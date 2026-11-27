use serde::Serialize;
use std::{
    collections::BTreeMap, fs, io::Write, path::Path, path::PathBuf, time::SystemTime,
    time::UNIX_EPOCH,
};
use tauri::{AppHandle, Emitter};
use crate::git::resolve_project_id;
use crate::projects::{WindowProjects, project_at, project_with_id};

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

fn project_layouts_path() -> Result<PathBuf, String> {
    data_dir().map(|dir| dir.join("project-layouts.json"))
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

pub(crate) fn malformed_settings_path(path: &Path) -> PathBuf {
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

pub(crate) fn with_locked_file<T>(
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

pub(crate) fn write_json_atomically(path: &Path, value: &impl Serialize) -> Result<(), String> {
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

pub(crate) type ProjectLayouts = BTreeMap<String, BTreeMap<String, serde_json::Value>>;

fn parse_project_layouts(contents: &str) -> Result<ProjectLayouts, serde_json::Error> {
    serde_json::from_str(contents)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectLayout {
    path: String,
    layout: Option<serde_json::Value>,
}

pub(crate) fn load_project_layout(project: String, client_id: String) -> Result<ProjectLayout, String> {
    load_project_layout_at(&project_layouts_path()?, &project, &client_id)
}

fn load_project_layout_at(storage_path: &Path, project: &str, client_id: &str) -> Result<ProjectLayout, String> {
    let project = project_with_id(project, &WindowProjects::default())?;
    let contents = match fs::read_to_string(storage_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ProjectLayout { path: project.path, layout: None })
        }
        Err(error) => return Err(error.to_string()),
    };
    let layouts = parse_project_layouts(&contents).unwrap_or_default();
    Ok(ProjectLayout {
        layout: layouts
            .get(client_id)
            .and_then(|layouts| layouts.get(&project.id))
            .cloned(),
        path: project.path,
    })
}

fn read_project_layouts(storage_path: &Path) -> Result<ProjectLayouts, String> {
    match fs::read_to_string(storage_path) {
        Ok(contents) => match parse_project_layouts(&contents) {
            Ok(layouts) => Ok(layouts),
            Err(_) => {
                fs::rename(storage_path, malformed_settings_path(storage_path))
                    .map_err(|error| error.to_string())?;
                Ok(ProjectLayouts::new())
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ProjectLayouts::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn write_project_layout_at(
    storage_path: &Path,
    project: String,
    client_id: String,
    layout: serde_json::Value,
) -> Result<(), String> {
    with_locked_file(storage_path, || {
        let mut layouts = read_project_layouts(storage_path)?;
        layouts.entry(client_id).or_default().insert(project, layout);
        write_json_atomically(storage_path, &layouts)
    })
}

fn save_project_layout_at(
    storage_path: &Path,
    project: String,
    client_id: String,
    layout: serde_json::Value,
) -> Result<(), String> {
    write_project_layout_at(storage_path, resolve_project_id(&project)?, client_id, layout)
}

pub(crate) fn migrate_repository_layouts() -> Result<(), String> {
    migrate_repository_layouts_in(&data_dir()?)
}

fn home_project_id(path: &str) -> Option<String> {
    project_at(path, &WindowProjects::default())
        .ok()
        .filter(|project| project.path == path)
        .map(|project| project.id)
}

// Layouts used to be saved per worktree; each project keeps the one its home checkout had.
// Layouts already in the project store win, so a legacy store written by an older build never replaces them.
fn migrate_repository_layouts_in(directory: &Path) -> Result<(), String> {
    let legacy_path = directory.join("repository-layouts.json");
    if !legacy_path.exists() {
        return Ok(());
    }
    with_locked_file(&legacy_path, || {
        let contents = match fs::read_to_string(&legacy_path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.to_string()),
        };
        let legacy = parse_project_layouts(&contents).unwrap_or_default();
        let storage_path = directory.join("project-layouts.json");
        with_locked_file(&storage_path, || {
            let mut layouts = read_project_layouts(&storage_path)?;
            let mut home_projects = BTreeMap::<String, Option<String>>::new();
            for (client_id, legacy_layouts) in legacy {
                for (path, layout) in legacy_layouts {
                    let project = home_projects
                        .entry(path.clone())
                        .or_insert_with(|| home_project_id(&path))
                        .clone();
                    if let Some(project) = project {
                        layouts
                            .entry(client_id.clone())
                            .or_default()
                            .entry(project)
                            .or_insert(layout);
                    }
                }
            }
            write_json_atomically(&storage_path, &layouts)
        })?;
        fs::remove_file(&legacy_path).map_err(|error| error.to_string())
    })?;
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())?.flatten() {
        if entry.file_name().to_string_lossy().starts_with("repository-layouts.") {
            fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
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

#[tauri::command(async)]
pub(crate) fn project_layout(project: String, client_id: String) -> Result<ProjectLayout, String> {
    load_project_layout(project, client_id)
}

#[tauri::command]
pub(crate) fn save_project_layout(
    project: String,
    client_id: String,
    layout: serde_json::Value,
) -> Result<(), String> {
    save_project_layout_at(&project_layouts_path()?, project, client_id, layout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use crate::git::{project_id, worktree_path};
    use crate::test_support::{remove_scratch_repository, rerun_with_explicit_bare_repositories, scratch_repository};

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
    fn stores_project_layouts_by_client_and_project() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            env::temp_dir().join(format!("git-nav-layouts-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("project-layouts.json");
        let desktop_layout = serde_json::json!({ "version": 1, "layout": {} });
        let browser_layout = serde_json::json!({ "version": 2 });

        write_project_layout_at(
            &path,
            "/repositories/one/.git".to_string(),
            "desktop".to_string(),
            desktop_layout.clone(),
        )
        .unwrap();
        write_project_layout_at(
            &path,
            "/repositories/one/.git".to_string(),
            "browser".to_string(),
            browser_layout.clone(),
        )
        .unwrap();

        let layouts: ProjectLayouts = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            layouts.get("desktop").and_then(|entries| entries.get("/repositories/one/.git")),
            Some(&desktop_layout)
        );
        assert_eq!(
            layouts.get("browser").and_then(|entries| entries.get("/repositories/one/.git")),
            Some(&browser_layout)
        );

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn normalizes_project_layout_keys_before_saving() {
        let (repository, _) = scratch_repository("layout-path");
        let directory = PathBuf::from(&repository);
        let storage_path = directory.join("project-layouts.json");
        fs::create_dir_all(directory.join("src")).unwrap();
        let layout = serde_json::json!({ "version": 1 });

        save_project_layout_at(
            &storage_path,
            format!("{repository}/src/../.git"),
            "browser".to_string(),
            layout.clone(),
        )
        .unwrap();

        let layouts: ProjectLayouts =
            serde_json::from_str(&fs::read_to_string(storage_path).unwrap()).unwrap();
        let project = project_id(&repository).unwrap();
        assert_eq!(
            layouts
                .get("browser")
                .and_then(|entries| entries.get(&project)),
            Some(&layout)
        );

        remove_scratch_repository(&repository);
    }

    #[test]
    fn saves_and_loads_a_bare_repository_layout_when_bare_repositories_must_be_explicit() {
        if rerun_with_explicit_bare_repositories(
            "storage::tests::saves_and_loads_a_bare_repository_layout_when_bare_repositories_must_be_explicit",
        ) {
            return;
        }
        let (path, run) = scratch_repository("layout-explicit-bare");
        run(&["commit", "--allow-empty", "--quiet", "-m", "init"]);
        let bare = format!("{path}-origin.git");
        let checkout = format!("{path}-checkout");
        run(&["clone", "--bare", "--quiet", &path, &bare]);
        run(&["--git-dir", &bare, "worktree", "add", "--quiet", &checkout, "main"]);
        let project = project_id(&checkout).unwrap();
        let directory = layouts_directory("layout-explicit-bare-store");
        let storage_path = directory.join("project-layouts.json");
        let layout = serde_json::json!({ "version": 1 });

        save_project_layout_at(&storage_path, project.clone(), "desktop".to_string(), layout.clone()).unwrap();
        let loaded = load_project_layout_at(&storage_path, &project, "desktop").unwrap();

        assert_eq!(loaded.path, worktree_path(&checkout).unwrap());
        assert_eq!(loaded.layout, Some(layout));
        fs::remove_dir_all(directory).unwrap();
        remove_scratch_repository(&checkout);
        remove_scratch_repository(&bare);
        remove_scratch_repository(&path);
    }

    #[test]
    fn preserves_malformed_project_layouts_before_starting_a_new_store() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = env::temp_dir().join(format!(
            "git-nav-layouts-malformed-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("project-layouts.json");
        fs::write(&path, "{malformed").unwrap();
        let layout = serde_json::json!({ "version": 1 });

        write_project_layout_at(
            &path,
            "/repositories/one/.git".to_string(),
            "desktop".to_string(),
            layout.clone(),
        )
        .unwrap();

        let layouts: ProjectLayouts =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            layouts
                .get("desktop")
                .and_then(|entries| entries.get("/repositories/one/.git")),
            Some(&layout)
        );
        let backups = fs::read_dir(&directory)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("project-layouts.invalid-")
            })
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read_to_string(backups[0].path()).unwrap(), "{malformed");

        fs::remove_dir_all(directory).unwrap();
    }

    fn layouts_directory(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = env::temp_dir().join(format!("git-nav-{name}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn stored_files(directory: &Path) -> Vec<String> {
        let mut files = fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        files.sort();
        files
    }

    #[test]
    fn migration_keeps_each_projects_home_layout_and_removes_the_old_store() {
        let (path, run) = scratch_repository("layout-migration");
        run(&["commit", "--allow-empty", "--quiet", "-m", "init"]);
        let linked = format!("{path}-linked");
        run(&["worktree", "add", "--quiet", "-b", "linked", &linked]);
        let home = worktree_path(&path).unwrap();
        let linked = worktree_path(&linked).unwrap();
        let directory = layouts_directory("layout-migration-store");
        let legacy = serde_json::json!({
            "desktop": {
                home.clone(): { "tabs": "desktop home" },
                linked.clone(): { "tabs": "desktop linked" },
                format!("{path}-missing"): { "tabs": "missing" },
            },
            "browser": {
                home.clone(): { "tabs": "browser home" },
            },
            "phone": {
                linked.clone(): { "tabs": "phone linked" },
            },
        });
        fs::write(directory.join("repository-layouts.json"), legacy.to_string()).unwrap();
        fs::write(directory.join("repository-layouts.lock"), "").unwrap();
        fs::write(directory.join("repository-layouts.invalid-1-0.json"), "{malformed").unwrap();

        migrate_repository_layouts_in(&directory).unwrap();

        let project = project_id(&path).unwrap();
        let migrated: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(directory.join("project-layouts.json")).unwrap()).unwrap();
        assert_eq!(
            migrated,
            serde_json::json!({
                "desktop": { project.clone(): { "tabs": "desktop home" } },
                "browser": { project: { "tabs": "browser home" } },
            })
        );
        assert_eq!(stored_files(&directory), vec!["project-layouts.json", "project-layouts.lock"]);

        fs::remove_dir_all(directory).unwrap();
        remove_scratch_repository(&linked);
        remove_scratch_repository(&path);
    }

    #[test]
    fn migration_keeps_the_first_worktree_layout_of_a_bare_repository() {
        let (path, run) = scratch_repository("layout-migration-bare");
        run(&["commit", "--allow-empty", "--quiet", "-m", "init"]);
        let bare = format!("{path}-origin.git");
        let first = format!("{path}-first");
        let second = format!("{path}-second");
        for stale in [&bare, &first, &second] {
            let _ = fs::remove_dir_all(stale);
        }
        let git = |directory: &str, arguments: &[&str]| {
            assert!(crate::git::git_result(directory, arguments).unwrap().status.success());
        };
        git(&path, &["clone", "--bare", "--quiet", &path, &bare]);
        git(&bare, &["worktree", "add", "--quiet", &first, "main"]);
        git(&bare, &["worktree", "add", "--quiet", "-b", "second", &second]);
        let directory = layouts_directory("layout-migration-bare-store");
        let legacy = serde_json::json!({
            "desktop": {
                worktree_path(&first).unwrap(): { "tabs": "first" },
                worktree_path(&second).unwrap(): { "tabs": "second" },
            },
        });
        fs::write(directory.join("repository-layouts.json"), legacy.to_string()).unwrap();

        migrate_repository_layouts_in(&directory).unwrap();

        let migrated: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(directory.join("project-layouts.json")).unwrap()).unwrap();
        assert_eq!(
            migrated,
            serde_json::json!({ "desktop": { project_id(&bare).unwrap(): { "tabs": "first" } } })
        );

        fs::remove_dir_all(directory).unwrap();
        for checkout in [&second, &first, &bare] {
            remove_scratch_repository(checkout);
        }
        remove_scratch_repository(&path);
    }

    #[test]
    fn migration_keeps_layouts_already_in_the_project_store() {
        let (path, run) = scratch_repository("layout-migration-existing");
        run(&["commit", "--allow-empty", "--quiet", "-m", "init"]);
        let home = worktree_path(&path).unwrap();
        let project = project_id(&path).unwrap();
        let directory = layouts_directory("layout-migration-existing-store");
        fs::write(
            directory.join("project-layouts.json"),
            serde_json::json!({ "desktop": { project.clone(): { "tabs": "desktop current" } } })
                .to_string(),
        )
        .unwrap();
        let legacy = serde_json::json!({
            "desktop": { home.clone(): { "tabs": "desktop legacy" } },
            "browser": { home.clone(): { "tabs": "browser legacy" } },
        });
        fs::write(directory.join("repository-layouts.json"), legacy.to_string()).unwrap();

        migrate_repository_layouts_in(&directory).unwrap();

        let migrated: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(directory.join("project-layouts.json")).unwrap()).unwrap();
        assert_eq!(
            migrated,
            serde_json::json!({
                "desktop": { project.clone(): { "tabs": "desktop current" } },
                "browser": { project: { "tabs": "browser legacy" } },
            })
        );

        fs::remove_dir_all(directory).unwrap();
        remove_scratch_repository(&path);
    }

    #[test]
    fn migration_leaves_a_store_without_the_old_file_untouched() {
        let directory = layouts_directory("layout-migration-none");

        migrate_repository_layouts_in(&directory).unwrap();

        assert!(stored_files(&directory).is_empty());
        fs::remove_dir_all(directory).unwrap();
    }
}
