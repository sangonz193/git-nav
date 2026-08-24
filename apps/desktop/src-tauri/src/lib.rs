use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, process::Command};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const MAX_RECENT_REPOSITORIES: usize = 8;

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

#[tauri::command]
fn open_repository(app: AppHandle, path: String) -> Result<(), String> {
    let repository = repository_at(&path)?;
    save_recent_path(&app, &repository.path)?;

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
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            recent_repositories,
            open_repository
        ])
        .setup(|app| {
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
