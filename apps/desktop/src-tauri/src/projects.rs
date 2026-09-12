use serde::{Deserialize, Serialize};
use std::{collections::HashMap, collections::HashSet, fs, path::PathBuf, sync::Arc, sync::Mutex};
use tauri::{AppHandle, Emitter};
use crate::storage::data_dir;
use crate::git::{git_output_bytes, project_id, worktree_name, worktree_path};
use crate::window::update_recent_menu;

const RECENT_PROJECTS_CLEARED_EVENT: &str = "recent-projects-cleared";

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

pub(crate) fn project_at(path: &str, open_worktrees: &OpenWorktrees) -> Result<Project, String> {
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

pub(crate) fn recent_project_list(open_worktrees: &OpenWorktrees) -> Result<Vec<Project>, String> {
    let mut project_ids = HashSet::new();
    Ok(load_recent_paths()?
        .into_iter()
        .filter_map(|path| project_at(&path, open_worktrees).ok())
        .filter(|project| project_ids.insert(project.id.clone()))
        .collect())
}

/// Canonicalizes a user-supplied path to its worktree root and records it as recently opened.
pub(crate) fn remember_repository(
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
pub(crate) fn recent_projects(open_worktrees: tauri::State<OpenWorktrees>) -> Result<Vec<Project>, String> {
    recent_project_list(&open_worktrees)
}

#[tauri::command]
pub(crate) fn clear_recent_projects(app: AppHandle) -> Result<(), String> {
    clear_recent_paths(Some(&app))
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
}
