use serde::Serialize;
use crate::git::{OperationResult, git_output_allow_empty, resolve_commit};
use crate::worktrees::idle_worktree;
use crate::operations::run_worktree_operation;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StashEntry {
    pub(crate) name: String,
    pub(crate) sha: String,
    pub(crate) base: Option<String>,
    pub(crate) message: String,
    pub(crate) branch: Option<String>,
    pub(crate) date: String,
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
pub(crate) fn stash_list(repo_path: String) -> Result<Vec<StashEntry>, String> {
    let output = git_output_allow_empty(
        &repo_path,
        &["stash", "list", "-z", "--format=%gd%x1f%H%x1f%gs%x1f%aI%x1f%P"],
    )?;
    Ok(parse_stash_entries(&output))
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn stash_changes(repo_path: String, message: Option<String>, include_untracked: bool) -> Result<OperationResult, String> {
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
pub(crate) async fn stash_action(repo_path: String, name: String, sha: String, action: String) -> Result<OperationResult, String> {
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
}
