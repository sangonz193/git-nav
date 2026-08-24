use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
};
use tauri::{ipc::Channel, AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const MAX_RECENT_REPOSITORIES: usize = 8;
const COMMIT_BATCH_SIZE: usize = 500;

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

struct WorktreeRecord {
    path: String,
    branch: String,
    head: String,
    is_main: bool,
    is_detached: bool,
    is_locked: bool,
    is_prunable: bool,
}

#[derive(Default, Deserialize, Serialize)]
struct RecentRepositories {
    #[serde(default)]
    projects: Vec<String>,
    #[serde(default)]
    repositories: Vec<String>,
}

#[derive(Clone)]
struct OpenWorktree {
    project_id: String,
    worktree_path: String,
}

#[derive(Default)]
struct OpenWorktrees(Mutex<HashMap<String, OpenWorktree>>);

fn recent_repositories_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    Ok(data_dir.join("recent-repositories.json"))
}

fn load_recent_paths(app: &AppHandle) -> Result<Vec<String>, String> {
    let path = recent_repositories_path(app)?;
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

fn save_recent_path(app: &AppHandle, repository_path: &str) -> Result<(), String> {
    let mut paths = load_recent_paths(app)?;
    paths.retain(|path| path != repository_path);
    paths.insert(0, repository_path.to_string());
    paths.truncate(MAX_RECENT_REPOSITORIES);

    let contents = serde_json::to_string(&RecentRepositories {
        projects: paths,
        repositories: Vec::new(),
    })
    .map_err(|error| error.to_string())?;
    fs::write(recent_repositories_path(app)?, contents).map_err(|error| error.to_string())
}

fn git_output(path: &str, arguments: &[&str]) -> Option<String> {
    let output = Command::new("git")
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
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .output()
        .ok()?;

    output.status.success().then_some(output.stdout)
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

#[tauri::command]
fn recent_projects(
    app: AppHandle,
    open_worktrees: tauri::State<OpenWorktrees>,
) -> Result<Vec<Project>, String> {
    let mut project_ids = HashSet::new();
    Ok(load_recent_paths(&app)?
        .into_iter()
        .filter_map(|path| project_at(&path, &open_worktrees).ok())
        .filter(|project| project_ids.insert(project.id.clone()))
        .collect())
}

#[tauri::command]
fn project_snapshot(
    path: String,
    open_worktrees: tauri::State<OpenWorktrees>,
) -> Result<Project, String> {
    project_at(&path, &open_worktrees)
}

fn open_repository_window(app: &AppHandle, path: &str) -> Result<(), String> {
    let worktree_path = worktree_path(path)?;
    let project = project_at(&worktree_path, &app.state::<OpenWorktrees>())?;
    save_recent_path(app, &project.path)?;
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
        let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
            .title(format!("{} · Git Nav", worktree_name(&worktree_path)))
            .inner_size(800.0, 600.0)
            .build()
            .map_err(|error| error.to_string())?;
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

fn lane_for(lanes: &mut Vec<Option<String>>, hash: &str) -> usize {
    if let Some(index) = lanes
        .iter()
        .position(|waiting_for| waiting_for.as_deref() == Some(hash))
    {
        return index;
    }

    if let Some(index) = lanes.iter().position(Option::is_none) {
        return index;
    }

    lanes.push(None);
    lanes.len() - 1
}

fn parse_commit(line: &str, lanes: &mut Vec<Option<String>>) -> Option<Vec<serde_json::Value>> {
    let fields: Vec<_> = line.split('\0').collect();
    if fields.len() != 6 || fields[0].is_empty() {
        return None;
    }

    let hash = fields[0];
    let parents: Vec<_> = fields[1]
        .split_whitespace()
        .filter(|parent| !parent.is_empty())
        .collect();
    let lane = lane_for(lanes, hash);
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
            let parent_lane = lane_for(lanes, parent);
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

#[tauri::command]
fn stream_commit_graph(
    repo_path: String,
    on_batch: Channel<Vec<Vec<serde_json::Value>>>,
) -> Result<(), String> {
    let mut child = Command::new("git")
        .args([
            "--no-optional-locks",
            "-C",
            &repo_path,
            "log",
            "--all",
            "--topo-order",
            "--format=%H%x00%P%x00%an%x00%aI%x00%D%x00%s",
        ])
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read git output.".to_string())?;
    let mut lanes = Vec::new();
    let mut batch = Vec::with_capacity(COMMIT_BATCH_SIZE);

    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|error| error.to_string())?;
        if let Some(commit) = parse_commit(&line, &mut lanes) {
            batch.push(commit);
        }

        if batch.len() == COMMIT_BATCH_SIZE {
            on_batch.send(batch).map_err(|error| error.to_string())?;
            batch = Vec::with_capacity(COMMIT_BATCH_SIZE);
        }
    }

    if !batch.is_empty() {
        on_batch.send(batch).map_err(|error| error.to_string())?;
    }

    let status = child.wait().map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("git log failed.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_the_invocation_directory_for_relative_paths() {
        let path = repository_path_from_args(
            &["git-nav".to_string(), "repository".to_string()],
            "/workspace",
        );

        assert_eq!(path.as_deref(), Some("/workspace/repository"));
    }

    #[test]
    fn preserves_absolute_paths() {
        let path = repository_path_from_args(
            &["git-nav".to_string(), "/workspace/repository".to_string()],
            "/other-workspace",
        );

        assert_eq!(path.as_deref(), Some("/workspace/repository"));
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
    fn assigns_a_lane_and_reuses_it_for_the_first_parent() {
        let mut lanes = Vec::new();
        let commit =
            parse_commit("a\0b\0Ada\02026-01-01T00:00:00+00:00\0\0first", &mut lanes).unwrap();

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
            parse_commit("a\0\0Ada\02026-01-01T00:00:00+00:00\0\0root", &mut lanes).unwrap();

        assert_eq!(commit[8], 0);
        assert_eq!(commit[9], serde_json::json!([0]));
        assert_eq!(commit[10], serde_json::json!([]));
        assert!(lanes.is_empty());
    }

    #[test]
    fn frees_duplicate_lanes_after_a_commit_is_seen() {
        let mut lanes = vec![Some("a".to_string()), Some("a".to_string())];
        parse_commit("a\0b\0Ada\02026-01-01T00:00:00+00:00\0\0commit", &mut lanes).unwrap();

        assert_eq!(lanes, vec![Some("b".to_string())]);
    }
}

#[tauri::command]
fn open_repository(app: AppHandle, path: String) -> Result<(), String> {
    open_repository_window(&app, &path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<_> = env::args().collect();
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
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(OpenWorktrees::default())
        .invoke_handler(tauri::generate_handler![
            recent_projects,
            open_repository,
            project_snapshot,
            stream_commit_graph
        ])
        .setup(move |app| {
            if let Some(path) = &repository_path {
                open_repository_window(app.handle(), path)?;
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
