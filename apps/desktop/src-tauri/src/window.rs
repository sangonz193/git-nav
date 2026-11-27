use serde::Deserialize;
use std::{collections::HashMap, collections::HashSet, path::PathBuf, sync::Mutex};
use tauri::{
    AppHandle, Emitter, Manager, Theme, WebviewWindow, WebviewWindowBuilder,
    WindowEvent, window::Color,
};
use tauri_plugin_dialog::DialogExt;
#[cfg(target_os = "macos")]
use std::{sync::atomic::AtomicU64, sync::atomic::Ordering};
#[cfg(target_os = "macos")]
use tauri::{
    menu::IsMenuItem, menu::Menu, menu::MenuItem, menu::MenuItemKind, menu::PredefinedMenuItem,
    menu::Submenu,
};
use crate::storage::{
    SETTING_CHANGED_EVENT, SettingChanged, load_settings, save_setting_at_then, settings_path,
};
use crate::projects::{WindowProjects, remember_repository};
use crate::git::resolve_project_id;
use crate::sharing::TrayExit;
use crate::window_sessions::{
    ActiveProject, MAIN_WINDOW, WindowSession, forget_window_session, load_window_sessions,
    save_window_session,
    take_restorable_window_sessions,
};
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
use crate::storage::save_setting;
#[cfg(target_os = "macos")]
use crate::projects::{Project, clear_recent_paths, recent_project_list};
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
use crate::sharing::active_sharing_state;
#[cfg(target_os = "linux")]
use crate::sharing::status_notifier_host_available;

#[cfg(target_os = "macos")]
const CLOSE_TAB_EVENT: &str = "close-tab";
#[cfg(target_os = "macos")]
const REOPEN_TAB_EVENT: &str = "reopen-tab";
const ZOOM_FACTOR_SETTING: &str = "app.zoomFactor";
const REPOSITORIES_OPENED_EVENT: &str = "repositories-opened";
const WINDOW_LABEL_PREFIX: &str = "window-";

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
        .or_else(|| target_window(app, None))
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
            recent_project_list(&list_app.state::<WindowProjects>())
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

fn set_theme_background(window: &WebviewWindow, theme: Theme) -> Result<(), String> {
    window
        .set_background_color(Some(theme_background(theme)))
        .map_err(|error| error.to_string())
}

fn reveal_window(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    window
        .app_handle()
        .set_activation_policy(tauri::ActivationPolicy::Regular)
        .map_err(|error| error.to_string())?;
    let theme = window.theme().unwrap_or(Theme::Light);
    set_theme_background(window, theme)?;
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
    if let Ok(mut focused) = window.app_handle().state::<LastFocusedWindow>().0.lock() {
        *focused = Some(window.label().to_string());
    }
    window.set_focus().map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn watch_window_theme(window: &WebviewWindow) {
    let window = window.clone();
    window.clone().on_window_event(move |event| {
        if let WindowEvent::ThemeChanged(theme) = event {
            if let Err(error) = set_theme_background(&window, theme.clone()) {
                log::error!("Could not update the window background for the system theme: {error}");
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn watch_window_theme(_: &WebviewWindow) {}

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

#[derive(Default)]
pub(crate) struct PendingRepositories(Mutex<HashMap<String, Vec<ActiveProject>>>);

impl PendingRepositories {
    fn deliver(&self, window_projects: &WindowProjects, label: &str, opened: ActiveProject) -> Result<(), String> {
        let mut window_projects = window_projects.0.lock().map_err(|error| error.to_string())?;
        let mut pending = self.0.lock().map_err(|error| error.to_string())?;
        window_projects.insert(label.to_string(), WindowSession {
            label: label.to_string(),
            active: Some(opened.clone()),
        });
        pending.entry(label.to_string()).or_default().push(opened);
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct LastFocusedWindow(Mutex<Option<String>>);

#[derive(Default)]
pub(crate) struct WindowLabels {
    // Handed out to windows still being built, so two built at once never get the same label.
    reserved: Mutex<HashSet<String>>,
    sessions: Mutex<WindowSessionLifecycle>,
}

#[derive(Default)]
struct WindowSessionLifecycle {
    live: HashSet<String>,
    closing: HashSet<String>,
}

impl WindowSessionLifecycle {
    fn save_project(
        &self,
        window_projects: &WindowProjects,
        session: WindowSession,
        save: impl FnOnce(WindowSession) -> Result<(), String>,
    ) -> Result<(), String> {
        if !self.live.contains(&session.label) {
            return Ok(());
        }
        // Delivered projects are authoritative because an older frontend save can arrive afterward.
        let mut window_projects = window_projects.0.lock().map_err(|error| error.to_string())?;
        window_projects.entry(session.label.clone()).or_insert_with(|| session.clone());
        save(session)
    }

    fn clear_project(&self, window_projects: &WindowProjects, label: &str, project: &str) -> Result<(), String> {
        if !self.live.contains(label) {
            return Ok(());
        }
        let mut window_projects = window_projects.0.lock().map_err(|error| error.to_string())?;
        if let Some(session) = window_projects.get_mut(label) {
            if session.active.as_ref().is_some_and(|active| active.project == project) {
                session.active = None;
            }
        }
        Ok(())
    }
}

fn free_window_label(taken: &HashSet<String>) -> String {
    (2..)
        .map(|index| format!("{WINDOW_LABEL_PREFIX}{index}"))
        .find(|label| !taken.contains(label))
        .expect("an unused window label")
}

fn create_new_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let labels = app.state::<WindowLabels>();
    let label = {
        let mut reserved = labels.reserved.lock().map_err(|error| error.to_string())?;
        let mut taken = app.webview_windows().into_keys().collect::<HashSet<_>>();
        taken.extend(reserved.iter().cloned());
        taken.extend(
            load_window_sessions()
                .unwrap_or_default()
                .into_iter()
                .map(|session| session.label),
        );
        let label = free_window_label(&taken);
        reserved.insert(label.clone());
        label
    };
    let window = create_window(app, &label);
    if let Ok(mut reserved) = labels.reserved.lock() {
        reserved.remove(&label);
    }
    window
}

fn watch_window_session(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    if let Ok(mut sessions) = app.state::<WindowLabels>().sessions.lock() {
        sessions.live.insert(label.clone());
    }
    window.on_window_event(move |event| match event {
        WindowEvent::Focused(true) => {
            if let Ok(mut focused) = app.state::<LastFocusedWindow>().0.lock() {
                *focused = Some(label.clone());
            }
        }
        WindowEvent::CloseRequested { .. } => {
            if let Ok(mut sessions) = app.state::<WindowLabels>().sessions.lock() {
                sessions.closing.insert(label.clone());
            }
        }
        WindowEvent::Destroyed => {
            let labels = app.state::<WindowLabels>();
            let mut sessions = labels.sessions.lock().ok();
            let closed_alone = sessions
                .as_mut()
                .map(|sessions| {
                    sessions.live.remove(&label);
                    sessions.closing.remove(&label)
                        && app
                            .webview_windows()
                            .keys()
                            .any(|other| *other != label && !sessions.closing.contains(other))
                })
                .unwrap_or(false);
            if closed_alone && !app.state::<TrayExit>().0.load(std::sync::atomic::Ordering::Relaxed) {
                if let Err(error) = forget_window_session(&label) {
                    log::error!("Could not forget the closed window's repositories: {error}");
                }
            }
            if let Ok(mut window_projects) = app.state::<WindowProjects>().0.lock() {
                window_projects.remove(&label);
            }
            if let Ok(mut pending) = app.state::<PendingRepositories>().0.lock() {
                pending.remove(&label);
            }
            if let Ok(mut focused) = app.state::<LastFocusedWindow>().0.lock() {
                if focused.as_deref() == Some(label.as_str()) {
                    *focused = None;
                }
            }
        }
        _ => {}
    });
}

// Windows deadlocks when a webview is built on the main thread, which is where a synchronous
// command runs, so every command that reaches this is declared async.
fn create_window(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == MAIN_WINDOW)
        .cloned()
        .ok_or_else(|| "Could not find the window configuration.".to_string())?;
    config.label = label.to_string();
    let window = WebviewWindowBuilder::from_config(app, &config)
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?;
    watch_window_theme(&window);
    watch_sharing_close(&window);
    watch_window_session(&window);
    Ok(window)
}

pub(crate) fn restore_windows(app: &AppHandle) -> Result<WebviewWindow, String> {
    let sessions = take_restorable_window_sessions().unwrap_or_else(|error| {
        log::error!("Could not restore the previous windows: {error}");
        Vec::new()
    });
    if let Ok(mut window_projects) = app.state::<WindowProjects>().0.lock() {
        for session in &sessions {
            window_projects.insert(session.label.clone(), session.clone());
        }
    }
    let labels = if sessions.is_empty() {
        vec![MAIN_WINDOW.to_string()]
    } else {
        sessions.into_iter().map(|session| session.label).collect()
    };
    for label in labels.iter().rev() {
        if let Err(error) = create_window(app, label).and_then(|window| reveal_window(&window)) {
            log::error!("Could not restore the {label} window: {error}");
        }
    }
    match target_window(app, None) {
        Some(window) => Ok(window),
        None => {
            let window = create_window(app, MAIN_WINDOW)?;
            reveal_window(&window)?;
            Ok(window)
        }
    }
}

fn target_window_label<Window>(
    windows: &HashMap<String, Window>,
    closing: &HashSet<String>,
    preferred: Option<&str>,
    last_focused: Option<&str>,
) -> Option<String> {
    [preferred, last_focused, Some(MAIN_WINDOW)]
        .into_iter()
        .flatten()
        .chain(windows.keys().map(String::as_str))
        .find(|label| windows.contains_key(*label) && !closing.contains(*label))
        .map(String::from)
}

pub(crate) fn target_window(app: &AppHandle, preferred: Option<&str>) -> Option<WebviewWindow> {
    let last_focused = app
        .state::<LastFocusedWindow>()
        .0
        .lock()
        .ok()
        .and_then(|focused| focused.clone());
    let labels = app.state::<WindowLabels>();
    let sessions = labels.sessions.lock().ok()?;
    let mut windows = app.webview_windows();
    let label = target_window_label(&windows, &sessions.closing, preferred, last_focused.as_deref())?;
    windows.remove(&label)
}

pub(crate) fn show_windows(app: &AppHandle) -> Result<(), String> {
    match target_window(app, None) {
        Some(window) => reveal_window(&window),
        None => restore_windows(app).map(|_| ()),
    }
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
pub(crate) fn new_window(app: AppHandle) -> Result<(), String> {
    reveal_window(&create_new_window(&app)?)
}

#[tauri::command]
pub(crate) async fn choose_repository(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let window_label = window.label().to_string();
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
    open_repository_window(&app, &path.to_string_lossy(), Some(window_label.as_str()))
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
            MENU_NEW_WINDOW => create_new_window(app).and_then(|window| reveal_window(&window)),
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
            _ => recent_menu_path(id).map_or(Ok(()), |path| {
                let label = focused_window(app).map(|window| window.label().to_string());
                open_repository_window(app, path, label.as_deref())
            }),
        };
        if let Err(error) = result {
            log::error!("Menu command failed: {error}");
        }
    });
    Ok(())
}

fn deliver_repository(
    app: &AppHandle,
    window: &WebviewWindow,
    opened: ActiveProject,
) -> Result<(), String> {
    app.state::<PendingRepositories>()
        .deliver(&app.state::<WindowProjects>(), window.label(), opened)?;
    app.emit_to(window.label(), REPOSITORIES_OPENED_EVENT, ())
        .map_err(|error| error.to_string())?;
    reveal_window(window)
}

fn resolve_opened(app: &AppHandle, path: &str) -> Result<ActiveProject, String> {
    let project = remember_repository(path, &app.state::<WindowProjects>(), Some(app))?;
    Ok(ActiveProject { project: project.id })
}

fn window_showing_label(
    sessions: &HashMap<String, WindowSession>,
    project: &str,
    excluded: Option<&str>,
    closing: &HashSet<String>,
) -> Option<String> {
    sessions
        .iter()
        .find(|(label, session)| {
            excluded != Some(label.as_str())
                && !closing.contains(*label)
                && session
                    .active
                    .as_ref()
                    .is_some_and(|active| active.project == project)
        })
        .map(|(label, _)| label.clone())
}

fn window_showing(app: &AppHandle, project: &str, excluded: Option<&str>) -> Option<WebviewWindow> {
    let labels = app.state::<WindowLabels>();
    let sessions = labels.sessions.lock().ok()?;
    let label = window_showing_label(
        &*app.state::<WindowProjects>().0.lock().ok()?,
        project,
        excluded,
        &sessions.closing,
    )?;
    app.get_webview_window(&label)
}

pub(crate) fn open_repository_window(
    app: &AppHandle,
    path: &str,
    preferred: Option<&str>,
) -> Result<(), String> {
    let opened = resolve_opened(app, path)?;
    let window = match window_showing(app, &opened.project, None).or_else(|| target_window(app, preferred)) {
        Some(window) => window,
        None if !app.webview_windows().is_empty() => create_new_window(app)?,
        None => {
            let restored = restore_windows(app)?;
            window_showing(app, &opened.project, None).unwrap_or(restored)
        }
    };
    deliver_repository(app, &window, opened)
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
pub(crate) fn open_repository(app: AppHandle, window: WebviewWindow, path: String) -> Result<(), String> {
    open_repository_window(&app, &path, Some(window.label()))
}

#[tauri::command(async)]
pub(crate) fn open_repository_in_new_window(app: AppHandle, window: WebviewWindow, path: String) -> Result<(), String> {
    let opened = resolve_opened(&app, &path)?;
    if let Some(existing) = window_showing(&app, &opened.project, Some(window.label())) {
        return reveal_window(&existing);
    }
    let window = create_new_window(&app)?;
    deliver_repository(&app, &window, opened)
}

fn restored_window_project(active: ActiveProject) -> Option<ActiveProject> {
    Some(ActiveProject {
        project: resolve_project_id(&active.project).ok()?,
    })
}

#[tauri::command(async)]
pub(crate) fn window_session(window: WebviewWindow) -> Result<WindowSession, String> {
    let label = window.label();
    let session = load_window_sessions()?
        .into_iter()
        .find(|session| session.label == label)
        .unwrap_or_default();
    let active = session.active.and_then(restored_window_project);
    Ok(WindowSession {
        active,
        label: label.to_string(),
    })
}

#[tauri::command(async)]
pub(crate) fn save_window_project(
    window: WebviewWindow,
    labels: tauri::State<WindowLabels>,
    window_projects: tauri::State<WindowProjects>,
    active: Option<ActiveProject>,
) -> Result<(), String> {
    let session = WindowSession {
        label: window.label().to_string(),
        active,
    };
    // Serialize saves with closing and destruction so a late save cannot resurrect a session.
    let sessions = labels.sessions.lock().map_err(|error| error.to_string())?;
    sessions.save_project(&window_projects, session, save_window_session)
}

#[tauri::command]
pub(crate) fn clear_window_project(
    window: WebviewWindow,
    labels: tauri::State<WindowLabels>,
    window_projects: tauri::State<WindowProjects>,
    project: String,
) -> Result<(), String> {
    let sessions = labels.sessions.lock().map_err(|error| error.to_string())?;
    sessions.clear_project(&window_projects, window.label(), &project)
}

#[tauri::command]
pub(crate) fn take_opened_repositories(
    window: WebviewWindow,
    pending: tauri::State<PendingRepositories>,
) -> Result<Vec<ActiveProject>, String> {
    Ok(pending
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .remove(window.label())
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::project_id;
    use std::env;

    fn active(project: &str) -> ActiveProject {
        ActiveProject { project: project.to_string() }
    }

    #[test]
    fn restores_existing_projects_and_leaves_unresolvable_projects_empty() {
        use crate::test_support::{remove_scratch_repository, scratch_repository};

        let (path, run) = scratch_repository("window-restore-project");
        run(&["commit", "--allow-empty", "--quiet", "-m", "init"]);
        let project = active(&project_id(&path).unwrap());
        assert_eq!(restored_window_project(project.clone()), Some(project));
        assert_eq!(restored_window_project(active(&format!("{path}/missing-project"))), None);
        remove_scratch_repository(&path);
    }

    #[test]
    fn restores_a_bare_repository_project_when_bare_repositories_must_be_explicit() {
        use crate::test_support::{remove_scratch_repository, rerun_with_explicit_bare_repositories, scratch_repository};

        if rerun_with_explicit_bare_repositories(
            "window::tests::restores_a_bare_repository_project_when_bare_repositories_must_be_explicit",
        ) {
            return;
        }
        let (path, run) = scratch_repository("window-restore-explicit-bare");
        run(&["commit", "--allow-empty", "--quiet", "-m", "init"]);
        let bare = format!("{path}-origin.git");
        let checkout = format!("{path}-checkout");
        run(&["clone", "--bare", "--quiet", &path, &bare]);
        run(&["--git-dir", &bare, "worktree", "add", "--quiet", &checkout, "main"]);
        let project = active(&project_id(&checkout).unwrap());
        assert_eq!(restored_window_project(project.clone()), Some(project));
        remove_scratch_repository(&checkout);
        remove_scratch_repository(&bare);
        remove_scratch_repository(&path);
    }

    #[test]
    fn saves_projects_for_live_windows_including_while_closing() {
        for active in [None, Some(active("/code/app/.git"))] {
            let session = WindowSession {
                label: "window-2".to_string(),
                active,
            };
            let window_projects = WindowProjects::default();
            let mut lifecycle = WindowSessionLifecycle::default();
            lifecycle.live.insert(session.label.clone());
            let mut saved = None;
            lifecycle.save_project(&window_projects, session.clone(), |session| {
                saved = Some(session);
                Ok(())
            }).unwrap();
            assert_eq!(saved, Some(session.clone()));
            assert_eq!(window_projects.0.lock().unwrap().get(&session.label), Some(&session));

            lifecycle.closing.insert(session.label.clone());
            saved = None;
            lifecycle.save_project(&window_projects, session.clone(), |session| {
                saved = Some(session);
                Ok(())
            }).unwrap();
            assert_eq!(saved, Some(session.clone()));
            assert_eq!(window_projects.0.lock().unwrap().get(&session.label), Some(&session));

            lifecycle.live.remove(&session.label);
            lifecycle.closing.remove(&session.label);
            window_projects.0.lock().unwrap().remove(&session.label);
            lifecycle.save_project(&window_projects, session, |_| {
                panic!("a destroyed window must not write its session")
            }).unwrap();
            assert!(window_projects.0.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn a_stale_save_cannot_replace_a_delivered_routing_assignment() {
        let pending = PendingRepositories::default();
        let window_projects = WindowProjects::default();
        let mut lifecycle = WindowSessionLifecycle::default();
        lifecycle.live.insert("main".to_string());
        let previous = WindowSession {
            label: "main".to_string(),
            active: Some(active("/a")),
        };
        lifecycle.save_project(&window_projects, previous.clone(), |_| Ok(())).unwrap();
        let delivered = active("/b");
        pending.deliver(&window_projects, "main", delivered.clone()).unwrap();
        pending.0.lock().unwrap().remove("main");
        lifecycle.save_project(&window_projects, WindowSession { label: "main".to_string(), active: None }, |_| Ok(())).unwrap();
        lifecycle.save_project(&window_projects, previous, |_| Ok(())).unwrap();
        {
            let sessions = window_projects.0.lock().unwrap();
            assert_eq!(sessions["main"].active, Some(delivered.clone()));
            assert_eq!(window_showing_label(&sessions, "/b", None, &HashSet::new()).as_deref(), Some("main"));
        }
        lifecycle.save_project(&window_projects, WindowSession { label: "main".to_string(), active: Some(delivered.clone()) }, |_| Ok(())).unwrap();
        assert_eq!(window_projects.0.lock().unwrap()["main"].active, Some(delivered));
    }

    #[test]
    fn explicit_clears_release_only_the_named_project_in_the_live_window() {
        let pending = PendingRepositories::default();
        let window_projects = WindowProjects::default();
        let mut lifecycle = WindowSessionLifecycle::default();
        lifecycle.live.extend(["main".to_string(), "window-2".to_string()]);
        let first = active("/a");
        let second = active("/b");
        pending.deliver(&window_projects, "main", first.clone()).unwrap();
        pending.deliver(&window_projects, "main", second.clone()).unwrap();
        lifecycle.clear_project(&window_projects, "main", &first.project).unwrap();
        assert_eq!(window_projects.0.lock().unwrap()["main"].active, Some(second.clone()));

        pending.deliver(&window_projects, "window-2", second.clone()).unwrap();
        lifecycle.closing.insert("main".to_string());
        lifecycle.clear_project(&window_projects, "main", &second.project).unwrap();
        for active in [None, Some(second.clone())] {
            lifecycle.save_project(&window_projects, WindowSession { label: "main".to_string(), active }, |_| Ok(())).unwrap();
            let sessions = window_projects.0.lock().unwrap();
            assert!(sessions["main"].active.is_none());
            assert_eq!(window_showing_label(&sessions, "/b", None, &HashSet::new()).as_deref(), Some("window-2"));
        }

        lifecycle.closing.remove("main");
        pending.deliver(&window_projects, "main", first).unwrap();
        assert_eq!(window_showing_label(&window_projects.0.lock().unwrap(), "/a", None, &HashSet::new()).as_deref(), Some("main"));
        lifecycle.live.remove("main");
        window_projects.0.lock().unwrap().remove("main");
        lifecycle.clear_project(&window_projects, "main", "/a").unwrap();
        assert!(!window_projects.0.lock().unwrap().contains_key("main"));
    }

    #[test]
    fn routes_to_the_window_showing_the_project() {
        let sessions = [
            ("main", Some("/code/app/.git")),
            ("window-2", Some("/code/other/.git")),
            ("window-3", None),
        ]
        .into_iter()
        .map(|(label, project)| {
            (
                label.to_string(),
                WindowSession {
                    label: label.to_string(),
                    active: project.map(active),
                },
            )
        })
        .collect();

        assert_eq!(
            window_showing_label(&sessions, "/code/app/.git", None, &HashSet::new()).as_deref(),
            Some("main"),
        );
        assert_eq!(
            window_showing_label(&sessions, "/code/other/.git", None, &HashSet::new()).as_deref(),
            Some("window-2"),
        );
        assert_eq!(window_showing_label(&sessions, "/code/third/.git", None, &HashSet::new()), None);
        assert_eq!(window_showing_label(&sessions, "/code/app/.git", Some("main"), &HashSet::new()), None);
        assert_eq!(
            window_showing_label(&sessions, "/code/other/.git", Some("main"), &HashSet::new()).as_deref(),
            Some("window-2"),
        );
    }

    #[test]
    fn targets_the_preferred_or_last_revealed_window_and_skips_closing_windows() {
        let windows = HashMap::from([
            ("main".to_string(), ()),
            ("window-2".to_string(), ()),
            ("window-3".to_string(), ()),
        ]);
        let mut closing = HashSet::new();
        assert_eq!(target_window_label(&windows, &closing, None, Some("window-2")).as_deref(), Some("window-2"));
        assert_eq!(target_window_label(&windows, &closing, Some("window-3"), Some("window-2")).as_deref(), Some("window-3"));
        closing.insert("window-3".to_string());
        assert_eq!(target_window_label(&windows, &closing, Some("window-3"), Some("window-2")).as_deref(), Some("window-2"));
        closing.insert("window-2".to_string());
        assert_eq!(target_window_label(&windows, &closing, None, Some("window-2")).as_deref(), Some("main"));
        closing.insert("main".to_string());
        assert_eq!(target_window_label(&windows, &closing, Some("main"), None), None);
    }

    #[test]
    fn delivered_projects_are_routable_before_the_window_saves() {
        let pending = PendingRepositories::default();
        let window_projects = WindowProjects::default();
        let opened = active("/code/app/.git");
        pending.deliver(&window_projects, "window-2", opened.clone()).unwrap();
        let sessions = window_projects.0.lock().unwrap();
        assert_eq!(sessions["window-2"].active, Some(opened.clone()));
        assert_eq!(
            window_showing_label(&sessions, &opened.project, None, &HashSet::new()).as_deref(),
            Some("window-2"),
        );
        assert_eq!(pending.0.lock().unwrap()["window-2"], vec![opened.clone()]);

        let closing = HashSet::from(["window-2".to_string()]);
        assert_eq!(window_showing_label(&sessions, &opened.project, None, &closing), None);
    }

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
    fn new_windows_take_the_lowest_free_label() {
        let taken = ["main", "window-2", "window-4"]
            .into_iter()
            .map(String::from)
            .collect::<HashSet<_>>();
        assert_eq!(free_window_label(&taken), "window-3");
        assert_eq!(free_window_label(&HashSet::new()), "window-2");
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
