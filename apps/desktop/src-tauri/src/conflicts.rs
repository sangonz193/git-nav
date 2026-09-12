use serde::Serialize;
use crate::git::{
    git_error_message, git_output, git_output_allow_empty, git_result, git_version, is_ancestor,
    resolve_commit,
};

const MINIMUM_MERGE_TREE_VERSION: (u32, u32) = (2, 38);
const MINIMUM_MERGE_TREE_WITH_BASE_VERSION: (u32, u32) = (2, 40);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PredictedConflict {
    commit: String,
    subject: String,
    files: Vec<String>,
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub(crate) enum ConflictPrediction {
    Clean,
    Conflicts(PredictedConflict),
    Unknown { reason: String },
}

fn parse_merge_tree_output(stdout: &str) -> Result<(String, Vec<String>), String> {
    let mut fields = stdout.split('\0');
    let tree = fields
        .next()
        .filter(|tree| !tree.is_empty())
        .ok_or_else(|| "git merge-tree produced no tree.".to_string())?;
    Ok((
        tree.to_string(),
        fields.take_while(|field| !field.is_empty()).map(str::to_string).collect(),
    ))
}

fn merge_tree_unavailable(
    version: Option<(u32, u32)>,
    minimum_version: (u32, u32),
    capability: &str,
) -> Option<ConflictPrediction> {
    let Some(version) = version else {
        return Some(ConflictPrediction::Unknown { reason: "Could not read the installed Git version.".to_string() });
    };
    if version < minimum_version {
        let (major, minor) = minimum_version;
        return Some(ConflictPrediction::Unknown {
            reason: format!("{capability} requires Git {major}.{minor} or newer."),
        });
    }
    None
}

fn predicted_conflicts(repo_path: &str, onto: &str, upstream: &str, branch: &str) -> Result<ConflictPrediction, String> {
    if let Some(prediction) = merge_tree_unavailable(
        git_version(repo_path),
        MINIMUM_MERGE_TREE_WITH_BASE_VERSION,
        "Predicting conflicts",
    ) {
        return Ok(prediction);
    }
    let onto_sha = resolve_commit(repo_path, onto)?;
    let upstream_sha = resolve_commit(repo_path, upstream)?;
    let branch_sha = resolve_commit(repo_path, branch)?;
    // Three dots so --cherry-pick sees the upstream side and drops the commits git rebase would skip as already applied.
    let range = format!("{upstream_sha}...{branch_sha}");
    let commits = git_output_allow_empty(
        repo_path,
        &["rev-list", "--reverse", "--topo-order", "--no-merges", "--cherry-pick", "--right-only", &range],
    )?;
    let mut accumulated = git_output(repo_path, &["rev-parse", "--verify", &format!("{onto_sha}^{{tree}}")])
        .ok_or_else(|| format!("Could not resolve the tree of {onto}."))?;

    for commit in commits.lines() {
        let Some(parent) = git_output(repo_path, &["rev-parse", "--verify", "--quiet", &format!("{commit}^1")]) else {
            return Ok(ConflictPrediction::Unknown { reason: format!("{commit} has no parent to replay against.") });
        };
        let output = git_result(
            repo_path,
            &[
                "merge-tree",
                "-z",
                "--write-tree",
                "--name-only",
                &format!("--merge-base={parent}"),
                &accumulated,
                commit,
            ],
        )?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        match output.status.code() {
            Some(0) => accumulated = parse_merge_tree_output(&stdout)?.0,
            Some(1) => {
                return Ok(ConflictPrediction::Conflicts(PredictedConflict {
                    commit: commit.to_string(),
                    subject: git_output(repo_path, &["log", "-1", "--format=%s", commit]).unwrap_or_default(),
                    files: parse_merge_tree_output(&stdout)?.1,
                }))
            }
            _ => {
                return Ok(ConflictPrediction::Unknown {
                    reason: String::from_utf8_lossy(&output.stderr).trim().to_string(),
                })
            }
        }
    }

    Ok(ConflictPrediction::Clean)
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn predict_rebase_conflicts(
    repo_path: String,
    onto: String,
    upstream: String,
    branch: String,
) -> Result<ConflictPrediction, String> {
    tauri::async_runtime::spawn_blocking(move || predicted_conflicts(&repo_path, &onto, &upstream, &branch))
        .await
        .map_err(|error| error.to_string())?
}

fn predicted_merge_conflicts(repo_path: &str, source: &str, into: &str) -> Result<ConflictPrediction, String> {
    if let Some(prediction) = merge_tree_unavailable(
        git_version(repo_path),
        MINIMUM_MERGE_TREE_VERSION,
        "Predicting merge conflicts with git merge-tree --write-tree",
    ) {
        return Ok(prediction);
    }
    let source_sha = resolve_commit(repo_path, source)?;
    let into_sha = resolve_commit(repo_path, into)?;
    if is_ancestor(repo_path, &source_sha, &into_sha) || is_ancestor(repo_path, &into_sha, &source_sha) {
        return Ok(ConflictPrediction::Clean);
    }
    let output = git_result(repo_path, &["merge-tree", "-z", "--write-tree", "--name-only", &into_sha, &source_sha])?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    match output.status.code() {
        Some(0) => Ok(ConflictPrediction::Clean),
        Some(1) => Ok(ConflictPrediction::Conflicts(PredictedConflict {
            commit: source_sha,
            subject: git_output(repo_path, &["log", "-1", "--format=%s", source]).unwrap_or_default(),
            files: parse_merge_tree_output(&stdout)?.1,
        })),
        _ => Ok(ConflictPrediction::Unknown { reason: git_error_message(&output) }),
    }
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn predict_merge_conflicts(repo_path: String, source: String, into: String) -> Result<ConflictPrediction, String> {
    tauri::async_runtime::spawn_blocking(move || predicted_merge_conflicts(&repo_path, &source, &into))
        .await
        .map_err(|error| error.to_string())?
}

// git revert walks a range newest first and undoes each commit against the result of the ones before it,
// so the prediction has to replay that same sequence rather than test the range as one change.
fn predicted_revert_conflicts(repo_path: &str, base: &str, tip: &str) -> Result<ConflictPrediction, String> {
    if let Some(prediction) = merge_tree_unavailable(
        git_version(repo_path),
        MINIMUM_MERGE_TREE_WITH_BASE_VERSION,
        "Predicting revert conflicts with git merge-tree --merge-base",
    ) {
        return Ok(prediction);
    }
    let head_sha = resolve_commit(repo_path, "HEAD")?;
    let base_sha = resolve_commit(repo_path, base)?;
    let tip_sha = resolve_commit(repo_path, tip)?;
    let commits = git_output_allow_empty(repo_path, &["rev-list", &format!("{base_sha}..{tip_sha}")])?;
    let mut accumulated = git_output(repo_path, &["rev-parse", "--verify", &format!("{head_sha}^{{tree}}")])
        .ok_or_else(|| "Could not resolve the tree of HEAD.".to_string())?;

    for commit in commits.lines() {
        if git_output(repo_path, &["rev-parse", "--verify", "--quiet", &format!("{commit}^2")]).is_some() {
            return Ok(ConflictPrediction::Unknown {
                reason: format!("{} is a merge commit, and reverting one needs a mainline to keep.", &commit[..8.min(commit.len())]),
            });
        }
        let Some(parent) = git_output(repo_path, &["rev-parse", "--verify", "--quiet", &format!("{commit}^1")]) else {
            return Ok(ConflictPrediction::Unknown { reason: format!("{} has no parent to undo against.", &commit[..8.min(commit.len())]) });
        };
        // Undoing a commit is the change from it back to its parent, so the commit itself is what both sides start from.
        let output = git_result(
            repo_path,
            &[
                "merge-tree",
                "-z",
                "--write-tree",
                "--name-only",
                &format!("--merge-base={commit}"),
                &accumulated,
                &parent,
            ],
        )?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        match output.status.code() {
            Some(0) => accumulated = parse_merge_tree_output(&stdout)?.0,
            Some(1) => {
                return Ok(ConflictPrediction::Conflicts(PredictedConflict {
                    commit: commit.to_string(),
                    subject: git_output(repo_path, &["log", "-1", "--format=%s", commit]).unwrap_or_default(),
                    files: parse_merge_tree_output(&stdout)?.1,
                }))
            }
            _ => return Ok(ConflictPrediction::Unknown { reason: git_error_message(&output) }),
        }
    }

    Ok(ConflictPrediction::Clean)
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn predict_revert_conflicts(repo_path: String, base: String, tip: String) -> Result<ConflictPrediction, String> {
    tauri::async_runtime::spawn_blocking(move || predicted_revert_conflicts(&repo_path, &base, &tip))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{env, fs, path::Path};
    use crate::git::OperationResult;
    use crate::operations::rebase_branch_onto;
    use crate::test_support::scratch_repository;

    #[test]
    fn requires_the_merge_base_capability_for_replay_predictions() {
        assert!(
            merge_tree_unavailable(
                Some((2, 38)),
                MINIMUM_MERGE_TREE_VERSION,
                "Predicting merge conflicts"
            )
            .is_none()
        );

        let Some(ConflictPrediction::Unknown { reason }) = merge_tree_unavailable(
            Some((2, 39)),
            MINIMUM_MERGE_TREE_WITH_BASE_VERSION,
            "Predicting conflicts",
        )
        else {
            panic!("Git 2.39 should not be used for replay predictions");
        };
        assert_eq!(
            reason,
            "Predicting conflicts requires Git 2.40 or newer."
        );

        assert!(merge_tree_unavailable(
            Some((2, 40)),
            MINIMUM_MERGE_TREE_WITH_BASE_VERSION,
            "Predicting conflicts",
        )
        .is_none());
    }

    #[test]
    fn reads_the_written_tree_from_a_clean_merge() {
        let (tree, files) = parse_merge_tree_output("tree-sha\0").unwrap();

        assert_eq!(tree, "tree-sha");
        assert!(files.is_empty());
    }

    #[test]
    fn reads_conflicted_paths_before_the_informational_messages() {
        let (tree, files) =
            parse_merge_tree_output("tree-sha\0a.txt\0b.txt\0\01\0a.txt\0CONFLICT (contents)\0message\0").unwrap();

        assert_eq!(tree, "tree-sha");
        assert_eq!(files, vec!["a.txt".to_string(), "b.txt".to_string()]);
    }

    #[test]
    fn predicts_the_first_conflicting_commit_of_a_rebase() {
        let path = env::temp_dir()
            .join(format!("git-nav-prediction-{}", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        let run = |arguments: &[&str]| {
            let output = git_result(&path, arguments).unwrap();
            assert!(output.status.success(), "{arguments:?}: {}", String::from_utf8_lossy(&output.stderr));
        };
        let write = |name: &str, contents: &str| fs::write(Path::new(&path).join(name), contents).unwrap();
        run(&["init", "--quiet", "--initial-branch=main"]);
        run(&["config", "user.email", "tests@example.com"]);
        run(&["config", "user.name", "Tests"]);
        run(&["config", "commit.gpgsign", "false"]);
        write("shared.txt", "base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["branch", "feature"]);
        write("shared.txt", "onto\n");
        run(&["commit", "--quiet", "--all", "--message", "diverge"]);
        run(&["checkout", "--quiet", "feature"]);
        write("only-feature.txt", "feature\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "add a file"]);
        write("shared.txt", "feature\n");
        run(&["commit", "--quiet", "--all", "--message", "change the shared file"]);

        let clean = predicted_conflicts(&path, "main", "feature~2", "feature~1").unwrap();
        let conflicted = predicted_conflicts(&path, "main", "feature~2", "feature").unwrap();
        fs::remove_dir_all(&path).unwrap();

        assert!(matches!(clean, ConflictPrediction::Clean));
        let ConflictPrediction::Conflicts(conflict) = conflicted else {
            panic!("expected a conflict");
        };
        assert_eq!(conflict.subject, "change the shared file");
        assert_eq!(conflict.files, vec!["shared.txt".to_string()]);
    }

    #[test]
    fn ignores_commits_whose_patch_is_already_upstream() {
        let path = env::temp_dir()
            .join(format!("git-nav-patch-duplicate-{}", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        let run = |arguments: &[&str]| {
            let output = git_result(&path, arguments).unwrap();
            assert!(output.status.success(), "{arguments:?}: {}", String::from_utf8_lossy(&output.stderr));
        };
        let write = |name: &str, contents: &str| fs::write(Path::new(&path).join(name), contents).unwrap();
        run(&["init", "--quiet", "--initial-branch=main"]);
        run(&["config", "user.email", "tests@example.com"]);
        run(&["config", "user.name", "Tests"]);
        run(&["config", "commit.gpgsign", "false"]);
        write("shared.txt", "base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["branch", "onto"]);
        run(&["checkout", "--quiet", "-b", "feature"]);
        write("shared.txt", "duplicate\n");
        run(&["commit", "--quiet", "--all", "--message", "change the shared file"]);
        write("only-feature.txt", "feature\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "add a file"]);
        run(&["checkout", "--quiet", "main"]);
        run(&["cherry-pick", "feature~1"]);
        run(&["commit", "--quiet", "--amend", "--message", "land the shared file change"]);
        run(&["checkout", "--quiet", "onto"]);
        write("shared.txt", "onto\n");
        run(&["commit", "--quiet", "--all", "--message", "diverge"]);

        let prediction = predicted_conflicts(&path, "onto", "main", "feature").unwrap();
        let rebase = rebase_branch_onto(&path, "onto", "main", "feature").unwrap();
        let replayed = git_output_allow_empty(&path, &["log", "--format=%s", "onto..feature"]).unwrap();
        fs::remove_dir_all(&path).unwrap();

        assert!(matches!(prediction, ConflictPrediction::Clean));
        assert!(matches!(rebase, OperationResult::Completed(_)));
        assert_eq!(replayed.lines().collect::<Vec<_>>(), vec!["add a file"]);
    }

    #[test]
    fn predicts_the_commit_a_revert_stops_on() {
        let (path, run) = scratch_repository("revert-prediction");
        let write = |contents: &str| fs::write(Path::new(&path).join("shared.txt"), contents).unwrap();
        write("one\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        let base = resolve_commit(&path, "HEAD").unwrap();
        write("two\n");
        run(&["commit", "--quiet", "--all", "--message", "second"]);
        let tip = resolve_commit(&path, "HEAD").unwrap();
        write("three\n");
        run(&["commit", "--quiet", "--all", "--message", "third"]);

        let conflicting = predicted_revert_conflicts(&path, &base, &tip).unwrap();
        let clean = predicted_revert_conflicts(&path, &tip, &resolve_commit(&path, "HEAD").unwrap()).unwrap();
        fs::remove_dir_all(&path).unwrap();

        let ConflictPrediction::Conflicts(conflict) = conflicting else {
            panic!("reverting a commit later rewritten should be predicted to conflict");
        };
        assert_eq!(conflict.subject, "second");
        assert_eq!(conflict.files, vec!["shared.txt".to_string()]);
        assert!(matches!(clean, ConflictPrediction::Clean));
    }
}
