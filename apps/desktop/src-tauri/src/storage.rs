use serde::Serialize;
use std::{
    collections::BTreeMap, fs, io::Write, path::Path, path::PathBuf, time::SystemTime,
    time::UNIX_EPOCH,
};
use tauri::{AppHandle, Emitter};
use crate::git::worktree_path;

pub(crate) const APPLICATION_IDENTIFIER: &str = "com.gitnav.desktop";
pub(crate) const SETTING_CHANGED_EVENT: &str = "setting-changed";

/// Mirrors Tauri's `app_data_dir` so the desktop app and `git-nav serve` share one store.
pub(crate) fn data_dir() -> Result<PathBuf, String> {
    let data_dir = dirs::data_dir()
        .ok_or_else(|| "Could not locate the user data directory.".to_string())?
        .join(APPLICATION_IDENTIFIER);
    fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    Ok(data_dir)
}

pub(crate) fn settings_path() -> Result<PathBuf, String> {
    data_dir().map(|dir| dir.join("settings.json"))
}

fn repository_layouts_path() -> Result<PathBuf, String> {
    data_dir().map(|dir| dir.join("repository-layouts.json"))
}

pub(crate) enum StoredSettings {
    Valid(BTreeMap<String, serde_json::Value>),
    Malformed,
}

#[derive(Clone, Serialize)]
pub(crate) struct SettingChanged {
    pub(crate) key: String,
    pub(crate) value: serde_json::Value,
}

fn read_settings(path: &Path) -> Result<StoredSettings, String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => {
            restrict_to_owner(path)?;
            contents
        }
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

pub(crate) fn load_settings() -> Result<BTreeMap<String, serde_json::Value>, String> {
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

pub(crate) fn save_setting_at_then(
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
    let mut temporary = open_owner_only_file(&temporary_path)?;
    temporary
        .write_all(contents.as_bytes())
        .map_err(|error| error.to_string())?;
    // std::fs::rename replaces an existing destination on every platform, including Windows via MoveFileExW.
    fs::rename(temporary_path, path).map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(unix)]
fn open_owner_only_file(path: &Path) -> Result<fs::File, String> {
    use std::os::unix::fs::OpenOptionsExt;

    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| error.to_string())?;
    restrict_to_owner(path)?;
    Ok(file)
}

#[cfg(not(unix))]
fn open_owner_only_file(path: &Path) -> Result<fs::File, String> {
    fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
        .map_err(|error| error.to_string())
}

#[cfg(unix)]
fn restrict_to_owner(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn restrict_to_owner(_: &Path) -> Result<(), String> {
    Ok(())
}

fn save_setting_at(path: &Path, key: String, value: serde_json::Value) -> Result<(), String> {
    save_setting_at_then(path, key, value, || Ok(()))
}

pub(crate) fn save_setting(key: String, value: serde_json::Value) -> Result<(), String> {
    save_setting_at(&settings_path()?, key, value)
}

pub(crate) type RepositoryLayouts = BTreeMap<String, BTreeMap<String, serde_json::Value>>;

fn parse_repository_layouts(contents: &str) -> Result<RepositoryLayouts, serde_json::Error> {
    serde_json::from_str(contents)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepositoryLayout {
    path: String,
    layout: Option<serde_json::Value>,
}

pub(crate) fn load_repository_layout(path: String, client_id: String) -> Result<RepositoryLayout, String> {
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

#[tauri::command]
pub(crate) fn settings() -> Result<BTreeMap<String, serde_json::Value>, String> {
    load_settings()
}

#[tauri::command]
pub(crate) fn set_setting(app: AppHandle, key: String, value: serde_json::Value) -> Result<(), String> {
    save_setting_at_then(&settings_path()?, key.clone(), value.clone(), || {
        app.emit(SETTING_CHANGED_EVENT, SettingChanged { key, value })
            .map_err(|error| error.to_string())
    })
}

#[tauri::command]
pub(crate) fn repository_layout(path: String, client_id: String) -> Result<RepositoryLayout, String> {
    load_repository_layout(path, client_id)
}

#[tauri::command]
pub(crate) fn save_repository_layout(
    path: String,
    client_id: String,
    layout: serde_json::Value,
) -> Result<(), String> {
    save_repository_layout_at(&repository_layouts_path()?, path, client_id, layout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use crate::test_support::{remove_scratch_repository, scratch_repository};

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

    #[cfg(unix)]
    #[test]
    fn saving_settings_uses_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = env::temp_dir().join(format!(
            "git-nav-settings-permissions-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("settings.json");

        save_setting_at(&path, "key".to_string(), serde_json::json!(true)).unwrap();

        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn reading_settings_restricts_an_existing_file_to_its_owner() {
        use std::os::unix::fs::PermissionsExt;

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = env::temp_dir().join(format!(
            "git-nav-settings-permissions-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("settings.json");
        fs::write(&path, "{}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        read_settings(&path).unwrap();

        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
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
}
