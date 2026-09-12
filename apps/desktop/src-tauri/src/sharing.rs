use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap, env, fs, io::Write, path::Path, path::PathBuf, process::Command,
    process::Stdio, sync::Mutex, sync::atomic::AtomicBool, thread, time::Duration,
    time::SystemTime, time::UNIX_EPOCH,
};
use tauri::{AppHandle, Emitter, Manager};
#[cfg(any(target_os = "linux", target_os = "windows"))]
use tauri::{menu::Menu, menu::MenuEvent, menu::MenuItem, tray::TrayIconBuilder};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use crate::server;
use crate::storage::{load_settings, save_setting, set_setting};
use crate::projects::OpenWorktrees;
#[cfg(target_os = "windows")]
use crate::process::CREATE_NO_WINDOW;
#[cfg(any(target_os = "linux", target_os = "windows"))]
use crate::window::reveal_launcher;

const SHARING_CHANGED_EVENT: &str = "sharing-changed";

const SERVE_HOST_SETTING: &str = "serve.host";
const SERVE_PORT_SETTING: &str = "serve.port";
const SERVE_TOKEN_SETTING: &str = "serve.token";
const SERVE_PUBLIC_URL_SETTING: &str = "serve.publicUrl";
pub(crate) const SERVE_START_SHARING_SETTING: &str = "serve.startSharing";
const MINIMUM_SERVE_PORT: u16 = 1024;

#[derive(Default)]
pub(crate) struct SharingServer {
    server: Mutex<Option<server::RunningServer>>,
}

#[derive(Default)]
pub(crate) struct TrayExit(pub(crate) AtomicBool);

pub(crate) const SERVE_USAGE: &str = "\
Usage: git-nav serve [options]

Options:
      --foreground      Run the HTTP server without starting the desktop app
      --stop            Stop sharing from the running desktop app
      --host <address>  Interface to bind (default 127.0.0.1; use 0.0.0.0 for other devices)
      --port <number>   Port to listen on (default 4300)
      --token <value>   Shared secret required to open the app (default: saved in application data settings.json or generated)
      --no-token        Serve without authentication

Closing the last window keeps sharing active while Git Nav stays in the macOS Dock or in the
tray on Linux and Windows. Run git-nav serve --stop to stop sharing.
";

#[derive(Debug, PartialEq)]
pub(crate) enum ServeMode {
    App,
    Foreground,
    Stop,
}

pub(crate) fn parse_serve_mode(args: &[String]) -> Result<(ServeMode, Vec<String>), String> {
    let mut mode = ServeMode::App;
    let mut options = Vec::new();
    let mut index = 0;

    while let Some(argument) = args.get(index) {
        index += 1;
        match argument.as_str() {
            "--foreground" => {
                if mode == ServeMode::Stop {
                    return Err(format!("--foreground cannot be combined with --stop.\n\n{SERVE_USAGE}"));
                }
                mode = ServeMode::Foreground;
            }
            "--stop" => {
                if mode == ServeMode::Foreground {
                    return Err(format!("--stop cannot be combined with --foreground.\n\n{SERVE_USAGE}"));
                }
                mode = ServeMode::Stop;
            }
            "--host" | "--port" | "--token" => {
                options.push(argument.clone());
                if let Some(value) = args.get(index) {
                    options.push(value.clone());
                    index += 1;
                }
            }
            _ => options.push(argument.clone()),
        }
    }
    Ok((mode, options))
}

#[derive(Clone)]
pub(crate) struct ServeArguments {
    host: std::net::IpAddr,
    port: u16,
    token: Option<String>,
    public_url: Option<String>,
    persist_token: bool,
}

pub(crate) fn load_serve_arguments(args: &[String]) -> Result<ServeArguments, String> {
    let settings = load_settings().map_err(|error| format!("Could not load settings: {error}"))?;
    let arguments = parse_serve_arguments(args, &settings)?;
    if arguments.persist_token {
        save_setting(
            SERVE_TOKEN_SETTING.to_string(),
            serde_json::Value::String(arguments.token.clone().expect("generated token missing")),
        )
        .map_err(|error| format!("Could not save the generated token: {error}"))?;
    }
    Ok(arguments)
}

fn parse_serve_arguments(
    args: &[String],
    settings: &BTreeMap<String, serde_json::Value>,
) -> Result<ServeArguments, String> {
    let mut host = stored_serve_host(settings);
    let mut port = None;
    let mut token = None;
    let mut generate_token = true;
    let mut index = 0;

    while let Some(argument) = args.get(index) {
        index += 1;
        let mut value = || {
            args.get(index)
                .cloned()
                .ok_or_else(|| format!("{argument} needs a value."))
                .inspect(|_| index += 1)
        };
        match argument.as_str() {
            "--host" => host = value()?.parse().map_err(|_| "Invalid --host.".to_string())?,
            "--port" => {
                port = Some(value()?.parse().map_err(|_| "Invalid --port.".to_string())?);
            }
            "--token" => {
                token = Some(value()?);
                generate_token = false;
            }
            "--no-token" => generate_token = false,
            "--help" | "-h" => return Err(SERVE_USAGE.to_string()),
            _ => return Err(format!("Unknown option {argument}.\n\n{SERVE_USAGE}")),
        }
    }

    // An explicit --port may be privileged, so the stored port is read and checked only without one.
    let port = match port {
        Some(port) => port,
        None => stored_serve_port(settings)?,
    };

    let mut persist_token = false;
    if generate_token {
        token = settings
            .get(SERVE_TOKEN_SETTING)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        if token.is_none() {
            token = Some(generated_token());
            persist_token = true;
        }
    }

    Ok(ServeArguments {
        host,
        port,
        token,
        public_url: settings
            .get(SERVE_PUBLIC_URL_SETTING)
            .and_then(|value| match value.as_str().filter(|value| !value.is_empty()) {
                Some(value) => Some(value.to_owned()),
                None => {
                    eprintln!("Ignoring invalid {SERVE_PUBLIC_URL_SETTING}: {value}");
                    None
                }
            }),
        persist_token,
    })
}

fn valid_serve_host(value: &serde_json::Value) -> Option<std::net::IpAddr> {
    value
        .as_str()
        .and_then(|host| host.parse().ok())
        .filter(|host| {
            matches!(
                host,
                std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
                    | std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED)
            )
        })
}

fn valid_serve_port(value: &serde_json::Value) -> Option<u16> {
    value
        .as_u64()
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port >= MINIMUM_SERVE_PORT)
}

fn stored_serve_host(settings: &BTreeMap<String, serde_json::Value>) -> std::net::IpAddr {
    let Some(value) = settings.get(SERVE_HOST_SETTING) else {
        return std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);
    };
    match valid_serve_host(value) {
        Some(host) => host,
        None => {
            eprintln!("Ignoring invalid {SERVE_HOST_SETTING}: {value}");
            std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
        }
    }
}

fn stored_serve_port(settings: &BTreeMap<String, serde_json::Value>) -> Result<u16, String> {
    let Some(value) = settings.get(SERVE_PORT_SETTING) else {
        return Ok(4300);
    };
    valid_serve_port(value).ok_or_else(|| {
        format!(
            "Invalid {SERVE_PORT_SETTING}: {value}. The port must be a number between {MINIMUM_SERVE_PORT} and 65535."
        )
    })
}

fn generated_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("could not generate a token");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn serve_foreground(arguments: ServeArguments) {
    let runtime = tokio::runtime::Runtime::new().expect("could not start the async runtime");
    if let Err(error) = runtime.block_on(server::serve(server::Options {
        host: arguments.host,
        port: arguments.port,
        token: arguments.token,
        public_url: arguments.public_url,
    })) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn inactive_sharing_state() -> server::SharingState {
    server::SharingState { sharing: false, host: None, port: None, entry_urls: Vec::new() }
}

pub(crate) fn active_sharing_state(app: &AppHandle) -> server::SharingState {
    app.state::<SharingServer>()
        .server
        .lock()
        .ok()
        .and_then(|server| server.as_ref().map(server::RunningServer::state))
        .unwrap_or_else(inactive_sharing_state)
}

fn sharing_configuration_conflict(
    running: &server::Options,
    requested: &ServeArguments,
) -> Option<String> {
    let mut changes = Vec::new();
    if requested.host != running.host {
        changes.push(format!("host {} (currently {})", requested.host, running.host));
    }
    if requested.port != running.port {
        changes.push(format!("port {} (currently {})", requested.port, running.port));
    }
    if requested.token != running.token {
        changes.push(match (&requested.token, &running.token) {
            (None, _) => "no authentication (currently required)".to_string(),
            (Some(_), None) => "authentication (currently disabled)".to_string(),
            (Some(_), Some(_)) => "a different token".to_string(),
        });
    }
    if requested.public_url != running.public_url {
        changes.push("a different public URL".to_string());
    }
    (!changes.is_empty()).then(|| {
        format!(
            "Git Nav is already sharing and cannot switch to {} while it is running. Run git-nav serve --stop first, then serve again with the new settings.",
            changes.join(", ")
        )
    })
}

/// The tray backend loads one of these on the main thread and panics when none of them is there,
/// which would take the whole process down instead of failing tray creation. The handle stays open
/// because that same library is the one the tray backend loads later.
#[cfg(target_os = "linux")]
fn has_appindicator_library() -> bool {
    [
        "libayatana-appindicator3.so.1\0",
        "libappindicator3.so.1\0",
        "libayatana-appindicator3.so\0",
        "libappindicator3.so\0",
    ]
    .iter()
    .any(|name| !unsafe { libc::dlopen(name.as_ptr().cast(), libc::RTLD_LAZY) }.is_null())
}

#[cfg(target_os = "linux")]
pub(crate) fn status_notifier_host_available() -> bool {
    use dbus::blocking::stdintf::org_freedesktop_dbus::Properties;

    let Ok(connection) = dbus::blocking::Connection::new_session() else {
        return false;
    };
    let proxy = connection.with_proxy(
        "org.kde.StatusNotifierWatcher",
        "/StatusNotifierWatcher",
        Duration::from_millis(100),
    );
    proxy
        .get("org.kde.StatusNotifierWatcher", "IsStatusNotifierHostRegistered")
        .unwrap_or(false)
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn exit_after_closing_windows(app: &AppHandle) {
    let windows = app.webview_windows();
    if windows.is_empty() {
        app.exit(0);
        return;
    }
    app.state::<TrayExit>().0.store(true, std::sync::atomic::Ordering::Relaxed);
    for window in windows.values() {
        if let Err(error) = window.close() {
            log::error!("Could not close {} before exiting: {error}", window.label());
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
const SHARING_TRAY_SHOW: &str = "sharing-show";
#[cfg(any(target_os = "linux", target_os = "windows"))]
const SHARING_TRAY_QUIT: &str = "sharing-quit";

/// Menu handlers are app-wide and outlive the tray they were built with, so this one is
/// registered once at startup and serves every tray created while sharing restarts.
#[cfg(any(target_os = "linux", target_os = "windows"))]
pub(crate) fn handle_sharing_tray_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        SHARING_TRAY_SHOW => {
            // Windows deadlocks when a webview is built from the main thread's menu handler.
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(error) = reveal_launcher(&app) {
                    log::error!("Could not show the launcher from the tray: {error}");
                }
            });
        }
        SHARING_TRAY_QUIT => exit_after_closing_windows(app),
        _ => {}
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn install_sharing_tray(app: &AppHandle) -> Result<(), String> {
    if let Some(_tray) = app.tray_by_id("sharing") {
        #[cfg(target_os = "linux")]
        _tray.set_visible(true).map_err(|error| error.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    if !has_appindicator_library() {
        log::warn!(
            "Sharing without a tray icon: this desktop has no appindicator library. Run git-nav again to bring the window back; closing the last window stops sharing."
        );
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    if !status_notifier_host_available() {
        log::warn!(
            "Sharing without a tray icon: this desktop has no status notifier host. Closing the last window stops sharing."
        );
        return Ok(());
    }
    let show = MenuItem::with_id(app, SHARING_TRAY_SHOW, "Show Git Nav", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let quit = MenuItem::with_id(app, SHARING_TRAY_QUIT, "Quit Git Nav", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let menu = Menu::with_items(app, &[&show, &quit]).map_err(|error| error.to_string())?;
    let icon = app.default_window_icon().ok_or_else(|| "Could not load the application icon.".to_string())?;
    TrayIconBuilder::with_id("sharing")
        .menu(&menu)
        .icon(icon.clone())
        .tooltip("Git Nav is sharing on the network")
        .build(app)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn install_sharing_tray(_: &AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "linux")]
fn remove_sharing_tray(app: &AppHandle) {
    // AppIndicator teardown does not unexport its D-Bus object synchronously, so reuse the same
    // registered tray and make it passive while sharing is stopped.
    if let Some(tray) = app.tray_by_id("sharing") {
        if let Err(error) = tray.set_visible(false) {
            log::error!("Could not hide the sharing tray: {error}");
        }
    }
}

#[cfg(target_os = "windows")]
fn remove_sharing_tray(app: &AppHandle) {
    // The icon only leaves the tray once the last handle to it is dropped.
    drop(app.remove_tray_by_id("sharing"));
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn remove_sharing_tray(_: &AppHandle) {}

fn run_sharing_transition<T>(
    app: &AppHandle,
    transition: impl FnOnce(AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String>
where
    T: Send + 'static,
{
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let transition_app = app.clone();
    // Wry runs this inline when already on the UI thread and queues it otherwise. Callers hold no
    // sharing locks while waiting, and the UI thread orders server and tray lifecycle together.
    app.run_on_main_thread(move || {
        let _ = sender.send(transition(transition_app));
    })
    .map_err(|error| error.to_string())?;
    receiver.recv().map_err(|error| error.to_string())?
}

fn start_sharing_with_arguments(
    app: &AppHandle,
    arguments: ServeArguments,
) -> Result<server::SharingState, String> {
    run_sharing_transition(app, move |app| start_sharing_on_main_thread(&app, arguments))
}

fn start_sharing_on_main_thread(
    app: &AppHandle,
    arguments: ServeArguments,
) -> Result<server::SharingState, String> {
    let sharing_server = app.state::<SharingServer>();
    {
        let sharing = sharing_server.server.lock().map_err(|error| error.to_string())?;
        if let Some(server) = sharing.as_ref() {
            if let Some(conflict) = sharing_configuration_conflict(server.options(), &arguments) {
                return Err(conflict);
            }
            return Ok(server.state());
        }
    }

    let server = server::start(
        server::Options {
            host: arguments.host,
            port: arguments.port,
            token: arguments.token,
            public_url: arguments.public_url,
        },
        app.state::<OpenWorktrees>().inner().clone(),
    )?;
    let state = server.state();
    if let Err(error) = install_sharing_tray(app) {
        if !server.stop() {
            log::warn!("Git Nav sharing server did not release its port within five seconds.");
        }
        return Err(error);
    }
    *sharing_server.server.lock().map_err(|error| error.to_string())? = Some(server);
    app.emit(SHARING_CHANGED_EVENT, &state)
        .map_err(|error| error.to_string())?;
    Ok(state)
}

fn stop_sharing_from_app(app: &AppHandle) -> Result<server::SharingState, String> {
    run_sharing_transition(app, |app| stop_sharing_on_main_thread(&app))
}

fn stop_sharing_on_main_thread(app: &AppHandle) -> Result<server::SharingState, String> {
    let sharing_server = app.state::<SharingServer>();
    let server = sharing_server.server.lock().map_err(|error| error.to_string())?.take();
    let Some(server) = server else {
        return Ok(inactive_sharing_state());
    };
    if !server.stop() {
        log::warn!("Git Nav sharing server did not release its port within five seconds.");
    }
    let state = inactive_sharing_state();
    remove_sharing_tray(app);
    app.emit(SHARING_CHANGED_EVENT, &state)
        .map_err(|error| error.to_string())?;
    if !app
        .webview_windows()
        .values()
        .any(|window| window.is_visible().unwrap_or(true))
    {
        app.exit(0);
    }
    Ok(state)
}

fn take_sharing_server_for_restart<T>(
    sharing: &mut Option<T>,
    change: impl FnOnce(&T) -> Result<server::Options, String>,
) -> Result<(T, server::Options), String> {
    let Some(server) = sharing.as_ref() else {
        return Err("Git Nav is not sharing on the network.".to_string());
    };
    let options = change(server)?;
    let server = sharing.take().expect("sharing server disappeared after it was checked");
    Ok((server, options))
}

/// Saves the change only once the replacement is listening, and starts the previous configuration
/// again when either step fails, so a rejected change leaves neither an unusable saved setting nor
/// a stopped server behind.
fn replace_sharing_server<T>(
    server: T,
    previous: server::Options,
    options: server::Options,
    stop: impl Fn(T),
    start: impl Fn(server::Options) -> Result<T, String>,
    persist: impl FnOnce() -> Result<(), String>,
) -> Result<T, (Option<T>, String)> {
    stop(server);
    let error = match start(options) {
        Ok(replacement) => match persist() {
            Ok(()) => return Ok(replacement),
            Err(error) => {
                stop(replacement);
                error
            }
        },
        Err(error) => error,
    };
    Err((start(previous).ok(), error))
}

fn restart_sharing_with(
    app: &AppHandle,
    change: impl FnOnce(&server::Options) -> Result<server::Options, String> + Send + 'static,
    persist: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Result<server::SharingState, String> {
    run_sharing_transition(app, move |app| restart_sharing_on_main_thread(&app, change, persist))
}

fn restart_sharing_on_main_thread(
    app: &AppHandle,
    change: impl FnOnce(&server::Options) -> Result<server::Options, String>,
    persist: impl FnOnce() -> Result<(), String>,
) -> Result<server::SharingState, String> {
    let sharing_server = app.state::<SharingServer>();
    let (server, options) = {
        let mut sharing = sharing_server.server.lock().map_err(|error| error.to_string())?;
        // The running configuration wins over persisted settings: only the requested change applies.
        take_sharing_server_for_restart(&mut sharing, |server| change(server.options()))?
    };
    let previous = server.options().clone();
    let open_worktrees = app.state::<OpenWorktrees>().inner().clone();
    let (running, error) = match replace_sharing_server(
        server,
        previous,
        options,
        |server: server::RunningServer| {
            if !server.stop() {
                log::warn!("Git Nav sharing server did not release its port within five seconds.");
            }
        },
        |options| server::start(options, open_worktrees.clone()),
        persist,
    ) {
        Ok(server) => (Some(server), None),
        Err((restored, error)) => (restored, Some(error)),
    };
    let state = running
        .as_ref()
        .map_or_else(inactive_sharing_state, server::RunningServer::state);
    // When restoring the previous server also failed, sharing ended here.
    if running.is_none() {
        remove_sharing_tray(app);
    }
    *sharing_server.server.lock().map_err(|error| error.to_string())? = running;
    match error {
        Some(error) => {
            let _ = app.emit(SHARING_CHANGED_EVENT, &state);
            Err(error)
        }
        None => {
            app.emit(SHARING_CHANGED_EVENT, &state)
                .map_err(|error| error.to_string())?;
            Ok(state)
        }
    }
}

fn restart_sharing_with_token(
    app: &AppHandle,
    token: String,
) -> Result<server::SharingState, String> {
    let persisted = serde_json::Value::String(token.clone());
    restart_sharing_with(
        app,
        move |options| Ok(server::Options { token: Some(token), ..options.clone() }),
        move || save_setting(SERVE_TOKEN_SETTING.to_string(), persisted),
    )
}

fn sharing_options_with_setting(
    options: &server::Options,
    key: &str,
    value: &serde_json::Value,
) -> Result<server::Options, String> {
    let mut options = options.clone();
    match key {
        SERVE_HOST_SETTING => {
            options.host = valid_serve_host(value)
                .ok_or_else(|| format!("Invalid {SERVE_HOST_SETTING}: {value}."))?;
        }
        SERVE_PORT_SETTING => {
            options.port = valid_serve_port(value).ok_or_else(|| {
                format!(
                    "Invalid {SERVE_PORT_SETTING}: {value}. The port must be a number between {MINIMUM_SERVE_PORT} and 65535."
                )
            })?;
        }
        SERVE_PUBLIC_URL_SETTING => {
            let url = value
                .as_str()
                .ok_or_else(|| format!("Invalid {SERVE_PUBLIC_URL_SETTING}: {value}."))?;
            options.public_url = (!url.is_empty())
                .then(|| {
                    // Sharing serves the entry URL this parses to, so anything it rejects would be
                    // saved and then quietly replaced by a listener URL.
                    server::public_entry_url(url).map(|_| url.to_owned()).ok_or_else(|| {
                        format!(
                            "Invalid {SERVE_PUBLIC_URL_SETTING}: {value}. It must be an http or https URL."
                        )
                    })
                })
                .transpose()?;
        }
        _ => return Err(format!("{key} does not change the running sharing server.")),
    }
    Ok(options)
}

#[tauri::command]
pub(crate) fn update_sharing_setting(
    app: AppHandle,
    key: String,
    value: serde_json::Value,
) -> Result<server::SharingState, String> {
    let persist_app = app.clone();
    let persisted_key = key.clone();
    let persisted = value.clone();
    restart_sharing_with(
        &app,
        move |options| sharing_options_with_setting(options, &key, &value),
        move || set_setting(persist_app, persisted_key, persisted),
    )
}

#[tauri::command]
pub(crate) fn start_sharing(app: AppHandle) -> Result<server::SharingState, String> {
    start_sharing_with_arguments(&app, load_serve_arguments(&[])?)
}

#[tauri::command]
pub(crate) fn stop_sharing(app: AppHandle) -> Result<server::SharingState, String> {
    stop_sharing_from_app(&app)
}

#[tauri::command]
pub(crate) fn sharing_state(app: AppHandle) -> server::SharingState {
    active_sharing_state(&app)
}

#[tauri::command]
pub(crate) fn rotate_sharing_token(app: AppHandle) -> Result<server::SharingState, String> {
    let token = generated_token();
    restart_sharing_with_token(&app, token)
}

#[derive(Deserialize, Serialize)]
pub(crate) struct ServeReadiness {
    state: Option<server::SharingState>,
    error: Option<String>,
}

/// The single-instance socket relays these requests from any local process, so only paths the
/// `serve` CLI could have created are accepted.
fn is_expected_readiness_path(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if !name.starts_with("git-nav-serve-") || !name.ends_with(".ready") {
        return false;
    }
    let parent = path.parent();
    // The CLI may run with a TMPDIR the app was not launched with, so /tmp stays accepted.
    parent == Some(env::temp_dir().as_path()) || (cfg!(unix) && parent == Some(Path::new("/tmp")))
}

pub(crate) fn internal_serve_request(args: &[String]) -> Result<(Option<PathBuf>, Vec<String>), String> {
    let mut readiness_path = None;
    let mut options = Vec::new();
    let mut index = 0;
    while let Some(argument) = args.get(index) {
        index += 1;
        if argument == "--internal-ready" {
            let path = args
                .get(index)
                .ok_or_else(|| "--internal-ready needs a value.".to_string())?;
            index += 1;
            let path = PathBuf::from(path);
            if !is_expected_readiness_path(&path) {
                return Err("--internal-ready must name a readiness file in the temporary directory.".to_string());
            }
            readiness_path = Some(path);
        } else {
            options.push(argument.clone());
        }
    }
    Ok((readiness_path, options))
}

pub(crate) fn write_serve_readiness(path: &Path, result: Result<server::SharingState, String>) {
    let readiness = match result {
        Ok(state) => ServeReadiness { state: Some(state), error: None },
        Err(error) => ServeReadiness { state: None, error: Some(error) },
    };
    let contents = match serde_json::to_vec(&readiness) {
        Ok(contents) => contents,
        Err(error) => {
            log::error!("Could not encode sharing readiness: {error}");
            return;
        }
    };
    match open_readiness_file(path).and_then(|mut file| {
        file.write_all(&contents).map_err(|error| error.to_string())
    }) {
        Ok(()) => {}
        Err(error) => log::error!("Could not report sharing readiness: {error}"),
    }
}

/// Never creates the file: the CLI owns it, and recreating it after the CLI timed out and removed
/// it would leave a token-bearing file behind in temp. Refusing symlinks keeps a forged request
/// from truncating another file.
fn open_readiness_file(path: &Path) -> Result<fs::File, String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path).map_err(|error| error.to_string())
}

pub(crate) fn handle_serve_request(app: &AppHandle, args: &[String]) -> Result<server::SharingState, String> {
    let (mode, options) = parse_serve_mode(args)?;
    match mode {
        ServeMode::App => start_sharing_with_arguments(app, load_serve_arguments(&options)?),
        ServeMode::Stop => {
            if !options.is_empty() {
                return Err(format!("--stop does not take other options.\n\n{SERVE_USAGE}"));
            }
            stop_sharing_from_app(app)
        }
        ServeMode::Foreground => Err("--foreground cannot run inside the desktop app.".to_string()),
    }
}

fn create_readiness_path() -> Result<PathBuf, String> {
    for nonce in 0..100 {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = env::temp_dir().join(format!(
            "git-nav-serve-{}-{timestamp}-{nonce}.ready",
            std::process::id()
        ));
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(_) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Could not create a sharing readiness file.".to_string())
}

fn wait_for_serve_readiness(path: &Path) -> Result<server::SharingState, String> {
    // A cold launch of the bundled app can take well over ten seconds, so allow thirty.
    for _ in 0..1200 {
        if let Ok(contents) = fs::read(path) {
            if let Ok(readiness) = serde_json::from_slice::<ServeReadiness>(&contents) {
                return match readiness {
                    ServeReadiness { state: Some(state), error: None } => Ok(state),
                    ServeReadiness { state: None, error: Some(error) } => Err(error),
                    _ => Err("The desktop app returned an invalid sharing readiness response.".to_string()),
                };
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    Err("Timed out waiting for the desktop app to start sharing.".to_string())
}

#[cfg(target_os = "macos")]
fn macos_app_path() -> Option<PathBuf> {
    let executable = env::current_exe().ok()?;
    let bundle = executable.ancestors().nth(3)?;
    (bundle.extension().and_then(|extension| extension.to_str()) == Some("app"))
        .then(|| bundle.to_path_buf())
}

fn start_desktop_app_for_sharing(arguments: &[String], readiness_path: &Path) -> Result<(), String> {
    let mut child_arguments = vec!["serve".to_string(), "--internal-ready".to_string()];
    child_arguments.push(readiness_path.to_string_lossy().into_owned());
    child_arguments.extend(arguments.iter().cloned());

    #[cfg(target_os = "macos")]
    let mut command = if let Some(app_path) = macos_app_path() {
        let mut command = Command::new("open");
        command.arg("-n").arg("-a").arg(app_path).arg("--args");
        command
    } else {
        Command::new(env::current_exe().map_err(|error| error.to_string())?)
    };
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = Command::new("setsid");
        // An AppImage's current_exe lives in a mount that unwinds with this process, so relaunch
        // the bundle itself.
        let executable = match env::var_os("APPIMAGE") {
            Some(bundle) => PathBuf::from(bundle),
            None => env::current_exe().map_err(|error| error.to_string())?,
        };
        command.arg(executable);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = Command::new(env::current_exe().map_err(|error| error.to_string())?);
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    let mut command = Command::new(env::current_exe().map_err(|error| error.to_string())?);

    command
        .args(&child_arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW | 0x0000_0008 | 0x0000_0200);
    command.spawn().map(|_| ()).map_err(|error| error.to_string())
}

fn print_sharing_urls(state: &server::SharingState) {
    for url in &state.entry_urls {
        println!("Git Nav is serving at {url}");
    }
    if state.host.as_deref() == Some("127.0.0.1") {
        println!("Pass --host 0.0.0.0 to reach it from other devices on your network.");
    }
}

pub(crate) fn serve_in_desktop_app(args: &[String]) -> Result<(), String> {
    let readiness_path = create_readiness_path()?;
    let result = start_desktop_app_for_sharing(args, &readiness_path)
        .and_then(|()| wait_for_serve_readiness(&readiness_path));
    let _ = fs::remove_file(&readiness_path);
    match result {
        Ok(state) if state.sharing => {
            print_sharing_urls(&state);
            Ok(())
        }
        Ok(_) => {
            println!("Git Nav is not sharing.");
            Ok(())
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn restart_error(
        sharing: &mut Option<()>,
        change: impl FnOnce(&()) -> Result<server::Options, String>,
    ) -> String {
        match take_sharing_server_for_restart(sharing, change) {
            Ok(_) => panic!("the restart should be refused"),
            Err(error) => error,
        }
    }

    #[test]
    fn sharing_restarts_are_refused_when_sharing_is_inactive() {
        let mut sharing = None;

        let error = restart_error(&mut sharing, |_| {
            Ok(sharing_options([127, 0, 0, 1], 4300, None))
        });

        assert_eq!(error, "Git Nav is not sharing on the network.");
    }

    #[test]
    fn an_invalid_change_keeps_the_server_running() {
        let mut sharing = Some(());

        let error = restart_error(&mut sharing, |_| Err("invalid change".to_string()));

        assert_eq!(error, "invalid change");
        assert!(sharing.is_some());
    }

    /// Stands in for the running server: replacements are identified by the port they listen on.
    fn replaced_sharing_server(
        start: impl Fn(server::Options) -> Result<u16, String>,
        persist: impl FnOnce() -> Result<(), String>,
        steps: &RefCell<Vec<String>>,
    ) -> Result<u16, (Option<u16>, String)> {
        replace_sharing_server(
            4300,
            sharing_options([127, 0, 0, 1], 4300, None),
            sharing_options([127, 0, 0, 1], 4310, None),
            |port| steps.borrow_mut().push(format!("stop {port}")),
            |options| {
                steps.borrow_mut().push(format!("start {}", options.port));
                start(options)
            },
            || {
                steps.borrow_mut().push("persist".to_string());
                persist()
            },
        )
    }

    #[test]
    fn a_restart_saves_the_change_only_once_the_replacement_is_listening() {
        let steps = RefCell::new(Vec::new());

        let replacement = replaced_sharing_server(|options| Ok(options.port), || Ok(()), &steps);

        assert_eq!(replacement.map_err(|(_, error)| error), Ok(4310));
        assert_eq!(steps.into_inner(), ["stop 4300", "start 4310", "persist"]);
    }

    #[test]
    fn a_replacement_that_cannot_start_restores_the_previous_server_unsaved() {
        let steps = RefCell::new(Vec::new());

        let Err((restored, error)) = replaced_sharing_server(
            |options| match options.port {
                4310 => Err("Port 4310 is already in use.".to_string()),
                port => Ok(port),
            },
            || panic!("a failed restart must not be saved"),
            &steps,
        ) else {
            panic!("the restart should fail");
        };

        assert_eq!(restored, Some(4300));
        assert_eq!(error, "Port 4310 is already in use.");
        assert_eq!(steps.into_inner(), ["stop 4300", "start 4310", "start 4300"]);
    }

    #[test]
    fn a_change_that_cannot_be_saved_restores_the_previous_server() {
        let steps = RefCell::new(Vec::new());

        let Err((restored, error)) = replaced_sharing_server(
            |options| Ok(options.port),
            || Err("Could not save the setting.".to_string()),
            &steps,
        ) else {
            panic!("the restart should fail");
        };

        assert_eq!(restored, Some(4300));
        assert_eq!(error, "Could not save the setting.");
        assert_eq!(
            steps.into_inner(),
            ["stop 4300", "start 4310", "persist", "stop 4310", "start 4300"]
        );
    }

    #[test]
    fn a_restart_that_cannot_be_undone_reports_the_original_failure() {
        let steps = RefCell::new(Vec::new());

        let Err((restored, error)) = replaced_sharing_server(
            |options| Err(format!("Port {} is already in use.", options.port)),
            || panic!("a failed restart must not be saved"),
            &steps,
        ) else {
            panic!("the restart should fail");
        };

        assert_eq!(restored, None);
        assert_eq!(error, "Port 4310 is already in use.");
    }

    #[test]
    fn serve_mode_keeps_configuration_flags_for_the_selected_runner() {
        let arguments = vec![
            "--foreground".to_string(),
            "--host".to_string(),
            "0.0.0.0".to_string(),
            "--port".to_string(),
            "4310".to_string(),
        ];

        let (mode, options) = parse_serve_mode(&arguments).unwrap();

        assert_eq!(mode, ServeMode::Foreground);
        assert_eq!(options, ["--host", "0.0.0.0", "--port", "4310"]);
    }

    #[test]
    fn serve_mode_rejects_foreground_and_stop_together() {
        let error = parse_serve_mode(&["--foreground".to_string(), "--stop".to_string()])
            .unwrap_err();
        assert!(error.contains("--stop cannot be combined with --foreground"));

        let error = parse_serve_mode(&["--stop".to_string(), "--foreground".to_string()])
            .unwrap_err();
        assert!(error.contains("--foreground cannot be combined with --stop"));
    }

    #[test]
    fn serve_mode_accepts_a_repeated_flag() {
        let (mode, options) =
            parse_serve_mode(&["--foreground".to_string(), "--foreground".to_string()]).unwrap();

        assert_eq!(mode, ServeMode::Foreground);
        assert!(options.is_empty());
    }

    #[test]
    fn serve_mode_does_not_treat_option_values_as_modes() {
        let arguments = vec![
            "--host".to_string(),
            "--foreground".to_string(),
            "--port".to_string(),
            "--stop".to_string(),
            "--token".to_string(),
            "--foreground".to_string(),
        ];

        let (mode, options) = parse_serve_mode(&arguments).unwrap();

        assert_eq!(mode, ServeMode::App);
        assert_eq!(options, arguments);
    }

    fn sharing_options(host: [u8; 4], port: u16, token: Option<&str>) -> server::Options {
        server::Options {
            host: std::net::IpAddr::V4(host.into()),
            port,
            token: token.map(str::to_owned),
            public_url: None,
        }
    }

    fn serve_arguments(host: [u8; 4], port: u16, token: Option<&str>) -> ServeArguments {
        ServeArguments {
            host: std::net::IpAddr::V4(host.into()),
            port,
            token: token.map(str::to_owned),
            public_url: None,
            persist_token: false,
        }
    }

    #[test]
    fn sharing_reports_the_running_state_when_the_requested_options_match() {
        let running = sharing_options([127, 0, 0, 1], 4300, Some("token"));
        let requested = serve_arguments([127, 0, 0, 1], 4300, Some("token"));

        assert_eq!(sharing_configuration_conflict(&running, &requested), None);
    }

    #[test]
    fn sharing_refuses_configuration_changes_while_running() {
        let running = sharing_options([127, 0, 0, 1], 4300, Some("token"));
        let requested = serve_arguments([0, 0, 0, 0], 4310, None);

        let message = sharing_configuration_conflict(&running, &requested).unwrap();

        assert!(message.contains("host 0.0.0.0 (currently 127.0.0.1)"));
        assert!(message.contains("port 4310 (currently 4300)"));
        assert!(message.contains("no authentication (currently required)"));
        assert!(message.contains("git-nav serve --stop"));
    }

    #[test]
    fn sharing_refuses_a_token_change_without_leaking_the_values() {
        let running = sharing_options([127, 0, 0, 1], 4300, Some("running-token"));
        let requested = serve_arguments([127, 0, 0, 1], 4300, Some("requested-token"));

        let message = sharing_configuration_conflict(&running, &requested).unwrap();

        assert!(message.contains("a different token"));
        assert!(!message.contains("running-token"));
        assert!(!message.contains("requested-token"));
    }

    #[test]
    fn readiness_paths_are_confined_to_the_temporary_directory() {
        assert!(is_expected_readiness_path(
            &env::temp_dir().join("git-nav-serve-1-2-3.ready")
        ));
        if cfg!(unix) {
            assert!(is_expected_readiness_path(Path::new("/tmp/git-nav-serve-1.ready")));
        }
        assert!(!is_expected_readiness_path(Path::new("/etc/git-nav-serve-1.ready")));
        assert!(!is_expected_readiness_path(&env::temp_dir().join("other.ready")));
        assert!(!is_expected_readiness_path(&env::temp_dir().join("git-nav-serve-1.txt")));
        assert!(!is_expected_readiness_path(
            &env::temp_dir().join("nested").join("git-nav-serve-1.ready")
        ));
    }

    #[cfg(unix)]
    #[test]
    fn readiness_files_are_created_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let path = create_readiness_path().unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        fs::remove_file(&path).unwrap();

        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn internal_serve_requests_reject_unexpected_readiness_paths() {
        let error = internal_serve_request(&[
            "--internal-ready".to_string(),
            "/etc/passwd".to_string(),
        ])
        .unwrap_err();

        assert!(error.contains("--internal-ready"));
    }

    #[test]
    fn serve_flags_override_stored_values() {
        let settings = BTreeMap::from([
            (SERVE_HOST_SETTING.to_string(), serde_json::json!("0.0.0.0")),
            (SERVE_PORT_SETTING.to_string(), serde_json::json!(4301)),
            (SERVE_TOKEN_SETTING.to_string(), serde_json::json!("stored-token")),
        ]);
        let arguments = vec![
            "--host".to_string(),
            "127.0.0.1".to_string(),
            "--port".to_string(),
            "5000".to_string(),
            "--token".to_string(),
            "cli-token".to_string(),
        ];

        let parsed = parse_serve_arguments(&arguments, &settings).unwrap();

        assert_eq!(parsed.host, std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
        assert_eq!(parsed.port, 5000);
        assert_eq!(parsed.token.as_deref(), Some("cli-token"));
        assert!(!parsed.persist_token);
    }

    #[test]
    fn serve_uses_stored_values_before_built_in_defaults() {
        let settings = BTreeMap::from([
            (SERVE_HOST_SETTING.to_string(), serde_json::json!("0.0.0.0")),
            (SERVE_PORT_SETTING.to_string(), serde_json::json!(4301)),
            (SERVE_TOKEN_SETTING.to_string(), serde_json::json!("stored-token")),
            (
                SERVE_PUBLIC_URL_SETTING.to_string(),
                serde_json::json!("https://git-nav.example"),
            ),
        ]);

        let parsed = parse_serve_arguments(&[], &settings).unwrap();

        assert_eq!(parsed.host, std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
        assert_eq!(parsed.port, 4301);
        assert_eq!(parsed.token.as_deref(), Some("stored-token"));
        assert_eq!(parsed.public_url.as_deref(), Some("https://git-nav.example"));
        assert!(!parsed.persist_token);
    }

    #[test]
    fn serve_rejects_an_invalid_stored_port() {
        let settings = BTreeMap::from([
            (SERVE_HOST_SETTING.to_string(), serde_json::json!("localhost")),
            (SERVE_PORT_SETTING.to_string(), serde_json::json!(1023)),
        ]);

        let Err(error) = parse_serve_arguments(&[], &settings) else {
            panic!("an invalid stored port should be rejected");
        };

        assert!(error.contains("serve.port"));
        assert!(error.contains("1024"));
    }

    #[test]
    fn serve_allows_a_privileged_port_passed_on_the_command_line() {
        let parsed = parse_serve_arguments(
            &["--port".to_string(), "80".to_string()],
            &BTreeMap::new(),
        )
        .unwrap();

        assert_eq!(parsed.port, 80);
    }

    #[test]
    fn serve_port_flag_overrides_an_invalid_stored_port() {
        let settings = BTreeMap::from([(SERVE_PORT_SETTING.to_string(), serde_json::json!(80))]);

        let parsed = parse_serve_arguments(
            &["--port".to_string(), "4300".to_string()],
            &settings,
        )
        .unwrap();

        assert_eq!(parsed.port, 4300);
    }

    #[test]
    fn sharing_setting_updates_replace_only_the_changed_option() {
        let running = server::Options {
            public_url: Some("https://git-nav.example".to_owned()),
            ..sharing_options([127, 0, 0, 1], 5000, Some("cli-token"))
        };

        let updated =
            sharing_options_with_setting(&running, SERVE_HOST_SETTING, &serde_json::json!("0.0.0.0"))
                .unwrap();
        assert_eq!(updated.host, std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
        assert_eq!(updated.port, 5000);
        assert_eq!(updated.token.as_deref(), Some("cli-token"));
        assert_eq!(updated.public_url.as_deref(), Some("https://git-nav.example"));

        let updated =
            sharing_options_with_setting(&running, SERVE_PORT_SETTING, &serde_json::json!(4310))
                .unwrap();
        assert_eq!(updated.host, running.host);
        assert_eq!(updated.port, 4310);
        assert_eq!(updated.token.as_deref(), Some("cli-token"));

        let updated = sharing_options_with_setting(
            &running,
            SERVE_PUBLIC_URL_SETTING,
            &serde_json::json!("https://other.example"),
        )
        .unwrap();
        assert_eq!(updated.public_url.as_deref(), Some("https://other.example"));
        assert_eq!(updated.token.as_deref(), Some("cli-token"));
    }

    #[test]
    fn sharing_setting_updates_clear_the_public_url_with_an_empty_string() {
        let running = sharing_options([127, 0, 0, 1], 4300, None);

        let updated =
            sharing_options_with_setting(&running, SERVE_PUBLIC_URL_SETTING, &serde_json::json!(""))
                .unwrap();

        assert_eq!(updated.public_url, None);
    }

    #[test]
    fn sharing_setting_updates_reject_invalid_values() {
        let running = sharing_options([127, 0, 0, 1], 4300, None);
        let error = |key: &str, value: serde_json::Value| {
            match sharing_options_with_setting(&running, key, &value) {
                Ok(_) => panic!("the {key} update should be rejected"),
                Err(error) => error,
            }
        };

        assert!(error(SERVE_HOST_SETTING, serde_json::json!("localhost"))
            .contains(SERVE_HOST_SETTING));
        assert!(error(SERVE_PORT_SETTING, serde_json::json!(80)).contains("1024"));
        assert!(error(SERVE_PUBLIC_URL_SETTING, serde_json::json!(5))
            .contains(SERVE_PUBLIC_URL_SETTING));
        assert!(error(SERVE_PUBLIC_URL_SETTING, serde_json::json!("git-nav.example"))
            .contains("http or https"));
        assert!(error(SERVE_PUBLIC_URL_SETTING, serde_json::json!("ftp://git-nav.example"))
            .contains("http or https"));
        assert!(error(SERVE_PUBLIC_URL_SETTING, serde_json::json!("https://"))
            .contains("http or https"));
        assert!(error(SERVE_TOKEN_SETTING, serde_json::json!("token"))
            .contains(SERVE_TOKEN_SETTING));
        assert!(error(SERVE_START_SHARING_SETTING, serde_json::json!(true))
            .contains(SERVE_START_SHARING_SETTING));
    }

    #[test]
    fn serve_generates_a_token_only_when_no_stored_token_exists() {
        let parsed = parse_serve_arguments(&[], &BTreeMap::new()).unwrap();

        assert_eq!(parsed.host, std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
        assert_eq!(parsed.port, 4300);
        assert_eq!(parsed.token.as_ref().map(String::len), Some(32));
        assert!(parsed.persist_token);
    }

    #[test]
    fn serve_replaces_an_empty_stored_token() {
        let settings = BTreeMap::from([(
            SERVE_TOKEN_SETTING.to_string(),
            serde_json::json!(""),
        )]);

        let parsed = parse_serve_arguments(&[], &settings).unwrap();

        assert_eq!(parsed.token.as_ref().map(String::len), Some(32));
        assert!(parsed.persist_token);
    }

    #[test]
    fn serve_no_token_does_not_use_or_persist_the_stored_token() {
        let settings = BTreeMap::from([(
            SERVE_TOKEN_SETTING.to_string(),
            serde_json::json!("stored-token"),
        )]);

        let parsed = parse_serve_arguments(&["--no-token".to_string()], &settings).unwrap();

        assert_eq!(parsed.token, None);
        assert!(!parsed.persist_token);
    }
}
