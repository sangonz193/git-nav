use serde::Deserialize;
use std::path::PathBuf;
use tauri::{
    AppHandle, Emitter, Manager, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent, window::Color,
};
use tauri_plugin_dialog::DialogExt;
#[cfg(target_os = "macos")]
use std::{sync::Mutex, sync::atomic::AtomicU64, sync::atomic::Ordering};
#[cfg(target_os = "macos")]
use tauri::{
    menu::IsMenuItem, menu::Menu, menu::MenuItem, menu::MenuItemKind, menu::PredefinedMenuItem,
    menu::Submenu,
};
use crate::storage::{
    SETTING_CHANGED_EVENT, SettingChanged, load_settings, save_setting_at_then, settings_path,
};
use crate::projects::{OpenWorktree, OpenWorktrees, remember_repository};
use crate::git::{worktree_name, worktree_path};
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
use crate::storage::save_setting;
#[cfg(target_os = "macos")]
use crate::projects::{Project, clear_recent_paths, recent_project_list};
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
use crate::sharing::{TrayExit, active_sharing_state};
#[cfg(target_os = "linux")]
use crate::sharing::status_notifier_host_available;

#[cfg(target_os = "macos")]
const CLOSE_TAB_EVENT: &str = "close-tab";
#[cfg(target_os = "macos")]
const REOPEN_TAB_EVENT: &str = "reopen-tab";
const ZOOM_FACTOR_SETTING: &str = "app.zoomFactor";

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
const SERVE_CLOSE_NOTICE_SETTING: &str = "serve.closeNoticeShown";
#[cfg(target_os = "macos")]
const SHARING_CLOSE_NOTICE: &str =
    "Git Nav is still sharing on the network. Reopen it from the Dock to manage sharing.";
#[cfg(any(target_os = "linux", target_os = "windows"))]
const SHARING_CLOSE_NOTICE: &str =
    "Git Nav is still sharing on the network. Use the tray icon to manage sharing.";
const DEFAULT_ZOOM_FACTOR: f64 = 1.0;
const MINIMUM_ZOOM_FACTOR: f64 = 0.5;
const MAXIMUM_ZOOM_FACTOR: f64 = 2.0;
const ZOOM_STEP: f64 = 0.1;

#[cfg(target_os = "macos")]
const MENU_NEW_WINDOW: &str = "new-window";
#[cfg(target_os = "macos")]
const MENU_OPEN: &str = "open-repository";
#[cfg(target_os = "macos")]
const MENU_CLEAR_RECENT: &str = "clear-recent-projects";
#[cfg(target_os = "macos")]
const MENU_ZOOM_IN: &str = "zoom-in";
#[cfg(target_os = "macos")]
const MENU_ZOOM_OUT: &str = "zoom-out";
#[cfg(target_os = "macos")]
const MENU_ACTUAL_SIZE: &str = "actual-size";
#[cfg(target_os = "macos")]
const MENU_CLOSE_TAB: &str = "close-tab";
#[cfg(target_os = "macos")]
const MENU_CLOSE_WINDOW: &str = "close-window";
#[cfg(target_os = "macos")]
const MENU_REOPEN_TAB: &str = "reopen-tab";
#[cfg(target_os = "macos")]
const MENU_RECENT_PREFIX: &str = "open-recent-";
// The text the default menu gives its close item, which is the only handle on it once it is built.
#[cfg(target_os = "macos")]
const PREDEFINED_CLOSE_WINDOW_TEXT: &str = "Close Window";

#[cfg(target_os = "macos")]
fn recent_menu_id(path: &str) -> String {
    format!("{MENU_RECENT_PREFIX}{path}")
}

#[cfg(target_os = "macos")]
fn recent_menu_path(id: &str) -> Option<&str> {
    id.strip_prefix(MENU_RECENT_PREFIX)
}

#[cfg(target_os = "macos")]
pub(crate) struct AppMenuState {
    recent: Submenu<tauri::Wry>,
    rebuild_generation: AtomicU64,
    rebuild_lock: Mutex<()>,
}

#[cfg(target_os = "macos")]
fn menu_submenu(menu: &Menu<tauri::Wry>, title: &str) -> Result<Submenu<tauri::Wry>, String> {
    menu.items()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find_map(|item| match item {
            MenuItemKind::Submenu(submenu) if submenu.text().ok().as_deref() == Some(title) => {
                Some(submenu)
            }
            _ => None,
        })
        .ok_or_else(|| format!("Could not find the {title} menu."))
}

// The default menu binds its close item to CmdOrCtrl+W in both the File and the Window menus, and a
// predefined item carries that accelerator with it. Taking the key back for tabs means dropping the
// item itself, not rebinding it.
#[cfg(target_os = "macos")]
fn replace_close_window_item(
    submenu: &Submenu<tauri::Wry>,
    items: &[&dyn IsMenuItem<tauri::Wry>],
) -> Result<(), String> {
    let position = submenu
        .items()
        .map_err(|error| error.to_string())?
        .iter()
        .position(|item| match item {
            MenuItemKind::Predefined(item) => {
                item.text().ok().as_deref() == Some(PREDEFINED_CLOSE_WINDOW_TEXT)
            }
            _ => false,
        })
        .ok_or_else(|| format!("Could not find the {PREDEFINED_CLOSE_WINDOW_TEXT} menu item."))?;
    submenu
        .remove_at(position)
        .map_err(|error| error.to_string())?;
    submenu
        .insert_items(items, position)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn focused_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"))
}

#[cfg(target_os = "macos")]
fn populate_recent_menu(
    app: &AppHandle,
    recent: &Submenu<tauri::Wry>,
    projects: &[Project],
) -> Result<(), String> {
    for index in (0..recent.items().map_err(|error| error.to_string())?.len()).rev() {
        recent.remove_at(index).map_err(|error| error.to_string())?;
    }

    let project_items = if projects.is_empty() {
        vec![MenuItem::with_id(
            app,
            "no-recent-projects",
            "No Recent Projects",
            false,
            None::<&str>,
        )
        .map_err(|error| error.to_string())?]
    } else {
        projects
            .iter()
            .map(|project| {
                let label = project.name.replace('&', "&&");
                MenuItem::with_id(
                    app,
                    recent_menu_id(&project.path),
                    &label,
                    true,
                    None::<&str>,
                )
                .map_err(|error| error.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    let project_item_refs = project_items
        .iter()
        .map(|item| item as &dyn IsMenuItem<tauri::Wry>)
        .collect::<Vec<_>>();
    recent
        .append_items(&project_item_refs)
        .map_err(|error| error.to_string())?;

    let separator = PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;
    let clear = MenuItem::with_id(
        app,
        MENU_CLEAR_RECENT,
        "Clear Menu",
        !projects.is_empty(),
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    recent
        .append_items(&[&separator, &clear])
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
pub(crate) fn update_recent_menu(app: Option<&AppHandle>) {
    let Some(app) = app else {
        return;
    };
    let Some(state) = app.try_state::<AppMenuState>() else {
        return;
    };
    let generation = state.rebuild_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let list_app = app.clone();
        let projects = tauri::async_runtime::spawn_blocking(move || {
            recent_project_list(&list_app.state::<OpenWorktrees>())
        })
        .await;
        let projects = match projects {
            Ok(Ok(projects)) => projects,
            Ok(Err(error)) => {
                log::error!("Could not rebuild the recent projects menu: {error}");
                return;
            }
            Err(error) => {
                log::error!("Could not rebuild the recent projects menu: {error}");
                return;
            }
        };
        let state = app.state::<AppMenuState>();
        let _rebuild = match state.rebuild_lock.lock() {
            Ok(rebuild) => rebuild,
            Err(error) => {
                log::error!("Could not rebuild the recent projects menu: {error}");
                return;
            }
        };
        if state.rebuild_generation.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Err(error) = populate_recent_menu(&app, &state.recent, &projects) {
            log::error!("Could not rebuild the recent projects menu: {error}");
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn update_recent_menu(_app: Option<&AppHandle>) {}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ZoomDirection {
    In,
    Out,
    ActualSize,
}

fn clamp_zoom_factor(factor: f64) -> f64 {
    if factor.is_finite() {
        factor.clamp(MINIMUM_ZOOM_FACTOR, MAXIMUM_ZOOM_FACTOR)
    } else {
        DEFAULT_ZOOM_FACTOR
    }
}

fn saved_zoom_factor() -> Result<f64, String> {
    Ok(load_settings()?
        .get(ZOOM_FACTOR_SETTING)
        .and_then(serde_json::Value::as_f64)
        .map(clamp_zoom_factor)
        .unwrap_or(DEFAULT_ZOOM_FACTOR))
}

fn next_zoom_factor(factor: f64, direction: ZoomDirection) -> f64 {
    let factor = clamp_zoom_factor(factor);
    let next = match direction {
        ZoomDirection::In => factor + ZOOM_STEP,
        ZoomDirection::Out => factor - ZOOM_STEP,
        ZoomDirection::ActualSize => DEFAULT_ZOOM_FACTOR,
    };
    (clamp_zoom_factor(next) * 10.0).round() / 10.0
}

fn set_app_zoom(app: &AppHandle, direction: ZoomDirection) -> Result<(), String> {
    let factor = next_zoom_factor(saved_zoom_factor()?, direction);
    let mut zoom_error = None;
    for window in app.webview_windows().values() {
        if let Err(error) = window.set_zoom(factor) {
            zoom_error.get_or_insert_with(|| error.to_string());
        }
    }
    let value = serde_json::json!(factor);
    save_setting_at_then(
        &settings_path()?,
        ZOOM_FACTOR_SETTING.to_string(),
        value.clone(),
        || {
            app.emit(
                SETTING_CHANGED_EVENT,
                SettingChanged {
                    key: ZOOM_FACTOR_SETTING.to_string(),
                    value,
                },
            )
            .map_err(|error| error.to_string())
        },
    )?;
    match zoom_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[tauri::command]
pub(crate) fn zoom(app: AppHandle, direction: ZoomDirection) -> Result<(), String> {
    set_app_zoom(&app, direction)
}

/// The two `html` background colours from index.html, so a window carries the page's own surface from the
/// moment it appears rather than the platform default.
fn theme_background(theme: Theme) -> Color {
    match theme {
        Theme::Dark => Color(10, 10, 10, 255),
        _ => Color(255, 255, 255, 255),
    }
}

fn reveal_window(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    window
        .app_handle()
        .set_activation_policy(tauri::ActivationPolicy::Regular)
        .map_err(|error| error.to_string())?;
    let theme = window.theme().unwrap_or(Theme::Light);
    window
        .set_background_color(Some(theme_background(theme)))
        .map_err(|error| error.to_string())?;
    #[cfg(all(target_os = "windows", not(debug_assertions)))]
    if let Err(error) = disable_browser_accelerator_keys(window) {
        log::error!("Could not disable browser accelerator keys: {error}");
    }
    if let Err(error) = saved_zoom_factor()
        .and_then(|factor| window.set_zoom(factor).map_err(|error| error.to_string()))
    {
        log::error!("Could not apply the saved zoom factor: {error}");
    }
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[cfg(all(target_os = "windows", not(debug_assertions)))]
fn disable_browser_accelerator_keys(window: &WebviewWindow) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;

    window
        .with_webview(|webview| unsafe {
            let result = webview
                .controller()
                .CoreWebView2()
                .and_then(|webview| webview.Settings())
                .and_then(|settings| settings.cast::<ICoreWebView2Settings3>())
                .and_then(|settings| settings.SetAreBrowserAcceleratorKeysEnabled(false));
            if let Err(error) = result {
                log::error!("Could not disable browser accelerator keys: {error}");
            }
        })
        .map_err(|error| error.to_string())
}

pub(crate) fn reveal_launcher(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        return reveal_window(&window);
    }
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .ok_or_else(|| "Could not find the launcher window configuration.".to_string())?;
    let window = WebviewWindowBuilder::from_config(app, config)
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?;
    watch_sharing_close(&window);
    reveal_window(&window)
}

pub(crate) fn should_keep_sharing_without_windows(
    sharing: bool,
    has_reachable_control: bool,
    exiting_from_tray: bool,
) -> bool {
    sharing && has_reachable_control && !exiting_from_tray
}

/// Whether closing the last window leaves a way back to the app while sharing: the Dock on
/// macOS, the sharing tray icon on Linux and Windows. Without one the app must stop with the
/// window instead of keeping repository access on the network with nothing visible.
#[cfg(target_os = "macos")]
pub(crate) fn sharing_survives_window_close(_: &AppHandle) -> bool {
    true
}

#[cfg(target_os = "linux")]
pub(crate) fn sharing_survives_window_close(app: &AppHandle) -> bool {
    app.tray_by_id("sharing").is_some() && status_notifier_host_available()
}

#[cfg(target_os = "windows")]
pub(crate) fn sharing_survives_window_close(app: &AppHandle) -> bool {
    app.tray_by_id("sharing").is_some()
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub(crate) fn sharing_survives_window_close(_: &AppHandle) -> bool {
    false
}

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
pub(crate) fn watch_sharing_close(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::CloseRequested { .. })
            || app
                .webview_windows()
                .values()
                .filter(|window| window.is_visible().unwrap_or(true))
                .count()
                != 1
            || !active_sharing_state(&app).sharing
            || !sharing_survives_window_close(&app)
            || app.state::<TrayExit>().0.load(std::sync::atomic::Ordering::Relaxed)
        {
            return;
        }
        let already_shown = load_settings()
            .ok()
            .and_then(|settings| settings.get(SERVE_CLOSE_NOTICE_SETTING).and_then(serde_json::Value::as_bool))
            .unwrap_or(false);
        if already_shown {
            return;
        }
        if let Err(error) = save_setting(
            SERVE_CLOSE_NOTICE_SETTING.to_string(),
            serde_json::Value::Bool(true),
        ) {
            log::warn!("Could not save sharing close notice state: {error}");
            return;
        }
        app.dialog()
            .message(SHARING_CLOSE_NOTICE)
            .title("Sharing is still on")
            .show(|_| {});
    });
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub(crate) fn watch_sharing_close(_: &WebviewWindow) {}

#[tauri::command(async)]
pub(crate) fn show_launcher(app: AppHandle) -> Result<(), String> {
    reveal_launcher(&app)
}

#[tauri::command]
pub(crate) async fn choose_repository(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let picker_app = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        picker_app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Choose a Git repository")
            .blocking_pick_folder()
    })
    .await
    .map_err(|error| error.to_string())?;
    let Some(path) = selected else {
        return Ok(());
    };
    let path = path.into_path().map_err(|error| error.to_string())?;
    open_repository_window(&app, &path.to_string_lossy())
}

#[cfg(target_os = "macos")]
pub(crate) fn install_app_menu(app: &AppHandle) -> Result<(), String> {
    let menu = Menu::default(app).map_err(|error| error.to_string())?;
    let file = menu_submenu(&menu, "File")?;
    let view = menu_submenu(&menu, "View")?;
    let window = menu_submenu(&menu, "Window")?;
    let recent = Submenu::with_id(app, "open-recent", "Open Recent", true)
        .map_err(|error| error.to_string())?;

    let new_window = MenuItem::with_id(
        app,
        MENU_NEW_WINDOW,
        "New Window",
        true,
        Some("CmdOrCtrl+N"),
    )
    .map_err(|error| error.to_string())?;
    let open = MenuItem::with_id(app, MENU_OPEN, "Open…", true, Some("CmdOrCtrl+O"))
        .map_err(|error| error.to_string())?;
    let reopen_tab = MenuItem::with_id(
        app,
        MENU_REOPEN_TAB,
        "Reopen Closed Tab",
        true,
        Some("Shift+CmdOrCtrl+T"),
    )
    .map_err(|error| error.to_string())?;
    let file_separator = PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;
    file.prepend_items(&[&new_window, &open, &recent, &reopen_tab, &file_separator])
        .map_err(|error| error.to_string())?;

    let close_tab = MenuItem::with_id(app, MENU_CLOSE_TAB, "Close Tab", true, Some("CmdOrCtrl+W"))
        .map_err(|error| error.to_string())?;
    let close_window = MenuItem::with_id(
        app,
        MENU_CLOSE_WINDOW,
        "Close Window",
        true,
        Some("Shift+CmdOrCtrl+W"),
    )
    .map_err(|error| error.to_string())?;
    replace_close_window_item(&file, &[&close_tab, &close_window])?;
    replace_close_window_item(&window, &[&close_window])?;

    let zoom_in = MenuItem::with_id(app, MENU_ZOOM_IN, "Zoom In", true, Some("CmdOrCtrl+="))
        .map_err(|error| error.to_string())?;
    let zoom_out = MenuItem::with_id(app, MENU_ZOOM_OUT, "Zoom Out", true, Some("CmdOrCtrl+-"))
        .map_err(|error| error.to_string())?;
    let actual_size = MenuItem::with_id(
        app,
        MENU_ACTUAL_SIZE,
        "Actual Size",
        true,
        Some("CmdOrCtrl+0"),
    )
    .map_err(|error| error.to_string())?;
    let view_separator = PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;
    view.prepend_items(&[&zoom_in, &zoom_out, &actual_size, &view_separator])
        .map_err(|error| error.to_string())?;

    let window_separator = PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;
    let bring_all =
        PredefinedMenuItem::bring_all_to_front(app, None).map_err(|error| error.to_string())?;
    window
        .append_items(&[&window_separator, &bring_all])
        .map_err(|error| error.to_string())?;

    populate_recent_menu(app, &recent, &[])?;
    app.set_menu(menu).map_err(|error| error.to_string())?;
    app.manage(AppMenuState {
        recent,
        rebuild_generation: AtomicU64::new(0),
        rebuild_lock: Mutex::new(()),
    });
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        let result = match id {
            MENU_NEW_WINDOW => reveal_launcher(app),
            MENU_CLEAR_RECENT => clear_recent_paths(Some(app)),
            MENU_ZOOM_IN => set_app_zoom(app, ZoomDirection::In),
            MENU_ZOOM_OUT => set_app_zoom(app, ZoomDirection::Out),
            MENU_ACTUAL_SIZE => set_app_zoom(app, ZoomDirection::ActualSize),
            // Which tab is active, which ones closed, and whether there are any at all, is only
            // known to the window.
            MENU_CLOSE_TAB => match app
                .webview_windows()
                .into_values()
                .find(|window| window.is_focused().unwrap_or(false))
            {
                Some(window) => app
                    .emit_to(window.label(), CLOSE_TAB_EVENT, ())
                    .map_err(|error| error.to_string()),
                None => Ok(()),
            },
            MENU_REOPEN_TAB => match focused_window(app) {
                Some(window) => app
                    .emit_to(window.label(), REOPEN_TAB_EVENT, ())
                    .map_err(|error| error.to_string()),
                None => Ok(()),
            },
            MENU_CLOSE_WINDOW => match app
                .webview_windows()
                .into_values()
                .find(|window| window.is_focused().unwrap_or(false))
            {
                Some(window) => window.close().map_err(|error| error.to_string()),
                None => Ok(()),
            },
            MENU_OPEN => {
                let app = app.clone();
                let window = focused_window(&app);
                match window {
                    Some(window) => {
                        tauri::async_runtime::spawn(async move {
                            if let Err(error) = choose_repository(app, window).await {
                                log::error!("Could not open a repository: {error}");
                            }
                        });
                        Ok(())
                    }
                    None => Err("Could not find a window for the repository picker.".to_string()),
                }
            }
            _ => recent_menu_path(id).map_or(Ok(()), |path| open_repository_window(app, path)),
        };
        if let Err(error) = result {
            log::error!("Menu command failed: {error}");
        }
    });
    Ok(())
}

// Windows deadlocks when a webview is built on the main thread, which is where a synchronous
// command runs, so every command that reaches this is declared async.
pub(crate) fn open_repository_window(app: &AppHandle, path: &str) -> Result<(), String> {
    let project = remember_repository(path, &app.state::<OpenWorktrees>(), Some(app))?;
    let worktree_path = worktree_path(path)?;
    let label = format!(
        "repository-{}",
        worktree_path.as_bytes().iter().fold(0u64, |hash, byte| hash
            .wrapping_mul(31)
            .wrapping_add(*byte as u64))
    );

    if let Some(window) = app.get_webview_window(&label) {
        window.set_focus().map_err(|error| error.to_string())?;
    } else {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("repository", &worktree_path)
            .finish();
        let url = format!("/?{query}");
        let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
            .title(format!("{} · Git Nav", worktree_name(&worktree_path)))
            .inner_size(1280.0, 800.0)
            .min_inner_size(500.0, 400.0)
            .visible(false);
        #[cfg(target_os = "macos")]
        let builder = builder
            .decorations(true)
            .title_bar_style(tauri::TitleBarStyle::Transparent)
            .hidden_title(false);
        let window = builder
            .build()
            .map_err(|error| error.to_string())?;
        watch_sharing_close(&window);
        reveal_window(&window)?;
        window.on_window_event({
            let app = app.clone();
            let label = label.clone();
            move |event| {
                if matches!(event, WindowEvent::Destroyed) {
                    if let Ok(mut worktrees) = app.state::<OpenWorktrees>().0.lock() {
                        worktrees.remove(&label);
                    }
                }
            }
        });
        app.state::<OpenWorktrees>()
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .insert(
                label,
                OpenWorktree {
                    project_id: project.id,
                    worktree_path,
                },
            );
    }

    if let Some(window) = app.get_webview_window("main") {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn repository_path_from_args(args: &[String], cwd: &str) -> Option<String> {
    let path = args.get(1)?;
    let path = PathBuf::from(path);
    Some(
        if path.is_absolute() {
            path
        } else {
            PathBuf::from(cwd).join(path)
        }
        .to_string_lossy()
        .into_owned(),
    )
}

#[tauri::command(async)]
pub(crate) fn open_repository(app: AppHandle, path: String) -> Result<(), String> {
    open_repository_window(&app, &path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn sharing_only_survives_without_windows_when_a_control_remains_reachable() {
        assert!(should_keep_sharing_without_windows(true, true, false));
        assert!(!should_keep_sharing_without_windows(true, false, false));
        assert!(!should_keep_sharing_without_windows(true, true, true));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn recent_menu_ids_round_trip_the_selected_path() {
        let path = "/Volumes/External/repository 4";
        assert_eq!(recent_menu_path(&recent_menu_id(path)), Some(path));
        assert_eq!(recent_menu_path("unrelated-menu-item"), None);
    }

    #[test]
    fn zoom_uses_ten_percent_steps_and_clamps_the_range() {
        assert_eq!(next_zoom_factor(1.0, ZoomDirection::In), 1.1);
        assert_eq!(next_zoom_factor(1.0, ZoomDirection::Out), 0.9);
        assert_eq!(next_zoom_factor(1.7, ZoomDirection::ActualSize), 1.0);
        assert_eq!(next_zoom_factor(2.0, ZoomDirection::In), 2.0);
        assert_eq!(next_zoom_factor(0.5, ZoomDirection::Out), 0.5);
        assert_eq!(next_zoom_factor(f64::NAN, ZoomDirection::In), 1.1);
    }

    #[test]
    fn uses_the_invocation_directory_for_relative_paths() {
        let cwd = env::temp_dir().join("workspace");
        let expected = cwd.join("repository").to_string_lossy().into_owned();
        let path = repository_path_from_args(
            &["git-nav".to_string(), "repository".to_string()],
            &cwd.to_string_lossy(),
        );

        assert_eq!(path.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn preserves_absolute_paths() {
        let expected = env::temp_dir()
            .join("workspace")
            .join("repository")
            .to_string_lossy()
            .into_owned();
        let path = repository_path_from_args(
            &["git-nav".to_string(), expected.clone()],
            &env::temp_dir().join("other-workspace").to_string_lossy(),
        );

        assert_eq!(path.as_deref(), Some(expected.as_str()));
    }
}
