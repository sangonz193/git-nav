use crate::cleanup::{cleanup_candidates, cleanup_database_path, CleanupOptions};
use crate::git::{
    changed_refs, git_error_message, git_output_allow_empty, git_result, primary_reference,
    ref_shas, resolve_commit, RefUpdate,
};
use crate::worktrees::{
    pending_operation, pending_operation_label, worktree_is_dirty, worktree_paths_by_branch,
};
use serde::Serialize;
use std::{collections::HashSet, path::PathBuf};

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FastForwardCandidate {
    pub(crate) branch: String,
    pub(crate) worktree: Option<String>,
    pub(crate) blocker: Option<String>,
    #[serde(skip)]
    reference: String,
    #[serde(skip)]
    sha: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FailedFastForward {
    branch: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BranchFastForward {
    target: String,
    moved: Vec<String>,
    failed: Vec<FailedFastForward>,
    updates: Vec<RefUpdate>,
}

fn worktree_blocker(worktree: &str) -> Result<Option<String>, String> {
    if let Some(operation) = pending_operation(worktree) {
        return Ok(Some(pending_operation_label(&operation).to_string()));
    }
    if worktree_is_dirty(worktree)? {
        return Ok(Some("uncommitted changes".to_string()));
    }
    Ok(None)
}

fn canonical_local_branch(branch: &str) -> &str {
    branch.strip_prefix("heads/").unwrap_or(branch)
}

fn cleanup_exclusions(
    repo_path: &str,
    options: &CleanupOptions,
    database_path: Option<PathBuf>,
) -> Result<HashSet<String>, String> {
    let candidates = match cleanup_candidates(repo_path, options, database_path) {
        Ok(candidates) => candidates,
        Err(error)
            if options.delete_merged_pull_request_branches
                && matches!(
                    error.as_str(),
                    "Could not identify the origin remote."
                        | "Only GitHub remotes are supported."
                ) => {
            let mut options = options.clone();
            options.delete_merged_pull_request_branches = false;
            cleanup_candidates(repo_path, &options, None)?
        }
        Err(error) => return Err(error),
    };
    Ok(candidates
        .into_iter()
        .map(|candidate| canonical_local_branch(&candidate.branch).to_string())
        .collect())
}

fn fast_forward_candidate(
    repo_path: &str,
    primary_sha: &str,
    candidate: &FastForwardCandidate,
) -> Result<std::process::Output, String> {
    match &candidate.worktree {
        Some(worktree) => git_result(worktree, &["merge", "--ff-only", primary_sha]),
        None => git_result(
            repo_path,
            &[
                "update-ref",
                &candidate.reference,
                primary_sha,
                &candidate.sha,
            ],
        ),
    }
}

// Cleanup already leaves out checked-out branches, so a parked worktree on a merged branch lands
// here and is moved instead of stranded.
pub(crate) fn fast_forward_candidates(
    repo_path: &str,
    options: &CleanupOptions,
    database_path: Option<PathBuf>,
) -> Result<(String, Vec<FastForwardCandidate>), String> {
    let primary = primary_reference(repo_path)?;
    let primary_sha = resolve_commit(repo_path, &primary)?;
    let excluded = cleanup_exclusions(repo_path, options, database_path)?;
    let refs = git_output_allow_empty(
        repo_path,
        &[
            "for-each-ref",
            "--merged",
            &primary,
            "--format=%(refname)%00%(objectname)",
            "refs/heads",
        ],
    )?;
    let worktrees = worktree_paths_by_branch(repo_path)?;
    let mut candidates = Vec::new();
    for (reference, sha) in refs.lines().filter_map(|line| line.split_once('\0')) {
        let Some(branch) = reference.strip_prefix("refs/heads/") else {
            continue;
        };
        if sha == primary_sha || excluded.contains(canonical_local_branch(branch)) {
            continue;
        }
        let worktree = worktrees.get(branch).cloned();
        let blocker = worktree
            .as_deref()
            .map(worktree_blocker)
            .transpose()?
            .flatten();
        candidates.push(FastForwardCandidate {
            branch: branch.to_string(),
            worktree,
            blocker,
            reference: reference.to_string(),
            sha: sha.to_string(),
        });
    }
    candidates.sort_by(|left, right| left.branch.cmp(&right.branch));
    Ok((primary, candidates))
}

pub(crate) fn fast_forward_branches(
    repo_path: &str,
    options: &CleanupOptions,
    database_path: Option<PathBuf>,
) -> Result<BranchFastForward, String> {
    let (primary, candidates) = fast_forward_candidates(repo_path, options, database_path)?;
    let primary_sha = resolve_commit(repo_path, &primary)?;
    let before = ref_shas(repo_path)?;
    let mut moved = Vec::new();
    let mut failed = Vec::new();
    for candidate in candidates
        .into_iter()
        .filter(|candidate| candidate.blocker.is_none())
    {
        let output = fast_forward_candidate(repo_path, &primary_sha, &candidate)?;
        if output.status.success() {
            moved.push(candidate.branch);
        } else {
            failed.push(FailedFastForward {
                branch: candidate.branch,
                message: git_error_message(&output),
            });
        }
    }
    Ok(BranchFastForward {
        target: primary,
        moved,
        failed,
        updates: changed_refs(&before, &ref_shas(repo_path)?),
    })
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn preview_fast_forward_candidates(
    repo_path: String,
    options: CleanupOptions,
) -> Result<Vec<FastForwardCandidate>, String> {
    let database_path = cleanup_database_path(&options)?;
    tauri::async_runtime::spawn_blocking(move || {
        fast_forward_candidates(&repo_path, &options, database_path)
            .map(|(_, candidates)| candidates)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn fast_forward_merged_branches(
    repo_path: String,
    options: CleanupOptions,
) -> Result<BranchFastForward, String> {
    let database_path = cleanup_database_path(&options)?;
    tauri::async_runtime::spawn_blocking(move || {
        fast_forward_branches(&repo_path, &options, database_path)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::git_output;
    use crate::test_support::{remove_scratch_repository, scratch_repository};
    use std::{env, fs, path::Path};

    fn options(delete_merged_branches: bool) -> CleanupOptions {
        CleanupOptions {
            delete_merged_pull_request_branches: false,
            delete_merged_branches,
            delete_squash_merged_branches: true,
        }
    }

    fn sha(path: &str, reference: &str) -> String {
        git_output(path, &["rev-parse", reference]).unwrap()
    }

    struct Fixture {
        path: String,
        clean_worktree: String,
        dirty_worktree: String,
    }

    // main carries two commits past the fork. `trailing` and `empty` sit behind with nothing of their
    // own, `squashed` was squash-merged, `open` has unmerged work, and two worktrees hold branches
    // behind main: one clean, one with a modified file.
    fn fixture(name: &str) -> Fixture {
        let (path, run) = scratch_repository(name);
        let write =
            |file: &str, contents: &str| fs::write(Path::new(&path).join(file), contents).unwrap();
        write("shared.txt", "base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["branch", "trailing"]);
        run(&["branch", "empty"]);
        run(&["branch", "parked-clean"]);
        run(&["branch", "parked-dirty"]);

        run(&["checkout", "--quiet", "-b", "squashed"]);
        write("squashed.txt", "one\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "squashed"]);
        run(&["checkout", "--quiet", "main"]);
        run(&["merge", "--quiet", "--squash", "squashed"]);
        run(&["commit", "--quiet", "--message", "Merge branch 'squashed'"]);

        run(&["checkout", "--quiet", "-b", "open"]);
        write("open.txt", "wip\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "open"]);
        run(&["checkout", "--quiet", "main"]);
        write("shared.txt", "base\nmore\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "more"]);

        let clean_worktree =
            env::temp_dir().join(format!("git-nav-{name}-clean-{}", std::process::id()));
        let dirty_worktree =
            env::temp_dir().join(format!("git-nav-{name}-dirty-{}", std::process::id()));
        let _ = fs::remove_dir_all(&clean_worktree);
        let _ = fs::remove_dir_all(&dirty_worktree);
        run(&[
            "worktree",
            "add",
            "--quiet",
            &clean_worktree.to_string_lossy(),
            "parked-clean",
        ]);
        run(&[
            "worktree",
            "add",
            "--quiet",
            &dirty_worktree.to_string_lossy(),
            "parked-dirty",
        ]);
        fs::write(dirty_worktree.join("shared.txt"), "edited\n").unwrap();
        Fixture {
            path,
            clean_worktree: clean_worktree.to_string_lossy().into_owned(),
            dirty_worktree: dirty_worktree.to_string_lossy().into_owned(),
        }
    }

    fn discard(fixture: &Fixture) {
        let _ = fs::remove_dir_all(&fixture.clean_worktree);
        let _ = fs::remove_dir_all(&fixture.dirty_worktree);
        remove_scratch_repository(&fixture.path);
    }

    fn head_primary_fixture(name: &str) -> (String, String) {
        let (path, run) = scratch_repository(name);
        fs::write(Path::new(&path).join("shared.txt"), "base\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["branch", "trailing"]);
        run(&["branch", "-m", "trunk"]);
        fs::write(Path::new(&path).join("shared.txt"), "base\nmore\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "more"]);

        let worktree =
            env::temp_dir().join(format!("git-nav-{name}-worktree-{}", std::process::id()));
        let _ = fs::remove_dir_all(&worktree);
        run(&[
            "worktree",
            "add",
            "--quiet",
            &worktree.to_string_lossy(),
            "trailing",
        ]);
        (path, worktree.to_string_lossy().into_owned())
    }

    #[test]
    fn offers_branches_behind_main_that_cleanup_leaves_alone() {
        let fixture = fixture("fast-forward-candidates");
        let (primary, candidates) =
            fast_forward_candidates(&fixture.path, &options(false), None).unwrap();
        discard(&fixture);

        assert_eq!(primary, "main");
        let summary = candidates
            .iter()
            .map(|candidate| {
                (
                    candidate.branch.as_str(),
                    candidate.worktree.is_some(),
                    candidate.blocker.as_deref(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            summary,
            [
                ("empty", false, None),
                ("parked-clean", true, None),
                ("parked-dirty", true, Some("uncommitted changes")),
                ("trailing", false, None),
            ]
        );
    }

    #[test]
    fn keeps_checked_out_branches_when_cleanup_claims_every_merged_branch() {
        let fixture = fixture("fast-forward-merged-option");
        let (_, candidates) = fast_forward_candidates(&fixture.path, &options(true), None).unwrap();
        discard(&fixture);

        let branches = candidates
            .iter()
            .map(|candidate| candidate.branch.as_str())
            .collect::<Vec<_>>();
        assert_eq!(branches, ["parked-clean", "parked-dirty"]);
    }

    #[test]
    fn moves_every_unblocked_branch_to_main_and_reports_the_updates() {
        let fixture = fixture("fast-forward-run");
        let main = sha(&fixture.path, "main");
        let dirty_before = sha(&fixture.path, "parked-dirty");
        let result = fast_forward_branches(&fixture.path, &options(false), None).unwrap();
        let moved = ["empty", "parked-clean", "trailing"].map(|branch| sha(&fixture.path, branch));
        let clean_head = git_output(&fixture.clean_worktree, &["rev-parse", "HEAD"]).unwrap();
        let clean_file =
            fs::read_to_string(Path::new(&fixture.clean_worktree).join("shared.txt")).unwrap();
        let dirty_after = sha(&fixture.path, "parked-dirty");
        discard(&fixture);

        assert_eq!(result.target, "main");
        assert_eq!(result.moved, ["empty", "parked-clean", "trailing"]);
        assert!(
            result.failed.is_empty(),
            "{:?}",
            result
                .failed
                .iter()
                .map(|failure| &failure.message)
                .collect::<Vec<_>>()
        );
        assert!(moved.iter().all(|sha| *sha == main));
        assert_eq!(
            clean_head, main,
            "the worktree itself moves, not only its ref"
        );
        assert_eq!(clean_file, "base\nmore\n");
        assert_eq!(
            dirty_after, dirty_before,
            "a dirty worktree is left where it is"
        );
        let mut updated = result
            .updates
            .iter()
            .map(|update| update.reference.as_str())
            .collect::<Vec<_>>();
        updated.sort();
        assert_eq!(
            updated,
            [
                "refs/heads/empty",
                "refs/heads/parked-clean",
                "refs/heads/trailing"
            ]
        );
        assert!(result.updates.iter().all(|update| update.after == main));
    }

    #[test]
    fn moves_prunable_worktree_refs_without_blocking_other_branches() {
        let fixture = fixture("fast-forward-prunable-worktree");
        let main = sha(&fixture.path, "main");
        let parked_clean_before = sha(&fixture.path, "parked-clean");
        fs::remove_dir_all(&fixture.clean_worktree).unwrap();

        let (_, candidates) =
            fast_forward_candidates(&fixture.path, &options(false), None).unwrap();
        let result = fast_forward_branches(&fixture.path, &options(false), None).unwrap();
        discard(&fixture);

        assert!(candidates.iter().any(|candidate| {
            candidate.branch == "parked-clean"
                && candidate.worktree.is_none()
                && candidate.blocker.is_none()
        }));
        assert!(result.moved.iter().any(|branch| branch == "parked-clean"));
        assert!(result.moved.iter().any(|branch| branch == "trailing"));
        assert!(result.updates.iter().any(|update| {
            update.reference == "refs/heads/parked-clean"
                && update.before == parked_clean_before
                && update.after == main
        }));
    }

    #[test]
    fn uses_the_discovered_sha_to_guard_ref_updates() {
        let fixture = fixture("fast-forward-compare-and-swap");
        let (_, candidates) =
            fast_forward_candidates(&fixture.path, &options(false), None).unwrap();
        let candidate = candidates
            .into_iter()
            .find(|candidate| candidate.branch == "trailing")
            .unwrap();
        let advanced = sha(&fixture.path, "open");
        let primary = sha(&fixture.path, "main");
        git_result(
            &fixture.path,
            &["update-ref", "refs/heads/trailing", &advanced],
        )
        .unwrap();
        let output = fast_forward_candidate(&fixture.path, &primary, &candidate).unwrap();
        let trailing = sha(&fixture.path, "trailing");
        discard(&fixture);

        assert!(!output.status.success());
        assert_eq!(trailing, advanced);
    }

    #[test]
    fn merges_the_primary_sha_when_head_is_the_only_primary_reference() {
        let (path, worktree) = head_primary_fixture("fast-forward-head-primary");
        let primary = sha(&path, "trunk");
        let result = fast_forward_branches(&path, &options(false), None).unwrap();
        let trailing = sha(&worktree, "HEAD");
        let _ = fs::remove_dir_all(&worktree);
        remove_scratch_repository(&path);

        assert_eq!(result.target, "HEAD");
        assert_eq!(result.moved, ["trailing"]);
        assert_eq!(trailing, primary);
    }

    #[test]
    fn keeps_the_local_ref_when_a_tag_has_the_same_short_name() {
        let fixture = fixture("fast-forward-ambiguous-short-ref");
        let trailing_before = sha(&fixture.path, "trailing");
        let primary = sha(&fixture.path, "main");
        git_result(&fixture.path, &["tag", "trailing", &trailing_before]).unwrap();
        let (_, candidates) =
            fast_forward_candidates(&fixture.path, &options(false), None).unwrap();
        let result = fast_forward_branches(&fixture.path, &options(false), None).unwrap();
        let trailing = sha(&fixture.path, "refs/heads/trailing");
        let refs = ref_shas(&fixture.path).unwrap();
        discard(&fixture);

        assert!(candidates
            .iter()
            .any(|candidate| candidate.branch == "trailing"));
        assert_eq!(trailing, primary);
        assert!(!refs.contains_key("refs/heads/heads/trailing"));
        assert!(result.moved.iter().any(|branch| branch == "trailing"));
    }

    #[test]
    fn excludes_cleanup_candidates_when_a_tag_qualifies_their_short_name() {
        let fixture = fixture("fast-forward-qualified-cleanup-candidate");
        let trailing = sha(&fixture.path, "trailing");
        git_result(&fixture.path, &["tag", "trailing", &trailing]).unwrap();
        let (_, candidates) =
            fast_forward_candidates(&fixture.path, &options(true), None).unwrap();
        discard(&fixture);

        let branches = candidates
            .iter()
            .map(|candidate| candidate.branch.as_str())
            .collect::<Vec<_>>();
        assert_eq!(branches, ["parked-clean", "parked-dirty"]);
    }

    #[test]
    fn skips_pull_request_cleanup_when_origin_is_not_github() {
        let fixture = fixture("fast-forward-without-github-origin");
        let database_path = env::temp_dir().join(format!(
            "git-nav-fast-forward-without-github-origin-{}.sqlite",
            std::process::id()
        ));
        let options = CleanupOptions {
            delete_merged_pull_request_branches: true,
            delete_merged_branches: false,
            delete_squash_merged_branches: true,
        };
        let (_, candidates) =
            fast_forward_candidates(&fixture.path, &options, Some(database_path.clone())).unwrap();
        discard(&fixture);
        let _ = fs::remove_file(database_path);

        assert!(candidates.iter().any(|candidate| candidate.branch == "trailing"));
    }
}
