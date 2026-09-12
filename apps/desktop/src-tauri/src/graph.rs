use std::{
    collections::hash_map::DefaultHasher, hash::Hash, hash::Hasher, io::BufRead, io::BufReader,
    process::Stdio,
};
use tauri::ipc::Channel;
use crate::process::external_command;
use crate::git::{
    ChildGuard, git_output_allow_empty, is_ancestor, primary_reference, resolve_commit,
};

const COMMIT_BATCH_SIZE: usize = 500;

fn lane_for(lanes: &mut Vec<Option<String>>, hash: &str, reserve_first: bool) -> usize {
    if let Some(index) = lanes
        .iter()
        .position(|waiting_for| waiting_for.as_deref() == Some(hash))
    {
        return index;
    }

    let first = usize::from(reserve_first);
    if let Some(index) = lanes.iter().skip(first).position(Option::is_none) {
        return first + index;
    }

    lanes.push(None);
    lanes.len() - 1
}

pub(crate) fn parse_commit(
    line: &str,
    lanes: &mut Vec<Option<String>>,
    reserved_tip: &mut Option<String>,
) -> Option<Vec<serde_json::Value>> {
    let fields: Vec<_> = line.split('\0').collect();
    if fields.len() != 6 || fields[0].is_empty() {
        return None;
    }

    let hash = fields[0];
    let parents: Vec<_> = fields[1]
        .split_whitespace()
        .filter(|parent| !parent.is_empty())
        .collect();
    // Lane 0 stays empty until the default branch tip arrives so it reports inactive on the rows above it.
    if reserved_tip.is_some() && lanes.is_empty() {
        lanes.push(None);
    }
    let lane = if reserved_tip.as_deref() == Some(hash) {
        *reserved_tip = None;
        0
    } else {
        lane_for(lanes, hash, reserved_tip.is_some())
    };
    let incoming_lanes: Vec<_> = lanes
        .iter()
        .enumerate()
        .filter_map(|(index, waiting_for)| (waiting_for.as_deref() == Some(hash)).then_some(index))
        .collect();
    for (index, waiting_for) in lanes.iter_mut().enumerate() {
        if index != lane && waiting_for.as_deref() == Some(hash) {
            *waiting_for = None;
        }
    }
    let mut parent_lanes = Vec::with_capacity(parents.len());

    if let Some(first_parent) = parents.first() {
        lanes[lane] = Some((*first_parent).to_string());
        parent_lanes.push(lane);

        for parent in parents.iter().skip(1) {
            let parent_lane = lane_for(lanes, parent, reserved_tip.is_some());
            lanes[parent_lane] = Some((*parent).to_string());
            parent_lanes.push(parent_lane);
        }
    } else {
        lanes[lane] = None;
    }

    while lanes.last().is_some_and(Option::is_none) {
        lanes.pop();
    }
    let active_lanes: Vec<_> = lanes.iter().map(Option::is_some).collect();

    let refs = if fields[4].is_empty() {
        Vec::new()
    } else {
        fields[4].split(", ").collect()
    };

    Some(vec![
        serde_json::Value::String(hash.to_string()),
        serde_json::json!(parents),
        serde_json::Value::String(fields[2].to_string()),
        serde_json::Value::String(fields[3].to_string()),
        serde_json::json!(refs),
        serde_json::Value::String(fields[5].to_string()),
        serde_json::json!(lane),
        serde_json::json!(parent_lanes),
        serde_json::json!(lanes.len()),
        serde_json::json!(incoming_lanes),
        serde_json::json!(active_lanes),
    ])
}

/// The revisions a graph is walked from. `--all` also reaches refs/stash, refs/notes and refs/prefetch, whose
/// commits are not history and arrive as unlabelled rows, so the set is named rather than inferred.
pub(crate) fn graph_revisions(repo_path: &str) -> Vec<String> {
    let mut revisions = vec![
        "--branches".to_string(),
        "--tags".to_string(),
        "--remotes".to_string(),
    ];
    // A repository with no commits has no HEAD to resolve, and naming it as a revision fails the whole walk.
    if resolve_commit(repo_path, "HEAD").is_ok() {
        revisions.push("HEAD".to_string());
    }
    // `HEAD` names this worktree only, while `--all` reached every one of them, so a worktree sitting on a
    // detached HEAD would otherwise take its commits out of the graph with it.
    // A stash is drawn on the commit it was made from, which nothing else reaches once the branch it was
    // taken from has moved on.
    for sha in worktree_heads(repo_path).into_iter().chain(stash_bases(repo_path)) {
        if !revisions.contains(&sha) {
            revisions.push(sha);
        }
    }
    revisions
}

fn worktree_heads(repo_path: &str) -> Vec<String> {
    let Ok(output) = git_output_allow_empty(repo_path, &["worktree", "list", "--porcelain", "-z"]) else {
        return Vec::new();
    };
    output
        .split('\0')
        .filter_map(|field| field.trim().strip_prefix("HEAD ").map(str::to_string))
        .collect()
}

fn stash_bases(repo_path: &str) -> Vec<String> {
    let Ok(output) = git_output_allow_empty(repo_path, &["stash", "list", "-z", "--format=%P"]) else {
        return Vec::new();
    };
    output
        .split('\0')
        .filter_map(|record| record.split_whitespace().next())
        .map(str::to_string)
        .collect()
}

/// Feeds `on_batch` as `git log` produces rows; returning `Err` from it stops the walk early.
fn walk_commit_graph(
    repo_path: &str,
    on_batch: impl FnMut(Vec<Vec<serde_json::Value>>) -> Result<(), String>,
) -> Result<(), String> {
    walk_commit_graph_page(repo_path, 0, usize::MAX, on_batch).map(|_| ())
}

/// Feeds one contiguous graph window to `on_batch`, returning whether older commits remain.
pub(crate) fn walk_commit_graph_page(
    repo_path: &str,
    offset: usize,
    limit: usize,
    mut on_batch: impl FnMut(Vec<Vec<serde_json::Value>>) -> Result<(), String>,
) -> Result<bool, String> {
    let mut reserved_tip = reserved_lane_tip(repo_path);
    let revisions = graph_revisions(repo_path);
    let mut child = ChildGuard(
        external_command("git")
            .args(["--no-optional-locks", "-C", repo_path, "log"])
            .args(&revisions)
            .args(["--topo-order", "--format=%H%x00%P%x00%an%x00%aI%x00%D%x00%s"])
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|error| error.to_string())?,
    );
    let stdout = child
        .0
        .stdout
        .take()
        .ok_or_else(|| "Could not read git output.".to_string())?;
    let mut lanes = Vec::new();
    let mut batch = Vec::with_capacity(COMMIT_BATCH_SIZE);
    let mut skipped = 0;
    let mut sent = 0;

    // A send failure means the receiver is gone, so stop git rather than walking the whole history.
    let mut deliver = |batch| match on_batch(batch) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = child.0.kill();
            Err(error)
        }
    };

    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|error| error.to_string())?;
        if sent == limit {
            return Ok(true);
        }
        if let Some(commit) = parse_commit(&line, &mut lanes, &mut reserved_tip) {
            if skipped < offset {
                skipped += 1;
                continue;
            }
            batch.push(commit);
            sent += 1;
        }

        if batch.len() == COMMIT_BATCH_SIZE || sent == limit {
            deliver(batch)?;
            batch = Vec::with_capacity(COMMIT_BATCH_SIZE);
        }
    }

    if !batch.is_empty() {
        deliver(batch)?;
    }

    let status = child.0.wait().map_err(|error| error.to_string())?;
    if status.success() {
        Ok(false)
    } else {
        Err("git log failed.".to_string())
    }
}

// Only ever compared against the previous fingerprint from the same run, so a process-local hash is enough.
fn fingerprint(values: &[&str]) -> String {
    let mut hasher = DefaultHasher::new();
    for value in values {
        value.hash(&mut hasher);
    }
    hasher.finish().to_string()
}

// show-ref exits non-zero on a repository with no refs, and symbolic-ref does the same on a detached HEAD.
#[git_nav_macros::http_command]
#[tauri::command(async)]
pub(crate) fn repository_fingerprint(repo_path: String) -> String {
    let refs = git_output_allow_empty(&repo_path, &["--no-optional-locks", "show-ref", "--head"])
        .unwrap_or_default();
    let head = git_output_allow_empty(&repo_path, &["symbolic-ref", "--quiet", "HEAD"])
        .unwrap_or_default();
    fingerprint(&[&refs, &head])
}

#[tauri::command]
pub(crate) fn stream_commit_graph(
    repo_path: String,
    on_batch: Channel<Vec<Vec<serde_json::Value>>>,
) -> Result<(), String> {
    walk_commit_graph(&repo_path, |batch| {
        on_batch.send(batch).map_err(|error| error.to_string())
    })
}

// Lane 0 belongs to the default branch, and a local branch that is only ahead of its remote is the same
// line of history, so the reservation starts at whichever of the two can reach the other.
fn reserved_lane_tip(repo_path: &str) -> Option<String> {
    let primary = primary_reference(repo_path).ok()?;
    let primary_sha = resolve_commit(repo_path, &primary).ok()?;
    let Some(local) = primary.strip_prefix("origin/") else {
        return Some(primary_sha);
    };
    let Ok(local_sha) = resolve_commit(repo_path, &format!("refs/heads/{local}")) else {
        return Some(primary_sha);
    };
    Some(if is_ancestor(repo_path, &primary_sha, &local_sha) {
        local_sha
    } else {
        primary_sha
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{env, fs, path::Path, process::Command};
    use crate::git::git_result;
    use crate::stash::stash_list;
    use crate::test_support::{remove_scratch_repository, scratch_repository};

    #[test]
    fn assigns_a_lane_and_reuses_it_for_the_first_parent() {
        let mut lanes = Vec::new();
        let commit =
            parse_commit("a\0b\0Ada\02026-01-01T00:00:00+00:00\0\0first", &mut lanes, &mut None).unwrap();

        assert_eq!(commit[6], 0);
        assert_eq!(commit[7], serde_json::json!([0]));
        assert_eq!(lanes, vec![Some("b".to_string())]);
    }

    #[test]
    fn assigns_additional_parents_to_separate_lanes() {
        let mut lanes = Vec::new();
        let commit = parse_commit(
            "a\0b c\0Ada\02026-01-01T00:00:00+00:00\0\0merge",
            &mut lanes,
            &mut None,
        )
        .unwrap();

        assert_eq!(commit[6], 0);
        assert_eq!(commit[7], serde_json::json!([0, 1]));
        assert_eq!(commit[9], serde_json::json!([]));
        assert_eq!(commit[10], serde_json::json!([true, true]));
        assert_eq!(lanes, vec![Some("b".to_string()), Some("c".to_string())]);
    }

    #[test]
    fn frees_root_lanes() {
        let mut lanes = vec![Some("a".to_string())];
        let commit =
            parse_commit("a\0\0Ada\02026-01-01T00:00:00+00:00\0\0root", &mut lanes, &mut None).unwrap();

        assert_eq!(commit[8], 0);
        assert_eq!(commit[9], serde_json::json!([0]));
        assert_eq!(commit[10], serde_json::json!([]));
        assert!(lanes.is_empty());
    }

    #[test]
    fn frees_duplicate_lanes_after_a_commit_is_seen() {
        let mut lanes = vec![Some("a".to_string()), Some("a".to_string())];
        parse_commit("a\0b\0Ada\02026-01-01T00:00:00+00:00\0\0commit", &mut lanes, &mut None).unwrap();

        assert_eq!(lanes, vec![Some("b".to_string())]);
    }

    #[test]
    fn reserves_the_first_lane_for_the_default_branch_tip() {
        let mut lanes = Vec::new();
        let mut reserved_tip = Some("main".to_string());

        let feature = parse_commit(
            "feature\0feature-parent\0Ada\02026-01-01T00:00:00+00:00\0\0feature",
            &mut lanes,
            &mut reserved_tip,
        )
        .unwrap();

        assert_eq!(feature[6], 1);
        assert_eq!(feature[7], serde_json::json!([1]));
        assert_eq!(feature[8], 2);
        assert_eq!(feature[10], serde_json::json!([false, true]));

        let tip = parse_commit(
            "main\0main-parent\0Ada\02026-01-01T00:00:00+00:00\0\0tip",
            &mut lanes,
            &mut reserved_tip,
        )
        .unwrap();

        assert_eq!(tip[6], 0);
        assert_eq!(tip[7], serde_json::json!([0]));
        assert_eq!(tip[9], serde_json::json!([]));
        assert_eq!(reserved_tip, None);
        assert_eq!(
            lanes,
            vec![Some("main-parent".to_string()), Some("feature-parent".to_string())]
        );
    }

    #[test]
    fn moves_the_default_branch_tip_out_of_the_lane_waiting_for_it() {
        let mut lanes = Vec::new();
        let mut reserved_tip = Some("main".to_string());
        parse_commit(
            "feature\0main\0Ada\02026-01-01T00:00:00+00:00\0\0feature",
            &mut lanes,
            &mut reserved_tip,
        )
        .unwrap();

        let tip = parse_commit(
            "main\0main-parent\0Ada\02026-01-01T00:00:00+00:00\0\0tip",
            &mut lanes,
            &mut reserved_tip,
        )
        .unwrap();

        assert_eq!(tip[6], 0);
        assert_eq!(tip[9], serde_json::json!([1]));
        assert_eq!(lanes, vec![Some("main-parent".to_string())]);
    }

    #[test]
    fn keeps_the_first_lane_empty_while_the_default_branch_tip_is_missing() {
        let mut lanes = Vec::new();
        let mut reserved_tip = Some("main".to_string());

        let root = parse_commit(
            "feature\0\0Ada\02026-01-01T00:00:00+00:00\0\0root",
            &mut lanes,
            &mut reserved_tip,
        )
        .unwrap();

        assert_eq!(root[6], 1);
        assert_eq!(root[10], serde_json::json!([]));
        assert_eq!(reserved_tip.as_deref(), Some("main"));
        assert!(lanes.is_empty());
    }

    #[test]
    fn uses_the_first_lane_without_a_default_branch_tip() {
        let mut lanes = Vec::new();
        let mut reserved_tip = None;

        let commit = parse_commit(
            "feature\0feature-parent\0Ada\02026-01-01T00:00:00+00:00\0\0feature",
            &mut lanes,
            &mut reserved_tip,
        )
        .unwrap();

        assert_eq!(commit[6], 0);
        assert_eq!(commit[8], 1);
        assert_eq!(lanes, vec![Some("feature-parent".to_string())]);
    }

    #[test]
    fn changes_the_fingerprint_only_when_a_ref_moves() {
        let path = env::temp_dir()
            .join(format!("git-nav-fingerprint-{}", std::process::id()))
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
        write("tracked.txt", "base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);

        let initial = repository_fingerprint(path.clone());
        let repeated = repository_fingerprint(path.clone());
        write("tracked.txt", "changed\n");
        let edited = repository_fingerprint(path.clone());
        run(&["commit", "--quiet", "--all", "--message", "change"]);
        let committed = repository_fingerprint(path.clone());
        run(&["branch", "feature"]);
        let branched = repository_fingerprint(path.clone());
        run(&["checkout", "--quiet", "feature"]);
        let checked_out = repository_fingerprint(path.clone());
        fs::remove_dir_all(&path).unwrap();

        assert_eq!(initial, repeated);
        assert_eq!(initial, edited);
        assert_ne!(initial, committed);
        assert_ne!(committed, branched);
        // The branch points at the commit HEAD already sat on, so only the symbolic ref moved.
        assert_ne!(branched, checked_out);
    }

    #[test]
    fn streams_a_bounded_commit_graph_window() {
        let (path, run) = scratch_repository("graph-window");
        run(&["commit", "--quiet", "--allow-empty", "--message", "first"]);
        run(&["commit", "--quiet", "--allow-empty", "--message", "second"]);
        run(&["commit", "--quiet", "--allow-empty", "--message", "third"]);

        let mut batches = Vec::new();
        let has_more = walk_commit_graph_page(&path, 1, 1, |batch| {
            batches.push(batch);
            Ok(())
        })
        .unwrap();
        let subjects = batches
            .into_iter()
            .flatten()
            .map(|commit| commit[5].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        remove_scratch_repository(&path);

        assert_eq!(subjects, ["second"]);
        assert!(has_more);
    }

    #[test]
    fn walks_history_without_stash_or_notes_commits() {
        let (path, run) = scratch_repository("graph-revisions");
        run(&["commit", "--quiet", "--allow-empty", "--message", "first"]);
        fs::write(format!("{path}/work.txt"), "one").unwrap();
        run(&["add", "work.txt"]);
        run(&["stash", "push", "--quiet", "--message", "set aside"]);
        run(&["notes", "add", "--message", "a note"]);

        let mut batches = Vec::new();
        walk_commit_graph(&path, |batch| {
            batches.push(batch);
            Ok(())
        })
        .unwrap();
        let subjects = batches
            .into_iter()
            .flatten()
            .map(|commit| commit[5].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        fs::remove_dir_all(&path).unwrap();

        assert_eq!(subjects, ["first"]);
    }

    #[test]
    fn keeps_the_commits_of_a_detached_worktree() {
        let (path, run) = scratch_repository("detached-worktree");
        run(&["commit", "--quiet", "--allow-empty", "--message", "base"]);
        let detached = format!("{path}-detached");
        run(&["worktree", "add", "--quiet", "--detach", &detached, "HEAD"]);
        let commit = Command::new("git")
            .args(["-C", &detached, "-c", "user.email=tests@example.com", "-c", "user.name=Tests"])
            .args(["commit", "--quiet", "--allow-empty", "--message", "work in a detached worktree"])
            .status()
            .unwrap();
        assert!(commit.success());

        let mut batches = Vec::new();
        walk_commit_graph(&path, |batch| {
            batches.push(batch);
            Ok(())
        })
        .unwrap();
        let subjects = batches
            .into_iter()
            .flatten()
            .map(|commit| commit[5].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        let _ = fs::remove_dir_all(&detached);
        fs::remove_dir_all(&path).unwrap();

        assert_eq!(subjects, ["work in a detached worktree", "base"]);
    }

    #[test]
    fn keeps_the_commit_a_stash_was_made_from_even_when_no_branch_reaches_it() {
        let (path, run) = scratch_repository("stash-base");
        run(&["commit", "--quiet", "--allow-empty", "--message", "base"]);
        run(&["commit", "--quiet", "--allow-empty", "--message", "stashed from here"]);
        fs::write(format!("{path}/work.txt"), "one").unwrap();
        run(&["add", "work.txt"]);
        run(&["stash", "push", "--quiet", "--message", "set aside"]);
        // The branch moves off the commit the stash was taken from, so only the stash still reaches it.
        run(&["reset", "--quiet", "--hard", "HEAD~1"]);

        let entries = stash_list(path.clone()).unwrap();
        let mut batches = Vec::new();
        walk_commit_graph(&path, |batch| {
            batches.push(batch);
            Ok(())
        })
        .unwrap();
        let subjects = batches
            .into_iter()
            .flatten()
            .map(|commit| commit[5].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        fs::remove_dir_all(&path).unwrap();

        assert_eq!(entries.len(), 1);
        assert!(entries[0].base.is_some());
        assert_eq!(subjects, ["stashed from here", "base"]);
    }

    #[test]
    fn reserves_lane_zero_for_the_local_branch_that_is_ahead_of_its_remote() {
        let (path, run) = scratch_repository("lane-tip");
        run(&["commit", "--quiet", "--allow-empty", "--message", "base"]);
        run(&["update-ref", "refs/remotes/origin/main", "refs/heads/main"]);
        run(&["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
        let base = resolve_commit(&path, "refs/heads/main").unwrap();
        let synced = reserved_lane_tip(&path);

        run(&["commit", "--quiet", "--allow-empty", "--message", "ahead"]);
        let local = resolve_commit(&path, "refs/heads/main").unwrap();
        let ahead = reserved_lane_tip(&path);

        run(&["checkout", "--quiet", "-b", "other", &base]);
        run(&["commit", "--quiet", "--allow-empty", "--message", "remote side"]);
        run(&["update-ref", "refs/remotes/origin/main", "refs/heads/other"]);
        run(&["checkout", "--quiet", "main"]);
        let remote = resolve_commit(&path, "refs/heads/other").unwrap();
        let diverged = reserved_lane_tip(&path);
        fs::remove_dir_all(&path).unwrap();

        assert_eq!(synced.as_deref(), Some(base.as_str()));
        assert_eq!(ahead.as_deref(), Some(local.as_str()));
        // Divergence is not one line of history, so the remote keeps the lane and the local branch takes its own.
        assert_eq!(diverged.as_deref(), Some(remote.as_str()));
    }
}
