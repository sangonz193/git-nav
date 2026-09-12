use serde::Serialize;
use std::{fs, path::Path, path::PathBuf};
use crate::projects::parse_worktree_records;
use crate::git::{
    git_output, git_output_allow_empty, primary_reference, resolve_commit, worktree_path,
};

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PendingOperation {
    Rebase,
    Merge,
    CherryPick,
    Bisect,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BranchOperability {
    exists: bool,
    sha: Option<String>,
    worktree_path: Option<String>,
    is_current_worktree: bool,
    is_dirty: bool,
    pending_operation: Option<PendingOperation>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BranchSync {
    branch: String,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    is_gone: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeStatus {
    path: String,
    branch: String,
    head: String,
    is_detached: bool,
    changed_files: u32,
    untracked_files: u32,
    pending_operation: Option<PendingOperation>,
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
pub(crate) fn branch_sync(repo_path: String) -> Result<Vec<BranchSync>, String> {
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

pub(crate) fn existing_git_path(worktree: &str, name: &str) -> Option<PathBuf> {
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
pub(crate) fn worktree_for_branch(repo_path: &str, branch: &str) -> Result<Option<String>, String> {
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

pub(crate) fn pending_operation(worktree: &str) -> Option<PendingOperation> {
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

pub(crate) fn worktree_is_dirty(worktree: &str) -> Result<bool, String> {
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
pub(crate) fn worktree_status(repo_path: String, worktree_paths: Option<Vec<String>>) -> Result<Vec<WorktreeStatus>, String> {
    let output = git_output_allow_empty(&repo_path, &["worktree", "list", "--porcelain", "-z"])?;
    Ok(parse_worktree_records(&output)
        .into_iter()
        .filter(|worktree| !worktree.is_prunable)
        .filter(|worktree| {
            worktree_paths
                .as_ref()
                .map_or(true, |paths| paths.iter().any(|path| same_path(&worktree.path, path)))
        })
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

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) fn branch_operation_state(repo_path: String, branch: String) -> Result<BranchOperability, String> {
    branch_operability(&repo_path, &branch)
}

pub(crate) fn pending_operation_label(operation: &PendingOperation) -> &'static str {
    match operation {
        PendingOperation::Rebase => "rebasing",
        PendingOperation::Merge => "merging",
        PendingOperation::CherryPick => "cherry-picking",
        PendingOperation::Bisect => "bisecting",
    }
}

pub(crate) fn idle_worktree(repo_path: &str) -> Result<String, String> {
    let worktree = worktree_path(repo_path)?;
    if let Some(operation) = pending_operation(&worktree) {
        return Err(format!("This worktree is already {}.", pending_operation_label(&operation)));
    }
    Ok(worktree)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepositoryState {
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
pub(crate) fn repository_state(repo_path: String) -> Result<RepositoryState, String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use crate::git::git_result;

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

        let statuses = worktree_status(path.clone(), None).unwrap();
        let scoped = worktree_status(path.clone(), Some(vec![linked.clone()])).unwrap();
        let clean = {
            write(&path, "tracked.txt", "base\n");
            fs::remove_file(Path::new(&path).join("untracked.txt")).unwrap();
            write(&linked, "tracked.txt", "base\n");
            worktree_status(path.clone(), None).unwrap()
        };
        let _ = fs::remove_dir_all(&linked);
        fs::remove_dir_all(&path).unwrap();

        assert_eq!(statuses.len(), 2);
        let main = statuses.iter().find(|status| status.branch == "main").unwrap();
        assert_eq!((main.changed_files, main.untracked_files), (1, 1));
        let feature = statuses.iter().find(|status| status.branch == "feature").unwrap();
        assert_eq!((feature.changed_files, feature.untracked_files), (1, 0));
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].branch, "feature");
        assert!(clean.iter().all(|status| status.changed_files == 0 && status.untracked_files == 0));
    }
}
