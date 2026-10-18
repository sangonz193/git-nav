use serde::{Deserialize, Serialize};
use std::{fs, path::Path, path::PathBuf};
use crate::storage::{data_dir, with_locked_file, write_json_atomically};

pub(crate) const MAIN_WINDOW: &str = "main";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectWorktree {
    pub(crate) project: String,
    pub(crate) worktree: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowSession {
    pub(crate) label: String,
    #[serde(default)]
    pub(crate) active: Option<ProjectWorktree>,
}

fn window_sessions_path() -> Result<PathBuf, String> {
    data_dir().map(|dir| dir.join("window-sessions.json"))
}

fn read_sessions(path: &Path) -> Result<Vec<WindowSession>, String> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(serde_json::from_str(&contents).unwrap_or_default()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn update_sessions_at<T>(
    path: &Path,
    update: impl FnOnce(&mut Vec<WindowSession>) -> T,
) -> Result<T, String> {
    with_locked_file(path, || {
        let mut sessions = read_sessions(path)?;
        let result = update(&mut sessions);
        write_json_atomically(path, &sessions)?;
        Ok(result)
    })
}

fn upsert_session(sessions: &mut Vec<WindowSession>, session: WindowSession) {
    match sessions.iter_mut().find(|existing| existing.label == session.label) {
        Some(existing) => *existing = session,
        None => sessions.push(session),
    }
}

fn restorable_sessions(sessions: Vec<WindowSession>) -> Vec<WindowSession> {
    let mut sessions = sessions
        .into_iter()
        .filter(|session| session.active.is_some())
        .collect::<Vec<_>>();
    if let Some(index) = sessions.iter().position(|session| session.label == MAIN_WINDOW) {
        let main = sessions.remove(index);
        sessions.insert(0, main);
    }
    sessions
}

pub(crate) fn load_window_sessions() -> Result<Vec<WindowSession>, String> {
    read_sessions(&window_sessions_path()?)
}

pub(crate) fn take_restorable_window_sessions() -> Result<Vec<WindowSession>, String> {
    update_sessions_at(&window_sessions_path()?, |sessions| {
        *sessions = restorable_sessions(std::mem::take(sessions));
        sessions.clone()
    })
}

pub(crate) fn save_window_session(session: WindowSession) -> Result<(), String> {
    update_sessions_at(&window_sessions_path()?, |sessions| {
        upsert_session(sessions, session)
    })
}

pub(crate) fn forget_window_session(label: &str) -> Result<(), String> {
    update_sessions_at(&window_sessions_path()?, |sessions| {
        sessions.retain(|session| session.label != label)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn session(label: &str, worktree: Option<&str>) -> WindowSession {
        WindowSession {
            label: label.to_string(),
            active: worktree.map(|path| ProjectWorktree {
                project: path.to_string(),
                worktree: path.to_string(),
            }),
        }
    }

    #[test]
    fn restores_the_main_window_first_and_skips_empty_windows() {
        let sessions = restorable_sessions(vec![
            session("window-2", Some("/repo/b")),
            session("window-3", None),
            session(MAIN_WINDOW, Some("/repo/a")),
        ]);

        assert_eq!(
            sessions,
            vec![session(MAIN_WINDOW, Some("/repo/a")), session("window-2", Some("/repo/b"))]
        );
    }

    #[test]
    fn preserves_window_labels_when_main_was_closed() {
        let sessions = restorable_sessions(vec![
            session("window-2", Some("/repo/b")),
            session("window-4", Some("/repo/c")),
        ]);

        assert_eq!(
            sessions,
            vec![session("window-2", Some("/repo/b")), session("window-4", Some("/repo/c"))]
        );
    }

    #[test]
    fn restores_a_single_non_main_window_under_its_own_label() {
        assert_eq!(
            restorable_sessions(vec![session("window-2", Some("/repo/b"))]),
            vec![session("window-2", Some("/repo/b"))]
        );
    }

    #[test]
    fn skips_an_empty_main_window_without_renaming_other_windows() {
        assert_eq!(
            restorable_sessions(vec![
                session(MAIN_WINDOW, None),
                session("window-2", Some("/repo/b")),
            ]),
            vec![session("window-2", Some("/repo/b"))]
        );
    }

    #[test]
    fn empty_sessions_leave_no_windows_to_restore() {
        assert!(restorable_sessions(Vec::new()).is_empty());
        assert!(restorable_sessions(vec![session(MAIN_WINDOW, None)]).is_empty());
    }

    #[test]
    fn saving_replaces_the_window_entry_in_place() {
        let path = env::temp_dir().join(format!(
            "git-nav-window-sessions-{}.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);

        update_sessions_at(&path, |sessions| {
            upsert_session(sessions, session(MAIN_WINDOW, Some("/repo/a")));
            upsert_session(sessions, session("window-2", Some("/repo/b")));
        })
        .unwrap();
        update_sessions_at(&path, |sessions| {
            upsert_session(sessions, session(MAIN_WINDOW, Some("/repo/c")))
        })
        .unwrap();

        assert_eq!(
            read_sessions(&path).unwrap(),
            vec![
                session(MAIN_WINDOW, Some("/repo/c")),
                session("window-2", Some("/repo/b")),
            ]
        );
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("lock"));
    }
}
