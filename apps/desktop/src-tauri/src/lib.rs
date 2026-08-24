use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Command, Stdio},
};
use tauri::{ipc::Channel, AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const MAX_RECENT_REPOSITORIES: usize = 8;
const COMMIT_BATCH_SIZE: usize = 500;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Repository {
    path: String,
    name: String,
    branch: String,
    remote: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct RecentRepositories {
    repositories: Vec<String>,
}

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
        .map(|recent| recent.repositories)
        .map_err(|error| error.to_string())
}

fn save_recent_path(app: &AppHandle, repository_path: &str) -> Result<(), String> {
    let mut paths = load_recent_paths(app)?;
    paths.retain(|path| path != repository_path);
    paths.insert(0, repository_path.to_string());
    paths.truncate(MAX_RECENT_REPOSITORIES);

    let contents = serde_json::to_string(&RecentRepositories {
        repositories: paths,
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

fn repository_at(path: &str) -> Result<Repository, String> {
    let repository_path = git_output(path, &["rev-parse", "--show-toplevel"])
        .ok_or_else(|| "Choose a Git repository.".to_string())?;
    let name = PathBuf::from(&repository_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&repository_path)
        .to_string();

    Ok(Repository {
        path: repository_path.clone(),
        name,
        branch: git_output(&repository_path, &["branch", "--show-current"])
            .unwrap_or_else(|| "Detached HEAD".to_string()),
        remote: git_output(&repository_path, &["remote", "get-url", "origin"]),
    })
}

#[tauri::command]
fn recent_repositories(app: AppHandle) -> Result<Vec<Repository>, String> {
    let repositories = load_recent_paths(&app)?
        .into_iter()
        .filter_map(|path| repository_at(&path).ok())
        .collect();

    Ok(repositories)
}

fn open_repository_window(app: &AppHandle, path: &str) -> Result<(), String> {
    let repository = repository_at(&path)?;
    save_recent_path(app, &repository.path)?;

    let label = format!(
        "repository-{}",
        repository.path.as_bytes().iter().fold(0u64, |hash, byte| {
            hash.wrapping_mul(31).wrapping_add(*byte as u64)
        })
    );

    if let Some(window) = app.get_webview_window(&label) {
        window.set_focus().map_err(|error| error.to_string())?;
    } else {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("repository", &repository.path)
            .finish();
        let url = format!("/?{query}");
        WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
            .title(format!("{} · Git Nav", repository.name))
            .inner_size(800.0, 600.0)
            .build()
            .map_err(|error| error.to_string())?;
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
        .invoke_handler(tauri::generate_handler![
            recent_repositories,
            open_repository,
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
