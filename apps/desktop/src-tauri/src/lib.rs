use serde::{Deserialize, Serialize};
use rusqlite::{params, Connection, OptionalExtension};
#[cfg(any(target_os = "linux", test))]
use std::ffi::{OsStr, OsString};
use std::{
    collections::{hash_map::DefaultHasher, BTreeMap, HashMap, HashSet},
    env, fs,
    hash::{Hash, Hasher},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
#[cfg(any(target_os = "macos", test))]
use std::sync::Arc;
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use tauri::{
    ipc::Channel, window::Color, AppHandle, Emitter, Manager, RunEvent, Theme, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
#[cfg(target_os = "macos")]
use tauri::menu::{IsMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri_plugin_dialog::DialogExt;

mod server;

/// The one list of IPC commands. It emits both the Tauri handler and the `Command` enum the HTTP
/// server matches on, so a new command cannot reach one surface without the other refusing to build.
macro_rules! commands {
    ($($name:ident),* $(,)?) => {
        #[allow(non_camel_case_types)]
        pub enum IpcCommand { $($name),* }

        impl IpcCommand {
            pub const ALL: &'static [IpcCommand] = &[$(IpcCommand::$name),*];

            pub fn name(&self) -> &'static str {
                match self { $(IpcCommand::$name => stringify!($name)),* }
            }
        }

        fn invoke_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
            tauri::generate_handler![$($name),*]
        }
    };
}

commands![
    recent_projects,
    clear_recent_projects,
    open_repository,
    show_launcher,
    choose_repository,
    zoom,
    update_command,
    open_worktree,
    open_url,
    project_snapshot,
    stream_commit_graph,
    repository_fingerprint,
    branch_sync,
    worktree_status,
    inferred_squash_merge_edges,
    fetch_and_sync_pull_requests,
    branch_pull_requests,
    squashed_branch_candidates,
    preview_cleanup_candidates,
    delete_squashed_branches,
    delete_branch,
    compare_refs,
    viewed_files,
    set_file_viewed,
    reference_picker_commits,
    repository_references,
    resolve_revision,
    select_branch_range,
    diff_file,
    predict_rebase_conflicts,
    branch_operation_state,
    repository_state,
    merge_base,
    rebase_onto,
    checkout_ref,
    push_ref,
    pull_branch,
    merge_ref,
    predict_merge_conflicts,
    predict_revert_conflicts,
    create_branch,
    rename_branch,
    create_tag,
    delete_tag,
    cherry_pick_range,
    revert_range,
    reset_current,
    stash_list,
    stash_changes,
    stash_action,
    undo_ref_updates,
    settings,
    set_setting,
    repository_layout,
    save_repository_layout,
];

const APPLICATION_IDENTIFIER: &str = "com.gitnav.desktop";
const SETTING_CHANGED_EVENT: &str = "setting-changed";
const RECENT_PROJECTS_CLEARED_EVENT: &str = "recent-projects-cleared";
const CLOSE_TAB_EVENT: &str = "close-tab";
const ZOOM_FACTOR_SETTING: &str = "app.zoomFactor";
const DEFAULT_ZOOM_FACTOR: f64 = 1.0;
const MINIMUM_ZOOM_FACTOR: f64 = 0.5;
const MAXIMUM_ZOOM_FACTOR: f64 = 2.0;
const ZOOM_STEP: f64 = 0.1;
const MAX_RECENT_REPOSITORIES: usize = 8;
const COMMIT_BATCH_SIZE: usize = 500;
const PULL_REQUEST_SYNC_INTERVAL_SECONDS: u64 = 60;
const MINIMUM_MERGE_TREE_VERSION: (u32, u32) = (2, 38);
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
// Not a legal ref name, so it cannot collide with anything the user could name a branch or tag.
const WORKTREE_REF: &str = ":worktree";
const REFERENCE_FORMAT: &str = "%(refname)%00%(refname:short)%00%(objectname)%00%(*objectname)%00%(contents:subject)%00%(*contents:subject)%00%(creatordate:iso-strict)";

#[cfg(any(target_os = "macos", test))]
#[derive(Deserialize)]
struct PersistedWindowState {
    fullscreen: bool,
}

#[cfg(any(target_os = "macos", test))]
fn parse_initial_fullscreen_states(bytes: &[u8]) -> HashMap<String, bool> {
    serde_json::from_slice::<HashMap<String, PersistedWindowState>>(bytes)
        .unwrap_or_default()
        .into_iter()
        .map(|(label, state)| (label, state.fullscreen))
        .collect()
}

#[cfg(target_os = "macos")]
fn initial_fullscreen_states() -> HashMap<String, bool> {
    let Some(path) = dirs::config_dir().map(|directory| {
        directory
            .join(APPLICATION_IDENTIFIER)
            .join(tauri_plugin_window_state::DEFAULT_FILENAME)
    }) else {
        return HashMap::new();
    };
    // The plugin's private state schema can change, so parsing failure falls back to a normal launch.
    fs::read(path)
        .map(|bytes| parse_initial_fullscreen_states(&bytes))
        .unwrap_or_default()
}

#[cfg(any(target_os = "macos", test))]
fn fullscreen_initialization_script(states: &HashMap<String, bool>) -> String {
    let states = serde_json::to_string(states).unwrap();
    format!(
        "(() => {{ const states = {states}; window.__GIT_NAV_INITIAL_FULLSCREEN__ = states[window.__TAURI_INTERNALS__.metadata.currentWindow.label] ?? false; }})();"
    )
}

#[cfg(any(target_os = "macos", test))]
struct MacOSWindowChromePlugin {
    fullscreen_states: Arc<Mutex<HashMap<String, bool>>>,
}

#[cfg(any(target_os = "macos", test))]
impl MacOSWindowChromePlugin {
    fn new(fullscreen_states: HashMap<String, bool>) -> Self {
        Self {
            fullscreen_states: Arc::new(Mutex::new(fullscreen_states)),
        }
    }

    fn initialization_script(&self) -> String {
        fullscreen_initialization_script(&self.fullscreen_states.lock().unwrap())
    }
}

#[cfg(any(target_os = "macos", test))]
impl<R: tauri::Runtime> tauri::plugin::Plugin<R> for MacOSWindowChromePlugin {
    fn name(&self) -> &'static str {
        "macos-window-chrome"
    }

    fn initialization_script(&self) -> Option<String> {
        Some(MacOSWindowChromePlugin::initialization_script(self))
    }

    fn window_created(&mut self, window: tauri::Window<R>) {
        let fullscreen_states = self.fullscreen_states.clone();
        let event_window = window.clone();
        window.on_window_event(move |event| {
            if matches!(
                event,
                WindowEvent::Resized(_) | WindowEvent::CloseRequested { .. }
            ) {
                if let Ok(fullscreen) = event_window.is_fullscreen() {
                    fullscreen_states
                        .lock()
                        .unwrap()
                        .insert(event_window.label().to_string(), fullscreen);
                }
            }
        });
    }
}

#[cfg(target_os = "macos")]
fn macos_window_chrome_plugin() -> MacOSWindowChromePlugin {
    MacOSWindowChromePlugin::new(initial_fullscreen_states())
}

#[cfg(any(target_os = "linux", test))]
const APPIMAGE_PATH_ENVIRONMENT: [&str; 6] = [
    "LD_LIBRARY_PATH",
    "PATH",
    "XDG_DATA_DIRS",
    "GSETTINGS_SCHEMA_DIR",
    "GIO_MODULE_DIR",
    "GIO_EXTRA_MODULES",
];

fn external_command(program: &str) -> Command {
    let command = Command::new(program);
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    let mut command = command;
    #[cfg(target_os = "linux")]
    sanitize_appimage_environment(&mut command);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn desktop_process(program: &str) -> Command {
    #[cfg(target_os = "linux")]
    {
        let mut command = Command::new(program);
        sanitize_appimage_environment(&mut command);
        command
    }
    #[cfg(target_os = "windows")]
    {
        Command::new(program)
    }
}

#[cfg(any(target_os = "linux", test))]
fn sanitized_appimage_path_list(value: &OsStr, app_dir: &Path) -> Option<OsString> {
    // AppRun appends the original values after its bundled prefixes, so retain every non-bundled entry.
    let paths: Vec<_> = env::split_paths(value).filter(|path| !path.starts_with(app_dir)).collect();
    (!paths.is_empty()).then(|| env::join_paths(paths).expect("split environment paths must rejoin"))
}

#[cfg(target_os = "linux")]
fn sanitize_appimage_environment(command: &mut Command) {
    let (Some(app_dir), Some(_)) = (env::var_os("APPDIR"), env::var_os("APPIMAGE")) else {
        return;
    };
    apply_appimage_environment(command, Path::new(&app_dir), |name| env::var_os(name));
}

#[cfg(any(target_os = "linux", test))]
fn apply_appimage_environment(
    command: &mut Command,
    app_dir: &Path,
    value: impl Fn(&str) -> Option<OsString>,
) {
    for name in APPIMAGE_PATH_ENVIRONMENT {
        let Some(value) = value(name) else {
            continue;
        };
        match sanitized_appimage_path_list(&value, app_dir) {
            Some(value) => command.env(name, value),
            None => command.env_remove(name),
        };
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Worktree {
    path: String,
    name: String,
    branch: String,
    head: String,
    is_main: bool,
    is_detached: bool,
    is_locked: bool,
    is_prunable: bool,
    is_open: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    name: String,
    path: String,
    worktrees: Vec<Worktree>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangedFile {
    status: String,
    old_path: Option<String>,
    new_path: Option<String>,
    old_oid: Option<String>,
    new_oid: Option<String>,
    additions: u32,
    deletions: u32,
    is_binary: bool,
    split_rows: u32,
    unified_rows: u32,
    hunk_rows: u32,
}

#[derive(Clone, Copy, Default)]
struct FileStat {
    additions: u32,
    deletions: u32,
    is_binary: bool,
    split_rows: u32,
    unified_rows: u32,
    hunk_rows: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Comparison {
    base_sha: String,
    head_sha: String,
    files: Vec<ChangedFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileDiff {
    old_file_name: Option<String>,
    new_file_name: Option<String>,
    old_content: Option<String>,
    new_content: Option<String>,
    hunks: Vec<String>,
    is_binary: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BranchSelection {
    base_ref: String,
    head_ref: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Reference {
    kind: String,
    name: String,
    sha: String,
    subject: String,
    date: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedRevision {
    sha: String,
    subject: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BranchCleanup {
    candidates: Vec<String>,
    deleted: Vec<String>,
    failed: Vec<String>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum CleanupReason {
    SquashMergedPullRequest,
    MergedIntoDefaultBranch,
    SquashedIntoDefaultBranch,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupCandidate {
    branch: String,
    reasons: Vec<CleanupReason>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanupOptions {
    delete_merged_pull_request_branches: bool,
    delete_merged_branches: bool,
    delete_squash_merged_branches: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PredictedConflict {
    commit: String,
    subject: String,
    files: Vec<String>,
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
enum ConflictPrediction {
    Clean,
    Conflicts(PredictedConflict),
    Unknown { reason: String },
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum PendingOperation {
    Rebase,
    Merge,
    CherryPick,
    Bisect,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BranchOperability {
    exists: bool,
    sha: Option<String>,
    worktree_path: Option<String>,
    is_current_worktree: bool,
    is_dirty: bool,
    pending_operation: Option<PendingOperation>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RefUpdate {
    reference: String,
    before: String,
    after: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompletedOperation {
    summary: String,
    updates: Vec<RefUpdate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FailedOperation {
    message: String,
    files: Vec<String>,
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
enum OperationResult {
    Completed(CompletedOperation),
    Failed(FailedOperation),
}

struct WorktreeRecord {
    path: String,
    branch: String,
    head: String,
    is_main: bool,
    is_detached: bool,
    is_locked: bool,
    is_prunable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BranchSync {
    branch: String,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    is_gone: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeStatus {
    path: String,
    branch: String,
    head: String,
    is_detached: bool,
    changed_files: u32,
    untracked_files: u32,
    pending_operation: Option<PendingOperation>,
}

#[derive(Default, Deserialize, Serialize)]
struct RecentRepositories {
    #[serde(default)]
    projects: Vec<String>,
    #[serde(default)]
    repositories: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryEntry {
    name: String,
    path: String,
    is_repository: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryListing {
    path: String,
    parent: Option<String>,
    is_repository: bool,
    entries: Vec<DirectoryEntry>,
}

#[derive(Clone)]
struct OpenWorktree {
    project_id: String,
    worktree_path: String,
}

#[derive(Default)]
struct OpenWorktrees(Mutex<HashMap<String, OpenWorktree>>);

/// Mirrors Tauri's `app_data_dir` so the desktop app and `git-nav serve` share one store.
fn data_dir() -> Result<PathBuf, String> {
    let data_dir = dirs::data_dir()
        .ok_or_else(|| "Could not locate the user data directory.".to_string())?
        .join(APPLICATION_IDENTIFIER);
    fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    Ok(data_dir)
}

fn recent_repositories_path() -> Result<PathBuf, String> {
    data_dir().map(|dir| dir.join("recent-repositories.json"))
}

fn settings_path() -> Result<PathBuf, String> {
    data_dir().map(|dir| dir.join("settings.json"))
}

fn repository_layouts_path() -> Result<PathBuf, String> {
    data_dir().map(|dir| dir.join("repository-layouts.json"))
}

fn pull_request_database_path() -> Result<PathBuf, String> {
    data_dir().map(|dir| dir.join("pull-requests.sqlite3"))
}

enum StoredSettings {
    Valid(BTreeMap<String, serde_json::Value>),
    Malformed,
}

#[derive(Clone, Serialize)]
struct SettingChanged {
    key: String,
    value: serde_json::Value,
}

fn read_settings(path: &Path) -> Result<StoredSettings, String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(StoredSettings::Valid(BTreeMap::new()))
        }
        Err(error) => return Err(error.to_string()),
    };
    Ok(match serde_json::from_str(&contents) {
        Ok(settings) => StoredSettings::Valid(settings),
        Err(_) => StoredSettings::Malformed,
    })
}

fn load_settings() -> Result<BTreeMap<String, serde_json::Value>, String> {
    Ok(match read_settings(&settings_path()?)? {
        StoredSettings::Valid(settings) => settings,
        StoredSettings::Malformed => BTreeMap::new(),
    })
}

fn malformed_settings_path(path: &Path) -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let name = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("settings");
    for suffix in 0.. {
        let candidate = path.with_file_name(format!("{name}.invalid-{timestamp}-{suffix}.json"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

fn save_setting_at_then(
    path: &Path,
    key: String,
    value: serde_json::Value,
    after_save: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    with_locked_file(path, || {
        let mut settings = match read_settings(path)? {
            StoredSettings::Valid(settings) => settings,
            StoredSettings::Malformed => {
                fs::rename(path, malformed_settings_path(path))
                    .map_err(|error| error.to_string())?;
                BTreeMap::new()
            }
        };
        settings.insert(key, value);
        write_json_atomically(path, &settings)?;
        if let Err(error) = after_save() {
            log::warn!("Could not broadcast saved setting: {error}");
        }
        Ok(())
    })
}

fn with_locked_file<T>(
    path: &Path,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    use fs2::FileExt;

    let lock_path = path.with_extension("lock");
    let lock = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(lock_path)
        .map_err(|error| error.to_string())?;
    lock.lock_exclusive().map_err(|error| error.to_string())?;
    operation()
}

fn write_json_atomically(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let contents = serde_json::to_string(value).map_err(|error| error.to_string())?;
    let temporary_path = path.with_extension("json.tmp");
    fs::write(&temporary_path, contents).map_err(|error| error.to_string())?;
    // std::fs::rename replaces an existing destination on every platform, including Windows via MoveFileExW.
    fs::rename(temporary_path, path).map_err(|error| error.to_string())?;
    Ok(())
}

fn save_setting_at(path: &Path, key: String, value: serde_json::Value) -> Result<(), String> {
    save_setting_at_then(path, key, value, || Ok(()))
}

fn save_setting(key: String, value: serde_json::Value) -> Result<(), String> {
    save_setting_at(&settings_path()?, key, value)
}

type RepositoryLayouts = BTreeMap<String, BTreeMap<String, serde_json::Value>>;

fn parse_repository_layouts(contents: &str) -> Result<RepositoryLayouts, serde_json::Error> {
    serde_json::from_str(contents)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryLayout {
    path: String,
    layout: Option<serde_json::Value>,
}

fn load_repository_layout(path: String, client_id: String) -> Result<RepositoryLayout, String> {
    let path = worktree_path(&path)?;
    let contents = match fs::read_to_string(repository_layouts_path()?) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RepositoryLayout { path, layout: None })
        }
        Err(error) => return Err(error.to_string()),
    };
    let layouts = parse_repository_layouts(&contents).unwrap_or_default();
    Ok(RepositoryLayout {
        layout: layouts
            .get(&client_id)
            .and_then(|layouts| layouts.get(&path))
            .cloned(),
        path,
    })
}

fn write_repository_layout_at(
    storage_path: &Path,
    path: String,
    client_id: String,
    layout: serde_json::Value,
) -> Result<(), String> {
    with_locked_file(storage_path, || {
        let layouts = match fs::read_to_string(storage_path) {
            Ok(contents) => match parse_repository_layouts(&contents) {
                Ok(layouts) => layouts,
                Err(_) => {
                    fs::rename(storage_path, malformed_settings_path(storage_path))
                        .map_err(|error| error.to_string())?;
                    RepositoryLayouts::new()
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => RepositoryLayouts::new(),
            Err(error) => return Err(error.to_string()),
        };
        let mut layouts: RepositoryLayouts = layouts;
        layouts.entry(client_id).or_default().insert(path, layout);
        write_json_atomically(storage_path, &layouts)
    })
}

fn save_repository_layout_at(
    storage_path: &Path,
    path: String,
    client_id: String,
    layout: serde_json::Value,
) -> Result<(), String> {
    write_repository_layout_at(storage_path, worktree_path(&path)?, client_id, layout)
}

fn load_recent_paths() -> Result<Vec<String>, String> {
    let path = recent_repositories_path()?;
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };

    serde_json::from_str::<RecentRepositories>(&contents)
        .map(|recent| {
            if recent.projects.is_empty() {
                recent.repositories
            } else {
                recent.projects
            }
        })
        .map_err(|error| error.to_string())
}

fn updated_recent_paths(mut paths: Vec<String>, repository_path: &str) -> Vec<String> {
    paths.retain(|path| path != repository_path);
    paths.insert(0, repository_path.to_string());
    paths.truncate(MAX_RECENT_REPOSITORIES);
    paths
}

fn write_recent_paths(paths: Vec<String>) -> Result<(), String> {
    let contents = serde_json::to_string(&RecentRepositories {
        projects: paths,
        repositories: Vec::new(),
    })
    .map_err(|error| error.to_string())?;
    fs::write(recent_repositories_path()?, contents).map_err(|error| error.to_string())
}

fn save_recent_path(repository_path: &str, app: Option<&AppHandle>) -> Result<(), String> {
    let paths = updated_recent_paths(load_recent_paths()?, repository_path);
    write_recent_paths(paths)?;
    update_recent_menu(app);
    Ok(())
}

fn clear_recent_paths(app: Option<&AppHandle>) -> Result<(), String> {
    write_recent_paths(Vec::new())?;
    update_recent_menu(app);
    if let Some(app) = app {
        app.emit(RECENT_PROJECTS_CLEARED_EVENT, ())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn git_output(path: &str, arguments: &[&str]) -> Option<String> {
    let output = external_command("git")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let value = String::from_utf8(output.stdout).ok()?;
    let value = value.trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn git_output_bytes(path: &str, arguments: &[&str]) -> Option<Vec<u8>> {
    let output = external_command("git")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .output()
        .ok()?;

    output.status.success().then_some(output.stdout)
}

fn git_output_allow_empty(path: &str, arguments: &[&str]) -> Result<String, String> {
    let output = external_command("git")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    String::from_utf8(output.stdout).map_err(|error| error.to_string())
}

fn resolve_commit(path: &str, reference: &str) -> Result<String, String> {
    let revision = format!("{reference}^{{commit}}");
    git_output_allow_empty(path, &["rev-parse", "--verify", "--end-of-options", &revision])
        .map(|value| value.trim().to_string())
        .and_then(|value| (!value.is_empty()).then_some(value).ok_or_else(|| format!("Could not resolve {reference}.")))
}

/// Counts the rows `@git-diff-view` renders for one file: every patch body line becomes a unified
/// row, while split mode pairs a run of deletions with the additions that follow it.
fn parse_patch_stats(patch: &str) -> Vec<FileStat> {
    let mut files: Vec<FileStat> = Vec::new();
    let (mut deletions, mut additions) = (0u32, 0u32);
    for line in patch.lines() {
        let ends_block = !matches!(line.as_bytes().first(), Some(b'+') | Some(b'\\'))
            && !(line.starts_with('-') && additions == 0);
        if let Some(file) = files.last_mut().filter(|_| ends_block) {
            file.split_rows += deletions.max(additions);
            file.additions += additions;
            file.deletions += deletions;
            deletions = 0;
            additions = 0;
        }
        if line.starts_with("diff --git ") {
            files.push(FileStat::default());
            continue;
        }
        let Some(file) = files.last_mut() else {
            continue;
        };
        if line.starts_with("Binary files ") || line == "GIT binary patch" {
            file.is_binary = true;
            continue;
        }
        if line.starts_with("@@ ") {
            file.hunk_rows += 1;
            continue;
        }
        if file.hunk_rows == 0 {
            continue;
        }
        match line.as_bytes().first() {
            Some(b'+') => {
                additions += 1;
                file.unified_rows += 1;
            }
            Some(b'-') => {
                deletions += 1;
                file.unified_rows += 1;
            }
            Some(b'\\') => {}
            _ => {
                file.split_rows += 1;
                file.unified_rows += 1;
            }
        }
    }
    if let Some(file) = files.last_mut() {
        file.split_rows += deletions.max(additions);
        file.additions += additions;
        file.deletions += deletions;
    }
    for file in &mut files {
        // The view closes every file that still hides lines with one more expandable row.
        if file.hunk_rows > 0 {
            file.hunk_rows += 1;
        }
    }
    files
}

// --raw carries the blob each side of a file is, which is what a file being marked as read is read at.
const RAW_ARGUMENTS: [&str; 7] = ["diff", "--no-ext-diff", "--find-renames", "--find-copies", "--raw", "--abbrev=40", "-z"];
const PATCH_ARGUMENTS: [&str; 6] = ["diff", "--no-ext-diff", "--find-renames", "--find-copies", "--no-color", "--unified=3"];

const NUMSTAT_ARGUMENTS: [&str; 6] = ["diff", "--no-ext-diff", "--find-renames", "--find-copies", "--numstat", "-z"];

fn whitespace_arguments(ignore_whitespace: bool) -> &'static [&'static str] {
    if ignore_whitespace {
        &["--ignore-all-space"]
    } else {
        &[]
    }
}

// Only the patch answers to --ignore-all-space; --raw lists a file whenever its two blobs differ, however
// they differ. Numstat is the patch's own machinery, so the files it names are the ones the patch carries.
fn files_changed_beyond_whitespace(path: &str, revisions: &[&str]) -> Result<HashSet<String>, String> {
    let output = git_output_bytes(path, &[&NUMSTAT_ARGUMENTS[..], whitespace_arguments(true), revisions].concat())
        .ok_or_else(|| "git diff failed.".to_string())?;
    let mut fields = output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .map(|field| String::from_utf8_lossy(field).into_owned());
    let mut paths = HashSet::new();
    while let Some(record) = fields.next() {
        match record.splitn(3, '\t').nth(2) {
            Some(path) if !path.is_empty() => {
                paths.insert(path.to_string());
            }
            // A rename carries its two paths in the fields following the counts.
            _ => {
                paths.extend(fields.by_ref().take(2));
            }
        }
    }
    Ok(paths)
}

// A blob of nothing is what git reports for a side a file does not have, and for a working tree file it
// has not been asked to hash.
fn blob_oid(oid: &str) -> Option<String> {
    oid.chars().any(|character| character != '0').then(|| oid.to_string())
}

fn parse_changed_files(raw: &[u8], patch: &str, kept: Option<&HashSet<String>>) -> Result<Vec<ChangedFile>, String> {
    // The patch lists files in the same order as --raw, so its per-file stats zip by index.
    let stats = parse_patch_stats(patch);
    let fields = raw
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .map(|field| String::from_utf8(field.to_vec()).map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let mut files = Vec::new();
    let mut index = 0;
    while let Some(record) = fields.get(index) {
        index += 1;
        // ":<old mode> <new mode> <old blob> <new blob> <status>"
        let [_, _, old_oid, new_oid, status] = record.trim_start_matches(':').split(' ').collect::<Vec<_>>()[..] else {
            return Err("Invalid git diff record.".to_string());
        };
        let (old_oid, new_oid) = (blob_oid(old_oid), blob_oid(new_oid));
        let kind = status.chars().next().ok_or_else(|| "Invalid git diff status.".to_string())?;
        let first_path = fields.get(index).ok_or_else(|| "Invalid git diff path.".to_string())?.clone();
        index += 1;
        let (old_path, new_path, status) = match kind {
            'A' => (None, Some(first_path), "added"),
            'D' => (Some(first_path), None, "deleted"),
            'R' => {
                let new_path = fields.get(index).ok_or_else(|| "Invalid renamed path.".to_string())?.clone();
                index += 1;
                (Some(first_path), Some(new_path), "renamed")
            }
            'C' => {
                let new_path = fields.get(index).ok_or_else(|| "Invalid copied path.".to_string())?.clone();
                index += 1;
                (Some(first_path), Some(new_path), "copied")
            }
            _ => (Some(first_path.clone()), Some(first_path), "modified"),
        };
        if kept.is_some_and(|kept| !new_path.as_ref().or(old_path.as_ref()).is_some_and(|name| kept.contains(name))) {
            continue;
        }
        let stat = stats.get(files.len()).copied().unwrap_or_default();
        files.push(ChangedFile {
            status: status.to_string(),
            old_path,
            new_path,
            old_oid,
            new_oid,
            additions: stat.additions,
            deletions: stat.deletions,
            is_binary: stat.is_binary,
            split_rows: stat.split_rows,
            unified_rows: stat.unified_rows,
            hunk_rows: stat.hunk_rows,
        });
    }
    Ok(files)
}

fn changed_files(path: &str, base_sha: &str, head_sha: &str, ignore_whitespace: bool) -> Result<Vec<ChangedFile>, String> {
    let revisions = [base_sha, head_sha];
    let whitespace = whitespace_arguments(ignore_whitespace);
    let raw = git_output_bytes(path, &[&RAW_ARGUMENTS[..], &revisions].concat())
        .ok_or_else(|| "git diff failed.".to_string())?;
    let patch = git_output_allow_empty(path, &[&PATCH_ARGUMENTS[..], whitespace, &revisions].concat())?;
    let kept = ignore_whitespace.then(|| files_changed_beyond_whitespace(path, &revisions)).transpose()?;
    parse_changed_files(&raw, &patch, kept.as_ref())
}

// Untracked files are invisible to git diff, so they are listed separately and appended after the
// tracked changes, where they cannot disturb the index the patch stats are zipped by.
fn untracked_files(path: &str) -> Result<Vec<ChangedFile>, String> {
    let output = git_output_bytes(path, &["ls-files", "--others", "--exclude-standard", "-z"])
        .ok_or_else(|| "git ls-files failed.".to_string())?;
    let root = worktree_path(path)?;
    let mut files = Vec::new();
    for field in output.split(|byte| *byte == 0).filter(|field| !field.is_empty()) {
        let name = String::from_utf8(field.to_vec()).map_err(|error| error.to_string())?;
        let contents = fs::read(Path::new(&root).join(&name)).unwrap_or_default();
        let is_binary = contents.contains(&0);
        let lines = if is_binary || contents.is_empty() {
            0
        } else {
            let newlines = contents.iter().filter(|byte| **byte == b'\n').count() as u32;
            newlines + u32::from(contents.last() != Some(&b'\n'))
        };
        files.push(ChangedFile {
            status: "added".to_string(),
            old_path: None,
            new_path: Some(name),
            old_oid: None,
            new_oid: None,
            additions: lines,
            deletions: 0,
            is_binary,
            split_rows: lines,
            unified_rows: lines,
            hunk_rows: u32::from(lines > 0),
        });
    }
    Ok(files)
}

fn worktree_changed_files(path: &str, base_sha: &str, ignore_whitespace: bool) -> Result<Vec<ChangedFile>, String> {
    let revisions = [base_sha];
    let whitespace = whitespace_arguments(ignore_whitespace);
    let raw = git_output_bytes(path, &[&RAW_ARGUMENTS[..], &revisions].concat())
        .ok_or_else(|| "git diff failed.".to_string())?;
    let patch = git_output_allow_empty(path, &[&PATCH_ARGUMENTS[..], whitespace, &revisions].concat())?;
    let kept = ignore_whitespace.then(|| files_changed_beyond_whitespace(path, &revisions)).transpose()?;
    let mut files = parse_changed_files(&raw, &patch, kept.as_ref())?;
    files.extend(untracked_files(path)?);
    Ok(files)
}

fn primary_reference(path: &str) -> Result<String, String> {
    if let Some(reference) = git_output(path, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]) {
        if resolve_commit(path, &reference).is_ok() {
            return Ok(reference);
        }
    }
    for reference in ["main", "master", "HEAD"] {
        if resolve_commit(path, reference).is_ok() {
            return Ok(reference.to_string());
        }
    }
    Err("Could not identify the primary branch.".to_string())
}

fn worktree_path(path: &str) -> Result<String, String> {
    git_output(path, &["rev-parse", "--show-toplevel"])
        .ok_or_else(|| "Choose a Git repository.".to_string())
}

fn project_id(path: &str) -> Result<String, String> {
    let worktree_path = worktree_path(path)?;
    let common_dir = git_output(&worktree_path, &["rev-parse", "--git-common-dir"])
        .ok_or_else(|| "Could not identify the Git project.".to_string())?;
    let common_dir = PathBuf::from(common_dir);
    let common_dir = if common_dir.is_absolute() {
        common_dir
    } else {
        PathBuf::from(worktree_path).join(common_dir)
    };

    fs::canonicalize(common_dir)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| error.to_string())
}

fn worktree_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
        .to_string()
}

#[derive(Deserialize)]
struct GithubPullRequest {
    number: i64,
    title: String,
    state: String,
    draft: bool,
    merged_at: Option<String>,
    merge_commit_sha: Option<String>,
    updated_at: String,
    head: GithubPullRequestHead,
}

#[derive(Deserialize)]
struct GithubPullRequestHead {
    #[serde(rename = "ref")]
    reference: String,
    repo: Option<GithubRepositoryRef>,
    sha: String,
}

#[derive(Deserialize)]
struct GithubRepositoryRef {
    full_name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct BranchPullRequest {
    branch: String,
    number: i64,
    state: String,
    title: String,
    url: String,
}

fn github_repository(remote: &str) -> Option<(String, String)> {
    let remote = remote.trim_end_matches('/').trim_end_matches(".git");
    let (host, path) = if let Some(remote) = remote.strip_prefix("git@") {
        remote.split_once(':')?
    } else if let Some(remote) = remote.strip_prefix("ssh://git@") {
        remote.split_once('/')?
    } else {
        let remote = remote
            .strip_prefix("https://")
            .or_else(|| remote.strip_prefix("http://"))?;
        remote.split_once('/')?
    };
    let (owner, repository) = path.split_once('/')?;
    (!owner.is_empty() && !repository.is_empty()).then_some((host.to_string(), format!("{owner}/{repository}")))
}

fn github_pull_request_page(host: &str, repository: &str, state: &str) -> Option<Vec<GithubPullRequest>> {
    let endpoint = format!("repos/{repository}/pulls?state={state}&sort=updated&direction=desc&per_page=100");
    let mut command = external_command("gh");
    command.args(["api", "--method", "GET", "--header", "Accept: application/vnd.github+json"]);
    if host != "github.com" {
        command.args(["--hostname", host]);
    }
    let output = command.arg(endpoint).output().ok()?;
    output
        .status
        .success()
        .then(|| serde_json::from_slice(&output.stdout).ok())
        .flatten()
}

// Closed pull requests are what a merge is recognised by, and open ones are what a branch is marked with, and
// each page only reaches as far back as its own state, so both are read.
fn github_pull_requests(host: &str, repository: &str) -> Option<Vec<GithubPullRequest>> {
    let mut pull_requests = github_pull_request_page(host, repository, "closed")?;
    pull_requests.extend(github_pull_request_page(host, repository, "open")?);
    Some(pull_requests)
}

fn git_succeeds(path: &str, arguments: &[&str]) -> bool {
    external_command("git")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .status()
        .is_ok_and(|status| status.success())
}

fn migrate_pull_request_database(connection: &mut Connection) -> Result<(), String> {
    connection
        .execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)")
        .map_err(|error| error.to_string())?;
    let version = connection
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get::<_, Option<i64>>(0))
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    if version < 1 {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction
            .execute_batch(
                "
                CREATE TABLE pull_requests (
                  host TEXT NOT NULL,
                  repository TEXT NOT NULL,
                  number INTEGER NOT NULL,
                  head_sha TEXT NOT NULL,
                  merge_commit_sha TEXT,
                  merged_at TEXT,
                  updated_at TEXT NOT NULL,
                  PRIMARY KEY (host, repository, number)
                );
                CREATE TABLE pull_request_syncs (
                  host TEXT NOT NULL,
                  repository TEXT NOT NULL,
                  synchronized_at INTEGER NOT NULL,
                  PRIMARY KEY (host, repository)
                );
                INSERT INTO schema_migrations (version) VALUES (1);
                ",
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    if version < 2 {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        // Clearing the sync record brings the next read forward so the rows already stored gain the new columns.
        transaction
            .execute_batch(
                "
                ALTER TABLE pull_requests ADD COLUMN head_ref TEXT;
                ALTER TABLE pull_requests ADD COLUMN state TEXT;
                ALTER TABLE pull_requests ADD COLUMN title TEXT;
                ALTER TABLE pull_requests ADD COLUMN is_draft INTEGER NOT NULL DEFAULT 0;
                DELETE FROM pull_request_syncs;
                INSERT INTO schema_migrations (version) VALUES (2);
                ",
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn pull_request_database(path: PathBuf) -> Result<Connection, String> {
    let mut connection = Connection::open(path).map_err(|error| error.to_string())?;
    migrate_pull_request_database(&mut connection)?;
    Ok(connection)
}

fn should_sync_pull_requests(connection: &Connection, host: &str, repository: &str) -> Result<bool, String> {
    let synchronized_at = connection
        .query_row(
            "SELECT synchronized_at FROM pull_request_syncs WHERE host = ?1 AND repository = ?2",
            params![host, repository],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    Ok(match synchronized_at {
        Some(synchronized_at) => now.saturating_sub(synchronized_at as u64) >= PULL_REQUEST_SYNC_INTERVAL_SECONDS,
        None => true,
    })
}

fn sync_pull_requests(connection: &mut Connection, host: &str, repository: &str) -> Result<(), String> {
    let pull_requests = github_pull_requests(host, repository).ok_or_else(|| "Could not load pull requests.".to_string())?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    for pull_request in pull_requests {
        // A pull request raised from a fork names a branch in that fork, and names like "patch-1" are common
        // enough there to land on a local branch that has nothing to do with it.
        let head_ref = pull_request
            .head
            .repo
            .as_ref()
            .is_some_and(|repo| repo.full_name.eq_ignore_ascii_case(repository))
            .then_some(pull_request.head.reference.as_str());
        transaction
            .execute(
                "
                INSERT INTO pull_requests (host, repository, number, head_sha, head_ref, merge_commit_sha, merged_at, state, title, is_draft, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                ON CONFLICT(host, repository, number) DO UPDATE SET
                  head_sha = excluded.head_sha,
                  head_ref = excluded.head_ref,
                  merge_commit_sha = excluded.merge_commit_sha,
                  merged_at = excluded.merged_at,
                  state = excluded.state,
                  title = excluded.title,
                  is_draft = excluded.is_draft,
                  updated_at = excluded.updated_at
                WHERE excluded.updated_at > pull_requests.updated_at OR pull_requests.head_ref IS NULL
                ",
                params![
                    host,
                    repository,
                    pull_request.number,
                    pull_request.head.sha,
                    head_ref,
                    pull_request.merge_commit_sha,
                    pull_request.merged_at,
                    pull_request.state,
                    pull_request.title,
                    pull_request.draft,
                    pull_request.updated_at,
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    let synchronized_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs() as i64;
    transaction
        .execute(
            "
            INSERT INTO pull_request_syncs (host, repository, synchronized_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(host, repository) DO UPDATE SET synchronized_at = excluded.synchronized_at
            ",
            params![host, repository, synchronized_at],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn pull_request_state(state: &str, is_draft: bool, merged_at: Option<&str>) -> &'static str {
    if merged_at.is_some() {
        "merged"
    } else if state != "open" {
        "closed"
    } else if is_draft {
        "draft"
    } else {
        "open"
    }
}

fn pull_request_rank(state: &str) -> u8 {
    match state {
        "open" | "draft" => 2,
        "merged" => 1,
        _ => 0,
    }
}

type PullRequestRow = (String, i64, String, bool, Option<String>, String);

// A branch name outlives the pull requests raised from it, so the one it is marked with is whichever is still
// open, and failing that the newest one that closed.
fn rank_branch_pull_requests(host: &str, repository: &str, rows: Vec<PullRequestRow>) -> Vec<BranchPullRequest> {
    let mut best: HashMap<String, BranchPullRequest> = HashMap::new();
    for (branch, number, state, is_draft, merged_at, title) in rows {
        let state = pull_request_state(&state, is_draft, merged_at.as_deref());
        if best.get(&branch).is_some_and(|current| {
            (pull_request_rank(&current.state), current.number) > (pull_request_rank(state), number)
        }) {
            continue;
        }
        let url = format!("https://{host}/{repository}/pull/{number}");
        best.insert(branch.clone(), BranchPullRequest { branch, number, state: state.to_string(), title, url });
    }
    let mut pull_requests: Vec<_> = best.into_values().collect();
    pull_requests.sort_by(|a, b| a.branch.cmp(&b.branch));
    pull_requests
}

fn pull_requests_by_branch(repo_path: &str, database_path: PathBuf) -> Result<Vec<BranchPullRequest>, String> {
    let remote = git_output(repo_path, &["remote", "get-url", "origin"]).ok_or_else(|| "Could not identify the origin remote.".to_string())?;
    let (host, repository) = github_repository(&remote).ok_or_else(|| "Only GitHub remotes are supported.".to_string())?;
    let mut connection = pull_request_database(database_path)?;
    // What is already stored still answers the question when the remote cannot be reached.
    if should_sync_pull_requests(&connection, &host, &repository)? {
        let _ = sync_pull_requests(&mut connection, &host, &repository);
    }
    let mut statement = connection
        .prepare(
            "
            SELECT head_ref, number, state, is_draft, merged_at, title
            FROM pull_requests
            WHERE host = ?1 AND repository = ?2 AND head_ref IS NOT NULL
            ",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![host, repository], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                row.get::<_, bool>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            ))
        })
        .map_err(|error| error.to_string())?
        .flatten()
        .collect();
    Ok(rank_branch_pull_requests(&host, &repository, rows))
}

fn fetch_and_sync_repository(repo_path: &str, database_path: PathBuf) -> Result<(), String> {
    git_output_allow_empty(repo_path, &["fetch", "--prune", "origin"])?;
    let remote = git_output(repo_path, &["remote", "get-url", "origin"])
        .ok_or_else(|| "Could not identify the origin remote.".to_string())?;
    let (host, repository) = github_repository(&remote)
        .ok_or_else(|| "Only GitHub remotes are supported.".to_string())?;
    let mut connection = pull_request_database(database_path)?;
    sync_pull_requests(&mut connection, &host, &repository)
}

// A `Child` that is dropped without a wait stays a zombie for the lifetime of the app, so every
// spawn that is abandoned early - a killed walk, a `?` on a parse failure - is reaped here instead.
struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn patch_id(repo_path: &str, arguments: &[&str]) -> Option<String> {
    let mut diff = ChildGuard(
        external_command("git")
            .arg("-C")
            .arg(repo_path)
            .args(arguments)
            .stdout(Stdio::piped())
            .spawn()
            .ok()?,
    );
    let stdout = diff.0.stdout.take()?;
    let output = external_command("git")
        .arg("-C")
        .arg(repo_path)
        .args(["patch-id", "--stable"])
        .stdin(stdout)
        .output()
        .ok()?;
    let value = String::from_utf8(output.stdout).ok()?;
    value.split_whitespace().next().map(str::to_string)
}

struct SquashCandidate {
    hash: String,
    tree: String,
    paths: Vec<String>,
}

// One record per commit, carrying the tree and the paths it touched, so neither the tree comparison
// nor the path filter has to spawn a process per candidate.
fn squash_candidates(repo_path: &str, range: &str) -> Vec<SquashCandidate> {
    let Ok(output) = git_output_allow_empty(repo_path, &["log", "--no-merges", "--format=%x00%H %T", "--name-only", range]) else {
        return Vec::new();
    };
    output
        .split('\0')
        .filter_map(|record| {
            let mut lines = record.lines().filter(|line| !line.is_empty());
            let (hash, tree) = lines.next()?.split_once(' ')?;
            let mut paths: Vec<_> = lines.map(str::to_string).collect();
            paths.sort();
            Some(SquashCandidate { hash: hash.to_string(), tree: tree.to_string(), paths })
        })
        .collect()
}

// A squash merge replaces a branch with a single commit holding the same net change, so the branch
// never becomes an ancestor and the graph has no edge to draw without reconstructing one.
fn squash_merge_target_from_candidates(repo_path: &str, tip: &str, base: &str, candidates: &[SquashCandidate]) -> Option<String> {
    let tip_tree = git_output(repo_path, &["rev-parse", &format!("{tip}^{{tree}}")])?;

    // The squash landed straight onto the branch point, so it carries the branch tip's tree verbatim.
    if let Some(candidate) = candidates.iter().find(|candidate| candidate.tree == tip_tree) {
        return Some(candidate.hash.clone());
    }

    // Otherwise the primary branch moved on before the squash, so only the net change still matches.
    let mut branch_paths: Vec<_> = git_output_allow_empty(repo_path, &["diff", "--name-only", &base, tip])
        .ok()?
        .lines()
        .map(str::to_string)
        .collect();
    branch_paths.sort();
    if branch_paths.is_empty() {
        return None;
    }
    let branch_patch = patch_id(repo_path, &["diff", &base, tip])?;
    candidates
        .into_iter()
        .filter(|candidate| candidate.paths == branch_paths)
        .find(|candidate| patch_id(repo_path, &["show", &candidate.hash]).as_deref() == Some(branch_patch.as_str()))
        .map(|candidate| candidate.hash.clone())
}

// A squash that has not been pushed yet lives only on the local counterpart of the primary branch, so the
// search reaches through to it whenever that counterpart merely extends the remote.
fn squash_search_reference(repo_path: &str) -> Result<String, String> {
    let primary = primary_reference(repo_path)?;
    let name = primary.split_once('/').map_or(primary.as_str(), |(_, name)| name);
    let local = format!("refs/heads/{name}");
    if resolve_commit(repo_path, &local).is_ok() && git_succeeds(repo_path, &["merge-base", "--is-ancestor", &primary, &local]) {
        return Ok(local);
    }
    Ok(primary)
}

fn local_squash_merges(repo_path: &str) -> Vec<(String, String)> {
    let Ok(primary) = squash_search_reference(repo_path) else {
        return Vec::new();
    };
    let Ok(branches) = git_output_allow_empty(repo_path, &["for-each-ref", "--no-merged", &primary, "--format=%(objectname)", "refs/heads"]) else {
        return Vec::new();
    };
    let mut candidates_by_base = HashMap::new();
    let mut seen_tips = HashSet::new();
    branches
        .lines()
        .filter(|tip| !tip.is_empty())
        .filter(|tip| seen_tips.insert(*tip))
        .filter_map(|tip| {
            let base = git_output(repo_path, &["merge-base", tip, &primary])?;
            let candidates = candidates_by_base
                .entry(base.clone())
                .or_insert_with(|| squash_candidates(repo_path, &format!("{base}..{primary}")));
            squash_merge_target_from_candidates(repo_path, tip, &base, candidates)
                .map(|target| (tip.to_string(), target))
        })
        .collect()
}

fn inferred_squash_merges(repo_path: &str, database_path: PathBuf) -> Vec<(String, String)> {
    let mut edges: HashSet<_> = local_squash_merges(repo_path).into_iter().collect();
    // Pull requests still cover squashes whose conflict resolution changed the content on the way in.
    let Some(remote) = git_output(repo_path, &["remote", "get-url", "origin"]) else {
        return edges.into_iter().collect();
    };
    let Some((host, repository)) = github_repository(&remote) else {
        return edges.into_iter().collect();
    };
    let Ok(primary) = squash_search_reference(repo_path) else {
        return edges.into_iter().collect();
    };
    let Some(refs) = git_output(repo_path, &["for-each-ref", "--format=%(objectname)", "refs/heads", "refs/remotes"]) else {
        return edges.into_iter().collect();
    };
    let Ok(mut connection) = pull_request_database(database_path) else {
        return edges.into_iter().collect();
    };
    if should_sync_pull_requests(&connection, &host, &repository).unwrap_or(false) {
        let _ = sync_pull_requests(&mut connection, &host, &repository);
    }
    let ref_hashes: HashSet<_> = refs.lines().collect();
    let mut statement = match connection.prepare(
        "
        SELECT head_sha, merge_commit_sha
        FROM pull_requests
        WHERE host = ?1 AND repository = ?2 AND merged_at IS NOT NULL AND merge_commit_sha IS NOT NULL
        ",
    ) {
        Ok(statement) => statement,
        Err(_) => return edges.into_iter().collect(),
    };
    let pull_requests = match statement.query_map(params![host, repository], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))) {
        Ok(pull_requests) => pull_requests,
        Err(_) => return edges.into_iter().collect(),
    };
    for pull_request in pull_requests.flatten() {
        let (source, target) = pull_request;
        if ref_hashes.contains(source.as_str())
            && !git_succeeds(repo_path, &["merge-base", "--is-ancestor", &source, &primary])
            && git_succeeds(repo_path, &["merge-base", "--is-ancestor", &target, &primary])
        {
            edges.insert((source, target));
        }
    }
    edges.into_iter().collect()
}

fn merged_branch_candidates(repo_path: &str, database_path: PathBuf) -> Result<Vec<String>, String> {
    let remote = git_output(repo_path, &["remote", "get-url", "origin"]).ok_or_else(|| "Could not identify the origin remote.".to_string())?;
    let (host, repository) = github_repository(&remote).ok_or_else(|| "Only GitHub remotes are supported.".to_string())?;
    let refs = git_output_allow_empty(repo_path, &["for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads"])?;
    let mut connection = pull_request_database(database_path)?;
    if should_sync_pull_requests(&connection, &host, &repository)? {
        sync_pull_requests(&mut connection, &host, &repository)?;
    }
    let mut statement = connection
        .prepare(
            "
            SELECT head_sha
            FROM pull_requests
            WHERE host = ?1 AND repository = ?2 AND merged_at IS NOT NULL
            ",
        )
        .map_err(|error| error.to_string())?;
    let merged_heads = statement
        .query_map(params![host, repository], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .flatten()
        .collect::<HashSet<_>>();
    let primary = primary_reference(repo_path).ok().and_then(|reference| reference.strip_prefix("origin/").map(str::to_string).or(Some(reference)));
    let protected = ["main", "master"]
        .into_iter()
        .chain(primary.as_deref())
        .collect::<HashSet<_>>();

    Ok(refs
        .split('\n')
        .filter_map(|line| line.split_once('\0'))
        .filter(|(branch, hash)| !protected.contains(branch) && merged_heads.contains(*hash))
        .map(|(branch, _)| branch.to_string())
        .collect())
}

fn merged_local_branch_candidates(repo_path: &str) -> Result<Vec<String>, String> {
    let primary = primary_reference(repo_path)?;
    let primary_branch = primary.strip_prefix("origin/").unwrap_or(&primary);
    let protected = ["main", "master", primary_branch]
        .into_iter()
        .collect::<HashSet<_>>();
    // Reachability is asked of git once for every branch at a time, since this runs on every repository
    // change rather than only when the cleanup dialog is opened.
    let refs = git_output_allow_empty(
        repo_path,
        &[
            "for-each-ref",
            "--merged",
            &primary,
            "--format=%(refname:short)",
            "refs/heads",
        ],
    )?;
    let worktrees = git_output_allow_empty(repo_path, &["worktree", "list", "--porcelain", "-z"])?;
    let checked_out = parse_worktree_records(&worktrees)
        .into_iter()
        .filter(|worktree| !worktree.is_detached)
        .map(|worktree| worktree.branch)
        .collect::<HashSet<_>>();

    Ok(refs
        .lines()
        .filter(|branch| !protected.contains(branch) && !checked_out.contains(*branch))
        .map(str::to_string)
        .collect())
}

// A squash merge leaves no ancestry and needs no pull request, so the branch it replaced is only
// recognisable by the content that landed. That is an inference rather than a record, which is why it is
// offered separately from the rules git and GitHub can prove.
fn squash_merged_branch_candidates(repo_path: &str) -> Result<Vec<String>, String> {
    let primary = squash_search_reference(repo_path)?;
    let primary_branch = primary
        .strip_prefix("refs/heads/")
        .or_else(|| primary.strip_prefix("origin/"))
        .unwrap_or(&primary);
    let protected = ["main", "master", primary_branch].into_iter().collect::<HashSet<_>>();
    let squashed = local_squash_merges(repo_path).into_iter().map(|(tip, _)| tip).collect::<HashSet<_>>();
    let refs = git_output_allow_empty(repo_path, &["for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads"])?;
    let worktrees = git_output_allow_empty(repo_path, &["worktree", "list", "--porcelain", "-z"])?;
    let checked_out = parse_worktree_records(&worktrees)
        .into_iter()
        .filter(|worktree| !worktree.is_detached)
        .map(|worktree| worktree.branch)
        .collect::<HashSet<_>>();

    Ok(refs
        .split('\n')
        .filter_map(|line| line.split_once('\0'))
        .filter(|(branch, hash)| !protected.contains(branch) && !checked_out.contains(*branch) && squashed.contains(*hash))
        .map(|(branch, _)| branch.to_string())
        .collect())
}

fn cleanup_candidates(
    repo_path: &str,
    options: &CleanupOptions,
    database_path: Option<PathBuf>,
) -> Result<Vec<CleanupCandidate>, String> {
    let mut candidates = HashMap::new();
    if let Some(database_path) = database_path {
        for branch in merged_branch_candidates(repo_path, database_path)? {
            candidates
                .entry(branch)
                .or_insert_with(Vec::new)
                .push(CleanupReason::SquashMergedPullRequest);
        }
    }
    if options.delete_merged_branches {
        for branch in merged_local_branch_candidates(repo_path)? {
            candidates
                .entry(branch)
                .or_insert_with(Vec::new)
                .push(CleanupReason::MergedIntoDefaultBranch);
        }
    }
    if options.delete_squash_merged_branches {
        for branch in squash_merged_branch_candidates(repo_path)? {
            candidates
                .entry(branch)
                .or_insert_with(Vec::new)
                .push(CleanupReason::SquashedIntoDefaultBranch);
        }
    }
    let mut candidates = candidates
        .into_iter()
        .map(|(branch, reasons)| CleanupCandidate { branch, reasons })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| left.branch.cmp(&right.branch));
    Ok(candidates)
}

/// Backs the browser folder picker, which has no equivalent of the native directory dialog.
fn directory_listing(path: Option<&str>) -> Result<DirectoryListing, String> {
    let path = match path.filter(|path| !path.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => dirs::home_dir().ok_or_else(|| "Could not locate the home directory.".to_string())?,
    };
    let path = fs::canonicalize(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut entries = fs::read_dir(&path)
        .map_err(|error| format!("{}: {error}", path.display()))?
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .map(|entry| {
            let path = entry.path();
            DirectoryEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                is_repository: path.join(".git").exists(),
                path: path.to_string_lossy().into_owned(),
            }
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.name.to_lowercase());

    Ok(DirectoryListing {
        parent: path
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned()),
        is_repository: path.join(".git").exists(),
        path: path.to_string_lossy().into_owned(),
        entries,
    })
}

fn cleanup_database_path(options: &CleanupOptions) -> Result<Option<PathBuf>, String> {
    options
        .delete_merged_pull_request_branches
        .then(pull_request_database_path)
        .transpose()
}

fn delete_cleanup_candidates(
    repo_path: &str,
    options: &CleanupOptions,
    database_path: Option<PathBuf>,
) -> Result<BranchCleanup, String> {
    let candidates = cleanup_candidates(repo_path, options, database_path)?
        .into_iter()
        .map(|candidate| candidate.branch)
        .collect::<Vec<_>>();
    let mut deleted = Vec::new();
    let mut failed = Vec::new();
    for branch in &candidates {
        if git_succeeds(repo_path, &["branch", "-D", "--", branch]) {
            deleted.push(branch.clone());
        } else {
            failed.push(branch.clone());
        }
    }
    Ok(BranchCleanup {
        candidates,
        deleted,
        failed,
    })
}

fn parse_worktree_records(output: &str) -> Vec<WorktreeRecord> {
    let mut worktrees = Vec::new();

    for (index, record) in output
        .split('\0')
        .collect::<Vec<_>>()
        .split(|field| field.is_empty())
        .enumerate()
    {
        let mut path = None;
        let mut head = None;
        let mut branch = None;
        let mut detached = false;
        let mut locked = false;
        let mut prunable = false;

        for field in record {
            if let Some(value) = field.strip_prefix("worktree ") {
                path = Some(value.to_string());
            } else if let Some(value) = field.strip_prefix("HEAD ") {
                head = Some(value.to_string());
            } else if let Some(value) = field.strip_prefix("branch refs/heads/") {
                branch = Some(value.to_string());
            } else if *field == "detached" {
                detached = true;
            } else if field.starts_with("locked") {
                locked = true;
            } else if field.starts_with("prunable") {
                prunable = true;
            }
        }

        if let Some(path) = path {
            worktrees.push(WorktreeRecord {
                path,
                branch: branch.unwrap_or_else(|| "Detached HEAD".to_string()),
                head: head.unwrap_or_default(),
                is_main: index == 0,
                is_detached: detached,
                is_locked: locked,
                is_prunable: prunable,
            });
        }
    }

    worktrees
}

fn project_at(path: &str, open_worktrees: &OpenWorktrees) -> Result<Project, String> {
    let id = project_id(path)?;
    let output = git_output_bytes(path, &["worktree", "list", "--porcelain", "-z"])
        .ok_or_else(|| "Could not list Git worktrees.".to_string())?;
    let output = String::from_utf8(output).map_err(|error| error.to_string())?;
    let open_worktrees = open_worktrees.0.lock().map_err(|error| error.to_string())?;
    let worktrees = parse_worktree_records(&output)
        .into_iter()
        .map(|worktree| {
            let path = worktree.path;
            let is_open = open_worktrees
                .values()
                .any(|worktree| worktree.project_id == id && worktree.worktree_path == path);
            Worktree {
                name: worktree_name(&path),
                path,
                branch: worktree.branch,
                head: worktree.head,
                is_main: worktree.is_main,
                is_detached: worktree.is_detached,
                is_locked: worktree.is_locked,
                is_prunable: worktree.is_prunable,
                is_open,
            }
        })
        .collect::<Vec<_>>();

    let main = worktrees
        .first()
        .ok_or_else(|| "No usable Git worktrees were found.".to_string())?;
    Ok(Project {
        id,
        name: worktree_name(&main.path),
        path: main.path.clone(),
        worktrees,
    })
}

fn recent_project_list(open_worktrees: &OpenWorktrees) -> Result<Vec<Project>, String> {
    let mut project_ids = HashSet::new();
    Ok(load_recent_paths()?
        .into_iter()
        .filter_map(|path| project_at(&path, open_worktrees).ok())
        .filter(|project| project_ids.insert(project.id.clone()))
        .collect())
}

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
struct AppMenuState {
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
fn update_recent_menu(app: Option<&AppHandle>) {
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
fn update_recent_menu(_app: Option<&AppHandle>) {}

/// Canonicalizes a user-supplied path to its worktree root and records it as recently opened.
fn remember_repository(
    path: &str,
    open_worktrees: &OpenWorktrees,
    app: Option<&AppHandle>,
) -> Result<Project, String> {
    let worktree_path = worktree_path(path)?;
    let project = project_at(&worktree_path, open_worktrees)?;
    save_recent_path(&project.path, app)?;
    Ok(project)
}

#[tauri::command]
fn recent_projects(open_worktrees: tauri::State<OpenWorktrees>) -> Result<Vec<Project>, String> {
    recent_project_list(&open_worktrees)
}

#[tauri::command]
fn clear_recent_projects(app: AppHandle) -> Result<(), String> {
    clear_recent_paths(Some(&app))
}

#[tauri::command]
fn settings() -> Result<BTreeMap<String, serde_json::Value>, String> {
    load_settings()
}

#[tauri::command]
fn set_setting(app: AppHandle, key: String, value: serde_json::Value) -> Result<(), String> {
    save_setting_at_then(&settings_path()?, key.clone(), value.clone(), || {
        app.emit(SETTING_CHANGED_EVENT, SettingChanged { key, value })
            .map_err(|error| error.to_string())
    })
}

#[tauri::command]
fn repository_layout(path: String, client_id: String) -> Result<RepositoryLayout, String> {
    load_repository_layout(path, client_id)
}

#[tauri::command]
fn save_repository_layout(
    path: String,
    client_id: String,
    layout: serde_json::Value,
) -> Result<(), String> {
    save_repository_layout_at(&repository_layouts_path()?, path, client_id, layout)
}

#[tauri::command]
fn project_snapshot(
    path: String,
    open_worktrees: tauri::State<OpenWorktrees>,
) -> Result<Project, String> {
    project_at(&path, &open_worktrees)
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ZoomDirection {
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
fn zoom(app: AppHandle, direction: ZoomDirection) -> Result<(), String> {
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

#[cfg(target_os = "macos")]
fn macos_traffic_light_position(app: &AppHandle) -> Result<tauri::LogicalPosition<f64>, String> {
    app.config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .and_then(|config| config.traffic_light_position.as_ref())
        .map(|position| tauri::LogicalPosition::new(position.x, position.y))
        .ok_or_else(|| "Could not find the macOS traffic-light position.".to_string())
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

fn reveal_launcher(app: &AppHandle) -> Result<(), String> {
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
    reveal_window(&window)
}

#[tauri::command]
fn show_launcher(app: AppHandle) -> Result<(), String> {
    reveal_launcher(&app)
}

#[tauri::command]
async fn choose_repository(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
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
fn install_app_menu(app: &AppHandle) -> Result<(), String> {
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
    let file_separator = PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;
    file.prepend_items(&[&new_window, &open, &recent, &file_separator])
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
            // Which tab is active, and whether there is one at all, is only known to the window.
            MENU_CLOSE_TAB => match focused_window(app) {
                Some(window) => app
                    .emit_to(window.label(), CLOSE_TAB_EVENT, ())
                    .map_err(|error| error.to_string()),
                None => Ok(()),
            },
            MENU_CLOSE_WINDOW => match focused_window(app) {
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

fn open_repository_window(app: &AppHandle, path: &str) -> Result<(), String> {
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
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(macos_traffic_light_position(app)?);
        let window = builder
            .build()
            .map_err(|error| error.to_string())?;
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

fn repository_path_from_args(args: &[String], cwd: &str) -> Option<String> {
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

fn lane_for(lanes: &mut Vec<Option<String>>, hash: &str, reserve_first: bool) -> usize {
    if let Some(index) = lanes
        .iter()
        .position(|waiting_for| waiting_for.as_deref() == Some(hash))
    {
        return index;
    }

    let first = usize::from(reserve_first);
    if let Some(index) = lanes.iter().skip(first).position(Option::is_none) {
        return first + index;
    }

    lanes.push(None);
    lanes.len() - 1
}

fn parse_commit(
    line: &str,
    lanes: &mut Vec<Option<String>>,
    reserved_tip: &mut Option<String>,
) -> Option<Vec<serde_json::Value>> {
    let fields: Vec<_> = line.split('\0').collect();
    if fields.len() != 6 || fields[0].is_empty() {
        return None;
    }

    let hash = fields[0];
    let parents: Vec<_> = fields[1]
        .split_whitespace()
        .filter(|parent| !parent.is_empty())
        .collect();
    // Lane 0 stays empty until the default branch tip arrives so it reports inactive on the rows above it.
    if reserved_tip.is_some() && lanes.is_empty() {
        lanes.push(None);
    }
    let lane = if reserved_tip.as_deref() == Some(hash) {
        *reserved_tip = None;
        0
    } else {
        lane_for(lanes, hash, reserved_tip.is_some())
    };
    let incoming_lanes: Vec<_> = lanes
        .iter()
        .enumerate()
        .filter_map(|(index, waiting_for)| (waiting_for.as_deref() == Some(hash)).then_some(index))
        .collect();
    for (index, waiting_for) in lanes.iter_mut().enumerate() {
        if index != lane && waiting_for.as_deref() == Some(hash) {
            *waiting_for = None;
        }
    }
    let mut parent_lanes = Vec::with_capacity(parents.len());

    if let Some(first_parent) = parents.first() {
        lanes[lane] = Some((*first_parent).to_string());
        parent_lanes.push(lane);

        for parent in parents.iter().skip(1) {
            let parent_lane = lane_for(lanes, parent, reserved_tip.is_some());
            lanes[parent_lane] = Some((*parent).to_string());
            parent_lanes.push(parent_lane);
        }
    } else {
        lanes[lane] = None;
    }

    while lanes.last().is_some_and(Option::is_none) {
        lanes.pop();
    }
    let active_lanes: Vec<_> = lanes.iter().map(Option::is_some).collect();

    let refs = if fields[4].is_empty() {
        Vec::new()
    } else {
        fields[4].split(", ").collect()
    };

    Some(vec![
        serde_json::Value::String(hash.to_string()),
        serde_json::json!(parents),
        serde_json::Value::String(fields[2].to_string()),
        serde_json::Value::String(fields[3].to_string()),
        serde_json::json!(refs),
        serde_json::Value::String(fields[5].to_string()),
        serde_json::json!(lane),
        serde_json::json!(parent_lanes),
        serde_json::json!(lanes.len()),
        serde_json::json!(incoming_lanes),
        serde_json::json!(active_lanes),
    ])
}

/// The revisions a graph is walked from. `--all` also reaches refs/stash, refs/notes and refs/prefetch, whose
/// commits are not history and arrive as unlabelled rows, so the set is named rather than inferred.
fn graph_revisions(repo_path: &str) -> Vec<String> {
    let mut revisions = vec![
        "--branches".to_string(),
        "--tags".to_string(),
        "--remotes".to_string(),
    ];
    // A repository with no commits has no HEAD to resolve, and naming it as a revision fails the whole walk.
    if resolve_commit(repo_path, "HEAD").is_ok() {
        revisions.push("HEAD".to_string());
    }
    // `HEAD` names this worktree only, while `--all` reached every one of them, so a worktree sitting on a
    // detached HEAD would otherwise take its commits out of the graph with it.
    // A stash is drawn on the commit it was made from, which nothing else reaches once the branch it was
    // taken from has moved on.
    for sha in worktree_heads(repo_path).into_iter().chain(stash_bases(repo_path)) {
        if !revisions.contains(&sha) {
            revisions.push(sha);
        }
    }
    revisions
}

fn worktree_heads(repo_path: &str) -> Vec<String> {
    let Ok(output) = git_output_allow_empty(repo_path, &["worktree", "list", "--porcelain", "-z"]) else {
        return Vec::new();
    };
    output
        .split('\0')
        .filter_map(|field| field.trim().strip_prefix("HEAD ").map(str::to_string))
        .collect()
}

fn stash_bases(repo_path: &str) -> Vec<String> {
    let Ok(output) = git_output_allow_empty(repo_path, &["stash", "list", "-z", "--format=%P"]) else {
        return Vec::new();
    };
    output
        .split('\0')
        .filter_map(|record| record.split_whitespace().next())
        .map(str::to_string)
        .collect()
}

/// Feeds `on_batch` as `git log` produces rows; returning `Err` from it stops the walk early.
fn walk_commit_graph(
    repo_path: &str,
    on_batch: impl FnMut(Vec<Vec<serde_json::Value>>) -> Result<(), String>,
) -> Result<(), String> {
    walk_commit_graph_page(repo_path, 0, usize::MAX, on_batch).map(|_| ())
}

/// Feeds one contiguous graph window to `on_batch`, returning whether older commits remain.
fn walk_commit_graph_page(
    repo_path: &str,
    offset: usize,
    limit: usize,
    mut on_batch: impl FnMut(Vec<Vec<serde_json::Value>>) -> Result<(), String>,
) -> Result<bool, String> {
    let mut reserved_tip = reserved_lane_tip(repo_path);
    let revisions = graph_revisions(repo_path);
    let mut child = ChildGuard(
        external_command("git")
            .args(["--no-optional-locks", "-C", repo_path, "log"])
            .args(&revisions)
            .args(["--topo-order", "--format=%H%x00%P%x00%an%x00%aI%x00%D%x00%s"])
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|error| error.to_string())?,
    );
    let stdout = child
        .0
        .stdout
        .take()
        .ok_or_else(|| "Could not read git output.".to_string())?;
    let mut lanes = Vec::new();
    let mut batch = Vec::with_capacity(COMMIT_BATCH_SIZE);
    let mut skipped = 0;
    let mut sent = 0;

    // A send failure means the receiver is gone, so stop git rather than walking the whole history.
    let mut deliver = |batch| match on_batch(batch) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = child.0.kill();
            Err(error)
        }
    };

    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|error| error.to_string())?;
        if sent == limit {
            return Ok(true);
        }
        if let Some(commit) = parse_commit(&line, &mut lanes, &mut reserved_tip) {
            if skipped < offset {
                skipped += 1;
                continue;
            }
            batch.push(commit);
            sent += 1;
        }

        if batch.len() == COMMIT_BATCH_SIZE || sent == limit {
            deliver(batch)?;
            batch = Vec::with_capacity(COMMIT_BATCH_SIZE);
        }
    }

    if !batch.is_empty() {
        deliver(batch)?;
    }

    let status = child.0.wait().map_err(|error| error.to_string())?;
    if status.success() {
        Ok(false)
    } else {
        Err("git log failed.".to_string())
    }
}

// Only ever compared against the previous fingerprint from the same run, so a process-local hash is enough.
fn fingerprint(values: &[&str]) -> String {
    let mut hasher = DefaultHasher::new();
    for value in values {
        value.hash(&mut hasher);
    }
    hasher.finish().to_string()
}

// show-ref exits non-zero on a repository with no refs, and symbolic-ref does the same on a detached HEAD.
#[git_nav_macros::http_command]
#[tauri::command(async)]
fn repository_fingerprint(repo_path: String) -> String {
    let refs = git_output_allow_empty(&repo_path, &["--no-optional-locks", "show-ref", "--head"])
        .unwrap_or_default();
    let head = git_output_allow_empty(&repo_path, &["symbolic-ref", "--quiet", "HEAD"])
        .unwrap_or_default();
    fingerprint(&[&refs, &head])
}

#[tauri::command]
fn stream_commit_graph(
    repo_path: String,
    on_batch: Channel<Vec<Vec<serde_json::Value>>>,
) -> Result<(), String> {
    walk_commit_graph(&repo_path, |batch| {
        on_batch.send(batch).map_err(|error| error.to_string())
    })
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn inferred_squash_merge_edges(repo_path: String) -> Vec<(String, String)> {
    let Ok(database_path) = pull_request_database_path() else {
        return Vec::new();
    };
    tauri::async_runtime::spawn_blocking(move || inferred_squash_merges(&repo_path, database_path))
        .await
        .unwrap_or_default()
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn fetch_and_sync_pull_requests(repo_path: String) -> Result<(), String> {
    let database_path = pull_request_database_path()?;
    tauri::async_runtime::spawn_blocking(move || fetch_and_sync_repository(&repo_path, database_path))
        .await
        .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn branch_pull_requests(repo_path: String) -> Result<Vec<BranchPullRequest>, String> {
    let database_path = pull_request_database_path()?;
    tauri::async_runtime::spawn_blocking(move || pull_requests_by_branch(&repo_path, database_path))
        .await
        .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn squashed_branch_candidates(repo_path: String) -> Result<Vec<String>, String> {
    let database_path = pull_request_database_path()?;
    tauri::async_runtime::spawn_blocking(move || merged_branch_candidates(&repo_path, database_path))
        .await
        .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn preview_cleanup_candidates(
    repo_path: String,
    options: CleanupOptions,
) -> Result<Vec<CleanupCandidate>, String> {
    let database_path = cleanup_database_path(&options)?;
    tauri::async_runtime::spawn_blocking(move || {
        cleanup_candidates(&repo_path, &options, database_path)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn delete_squashed_branches(
    repo_path: String,
    options: CleanupOptions,
) -> Result<BranchCleanup, String> {
    let database_path = cleanup_database_path(&options)?;
    tauri::async_runtime::spawn_blocking(move || {
        delete_cleanup_candidates(&repo_path, &options, database_path)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
fn delete_branch(repo_path: String, branch: String) -> Result<OperationResult, String> {
    run_worktree_operation(
        &repo_path,
        &repo_path,
        format!("Deleted {branch}."),
        &["branch", "--delete", "--force", "--", &branch],
        None,
    )
}

fn parse_branch_sync(output: &str) -> Vec<BranchSync> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\0');
            let branch = fields.next()?;
            let upstream = fields.next().unwrap_or_default();
            let track = fields.next().unwrap_or_default();
            let mut sync = BranchSync {
                branch: branch.to_string(),
                upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
                ahead: 0,
                behind: 0,
                is_gone: track == "gone",
            };
            for part in track.split(", ") {
                if let Some(count) = part.strip_prefix("ahead ") {
                    sync.ahead = count.parse().unwrap_or_default();
                } else if let Some(count) = part.strip_prefix("behind ") {
                    sync.behind = count.parse().unwrap_or_default();
                }
            }
            Some(sync)
        })
        .collect()
}

#[git_nav_macros::http_command]
#[tauri::command(async)]
fn branch_sync(repo_path: String) -> Result<Vec<BranchSync>, String> {
    let output = git_output_allow_empty(
        &repo_path,
        &[
            "for-each-ref",
            "--format=%(refname:short)%00%(upstream:short)%00%(upstream:track,nobracket)",
            "refs/heads",
        ],
    )?;
    Ok(parse_branch_sync(&output))
}

fn comparison(repo_path: &str, base_ref: &str, head_ref: &str, merge_base: bool, ignore_whitespace: bool) -> Result<Comparison, String> {
    let is_worktree = head_ref == WORKTREE_REF;
    // The working tree has no commit of its own, so the checkout it sits on stands in for it as the
    // side the fork point is measured from.
    let resolved_base_sha = resolve_commit(repo_path, base_ref)?;
    if is_worktree {
        let base_sha = if merge_base {
            let head_commit_sha = resolve_commit(repo_path, "HEAD")?;
            merge_base_for_commits(repo_path, &resolved_base_sha, &head_commit_sha, base_ref, "HEAD")?
        } else {
            resolved_base_sha
        };
        return Ok(Comparison {
            files: worktree_changed_files(repo_path, &base_sha, ignore_whitespace)?,
            base_sha,
            head_sha: WORKTREE_REF.to_string(),
        });
    }
    let head_commit_sha = resolve_commit(repo_path, head_ref)?;
    let base_sha = if merge_base {
        merge_base_for_commits(repo_path, &resolved_base_sha, &head_commit_sha, base_ref, head_ref)?
    } else {
        resolved_base_sha
    };
    Ok(Comparison {
        files: changed_files(repo_path, &base_sha, &head_commit_sha, ignore_whitespace)?,
        base_sha,
        head_sha: head_commit_sha,
    })
}

#[git_nav_macros::http_command]
#[tauri::command(async)]
fn compare_refs(repo_path: String, base_ref: String, head_ref: String, merge_base: bool, ignore_whitespace: bool) -> Result<Comparison, String> {
    comparison(&repo_path, &base_ref, &head_ref, merge_base, ignore_whitespace)
}

const VIEWED_COMPARISON_LIMIT: i64 = 50;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ViewedFile {
    path: String,
    identity: String,
}

fn viewed_files_database_path() -> Result<PathBuf, String> {
    data_dir().map(|dir| dir.join("viewed-files.sqlite3"))
}

fn migrate_viewed_files_database(connection: &mut Connection) -> Result<(), String> {
    connection
        .execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)")
        .map_err(|error| error.to_string())?;
    let version = connection
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get::<_, Option<i64>>(0))
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    if version < 2 {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction
            .execute_batch(
                "
                DROP TABLE IF EXISTS viewed_files;
                CREATE TABLE viewed_files (
                  project_id TEXT NOT NULL,
                  base_ref TEXT NOT NULL,
                  head_ref TEXT NOT NULL,
                  merge_base INTEGER NOT NULL,
                  path TEXT NOT NULL,
                  oid TEXT NOT NULL,
                  viewed_at INTEGER NOT NULL,
                  PRIMARY KEY (project_id, base_ref, head_ref, merge_base, path)
                );
                INSERT INTO schema_migrations (version) VALUES (2);
                ",
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    if version < 3 {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        // A mark now stands for the patch a file was read at, which both of its blobs decide together, so
        // the marks stored against one of them no longer say what they were taken to say.
        transaction
            .execute_batch(
                "
                ALTER TABLE viewed_files RENAME COLUMN oid TO identity;
                DELETE FROM viewed_files;
                INSERT INTO schema_migrations (version) VALUES (3);
                ",
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn viewed_files_database(path: PathBuf) -> Result<Connection, String> {
    let mut connection = Connection::open(path).map_err(|error| error.to_string())?;
    migrate_viewed_files_database(&mut connection)?;
    Ok(connection)
}

fn read_viewed_files(
    connection: &Connection,
    project: &str,
    base_ref: &str,
    head_ref: &str,
    merge_base: bool,
) -> Result<Vec<ViewedFile>, String> {
    let mut statement = connection
        .prepare("SELECT path, identity FROM viewed_files WHERE project_id = ?1 AND base_ref = ?2 AND head_ref = ?3 AND merge_base = ?4")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![project, base_ref, head_ref, merge_base], |row| {
            Ok(ViewedFile {
                path: row.get(0)?,
                identity: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

// Marks are only worth keeping for the comparisons still being read, so the least recently marked ones
// fall away rather than growing a store nothing empties.
fn prune_viewed_comparisons(connection: &Connection, project: &str) -> Result<(), String> {
    connection
        .execute(
            "
            DELETE FROM viewed_files WHERE project_id = ?1 AND (base_ref, head_ref, merge_base) NOT IN (
              SELECT base_ref, head_ref, merge_base FROM viewed_files
              WHERE project_id = ?1
              GROUP BY base_ref, head_ref, merge_base
              ORDER BY MAX(viewed_at) DESC
              LIMIT ?2
            )
            ",
            params![project, VIEWED_COMPARISON_LIMIT],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn write_viewed_file(
    connection: &Connection,
    project: &str,
    base_ref: &str,
    head_ref: &str,
    merge_base: bool,
    path: &str,
    identity: &str,
    viewed: bool,
) -> Result<(), String> {
    if !viewed {
        connection
            .execute(
                "DELETE FROM viewed_files WHERE project_id = ?1 AND base_ref = ?2 AND head_ref = ?3 AND merge_base = ?4 AND path = ?5",
                params![project, base_ref, head_ref, merge_base, path],
            )
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    let viewed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs() as i64;
    connection
        .execute(
            "
            INSERT INTO viewed_files (project_id, base_ref, head_ref, merge_base, path, identity, viewed_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT (project_id, base_ref, head_ref, merge_base, path)
            DO UPDATE SET identity = excluded.identity, viewed_at = excluded.viewed_at
            ",
            params![project, base_ref, head_ref, merge_base, path, identity, viewed_at],
        )
        .map_err(|error| error.to_string())?;
    prune_viewed_comparisons(connection, project)
}

#[git_nav_macros::http_command]
#[tauri::command(async)]
fn viewed_files(repo_path: String, base_ref: String, head_ref: String, merge_base: bool) -> Result<Vec<ViewedFile>, String> {
    let project = project_id(&repo_path)?;
    let connection = viewed_files_database(viewed_files_database_path()?)?;
    read_viewed_files(&connection, &project, &base_ref, &head_ref, merge_base)
}

#[git_nav_macros::http_command]
#[tauri::command(async)]
fn set_file_viewed(
    repo_path: String,
    base_ref: String,
    head_ref: String,
    merge_base: bool,
    path: String,
    identity: String,
    viewed: bool,
) -> Result<(), String> {
    let project = project_id(&repo_path)?;
    let connection = viewed_files_database(viewed_files_database_path()?)?;
    write_viewed_file(&connection, &project, &base_ref, &head_ref, merge_base, &path, &identity, viewed)
}

fn picker_commits(repo_path: &str) -> Result<Vec<Vec<serde_json::Value>>, String> {
    let revisions = graph_revisions(repo_path);
    let arguments: Vec<&str> = ["log"]
        .into_iter()
        .chain(revisions.iter().map(String::as_str))
        .chain(["--topo-order", "--max-count=250", "--format=%H%x00%P%x00%an%x00%aI%x00%D%x00%s"])
        .collect();
    let output = git_output_allow_empty(repo_path, &arguments)?;
    let mut lanes = Vec::new();
    Ok(output
        .lines()
        .filter_map(|line| parse_commit(line, &mut lanes, &mut None))
        .collect())
}

#[git_nav_macros::http_command]
#[tauri::command]
fn reference_picker_commits(repo_path: String) -> Result<Vec<Vec<serde_json::Value>>, String> {
    picker_commits(&repo_path)
}

fn parse_references(output: &str) -> Vec<Reference> {
    output
        .lines()
        .filter_map(|line| {
            let [full_name, name, object, dereferenced, subject, tagged_subject, date] = line.split('\0').collect::<Vec<_>>()[..] else {
                return None;
            };
            let kind = if full_name.starts_with("refs/heads/") {
                "branch"
            } else if full_name.starts_with("refs/remotes/") {
                "remote"
            } else {
                "tag"
            };
            // A remote's HEAD only points at one of its branches, which is already listed on its own. Its
            // short name is the remote itself, so only the full name gives it away.
            if kind == "remote" && full_name.ends_with("/HEAD") {
                return None;
            }
            // An annotated tag names the tag object, and the commit it carries is behind the dereference.
            let (sha, subject) = if dereferenced.is_empty() {
                (object, subject)
            } else {
                (dereferenced, tagged_subject)
            };
            Some(Reference {
                kind: kind.to_string(),
                name: name.to_string(),
                sha: sha.to_string(),
                subject: subject.to_string(),
                date: date.to_string(),
            })
        })
        .collect()
}

#[git_nav_macros::http_command]
#[tauri::command(async)]
fn repository_references(repo_path: String) -> Result<Vec<Reference>, String> {
    let output = git_output_allow_empty(
        &repo_path,
        &[
            "for-each-ref",
            "--sort=-creatordate",
            &format!("--format={REFERENCE_FORMAT}"),
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )?;
    Ok(parse_references(&output))
}

#[git_nav_macros::http_command]
#[tauri::command(async)]
fn resolve_revision(repo_path: String, revision: String) -> Result<ResolvedRevision, String> {
    let sha = resolve_commit(&repo_path, &revision)?;
    let subject = git_output_allow_empty(&repo_path, &["log", "-1", "--format=%s", &sha])?;
    Ok(ResolvedRevision { sha, subject: subject.trim().to_string() })
}

fn merge_base_sha(repo_path: &str, base_ref: &str, head_ref: &str) -> Result<String, String> {
    let base_sha = resolve_commit(repo_path, base_ref)?;
    let head_sha = resolve_commit(repo_path, head_ref)?;
    merge_base_for_commits(repo_path, &base_sha, &head_sha, base_ref, head_ref)
}

fn merge_base_for_commits(repo_path: &str, base_sha: &str, head_sha: &str, base_ref: &str, head_ref: &str) -> Result<String, String> {
    let output = git_result(repo_path, &["merge-base", base_sha, head_sha])?;
    let sha = String::from_utf8(output.stdout).map_err(|error| error.to_string())?.trim().to_string();
    if !output.status.success() {
        if output.status.code() == Some(1) && sha.is_empty() {
            return Err(format!("Could not find a merge base for {base_ref} and {head_ref}."));
        }
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    if sha.is_empty() {
        return Err(format!("Could not find a merge base for {base_ref} and {head_ref}."));
    }
    Ok(sha)
}

// The range is named by its two refs rather than by where they point now, so the comparison follows
// the branch as it moves instead of freezing at the moment it was opened.
fn branch_range(repo_path: &str, reference: &str) -> Result<BranchSelection, String> {
    let primary = primary_reference(repo_path)?;
    merge_base_sha(repo_path, &primary, reference)?;
    Ok(BranchSelection { base_ref: primary, head_ref: reference.to_string() })
}

#[git_nav_macros::http_command]
#[tauri::command]
fn select_branch_range(repo_path: String, reference: String) -> Result<BranchSelection, String> {
    branch_range(&repo_path, &reference)
}

// git diff cannot see an untracked file, so an empty patch means falling back to an empty left side.
fn worktree_patch(repo_path: &str, base_sha: &str, path: &str, ignore_whitespace: bool) -> Result<String, String> {
    let whitespace = whitespace_arguments(ignore_whitespace);
    let patch = git_output_allow_empty(repo_path, &[&PATCH_ARGUMENTS[..], whitespace, &[base_sha, "--", path]].concat())?;
    if !patch.is_empty() {
        return Ok(patch);
    }
    // --no-index reports a difference by exiting non-zero, so its status carries no error to report.
    let output = git_result(repo_path, &[&PATCH_ARGUMENTS[..], whitespace, &["--no-index", "--", "/dev/null", path]].concat())?;
    String::from_utf8(output.stdout).map_err(|error| error.to_string())
}

fn file_diff(
    repo_path: &str,
    base_sha: &str,
    head_sha: &str,
    old_path: Option<String>,
    new_path: Option<String>,
    ignore_whitespace: bool,
) -> Result<FileDiff, String> {
    let path = new_path.as_ref().or(old_path.as_ref()).ok_or_else(|| "No file path was provided.".to_string())?;
    let is_worktree = head_sha == WORKTREE_REF;
    let patch = if is_worktree {
        worktree_patch(repo_path, base_sha, path, ignore_whitespace)?
    } else {
        git_output_allow_empty(repo_path, &[&PATCH_ARGUMENTS[..], whitespace_arguments(ignore_whitespace), &[base_sha, head_sha, "--", path]].concat())?
    };
    // Content lines in a patch always carry a leading marker, so an unprefixed header is git's own.
    if patch.lines().any(|line| line.starts_with("Binary files ") || line == "GIT binary patch") {
        return Ok(FileDiff {
            old_file_name: old_path,
            new_file_name: new_path,
            old_content: None,
            new_content: None,
            hunks: Vec::new(),
            is_binary: true,
        });
    }

    let old_content = old_path.as_ref().map(|path| git_output_allow_empty(repo_path, &["show", &format!("{base_sha}:{path}")])).transpose()?;
    let new_content = if is_worktree {
        let root = worktree_path(repo_path)?;
        new_path.as_ref().map(|path| fs::read_to_string(Path::new(&root).join(path)).map_err(|error| error.to_string())).transpose()?
    } else {
        new_path.as_ref().map(|path| git_output_allow_empty(repo_path, &["show", &format!("{head_sha}:{path}")])).transpose()?
    };

    Ok(FileDiff {
        old_file_name: old_path,
        new_file_name: new_path,
        old_content,
        new_content,
        hunks: (!patch.is_empty()).then_some(vec![patch]).unwrap_or_default(),
        is_binary: false,
    })
}

#[git_nav_macros::http_command]
#[tauri::command(async)]
fn diff_file(
    repo_path: String,
    base_sha: String,
    head_sha: String,
    old_path: Option<String>,
    new_path: Option<String>,
    ignore_whitespace: bool,
) -> Result<FileDiff, String> {
    file_diff(&repo_path, &base_sha, &head_sha, old_path, new_path, ignore_whitespace)
}

fn git_result(path: &str, arguments: &[&str]) -> Result<Output, String> {
    external_command("git")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| error.to_string())
}

fn parse_git_version(output: &str) -> Option<(u32, u32)> {
    let mut parts = output.split_whitespace().nth(2)?.split('.');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

fn git_version(path: &str) -> Option<(u32, u32)> {
    git_output(path, &["--version"]).as_deref().and_then(parse_git_version)
}

fn parse_merge_tree_output(stdout: &str) -> Result<(String, Vec<String>), String> {
    let mut fields = stdout.split('\0');
    let tree = fields
        .next()
        .filter(|tree| !tree.is_empty())
        .ok_or_else(|| "git merge-tree produced no tree.".to_string())?;
    Ok((
        tree.to_string(),
        fields.take_while(|field| !field.is_empty()).map(str::to_string).collect(),
    ))
}

// merge-tree only learned to answer this without a worktree, through --write-tree, in 2.38.
fn merge_tree_unavailable(repo_path: &str) -> Option<ConflictPrediction> {
    let Some(version) = git_version(repo_path) else {
        return Some(ConflictPrediction::Unknown { reason: "Could not read the installed Git version.".to_string() });
    };
    if version < MINIMUM_MERGE_TREE_VERSION {
        let (major, minor) = MINIMUM_MERGE_TREE_VERSION;
        return Some(ConflictPrediction::Unknown {
            reason: format!("Predicting conflicts requires Git {major}.{minor} or newer."),
        });
    }
    None
}

fn predicted_conflicts(repo_path: &str, onto: &str, upstream: &str, branch: &str) -> Result<ConflictPrediction, String> {
    if let Some(prediction) = merge_tree_unavailable(repo_path) {
        return Ok(prediction);
    }
    let onto_sha = resolve_commit(repo_path, onto)?;
    let upstream_sha = resolve_commit(repo_path, upstream)?;
    let branch_sha = resolve_commit(repo_path, branch)?;
    // Three dots so --cherry-pick sees the upstream side and drops the commits git rebase would skip as already applied.
    let range = format!("{upstream_sha}...{branch_sha}");
    let commits = git_output_allow_empty(
        repo_path,
        &["rev-list", "--reverse", "--topo-order", "--no-merges", "--cherry-pick", "--right-only", &range],
    )?;
    let mut accumulated = git_output(repo_path, &["rev-parse", "--verify", &format!("{onto_sha}^{{tree}}")])
        .ok_or_else(|| format!("Could not resolve the tree of {onto}."))?;

    for commit in commits.lines() {
        let Some(parent) = git_output(repo_path, &["rev-parse", "--verify", "--quiet", &format!("{commit}^1")]) else {
            return Ok(ConflictPrediction::Unknown { reason: format!("{commit} has no parent to replay against.") });
        };
        let output = git_result(
            repo_path,
            &[
                "merge-tree",
                "-z",
                "--write-tree",
                "--name-only",
                &format!("--merge-base={parent}"),
                &accumulated,
                commit,
            ],
        )?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        match output.status.code() {
            Some(0) => accumulated = parse_merge_tree_output(&stdout)?.0,
            Some(1) => {
                return Ok(ConflictPrediction::Conflicts(PredictedConflict {
                    commit: commit.to_string(),
                    subject: git_output(repo_path, &["log", "-1", "--format=%s", commit]).unwrap_or_default(),
                    files: parse_merge_tree_output(&stdout)?.1,
                }))
            }
            _ => {
                return Ok(ConflictPrediction::Unknown {
                    reason: String::from_utf8_lossy(&output.stderr).trim().to_string(),
                })
            }
        }
    }

    Ok(ConflictPrediction::Clean)
}

fn existing_git_path(worktree: &str, name: &str) -> Option<PathBuf> {
    let path = PathBuf::from(git_output(worktree, &["rev-parse", "--git-path", name])?);
    let path = if path.is_absolute() { path } else { Path::new(worktree).join(path) };
    path.exists().then_some(path)
}

fn rebasing_branch(worktree: &str) -> Option<String> {
    ["rebase-merge/head-name", "rebase-apply/head-name"]
        .into_iter()
        .find_map(|name| existing_git_path(worktree, name))
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|head| head.trim().strip_prefix("refs/heads/").map(str::to_string))
}

// A worktree that is mid-rebase reports a detached HEAD, but it still owns the branch it is rebasing.
fn worktree_for_branch(repo_path: &str, branch: &str) -> Result<Option<String>, String> {
    let output = git_output_allow_empty(repo_path, &["worktree", "list", "--porcelain", "-z"])?;
    Ok(parse_worktree_records(&output)
        .into_iter()
        .find(|worktree| {
            if worktree.is_detached {
                rebasing_branch(&worktree.path).as_deref() == Some(branch)
            } else {
                worktree.branch == branch
            }
        })
        .map(|worktree| worktree.path))
}

fn pending_operation(worktree: &str) -> Option<PendingOperation> {
    [
        ("rebase-merge", PendingOperation::Rebase),
        ("rebase-apply", PendingOperation::Rebase),
        ("MERGE_HEAD", PendingOperation::Merge),
        ("CHERRY_PICK_HEAD", PendingOperation::CherryPick),
        ("BISECT_LOG", PendingOperation::Bisect),
    ]
    .into_iter()
    .find(|(name, _)| existing_git_path(worktree, name).is_some())
    .map(|(_, operation)| operation)
}

fn worktree_is_dirty(worktree: &str) -> Result<bool, String> {
    let output = git_output_allow_empty(worktree, &["status", "--porcelain", "--untracked-files=no"])?;
    Ok(!output.trim().is_empty())
}

// The rebase safety check ignores untracked files, but a new file is still local work worth reporting.
fn parse_status_counts(output: &str) -> (u32, u32) {
    let mut changed = 0;
    let mut untracked = 0;
    for line in output.lines() {
        match line.split(' ').next() {
            Some("1" | "2" | "u") => changed += 1,
            Some("?") => untracked += 1,
            _ => {}
        }
    }
    (changed, untracked)
}

#[git_nav_macros::http_command]
#[tauri::command(async)]
fn worktree_status(repo_path: String) -> Result<Vec<WorktreeStatus>, String> {
    let output = git_output_allow_empty(&repo_path, &["worktree", "list", "--porcelain", "-z"])?;
    Ok(parse_worktree_records(&output)
        .into_iter()
        .filter(|worktree| !worktree.is_prunable)
        .filter_map(|worktree| {
            let status = git_output_allow_empty(
                &worktree.path,
                &[
                    "--no-optional-locks",
                    "status",
                    "--porcelain=v2",
                    "--untracked-files=normal",
                ],
            )
            .ok()?;
            let (changed_files, untracked_files) = parse_status_counts(&status);
            Some(WorktreeStatus {
                branch: worktree.branch,
                head: worktree.head,
                is_detached: worktree.is_detached,
                changed_files,
                untracked_files,
                pending_operation: pending_operation(&worktree.path),
                path: worktree.path,
            })
        })
        .collect())
}

fn same_path(left: &str, right: &str) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn branch_operability(repo_path: &str, branch: &str) -> Result<BranchOperability, String> {
    let sha = resolve_commit(repo_path, &format!("refs/heads/{branch}")).ok();
    let mut state = BranchOperability {
        exists: sha.is_some(),
        sha,
        worktree_path: None,
        is_current_worktree: false,
        is_dirty: false,
        pending_operation: None,
    };
    if !state.exists {
        return Ok(state);
    }
    if let Some(worktree) = worktree_for_branch(repo_path, branch)? {
        state.is_current_worktree = same_path(&worktree_path(repo_path)?, &worktree);
        state.is_dirty = worktree_is_dirty(&worktree)?;
        state.pending_operation = pending_operation(&worktree);
        state.worktree_path = Some(worktree);
    }
    Ok(state)
}

fn parse_ref_shas(output: &str) -> HashMap<String, String> {
    output
        .lines()
        .filter_map(|line| line.split_once('\0'))
        .map(|(reference, sha)| (reference.to_string(), sha.to_string()))
        .collect()
}

fn ref_shas(repo_path: &str) -> Result<HashMap<String, String>, String> {
    git_output_allow_empty(
        repo_path,
        &["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads", "refs/tags", "refs/remotes"],
    )
    .map(|output| parse_ref_shas(&output))
}

fn changed_refs(before: &HashMap<String, String>, after: &HashMap<String, String>) -> Vec<RefUpdate> {
    let mut updates: Vec<_> = before
        .keys()
        .chain(after.keys())
        .collect::<HashSet<_>>()
        .into_iter()
        .filter_map(|reference| {
            let was = before.get(reference).cloned().unwrap_or_default();
            let now = after.get(reference).cloned().unwrap_or_default();
            (was != now).then(|| RefUpdate {
                reference: reference.clone(),
                before: was,
                after: now,
            })
        })
        .collect();
    updates.sort_by(|left, right| left.reference.cmp(&right.reference));
    updates
}

fn conflicted_files(worktree: &str) -> Vec<String> {
    git_output_allow_empty(worktree, &["diff", "--name-only", "--diff-filter=U"])
        .map(|output| output.lines().map(str::to_string).collect())
        .unwrap_or_default()
}

fn failed_operation(worktree: &str, output: &Output) -> OperationResult {
    OperationResult::Failed(FailedOperation {
        files: conflicted_files(worktree),
        message: git_error_message(output),
    })
}

fn completed_operation(repo_path: &str, summary: String, before: &HashMap<String, String>) -> Result<OperationResult, String> {
    Ok(OperationResult::Completed(CompletedOperation {
        summary,
        updates: changed_refs(before, &ref_shas(repo_path)?),
    }))
}

fn temporary_worktree_path(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    env::temp_dir()
        .join(format!("git-nav-{prefix}-{}-{nanos}", std::process::id()))
        .to_string_lossy()
        .into_owned()
}

fn discard_temporary_worktree(repo_path: &str, worktree: &str) {
    let _ = git_result(worktree, &["rebase", "--abort"]);
    let _ = git_result(repo_path, &["worktree", "remove", "--force", "--", worktree]);
    let _ = git_result(repo_path, &["worktree", "prune"]);
    let _ = fs::remove_dir_all(worktree);
}

fn rebase_branch_onto(repo_path: &str, onto: &str, upstream: &str, branch: &str) -> Result<OperationResult, String> {
    let reference = format!("refs/heads/{branch}");
    resolve_commit(repo_path, &reference)?;
    resolve_commit(repo_path, onto)?;
    resolve_commit(repo_path, upstream)?;
    let summary = format!("Rebased {branch} onto {onto}.");
    let before = ref_shas(repo_path)?;

    if let Some(worktree) = worktree_for_branch(repo_path, branch)? {
        if pending_operation(&worktree).is_some() {
            return Err(format!("{worktree} already has a Git operation in progress."));
        }
        if worktree_is_dirty(&worktree)? {
            return Err(format!("{worktree} has uncommitted changes."));
        }
        let output = git_result(&worktree, &["rebase", "--onto", onto, upstream, branch])?;
        if output.status.success() {
            return completed_operation(repo_path, summary, &before);
        }
        let failure = failed_operation(&worktree, &output);
        let _ = git_result(&worktree, &["rebase", "--abort"]);
        return Ok(failure);
    }

    // Rebasing an unchecked-out branch from the user's own worktree would move that worktree onto it.
    let worktree = temporary_worktree_path("rebase");
    git_output_allow_empty(repo_path, &["worktree", "add", "--detach", &worktree, &reference])?;
    let result = git_result(&worktree, &["rebase", "--onto", onto, upstream, branch]).and_then(|output| {
        if output.status.success() {
            completed_operation(repo_path, summary, &before)
        } else {
            Ok(failed_operation(&worktree, &output))
        }
    });
    discard_temporary_worktree(repo_path, &worktree);
    result
}

fn restore_refs(repo_path: &str, updates: &[RefUpdate]) -> Result<(), String> {
    let mut worktrees = Vec::new();
    for update in updates {
        let Some(branch) = update.reference.strip_prefix("refs/heads/") else {
            continue;
        };
        let Some(worktree) = worktree_for_branch(repo_path, branch)? else {
            continue;
        };
        if pending_operation(&worktree).is_some() {
            return Err(format!("{worktree} has a Git operation in progress."));
        }
        if worktree_is_dirty(&worktree)? {
            return Err(format!("{worktree} has uncommitted changes."));
        }
        if update.before.is_empty() {
            return Err(format!("{branch} is checked out at {worktree}."));
        }
        worktrees.push(worktree);
    }
    for update in updates {
        let arguments = match (update.before.as_str(), update.after.as_str()) {
            ("", after) => vec!["update-ref", "-d", &update.reference, after],
            (before, "") => vec!["update-ref", &update.reference, before],
            (before, after) => vec!["update-ref", &update.reference, before, after],
        };
        git_output_allow_empty(repo_path, &arguments)?;
    }
    for worktree in worktrees {
        git_output_allow_empty(&worktree, &["reset", "--hard"])?;
    }
    Ok(())
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn predict_rebase_conflicts(
    repo_path: String,
    onto: String,
    upstream: String,
    branch: String,
) -> Result<ConflictPrediction, String> {
    tauri::async_runtime::spawn_blocking(move || predicted_conflicts(&repo_path, &onto, &upstream, &branch))
        .await
        .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
fn branch_operation_state(repo_path: String, branch: String) -> Result<BranchOperability, String> {
    branch_operability(&repo_path, &branch)
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn rebase_onto(
    repo_path: String,
    onto: String,
    upstream: String,
    branch: String,
) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || rebase_branch_onto(&repo_path, &onto, &upstream, &branch))
        .await
        .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn undo_ref_updates(repo_path: String, updates: Vec<RefUpdate>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || restore_refs(&repo_path, &updates))
        .await
        .map_err(|error| error.to_string())?
}

fn git_error_message(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        "Git exited without a message.".to_string()
    } else {
        stdout
    }
}

fn pending_operation_label(operation: &PendingOperation) -> &'static str {
    match operation {
        PendingOperation::Rebase => "rebasing",
        PendingOperation::Merge => "merging",
        PendingOperation::CherryPick => "cherry-picking",
        PendingOperation::Bisect => "bisecting",
    }
}

fn is_ancestor(repo_path: &str, ancestor: &str, descendant: &str) -> bool {
    git_result(repo_path, &["merge-base", "--is-ancestor", ancestor, descendant])
        .map(|output| output.status.success())
        .unwrap_or(false)
}

// Lane 0 belongs to the default branch, and a local branch that is only ahead of its remote is the same
// line of history, so the reservation starts at whichever of the two can reach the other.
fn reserved_lane_tip(repo_path: &str) -> Option<String> {
    let primary = primary_reference(repo_path).ok()?;
    let primary_sha = resolve_commit(repo_path, &primary).ok()?;
    let Some(local) = primary.strip_prefix("origin/") else {
        return Some(primary_sha);
    };
    let Ok(local_sha) = resolve_commit(repo_path, &format!("refs/heads/{local}")) else {
        return Some(primary_sha);
    };
    Some(if is_ancestor(repo_path, &primary_sha, &local_sha) {
        local_sha
    } else {
        primary_sha
    })
}

fn ensure_ref_name(repo_path: &str, prefix: &str, name: &str) -> Result<(), String> {
    let reference = format!("{prefix}{name}");
    let output = git_result(repo_path, &["check-ref-format", &reference])?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!("{name} is not a name Git can use."))
    }
}

fn idle_worktree(repo_path: &str) -> Result<String, String> {
    let worktree = worktree_path(repo_path)?;
    if let Some(operation) = pending_operation(&worktree) {
        return Err(format!("This worktree is already {}.", pending_operation_label(&operation)));
    }
    Ok(worktree)
}

fn run_worktree_operation(
    repo_path: &str,
    worktree: &str,
    summary: String,
    arguments: &[&str],
    abort: Option<&[&str]>,
) -> Result<OperationResult, String> {
    let before = ref_shas(repo_path)?;
    let output = git_result(worktree, arguments)?;
    if output.status.success() {
        return completed_operation(repo_path, summary, &before);
    }
    let failure = failed_operation(worktree, &output);
    if let Some(abort) = abort {
        let _ = git_result(worktree, abort);
    }
    Ok(failure)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryState {
    current_branch: Option<String>,
    head_sha: Option<String>,
    is_detached: bool,
    is_dirty: bool,
    pending_operation: Option<PendingOperation>,
    default_branch: Option<String>,
    remote: Option<String>,
    remotes: Vec<String>,
}

#[git_nav_macros::http_command]
#[tauri::command(async)]
fn merge_base(repo_path: String, left: String, right: String) -> Result<String, String> {
    let left = resolve_commit(&repo_path, &left)?;
    let right = resolve_commit(&repo_path, &right)?;
    git_output(&repo_path, &["merge-base", &left, &right])
        .ok_or_else(|| "These refs share no common history.".to_string())
}

#[git_nav_macros::http_command]
#[tauri::command(async)]
fn repository_state(repo_path: String) -> Result<RepositoryState, String> {
    let worktree = worktree_path(&repo_path)?;
    let current_branch = git_output(&worktree, &["symbolic-ref", "--quiet", "--short", "HEAD"]);
    let remotes = git_output_allow_empty(&repo_path, &["remote"]).unwrap_or_default();
    let remote = remotes
        .lines()
        .find(|name| *name == "origin")
        .or_else(|| remotes.lines().next())
        .map(str::to_string);
    Ok(RepositoryState {
        head_sha: resolve_commit(&worktree, "HEAD").ok(),
        is_detached: current_branch.is_none(),
        is_dirty: worktree_is_dirty(&worktree)?,
        pending_operation: pending_operation(&worktree),
        default_branch: primary_reference(&repo_path).ok(),
        current_branch,
        remote,
        remotes: remotes.lines().map(str::to_string).collect(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckoutOptions {
    create: Option<String>,
    track: bool,
    detach: bool,
    stash: bool,
}

const CHECKOUT_STASH_MESSAGE: &str = "git-nav: set aside before checkout";

fn checkout_reference(repo_path: &str, reference: &str, options: &CheckoutOptions) -> Result<OperationResult, String> {
    let worktree = idle_worktree(repo_path)?;
    if let Some(name) = &options.create {
        ensure_ref_name(repo_path, "refs/heads/", name)?;
    }
    let mut arguments = vec!["switch".to_string()];
    if options.detach {
        arguments.push("--detach".to_string());
    } else if let Some(name) = &options.create {
        arguments.push("-c".to_string());
        arguments.push(name.clone());
        if options.track {
            arguments.push("--track".to_string());
        }
    } else if options.track {
        arguments.push("--track".to_string());
    }
    arguments.push(reference.to_string());
    let arguments: Vec<_> = arguments.iter().map(String::as_str).collect();
    let before = ref_shas(repo_path)?;

    if options.stash {
        let stashed = git_result(&worktree, &["stash", "push", "--include-untracked", "--message", CHECKOUT_STASH_MESSAGE])?;
        if !stashed.status.success() {
            return Ok(failed_operation(&worktree, &stashed));
        }
    }

    let output = git_result(&worktree, &arguments)?;
    if !output.status.success() {
        if options.stash {
            let _ = git_result(&worktree, &["stash", "pop"]);
        }
        return Ok(failed_operation(&worktree, &output));
    }

    let landed = options.create.clone().unwrap_or_else(|| reference.to_string());
    let mut summary = format!("Checked out {landed}.");
    if options.stash && !git_result(&worktree, &["stash", "pop"])?.status.success() {
        summary = format!("{summary} The set aside changes conflicted, so they are still in the stash and the files carry conflict markers.");
    }
    completed_operation(repo_path, summary, &before)
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn checkout_ref(repo_path: String, reference: String, options: CheckoutOptions) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || checkout_reference(&repo_path, &reference, &options))
        .await
        .map_err(|error| error.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushOptions {
    remote: String,
    force: bool,
    set_upstream: bool,
    delete: bool,
}

fn push_reference(repo_path: &str, reference: &str, options: &PushOptions) -> Result<OperationResult, String> {
    let worktree = worktree_path(repo_path)?;
    let mut arguments = vec!["push".to_string()];
    if options.force {
        arguments.push("--force-with-lease".to_string());
        arguments.push("--force-if-includes".to_string());
    }
    if options.set_upstream {
        arguments.push("--set-upstream".to_string());
    }
    if options.delete {
        arguments.push("--delete".to_string());
    }
    arguments.push(options.remote.clone());
    arguments.push(reference.to_string());
    let arguments: Vec<_> = arguments.iter().map(String::as_str).collect();
    let output = git_result(&worktree, &arguments)?;
    if !output.status.success() {
        return Ok(failed_operation(&worktree, &output));
    }
    let summary = if options.delete {
        format!("Deleted {reference} from {}.", options.remote)
    } else {
        format!("Pushed {reference} to {}.", options.remote)
    };
    // Rewinding the local remote-tracking ref would hide the push rather than reverse it, so this reports no undo.
    Ok(OperationResult::Completed(CompletedOperation { summary, updates: Vec::new() }))
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn push_ref(repo_path: String, reference: String, options: PushOptions) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || push_reference(&repo_path, &reference, &options))
        .await
        .map_err(|error| error.to_string())?
}

fn upstream_of(repo_path: &str, branch: &str) -> Result<String, String> {
    git_output(repo_path, &["rev-parse", "--abbrev-ref", &format!("{branch}@{{upstream}}")])
        .ok_or_else(|| format!("{branch} has no upstream branch."))
}

fn fast_forward_branch(repo_path: &str, branch: &str) -> Result<OperationResult, String> {
    let upstream = upstream_of(repo_path, branch)?;
    let (remote, remote_branch) = upstream
        .split_once('/')
        .ok_or_else(|| format!("Could not read the remote of {upstream}."))?;
    let before = ref_shas(repo_path)?;
    let fetched = git_result(repo_path, &["fetch", remote, remote_branch])?;
    if !fetched.status.success() {
        return Ok(OperationResult::Failed(FailedOperation { message: git_error_message(&fetched), files: Vec::new() }));
    }

    let summary = format!("Fast-forwarded {branch} to {upstream}.");
    if let Some(worktree) = worktree_for_branch(repo_path, branch)? {
        if pending_operation(&worktree).is_some() {
            return Err(format!("{worktree} has a Git operation in progress."));
        }
        let output = git_result(&worktree, &["merge", "--ff-only", &upstream])?;
        if !output.status.success() {
            return Ok(failed_operation(&worktree, &output));
        }
        return completed_operation(repo_path, summary, &before);
    }

    let refspec = format!("{remote_branch}:{branch}");
    let output = git_result(repo_path, &["fetch", remote, &refspec])?;
    if !output.status.success() {
        return Ok(OperationResult::Failed(FailedOperation { message: git_error_message(&output), files: Vec::new() }));
    }
    completed_operation(repo_path, summary, &before)
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn pull_branch(repo_path: String, branch: String) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || fast_forward_branch(&repo_path, &branch))
        .await
        .map_err(|error| error.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergeOptions {
    mode: String,
    message: Option<String>,
}

// Git ignores -m under --squash and writes no MERGE_HEAD, so the commit that lands the squash and the
// recovery that undoes a conflicted one both have to be spelled out here.
fn squash_into_branch(repo_path: &str, worktree: &str, source: &str, into: &str, message: Option<&str>) -> Result<OperationResult, String> {
    let message = message
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .ok_or_else(|| "A squash merge needs a commit message.".to_string())?;
    let before = ref_shas(repo_path)?;
    let merged = git_result(worktree, &["merge", "--squash", source])?;
    if !merged.status.success() {
        let failure = failed_operation(worktree, &merged);
        let _ = git_result(worktree, &["reset", "--merge"]);
        return Ok(failure);
    }
    if !worktree_is_dirty(worktree)? {
        let _ = git_result(worktree, &["reset", "--merge"]);
        return completed_operation(repo_path, format!("{into} already has every change in {source}."), &before);
    }
    let committed = git_result(worktree, &["commit", "--message", message])?;
    if !committed.status.success() {
        let failure = failed_operation(worktree, &committed);
        let _ = git_result(worktree, &["reset", "--merge"]);
        return Ok(failure);
    }
    completed_operation(repo_path, format!("Squashed {source} into a single commit on {into}."), &before)
}

fn merge_into_branch(repo_path: &str, source: &str, into: &str, options: &MergeOptions) -> Result<OperationResult, String> {
    resolve_commit(repo_path, source)?;
    let worktree = worktree_for_branch(repo_path, into)?
        .ok_or_else(|| format!("{into} is not checked out in any worktree."))?;
    if let Some(operation) = pending_operation(&worktree) {
        return Err(format!("{worktree} is already {}.", pending_operation_label(&operation)));
    }
    if worktree_is_dirty(&worktree)? {
        return Err(format!("{worktree} has uncommitted changes."));
    }
    if options.mode == "squash" {
        return squash_into_branch(repo_path, &worktree, source, into, options.message.as_deref());
    }

    let mut arguments = vec!["merge".to_string(), "--no-edit".to_string()];
    match options.mode.as_str() {
        "noFastForward" => arguments.push("--no-ff".to_string()),
        "fastForwardOnly" => arguments.push("--ff-only".to_string()),
        _ => {}
    }
    if let Some(message) = options.message.as_ref().filter(|message| !message.trim().is_empty()) {
        arguments.push("--message".to_string());
        arguments.push(message.clone());
    }
    arguments.push(source.to_string());
    let arguments: Vec<_> = arguments.iter().map(String::as_str).collect();
    let summary = format!("Merged {source} into {into}.");
    run_worktree_operation(repo_path, &worktree, summary, &arguments, Some(&["merge", "--abort"]))
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn merge_ref(repo_path: String, source: String, into: String, options: MergeOptions) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || merge_into_branch(&repo_path, &source, &into, &options))
        .await
        .map_err(|error| error.to_string())?
}

fn predicted_merge_conflicts(repo_path: &str, source: &str, into: &str) -> Result<ConflictPrediction, String> {
    if let Some(prediction) = merge_tree_unavailable(repo_path) {
        return Ok(prediction);
    }
    let source_sha = resolve_commit(repo_path, source)?;
    let into_sha = resolve_commit(repo_path, into)?;
    if is_ancestor(repo_path, &source_sha, &into_sha) || is_ancestor(repo_path, &into_sha, &source_sha) {
        return Ok(ConflictPrediction::Clean);
    }
    let output = git_result(repo_path, &["merge-tree", "-z", "--write-tree", "--name-only", &into_sha, &source_sha])?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    match output.status.code() {
        Some(0) => Ok(ConflictPrediction::Clean),
        Some(1) => Ok(ConflictPrediction::Conflicts(PredictedConflict {
            commit: source_sha,
            subject: git_output(repo_path, &["log", "-1", "--format=%s", source]).unwrap_or_default(),
            files: parse_merge_tree_output(&stdout)?.1,
        })),
        _ => Ok(ConflictPrediction::Unknown { reason: git_error_message(&output) }),
    }
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn predict_merge_conflicts(repo_path: String, source: String, into: String) -> Result<ConflictPrediction, String> {
    tauri::async_runtime::spawn_blocking(move || predicted_merge_conflicts(&repo_path, &source, &into))
        .await
        .map_err(|error| error.to_string())?
}

// git revert walks a range newest first and undoes each commit against the result of the ones before it,
// so the prediction has to replay that same sequence rather than test the range as one change.
fn predicted_revert_conflicts(repo_path: &str, base: &str, tip: &str) -> Result<ConflictPrediction, String> {
    if let Some(prediction) = merge_tree_unavailable(repo_path) {
        return Ok(prediction);
    }
    let head_sha = resolve_commit(repo_path, "HEAD")?;
    let base_sha = resolve_commit(repo_path, base)?;
    let tip_sha = resolve_commit(repo_path, tip)?;
    let commits = git_output_allow_empty(repo_path, &["rev-list", &format!("{base_sha}..{tip_sha}")])?;
    let mut accumulated = git_output(repo_path, &["rev-parse", "--verify", &format!("{head_sha}^{{tree}}")])
        .ok_or_else(|| "Could not resolve the tree of HEAD.".to_string())?;

    for commit in commits.lines() {
        if git_output(repo_path, &["rev-parse", "--verify", "--quiet", &format!("{commit}^2")]).is_some() {
            return Ok(ConflictPrediction::Unknown {
                reason: format!("{} is a merge commit, and reverting one needs a mainline to keep.", &commit[..8.min(commit.len())]),
            });
        }
        let Some(parent) = git_output(repo_path, &["rev-parse", "--verify", "--quiet", &format!("{commit}^1")]) else {
            return Ok(ConflictPrediction::Unknown { reason: format!("{} has no parent to undo against.", &commit[..8.min(commit.len())]) });
        };
        // Undoing a commit is the change from it back to its parent, so the commit itself is what both sides start from.
        let output = git_result(
            repo_path,
            &[
                "merge-tree",
                "-z",
                "--write-tree",
                "--name-only",
                &format!("--merge-base={commit}"),
                &accumulated,
                &parent,
            ],
        )?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        match output.status.code() {
            Some(0) => accumulated = parse_merge_tree_output(&stdout)?.0,
            Some(1) => {
                return Ok(ConflictPrediction::Conflicts(PredictedConflict {
                    commit: commit.to_string(),
                    subject: git_output(repo_path, &["log", "-1", "--format=%s", commit]).unwrap_or_default(),
                    files: parse_merge_tree_output(&stdout)?.1,
                }))
            }
            _ => return Ok(ConflictPrediction::Unknown { reason: git_error_message(&output) }),
        }
    }

    Ok(ConflictPrediction::Clean)
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn predict_revert_conflicts(repo_path: String, base: String, tip: String) -> Result<ConflictPrediction, String> {
    tauri::async_runtime::spawn_blocking(move || predicted_revert_conflicts(&repo_path, &base, &tip))
        .await
        .map_err(|error| error.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BranchOptions {
    checkout: bool,
    track: bool,
}

fn create_branch_at(repo_path: &str, name: &str, start_point: &str, options: &BranchOptions) -> Result<OperationResult, String> {
    ensure_ref_name(repo_path, "refs/heads/", name)?;
    resolve_commit(repo_path, start_point)?;
    if options.checkout {
        return checkout_reference(
            repo_path,
            start_point,
            &CheckoutOptions { create: Some(name.to_string()), track: options.track, detach: false, stash: false },
        );
    }
    let mut arguments = vec!["branch"];
    if options.track {
        arguments.push("--track");
    }
    arguments.push(name);
    arguments.push(start_point);
    run_worktree_operation(repo_path, repo_path, format!("Created {name} at {start_point}."), &arguments, None)
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn create_branch(repo_path: String, name: String, start_point: String, options: BranchOptions) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || create_branch_at(&repo_path, &name, &start_point, &options))
        .await
        .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn rename_branch(repo_path: String, branch: String, name: String) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_ref_name(&repo_path, "refs/heads/", &name)?;
        run_worktree_operation(
            &repo_path,
            &repo_path,
            format!("Renamed {branch} to {name}."),
            &["branch", "--move", &branch, &name],
            None,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn create_tag(repo_path: String, name: String, target: String, message: Option<String>) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_ref_name(&repo_path, "refs/tags/", &name)?;
        resolve_commit(&repo_path, &target)?;
        let annotation = message.filter(|message| !message.trim().is_empty());
        let mut arguments = vec!["tag"];
        if let Some(message) = &annotation {
            arguments.push("--annotate");
            arguments.push("--message");
            arguments.push(message);
        }
        arguments.push(&name);
        arguments.push(&target);
        run_worktree_operation(&repo_path, &repo_path, format!("Tagged {target} as {name}."), &arguments, None)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn delete_tag(repo_path: String, name: String) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_worktree_operation(&repo_path, &repo_path, format!("Deleted tag {name}."), &["tag", "--delete", &name], None)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn cherry_pick_range(repo_path: String, base: String, tip: String) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let worktree = idle_worktree(&repo_path)?;
        if worktree_is_dirty(&worktree)? {
            return Err("This worktree has uncommitted changes.".to_string());
        }
        let range = format!("{base}..{tip}");
        run_worktree_operation(
            &repo_path,
            &worktree,
            format!("Cherry-picked {range}."),
            &["cherry-pick", &range],
            Some(&["cherry-pick", "--abort"]),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn revert_range(repo_path: String, base: String, tip: String) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let worktree = idle_worktree(&repo_path)?;
        if worktree_is_dirty(&worktree)? {
            return Err("This worktree has uncommitted changes.".to_string());
        }
        let range = format!("{base}..{tip}");
        run_worktree_operation(
            &repo_path,
            &worktree,
            format!("Reverted {range}."),
            &["revert", "--no-edit", &range],
            Some(&["revert", "--abort"]),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn reset_current(repo_path: String, target: String, mode: String) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let worktree = idle_worktree(&repo_path)?;
        let sha = resolve_commit(&repo_path, &target)?;
        let flag = match mode.as_str() {
            "soft" => "--soft",
            "hard" => "--hard",
            _ => "--mixed",
        };
        run_worktree_operation(
            &repo_path,
            &worktree,
            format!("Reset to {}.", &sha[..8.min(sha.len())]),
            &["reset", flag, &sha],
            None,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StashEntry {
    name: String,
    sha: String,
    base: Option<String>,
    message: String,
    branch: Option<String>,
    date: String,
}

fn parse_stash_entries(output: &str) -> Vec<StashEntry> {
    output
        .split('\0')
        .filter(|record| !record.trim().is_empty())
        .filter_map(|record| {
            let mut fields = record.trim_start_matches('\n').split('\u{1f}');
            let name = fields.next()?.to_string();
            let sha = fields.next()?.to_string();
            let subject = fields.next().unwrap_or_default();
            let date = fields.next().unwrap_or_default().to_string();
            // A stash commit records the working tree against the commit it was made from, which is its first parent.
            let base = fields
                .next()
                .and_then(|parents| parents.split_whitespace().next())
                .map(str::to_string);
            // Git writes "WIP on main: 1a2b3c subject" for an automatic message and "On main: text" for a named one.
            let (branch, message) = match subject.split_once(": ") {
                Some((source, message)) => (
                    source
                        .strip_prefix("WIP on ")
                        .or_else(|| source.strip_prefix("On "))
                        .map(str::to_string),
                    message.to_string(),
                ),
                None => (None, subject.to_string()),
            };
            Some(StashEntry { name, sha, base, message, branch, date })
        })
        .collect()
}

#[git_nav_macros::http_command]
#[tauri::command(async)]
fn stash_list(repo_path: String) -> Result<Vec<StashEntry>, String> {
    let output = git_output_allow_empty(
        &repo_path,
        &["stash", "list", "-z", "--format=%gd%x1f%H%x1f%gs%x1f%aI%x1f%P"],
    )?;
    Ok(parse_stash_entries(&output))
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn stash_changes(repo_path: String, message: Option<String>, include_untracked: bool) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let worktree = idle_worktree(&repo_path)?;
        let mut arguments = vec!["stash".to_string(), "push".to_string()];
        if include_untracked {
            arguments.push("--include-untracked".to_string());
        }
        if let Some(message) = message.as_ref().filter(|message| !message.trim().is_empty()) {
            arguments.push("--message".to_string());
            arguments.push(message.clone());
        }
        let arguments: Vec<_> = arguments.iter().map(String::as_str).collect();
        run_worktree_operation(&repo_path, &worktree, "Stashed the uncommitted changes.".to_string(), &arguments, None)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
async fn stash_action(repo_path: String, name: String, sha: String, action: String) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let worktree = idle_worktree(&repo_path)?;
        // The reflog selector shifts as entries come and go, so the sha the menu was built from has to still be there.
        if resolve_commit(&repo_path, &name)? != sha {
            return Err("The stash list changed. Refresh and try again.".to_string());
        }
        let (verb, summary) = match action.as_str() {
            "pop" => ("pop", format!("Restored {name} and removed it from the stash.")),
            "drop" => ("drop", format!("Dropped {name}.")),
            _ => ("apply", format!("Applied {name}.")),
        };
        run_worktree_operation(&repo_path, &worktree, summary, &["stash", verb, &name], None)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_fullscreen_states_match_persisted_window_state() {
        let states = parse_initial_fullscreen_states(
            br#"{
                "main": {
                    "width": 1280,
                    "height": 800,
                    "x": 10,
                    "y": 20,
                    "prev_x": 10,
                    "prev_y": 20,
                    "maximized": false,
                    "visible": false,
                    "decorated": true,
                    "fullscreen": false
                },
                "repository-1": {
                    "width": 1280,
                    "height": 800,
                    "x": 30,
                    "y": 40,
                    "prev_x": 30,
                    "prev_y": 40,
                    "maximized": false,
                    "visible": false,
                    "decorated": true,
                    "fullscreen": true
                }
            }"#,
        );

        assert_eq!(states.get("main"), Some(&false));
        assert_eq!(states.get("repository-1"), Some(&true));
    }

    #[test]
    fn malformed_window_state_defaults_to_normal_launch() {
        assert!(
            parse_initial_fullscreen_states(br#"{"main":{"fullscreen":true}"#).is_empty()
        );
    }

    #[test]
    fn fullscreen_initialization_script_reflects_state_at_window_creation() {
        let plugin = MacOSWindowChromePlugin::new(HashMap::from([(
            "repository-1".to_string(),
            false,
        )]));
        let first_script = plugin.initialization_script();

        plugin
            .fullscreen_states
            .lock()
            .unwrap()
            .insert("repository-1".to_string(), true);
        let recreated_script = plugin.initialization_script();

        assert!(first_script.contains("\"repository-1\":false"));
        assert!(recreated_script.starts_with("(() => { const states = "));
        assert!(recreated_script.ends_with(" })();"));
        assert!(recreated_script.contains("\"repository-1\":true"));
    }

    #[test]
    fn recent_paths_move_to_the_front_and_stay_bounded() {
        let paths = (0..MAX_RECENT_REPOSITORIES)
            .map(|index| format!("/repo/{index}"))
            .collect();
        let paths = updated_recent_paths(paths, "/repo/4");
        assert_eq!(paths[0], "/repo/4");
        assert_eq!(paths.len(), MAX_RECENT_REPOSITORIES);
        assert_eq!(paths.iter().filter(|path| *path == "/repo/4").count(), 1);

        let paths = updated_recent_paths(paths, "/repo/new");
        assert_eq!(paths[0], "/repo/new");
        assert_eq!(paths.len(), MAX_RECENT_REPOSITORIES);
        assert!(!paths.iter().any(|path| path == "/repo/7"));
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

    fn joined_paths<const N: usize>(paths: [&str; N]) -> OsString {
        env::join_paths(paths).unwrap()
    }

    #[test]
    fn preserves_malformed_settings_before_starting_a_new_store() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            env::temp_dir().join(format!("git-nav-settings-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("settings.json");
        fs::write(&path, "{malformed").unwrap();

        save_setting_at(&path, "new-key".to_string(), serde_json::json!(true)).unwrap();

        let settings = match read_settings(&path).unwrap() {
            StoredSettings::Valid(settings) => settings,
            StoredSettings::Malformed => panic!("new settings store is malformed"),
        };
        assert_eq!(settings.get("new-key"), Some(&serde_json::json!(true)));
        let backups = fs::read_dir(&directory)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("settings.invalid-")
            })
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read_to_string(backups[0].path()).unwrap(), "{malformed");

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn keeps_a_saved_setting_when_the_notification_fails() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            env::temp_dir().join(format!("git-nav-settings-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("settings.json");

        save_setting_at_then(&path, "new-key".to_string(), serde_json::json!(true), || {
            Err("could not notify".to_string())
        })
        .unwrap();

        let settings = match read_settings(&path).unwrap() {
            StoredSettings::Valid(settings) => settings,
            StoredSettings::Malformed => panic!("new settings store is malformed"),
        };
        assert_eq!(settings.get("new-key"), Some(&serde_json::json!(true)));

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn stores_repository_layouts_by_client_and_worktree() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            env::temp_dir().join(format!("git-nav-layouts-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("repository-layouts.json");
        let desktop_layout = serde_json::json!({ "version": 1, "layout": {} });
        let browser_layout = serde_json::json!({ "version": 2 });

        write_repository_layout_at(
            &path,
            "/repositories/one".to_string(),
            "desktop".to_string(),
            desktop_layout.clone(),
        )
        .unwrap();
        write_repository_layout_at(
            &path,
            "/repositories/one".to_string(),
            "browser".to_string(),
            browser_layout.clone(),
        )
        .unwrap();

        let layouts: RepositoryLayouts = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            layouts.get("desktop").and_then(|entries| entries.get("/repositories/one")),
            Some(&desktop_layout)
        );
        assert_eq!(
            layouts.get("browser").and_then(|entries| entries.get("/repositories/one")),
            Some(&browser_layout)
        );

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn normalizes_repository_layout_paths_before_saving() {
        let (repository, _) = scratch_repository("layout-path");
        let directory = PathBuf::from(&repository);
        let storage_path = directory.join("repository-layouts.json");
        let subdirectory = directory.join("src");
        fs::create_dir_all(&subdirectory).unwrap();
        let layout = serde_json::json!({ "version": 1 });

        save_repository_layout_at(
            &storage_path,
            subdirectory.to_string_lossy().into_owned(),
            "browser".to_string(),
            layout.clone(),
        )
        .unwrap();

        let layouts: RepositoryLayouts =
            serde_json::from_str(&fs::read_to_string(storage_path).unwrap()).unwrap();
        let worktree = worktree_path(&repository).unwrap();
        assert_eq!(
            layouts
                .get("browser")
                .and_then(|entries| entries.get(&worktree)),
            Some(&layout)
        );

        remove_scratch_repository(&repository);
    }

    #[test]
    fn preserves_malformed_repository_layouts_before_starting_a_new_store() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = env::temp_dir().join(format!(
            "git-nav-layouts-malformed-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("repository-layouts.json");
        fs::write(&path, "{malformed").unwrap();
        let layout = serde_json::json!({ "version": 1 });

        write_repository_layout_at(
            &path,
            "/repositories/one".to_string(),
            "desktop".to_string(),
            layout.clone(),
        )
        .unwrap();

        let layouts: RepositoryLayouts =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            layouts
                .get("desktop")
                .and_then(|entries| entries.get("/repositories/one")),
            Some(&layout)
        );
        let backups = fs::read_dir(&directory)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("repository-layouts.invalid-")
            })
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read_to_string(backups[0].path()).unwrap(), "{malformed");

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn removes_mounted_appimage_paths_and_preserves_original_values() {
        let app_dir = Path::new("/tmp/.mount_gitnav");
        let value = joined_paths([
            "/tmp/.mount_gitnav/usr/bin",
            "/tmp/.mount_gitnav/usr/lib",
            "/home/user/bin",
            "/usr/local/bin",
            "/usr/bin",
        ]);

        assert_eq!(
            sanitized_appimage_path_list(&value, app_dir),
            Some(joined_paths(["/home/user/bin", "/usr/local/bin", "/usr/bin"]))
        );
    }

    #[test]
    fn removes_extracted_appimage_paths_wherever_apprun_inserted_them() {
        let app_dir = Path::new("/tmp/appimage_extracted_1234");
        let value = joined_paths([
            "/tmp/appimage_extracted_1234/usr/share",
            "/usr/share",
            "/tmp/appimage_extracted_1234/usr/share/",
            "/custom/share",
        ]);

        assert_eq!(
            sanitized_appimage_path_list(&value, app_dir),
            Some(joined_paths(["/usr/share", "/custom/share"]))
        );
    }

    #[test]
    fn removes_an_appimage_only_environment_value() {
        assert_eq!(
            sanitized_appimage_path_list(
                OsStr::new("/tmp/.mount_gitnav/usr/share/glib-2.0/schemas"),
                Path::new("/tmp/.mount_gitnav"),
            ),
            None
        );
    }

    #[test]
    fn preserves_paths_outside_the_exact_appimage_root() {
        let value = joined_paths(["/tmp/.mount_gitnav-tools/bin", "/tmp/.mount_gitnav/usr/bin"]);

        assert_eq!(
            sanitized_appimage_path_list(&value, Path::new("/tmp/.mount_gitnav")),
            Some(OsString::from("/tmp/.mount_gitnav-tools/bin"))
        );
    }

    #[test]
    fn applies_sanitization_to_every_external_command_environment_variable() {
        let app_dir = Path::new("/tmp/.mount_gitnav");
        let mut command = Command::new("git");
        apply_appimage_environment(&mut command, app_dir, |_| {
            Some(joined_paths(["/tmp/.mount_gitnav/usr/lib", "/original/value"]))
        });
        let changes: HashMap<_, _> = command
            .get_envs()
            .map(|(name, value)| (name.to_string_lossy().into_owned(), value.map(OsStr::to_os_string)))
            .collect();

        for name in APPIMAGE_PATH_ENVIRONMENT {
            assert_eq!(changes.get(name), Some(&Some(OsString::from("/original/value"))));
        }
    }

    #[test]
    fn constructs_macos_worktree_commands() {
        assert_eq!(
            macos_worktree_command("/workspace/git-nav", "vscode"),
            Ok(DesktopCommand::new(
                "open",
                vec![
                    "-a".to_string(),
                    "Visual Studio Code".to_string(),
                    "/workspace/git-nav".to_string(),
                ],
            ))
        );
    }

    #[test]
    fn constructs_linux_worktree_commands() {
        let commands = linux_worktree_commands("/workspace/git-nav", "terminal").unwrap();

        assert_eq!(
            commands.first(),
            Some(&DesktopCommand::new(
                "xdg-terminal-exec",
                vec!["--dir=/workspace/git-nav".to_string()],
            ))
        );
        assert!(commands.iter().skip(1).all(|command| {
            command.arguments.is_empty()
                && command.current_dir.as_deref() == Some("/workspace/git-nav")
        }));
    }

    #[test]
    fn constructs_linux_url_commands() {
        assert_eq!(
            linux_url_command("https://github.com/sangonz193/git-nav".to_string()),
            DesktopCommand::new(
                "xdg-open",
                vec!["https://github.com/sangonz193/git-nav".to_string()],
            )
        );
    }

    #[test]
    fn constructs_windows_worktree_commands() {
        let path = "C:\\workspace\\git-nav";

        assert_eq!(
            windows_worktree_commands(path, "vscode"),
            Ok(vec![DesktopCommand::hidden("code.cmd", vec![path.to_string()])])
        );
        assert_eq!(
            windows_worktree_commands(path, "finder"),
            Ok(vec![DesktopCommand::new("explorer.exe", vec![path.to_string()])])
        );
        assert_eq!(
            windows_worktree_commands(path, "terminal"),
            Ok(vec![
                DesktopCommand::new("wt.exe", vec!["-d".to_string(), path.to_string()]),
                DesktopCommand::in_directory("powershell.exe", path),
                DesktopCommand::in_directory("cmd.exe", path),
            ])
        );
    }

    #[test]
    fn constructs_windows_url_commands() {
        assert_eq!(
            windows_url_command("https://github.com/sangonz193/git-nav".to_string()),
            DesktopCommand::new(
                "explorer.exe",
                vec!["https://github.com/sangonz193/git-nav".to_string()],
            )
        );
    }

    #[test]
    fn only_accepts_https_urls() {
        assert!(is_https_url("https://github.com/sangonz193/git-nav"));
        assert!(!is_https_url("http://github.com/sangonz193/git-nav"));
        assert!(!is_https_url("file:///workspace/git-nav"));
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

    #[test]
    fn reads_annotated_tags_through_their_dereference_and_drops_remote_heads() {
        let references = parse_references(&[
            "refs/heads/main\0main\0branch-sha\0\0Ship it\0\02026-08-29T12:00:00+00:00",
            "refs/remotes/origin/HEAD\0origin\0branch-sha\0\0Ship it\0\02026-08-29T12:00:00+00:00",
            "refs/remotes/origin/main\0origin/main\0branch-sha\0\0Ship it\0\02026-08-29T12:00:00+00:00",
            "refs/tags/v1\0v1\0tag-sha\0commit-sha\0Tag message\0Tagged commit\02026-08-28T12:00:00+00:00",
        ]
        .join("\n"));

        let described: Vec<_> = references
            .iter()
            .map(|reference| (reference.kind.as_str(), reference.name.as_str(), reference.sha.as_str(), reference.subject.as_str()))
            .collect();
        assert_eq!(
            described,
            vec![
                ("branch", "main", "branch-sha", "Ship it"),
                ("remote", "origin/main", "branch-sha", "Ship it"),
                ("tag", "v1", "commit-sha", "Tagged commit"),
            ]
        );
    }

    #[test]
    fn parses_main_and_linked_worktrees_from_porcelain_output() {
        let worktrees = parse_worktree_records(
            "worktree /workspace/project\0HEAD main-sha\0branch refs/heads/main\0\0worktree /workspace/fix\0HEAD fix-sha\0branch refs/heads/fix\0locked\0\0worktree /workspace/old\0HEAD old-sha\0detached\0prunable missing\0\0",
        );

        assert_eq!(worktrees.len(), 3);
        assert!(worktrees[0].is_main);
        assert_eq!(worktrees[0].branch, "main");
        assert_eq!(worktrees[1].branch, "fix");
        assert!(worktrees[1].is_locked);
        assert!(worktrees[2].is_detached);
        assert!(worktrees[2].is_prunable);
        assert_eq!(worktrees[2].branch, "Detached HEAD");
    }

    #[test]
    fn reads_the_upstream_state_of_each_branch() {
        let branches = parse_branch_sync(concat!(
            "ahead\0origin/ahead\0ahead 1, behind 2\n",
            "gone\0origin/gone\0gone\n",
            "synced\0origin/synced\0\n",
            "local\0\0",
        ));

        assert_eq!(branches.len(), 4);
        assert_eq!(branches[0].upstream.as_deref(), Some("origin/ahead"));
        assert_eq!((branches[0].ahead, branches[0].behind), (1, 2));
        assert!(!branches[0].is_gone);
        assert!(branches[1].is_gone);
        assert_eq!((branches[2].ahead, branches[2].behind), (0, 0));
        assert!(!branches[2].is_gone);
        assert_eq!(branches[3].upstream, None);
        assert!(!branches[3].is_gone);
    }

    #[test]
    fn counts_tracked_and_untracked_changes_separately() {
        let (changed, untracked) = parse_status_counts(concat!(
            "# branch.oid 0000\n",
            "1 MM N... 100644 100644 100644 aaa bbb changed.txt\n",
            "2 R. N... 100644 100644 100644 ccc ddd R100 new.txt\told.txt\n",
            "u UU N... 100644 100644 100644 100644 eee fff ggg conflicted.txt\n",
            "? untracked.txt\n",
            "? directory/\n",
            "! ignored.txt\n",
        ));

        assert_eq!((changed, untracked), (3, 2));
    }

    #[test]
    fn counts_the_rows_each_file_of_a_patch_renders() {
        let stats = parse_patch_stats(concat!(
            "diff --git a/src/main.rs b/src/main.rs\n",
            "--- a/src/main.rs\n",
            "+++ b/src/main.rs\n",
            "@@ -1,5 +1,5 @@\n",
            " context\n",
            "-old one\n",
            "-old two\n",
            "+new one\n",
            " context\n",
            "@@ -20,3 +20,4 @@\n",
            " context\n",
            "+added\n",
            "diff --git a/logo.png b/logo.png\n",
            "Binary files a/logo.png and b/logo.png differ\n",
        ));

        assert_eq!(stats.len(), 2);
        assert_eq!(stats[0].additions, 2);
        assert_eq!(stats[0].deletions, 2);
        // Three context rows, a paired two-for-one replacement, and a lone addition.
        assert_eq!(stats[0].split_rows, 6);
        assert_eq!(stats[0].unified_rows, 7);
        assert_eq!(stats[0].hunk_rows, 3);
        assert!(stats[1].is_binary);
        assert_eq!(stats[1].hunk_rows, 0);
    }

    #[test]
    fn parses_github_remote_urls() {
        assert_eq!(
            github_repository("git@github.com:octocat/hello-world.git"),
            Some(("github.com".to_string(), "octocat/hello-world".to_string()))
        );
        assert_eq!(
            github_repository("https://github.com/octocat/hello-world.git"),
            Some(("github.com".to_string(), "octocat/hello-world".to_string()))
        );
    }

    #[test]
    fn reads_the_blob_each_side_of_a_changed_file_is() {
        let raw = b":100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 M\0src/main.rs\0:000000 100644 0000000000000000000000000000000000000000 3333333333333333333333333333333333333333 A\0src/new.rs\0:100644 100644 4444444444444444444444444444444444444444 5555555555555555555555555555555555555555 R100\0src/old.rs\0src/renamed.rs\0";

        let files = parse_changed_files(raw, "", None).unwrap();

        assert_eq!(files.len(), 3);
        assert_eq!(files[0].status, "modified");
        assert_eq!(files[0].old_oid.as_deref(), Some("1".repeat(40).as_str()));
        assert_eq!(files[0].new_oid.as_deref(), Some("2".repeat(40).as_str()));
        assert_eq!(files[1].status, "added");
        assert_eq!(files[1].old_oid, None);
        assert_eq!(files[1].new_path.as_deref(), Some("src/new.rs"));
        assert_eq!(files[2].status, "renamed");
        assert_eq!(files[2].old_path.as_deref(), Some("src/old.rs"));
        assert_eq!(files[2].new_path.as_deref(), Some("src/renamed.rs"));
        assert_eq!(files[2].new_oid.as_deref(), Some("5".repeat(40).as_str()));
    }

    #[test]
    fn keeps_a_viewed_mark_against_the_blob_it_was_made_at() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate_viewed_files_database(&mut connection).unwrap();

        write_viewed_file(&connection, "project", "main", "feature", false, "src/main.rs", "abc", true).unwrap();
        write_viewed_file(&connection, "project", "main", "other", false, "src/main.rs", "def", true).unwrap();

        let marks = read_viewed_files(&connection, "project", "main", "feature", false).unwrap();
        assert_eq!(marks.len(), 1);
        assert_eq!(marks[0].path, "src/main.rs");
        assert_eq!(marks[0].identity, "abc");

        write_viewed_file(&connection, "project", "main", "feature", false, "src/main.rs", "abc", false).unwrap();
        assert!(read_viewed_files(&connection, "project", "main", "feature", false).unwrap().is_empty());
    }

    // Both ranges end at the same commit, so a file reads as the same blob in each one and only the
    // range they were made in tells the marks apart.
    #[test]
    fn keeps_a_viewed_mark_within_the_range_it_was_made_in() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate_viewed_files_database(&mut connection).unwrap();

        write_viewed_file(&connection, "project", "main", "feature", false, "src/main.rs", "abc", true).unwrap();

        assert!(read_viewed_files(&connection, "project", "main", "feature", true).unwrap().is_empty());
        let direct = read_viewed_files(&connection, "project", "main", "feature", false).unwrap();
        assert_eq!(direct.len(), 1);
        assert_eq!(direct[0].identity, "abc");

        write_viewed_file(&connection, "project", "main", "feature", true, "src/main.rs", "abc", true).unwrap();
        write_viewed_file(&connection, "project", "main", "feature", true, "src/main.rs", "abc", false).unwrap();
        assert_eq!(read_viewed_files(&connection, "project", "main", "feature", false).unwrap().len(), 1);
    }

    #[test]
    fn retires_marks_taken_against_a_single_blob() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
                CREATE TABLE viewed_files (
                  project_id TEXT NOT NULL,
                  base_ref TEXT NOT NULL,
                  head_ref TEXT NOT NULL,
                  merge_base INTEGER NOT NULL,
                  path TEXT NOT NULL,
                  oid TEXT NOT NULL,
                  viewed_at INTEGER NOT NULL,
                  PRIMARY KEY (project_id, base_ref, head_ref, merge_base, path)
                );
                INSERT INTO schema_migrations (version) VALUES (2);
                INSERT INTO viewed_files VALUES ('project', 'main', 'feature', 0, 'src/main.rs', 'abc', 1);
                ",
            )
            .unwrap();

        migrate_viewed_files_database(&mut connection).unwrap();

        assert!(read_viewed_files(&connection, "project", "main", "feature", false).unwrap().is_empty());
        write_viewed_file(&connection, "project", "main", "feature", false, "src/main.rs", "abc:def", true).unwrap();
        let marks = read_viewed_files(&connection, "project", "main", "feature", false).unwrap();
        assert_eq!(marks[0].identity, "abc:def");
    }

    #[test]
    fn keeps_recent_viewed_comparisons_per_project() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate_viewed_files_database(&mut connection).unwrap();
        for index in 0..VIEWED_COMPARISON_LIMIT + 5 {
            connection
                .execute(
                    "INSERT INTO viewed_files (project_id, base_ref, head_ref, merge_base, path, identity, viewed_at) VALUES ('project', 'main', ?1, 0, 'src/main.rs', 'abc', ?2)",
                    params![index.to_string(), index],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO viewed_files (project_id, base_ref, head_ref, merge_base, path, identity, viewed_at) VALUES ('other-project', 'main', 'old', 0, 'src/main.rs', 'abc', 0)",
                [],
            )
            .unwrap();

        prune_viewed_comparisons(&connection, "project").unwrap();

        let comparisons = connection
            .query_row(
                "SELECT COUNT(DISTINCT head_ref) FROM viewed_files WHERE project_id = 'project'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(comparisons, VIEWED_COMPARISON_LIMIT);
        let oldest = connection
            .query_row(
                "SELECT MIN(viewed_at) FROM viewed_files WHERE project_id = 'project'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(oldest, 5);
        let other_project = connection
            .query_row(
                "SELECT COUNT(*) FROM viewed_files WHERE project_id = 'other-project'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(other_project, 1);
    }

    #[test]
    fn migrates_pull_request_database() {
        let mut connection = Connection::open_in_memory().unwrap();

        migrate_pull_request_database(&mut connection).unwrap();

        let version = connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get::<_, i64>(0))
            .unwrap();
        assert_eq!(version, 2);
        connection
            .execute(
                "INSERT INTO pull_requests (host, repository, number, head_sha, head_ref, state, title, is_draft, updated_at) VALUES ('github.com', 'octocat/hello-world', 1, 'abc', 'feature', 'open', 'A title', 0, '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
    }

    #[test]
    fn reads_the_branch_and_the_fork_a_pull_request_was_raised_from() {
        let payload = r#"[{"number":7,"title":"A title","state":"open","draft":true,"merged_at":null,"merge_commit_sha":null,"updated_at":"2026-01-01T00:00:00Z","head":{"ref":"feature","sha":"abc","repo":{"full_name":"someone/hello-world"}}}]"#;

        let pull_requests: Vec<GithubPullRequest> = serde_json::from_str(payload).unwrap();

        assert_eq!(pull_requests[0].head.reference, "feature");
        assert_eq!(pull_requests[0].head.repo.as_ref().map(|repo| repo.full_name.as_str()), Some("someone/hello-world"));
        assert!(pull_requests[0].draft);
    }

    #[test]
    fn marks_a_branch_with_the_pull_request_that_is_still_open() {
        let rows = vec![
            ("feature".to_string(), 1, "closed".to_string(), false, Some("2026-01-01T00:00:00Z".to_string()), "Merged".to_string()),
            ("feature".to_string(), 2, "open".to_string(), true, None, "Draft".to_string()),
            ("feature".to_string(), 3, "closed".to_string(), false, None, "Abandoned".to_string()),
        ];

        let pull_requests = rank_branch_pull_requests("github.com", "octocat/hello-world", rows);

        assert_eq!(
            pull_requests,
            vec![BranchPullRequest {
                branch: "feature".to_string(),
                number: 2,
                state: "draft".to_string(),
                title: "Draft".to_string(),
                url: "https://github.com/octocat/hello-world/pull/2".to_string(),
            }]
        );
    }

    #[test]
    fn falls_back_to_the_newest_merged_pull_request_of_a_branch() {
        let rows = vec![
            ("feature".to_string(), 4, "closed".to_string(), false, Some("2026-01-01T00:00:00Z".to_string()), "First".to_string()),
            ("feature".to_string(), 7, "closed".to_string(), false, Some("2026-02-01T00:00:00Z".to_string()), "Second".to_string()),
            ("feature".to_string(), 9, "closed".to_string(), false, None, "Closed".to_string()),
        ];

        let pull_requests = rank_branch_pull_requests("github.com", "octocat/hello-world", rows);

        assert_eq!(pull_requests[0].number, 7);
        assert_eq!(pull_requests[0].state, "merged");
    }

    #[test]
    fn assigns_a_lane_and_reuses_it_for_the_first_parent() {
        let mut lanes = Vec::new();
        let commit =
            parse_commit("a\0b\0Ada\02026-01-01T00:00:00+00:00\0\0first", &mut lanes, &mut None).unwrap();

        assert_eq!(commit[6], 0);
        assert_eq!(commit[7], serde_json::json!([0]));
        assert_eq!(lanes, vec![Some("b".to_string())]);
    }

    #[test]
    fn assigns_additional_parents_to_separate_lanes() {
        let mut lanes = Vec::new();
        let commit = parse_commit(
            "a\0b c\0Ada\02026-01-01T00:00:00+00:00\0\0merge",
            &mut lanes,
            &mut None,
        )
        .unwrap();

        assert_eq!(commit[6], 0);
        assert_eq!(commit[7], serde_json::json!([0, 1]));
        assert_eq!(commit[9], serde_json::json!([]));
        assert_eq!(commit[10], serde_json::json!([true, true]));
        assert_eq!(lanes, vec![Some("b".to_string()), Some("c".to_string())]);
    }

    #[test]
    fn frees_root_lanes() {
        let mut lanes = vec![Some("a".to_string())];
        let commit =
            parse_commit("a\0\0Ada\02026-01-01T00:00:00+00:00\0\0root", &mut lanes, &mut None).unwrap();

        assert_eq!(commit[8], 0);
        assert_eq!(commit[9], serde_json::json!([0]));
        assert_eq!(commit[10], serde_json::json!([]));
        assert!(lanes.is_empty());
    }

    #[test]
    fn frees_duplicate_lanes_after_a_commit_is_seen() {
        let mut lanes = vec![Some("a".to_string()), Some("a".to_string())];
        parse_commit("a\0b\0Ada\02026-01-01T00:00:00+00:00\0\0commit", &mut lanes, &mut None).unwrap();

        assert_eq!(lanes, vec![Some("b".to_string())]);
    }

    #[test]
    fn reserves_the_first_lane_for_the_default_branch_tip() {
        let mut lanes = Vec::new();
        let mut reserved_tip = Some("main".to_string());

        let feature = parse_commit(
            "feature\0feature-parent\0Ada\02026-01-01T00:00:00+00:00\0\0feature",
            &mut lanes,
            &mut reserved_tip,
        )
        .unwrap();

        assert_eq!(feature[6], 1);
        assert_eq!(feature[7], serde_json::json!([1]));
        assert_eq!(feature[8], 2);
        assert_eq!(feature[10], serde_json::json!([false, true]));

        let tip = parse_commit(
            "main\0main-parent\0Ada\02026-01-01T00:00:00+00:00\0\0tip",
            &mut lanes,
            &mut reserved_tip,
        )
        .unwrap();

        assert_eq!(tip[6], 0);
        assert_eq!(tip[7], serde_json::json!([0]));
        assert_eq!(tip[9], serde_json::json!([]));
        assert_eq!(reserved_tip, None);
        assert_eq!(
            lanes,
            vec![Some("main-parent".to_string()), Some("feature-parent".to_string())]
        );
    }

    #[test]
    fn moves_the_default_branch_tip_out_of_the_lane_waiting_for_it() {
        let mut lanes = Vec::new();
        let mut reserved_tip = Some("main".to_string());
        parse_commit(
            "feature\0main\0Ada\02026-01-01T00:00:00+00:00\0\0feature",
            &mut lanes,
            &mut reserved_tip,
        )
        .unwrap();

        let tip = parse_commit(
            "main\0main-parent\0Ada\02026-01-01T00:00:00+00:00\0\0tip",
            &mut lanes,
            &mut reserved_tip,
        )
        .unwrap();

        assert_eq!(tip[6], 0);
        assert_eq!(tip[9], serde_json::json!([1]));
        assert_eq!(lanes, vec![Some("main-parent".to_string())]);
    }

    #[test]
    fn keeps_the_first_lane_empty_while_the_default_branch_tip_is_missing() {
        let mut lanes = Vec::new();
        let mut reserved_tip = Some("main".to_string());

        let root = parse_commit(
            "feature\0\0Ada\02026-01-01T00:00:00+00:00\0\0root",
            &mut lanes,
            &mut reserved_tip,
        )
        .unwrap();

        assert_eq!(root[6], 1);
        assert_eq!(root[10], serde_json::json!([]));
        assert_eq!(reserved_tip.as_deref(), Some("main"));
        assert!(lanes.is_empty());
    }

    #[test]
    fn uses_the_first_lane_without_a_default_branch_tip() {
        let mut lanes = Vec::new();
        let mut reserved_tip = None;

        let commit = parse_commit(
            "feature\0feature-parent\0Ada\02026-01-01T00:00:00+00:00\0\0feature",
            &mut lanes,
            &mut reserved_tip,
        )
        .unwrap();

        assert_eq!(commit[6], 0);
        assert_eq!(commit[8], 1);
        assert_eq!(lanes, vec![Some("feature-parent".to_string())]);
    }

    #[test]
    fn reads_the_major_and_minor_git_version() {
        assert_eq!(parse_git_version("git version 2.50.1 (Apple Git-155)"), Some((2, 50)));
        assert_eq!(parse_git_version("git version 2.39.5"), Some((2, 39)));
        assert_eq!(parse_git_version("not git"), None);
    }

    #[test]
    fn reads_the_written_tree_from_a_clean_merge() {
        let (tree, files) = parse_merge_tree_output("tree-sha\0").unwrap();

        assert_eq!(tree, "tree-sha");
        assert!(files.is_empty());
    }

    #[test]
    fn reads_conflicted_paths_before_the_informational_messages() {
        let (tree, files) =
            parse_merge_tree_output("tree-sha\0a.txt\0b.txt\0\01\0a.txt\0CONFLICT (contents)\0message\0").unwrap();

        assert_eq!(tree, "tree-sha");
        assert_eq!(files, vec!["a.txt".to_string(), "b.txt".to_string()]);
    }

    #[test]
    fn reports_the_refs_an_operation_moved_created_and_deleted() {
        let before = parse_ref_shas("refs/heads/main\0aaa\nrefs/heads/topic\0bbb\nrefs/heads/other\0ccc");
        let after = parse_ref_shas("refs/heads/main\0aaa\nrefs/heads/topic\0ddd\nrefs/tags/v1\0eee");

        let updates = changed_refs(&before, &after);

        assert_eq!(updates.len(), 3);
        assert_eq!(updates[0].reference, "refs/heads/other");
        assert_eq!((updates[0].before.as_str(), updates[0].after.as_str()), ("ccc", ""));
        assert_eq!(updates[1].reference, "refs/heads/topic");
        assert_eq!((updates[1].before.as_str(), updates[1].after.as_str()), ("bbb", "ddd"));
        assert_eq!(updates[2].reference, "refs/tags/v1");
        assert_eq!((updates[2].before.as_str(), updates[2].after.as_str()), ("", "eee"));
    }

    #[test]
    fn reads_the_branch_and_message_of_each_stash_entry() {
        let entries = parse_stash_entries(concat!(
            "stash@{0}\u{1f}aaa\u{1f}WIP on main: 1a2b3c4 last commit\u{1f}2026-01-01T00:00:00+00:00\0",
            "stash@{1}\u{1f}bbb\u{1f}On feature: named work\u{1f}2026-01-02T00:00:00+00:00\0",
        ));

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "stash@{0}");
        assert_eq!(entries[0].sha, "aaa");
        assert_eq!(entries[0].branch.as_deref(), Some("main"));
        assert_eq!(entries[0].message, "1a2b3c4 last commit");
        assert_eq!(entries[1].branch.as_deref(), Some("feature"));
        assert_eq!(entries[1].message, "named work");
    }

    #[test]
    fn changes_the_fingerprint_only_when_a_ref_moves() {
        let path = env::temp_dir()
            .join(format!("git-nav-fingerprint-{}", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        let run = |arguments: &[&str]| {
            let output = git_result(&path, arguments).unwrap();
            assert!(output.status.success(), "{arguments:?}: {}", String::from_utf8_lossy(&output.stderr));
        };
        let write = |name: &str, contents: &str| fs::write(Path::new(&path).join(name), contents).unwrap();
        run(&["init", "--quiet", "--initial-branch=main"]);
        run(&["config", "user.email", "tests@example.com"]);
        run(&["config", "user.name", "Tests"]);
        run(&["config", "commit.gpgsign", "false"]);
        write("tracked.txt", "base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);

        let initial = repository_fingerprint(path.clone());
        let repeated = repository_fingerprint(path.clone());
        write("tracked.txt", "changed\n");
        let edited = repository_fingerprint(path.clone());
        run(&["commit", "--quiet", "--all", "--message", "change"]);
        let committed = repository_fingerprint(path.clone());
        run(&["branch", "feature"]);
        let branched = repository_fingerprint(path.clone());
        run(&["checkout", "--quiet", "feature"]);
        let checked_out = repository_fingerprint(path.clone());
        fs::remove_dir_all(&path).unwrap();

        assert_eq!(initial, repeated);
        assert_eq!(initial, edited);
        assert_ne!(initial, committed);
        assert_ne!(committed, branched);
        // The branch points at the commit HEAD already sat on, so only the symbolic ref moved.
        assert_ne!(branched, checked_out);
    }

    #[test]
    fn finds_the_commit_a_branch_was_squashed_into() {
        let path = env::temp_dir()
            .join(format!("git-nav-squash-{}", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        let run = |arguments: &[&str]| {
            let output = git_result(&path, arguments).unwrap();
            assert!(output.status.success(), "{arguments:?}: {}", String::from_utf8_lossy(&output.stderr));
        };
        let write = |name: &str, contents: &str| fs::write(Path::new(&path).join(name), contents).unwrap();
        let sha = |reference: &str| git_output(&path, &["rev-parse", reference]).unwrap();
        run(&["init", "--quiet", "--initial-branch=main"]);
        run(&["config", "user.email", "tests@example.com"]);
        run(&["config", "user.name", "Tests"]);
        run(&["config", "commit.gpgsign", "false"]);
        write("shared.txt", "base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);

        // Squashed straight onto the branch point, so the trees match.
        run(&["checkout", "--quiet", "-b", "onto-tip"]);
        write("onto-tip.txt", "one\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "first"]);
        write("onto-tip.txt", "one\ntwo\n");
        run(&["commit", "--quiet", "--all", "--message", "second"]);
        let onto_tip = sha("HEAD");
        run(&["checkout", "--quiet", "main"]);
        run(&["merge", "--quiet", "--squash", "onto-tip"]);
        run(&["commit", "--quiet", "--message", "Merge branch 'onto-tip'"]);
        let onto_tip_target = sha("HEAD");

        // Squashed after main moved on, so only the net change still matches.
        run(&["checkout", "--quiet", "-b", "after-drift", &onto_tip_target]);
        write("after-drift.txt", "alpha\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "drifting work"]);
        let after_drift = sha("HEAD");
        run(&["checkout", "--quiet", "main"]);
        write("unrelated.txt", "meanwhile\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "unrelated work on main"]);
        run(&["merge", "--quiet", "--squash", "after-drift"]);
        run(&["commit", "--quiet", "--message", "Merge branch 'after-drift'"]);
        let after_drift_target = sha("HEAD");

        // Genuinely unmerged, and must not be paired with anything.
        run(&["checkout", "--quiet", "-b", "still-open", "main"]);
        write("still-open.txt", "wip\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "work in progress"]);
        let still_open = sha("HEAD");
        run(&["checkout", "--quiet", "main"]);

        let edges: HashMap<_, _> = local_squash_merges(&path).into_iter().collect();
        fs::remove_dir_all(&path).unwrap();

        assert_eq!(edges.get(&onto_tip), Some(&onto_tip_target), "tree match failed");
        assert_eq!(edges.get(&after_drift), Some(&after_drift_target), "patch id fallback failed");
        assert!(!edges.contains_key(&still_open));
    }

    #[test]
    fn offers_a_squash_merged_branch_for_cleanup_without_a_pull_request() {
        let path = env::temp_dir()
            .join(format!("git-nav-squash-cleanup-{}", std::process::id()))
            .to_string_lossy()
            .to_string();
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        let run = |arguments: &[&str]| {
            let output = git_result(&path, arguments).unwrap();
            assert!(output.status.success(), "{arguments:?}: {}", String::from_utf8_lossy(&output.stderr));
        };
        let write = |name: &str, contents: &str| fs::write(Path::new(&path).join(name), contents).unwrap();
        run(&["init", "--quiet", "--initial-branch=main"]);
        run(&["config", "user.email", "tests@example.com"]);
        run(&["config", "user.name", "Tests"]);
        run(&["config", "commit.gpgsign", "false"]);
        write("shared.txt", "base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);

        for branch in ["squashed", "parked"] {
            run(&["checkout", "--quiet", "-b", branch, "main"]);
            write(&format!("{branch}.txt"), "one\n");
            run(&["add", "."]);
            run(&["commit", "--quiet", "--message", branch]);
            run(&["checkout", "--quiet", "main"]);
            run(&["merge", "--quiet", "--squash", branch]);
            run(&["commit", "--quiet", "--message", &format!("Merge branch '{branch}'")]);
        }

        run(&["checkout", "--quiet", "-b", "open", "main"]);
        write("open.txt", "wip\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "work in progress"]);
        run(&["checkout", "--quiet", "main"]);
        let worktree = env::temp_dir().join(format!("git-nav-squash-cleanup-parked-{}", std::process::id()));
        let _ = fs::remove_dir_all(&worktree);
        run(&["worktree", "add", "--quiet", &worktree.to_string_lossy(), "parked"]);

        let options = CleanupOptions { delete_merged_pull_request_branches: false, delete_merged_branches: true, delete_squash_merged_branches: true };
        let candidates = cleanup_candidates(&path, &options, None).unwrap();
        let _ = fs::remove_dir_all(&worktree);
        fs::remove_dir_all(&path).unwrap();

        let reasons: HashMap<_, _> = candidates.into_iter().map(|candidate| (candidate.branch, candidate.reasons)).collect();
        // A squash leaves no ancestry, so the merged rule cannot be the one claiming it.
        assert_eq!(reasons.get("squashed"), Some(&vec![CleanupReason::SquashedIntoDefaultBranch]));
        assert!(!reasons.contains_key("open"));
        assert!(!reasons.contains_key("parked"), "a branch held by a worktree cannot be deleted");
        assert!(!reasons.contains_key("main"));
    }

    #[test]
    fn compares_a_branch_against_where_it_forked_from_the_primary_branch() {
        let (path, run) = scratch_repository("branch-range");
        let write = |name: &str, contents: &str| fs::write(Path::new(&path).join(name), contents).unwrap();
        write("shared.txt", "base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
        run(&["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

        run(&["checkout", "--quiet", "-b", "feature"]);
        write("feature.txt", "one\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "feature"]);
        run(&["checkout", "--quiet", "main"]);
        write("primary.txt", "later\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "primary"]);
        run(&["update-ref", "refs/remotes/origin/main", "HEAD"]);

        let selection = branch_range(&path, "feature").unwrap();
        let names = |comparison: &Comparison| {
            let mut names: Vec<_> = comparison.files.iter().filter_map(|file| file.new_path.clone().or(file.old_path.clone())).collect();
            names.sort();
            names
        };
        let forked = comparison(&path, &selection.base_ref, &selection.head_ref, true, false).unwrap();
        let direct = comparison(&path, &selection.base_ref, &selection.head_ref, false, false).unwrap();

        run(&["checkout", "--quiet", "feature"]);
        write("second.txt", "two\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "second"]);
        let after_commit = comparison(&path, &selection.base_ref, &selection.head_ref, true, false).unwrap();
        remove_scratch_repository(&path);

        assert_eq!((selection.base_ref.as_str(), selection.head_ref.as_str()), ("origin/main", "feature"));
        assert_eq!(names(&forked), ["feature.txt"]);
        // Without the fork point the primary branch's own commit reads as a deletion on the branch.
        assert_eq!(names(&direct), ["feature.txt", "primary.txt"]);
        assert_eq!(names(&after_commit), ["feature.txt", "second.txt"]);
    }

    #[test]
    fn leaves_out_a_file_whose_only_changes_are_whitespace() {
        let (path, run) = scratch_repository("ignore-whitespace");
        let write = |name: &str, contents: &str| fs::write(Path::new(&path).join(name), contents).unwrap();
        write("spaced.txt", "one\ntwo\n");
        write("changed.txt", "one\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["checkout", "--quiet", "-b", "feature"]);
        write("spaced.txt", "one  \n\ttwo\n");
        write("changed.txt", "two\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "feature"]);

        let names = |comparison: Comparison| {
            let mut names: Vec<_> = comparison.files.iter().filter_map(|file| file.new_path.clone()).collect();
            names.sort();
            names
        };
        let all = names(comparison(&path, "main", "feature", false, false).unwrap());
        let ignored = names(comparison(&path, "main", "feature", false, true).unwrap());
        remove_scratch_repository(&path);

        assert_eq!(all, ["changed.txt", "spaced.txt"]);
        assert_eq!(ignored, ["changed.txt"]);
    }

    #[test]
    fn keeps_files_after_a_rename_when_ignoring_whitespace() {
        let (path, run) = scratch_repository("ignore-whitespace-rename");
        let write =
            |name: &str, contents: &str| fs::write(Path::new(&path).join(name), contents).unwrap();
        write("old.txt", "unchanged\n");
        write("later.txt", "before\nkeep\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["checkout", "--quiet", "-b", "feature"]);
        run(&["mv", "old.txt", "renamed.txt"]);
        write("later.txt", "after\nnext\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "rename and change"]);

        let comparison = comparison(&path, "main", "feature", false, true).unwrap();
        remove_scratch_repository(&path);

        let later = comparison
            .files
            .iter()
            .find(|file| file.new_path.as_deref() == Some("later.txt"))
            .unwrap();
        assert_eq!(later.additions, 2);
        assert_eq!(later.deletions, 2);
        assert!(comparison
            .files
            .iter()
            .any(|file| file.new_path.as_deref() == Some("renamed.txt")));
    }

    #[test]
    fn reports_when_refs_have_no_merge_base() {
        let (path, run) = scratch_repository("no-merge-base");
        fs::write(Path::new(&path).join("main.txt"), "main\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "main"]);
        run(&["checkout", "--quiet", "--orphan", "unrelated"]);
        fs::write(Path::new(&path).join("unrelated.txt"), "unrelated\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "unrelated"]);

        let result = comparison(&path, "main", "unrelated", true, false);
        remove_scratch_repository(&path);

        assert!(matches!(result, Err(message) if message == "Could not find a merge base for main and unrelated."));
    }

    #[test]
    fn detects_a_squash_merge_that_has_not_been_pushed_yet() {
        let path = env::temp_dir()
            .join(format!("git-nav-unpushed-squash-{}", std::process::id()))
            .to_string_lossy()
            .to_string();
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        let run = |arguments: &[&str]| {
            let output = git_result(&path, arguments).unwrap();
            assert!(output.status.success(), "{arguments:?}: {}", String::from_utf8_lossy(&output.stderr));
        };
        let write = |name: &str, contents: &str| fs::write(Path::new(&path).join(name), contents).unwrap();
        let sha = |reference: &str| git_output(&path, &["rev-parse", reference]).unwrap();
        run(&["init", "--quiet", "--initial-branch=main"]);
        run(&["config", "user.email", "tests@example.com"]);
        run(&["config", "user.name", "Tests"]);
        run(&["config", "commit.gpgsign", "false"]);
        write("shared.txt", "base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);

        // The remote is left at the branch point, so the squash exists only on the local primary branch.
        run(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
        run(&["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

        run(&["checkout", "--quiet", "-b", "unpushed"]);
        write("unpushed.txt", "one\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "work"]);
        let tip = sha("HEAD");
        run(&["checkout", "--quiet", "main"]);
        run(&["merge", "--quiet", "--squash", "unpushed"]);
        run(&["commit", "--quiet", "--message", "Merge branch 'unpushed'"]);
        let target = sha("HEAD");

        let primary = primary_reference(&path).unwrap();
        let reference = squash_search_reference(&path).unwrap();
        let edges: HashMap<_, _> = local_squash_merges(&path).into_iter().collect();
        fs::remove_dir_all(&path).unwrap();

        assert_eq!(primary, "origin/main");
        assert_eq!(reference, "refs/heads/main");
        assert_eq!(edges.get(&tip), Some(&target));
    }

    #[test]
    fn diffs_the_working_tree_including_untracked_files() {
        let path = env::temp_dir()
            .join(format!("git-nav-worktree-diff-{}", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        let run = |arguments: &[&str]| {
            let output = git_result(&path, arguments).unwrap();
            assert!(output.status.success(), "{arguments:?}: {}", String::from_utf8_lossy(&output.stderr));
        };
        let write = |name: &str, contents: &str| fs::write(Path::new(&path).join(name), contents).unwrap();
        run(&["init", "--quiet", "--initial-branch=main"]);
        run(&["config", "user.email", "tests@example.com"]);
        run(&["config", "user.name", "Tests"]);
        run(&["config", "commit.gpgsign", "false"]);
        write("kept.txt", "one\ntwo\nthree\n");
        write("removed.txt", "gone\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        write("kept.txt", "one\nchanged\nthree\n");
        fs::remove_file(Path::new(&path).join("removed.txt")).unwrap();
        write("untracked.txt", "fresh\n\nlines\n");
        fs::write(Path::new(&path).join(".gitignore"), "ignored.txt\n").unwrap();
        write("ignored.txt", "invisible\n");

        let comparison = compare_refs(path.clone(), "HEAD".to_string(), WORKTREE_REF.to_string(), false, false).unwrap();
        let untracked = diff_file(path.clone(), comparison.base_sha.clone(), comparison.head_sha.clone(), None, Some("untracked.txt".to_string()), false);
        let modified = diff_file(path.clone(), comparison.base_sha.clone(), comparison.head_sha.clone(), Some("kept.txt".to_string()), Some("kept.txt".to_string()), false);
        fs::remove_dir_all(&path).unwrap();

        assert_eq!(comparison.head_sha, WORKTREE_REF);
        let names: Vec<_> = comparison.files.iter().map(|file| (file.status.as_str(), file.new_path.as_deref(), file.old_path.as_deref())).collect();
        assert!(names.contains(&("modified", Some("kept.txt"), Some("kept.txt"))), "{names:?}");
        assert!(names.contains(&("deleted", None, Some("removed.txt"))), "{names:?}");
        // .gitignore is untracked too, but the ignored file it names must not be listed.
        assert!(names.contains(&("added", Some("untracked.txt"), None)), "{names:?}");
        assert!(!names.iter().any(|(_, new, _)| *new == Some("ignored.txt")), "{names:?}");

        let untracked_stat = comparison.files.iter().find(|file| file.new_path.as_deref() == Some("untracked.txt")).unwrap();
        assert_eq!((untracked_stat.additions, untracked_stat.deletions), (3, 0));

        let untracked = untracked.unwrap();
        assert!(untracked.hunks[0].contains("+fresh"), "{:?}", untracked.hunks);
        assert_eq!(untracked.new_content.as_deref(), Some("fresh\n\nlines\n"));
        assert_eq!(untracked.old_content, None);

        let modified = modified.unwrap();
        assert!(modified.hunks[0].contains("+one\nchanged") || modified.hunks[0].contains("+changed"), "{:?}", modified.hunks);
        assert_eq!(modified.new_content.as_deref(), Some("one\nchanged\nthree\n"));
        assert_eq!(modified.old_content.as_deref(), Some("one\ntwo\nthree\n"));
    }

    #[test]
    fn counts_uncommitted_changes_in_every_worktree() {
        let path = env::temp_dir()
            .join(format!("git-nav-worktree-status-{}", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let linked = format!("{path}-linked");
        let _ = fs::remove_dir_all(&path);
        let _ = fs::remove_dir_all(&linked);
        fs::create_dir_all(&path).unwrap();
        let run = |arguments: &[&str]| {
            let output = git_result(&path, arguments).unwrap();
            assert!(output.status.success(), "{arguments:?}: {}", String::from_utf8_lossy(&output.stderr));
        };
        let write = |directory: &str, name: &str, contents: &str| {
            fs::write(Path::new(directory).join(name), contents).unwrap()
        };
        run(&["init", "--quiet", "--initial-branch=main"]);
        run(&["config", "user.email", "tests@example.com"]);
        run(&["config", "user.name", "Tests"]);
        run(&["config", "commit.gpgsign", "false"]);
        run(&["config", "core.autocrlf", "false"]);
        write(&path, "tracked.txt", "base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["worktree", "add", "--quiet", "-b", "feature", &linked]);
        write(&path, "tracked.txt", "changed\n");
        write(&path, "untracked.txt", "new\n");
        write(&linked, "tracked.txt", "changed in the linked worktree\n");

        let statuses = worktree_status(path.clone()).unwrap();
        let clean = {
            write(&path, "tracked.txt", "base\n");
            fs::remove_file(Path::new(&path).join("untracked.txt")).unwrap();
            write(&linked, "tracked.txt", "base\n");
            worktree_status(path.clone()).unwrap()
        };
        let _ = fs::remove_dir_all(&linked);
        fs::remove_dir_all(&path).unwrap();

        assert_eq!(statuses.len(), 2);
        let main = statuses.iter().find(|status| status.branch == "main").unwrap();
        assert_eq!((main.changed_files, main.untracked_files), (1, 1));
        let feature = statuses.iter().find(|status| status.branch == "feature").unwrap();
        assert_eq!((feature.changed_files, feature.untracked_files), (1, 0));
        assert!(clean.iter().all(|status| status.changed_files == 0 && status.untracked_files == 0));
    }

    #[test]
    fn predicts_the_first_conflicting_commit_of_a_rebase() {
        let path = env::temp_dir()
            .join(format!("git-nav-prediction-{}", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        let run = |arguments: &[&str]| {
            let output = git_result(&path, arguments).unwrap();
            assert!(output.status.success(), "{arguments:?}: {}", String::from_utf8_lossy(&output.stderr));
        };
        let write = |name: &str, contents: &str| fs::write(Path::new(&path).join(name), contents).unwrap();
        run(&["init", "--quiet", "--initial-branch=main"]);
        run(&["config", "user.email", "tests@example.com"]);
        run(&["config", "user.name", "Tests"]);
        run(&["config", "commit.gpgsign", "false"]);
        write("shared.txt", "base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["branch", "feature"]);
        write("shared.txt", "onto\n");
        run(&["commit", "--quiet", "--all", "--message", "diverge"]);
        run(&["checkout", "--quiet", "feature"]);
        write("only-feature.txt", "feature\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "add a file"]);
        write("shared.txt", "feature\n");
        run(&["commit", "--quiet", "--all", "--message", "change the shared file"]);

        let clean = predicted_conflicts(&path, "main", "feature~2", "feature~1").unwrap();
        let conflicted = predicted_conflicts(&path, "main", "feature~2", "feature").unwrap();
        fs::remove_dir_all(&path).unwrap();

        assert!(matches!(clean, ConflictPrediction::Clean));
        let ConflictPrediction::Conflicts(conflict) = conflicted else {
            panic!("expected a conflict");
        };
        assert_eq!(conflict.subject, "change the shared file");
        assert_eq!(conflict.files, vec!["shared.txt".to_string()]);
    }

    #[test]
    fn ignores_commits_whose_patch_is_already_upstream() {
        let path = env::temp_dir()
            .join(format!("git-nav-patch-duplicate-{}", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        let run = |arguments: &[&str]| {
            let output = git_result(&path, arguments).unwrap();
            assert!(output.status.success(), "{arguments:?}: {}", String::from_utf8_lossy(&output.stderr));
        };
        let write = |name: &str, contents: &str| fs::write(Path::new(&path).join(name), contents).unwrap();
        run(&["init", "--quiet", "--initial-branch=main"]);
        run(&["config", "user.email", "tests@example.com"]);
        run(&["config", "user.name", "Tests"]);
        run(&["config", "commit.gpgsign", "false"]);
        write("shared.txt", "base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["branch", "onto"]);
        run(&["checkout", "--quiet", "-b", "feature"]);
        write("shared.txt", "duplicate\n");
        run(&["commit", "--quiet", "--all", "--message", "change the shared file"]);
        write("only-feature.txt", "feature\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "add a file"]);
        run(&["checkout", "--quiet", "main"]);
        run(&["cherry-pick", "feature~1"]);
        run(&["commit", "--quiet", "--amend", "--message", "land the shared file change"]);
        run(&["checkout", "--quiet", "onto"]);
        write("shared.txt", "onto\n");
        run(&["commit", "--quiet", "--all", "--message", "diverge"]);

        let prediction = predicted_conflicts(&path, "onto", "main", "feature").unwrap();
        let rebase = rebase_branch_onto(&path, "onto", "main", "feature").unwrap();
        let replayed = git_output_allow_empty(&path, &["log", "--format=%s", "onto..feature"]).unwrap();
        fs::remove_dir_all(&path).unwrap();

        assert!(matches!(prediction, ConflictPrediction::Clean));
        assert!(matches!(rebase, OperationResult::Completed(_)));
        assert_eq!(replayed.lines().collect::<Vec<_>>(), vec!["add a file"]);
    }

    fn scratch_repository(name: &str) -> (String, impl Fn(&[&str])) {
        let path = env::temp_dir()
            .join(format!("git-nav-{name}-{}", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        let run_path = path.clone();
        let run = move |arguments: &[&str]| {
            let output = git_result(&run_path, arguments).unwrap();
            assert!(output.status.success(), "{arguments:?}: {}", String::from_utf8_lossy(&output.stderr));
        };
        run(&["init", "--quiet", "--initial-branch=main"]);
        run(&["config", "user.email", "tests@example.com"]);
        run(&["config", "user.name", "Tests"]);
        run(&["config", "commit.gpgsign", "false"]);
        run(&["config", "core.autocrlf", "false"]);
        (path, run)
    }

    fn remove_scratch_repository(path: &str) {
        for attempt in 0..20 {
            match fs::remove_dir_all(path) {
                Ok(()) => return,
                Err(error)
                    if cfg!(target_os = "windows")
                        && error.raw_os_error() == Some(32)
                        && attempt < 19 =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(error) => panic!("Could not remove scratch repository: {error}"),
            }
        }
    }

    #[test]
    fn streams_a_bounded_commit_graph_window() {
        let (path, run) = scratch_repository("graph-window");
        run(&["commit", "--quiet", "--allow-empty", "--message", "first"]);
        run(&["commit", "--quiet", "--allow-empty", "--message", "second"]);
        run(&["commit", "--quiet", "--allow-empty", "--message", "third"]);

        let mut batches = Vec::new();
        let has_more = walk_commit_graph_page(&path, 1, 1, |batch| {
            batches.push(batch);
            Ok(())
        })
        .unwrap();
        let subjects = batches
            .into_iter()
            .flatten()
            .map(|commit| commit[5].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        remove_scratch_repository(&path);

        assert_eq!(subjects, ["second"]);
        assert!(has_more);
    }

    #[cfg(not(target_os = "windows"))]
    fn zombie_children() -> usize {
        let pid = std::process::id().to_string();
        let output = Command::new("ps").args(["-ax", "-o", "ppid=,stat="]).output().unwrap();
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|line| {
                let mut fields = line.split_whitespace();
                fields.next() == Some(pid.as_str()) && fields.next().is_some_and(|stat| stat.starts_with('Z'))
            })
            .count()
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn reaps_the_git_processes_a_graph_walk_leaves_behind() {
        let (path, run) = scratch_repository("graph-reaping");
        run(&["commit", "--quiet", "--allow-empty", "--message", "first"]);
        fs::write(Path::new(&path).join("tracked.txt"), "contents\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "second"]);

        walk_commit_graph_page(&path, 0, 1, |_| Ok(())).unwrap();
        walk_commit_graph_page(&path, 0, usize::MAX, |_| Err("the receiver is gone".to_string())).unwrap_err();
        patch_id(&path, &["show", "HEAD"]).unwrap();
        fs::remove_dir_all(&path).unwrap();

        // Tests share a process, so a parallel case can hold a child of its own for an instant.
        let mut remaining = zombie_children();
        for _ in 0..20 {
            if remaining == 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
            remaining = zombie_children();
        }
        assert_eq!(remaining, 0);
    }

    #[test]
    fn walks_history_without_stash_or_notes_commits() {
        let (path, run) = scratch_repository("graph-revisions");
        run(&["commit", "--quiet", "--allow-empty", "--message", "first"]);
        fs::write(format!("{path}/work.txt"), "one").unwrap();
        run(&["add", "work.txt"]);
        run(&["stash", "push", "--quiet", "--message", "set aside"]);
        run(&["notes", "add", "--message", "a note"]);

        let mut batches = Vec::new();
        walk_commit_graph(&path, |batch| {
            batches.push(batch);
            Ok(())
        })
        .unwrap();
        let subjects = batches
            .into_iter()
            .flatten()
            .map(|commit| commit[5].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        fs::remove_dir_all(&path).unwrap();

        assert_eq!(subjects, ["first"]);
    }

    #[test]
    fn keeps_the_commits_of_a_detached_worktree() {
        let (path, run) = scratch_repository("detached-worktree");
        run(&["commit", "--quiet", "--allow-empty", "--message", "base"]);
        let detached = format!("{path}-detached");
        run(&["worktree", "add", "--quiet", "--detach", &detached, "HEAD"]);
        let commit = Command::new("git")
            .args(["-C", &detached, "-c", "user.email=tests@example.com", "-c", "user.name=Tests"])
            .args(["commit", "--quiet", "--allow-empty", "--message", "work in a detached worktree"])
            .status()
            .unwrap();
        assert!(commit.success());

        let mut batches = Vec::new();
        walk_commit_graph(&path, |batch| {
            batches.push(batch);
            Ok(())
        })
        .unwrap();
        let subjects = batches
            .into_iter()
            .flatten()
            .map(|commit| commit[5].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        let _ = fs::remove_dir_all(&detached);
        fs::remove_dir_all(&path).unwrap();

        assert_eq!(subjects, ["work in a detached worktree", "base"]);
    }

    #[test]
    fn keeps_the_commit_a_stash_was_made_from_even_when_no_branch_reaches_it() {
        let (path, run) = scratch_repository("stash-base");
        run(&["commit", "--quiet", "--allow-empty", "--message", "base"]);
        run(&["commit", "--quiet", "--allow-empty", "--message", "stashed from here"]);
        fs::write(format!("{path}/work.txt"), "one").unwrap();
        run(&["add", "work.txt"]);
        run(&["stash", "push", "--quiet", "--message", "set aside"]);
        // The branch moves off the commit the stash was taken from, so only the stash still reaches it.
        run(&["reset", "--quiet", "--hard", "HEAD~1"]);

        let entries = stash_list(path.clone()).unwrap();
        let mut batches = Vec::new();
        walk_commit_graph(&path, |batch| {
            batches.push(batch);
            Ok(())
        })
        .unwrap();
        let subjects = batches
            .into_iter()
            .flatten()
            .map(|commit| commit[5].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        fs::remove_dir_all(&path).unwrap();

        assert_eq!(entries.len(), 1);
        assert!(entries[0].base.is_some());
        assert_eq!(subjects, ["stashed from here", "base"]);
    }

    #[test]
    fn reserves_lane_zero_for_the_local_branch_that_is_ahead_of_its_remote() {
        let (path, run) = scratch_repository("lane-tip");
        run(&["commit", "--quiet", "--allow-empty", "--message", "base"]);
        run(&["update-ref", "refs/remotes/origin/main", "refs/heads/main"]);
        run(&["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
        let base = resolve_commit(&path, "refs/heads/main").unwrap();
        let synced = reserved_lane_tip(&path);

        run(&["commit", "--quiet", "--allow-empty", "--message", "ahead"]);
        let local = resolve_commit(&path, "refs/heads/main").unwrap();
        let ahead = reserved_lane_tip(&path);

        run(&["checkout", "--quiet", "-b", "other", &base]);
        run(&["commit", "--quiet", "--allow-empty", "--message", "remote side"]);
        run(&["update-ref", "refs/remotes/origin/main", "refs/heads/other"]);
        run(&["checkout", "--quiet", "main"]);
        let remote = resolve_commit(&path, "refs/heads/other").unwrap();
        let diverged = reserved_lane_tip(&path);
        fs::remove_dir_all(&path).unwrap();

        assert_eq!(synced.as_deref(), Some(base.as_str()));
        assert_eq!(ahead.as_deref(), Some(local.as_str()));
        // Divergence is not one line of history, so the remote keeps the lane and the local branch takes its own.
        assert_eq!(diverged.as_deref(), Some(remote.as_str()));
    }

    #[test]
    fn carries_uncommitted_work_across_a_stashed_checkout() {
        let (path, run) = scratch_repository("checkout-stash");
        fs::write(Path::new(&path).join("tracked.txt"), "base\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["branch", "topic"]);
        fs::write(Path::new(&path).join("tracked.txt"), "work in progress\n").unwrap();

        let result = checkout_reference(
            &path,
            "topic",
            &CheckoutOptions { create: None, track: false, detach: false, stash: true },
        )
        .unwrap();
        let branch = git_output(&path, &["symbolic-ref", "--short", "HEAD"]).unwrap();
        let restored = fs::read_to_string(Path::new(&path).join("tracked.txt")).unwrap();
        let stashes = git_output_allow_empty(&path, &["stash", "list"]).unwrap();
        fs::remove_dir_all(&path).unwrap();

        assert!(matches!(result, OperationResult::Completed(_)));
        assert_eq!(branch, "topic");
        assert_eq!(restored, "work in progress\n");
        assert!(stashes.trim().is_empty());
    }

    #[test]
    fn aborts_a_conflicted_merge_and_leaves_the_worktree_alone() {
        let (path, run) = scratch_repository("merge-conflict");
        let write = |contents: &str| fs::write(Path::new(&path).join("shared.txt"), contents).unwrap();
        write("base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["checkout", "--quiet", "-b", "topic"]);
        write("topic\n");
        run(&["commit", "--quiet", "--all", "--message", "topic"]);
        run(&["checkout", "--quiet", "main"]);
        write("main\n");
        run(&["commit", "--quiet", "--all", "--message", "main"]);

        let options = MergeOptions { mode: "default".to_string(), message: None };
        let result = merge_into_branch(&path, "topic", "main", &options).unwrap();
        let pending = pending_operation(&path);
        let dirty = worktree_is_dirty(&path).unwrap();
        let head = git_output(&path, &["log", "-1", "--format=%s"]).unwrap();
        fs::remove_dir_all(&path).unwrap();

        let OperationResult::Failed(failure) = result else {
            panic!("a conflicting merge should not complete");
        };
        assert_eq!(failure.files, vec!["shared.txt".to_string()]);
        assert!(pending.is_none());
        assert!(!dirty);
        assert_eq!(head, "main");
    }

    #[test]
    fn lands_a_squash_merge_as_one_commit_and_leaves_nothing_staged() {
        let (path, run) = scratch_repository("merge-squash");
        fs::write(Path::new(&path).join("file.txt"), "base\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["checkout", "--quiet", "-b", "topic"]);
        fs::write(Path::new(&path).join("one.txt"), "one\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "one"]);
        fs::write(Path::new(&path).join("two.txt"), "two\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "two"]);
        run(&["checkout", "--quiet", "main"]);

        let options = MergeOptions { mode: "squash".to_string(), message: Some("everything topic did".to_string()) };
        let result = merge_into_branch(&path, "topic", "main", &options).unwrap();
        let dirty = worktree_is_dirty(&path).unwrap();
        let subject = git_output(&path, &["log", "-1", "--format=%s"]).unwrap();
        let parents = git_output(&path, &["log", "-1", "--format=%P"]).unwrap();
        fs::remove_dir_all(&path).unwrap();

        assert!(matches!(result, OperationResult::Completed(_)));
        assert!(!dirty);
        assert_eq!(subject, "everything topic did");
        assert_eq!(parents.split_whitespace().count(), 1);
    }

    #[test]
    fn refuses_a_squash_merge_without_a_commit_message() {
        let (path, run) = scratch_repository("merge-squash-unnamed");
        fs::write(Path::new(&path).join("file.txt"), "base\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["checkout", "--quiet", "-b", "topic"]);
        run(&["commit", "--quiet", "--allow-empty", "--message", "ahead"]);
        run(&["checkout", "--quiet", "main"]);

        let options = MergeOptions { mode: "squash".to_string(), message: Some("   ".to_string()) };
        let result = merge_into_branch(&path, "topic", "main", &options);
        let dirty = worktree_is_dirty(&path).unwrap();
        fs::remove_dir_all(&path).unwrap();

        assert!(result.is_err());
        assert!(!dirty);
    }

    #[test]
    fn undoes_a_conflicted_squash_merge_that_has_no_merge_to_abort() {
        let (path, run) = scratch_repository("merge-squash-conflict");
        let write = |contents: &str| fs::write(Path::new(&path).join("shared.txt"), contents).unwrap();
        write("base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["checkout", "--quiet", "-b", "topic"]);
        write("topic\n");
        run(&["commit", "--quiet", "--all", "--message", "topic"]);
        run(&["checkout", "--quiet", "main"]);
        write("main\n");
        run(&["commit", "--quiet", "--all", "--message", "main"]);

        let options = MergeOptions { mode: "squash".to_string(), message: Some("squashed".to_string()) };
        let result = merge_into_branch(&path, "topic", "main", &options).unwrap();
        let dirty = worktree_is_dirty(&path).unwrap();
        let head = git_output(&path, &["log", "-1", "--format=%s"]).unwrap();
        let leftovers = existing_git_path(&path, "SQUASH_MSG");
        fs::remove_dir_all(&path).unwrap();

        let OperationResult::Failed(failure) = result else {
            panic!("a conflicting squash should not complete");
        };
        assert_eq!(failure.files, vec!["shared.txt".to_string()]);
        assert!(!dirty);
        assert_eq!(head, "main");
        assert!(leftovers.is_none());
    }

    #[test]
    fn completes_a_squash_merge_that_has_nothing_left_to_apply() {
        let (path, run) = scratch_repository("merge-squash-applied");
        fs::write(Path::new(&path).join("file.txt"), "base\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["checkout", "--quiet", "-b", "topic"]);
        fs::write(Path::new(&path).join("one.txt"), "one\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "one"]);
        run(&["checkout", "--quiet", "main"]);

        let options = MergeOptions { mode: "squash".to_string(), message: Some("squashed".to_string()) };
        merge_into_branch(&path, "topic", "main", &options).unwrap();
        let again = merge_into_branch(&path, "topic", "main", &options).unwrap();
        let dirty = worktree_is_dirty(&path).unwrap();
        let count = git_output(&path, &["rev-list", "--count", "HEAD"]).unwrap();
        fs::remove_dir_all(&path).unwrap();

        assert!(matches!(again, OperationResult::Completed(_)));
        assert!(!dirty);
        assert_eq!(count, "2");
    }

    #[test]
    fn predicts_the_commit_a_revert_stops_on() {
        let (path, run) = scratch_repository("revert-prediction");
        let write = |contents: &str| fs::write(Path::new(&path).join("shared.txt"), contents).unwrap();
        write("one\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        let base = resolve_commit(&path, "HEAD").unwrap();
        write("two\n");
        run(&["commit", "--quiet", "--all", "--message", "second"]);
        let tip = resolve_commit(&path, "HEAD").unwrap();
        write("three\n");
        run(&["commit", "--quiet", "--all", "--message", "third"]);

        let conflicting = predicted_revert_conflicts(&path, &base, &tip).unwrap();
        let clean = predicted_revert_conflicts(&path, &tip, &resolve_commit(&path, "HEAD").unwrap()).unwrap();
        fs::remove_dir_all(&path).unwrap();

        let ConflictPrediction::Conflicts(conflict) = conflicting else {
            panic!("reverting a commit later rewritten should be predicted to conflict");
        };
        assert_eq!(conflict.subject, "second");
        assert_eq!(conflict.files, vec!["shared.txt".to_string()]);
        assert!(matches!(clean, ConflictPrediction::Clean));
    }

    #[test]
    fn reports_the_moved_branch_of_a_fast_forward_merge() {
        let (path, run) = scratch_repository("merge-forward");
        fs::write(Path::new(&path).join("file.txt"), "base\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        let base = resolve_commit(&path, "refs/heads/main").unwrap();
        run(&["checkout", "--quiet", "-b", "topic"]);
        run(&["commit", "--quiet", "--allow-empty", "--message", "ahead"]);
        let topic = resolve_commit(&path, "refs/heads/topic").unwrap();
        run(&["checkout", "--quiet", "main"]);

        let options = MergeOptions { mode: "default".to_string(), message: None };
        let result = merge_into_branch(&path, "topic", "main", &options).unwrap();
        fs::remove_dir_all(&path).unwrap();

        let OperationResult::Completed(completed) = result else {
            panic!("a fast-forward merge should complete");
        };
        assert_eq!(completed.updates.len(), 1);
        assert_eq!(completed.updates[0].reference, "refs/heads/main");
        assert_eq!((completed.updates[0].before.as_str(), completed.updates[0].after.as_str()), (base.as_str(), topic.as_str()));
    }

    #[test]
    fn undoes_a_created_branch_by_deleting_it() {
        let (path, run) = scratch_repository("undo-create");
        fs::write(Path::new(&path).join("file.txt"), "base\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);

        let result = create_branch_at(&path, "topic", "main", &BranchOptions { checkout: false, track: false }).unwrap();
        let OperationResult::Completed(completed) = result else {
            panic!("creating a branch should complete");
        };
        restore_refs(&path, &completed.updates).unwrap();
        let branches = git_output_allow_empty(&path, &["for-each-ref", "--format=%(refname:short)", "refs/heads"]).unwrap();
        fs::remove_dir_all(&path).unwrap();

        assert_eq!(completed.updates.len(), 1);
        assert_eq!(completed.updates[0].reference, "refs/heads/topic");
        assert_eq!(completed.updates[0].before, "");
        assert_eq!(branches.lines().collect::<Vec<_>>(), vec!["main"]);
    }
}

#[tauri::command]
fn open_repository(app: AppHandle, path: String) -> Result<(), String> {
    open_repository_window(&app, &path)
}

#[tauri::command]
fn update_command() -> Option<String> {
    env::var("GIT_NAV_UPDATE_COMMAND").ok()
}

#[derive(Debug, PartialEq)]
struct DesktopCommand {
    program: &'static str,
    arguments: Vec<String>,
    current_dir: Option<String>,
    hide_console: bool,
}

impl DesktopCommand {
    fn new(program: &'static str, arguments: Vec<String>) -> Self {
        Self { program, arguments, current_dir: None, hide_console: false }
    }

    #[cfg(any(target_os = "linux", target_os = "windows", test))]
    fn in_directory(program: &'static str, path: &str) -> Self {
        Self { program, arguments: Vec::new(), current_dir: Some(path.to_string()), hide_console: false }
    }

    #[cfg(any(target_os = "windows", test))]
    fn hidden(program: &'static str, arguments: Vec<String>) -> Self {
        Self { program, arguments, current_dir: None, hide_console: true }
    }
}

#[cfg(any(target_os = "macos", test))]
fn macos_worktree_command(path: &str, target: &str) -> Result<DesktopCommand, String> {
    let arguments = match target {
        "vscode" => vec!["-a".to_string(), "Visual Studio Code".to_string(), path.to_string()],
        "terminal" => vec!["-a".to_string(), "Terminal".to_string(), path.to_string()],
        "finder" => vec![path.to_string()],
        _ => return Err("Unknown worktree target.".to_string()),
    };
    Ok(DesktopCommand::new("open", arguments))
}

#[cfg(any(target_os = "linux", test))]
fn linux_worktree_commands(path: &str, target: &str) -> Result<Vec<DesktopCommand>, String> {
    match target {
        "vscode" => Ok(vec![DesktopCommand::new("code", vec![path.to_string()])]),
        "finder" => Ok(vec![DesktopCommand::new("xdg-open", vec![path.to_string()])]),
        "terminal" => Ok([
            DesktopCommand::new("xdg-terminal-exec", vec![format!("--dir={path}")]),
            DesktopCommand::in_directory("x-terminal-emulator", path),
            DesktopCommand::in_directory("gnome-terminal", path),
            DesktopCommand::in_directory("kgx", path),
            DesktopCommand::in_directory("konsole", path),
            DesktopCommand::in_directory("xfce4-terminal", path),
            DesktopCommand::in_directory("mate-terminal", path),
            DesktopCommand::in_directory("tilix", path),
            DesktopCommand::in_directory("alacritty", path),
            DesktopCommand::in_directory("kitty", path),
            DesktopCommand::in_directory("wezterm", path),
        ]
        .into()),
        _ => Err("Unknown worktree target.".to_string()),
    }
}

#[cfg(any(target_os = "linux", test))]
fn linux_url_command(url: String) -> DesktopCommand {
    DesktopCommand::new("xdg-open", vec![url])
}

#[cfg(any(target_os = "windows", test))]
fn windows_worktree_commands(path: &str, target: &str) -> Result<Vec<DesktopCommand>, String> {
    match target {
        "vscode" => Ok(vec![DesktopCommand::hidden("code.cmd", vec![path.to_string()])]),
        "finder" => Ok(vec![DesktopCommand::new("explorer.exe", vec![path.to_string()])]),
        "terminal" => Ok(vec![
            DesktopCommand::new("wt.exe", vec!["-d".to_string(), path.to_string()]),
            DesktopCommand::in_directory("powershell.exe", path),
            DesktopCommand::in_directory("cmd.exe", path),
        ]),
        _ => Err("Unknown worktree target.".to_string()),
    }
}

#[cfg(any(target_os = "windows", test))]
fn windows_url_command(url: String) -> DesktopCommand {
    DesktopCommand::new("explorer.exe", vec![url])
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn start_desktop_command(command: &DesktopCommand) -> Result<(), std::io::Error> {
    let mut process = desktop_process(command.program);
    #[cfg(target_os = "windows")]
    if command.hide_console {
        process.creation_flags(CREATE_NO_WINDOW);
    }
    process.args(&command.arguments);
    if let Some(path) = &command.current_dir {
        process.current_dir(path);
    }
    process.spawn().map(|mut child| {
        let _ = std::thread::spawn(move || {
            let _ = child.wait();
        });
    })
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn start_first_desktop_command(
    commands: Vec<DesktopCommand>,
    target: &str,
) -> Result<(), String> {
    let mut errors = Vec::new();
    for command in commands {
        match start_desktop_command(&command) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => errors.push(command.program),
            Err(error) => return Err(format!("Could not open {target}: {error}")),
        }
    }
    Err(format!(
        "Could not find an application to open {target}. Tried: {}.",
        errors.join(", ")
    ))
}

#[cfg(target_os = "macos")]
fn run_desktop_command(command: &DesktopCommand) -> Result<(), String> {
    let mut process = external_command(command.program);
    process.args(&command.arguments);
    if let Some(path) = &command.current_dir {
        process.current_dir(path);
    }
    process
        .status()
        .map_err(|error| error.to_string())?
        .success()
        .then_some(())
        .ok_or_else(|| format!("Could not run {}.", command.program))
}

/// Launches a worktree in another local application. In server mode this runs on the host machine.
fn launch_worktree(path: &str, target: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let command = macos_worktree_command(path, target)?;
        run_desktop_command(&command).map_err(|_| format!("Could not open {target}."))
    }
    #[cfg(target_os = "linux")]
    {
        start_first_desktop_command(linux_worktree_commands(path, target)?, target)
    }
    #[cfg(target_os = "windows")]
    {
        start_first_desktop_command(windows_worktree_commands(path, target)?, target)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = (path, target);
        Err("Opening worktrees outside Git Nav is currently supported on macOS, Linux, and Windows only.".to_string())
    }
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !is_https_url(&url) {
        return Err("Only https links can be opened.".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        run_desktop_command(&DesktopCommand::new("open", vec![url]))
            .map_err(|error| format!("Could not open the link: {error}"))
    }
    #[cfg(target_os = "linux")]
    {
        start_desktop_command(&linux_url_command(url))
            .map_err(|error| format!("Could not open the link: {error}"))
    }
    #[cfg(target_os = "windows")]
    {
        start_desktop_command(&windows_url_command(url))
            .map_err(|error| format!("Could not open the link: {error}"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Err("Opening links outside Git Nav is currently supported on macOS, Linux, and Windows only.".to_string())
    }
}

fn is_https_url(url: &str) -> bool {
    url.starts_with("https://")
}

#[tauri::command]
fn open_worktree(app: AppHandle, path: String, target: String) -> Result<(), String> {
    if target == "git-nav" {
        return open_repository_window(&app, &path);
    }
    launch_worktree(&path, &target)
}

const SERVE_USAGE: &str = "\
Usage: git-nav serve [options]

Options:
      --host <address>  Interface to bind (default 127.0.0.1; use 0.0.0.0 for other devices)
      --port <number>   Port to listen on (default 4300)
      --token <value>   Shared secret required to open the app (default: randomly generated)
      --no-token        Serve without authentication
";

struct ServeArguments {
    host: std::net::IpAddr,
    port: u16,
    token: Option<String>,
}

fn parse_serve_arguments(args: &[String]) -> Result<ServeArguments, String> {
    let mut host = std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);
    let mut port = 4300;
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
            "--port" => port = value()?.parse().map_err(|_| "Invalid --port.".to_string())?,
            "--token" => {
                token = Some(value()?);
                generate_token = false;
            }
            "--no-token" => generate_token = false,
            "--help" | "-h" => return Err(SERVE_USAGE.to_string()),
            _ => return Err(format!("Unknown option {argument}.\n\n{SERVE_USAGE}")),
        }
    }

    if generate_token {
        token = Some(generated_token());
    }

    Ok(ServeArguments { host, port, token })
}

fn generated_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("could not generate a token");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn serve(args: &[String]) {
    let arguments = match parse_serve_arguments(args) {
        Ok(arguments) => arguments,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    };

    let runtime = tokio::runtime::Runtime::new().expect("could not start the async runtime");
    if let Err(error) = runtime.block_on(server::serve(server::Options {
        host: arguments.host,
        port: arguments.port,
        token: arguments.token,
    })) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<_> = env::args().collect();

    if args.get(1).is_some_and(|argument| argument == "serve") {
        serve(&args[2..]);
        return;
    }

    let cwd = env::current_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let repository_path = repository_path_from_args(&args, &cwd);

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(path) = repository_path_from_args(&args, &cwd) {
                let _ = open_repository_window(app, &path);
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
        #[cfg(target_os = "macos")]
        {
            builder = builder.plugin(macos_window_chrome_plugin());
        }
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(OpenWorktrees::default())
        .invoke_handler(invoke_handler())
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            if let Err(error) = install_app_menu(app.handle()) {
                log::error!("Could not install the application menu: {error}");
            }
            if let Some(path) = &repository_path {
                open_repository_window(app.handle(), path)?;
            } else {
                reveal_launcher(app.handle())?;
                #[cfg(target_os = "macos")]
                update_recent_menu(Some(app.handle()));
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS only grants the process activation once the run loop is going, so a shell-launched
            // app has to claim the foreground here rather than while its window is being built.
            if matches!(event, RunEvent::Ready) {
                if let Some(window) = app.webview_windows().values().next() {
                    let _ = window.set_focus();
                }
            }
        });
}
