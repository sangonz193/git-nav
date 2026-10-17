use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap, collections::HashSet, fs, path::Path, path::PathBuf, sync::Arc,
    sync::Mutex,
};
use tauri::{AppHandle, Emitter};
use crate::storage::{data_dir, malformed_settings_path, with_locked_file, write_json_atomically};
use crate::git::{git_output_bytes, project_id, worktree_name, worktree_path};
use crate::window::update_recent_menu;

const RECENT_PROJECTS_CLEARED_EVENT: &str = "recent-projects-cleared";

const SIDEBAR_PROJECTS_CHANGED_EVENT: &str = "sidebar-projects-changed";

const MAX_RECENT_REPOSITORIES: usize = 8;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Worktree {
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
pub(crate) struct Project {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) worktrees: Vec<Worktree>,
}

pub(crate) struct WorktreeRecord {
    pub(crate) path: String,
    pub(crate) branch: String,
    pub(crate) head: String,
    pub(crate) is_main: bool,
    pub(crate) is_detached: bool,
    pub(crate) is_locked: bool,
    pub(crate) is_prunable: bool,
    pub(crate) is_bare: bool,
}

#[derive(Default, Deserialize, Serialize)]
pub(crate) struct RecentRepositories {
    #[serde(default)]
    projects: Vec<String>,
    #[serde(default)]
    repositories: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectoryEntry {
    name: String,
    path: String,
    is_repository: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectoryListing {
    path: String,
    parent: Option<String>,
    is_repository: bool,
    entries: Vec<DirectoryEntry>,
}

#[derive(Clone)]
pub(crate) struct OpenWorktree {
    pub(crate) project_id: String,
    pub(crate) worktree_path: String,
}

#[derive(Clone, Default)]
pub(crate) struct OpenWorktrees(pub(crate) Arc<Mutex<HashMap<String, OpenWorktree>>>);


#[derive(Default, Deserialize, Serialize)]
struct SidebarProjects {
    #[serde(default)]
    projects: Vec<String>,
}

fn sidebar_projects_path() -> Result<PathBuf, String> {
    data_dir().map(|dir| dir.join("sidebar-projects.json"))
}

enum StoredSidebar {
    Missing,
    Listed(Vec<String>),
    Malformed,
}

fn read_sidebar(path: &Path) -> Result<StoredSidebar, String> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(serde_json::from_str::<SidebarProjects>(&contents)
            .map(|sidebar| StoredSidebar::Listed(sidebar.projects))
            .unwrap_or(StoredSidebar::Malformed)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(StoredSidebar::Missing),
        Err(error) => Err(error.to_string()),
    }
}

// The first launch starts from the recent list, so the projects already in use are there.
fn seeded_sidebar(recent_paths: Result<Vec<String>, String>) -> Vec<String> {
    let mut projects = Vec::new();
    for path in recent_paths.unwrap_or_default() {
        if let Ok(id) = project_id(&path) {
            if !projects.contains(&id) {
                projects.push(id);
            }
        }
    }
    projects
}

fn update_sidebar_at(
    path: &Path,
    update: impl FnOnce(&mut Vec<String>) -> bool,
    recent_paths: impl FnOnce() -> Result<Vec<String>, String>,
) -> Result<(bool, Vec<String>), String> {
    with_locked_file(path, || {
        let (mut projects, created) = match read_sidebar(path)? {
            StoredSidebar::Listed(projects) => (projects, false),
            StoredSidebar::Missing => (seeded_sidebar(recent_paths()), true),
            StoredSidebar::Malformed => {
                fs::rename(path, malformed_settings_path(path)).map_err(|error| error.to_string())?;
                (seeded_sidebar(recent_paths()), true)
            }
        };
        let changed = update(&mut projects) || created;
        write_json_atomically(path, &SidebarProjects { projects: projects.clone() })?;
        Ok((changed, projects))
    })
}

fn update_sidebar(update: impl FnOnce(&mut Vec<String>) -> bool) -> Result<(bool, Vec<String>), String> {
    update_sidebar_at(&sidebar_projects_path()?, update, load_recent_paths)
}

fn announce_sidebar_change(app: Option<&AppHandle>) {
    if let Some(app) = app {
        if let Err(error) = app.emit(SIDEBAR_PROJECTS_CHANGED_EVENT, ()) {
            log::warn!("Could not announce the sidebar change: {error}");
        }
    }
}

fn add_sidebar_project(id: &str, app: Option<&AppHandle>) -> Result<(), String> {
    let (changed, _) = update_sidebar(|projects| {
        let missing = !projects.iter().any(|project| project == id);
        if missing {
            projects.push(id.to_string());
        }
        missing
    })?;
    if changed {
        announce_sidebar_change(app);
    }
    Ok(())
}

pub(crate) fn remove_sidebar_project_at(id: &str, app: Option<&AppHandle>) -> Result<(), String> {
    update_sidebar(|projects| {
        let before = projects.len();
        projects.retain(|project| project != id);
        projects.len() != before
    })?;
    announce_sidebar_change(app);
    Ok(())
}

pub(crate) fn sidebar_project_list(open_worktrees: &OpenWorktrees) -> Result<Vec<Project>, String> {
    let path = sidebar_projects_path()?;
    let stored = match read_sidebar(&path)? {
        StoredSidebar::Listed(projects) => projects,
        StoredSidebar::Missing | StoredSidebar::Malformed => update_sidebar_at(&path, |_| false, load_recent_paths)?.1,
    };
    let mut project_ids = HashSet::new();
    Ok(stored
        .into_iter()
        .filter_map(|id| project_from_id(id, open_worktrees).ok())
        .filter(|project| project_ids.insert(project.id.clone()))
        .collect())
}

fn recent_repositories_path() -> Result<PathBuf, String> {
    data_dir().map(|dir| dir.join("recent-repositories.json"))
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

pub(crate) fn clear_recent_paths(app: Option<&AppHandle>) -> Result<(), String> {
    write_recent_paths(Vec::new())?;
    update_recent_menu(app);
    if let Some(app) = app {
        app.emit(RECENT_PROJECTS_CLEARED_EVENT, ())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Backs the browser folder picker, which has no equivalent of the native directory dialog.
pub(crate) fn directory_listing(path: Option<&str>) -> Result<DirectoryListing, String> {
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

pub(crate) fn parse_worktree_records(output: &str) -> Vec<WorktreeRecord> {
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
        let mut bare = false;

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
            } else if *field == "bare" {
                bare = true;
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
                is_bare: bare,
            });
        }
    }

    worktrees
}

pub(crate) fn normalize_worktree_record(mut worktree: WorktreeRecord) -> WorktreeRecord {
    if worktree.is_main && !worktree.is_bare && !Path::new(&worktree.path).join(".git").exists() {
        worktree.path = worktree_path(&worktree.path).unwrap_or(worktree.path);
    }
    worktree
}

fn project_name(path: &str) -> String {
    let name = worktree_name(path);
    name.strip_suffix(".git").map(str::to_string).unwrap_or(name)
}

pub(crate) fn project_at(path: &str, open_worktrees: &OpenWorktrees) -> Result<Project, String> {
    project_from_id(project_id(path)?, open_worktrees)
}

fn project_from_id(id: String, open_worktrees: &OpenWorktrees) -> Result<Project, String> {
    let output = git_output_bytes(&id, &["--git-dir", &id, "worktree", "list", "--porcelain", "-z"])
        .ok_or_else(|| "Could not list Git worktrees.".to_string())?;
    let output = String::from_utf8(output).map_err(|error| error.to_string())?;
    let records = parse_worktree_records(&output);
    let name = records
        .first()
        .map(|record| project_name(&record.path))
        .ok_or_else(|| "No usable Git worktrees were found.".to_string())?;
    // A bare repository lists itself first without being a worktree anyone can open.
    let mut worktrees = records
        .into_iter()
        .filter(|record| !record.is_bare)
        .map(normalize_worktree_record)
        .map(|worktree| {
            Worktree {
                name: worktree_name(&worktree.path),
                path: worktree.path,
                branch: worktree.branch,
                head: worktree.head,
                is_main: worktree.is_main,
                is_detached: worktree.is_detached,
                is_locked: worktree.is_locked,
                is_prunable: worktree.is_prunable,
                is_open: false,
            }
        })
        .collect::<Vec<_>>();

    {
        let open_worktrees = open_worktrees.0.lock().map_err(|error| error.to_string())?;
        for worktree in &mut worktrees {
            worktree.is_open = open_worktrees.values().any(|open| {
                open.project_id == id && open.worktree_path == worktree.path
            });
        }
    }

    let home = worktrees
        .iter()
        .find(|worktree| !worktree.is_prunable && worktree_path(&worktree.path).is_ok())
        .ok_or_else(|| "No usable Git worktrees were found.".to_string())?;
    Ok(Project {
        id,
        name,
        path: home.path.clone(),
        worktrees,
    })
}

pub(crate) fn recent_project_list(open_worktrees: &OpenWorktrees) -> Result<Vec<Project>, String> {
    let mut project_ids = HashSet::new();
    Ok(load_recent_paths()?
        .into_iter()
        .filter_map(|path| project_at(&path, open_worktrees).ok())
        .filter(|project| project_ids.insert(project.id.clone()))
        .collect())
}

pub(crate) fn remember_repository(
    path: &str,
    open_worktrees: &OpenWorktrees,
    app: Option<&AppHandle>,
) -> Result<Project, String> {
    let worktree_path = worktree_path(path)?;
    let project = project_at(&worktree_path, open_worktrees)?;
    add_sidebar_project(&project.id, app)?;
    save_recent_path(&project.path, app)?;
    Ok(project)
}

#[tauri::command]
pub(crate) fn recent_projects(open_worktrees: tauri::State<OpenWorktrees>) -> Result<Vec<Project>, String> {
    recent_project_list(&open_worktrees)
}

#[tauri::command]
pub(crate) fn clear_recent_projects(app: AppHandle) -> Result<(), String> {
    clear_recent_paths(Some(&app))
}

#[tauri::command(async)]
pub(crate) fn sidebar_projects(open_worktrees: tauri::State<OpenWorktrees>) -> Result<Vec<Project>, String> {
    sidebar_project_list(&open_worktrees)
}

#[tauri::command(async)]
pub(crate) fn remove_sidebar_project(app: AppHandle, project: String) -> Result<(), String> {
    remove_sidebar_project_at(&project, Some(&app))
}

#[tauri::command]
pub(crate) fn project_snapshot(
    path: String,
    open_worktrees: tauri::State<OpenWorktrees>,
) -> Result<Project, String> {
    project_at(&path, &open_worktrees)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::git_result;
    use crate::test_support::{remove_scratch_repository, scratch_repository};

    #[test]
    fn sidebar_seeding_falls_back_to_empty_when_recent_paths_cannot_be_read() {
        let recent = serde_json::from_str::<RecentRepositories>("not json")
            .map(|recent| recent.projects)
            .map_err(|error| error.to_string());
        assert!(seeded_sidebar(recent).is_empty());
        assert!(seeded_sidebar(Err("Could not read recent repositories".to_string())).is_empty());
    }

    #[test]
    fn sidebar_seeding_keeps_each_resolvable_project_once() {
        let (path, run) = scratch_repository("sidebar-seeding");
        run(&["commit", "--allow-empty", "--quiet", "-m", "init"]);
        let id = project_id(&path).unwrap();
        assert_eq!(
            seeded_sidebar(Ok(vec![path.clone(), id.clone(), format!("{path}/missing")])),
            vec![id]
        );
        remove_scratch_repository(&path);
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
    fn sidebar_projects_keep_their_order_and_set_an_unreadable_list_aside() {
        let directory = std::env::temp_dir().join(format!(
            "git-nav-sidebar-projects-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("sidebar-projects.json");

        fs::write(&path, r#"{"projects":["/b","/a"]}"#).unwrap();
        let (changed, projects) = update_sidebar_at(&path, |projects| {
            projects.push("/c".to_string());
            true
        }, || panic!("a listed sidebar must not read recent projects"))
        .unwrap();
        assert!(changed);
        assert_eq!(projects, vec!["/b", "/a", "/c"]);

        fs::write(&path, "not json").unwrap();
        let (repository, _) = scratch_repository("sidebar-reseeding");
        let id = project_id(&repository).unwrap();
        let (changed, projects) = update_sidebar_at(&path, |_| false, || Ok(vec![repository.clone()])).unwrap();
        assert!(changed);
        assert_eq!(projects, vec![id.clone()]);
        let set_aside = fs::read_dir(&directory)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains(".invalid-"))
            .count();
        assert_eq!(set_aside, 1);
        assert!(matches!(read_sidebar(&path).unwrap(), StoredSidebar::Listed(projects) if projects == vec![id.clone()]));
        fs::remove_file(&path).unwrap();
        let (_, projects) = update_sidebar_at(&path, |_| false, || Ok(vec![repository.clone()])).unwrap();
        assert_eq!(projects, vec![id]);
        remove_scratch_repository(&repository);
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn marks_the_bare_repository_entry() {
        let worktrees = parse_worktree_records(
            "worktree /workspace/project.git\0bare\0\0worktree /workspace/main\0HEAD main-sha\0branch refs/heads/main\0\0",
        );

        assert!(worktrees[0].is_bare);
        assert!(!worktrees[1].is_bare);
    }

    #[cfg(unix)]
    #[test]
    fn opening_a_ninth_project_preserves_recents_and_explicit_bare_identities() {
        let isolation = std::env::temp_dir().join("git-nav-project-storage").join(std::process::id().to_string());
        let home = PathBuf::from(std::env::var_os("HOME").unwrap());
        if home.parent().and_then(Path::file_name) != Some(std::ffi::OsStr::new("git-nav-project-storage")) {
            fs::create_dir_all(&isolation).unwrap();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "projects::tests::opening_a_ninth_project_preserves_recents_and_explicit_bare_identities", "--nocapture"])
                .env("HOME", &isolation)
                .env("APPDATA", &isolation)
                .env("XDG_DATA_HOME", &isolation)
                .env("GIT_CONFIG_COUNT", "1")
                .env("GIT_CONFIG_KEY_0", "safe.bareRepository")
                .env("GIT_CONFIG_VALUE_0", "explicit")
                .output().unwrap();
            fs::remove_dir_all(&isolation).unwrap();
            assert!(output.status.success(), "{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
            return;
        }
        assert!(data_dir().unwrap().starts_with(&home));
        let repositories = (0..9).map(|index| {
            let (path, run) = scratch_repository(&format!("sidebar-migration-{index}"));
            run(&["commit", "--allow-empty", "--quiet", "-m", "init"]);
            path
        }).collect::<Vec<_>>();
        write_recent_paths(repositories[..8].to_vec()).unwrap();
        let open = OpenWorktrees::default();
        remember_repository(&repositories[8], &open, None).unwrap();
        let projects = sidebar_project_list(&open).unwrap();
        assert_eq!(projects.len(), 9);
        assert_eq!(projects[7].id, project_id(&repositories[7]).unwrap());
        assert_eq!(load_recent_paths().unwrap().len(), MAX_RECENT_REPOSITORIES);
        let bare = home.join("origin.git").to_string_lossy().into_owned();
        let checkout = home.join("checkout").to_string_lossy().into_owned();
        assert!(git_result(&repositories[0], &["clone", "--bare", "--quiet", &repositories[0], &bare]).unwrap().status.success());
        assert!(git_result(&repositories[0], &["--git-dir", &bare, "worktree", "add", "--quiet", &checkout, "main"]).unwrap().status.success());
        assert!(project_id(&bare).is_err());
        let opened = remember_repository(&checkout, &open, None).unwrap();
        let projects = sidebar_project_list(&open).unwrap();
        assert!(projects.iter().any(|project| project.id == opened.id && project.path == opened.path));
        for path in repositories { remove_scratch_repository(&path); }
    }

    #[test]
    fn submodule_snapshot_and_scoped_status_use_the_checkout_path() {
        let (path, run) = scratch_repository("submodule-project");
        let (source, source_run) = scratch_repository("submodule-source");
        fs::write(Path::new(&source).join("tracked"), "base").unwrap();
        source_run(&["add", "."]);
        source_run(&["commit", "--quiet", "-m", "base"]);
        run(&["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", &source, "sub"]);
        let checkout = worktree_path(&format!("{path}/sub")).unwrap();
        fs::write(Path::new(&checkout).join("tracked"), "changed").unwrap();
        let git_dir = project_id(&checkout).unwrap();
        fs::write(Path::new(&git_dir).join("MERGE_HEAD"), "abc").unwrap();
        let project = project_at(&checkout, &OpenWorktrees::default()).unwrap();
        assert_eq!(project.path, checkout);
        for filter in [None, Some(vec![checkout.clone()])] {
            let statuses = crate::worktrees::worktree_status(checkout.clone(), filter).unwrap();
            let statuses = serde_json::to_value(statuses).unwrap();
            assert_eq!(statuses.as_array().unwrap().len(), 1);
            assert_eq!(statuses[0]["path"], project.worktrees[0].path);
            assert_eq!(statuses[0]["changedFiles"], 1);
            assert_eq!(statuses[0]["pendingOperation"], "merge");
        }
        remove_scratch_repository(&path);
        remove_scratch_repository(&source);
    }

    #[test]
    fn a_bare_repository_skips_a_missing_locked_checkout() {
        let (path, run) = scratch_repository("bare-locked-project");
        run(&["commit", "--allow-empty", "--quiet", "-m", "init"]);
        let bare = format!("{path}-origin.git");
        let missing = format!("{path}-a-missing");
        let existing = format!("{path}-b-existing");
        run(&["clone", "--bare", "--quiet", &path, &bare]);
        run(&["--git-dir", &bare, "worktree", "add", "--quiet", &missing, "main"]);
        run(&["--git-dir", &bare, "worktree", "add", "--quiet", "-b", "existing", &existing]);
        run(&["--git-dir", &bare, "worktree", "lock", &missing]);
        remove_scratch_repository(&missing);
        let project = project_from_id(project_id(&existing).unwrap(), &OpenWorktrees::default()).unwrap();
        assert!(project.worktrees[0].is_locked);
        assert!(!project.worktrees[0].is_prunable);
        assert_eq!(project.path, worktree_path(&existing).unwrap());
        remove_scratch_repository(&existing);
        remove_scratch_repository(&bare);
        remove_scratch_repository(&path);
    }

    #[test]
    fn a_bare_repository_opens_at_its_first_worktree() {
        let (path, run) = scratch_repository("bare-project");
        run(&["commit", "--allow-empty", "--quiet", "-m", "init"]);
        let bare = format!("{path}-origin.git");
        let checkout = format!("{path}-checkout");
        let _ = fs::remove_dir_all(&bare);
        let _ = fs::remove_dir_all(&checkout);
        assert!(git_result(&path, &["clone", "--bare", "--quiet", &path, &bare]).unwrap().status.success());
        assert!(git_result(&bare, &["worktree", "add", "--quiet", &checkout, "main"]).unwrap().status.success());

        let project = project_at(&checkout, &OpenWorktrees::default()).unwrap();

        assert_eq!(project.path, worktree_path(&checkout).unwrap());
        assert_eq!(project.name, format!("{}-origin", worktree_name(&path)));
        assert_eq!(project.worktrees.len(), 1);
        assert!(!project.worktrees[0].is_main);
        assert_eq!(project_id(&bare).unwrap(), project.id);
        assert_eq!(
            project_from_id(project.id.clone(), &OpenWorktrees::default()).unwrap().path,
            project.path
        );
        remove_scratch_repository(&checkout);
        remove_scratch_repository(&bare);
        remove_scratch_repository(&path);
    }
}
