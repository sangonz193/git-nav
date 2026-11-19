use serde::Deserialize;
use std::{env, fs, time::SystemTime, time::UNIX_EPOCH};
use crate::git::{
    CompletedOperation, OperationResult, RefUpdate, completed_operation, conflicted_files,
    failed_operation, git_error_message, git_output_allow_empty, git_result, git_result_with_stdin, ref_shas,
    ref_label, resolve_commit, undone_operation, worktree_path,
};
use crate::worktrees::{
    idle_worktree, pending_operation, pending_operation_label, worktree_for_branch,
    worktree_is_dirty,
};

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) fn delete_branch(
    repo_path: String,
    branch: String,
    remote_tracking: bool,
) -> Result<OperationResult, String> {
    let scope = if remote_tracking { "--remotes" } else { "--force" };
    run_worktree_operation(
        &repo_path,
        &repo_path,
        format!("Deleted {branch}."),
        &["branch", "--delete", scope, "--", &branch],
        None,
    )
}

fn temporary_worktree_path(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    env::temp_dir()
        .join(format!("git-nav-{prefix}-{}-{nanos}", std::process::id()))
        .to_string_lossy()
        .into_owned()
}

fn discard_temporary_worktree(repo_path: &str, worktree: &str) {
    let _ = git_result(worktree, &["rebase", "--abort"]);
    let _ = git_result(repo_path, &["worktree", "remove", "--force", "--", worktree]);
    let _ = git_result(repo_path, &["worktree", "prune"]);
    let _ = fs::remove_dir_all(worktree);
}

pub(crate) fn rebase_branch_onto(repo_path: &str, onto: &str, upstream: &str, branch: &str) -> Result<OperationResult, String> {
    let reference = format!("refs/heads/{branch}");
    resolve_commit(repo_path, &reference)?;
    resolve_commit(repo_path, onto)?;
    resolve_commit(repo_path, upstream)?;
    let summary = format!("Rebased {branch} onto {}.", ref_label(onto));
    let before = ref_shas(repo_path)?;

    if let Some(worktree) = worktree_for_branch(repo_path, branch)? {
        if pending_operation(&worktree).is_some() {
            return Err(format!("{worktree} already has a Git operation in progress."));
        }
        if worktree_is_dirty(&worktree)? {
            return Err(format!("{worktree} has uncommitted changes."));
        }
        let output = git_result(&worktree, &["rebase", "--onto", onto, upstream, branch])?;
        if output.status.success() {
            return completed_operation(repo_path, summary, &before);
        }
        let failure = undone_operation(&output, conflicted_files(&worktree));
        let _ = git_result(&worktree, &["rebase", "--abort"]);
        return Ok(failure);
    }

    // Rebasing an unchecked-out branch from the user's own worktree would move that worktree onto it.
    let worktree = temporary_worktree_path("rebase");
    git_output_allow_empty(repo_path, &["worktree", "add", "--detach", &worktree, &reference])?;
    let result = git_result(&worktree, &["rebase", "--onto", onto, upstream, branch]).and_then(|output| {
        if output.status.success() {
            completed_operation(repo_path, summary, &before)
        } else {
            Ok(undone_operation(&output, conflicted_files(&worktree)))
        }
    });
    discard_temporary_worktree(repo_path, &worktree);
    result
}

fn restore_refs(repo_path: &str, updates: &[RefUpdate]) -> Result<(), String> {
    let mut worktrees = Vec::new();
    for update in updates {
        let Some(branch) = update.reference.strip_prefix("refs/heads/") else {
            continue;
        };
        let Some(worktree) = worktree_for_branch(repo_path, branch)? else {
            continue;
        };
        if pending_operation(&worktree).is_some() {
            return Err(format!("{worktree} has a Git operation in progress."));
        }
        if worktree_is_dirty(&worktree)? {
            return Err(format!("{worktree} has uncommitted changes."));
        }
        if update.before.is_empty() {
            return Err(format!("{branch} is checked out at {worktree}."));
        }
        worktrees.push(worktree);
    }
    for update in updates {
        let arguments = match (update.before.as_str(), update.after.as_str()) {
            ("", after) => vec!["update-ref", "-d", &update.reference, after],
            (before, "") => vec!["update-ref", &update.reference, before],
            (before, after) => vec!["update-ref", &update.reference, before, after],
        };
        git_output_allow_empty(repo_path, &arguments)?;
    }
    for worktree in worktrees {
        git_output_allow_empty(&worktree, &["reset", "--hard"])?;
    }
    Ok(())
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn rebase_onto(
    repo_path: String,
    onto: String,
    upstream: String,
    branch: String,
) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || rebase_branch_onto(&repo_path, &onto, &upstream, &branch))
        .await
        .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn undo_ref_updates(repo_path: String, updates: Vec<RefUpdate>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || restore_refs(&repo_path, &updates))
        .await
        .map_err(|error| error.to_string())?
}

fn ensure_ref_name(repo_path: &str, prefix: &str, name: &str) -> Result<(), String> {
    let reference = format!("{prefix}{name}");
    let output = git_result(repo_path, &["check-ref-format", &reference])?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!("{name} is not a name Git can use."))
    }
}

pub(crate) fn run_worktree_operation(
    repo_path: &str,
    worktree: &str,
    summary: String,
    arguments: &[&str],
    abort: Option<&[&str]>,
) -> Result<OperationResult, String> {
    let before = ref_shas(repo_path)?;
    let existing_conflicts = conflicted_files(worktree);
    let output = git_result(worktree, arguments)?;
    if output.status.success() {
        return completed_operation(repo_path, summary, &before);
    }
    let files = conflicted_files(worktree)
        .into_iter()
        .filter(|file| !existing_conflicts.contains(file))
        .collect();
    let Some(abort) = abort else {
        return Ok(failed_operation(&output, files));
    };
    let failure = undone_operation(&output, files);
    let _ = git_result(worktree, abort);
    Ok(failure)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckoutOptions {
    create: Option<String>,
    track: bool,
    detach: bool,
    stash: bool,
}

const CHECKOUT_STASH_MESSAGE: &str = "git-nav: set aside before checkout";

fn checkout_reference(repo_path: &str, reference: &str, options: &CheckoutOptions) -> Result<OperationResult, String> {
    let worktree = idle_worktree(repo_path)?;
    if let Some(name) = &options.create {
        ensure_ref_name(repo_path, "refs/heads/", name)?;
    }
    let mut arguments = vec!["switch".to_string()];
    if options.detach {
        arguments.push("--detach".to_string());
    } else if let Some(name) = &options.create {
        arguments.push("-c".to_string());
        arguments.push(name.clone());
        if options.track {
            arguments.push("--track".to_string());
        }
    } else if options.track {
        arguments.push("--track".to_string());
    }
    arguments.push(reference.to_string());
    let arguments: Vec<_> = arguments.iter().map(String::as_str).collect();
    let before = ref_shas(repo_path)?;

    if options.stash {
        let stashed = git_result(&worktree, &["stash", "push", "--include-untracked", "--message", CHECKOUT_STASH_MESSAGE])?;
        if !stashed.status.success() {
            return Ok(failed_operation(&stashed, Vec::new()));
        }
    }

    let output = git_result(&worktree, &arguments)?;
    if !output.status.success() {
        if options.stash {
            let _ = git_result(&worktree, &["stash", "pop"]);
        }
        return Ok(failed_operation(&output, Vec::new()));
    }

    let landed = options.create.clone().unwrap_or_else(|| reference.to_string());
    let mut summary = format!("Checked out {landed}.");
    if options.stash && !git_result(&worktree, &["stash", "pop"])?.status.success() {
        summary = format!("{summary} The set aside changes conflicted, so they are still in the stash and the files carry conflict markers.");
    }
    completed_operation(repo_path, summary, &before)
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn checkout_ref(repo_path: String, reference: String, options: CheckoutOptions) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || checkout_reference(&repo_path, &reference, &options))
        .await
        .map_err(|error| error.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PushOptions {
    remote: String,
    force: bool,
    set_upstream: bool,
    delete: bool,
}

fn push_reference(repo_path: &str, reference: &str, options: &PushOptions) -> Result<OperationResult, String> {
    let worktree = worktree_path(repo_path)?;
    let mut arguments = vec!["push".to_string()];
    if options.force {
        arguments.push("--force-with-lease".to_string());
        arguments.push("--force-if-includes".to_string());
    }
    if options.set_upstream {
        arguments.push("--set-upstream".to_string());
    }
    if options.delete {
        arguments.push("--delete".to_string());
    }
    arguments.push(options.remote.clone());
    arguments.push(reference.to_string());
    let arguments: Vec<_> = arguments.iter().map(String::as_str).collect();
    let output = git_result(&worktree, &arguments)?;
    if !output.status.success() {
        return Ok(failed_operation(&output, Vec::new()));
    }
    let summary = if options.delete {
        format!("Deleted {reference} from {}.", options.remote)
    } else {
        format!("Pushed {reference} to {}.", options.remote)
    };
    // Rewinding the local remote-tracking ref would hide the push rather than reverse it, so this reports no undo.
    Ok(OperationResult::Completed(CompletedOperation { summary, updates: Vec::new() }))
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn push_ref(repo_path: String, reference: String, options: PushOptions) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || push_reference(&repo_path, &reference, &options))
        .await
        .map_err(|error| error.to_string())?
}

fn fast_forward_branch(repo_path: &str, branch: &str) -> Result<OperationResult, String> {
    let local_ref = format!("refs/heads/{branch}");
    let output = git_output_allow_empty(
        repo_path,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:short)",
            &local_ref,
        ],
    )?;
    let prefix = format!("{local_ref}\0");
    let mut fields = output
        .lines()
        .find_map(|line| line.strip_prefix(&prefix))
        .unwrap_or_default()
        .split('\0');
    let (Some(upstream), Some(remote), Some(remote_ref), Some(upstream_short)) = (
        fields.next().filter(|upstream| !upstream.is_empty()),
        fields.next(),
        fields.next(),
        fields.next(),
    ) else {
        return Err(format!("{branch} has no upstream branch."));
    };
    let before = ref_shas(repo_path)?;
    let fetched = git_result(repo_path, &["fetch", "--", remote, remote_ref])?;
    if !fetched.status.success() {
        return Ok(failed_operation(&fetched, Vec::new()));
    }

    let summary = format!("Fast-forwarded {branch} to {upstream_short}.");
    if let Some(worktree) = worktree_for_branch(repo_path, branch)? {
        if pending_operation(&worktree).is_some() {
            return Err(format!("{worktree} has a Git operation in progress."));
        }
        let output = git_result(&worktree, &["merge", "--ff-only", upstream])?;
        if !output.status.success() {
            return Ok(failed_operation(&output, Vec::new()));
        }
        return completed_operation(repo_path, summary, &before);
    }

    let refspec = format!("{remote_ref}:{local_ref}");
    let output = git_result(repo_path, &["fetch", "--", remote, &refspec])?;
    if !output.status.success() {
        return Ok(failed_operation(&output, Vec::new()));
    }
    completed_operation(repo_path, summary, &before)
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn pull_branch(repo_path: String, branch: String) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || fast_forward_branch(&repo_path, &branch))
        .await
        .map_err(|error| error.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MergeOptions {
    mode: String,
    message: Option<String>,
}

// Git ignores -m under --squash and writes no MERGE_HEAD, so the commit that lands the squash and the
// recovery that undoes a conflicted one both have to be spelled out here.
fn squash_into_branch(repo_path: &str, worktree: &str, source: &str, into: &str, message: Option<&str>) -> Result<OperationResult, String> {
    let message = message
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .ok_or_else(|| "A squash merge needs a commit message.".to_string())?;
    let before = ref_shas(repo_path)?;
    let merged = git_result(worktree, &["merge", "--squash", source])?;
    if !merged.status.success() {
        let failure = undone_operation(&merged, conflicted_files(worktree));
        let _ = git_result(worktree, &["reset", "--merge"]);
        return Ok(failure);
    }
    if !worktree_is_dirty(worktree)? {
        let _ = git_result(worktree, &["reset", "--merge"]);
        return completed_operation(repo_path, format!("{into} already has every change in {}.", ref_label(source)), &before);
    }
    let committed = git_result(worktree, &["commit", "--message", message])?;
    if !committed.status.success() {
        let failure = undone_operation(&committed, Vec::new());
        let _ = git_result(worktree, &["reset", "--merge"]);
        return Ok(failure);
    }
    completed_operation(repo_path, format!("Squashed {} into a single commit on {into}.", ref_label(source)), &before)
}

fn merge_into_branch(repo_path: &str, source: &str, into: &str, options: &MergeOptions) -> Result<OperationResult, String> {
    let source_sha = resolve_commit(repo_path, source)?;
    let worktree = worktree_for_branch(repo_path, into)?
        .ok_or_else(|| format!("{into} is not checked out in any worktree."))?;
    if let Some(operation) = pending_operation(&worktree) {
        return Err(format!("{worktree} is already {}.", pending_operation_label(&operation)));
    }
    if worktree_is_dirty(&worktree)? {
        return Err(format!("{worktree} has uncommitted changes."));
    }
    if options.mode == "squash" {
        return squash_into_branch(repo_path, &worktree, source, into, options.message.as_deref());
    }

    let mut arguments = vec!["merge".to_string(), "--no-edit".to_string()];
    match options.mode.as_str() {
        "noFastForward" => arguments.push("--no-ff".to_string()),
        "fastForwardOnly" => arguments.push("--ff-only".to_string()),
        _ => {}
    }
    if let Some(message) = options.message.as_ref().filter(|message| !message.trim().is_empty()) {
        arguments.push("--message".to_string());
        arguments.push(message.clone());
    } else if let Some(short) = source.strip_prefix("refs/remotes/") {
        let input = format!("{source_sha}\t\tremote-tracking branch '{short}' of .\n");
        let output = git_result_with_stdin(&worktree, &["fmt-merge-msg"], input.as_bytes())?;
        // The formatter needs a current commit, but merging into an unborn branch does not.
        if !output.status.success() && resolve_commit(&worktree, "HEAD").is_ok() {
            return Err(git_error_message(&output));
        }
        let message = String::from_utf8(output.stdout).map_err(|error| error.to_string())?;
        if !message.trim_end().is_empty() {
            arguments.push("--no-log".to_string());
            arguments.push("--message".to_string());
            arguments.push(message.trim_end().to_string());
        }
    }
    arguments.push(source.to_string());
    let arguments: Vec<_> = arguments.iter().map(String::as_str).collect();
    let summary = format!("Merged {} into {into}.", ref_label(source));
    run_worktree_operation(repo_path, &worktree, summary, &arguments, Some(&["merge", "--abort"]))
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn merge_ref(repo_path: String, source: String, into: String, options: MergeOptions) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || merge_into_branch(&repo_path, &source, &into, &options))
        .await
        .map_err(|error| error.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BranchOptions {
    checkout: bool,
    track: bool,
}

fn create_branch_at(repo_path: &str, name: &str, start_point: &str, options: &BranchOptions) -> Result<OperationResult, String> {
    ensure_ref_name(repo_path, "refs/heads/", name)?;
    resolve_commit(repo_path, start_point)?;
    if options.checkout {
        return checkout_reference(
            repo_path,
            start_point,
            &CheckoutOptions { create: Some(name.to_string()), track: options.track, detach: false, stash: false },
        );
    }
    let mut arguments = vec!["branch"];
    if options.track {
        arguments.push("--track");
    }
    arguments.push(name);
    arguments.push(start_point);
    run_worktree_operation(repo_path, repo_path, format!("Created {name} at {}.", ref_label(start_point)), &arguments, None)
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn create_branch(repo_path: String, name: String, start_point: String, options: BranchOptions) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || create_branch_at(&repo_path, &name, &start_point, &options))
        .await
        .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn rename_branch(repo_path: String, branch: String, name: String) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_ref_name(&repo_path, "refs/heads/", &name)?;
        run_worktree_operation(
            &repo_path,
            &repo_path,
            format!("Renamed {branch} to {name}."),
            &["branch", "--move", &branch, &name],
            None,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn create_tag(repo_path: String, name: String, target: String, message: Option<String>) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_ref_name(&repo_path, "refs/tags/", &name)?;
        resolve_commit(&repo_path, &target)?;
        let annotation = message.filter(|message| !message.trim().is_empty());
        let mut arguments = vec!["tag"];
        if let Some(message) = &annotation {
            arguments.push("--annotate");
            arguments.push("--message");
            arguments.push(message);
        }
        arguments.push(&name);
        arguments.push(&target);
        run_worktree_operation(&repo_path, &repo_path, format!("Tagged {} as {name}.", ref_label(&target)), &arguments, None)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn delete_tag(repo_path: String, name: String) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_worktree_operation(&repo_path, &repo_path, format!("Deleted tag {name}."), &["tag", "--delete", &name], None)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn cherry_pick_range(repo_path: String, base: String, tip: String) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let worktree = idle_worktree(&repo_path)?;
        if worktree_is_dirty(&worktree)? {
            return Err("This worktree has uncommitted changes.".to_string());
        }
        let range = format!("{base}..{tip}");
        run_worktree_operation(
            &repo_path,
            &worktree,
            format!("Cherry-picked {range}."),
            &["cherry-pick", &range],
            Some(&["cherry-pick", "--abort"]),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn revert_range(repo_path: String, base: String, tip: String) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let worktree = idle_worktree(&repo_path)?;
        if worktree_is_dirty(&worktree)? {
            return Err("This worktree has uncommitted changes.".to_string());
        }
        let range = format!("{base}..{tip}");
        run_worktree_operation(
            &repo_path,
            &worktree,
            format!("Reverted {range}."),
            &["revert", "--no-edit", &range],
            Some(&["revert", "--abort"]),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn reset_current(repo_path: String, target: String, mode: String) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let worktree = idle_worktree(&repo_path)?;
        let sha = resolve_commit(&repo_path, &target)?;
        let flag = match mode.as_str() {
            "soft" => "--soft",
            "hard" => "--hard",
            _ => "--mixed",
        };
        run_worktree_operation(
            &repo_path,
            &worktree,
            format!("Reset to {}.", &sha[..8.min(sha.len())]),
            &["reset", flag, &sha],
            None,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use crate::git::git_output;
    use crate::worktrees::existing_git_path;
    use crate::test_support::{remove_scratch_repository, scratch_repository};

    #[test]
    fn deletes_an_orphaned_remote_tracking_ref_with_a_matching_local_branch() {
        let (path, run) = scratch_repository("delete-orphaned-remote-ref");
        run(&["commit", "--quiet", "--allow-empty", "--message", "base"]);
        run(&["branch", "pr/110"]);
        let reference = "refs/remotes/pr/110";
        run(&["update-ref", reference, "HEAD"]);
        let before = resolve_commit(&path, reference).unwrap();

        let result = delete_branch(path.clone(), "pr/110".to_string(), true);
        let refs = ref_shas(&path).unwrap();
        remove_scratch_repository(&path);

        let OperationResult::Completed(completed) = result.unwrap() else {
            panic!("deleting an orphaned remote-tracking ref should complete");
        };
        assert!(!refs.contains_key(reference));
        assert_eq!(refs.get("refs/heads/pr/110"), Some(&before));
        assert_eq!(completed.updates.len(), 1);
        assert_eq!(completed.updates[0].reference, reference);
        assert_eq!(completed.updates[0].before, before);
        assert!(completed.updates[0].after.is_empty());
    }

    #[test]
    fn unrelated_failures_do_not_report_existing_conflicts() {
        let (path, run) = scratch_repository("failure-existing-conflicts");
        let write = |contents: &str| fs::write(Path::new(&path).join("shared.txt"), contents).unwrap();
        write("base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["checkout", "--quiet", "-b", "topic"]);
        write("topic\n");
        run(&["commit", "--quiet", "--all", "--message", "topic"]);
        run(&["checkout", "--quiet", "main"]);
        write("main\n");
        run(&["commit", "--quiet", "--all", "--message", "main"]);
        let merge = git_result(&path, &["merge", "topic"]).unwrap();
        assert!(!merge.status.success());
        assert_eq!(conflicted_files(&path), vec!["shared.txt"]);

        let remote = Path::new(&path).join("unavailable.git").to_string_lossy().into_owned();
        run(&["remote", "add", "origin", &remote]);
        let push = push_reference(
            &path,
            "main",
            &PushOptions { remote: "origin".to_string(), force: false, set_upstream: false, delete: false },
        ).unwrap();
        let branch = create_branch_at(&path, "topic", "main", &BranchOptions { checkout: false, track: false }).unwrap();
        assert_eq!(conflicted_files(&path), vec!["shared.txt"]);
        fs::remove_dir_all(&path).unwrap();

        let OperationResult::Failed(push) = push else {
            panic!("pushing to an unavailable remote should fail");
        };
        assert!(push.files.is_empty());
        assert!(push.message.contains(&remote), "{}", push.message);
        let OperationResult::Failed(branch) = branch else {
            panic!("creating an existing branch should fail");
        };
        assert!(branch.files.is_empty());
        assert!(branch.message.contains("topic"), "{}", branch.message);
    }

    #[test]
    fn reports_conflicts_created_by_applying_a_stash() {
        let (path, run) = scratch_repository("stash-apply-conflicts");
        let write = |contents: &str| fs::write(Path::new(&path).join("shared.txt"), contents).unwrap();
        write("base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        write("stashed\n");
        run(&["stash", "push"]);
        write("main\n");
        run(&["commit", "--quiet", "--all", "--message", "main"]);

        let result = run_worktree_operation(&path, &path, "Applied stash.".to_string(), &["stash", "apply"], None).unwrap();
        fs::remove_dir_all(&path).unwrap();

        let OperationResult::Failed(failure) = result else {
            panic!("applying the stash should conflict");
        };
        assert_eq!(failure.files, vec!["shared.txt"]);
    }

    #[test]
    fn carries_uncommitted_work_across_a_stashed_checkout() {
        let (path, run) = scratch_repository("checkout-stash");
        fs::write(Path::new(&path).join("tracked.txt"), "base\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["branch", "topic"]);
        fs::write(Path::new(&path).join("tracked.txt"), "work in progress\n").unwrap();

        let result = checkout_reference(
            &path,
            "topic",
            &CheckoutOptions { create: None, track: false, detach: false, stash: true },
        )
        .unwrap();
        let branch = git_output(&path, &["symbolic-ref", "--short", "HEAD"]).unwrap();
        let restored = fs::read_to_string(Path::new(&path).join("tracked.txt")).unwrap();
        let stashes = git_output_allow_empty(&path, &["stash", "list"]).unwrap();
        fs::remove_dir_all(&path).unwrap();

        assert!(matches!(result, OperationResult::Completed(_)));
        assert_eq!(branch, "topic");
        assert_eq!(restored, "work in progress\n");
        assert!(stashes.trim().is_empty());
    }

    #[test]
    fn aborts_a_conflicted_merge_and_leaves_the_worktree_alone() {
        let (path, run) = scratch_repository("merge-conflict");
        let write = |contents: &str| fs::write(Path::new(&path).join("shared.txt"), contents).unwrap();
        write("base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["checkout", "--quiet", "-b", "topic"]);
        write("topic\n");
        run(&["commit", "--quiet", "--all", "--message", "topic"]);
        run(&["checkout", "--quiet", "main"]);
        write("main\n");
        run(&["commit", "--quiet", "--all", "--message", "main"]);

        let options = MergeOptions { mode: "default".to_string(), message: None };
        let result = merge_into_branch(&path, "topic", "main", &options).unwrap();
        let pending = pending_operation(&path);
        let dirty = worktree_is_dirty(&path).unwrap();
        let head = git_output(&path, &["log", "-1", "--format=%s"]).unwrap();
        fs::remove_dir_all(&path).unwrap();

        let OperationResult::Failed(failure) = result else {
            panic!("a conflicting merge should not complete");
        };
        assert_eq!(failure.files, vec!["shared.txt".to_string()]);
        assert!(pending.is_none());
        assert!(!dirty);
        assert_eq!(head, "main");
    }

    #[test]
    fn lands_a_squash_merge_as_one_commit_and_leaves_nothing_staged() {
        let (path, run) = scratch_repository("merge-squash");
        fs::write(Path::new(&path).join("file.txt"), "base\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["checkout", "--quiet", "-b", "topic"]);
        fs::write(Path::new(&path).join("one.txt"), "one\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "one"]);
        fs::write(Path::new(&path).join("two.txt"), "two\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "two"]);
        run(&["checkout", "--quiet", "main"]);

        let options = MergeOptions { mode: "squash".to_string(), message: Some("everything topic did".to_string()) };
        let result = merge_into_branch(&path, "topic", "main", &options).unwrap();
        let dirty = worktree_is_dirty(&path).unwrap();
        let subject = git_output(&path, &["log", "-1", "--format=%s"]).unwrap();
        let parents = git_output(&path, &["log", "-1", "--format=%P"]).unwrap();
        fs::remove_dir_all(&path).unwrap();

        assert!(matches!(result, OperationResult::Completed(_)));
        assert!(!dirty);
        assert_eq!(subject, "everything topic did");
        assert_eq!(parents.split_whitespace().count(), 1);
    }

    #[test]
    fn refuses_a_squash_merge_without_a_commit_message() {
        let (path, run) = scratch_repository("merge-squash-unnamed");
        fs::write(Path::new(&path).join("file.txt"), "base\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["checkout", "--quiet", "-b", "topic"]);
        run(&["commit", "--quiet", "--allow-empty", "--message", "ahead"]);
        run(&["checkout", "--quiet", "main"]);

        let options = MergeOptions { mode: "squash".to_string(), message: Some("   ".to_string()) };
        let result = merge_into_branch(&path, "topic", "main", &options);
        let dirty = worktree_is_dirty(&path).unwrap();
        fs::remove_dir_all(&path).unwrap();

        assert!(result.is_err());
        assert!(!dirty);
    }

    #[test]
    fn undoes_a_conflicted_squash_merge_that_has_no_merge_to_abort() {
        let (path, run) = scratch_repository("merge-squash-conflict");
        let write = |contents: &str| fs::write(Path::new(&path).join("shared.txt"), contents).unwrap();
        write("base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["checkout", "--quiet", "-b", "topic"]);
        write("topic\n");
        run(&["commit", "--quiet", "--all", "--message", "topic"]);
        run(&["checkout", "--quiet", "main"]);
        write("main\n");
        run(&["commit", "--quiet", "--all", "--message", "main"]);

        let options = MergeOptions { mode: "squash".to_string(), message: Some("squashed".to_string()) };
        let result = merge_into_branch(&path, "topic", "main", &options).unwrap();
        let dirty = worktree_is_dirty(&path).unwrap();
        let head = git_output(&path, &["log", "-1", "--format=%s"]).unwrap();
        let leftovers = existing_git_path(&path, "SQUASH_MSG");
        fs::remove_dir_all(&path).unwrap();

        let OperationResult::Failed(failure) = result else {
            panic!("a conflicting squash should not complete");
        };
        assert_eq!(failure.files, vec!["shared.txt".to_string()]);
        assert!(!dirty);
        assert_eq!(head, "main");
        assert!(leftovers.is_none());
    }

    #[test]
    fn completes_a_squash_merge_that_has_nothing_left_to_apply() {
        let (path, run) = scratch_repository("merge-squash-applied");
        fs::write(Path::new(&path).join("file.txt"), "base\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["checkout", "--quiet", "-b", "topic"]);
        fs::write(Path::new(&path).join("one.txt"), "one\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "one"]);
        run(&["checkout", "--quiet", "main"]);

        let options = MergeOptions { mode: "squash".to_string(), message: Some("squashed".to_string()) };
        merge_into_branch(&path, "topic", "main", &options).unwrap();
        let again = merge_into_branch(&path, "topic", "main", &options).unwrap();
        let dirty = worktree_is_dirty(&path).unwrap();
        let count = git_output(&path, &["rev-list", "--count", "HEAD"]).unwrap();
        fs::remove_dir_all(&path).unwrap();

        assert!(matches!(again, OperationResult::Completed(_)));
        assert!(!dirty);
        assert_eq!(count, "2");
    }

    #[test]
    fn fast_forwards_branches_using_their_configured_upstreams() {
        for (remote, branch, checkout, upstream_short) in [
            ("origin", "origin/feature", true, "remotes/origin/feature"),
            ("team/fork", "topic", false, "team/fork/feature"),
        ] {
            let (remote_path, run_remote) = scratch_repository("pull-remote");
            run_remote(&["commit", "--quiet", "--allow-empty", "--message", "base"]);
            run_remote(&["switch", "--quiet", "-c", "feature"]);
            let (path, run) = scratch_repository("pull-local");
            let upstream = format!("refs/remotes/{remote}/feature");
            let local_ref = format!("refs/heads/{branch}");
            run(&["remote", "add", remote, &remote_path]);
            run(&["fetch", remote, "refs/heads/feature"]);
            run(&["branch", "--track", branch, &upstream]);
            run(&["branch", "main", &upstream]);
            if checkout {
                run(&["switch", "--quiet", branch]);
            }

            run_remote(&["commit", "--quiet", "--allow-empty", "--message", "ahead"]);
            let tip = resolve_commit(&remote_path, "refs/heads/feature").unwrap();
            let result = fast_forward_branch(&path, branch);
            let local_tip = resolve_commit(&path, &local_ref).unwrap();
            let tracking_tip = resolve_commit(&path, &upstream).unwrap();
            remove_scratch_repository(&path);
            remove_scratch_repository(&remote_path);

            match result.unwrap() {
                OperationResult::Completed(completed) => {
                    assert_eq!(completed.summary, format!("Fast-forwarded {branch} to {upstream_short}."));
                }
                OperationResult::Failed(failure) => panic!("{branch}: {}", failure.message),
            }
            assert_eq!(local_tip, tip);
            assert_eq!(tracking_tip, tip);
        }
    }

    #[test]
    fn names_the_remote_branch_in_the_merge_subject_when_a_local_name_collides() {
        let (path, run) = scratch_repository("merge-remote-ref");
        run(&["config", "merge.log", "true"]);
        run(&["commit", "--quiet", "--allow-empty", "--message", "base"]);
        run(&["branch", "origin/main"]);
        run(&["branch", "feature"]);
        run(&["commit", "--quiet", "--allow-empty", "--message", "remote"]);
        let source = "refs/remotes/origin/main";
        run(&["update-ref", source, "HEAD"]);
        let remote_sha = resolve_commit(&path, source).unwrap();
        run(&["checkout", "--quiet", "feature"]);

        let options = MergeOptions { mode: "noFastForward".to_string(), message: None };
        let result = merge_into_branch(&path, source, "feature", &options).unwrap();
        let subject = git_output(&path, &["log", "-1", "--format=%s"]);
        let body = git_output(&path, &["log", "-1", "--format=%b"]);
        let merged_sha = resolve_commit(&path, "HEAD^2");
        fs::remove_dir_all(&path).unwrap();

        assert!(matches!(result, OperationResult::Completed(_)));
        assert_eq!(subject.as_deref(), Some("Merge remote-tracking branch 'origin/main' into feature"));
        assert_eq!(body.as_deref(), Some("* origin/main:\n  remote"));
        assert_eq!(merged_sha.unwrap(), remote_sha);
    }

    #[test]
    fn merges_a_remote_ref_into_an_unborn_branch() {
        let (path, run) = scratch_repository("merge-remote-unborn");
        run(&["commit", "--quiet", "--allow-empty", "--message", "base"]);
        let source = "refs/remotes/origin/main";
        run(&["update-ref", source, "HEAD"]);
        let remote_sha = resolve_commit(&path, source).unwrap();
        run(&["symbolic-ref", "HEAD", "refs/heads/feature"]);

        let options = MergeOptions { mode: "default".to_string(), message: None };
        let result = merge_into_branch(&path, source, "feature", &options).unwrap();
        let merged_sha = resolve_commit(&path, "HEAD");
        fs::remove_dir_all(&path).unwrap();

        assert!(matches!(result, OperationResult::Completed(_)));
        assert_eq!(merged_sha.unwrap(), remote_sha);
    }

    #[test]
    fn reports_the_moved_branch_of_a_fast_forward_merge() {
        let (path, run) = scratch_repository("merge-forward");
        fs::write(Path::new(&path).join("file.txt"), "base\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        let base = resolve_commit(&path, "refs/heads/main").unwrap();
        run(&["checkout", "--quiet", "-b", "topic"]);
        run(&["commit", "--quiet", "--allow-empty", "--message", "ahead"]);
        let topic = resolve_commit(&path, "refs/heads/topic").unwrap();
        run(&["checkout", "--quiet", "main"]);

        let options = MergeOptions { mode: "default".to_string(), message: None };
        let result = merge_into_branch(&path, "topic", "main", &options).unwrap();
        fs::remove_dir_all(&path).unwrap();

        let OperationResult::Completed(completed) = result else {
            panic!("a fast-forward merge should complete");
        };
        assert_eq!(completed.updates.len(), 1);
        assert_eq!(completed.updates[0].reference, "refs/heads/main");
        assert_eq!((completed.updates[0].before.as_str(), completed.updates[0].after.as_str()), (base.as_str(), topic.as_str()));
    }

    #[test]
    fn undoes_a_created_branch_by_deleting_it() {
        let (path, run) = scratch_repository("undo-create");
        fs::write(Path::new(&path).join("file.txt"), "base\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);

        let result = create_branch_at(&path, "topic", "main", &BranchOptions { checkout: false, track: false }).unwrap();
        let OperationResult::Completed(completed) = result else {
            panic!("creating a branch should complete");
        };
        restore_refs(&path, &completed.updates).unwrap();
        let branches = git_output_allow_empty(&path, &["for-each-ref", "--format=%(refname:short)", "refs/heads"]).unwrap();
        fs::remove_dir_all(&path).unwrap();

        assert_eq!(completed.updates.len(), 1);
        assert_eq!(completed.updates[0].reference, "refs/heads/topic");
        assert_eq!(completed.updates[0].before, "");
        assert_eq!(branches.lines().collect::<Vec<_>>(), vec!["main"]);
    }
}
