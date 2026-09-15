use std::env;
use tauri::{Manager, RunEvent};

mod autostart;
mod cleanup;
mod compare;
mod conflicts;
mod desktop;
mod diff;
mod git;
mod graph;
mod images;
mod previews;
mod operations;
mod process;
mod projects;
mod pull_requests;
mod references;
mod server;
mod sharing;
mod stash;
mod storage;
mod window;
mod working_tree;
mod worktrees;
#[cfg(test)]
mod test_support;

use storage::load_settings;
use projects::OpenWorktrees;
use window::{
    open_repository_window, repository_path_from_args, reveal_launcher,
    sharing_survives_window_close, should_keep_sharing_without_windows, watch_sharing_close,
};
use sharing::{
    SERVE_START_SHARING_SETTING, SERVE_USAGE, ServeMode, SharingServer, TrayExit,
    active_sharing_state, handle_serve_request, internal_serve_request, load_serve_arguments,
    parse_serve_mode, serve_foreground, serve_in_desktop_app, start_sharing, write_serve_readiness,
};
#[cfg(unix)]
use process::warm_effective_path;
#[cfg(target_os = "macos")]
use window::{install_app_menu, update_recent_menu};
#[cfg(any(target_os = "linux", target_os = "windows"))]
use sharing::handle_sharing_tray_menu_event;

/// The one list of IPC commands. It emits both the Tauri handler and the `Command` enum the HTTP
/// server matches on, so a new command cannot reach one surface without the other refusing to build.
macro_rules! commands {
    ($($module:ident :: $name:ident),* $(,)?) => {
        #[allow(non_camel_case_types)]
        pub enum IpcCommand { $($name),* }

        impl IpcCommand {
            pub const ALL: &'static [IpcCommand] = &[$(IpcCommand::$name),*];

            pub fn name(&self) -> &'static str {
                match self { $(IpcCommand::$name => stringify!($name)),* }
            }
        }

        fn invoke_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
            tauri::generate_handler![$($module::$name),*]
        }
    };
}

commands![
    projects::recent_projects,
    projects::clear_recent_projects,
    window::open_repository,
    window::show_launcher,
    window::choose_repository,
    window::zoom,
    desktop::update_command,
    desktop::command_line_link,
    desktop::install_command_line_link,
    desktop::open_worktree,
    desktop::open_url,
    projects::project_snapshot,
    graph::stream_commit_graph,
    graph::repository_fingerprint,
    worktrees::branch_sync,
    worktrees::worktree_status,
    cleanup::inferred_squash_merge_edges,
    pull_requests::fetch_and_sync_pull_requests,
    pull_requests::branch_pull_requests,
    cleanup::squashed_branch_candidates,
    cleanup::preview_cleanup_candidates,
    cleanup::delete_squashed_branches,
    operations::delete_branch,
    compare::compare_refs,
    compare::viewed_files,
    compare::set_file_viewed,
    references::reference_picker_commits,
    references::repository_references,
    references::resolve_revision,
    compare::select_branch_range,
    diff::diff_file,
    conflicts::predict_rebase_conflicts,
    worktrees::branch_operation_state,
    worktrees::repository_state,
    compare::merge_base,
    operations::rebase_onto,
    operations::checkout_ref,
    operations::push_ref,
    operations::pull_branch,
    operations::merge_ref,
    conflicts::predict_merge_conflicts,
    conflicts::predict_revert_conflicts,
    operations::create_branch,
    operations::rename_branch,
    operations::create_tag,
    operations::delete_tag,
    operations::cherry_pick_range,
    operations::revert_range,
    operations::reset_current,
    stash::stash_list,
    graph::commit_details,
    graph::ref_divergence,
    graph::tag_details,
    diff::diff_stat,
    stash::stash_changes,
    stash::stash_action,
    operations::undo_ref_updates,
    working_tree::working_tree,
    working_tree::working_tree_fingerprint,
    working_tree::stage_files,
    working_tree::unstage_files,
    working_tree::commit_changes,
    storage::settings,
    storage::set_setting,
    storage::repository_layout,
    storage::save_repository_layout,
    sharing::start_sharing,
    sharing::stop_sharing,
    sharing::sharing_state,
    sharing::rotate_sharing_token,
    sharing::update_sharing_setting,
    autostart::set_autostart,
    autostart::autostart_enabled,
];

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<_> = env::args().collect();

    let serve_request = if args.get(1).is_some_and(|argument| argument == "serve") {
        let (readiness_path, options) = match internal_serve_request(&args[2..]) {
            Ok(request) => request,
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        };
        if readiness_path.is_none() {
            let (mode, serve_options) = match parse_serve_mode(&options) {
                Ok(mode) => mode,
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(1);
                }
            };
            match mode {
                ServeMode::Foreground => match load_serve_arguments(&serve_options) {
                    Ok(arguments) => serve_foreground(arguments),
                    Err(error) => {
                        eprintln!("{error}");
                        std::process::exit(1);
                    }
                },
                ServeMode::App => {
                    // Answer --help and configuration mistakes here instead of launching the app
                    // to relay them.
                    if let Err(error) = load_serve_arguments(&serve_options) {
                        eprintln!("{error}");
                        std::process::exit(1);
                    }
                    if let Err(error) = serve_in_desktop_app(&args[2..]) {
                        eprintln!("{error}");
                        std::process::exit(1);
                    }
                }
                ServeMode::Stop => {
                    if serve_options.iter().any(|option| option == "--help" || option == "-h") {
                        eprintln!("{SERVE_USAGE}");
                        std::process::exit(1);
                    }
                    if !serve_options.is_empty() {
                        eprintln!("--stop does not take other options.\n\n{SERVE_USAGE}");
                        std::process::exit(1);
                    }
                    if let Err(error) = serve_in_desktop_app(&args[2..]) {
                        eprintln!("{error}");
                        std::process::exit(1);
                    }
                }
            }
            return;
        }
        Some((readiness_path.expect("missing readiness path"), options))
    } else {
        None
    };

    let cwd = env::current_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let repository_path = repository_path_from_args(&args, &cwd);
    let startup_readiness = serve_request.as_ref().map(|(path, _)| path.clone());

    let mut builder = tauri::Builder::default().register_asynchronous_uri_scheme_protocol(
        images::URI_SCHEME,
        |_context, request, responder| {
            let token = request.uri().path().trim_start_matches('/').to_string();
            // The handler runs on the UI thread on macOS, and reading a blob shells out to git.
            tauri::async_runtime::spawn_blocking(move || responder.respond(images::response(&token)));
        },
    );

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if args.get(1).is_some_and(|argument| argument == "serve") {
                let Ok((readiness_path, options)) = internal_serve_request(&args[2..]) else {
                    return;
                };
                let result = handle_serve_request(app, &options);
                if let Some(path) = readiness_path {
                    write_serve_readiness(&path, result);
                }
            } else if let Some(path) = repository_path_from_args(&args, &cwd) {
                let _ = open_repository_window(app, &path);
            } else {
                // A serve-started app has no visible window, so a plain launch must bring one back.
                let _ = reveal_launcher(app);
            }
        }));
        builder = builder.plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        );
        builder = builder.plugin(tauri_plugin_process::init());
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    {
        builder = builder.on_menu_event(handle_sharing_tray_menu_event);
    }

    let app = match builder
        .plugin(tauri_plugin_dialog::init())
        .manage(OpenWorktrees::default())
        .manage(SharingServer::default())
        .manage(TrayExit::default())
        .invoke_handler(invoke_handler())
        .setup(move |app| {
            #[cfg(unix)]
            warm_effective_path();
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // A serve-started app needs the menu too: windows opened later through the
            // single-instance socket rely on it.
            #[cfg(target_os = "macos")]
            if let Err(error) = install_app_menu(app.handle()) {
                log::error!("Could not install the application menu: {error}");
            }
            if let Some(window) = app.get_webview_window("main") {
                watch_sharing_close(&window);
            }
            if let Some((readiness_path, options)) = &serve_request {
                #[cfg(target_os = "macos")]
                update_recent_menu(Some(app.handle()));
                #[cfg(target_os = "macos")]
                if let Err(error) = app
                    .handle()
                    .set_activation_policy(tauri::ActivationPolicy::Accessory)
                {
                    log::error!("Could not hide the Dock icon while sharing: {error}");
                }
                let result = handle_serve_request(app.handle(), options);
                let should_exit = result.is_err() || matches!(parse_serve_mode(options), Ok((ServeMode::Stop, _)));
                write_serve_readiness(readiness_path, result);
                if should_exit {
                    app.handle().exit(0);
                }
                return Ok(());
            }
            if load_settings()
                .ok()
                .and_then(|settings| settings.get(SERVE_START_SHARING_SETTING).and_then(serde_json::Value::as_bool))
                .unwrap_or(false)
            {
                if let Err(error) = start_sharing(app.handle().clone()) {
                    log::error!("Could not start sharing on launch: {error}");
                }
            }
            if let Some(path) = &repository_path {
                open_repository_window(app.handle(), path)?;
            } else {
                reveal_launcher(app.handle())?;
                #[cfg(target_os = "macos")]
                update_recent_menu(Some(app.handle()));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
    {
        Ok(app) => app,
        Err(error) => {
            if let Some(path) = startup_readiness {
                write_serve_readiness(&path, Err(error.to_string()));
            }
            eprintln!("error while building tauri application: {error}");
            std::process::exit(1);
        }
    };
    app.run(|app, event| {
            // User-initiated window closes have no code. Keep the app alive while sharing so
            // macOS can reopen from the Dock and Linux/Windows can use the tray menu.
            if let RunEvent::ExitRequested { code: None, api, .. } = &event {
                if should_keep_sharing_without_windows(
                    active_sharing_state(app).sharing,
                    sharing_survives_window_close(app),
                    app.state::<TrayExit>().0.load(std::sync::atomic::Ordering::Relaxed),
                ) {
                    api.prevent_exit();
                    return;
                }
            }
            #[cfg(target_os = "macos")]
            if matches!(event, RunEvent::Reopen { has_visible_windows: false, .. }) {
                let _ = reveal_launcher(app);
                return;
            }
            // macOS only grants the process activation once the run loop is going, so a shell-launched
            // app has to claim the foreground here rather than while its window is being built.
            if matches!(event, RunEvent::Ready) {
                if let Some(window) = app.webview_windows().values().next() {
                    let _ = window.set_focus();
                }
            }
        });
}
