use serde::Serialize;
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    path::Path,
};
use std::hash::{Hash, Hasher};
use crate::diff::{ChangedFile, conflicted_paths, staged_changed_files, unstaged_changed_files};
use crate::git::{
    INDEX_REF, WORKTREE_REF, OperationResult, completed_operation, failed_operation, git_error_message, git_output,
    git_output_allow_empty, git_output_bytes, git_result_with_stdin, git_version, ref_shas,
    resolve_commit, worktree_path,
};
use crate::worktrees::{PendingOperation, pending_operation};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkingTree {
    branch: Option<String>,
    head_sha: Option<String>,
    head_message: Option<String>,
    index_fingerprint: String,
    pending_operation: Option<PendingOperation>,
    conflicted: Vec<String>,
    staged: Vec<ChangedFile>,
    unstaged: Vec<ChangedFile>,
}

fn read_working_tree(repo_path: &str) -> Result<WorkingTree, String> {
    let worktree = worktree_path(repo_path)?;
    let conflicted = conflicted_paths(&worktree)?;
    let index_fingerprint = index_fingerprint(&worktree)?;
    let staged = staged_changed_files(&worktree, &conflicted)?;
    let unstaged = unstaged_changed_files(&worktree, &conflicted)?;
    crate::previews::warm(
        [
            crate::compare::image_sources(repo_path, "HEAD", INDEX_REF, &staged),
            crate::compare::image_sources(repo_path, INDEX_REF, WORKTREE_REF, &unstaged),
        ]
        .concat(),
    );
    Ok(WorkingTree {
        branch: git_output(&worktree, &["symbolic-ref", "--quiet", "--short", "HEAD"]),
        head_sha: resolve_commit(&worktree, "HEAD").ok(),
        head_message: git_output(&worktree, &["log", "-1", "--format=%B"]),
        index_fingerprint,
        pending_operation: pending_operation(&worktree),
        conflicted,
        staged,
        unstaged,
    })
}

fn index_fingerprint(worktree: &str) -> Result<String, String> {
    let index = git_output_bytes(worktree, &["--no-optional-locks", "ls-files", "--stage", "-z"])
        .ok_or_else(|| "Could not read the Git index.".to_string())?;
    let mut hasher = DefaultHasher::new();
    index.hash(&mut hasher);
    Ok(hasher.finish().to_string())
}

#[git_nav_macros::http_command]
#[tauri::command(async)]
pub(crate) fn working_tree(repo_path: String) -> Result<WorkingTree, String> {
    read_working_tree(&repo_path)
}

fn status_paths(status: &str) -> impl Iterator<Item = &str> {
    status.split('\0').filter_map(|entry| match entry.as_bytes().first() {
        Some(b'1') => entry.splitn(9, ' ').nth(8),
        Some(b'2') => entry.splitn(10, ' ').nth(9),
        Some(b'u') => entry.splitn(11, ' ').nth(10),
        Some(b'?') => entry.strip_prefix("? "),
        _ => None,
    })
}

fn hash_file_metadata(hasher: &mut DefaultHasher, worktree: &str, path: &str) {
    path.hash(hasher);
    match fs::metadata(Path::new(worktree).join(path)) {
        Ok(metadata) => {
            metadata.len().hash(hasher);
            metadata.modified().ok().hash(hasher);
        }
        Err(error) => error.kind().hash(hasher),
    }
}

// Status already walks the index and the working tree. File metadata catches content changes that status does not report.
#[git_nav_macros::http_command]
#[tauri::command(async)]
pub(crate) fn working_tree_fingerprint(repo_path: String) -> Result<String, String> {
    let worktree = worktree_path(&repo_path)?;
    let status = git_output_allow_empty(
        &worktree,
        &["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"],
    )?;
    let mut hasher = DefaultHasher::new();
    status.hash(&mut hasher);
    for path in status_paths(&status) {
        hash_file_metadata(&mut hasher, &worktree, path);
    }
    Ok(hasher.finish().to_string())
}

// Paths come from git itself, so they are handed back byte for byte rather than read as patterns.
const PATHSPEC_ARGUMENTS: [&str; 2] = ["--pathspec-from-file=-", "--pathspec-file-nul"];
const MINIMUM_PATHSPEC_FROM_FILE_VERSION: (u32, u32) = (2, 26);

fn pathspec_from_file_unavailable(version: Option<(u32, u32)>) -> Option<String> {
    version
        .filter(|version| *version < MINIMUM_PATHSPEC_FROM_FILE_VERSION)
        .map(|_| "Staging files requires Git 2.26 or newer.".to_string())
}

fn pathspec_input(paths: &[String]) -> Vec<u8> {
    paths.iter().flat_map(|path| path.bytes().chain(std::iter::once(0))).collect()
}

fn run_on_paths(worktree: &str, arguments: &[&str], paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    if let Some(error) = pathspec_from_file_unavailable(git_version(worktree)) {
        return Err(error);
    }
    let arguments = [&["--literal-pathspecs"][..], arguments, &PATHSPEC_ARGUMENTS[..]].concat();
    let output = git_result_with_stdin(worktree, &arguments, &pathspec_input(paths))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(git_error_message(&output))
    }
}

#[git_nav_macros::http_command]
#[tauri::command(async)]
pub(crate) fn stage_files(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    let worktree = worktree_path(&repo_path)?;
    run_on_paths(&worktree, &["add", "--all"], &paths)
}

// Before the first commit there is no HEAD to reset the index back to, so entries are dropped from it instead.
#[git_nav_macros::http_command]
#[tauri::command(async)]
pub(crate) fn unstage_files(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    let worktree = worktree_path(&repo_path)?;
    if resolve_commit(&worktree, "HEAD").is_ok() {
        run_on_paths(&worktree, &["reset", "--quiet"], &paths)
    } else {
        run_on_paths(&worktree, &["rm", "--cached", "--force", "--quiet", "-r"], &paths)
    }
}

fn commit(repo_path: &str, message: &str, amend: bool, head_sha: Option<&str>, branch: Option<&str>, expected_index_fingerprint: &str) -> Result<OperationResult, String> {
    let worktree = worktree_path(repo_path)?;
    let current_branch = git_output(&worktree, &["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if resolve_commit(&worktree, "HEAD").ok().as_deref() != head_sha
        || current_branch.as_deref() != branch
        || index_fingerprint(&worktree)? != expected_index_fingerprint
    {
        return Err("The working tree changed. Refresh and try again.".to_string());
    }
    let before = ref_shas(repo_path)?;
    let mut arguments = vec!["commit", "--quiet", "--file=-"];
    if amend {
        arguments.push("--amend");
    }
    let output = git_result_with_stdin(&worktree, &arguments, message.as_bytes())?;
    if !output.status.success() {
        return Ok(failed_operation(&worktree, &output));
    }
    let head = git_output(&worktree, &["log", "-1", "--format=%h %s"]).unwrap_or_default();
    let summary = if amend { format!("Amended {head}.") } else { format!("Committed {head}.") };
    completed_operation(repo_path, summary, &before)
}

#[git_nav_macros::http_command]
#[tauri::command(async)]
pub(crate) fn commit_changes(repo_path: String, message: String, amend: bool, head_sha: Option<String>, branch: Option<String>, index_fingerprint: String) -> Result<OperationResult, String> {
    commit(&repo_path, &message, amend, head_sha.as_deref(), branch.as_deref(), &index_fingerprint)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::Path};
    use crate::git::OperationResult;
    use crate::test_support::{remove_scratch_repository, scratch_repository};

    fn paths(files: &[ChangedFile]) -> Vec<String> {
        files.iter().map(|file| file.new_path.clone().or_else(|| file.old_path.clone()).unwrap()).collect()
    }

    #[test]
    fn requires_pathspec_from_file_support_to_stage_files() {
        assert_eq!(
            pathspec_from_file_unavailable(Some((2, 25))).as_deref(),
            Some("Staging files requires Git 2.26 or newer.")
        );
        assert!(pathspec_from_file_unavailable(Some((2, 26))).is_none());
        assert!(pathspec_from_file_unavailable(None).is_none());
    }

    #[test]
    fn splits_the_working_tree_into_staged_and_unstaged_changes() {
        let (path, run) = scratch_repository("working-tree-split");
        fs::write(Path::new(&path).join("kept.txt"), "one\n").unwrap();
        fs::write(Path::new(&path).join("gone.txt"), "gone\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "first"]);
        fs::write(Path::new(&path).join("kept.txt"), "one\ntwo\n").unwrap();
        fs::write(Path::new(&path).join("staged.txt"), "staged\n").unwrap();
        fs::write(Path::new(&path).join("new.txt"), "new\n").unwrap();
        fs::remove_file(Path::new(&path).join("gone.txt")).unwrap();
        run(&["add", "staged.txt"]);

        let tree = read_working_tree(&path).unwrap();

        assert_eq!(tree.branch.as_deref(), Some("main"));
        assert_eq!(tree.head_message.as_deref(), Some("first"));
        assert_eq!(paths(&tree.staged), vec!["staged.txt"]);
        assert_eq!(tree.staged[0].status, "added");
        assert_eq!(paths(&tree.unstaged), vec!["gone.txt", "kept.txt", "new.txt"]);
        assert_eq!(tree.unstaged[0].status, "deleted");
        assert_eq!(tree.unstaged[1].status, "modified");
        assert_eq!((tree.unstaged[1].additions, tree.unstaged[1].deletions), (1, 0));
        assert_eq!(tree.unstaged[2].status, "added");
        assert!(tree.conflicted.is_empty());
        remove_scratch_repository(&path);
    }

    #[test]
    fn lists_a_file_on_both_sides_when_only_part_of_it_is_staged() {
        let (path, run) = scratch_repository("working-tree-partial");
        fs::write(Path::new(&path).join("file.txt"), "one\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "first"]);
        fs::write(Path::new(&path).join("file.txt"), "one\ntwo\n").unwrap();
        run(&["add", "file.txt"]);
        fs::write(Path::new(&path).join("file.txt"), "one\ntwo\nthree\n").unwrap();

        let tree = read_working_tree(&path).unwrap();

        assert_eq!(paths(&tree.staged), vec!["file.txt"]);
        assert_eq!(paths(&tree.unstaged), vec!["file.txt"]);
        assert_eq!(tree.staged[0].additions, 1);
        assert_eq!(tree.unstaged[0].additions, 1);
        remove_scratch_repository(&path);
    }

    #[test]
    fn keeps_conflicted_files_out_of_the_stageable_lists() {
        let (path, run) = scratch_repository("working-tree-conflict");
        fs::write(Path::new(&path).join("file.txt"), "base\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["switch", "--quiet", "--create", "side"]);
        fs::write(Path::new(&path).join("file.txt"), "side\n").unwrap();
        run(&["commit", "--quiet", "--all", "--message", "side"]);
        run(&["switch", "--quiet", "main"]);
        fs::write(Path::new(&path).join("file.txt"), "main\n").unwrap();
        fs::write(Path::new(&path).join("other.txt"), "other\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "main"]);
        let _ = crate::git::git_result(&path, &["merge", "side"]);
        fs::write(Path::new(&path).join("file.txt"), "main\n").unwrap();
        fs::write(Path::new(&path).join("other.txt"), "other\nmore\n").unwrap();

        let tree = read_working_tree(&path).unwrap();

        assert_eq!(tree.conflicted, vec!["file.txt"]);
        assert!(matches!(tree.pending_operation, Some(PendingOperation::Merge)));
        assert!(tree.staged.is_empty());
        assert_eq!(paths(&tree.unstaged), vec!["other.txt"]);
        assert_eq!((tree.unstaged[0].additions, tree.unstaged[0].deletions, tree.unstaged[0].split_rows, tree.unstaged[0].unified_rows, tree.unstaged[0].hunk_rows), (1, 0, 2, 2, 2));
        remove_scratch_repository(&path);
    }

    #[test]
    fn keeps_unstaged_stats_aligned_after_an_edited_deleted_by_them_conflict() {
        let (path, run) = scratch_repository("working-tree-delete-conflict-stats");
        fs::write(Path::new(&path).join("file.txt"), "base\n").unwrap();
        fs::write(Path::new(&path).join("z.txt"), "z old\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["switch", "--quiet", "--create", "side"]);
        run(&["rm", "--quiet", "file.txt"]);
        run(&["commit", "--quiet", "--message", "delete"]);
        run(&["switch", "--quiet", "main"]);
        fs::write(Path::new(&path).join("file.txt"), "main\n").unwrap();
        run(&["commit", "--quiet", "--all", "--message", "modify"]);
        assert!(!crate::git::git_result(&path, &["merge", "--no-commit", "side"]).unwrap().status.success());
        fs::write(Path::new(&path).join("file.txt"), "main\nedited\n").unwrap();
        fs::write(Path::new(&path).join("z.txt"), "z new\n").unwrap();

        let tree = read_working_tree(&path).unwrap();

        assert_eq!(tree.conflicted, vec!["file.txt"]);
        assert_eq!(paths(&tree.unstaged), vec!["z.txt"]);
        assert_eq!((tree.unstaged[0].additions, tree.unstaged[0].deletions), (1, 1));
        remove_scratch_repository(&path);
    }

    #[test]
    fn stages_unstages_and_commits_the_chosen_files() {
        let (path, run) = scratch_repository("working-tree-commit");
        fs::write(Path::new(&path).join("first.txt"), "one\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "first"]);
        fs::write(Path::new(&path).join("first.txt"), "one\ntwo\n").unwrap();
        fs::write(Path::new(&path).join("[odd] name.txt"), "odd\n").unwrap();
        fs::write(Path::new(&path).join("later.txt"), "later\n").unwrap();

        stage_files(path.clone(), vec!["first.txt".to_string(), "[odd] name.txt".to_string(), "later.txt".to_string()]).unwrap();
        unstage_files(path.clone(), vec!["later.txt".to_string()]).unwrap();
        let tree = read_working_tree(&path).unwrap();
        assert_eq!(paths(&tree.staged), vec!["[odd] name.txt", "first.txt"]);
        assert_eq!(paths(&tree.unstaged), vec!["later.txt"]);

        let head = resolve_commit(&path, "HEAD").unwrap();
        let result = commit(&path, "Add an odd name\n\nWith a body.\n", false, Some(&head), Some("main"), &tree.index_fingerprint).unwrap();
        let OperationResult::Completed(completed) = result else { panic!("commit failed") };
        assert!(completed.summary.starts_with("Committed "));
        assert!(completed.summary.ends_with(" Add an odd name."));
        assert_eq!(completed.updates.len(), 1);
        assert_eq!(completed.updates[0].reference, "refs/heads/main");
        assert_eq!(git_output(&path, &["log", "-1", "--format=%B"]).unwrap(), "Add an odd name\n\nWith a body.");
        let tree = read_working_tree(&path).unwrap();
        assert!(tree.staged.is_empty());
        assert_eq!(paths(&tree.unstaged), vec!["later.txt"]);

        stage_files(path.clone(), vec!["later.txt".to_string()]).unwrap();
        let head = resolve_commit(&path, "HEAD").unwrap();
        let index = index_fingerprint(&path).unwrap();
        let OperationResult::Completed(amended) = commit(&path, "Add an odd name and more", true, Some(&head), Some("main"), &index).unwrap() else {
            panic!("amend failed")
        };
        assert!(amended.summary.starts_with("Amended "));
        assert_eq!(git_output(&path, &["rev-list", "--count", "HEAD"]).unwrap(), "2");
        remove_scratch_repository(&path);
    }

    #[test]
    fn reports_a_refused_commit_without_moving_anything() {
        let (path, run) = scratch_repository("working-tree-refused");
        run(&["commit", "--quiet", "--allow-empty", "--message", "first"]);

        let head = resolve_commit(&path, "HEAD").unwrap();
        let index = index_fingerprint(&path).unwrap();
        let OperationResult::Failed(failed) = commit(&path, "nothing to commit", false, Some(&head), Some("main"), &index).unwrap() else {
            panic!("an empty commit went through")
        };
        assert!(!failed.message.is_empty());
        remove_scratch_repository(&path);
    }

    #[test]
    fn refuses_to_amend_when_head_has_moved() {
        let (path, run) = scratch_repository("working-tree-amend-head");
        run(&["commit", "--quiet", "--allow-empty", "--message", "first"]);
        let shown_head = resolve_commit(&path, "HEAD").unwrap();
        let shown_index = index_fingerprint(&path).unwrap();
        run(&["commit", "--quiet", "--allow-empty", "--message", "second"]);

        let Err(error) = commit(&path, "amended", true, Some(&shown_head), Some("main"), &shown_index) else {
            panic!("amend succeeded after HEAD moved")
        };
        assert_eq!(error, "The working tree changed. Refresh and try again.");
        assert_eq!(git_output(&path, &["log", "-1", "--format=%s"]).as_deref(), Some("second"));
        remove_scratch_repository(&path);
    }

    #[test]
    fn refuses_to_amend_after_switching_to_a_branch_at_the_same_head() {
        let (path, run) = scratch_repository("working-tree-amend-branch");
        run(&["commit", "--quiet", "--allow-empty", "--message", "first"]);
        let shown_head = resolve_commit(&path, "HEAD").unwrap();
        let shown_index = index_fingerprint(&path).unwrap();
        run(&["switch", "--quiet", "--create", "other"]);

        let Err(error) = commit(&path, "amended", true, Some(&shown_head), Some("main"), &shown_index) else {
            panic!("amend succeeded after the branch changed")
        };
        assert_eq!(error, "The working tree changed. Refresh and try again.");
        assert_eq!(git_output(&path, &["log", "-1", "--format=%s"]).as_deref(), Some("first"));
        remove_scratch_repository(&path);
    }

    #[test]
    fn refuses_to_commit_after_switching_branches() {
        let (path, run) = scratch_repository("working-tree-commit-branch");
        run(&["commit", "--quiet", "--allow-empty", "--message", "first"]);
        let shown_head = resolve_commit(&path, "HEAD").unwrap();
        fs::write(Path::new(&path).join("file.txt"), "change\n").unwrap();
        run(&["add", "file.txt"]);
        let shown_index = index_fingerprint(&path).unwrap();
        run(&["switch", "--quiet", "--create", "other"]);

        let Err(error) = commit(&path, "second", false, Some(&shown_head), Some("main"), &shown_index) else {
            panic!("commit succeeded after the branch changed")
        };
        assert_eq!(error, "The working tree changed. Refresh and try again.");
        assert_eq!(git_output(&path, &["rev-list", "--count", "HEAD"]).as_deref(), Some("1"));
        remove_scratch_repository(&path);
    }

    #[test]
    fn stages_and_unstages_before_the_first_commit() {
        let (path, _run) = scratch_repository("working-tree-unborn");
        fs::write(Path::new(&path).join("first.txt"), "one\n").unwrap();

        stage_files(path.clone(), vec!["first.txt".to_string()]).unwrap();
        let tree = read_working_tree(&path).unwrap();
        assert_eq!(tree.head_sha, None);
        assert_eq!(paths(&tree.staged), vec!["first.txt"]);
        fs::write(Path::new(&path).join("first.txt"), "one\ntwo\n").unwrap();
        unstage_files(path.clone(), vec!["first.txt".to_string()]).unwrap();
        let tree = read_working_tree(&path).unwrap();
        assert!(tree.staged.is_empty());
        assert_eq!(paths(&tree.unstaged), vec!["first.txt"]);
        remove_scratch_repository(&path);
    }

    #[test]
    fn commits_the_first_commit_when_the_expected_head_is_missing() {
        let (path, _run) = scratch_repository("working-tree-first-commit");
        fs::write(Path::new(&path).join("first.txt"), "one\n").unwrap();
        stage_files(path.clone(), vec!["first.txt".to_string()]).unwrap();
        let index = index_fingerprint(&path).unwrap();

        let OperationResult::Completed(_) = commit(&path, "first", false, None, Some("main"), &index).unwrap() else {
            panic!("first commit failed")
        };
        assert_eq!(git_output(&path, &["log", "-1", "--format=%s"]).as_deref(), Some("first"));
        remove_scratch_repository(&path);
    }

    #[test]
    fn refuses_to_commit_when_the_index_has_changed() {
        let (path, run) = scratch_repository("working-tree-commit-index");
        run(&["commit", "--quiet", "--allow-empty", "--message", "first"]);
        fs::write(Path::new(&path).join("shown.txt"), "shown\n").unwrap();
        run(&["add", "shown.txt"]);
        let shown_tree = read_working_tree(&path).unwrap();
        fs::write(Path::new(&path).join("other.txt"), "other\n").unwrap();
        run(&["add", "other.txt"]);

        let result = commit(
            &path,
            "second",
            false,
            shown_tree.head_sha.as_deref(),
            shown_tree.branch.as_deref(),
            &shown_tree.index_fingerprint,
        );

        let Err(error) = result else { panic!("commit succeeded after the index changed") };
        assert_eq!(error, "The working tree changed. Refresh and try again.");
        assert_eq!(git_output(&path, &["rev-list", "--count", "HEAD"]).as_deref(), Some("1"));

        let fresh_tree = read_working_tree(&path).unwrap();
        let OperationResult::Completed(_) = commit(
            &path,
            "second",
            false,
            fresh_tree.head_sha.as_deref(),
            fresh_tree.branch.as_deref(),
            &fresh_tree.index_fingerprint,
        ).unwrap() else {
            panic!("commit failed with a fresh index")
        };
        assert_eq!(git_output(&path, &["rev-list", "--count", "HEAD"]).as_deref(), Some("2"));
        remove_scratch_repository(&path);
    }

    #[test]
    fn changes_the_fingerprint_when_the_working_tree_changes() {
        let (path, run) = scratch_repository("working-tree-fingerprint");
        run(&["commit", "--quiet", "--allow-empty", "--message", "first"]);
        let clean = working_tree_fingerprint(path.clone()).unwrap();
        fs::write(Path::new(&path).join("new.txt"), "new\n").unwrap();
        let dirty = working_tree_fingerprint(path.clone()).unwrap();
        assert_ne!(clean, dirty);
        stage_files(path.clone(), vec!["new.txt".to_string()]).unwrap();
        assert_ne!(dirty, working_tree_fingerprint(path.clone()).unwrap());
        remove_scratch_repository(&path);
    }

    #[test]
    fn changes_the_fingerprint_when_an_existing_change_is_edited() {
        let (path, run) = scratch_repository("working-tree-fingerprint-content");
        fs::write(Path::new(&path).join("file.txt"), "one\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "first"]);
        fs::write(Path::new(&path).join("file.txt"), "one\ntwo\n").unwrap();
        let first = working_tree_fingerprint(path.clone()).unwrap();
        fs::write(Path::new(&path).join("file.txt"), "one\ntwo\nthree\n").unwrap();
        assert_ne!(first, working_tree_fingerprint(path.clone()).unwrap());
        remove_scratch_repository(&path);
    }
}
