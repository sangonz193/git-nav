use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, collections::HashSet, path::PathBuf, sync::Mutex, sync::OnceLock};
use crate::projects::parse_worktree_records;
use crate::git::{
    git_output, git_output_allow_empty, git_result, git_succeeds, patch_id, primary_reference,
    resolve_commit,
};
use crate::pull_requests::{
    github_repository, pull_request_database, pull_request_database_path,
    should_sync_pull_requests, sync_pull_requests,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BranchCleanup {
    candidates: Vec<String>,
    deleted: Vec<String>,
    failed: Vec<String>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CleanupReason {
    SquashMergedPullRequest,
    MergedIntoDefaultBranch,
    SquashedIntoDefaultBranch,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupCandidate {
    pub(crate) branch: String,
    reasons: Vec<CleanupReason>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupOptions {
    pub(crate) delete_merged_pull_request_branches: bool,
    pub(crate) delete_merged_branches: bool,
    pub(crate) delete_squash_merged_branches: bool,
}

pub(crate) struct SquashCandidate {
    hash: String,
    tree: String,
    paths: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SquashTipMemo {
    base: String,
    tree: String,
    paths: Vec<String>,
    patch_id: Option<String>,
    result: Option<String>,
    primary: String,
}

#[derive(Clone)]
pub(crate) struct SquashTip {
    hash: String,
    tree: String,
}

static LOCAL_SQUASH_MERGE_MEMO: OnceLock<Mutex<HashMap<String, HashMap<String, SquashTipMemo>>>> = OnceLock::new();
const MAX_MEMOIZED_SQUASH_TIPS: usize = 4096;

#[cfg(test)]
static SQUASH_CANDIDATE_WALKS: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();

#[cfg(test)]
static SQUASH_REACHABILITY_WALKS: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();

fn local_squash_merge_memo() -> &'static Mutex<HashMap<String, HashMap<String, SquashTipMemo>>> {
    LOCAL_SQUASH_MERGE_MEMO.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(test)]
fn record_squash_candidate_walk(repo_path: &str) {
    *SQUASH_CANDIDATE_WALKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap()
        .entry(repo_path.to_string())
        .or_default() += 1;
}

#[cfg(not(test))]
fn record_squash_candidate_walk(_repo_path: &str) {}

#[cfg(test)]
fn record_squash_reachability_walk(repo_path: &str) {
    *SQUASH_REACHABILITY_WALKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap()
        .entry(repo_path.to_string())
        .or_default() += 1;
}

#[cfg(not(test))]
fn record_squash_reachability_walk(_repo_path: &str) {}

fn store_local_squash_merge_memos(repo_path: &str, mut next: HashMap<String, SquashTipMemo>) {
    if next.len() > MAX_MEMOIZED_SQUASH_TIPS {
        next = next.into_iter().take(MAX_MEMOIZED_SQUASH_TIPS).collect();
    }
    let mut memos = local_squash_merge_memo().lock().unwrap();
    if next.is_empty() {
        memos.remove(repo_path);
    } else {
        memos.insert(repo_path.to_string(), next);
    }
    while memos.values().map(HashMap::len).sum::<usize>() > MAX_MEMOIZED_SQUASH_TIPS {
        let Some(stale_repo) = memos.keys().find(|path| path.as_str() != repo_path).cloned() else {
            break;
        };
        memos.remove(&stale_repo);
    }
}

fn squash_candidates_for_base<'a>(candidates: &'a [SquashCandidate], hashes: &HashSet<&str>) -> Vec<&'a SquashCandidate> {
    candidates
        .iter()
        .filter(|candidate| hashes.contains(candidate.hash.as_str()))
        .collect()
}

// One record per commit, carrying the tree and the paths it touched, so neither the tree comparison
// nor the path filter has to spawn a process per candidate.
fn squash_candidates(repo_path: &str, range: &str) -> Result<Vec<SquashCandidate>, String> {
    record_squash_candidate_walk(repo_path);
    let output = git_output_allow_empty(repo_path, &["log", "--no-merges", "--format=%x00%H %T", "--name-only", range])?;
    Ok(output
        .split('\0')
        .filter_map(|record| {
            let mut lines = record.lines().filter(|line| !line.is_empty());
            let (hash, tree) = lines.next()?.split_once(' ')?;
            let mut paths: Vec<_> = lines.map(str::to_string).collect();
            paths.sort();
            Some(SquashCandidate { hash: hash.to_string(), tree: tree.to_string(), paths })
        })
        .collect())
}

fn git_is_ancestor(repo_path: &str, ancestor: &str, descendant: &str) -> Result<bool, String> {
    let output = git_result(repo_path, &["merge-base", "--is-ancestor", ancestor, descendant])?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(String::from_utf8_lossy(&output.stderr).trim().to_string()),
    }
}

fn cached_squash_targets_reachable(
    repo_path: &str,
    primary_hash: &str,
    targets: impl Iterator<Item = String>,
) -> HashSet<String> {
    record_squash_reachability_walk(repo_path);
    targets
        .collect::<HashSet<_>>()
        .into_iter()
        .filter(|target| git_is_ancestor(repo_path, target, primary_hash).unwrap_or(false))
        .collect()
}

const OCTOPUS_MERGE_BASE_BATCH_SIZE: usize = 128;

fn octopus_merge_base_once(repo_path: &str, revisions: &[&str]) -> Result<Option<String>, String> {
    let output = git_result(repo_path, &[&["merge-base", "--octopus"], revisions].concat())?;
    match output.status.code() {
        Some(0) => Ok(Some(String::from_utf8(output.stdout).map_err(|error| error.to_string())?.trim().to_string())),
        Some(1) => Ok(None),
        _ => Err(String::from_utf8_lossy(&output.stderr).trim().to_string()),
    }
}

fn octopus_merge_base(repo_path: &str, revisions: &[&str]) -> Result<Option<String>, String> {
    if revisions.len() <= OCTOPUS_MERGE_BASE_BATCH_SIZE {
        return octopus_merge_base_once(repo_path, revisions);
    }
    // Windows limits process command lines to 32 KiB.
    let mut bases = Vec::new();
    for batch in revisions.chunks(OCTOPUS_MERGE_BASE_BATCH_SIZE) {
        let Some(base) = octopus_merge_base_once(repo_path, batch)? else {
            return Ok(None);
        };
        bases.push(base);
    }
    let revisions: Vec<_> = bases.iter().map(String::as_str).collect();
    octopus_merge_base(repo_path, &revisions)
}

fn candidate_patch_id(repo_path: &str, hash: &str, patches: &mut HashMap<String, Option<String>>) -> Result<String, ()> {
    patches
        .entry(hash.to_string())
        .or_insert_with(|| patch_id(repo_path, &["show", hash]))
        .clone()
        .ok_or(())
}

fn squash_merge_target_from_memo(
    repo_path: &str,
    memo: &SquashTipMemo,
    candidates: &[&SquashCandidate],
    candidate_patches: &mut HashMap<String, Option<String>>,
) -> Result<Option<String>, ()> {
    if let Some(candidate) = candidates.iter().find(|candidate| candidate.tree == memo.tree) {
        return Ok(Some(candidate.hash.clone()));
    }
    if memo.paths.is_empty() {
        return Ok(None);
    }
    let branch_patch = memo.patch_id.as_deref().unwrap();
    for candidate in candidates.iter().filter(|candidate| candidate.paths == memo.paths) {
        if candidate_patch_id(repo_path, &candidate.hash, candidate_patches)? == branch_patch {
            return Ok(Some(candidate.hash.clone()));
        }
    }
    Ok(None)
}

fn compute_squash_tip_memo(
    repo_path: &str,
    tip: &SquashTip,
    base: &str,
    primary: &str,
    candidates: &[&SquashCandidate],
    candidate_patches: &mut HashMap<String, Option<String>>,
) -> Result<SquashTipMemo, ()> {
    let mut memo = SquashTipMemo {
        base: base.to_string(),
        tree: tip.tree.clone(),
        paths: Vec::new(),
        patch_id: None,
        result: None,
        primary: primary.to_string(),
    };
    if let Some(candidate) = candidates.iter().find(|candidate| candidate.tree == memo.tree) {
        memo.result = Some(candidate.hash.clone());
        return Ok(memo);
    }
    memo.paths = git_output_allow_empty(repo_path, &["diff", "--name-only", base, &tip.hash])
        .map_err(|_| ())?
        .lines()
        .map(str::to_string)
        .collect();
    memo.paths.sort();
    if memo.paths.is_empty() {
        return Ok(memo);
    }
    memo.patch_id = patch_id(repo_path, &["diff", base, &tip.hash]);
    if memo.patch_id.is_none() {
        return Err(());
    }
    memo.result = squash_merge_target_from_memo(repo_path, &memo, candidates, candidate_patches)?;
    Ok(memo)
}

// A squash that has not been pushed yet lives only on the local counterpart of the primary branch, so the
// search reaches through to it whenever that counterpart merely extends the remote.
fn squash_search_reference(repo_path: &str) -> Result<String, String> {
    let primary = primary_reference(repo_path)?;
    let name = primary.split_once('/').map_or(primary.as_str(), |(_, name)| name);
    let local = format!("refs/heads/{name}");
    if resolve_commit(repo_path, &local).is_ok() && git_succeeds(repo_path, &["merge-base", "--is-ancestor", &primary, &local]) {
        return Ok(local);
    }
    Ok(primary)
}

fn cold_squash_tip_memos(
    repo_path: &str,
    primary_hash: &str,
    tips: &[SquashTip],
    candidate_patches: &mut HashMap<String, Option<String>>,
) -> HashMap<String, SquashTipMemo> {
    let branch_bases: Vec<_> = tips
        .iter()
        .filter_map(|tip| git_output(repo_path, &["merge-base", &tip.hash, primary_hash]).map(|base| (tip, base)))
        .collect();
    let bases: Vec<_> = branch_bases
        .iter()
        .map(|(_, base)| base.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if bases.is_empty() {
        return HashMap::new();
    }
    let mut revisions = vec![primary_hash];
    revisions.extend(bases.iter().map(String::as_str));
    let Ok(oldest_base) = octopus_merge_base(repo_path, &revisions) else {
        return HashMap::new();
    };
    if oldest_base.is_none() {
        let mut memos = HashMap::new();
        for base in bases {
            let Ok(candidates) = squash_candidates(repo_path, &format!("{base}..{primary_hash}")) else {
                continue;
            };
            let candidates: Vec<_> = candidates.iter().collect();
            for (tip, tip_base) in branch_bases.iter().filter(|(_, tip_base)| tip_base == &base) {
                if let Ok(memo) = compute_squash_tip_memo(repo_path, tip, tip_base, primary_hash, &candidates, candidate_patches) {
                    memos.insert(tip.hash.clone(), memo);
                }
            }
        }
        return memos;
    }
    let Ok(candidates) = squash_candidates(repo_path, &format!("{}..{primary_hash}", oldest_base.unwrap())) else {
        return HashMap::new();
    };
    let mut memos = HashMap::new();
    for base in bases {
        let Ok(hashes) = git_output_allow_empty(repo_path, &["rev-list", "--no-merges", &format!("{base}..{primary_hash}")]) else {
            continue;
        };
        let hashes = hashes.lines().collect();
        let candidates = squash_candidates_for_base(&candidates, &hashes);
        for (tip, tip_base) in branch_bases.iter().filter(|(_, tip_base)| tip_base == &base) {
            if let Ok(memo) = compute_squash_tip_memo(repo_path, tip, tip_base, primary_hash, &candidates, candidate_patches) {
                memos.insert(tip.hash.clone(), memo);
            }
        }
    }
    memos
}

fn local_squash_merges(repo_path: &str) -> Vec<(String, String)> {
    let Ok(primary) = squash_search_reference(repo_path) else {
        return Vec::new();
    };
    let Ok(primary_hash) = resolve_commit(repo_path, &primary) else {
        return Vec::new();
    };
    let Ok(branches) = git_output_allow_empty(
        repo_path,
        &["for-each-ref", "--no-merged", &primary_hash, "--format=%(objectname) %(tree)", "refs/heads"],
    ) else {
        return Vec::new();
    };
    let mut seen_tips = HashSet::new();
    let tips: Vec<_> = branches
        .lines()
        .filter_map(|line| line.split_once(' '))
        .filter(|(hash, _)| seen_tips.insert(*hash))
        .map(|(hash, tree)| SquashTip { hash: hash.to_string(), tree: tree.to_string() })
        .collect();
    let previous = local_squash_merge_memo()
        .lock()
        .unwrap()
        .get(repo_path)
        .cloned()
        .unwrap_or_default();
    let mut next = HashMap::new();
    let mut edges = Vec::new();
    let mut advanced: HashMap<String, Vec<(SquashTip, SquashTipMemo)>> = HashMap::new();
    let mut cold = Vec::new();
    for tip in &tips {
        match previous.get(&tip.hash).cloned() {
            Some(memo) if memo.result.is_some() && memo.primary == primary_hash => {
                edges.push((tip.hash.clone(), memo.result.clone().unwrap()));
                next.insert(tip.hash.clone(), memo);
            }
            Some(memo) if memo.primary == primary_hash => {
                next.insert(tip.hash.clone(), memo);
            }
            Some(memo) => advanced.entry(memo.primary.clone()).or_default().push((tip.clone(), memo)),
            None => cold.push(tip.clone()),
        }
    }
    let mut candidate_patches = HashMap::new();
    for (old_primary, entries) in advanced {
        match git_is_ancestor(repo_path, &old_primary, &primary_hash) {
            Ok(true) => {
                let mut pending = Vec::new();
                for (tip, memo) in entries {
                    let Some(base) = git_output(repo_path, &["merge-base", &tip.hash, &primary_hash]) else {
                        cold.push(tip);
                        continue;
                    };
                    if base != memo.base {
                        cold.push(tip);
                    } else if let Some(target) = memo.result.clone() {
                        let mut memo = memo;
                        memo.primary = primary_hash.clone();
                        edges.push((tip.hash.clone(), target));
                        next.insert(tip.hash, memo);
                    } else {
                        pending.push((tip, memo));
                    }
                }
                if pending.is_empty() {
                    continue;
                }
                match squash_candidates(repo_path, &format!("{old_primary}..{primary_hash}")) {
                Ok(candidates) => {
                    let candidates: Vec<_> = candidates.iter().collect();
                    for (tip, mut memo) in pending {
                        match squash_merge_target_from_memo(repo_path, &memo, &candidates, &mut candidate_patches) {
                            Ok(result) => {
                                memo.result = result;
                                memo.primary = primary_hash.clone();
                                if let Some(target) = &memo.result {
                                    edges.push((tip.hash.clone(), target.clone()));
                                }
                                next.insert(tip.hash, memo);
                            }
                            Err(()) => {
                                next.insert(tip.hash, memo);
                            }
                        }
                    }
                }
                Err(_) => cold.extend(pending.into_iter().map(|(tip, _)| tip)),
                }
            }
            Ok(false) => {
                if entries.iter().all(|(_, memo)| memo.result.is_none()) {
                    cold.extend(entries.into_iter().map(|(tip, _)| tip));
                    continue;
                }
                let targets = cached_squash_targets_reachable(
                    repo_path,
                    &primary_hash,
                    entries.iter().filter_map(|(_, memo)| memo.result.clone()),
                );
                for (tip, memo) in entries {
                    if memo.result.as_ref().is_some_and(|target| targets.contains(target)) {
                        let target = memo.result.clone().unwrap();
                        let mut memo = memo;
                        memo.primary = primary_hash.clone();
                        edges.push((tip.hash.clone(), target));
                        next.insert(tip.hash, memo);
                    } else {
                        cold.push(tip);
                    }
                }
            }
            Err(_) => cold.extend(entries.into_iter().map(|(tip, _)| tip)),
        }
    }
    let fills = cold_squash_tip_memos(repo_path, &primary_hash, &cold, &mut candidate_patches);
    for (tip, memo) in fills {
        if let Some(target) = &memo.result {
            edges.push((tip.clone(), target.clone()));
        }
        next.insert(tip, memo);
    }
    store_local_squash_merge_memos(repo_path, next);
    edges
}

fn inferred_squash_merges(repo_path: &str, database_path: PathBuf) -> Vec<(String, String)> {
    let mut edges: HashSet<_> = local_squash_merges(repo_path).into_iter().collect();
    // Pull requests still cover squashes whose conflict resolution changed the content on the way in.
    let Some(remote) = git_output(repo_path, &["remote", "get-url", "origin"]) else {
        return edges.into_iter().collect();
    };
    let Some((host, repository)) = github_repository(&remote) else {
        return edges.into_iter().collect();
    };
    let Ok(primary) = squash_search_reference(repo_path) else {
        return edges.into_iter().collect();
    };
    let Some(refs) = git_output(repo_path, &["for-each-ref", "--format=%(objectname)", "refs/heads", "refs/remotes"]) else {
        return edges.into_iter().collect();
    };
    let Ok(mut connection) = pull_request_database(database_path) else {
        return edges.into_iter().collect();
    };
    if should_sync_pull_requests(&connection, &host, &repository).unwrap_or(false) {
        let _ = sync_pull_requests(&mut connection, &host, &repository);
    }
    let ref_hashes: HashSet<_> = refs.lines().collect();
    let mut statement = match connection.prepare(
        "
        SELECT head_sha, merge_commit_sha
        FROM pull_requests
        WHERE host = ?1 AND repository = ?2 AND merged_at IS NOT NULL AND merge_commit_sha IS NOT NULL
        ",
    ) {
        Ok(statement) => statement,
        Err(_) => return edges.into_iter().collect(),
    };
    let pull_requests = match statement.query_map(params![host, repository], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))) {
        Ok(pull_requests) => pull_requests,
        Err(_) => return edges.into_iter().collect(),
    };
    for pull_request in pull_requests.flatten() {
        let (source, target) = pull_request;
        if ref_hashes.contains(source.as_str())
            && !git_succeeds(repo_path, &["merge-base", "--is-ancestor", &source, &primary])
            && git_succeeds(repo_path, &["merge-base", "--is-ancestor", &target, &primary])
        {
            edges.insert((source, target));
        }
    }
    edges.into_iter().collect()
}

// git refuses to delete a branch that a worktree has checked out, so offering one would only end in a
// failure toast.
fn checked_out_branches(repo_path: &str) -> Result<HashSet<String>, String> {
    let worktrees = git_output_allow_empty(repo_path, &["worktree", "list", "--porcelain", "-z"])?;
    Ok(parse_worktree_records(&worktrees)
        .into_iter()
        .filter(|worktree| !worktree.is_detached)
        .map(|worktree| worktree.branch)
        .collect())
}

fn merged_branch_candidates(repo_path: &str, database_path: PathBuf) -> Result<Vec<String>, String> {
    let remote = git_output(repo_path, &["remote", "get-url", "origin"]).ok_or_else(|| "Could not identify the origin remote.".to_string())?;
    let (host, repository) = github_repository(&remote).ok_or_else(|| "Only GitHub remotes are supported.".to_string())?;
    let refs = git_output_allow_empty(repo_path, &["for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads"])?;
    let mut connection = pull_request_database(database_path)?;
    if should_sync_pull_requests(&connection, &host, &repository)? {
        sync_pull_requests(&mut connection, &host, &repository)?;
    }
    let mut statement = connection
        .prepare(
            "
            SELECT head_sha
            FROM pull_requests
            WHERE host = ?1 AND repository = ?2 AND merged_at IS NOT NULL
            ",
        )
        .map_err(|error| error.to_string())?;
    let merged_heads = statement
        .query_map(params![host, repository], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .flatten()
        .collect::<HashSet<_>>();
    let primary = primary_reference(repo_path).ok().and_then(|reference| reference.strip_prefix("origin/").map(str::to_string).or(Some(reference)));
    let protected = ["main", "master"]
        .into_iter()
        .chain(primary.as_deref())
        .collect::<HashSet<_>>();
    let checked_out = checked_out_branches(repo_path)?;

    Ok(refs
        .split('\n')
        .filter_map(|line| line.split_once('\0'))
        .filter(|(branch, hash)| !protected.contains(branch) && !checked_out.contains(*branch) && merged_heads.contains(*hash))
        .map(|(branch, _)| branch.to_string())
        .collect())
}

fn merged_local_branch_candidates(repo_path: &str) -> Result<Vec<String>, String> {
    let primary = primary_reference(repo_path)?;
    let primary_branch = primary.strip_prefix("origin/").unwrap_or(&primary);
    let protected = ["main", "master", primary_branch]
        .into_iter()
        .collect::<HashSet<_>>();
    // Reachability is asked of git once for every branch at a time, since this runs on every repository
    // change rather than only when the cleanup dialog is opened.
    let refs = git_output_allow_empty(
        repo_path,
        &[
            "for-each-ref",
            "--merged",
            &primary,
            "--format=%(refname:short)",
            "refs/heads",
        ],
    )?;
    let checked_out = checked_out_branches(repo_path)?;

    Ok(refs
        .lines()
        .filter(|branch| !protected.contains(branch) && !checked_out.contains(*branch))
        .map(str::to_string)
        .collect())
}

// A squash merge leaves no ancestry and needs no pull request, so the branch it replaced is only
// recognisable by the content that landed. That is an inference rather than a record, which is why it is
// offered separately from the rules git and GitHub can prove.
fn squash_merged_branch_candidates(repo_path: &str) -> Result<Vec<String>, String> {
    let primary = squash_search_reference(repo_path)?;
    let primary_branch = primary
        .strip_prefix("refs/heads/")
        .or_else(|| primary.strip_prefix("origin/"))
        .unwrap_or(&primary);
    let protected = ["main", "master", primary_branch].into_iter().collect::<HashSet<_>>();
    let squashed = local_squash_merges(repo_path).into_iter().map(|(tip, _)| tip).collect::<HashSet<_>>();
    let refs = git_output_allow_empty(repo_path, &["for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads"])?;
    let checked_out = checked_out_branches(repo_path)?;

    Ok(refs
        .split('\n')
        .filter_map(|line| line.split_once('\0'))
        .filter(|(branch, hash)| !protected.contains(branch) && !checked_out.contains(*branch) && squashed.contains(*hash))
        .map(|(branch, _)| branch.to_string())
        .collect())
}

pub(crate) fn cleanup_candidates(
    repo_path: &str,
    options: &CleanupOptions,
    database_path: Option<PathBuf>,
) -> Result<Vec<CleanupCandidate>, String> {
    let mut candidates = HashMap::new();
    if let Some(database_path) = database_path {
        for branch in merged_branch_candidates(repo_path, database_path)? {
            candidates
                .entry(branch)
                .or_insert_with(Vec::new)
                .push(CleanupReason::SquashMergedPullRequest);
        }
    }
    if options.delete_merged_branches {
        for branch in merged_local_branch_candidates(repo_path)? {
            candidates
                .entry(branch)
                .or_insert_with(Vec::new)
                .push(CleanupReason::MergedIntoDefaultBranch);
        }
    }
    if options.delete_squash_merged_branches {
        for branch in squash_merged_branch_candidates(repo_path)? {
            candidates
                .entry(branch)
                .or_insert_with(Vec::new)
                .push(CleanupReason::SquashedIntoDefaultBranch);
        }
    }
    let mut candidates = candidates
        .into_iter()
        .map(|(branch, reasons)| CleanupCandidate { branch, reasons })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| left.branch.cmp(&right.branch));
    Ok(candidates)
}

pub(crate) fn cleanup_database_path(options: &CleanupOptions) -> Result<Option<PathBuf>, String> {
    options
        .delete_merged_pull_request_branches
        .then(pull_request_database_path)
        .transpose()
}

fn delete_cleanup_candidates(
    repo_path: &str,
    options: &CleanupOptions,
    database_path: Option<PathBuf>,
) -> Result<BranchCleanup, String> {
    let candidates = cleanup_candidates(repo_path, options, database_path)?
        .into_iter()
        .map(|candidate| candidate.branch)
        .collect::<Vec<_>>();
    let mut deleted = Vec::new();
    let mut failed = Vec::new();
    for branch in &candidates {
        if git_succeeds(repo_path, &["branch", "-D", "--", branch]) {
            deleted.push(branch.clone());
        } else {
            failed.push(branch.clone());
        }
    }
    Ok(BranchCleanup {
        candidates,
        deleted,
        failed,
    })
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn inferred_squash_merge_edges(repo_path: String) -> Vec<(String, String)> {
    let Ok(database_path) = pull_request_database_path() else {
        return Vec::new();
    };
    tauri::async_runtime::spawn_blocking(move || inferred_squash_merges(&repo_path, database_path))
        .await
        .unwrap_or_default()
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn squashed_branch_candidates(repo_path: String) -> Result<Vec<String>, String> {
    let database_path = pull_request_database_path()?;
    tauri::async_runtime::spawn_blocking(move || merged_branch_candidates(&repo_path, database_path))
        .await
        .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn preview_cleanup_candidates(
    repo_path: String,
    options: CleanupOptions,
) -> Result<Vec<CleanupCandidate>, String> {
    let database_path = cleanup_database_path(&options)?;
    tauri::async_runtime::spawn_blocking(move || {
        cleanup_candidates(&repo_path, &options, database_path)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn delete_squashed_branches(
    repo_path: String,
    options: CleanupOptions,
) -> Result<BranchCleanup, String> {
    let database_path = cleanup_database_path(&options)?;
    tauri::async_runtime::spawn_blocking(move || {
        delete_cleanup_candidates(&repo_path, &options, database_path)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{env, fs, path::Path};
    use crate::test_support::{remove_scratch_repository, scratch_repository};

    #[test]
    fn slices_shared_squash_candidates_to_each_branch_base() {
        let candidates = vec![
            SquashCandidate { hash: "newest".to_string(), tree: "tree-newest".to_string(), paths: Vec::new() },
            SquashCandidate { hash: "middle".to_string(), tree: "tree-middle".to_string(), paths: Vec::new() },
            SquashCandidate { hash: "oldest".to_string(), tree: "tree-oldest".to_string(), paths: Vec::new() },
        ];
        let hashes: HashSet<_> = ["newest", "oldest"].into_iter().collect();

        let sliced = squash_candidates_for_base(&candidates, &hashes);

        assert_eq!(sliced.iter().map(|candidate| candidate.hash.as_str()).collect::<Vec<_>>(), ["newest", "oldest"]);
    }

    #[test]
    fn batches_octopus_merge_bases() {
        let (path, run) = scratch_repository("squash-octopus-batches");
        fs::write(Path::new(&path).join("base.txt"), "base\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        let mut revisions = vec![git_output(&path, &["rev-parse", "HEAD"]).unwrap()];
        for index in 1..=OCTOPUS_MERGE_BASE_BATCH_SIZE {
            fs::write(Path::new(&path).join("base.txt"), format!("{index}\n")).unwrap();
            run(&["commit", "--quiet", "--all", "--message", "advance"]);
            revisions.push(git_output(&path, &["rev-parse", "HEAD"]).unwrap());
        }
        let revisions: Vec<_> = revisions.iter().map(String::as_str).collect();

        let base = octopus_merge_base(&path, &revisions).unwrap();
        remove_scratch_repository(&path);

        assert_eq!(base.as_deref(), revisions.first().copied());
    }

    #[test]
    fn excludes_squash_candidates_that_predate_a_branch_base() {
        let (path, run) = scratch_repository("squash-candidate-base");
        let write = |name: &str, contents: &str| fs::write(Path::new(&path).join(name), contents).unwrap();
        write("base.txt", "base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["branch", "older"]);
        run(&["checkout", "--quiet", "older"]);
        write("older.txt", "older\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "older branch work"]);
        run(&["checkout", "--quiet", "main"]);
        write("old.txt", "old\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "old squash"]);
        let old_target = git_output(&path, &["rev-parse", "HEAD"]).unwrap();
        write("later.txt", "later\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "later primary work"]);
        run(&["checkout", "--quiet", "-b", "feature"]);
        fs::remove_file(Path::new(&path).join("later.txt")).unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "revert later primary work"]);
        let feature = git_output(&path, &["rev-parse", "HEAD"]).unwrap();
        run(&["checkout", "--quiet", "main"]);

        let edges: HashMap<_, _> = local_squash_merges(&path).into_iter().collect();
        remove_scratch_repository(&path);

        assert_ne!(feature, old_target);
        assert!(!edges.contains_key(&feature));
    }

    fn clear_squash_memo(repo_path: &str) {
        local_squash_merge_memo().lock().unwrap().remove(repo_path);
        SQUASH_CANDIDATE_WALKS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap()
            .remove(repo_path);
        SQUASH_REACHABILITY_WALKS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap()
            .remove(repo_path);
    }

    fn squash_memo(repo_path: &str, tip: &str) -> Option<SquashTipMemo> {
        local_squash_merge_memo()
            .lock()
            .unwrap()
            .get(repo_path)
            .and_then(|memos| memos.get(tip))
            .cloned()
    }

    #[test]
    fn unchanged_squash_tips_do_not_repeat_the_candidate_walk() {
        let (path, run) = scratch_repository("squash-memo-unchanged");
        fs::write(Path::new(&path).join("base.txt"), "base\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["checkout", "--quiet", "-b", "feature"]);
        fs::write(Path::new(&path).join("feature.txt"), "feature\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "feature"]);
        let tip = git_output(&path, &["rev-parse", "HEAD"]).unwrap();
        run(&["checkout", "--quiet", "main"]);

        local_squash_merges(&path);
        let memo = squash_memo(&path, &tip).unwrap();
        let walks = SQUASH_CANDIDATE_WALKS.get().unwrap().lock().unwrap()[&path];
        local_squash_merges(&path);
        let repeated = squash_memo(&path, &tip).unwrap();
        let repeated_walks = SQUASH_CANDIDATE_WALKS.get().unwrap().lock().unwrap()[&path];
        clear_squash_memo(&path);
        remove_scratch_repository(&path);

        assert_eq!(memo, repeated);
        assert_eq!(walks, repeated_walks);
    }

    #[test]
    fn primary_advance_finds_a_squash_for_a_memoized_tip() {
        let (path, run) = scratch_repository("squash-memo-primary-advance");
        fs::write(Path::new(&path).join("base.txt"), "base\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["checkout", "--quiet", "-b", "feature"]);
        fs::write(Path::new(&path).join("feature.txt"), "feature\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "feature"]);
        let tip = git_output(&path, &["rev-parse", "HEAD"]).unwrap();
        run(&["checkout", "--quiet", "main"]);
        assert!(local_squash_merges(&path).is_empty());
        run(&["merge", "--quiet", "--squash", "feature"]);
        run(&["commit", "--quiet", "--message", "squash feature"]);
        let target = git_output(&path, &["rev-parse", "HEAD"]).unwrap();

        let edges: HashMap<_, _> = local_squash_merges(&path).into_iter().collect();
        let walks = SQUASH_CANDIDATE_WALKS.get().unwrap().lock().unwrap()[&path];
        let repeated: HashMap<_, _> = local_squash_merges(&path).into_iter().collect();
        let repeated_walks = SQUASH_CANDIDATE_WALKS.get().unwrap().lock().unwrap()[&path];
        let reachability_walks = SQUASH_REACHABILITY_WALKS
            .get()
            .and_then(|walks| walks.lock().unwrap().get(&path).copied())
            .unwrap_or_default();
        clear_squash_memo(&path);
        remove_scratch_repository(&path);

        assert_eq!(edges.get(&tip), Some(&target));
        assert_eq!(repeated.get(&tip), Some(&target));
        assert_eq!(walks, repeated_walks);
        assert_eq!(reachability_walks, 0);
    }

    #[test]
    fn primary_advance_recomputes_a_stacked_tip_from_its_new_merge_base() {
        let (path, run) = scratch_repository("squash-memo-stacked-primary-advance");
        fs::write(Path::new(&path).join("base.txt"), "base\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["checkout", "--quiet", "-b", "feature-a"]);
        fs::write(Path::new(&path).join("a.txt"), "a\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "feature a"]);
        run(&["checkout", "--quiet", "-b", "feature-b"]);
        fs::write(Path::new(&path).join("b.txt"), "b\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "feature b"]);
        let tip = git_output(&path, &["rev-parse", "HEAD"]).unwrap();
        run(&["checkout", "--quiet", "main"]);
        assert!(local_squash_merges(&path).is_empty());
        run(&["merge", "--quiet", "--ff-only", "feature-a"]);
        fs::write(Path::new(&path).join("unrelated.txt"), "unrelated\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "unrelated"]);
        run(&["merge", "--quiet", "--squash", "feature-b"]);
        run(&["commit", "--quiet", "--message", "squash feature b"]);
        let target = git_output(&path, &["rev-parse", "HEAD"]).unwrap();

        let edges: HashMap<_, _> = local_squash_merges(&path).into_iter().collect();
        let memo = squash_memo(&path, &tip).unwrap();
        let base = git_output(&path, &["merge-base", &tip, &target]).unwrap();
        clear_squash_memo(&path);
        remove_scratch_repository(&path);

        assert_eq!(edges.get(&tip), Some(&target));
        assert_eq!(memo.base, base);
    }

    #[test]
    fn moved_squash_tip_is_recomputed() {
        let (path, run) = scratch_repository("squash-memo-moved-tip");
        fs::write(Path::new(&path).join("base.txt"), "base\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["checkout", "--quiet", "-b", "feature"]);
        fs::write(Path::new(&path).join("feature.txt"), "one\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "first"]);
        let old_tip = git_output(&path, &["rev-parse", "HEAD"]).unwrap();
        run(&["checkout", "--quiet", "main"]);
        local_squash_merges(&path);
        run(&["checkout", "--quiet", "feature"]);
        fs::write(Path::new(&path).join("feature.txt"), "two\n").unwrap();
        run(&["commit", "--quiet", "--all", "--message", "second"]);
        let new_tip = git_output(&path, &["rev-parse", "HEAD"]).unwrap();
        run(&["checkout", "--quiet", "main"]);

        local_squash_merges(&path);
        let new_memo = squash_memo(&path, &new_tip);
        let old_memo = squash_memo(&path, &old_tip);
        clear_squash_memo(&path);
        remove_scratch_repository(&path);

        assert!(new_memo.is_some());
        assert!(old_memo.is_none());
    }

    #[test]
    fn force_moved_primary_recomputes_after_the_memoized_primary_is_pruned() {
        let (path, run) = scratch_repository("squash-memo-force-moved-primary");
        fs::write(Path::new(&path).join("base.txt"), "base\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        let base = git_output(&path, &["rev-parse", "HEAD"]).unwrap();
        run(&["checkout", "--quiet", "-b", "feature"]);
        fs::write(Path::new(&path).join("feature.txt"), "feature\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "feature"]);
        let tip = git_output(&path, &["rev-parse", "HEAD"]).unwrap();
        run(&["checkout", "--quiet", "main"]);
        run(&["merge", "--quiet", "--squash", "feature"]);
        run(&["commit", "--quiet", "--message", "squash feature"]);
        let target = git_output(&path, &["rev-parse", "HEAD"]).unwrap();
        let initial: HashMap<_, _> = local_squash_merges(&path).into_iter().collect();
        assert_eq!(initial.get(&tip), Some(&target));
        run(&["update-ref", "refs/heads/main", &base]);
        run(&["reflog", "expire", "--expire=now", "--all"]);
        run(&["gc", "--prune=now"]);
        assert!(!git_result(&path, &["cat-file", "-e", &target]).unwrap().status.success());

        let edges: HashMap<_, _> = local_squash_merges(&path).into_iter().collect();
        let memo = squash_memo(&path, &tip).unwrap();
        clear_squash_memo(&path);
        remove_scratch_repository(&path);

        assert!(!edges.contains_key(&tip));
        assert_eq!(memo.result, None);
        assert_eq!(memo.primary, base);
    }

    #[test]
    fn failed_squash_tip_computation_is_not_memoized() {
        let (path, run) = scratch_repository("squash-memo-failed-command");
        fs::write(Path::new(&path).join("main.txt"), "main\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "main"]);
        run(&["checkout", "--quiet", "--orphan", "feature"]);
        run(&["rm", "--quiet", "-rf", "."]);
        fs::write(Path::new(&path).join("feature.txt"), "feature\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "feature"]);
        let tip = git_output(&path, &["rev-parse", "HEAD"]).unwrap();
        run(&["checkout", "--quiet", "main"]);

        local_squash_merges(&path);
        let memo = squash_memo(&path, &tip);
        clear_squash_memo(&path);
        remove_scratch_repository(&path);

        assert!(memo.is_none());
    }

    #[test]
    fn falls_back_to_per_base_squash_candidates_without_an_octopus_base() {
        let (path, run) = scratch_repository("squash-unrelated-roots");
        let write = |name: &str, contents: &str| fs::write(Path::new(&path).join(name), contents).unwrap();
        write("base.txt", "base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        run(&["checkout", "--quiet", "-b", "squashed"]);
        write("squashed.txt", "squashed\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "squashed work"]);
        let squashed = git_output(&path, &["rev-parse", "HEAD"]).unwrap();
        run(&["checkout", "--quiet", "main"]);
        run(&["merge", "--quiet", "--squash", "squashed"]);
        run(&["commit", "--quiet", "--message", "squash merge"]);
        let target = git_output(&path, &["rev-parse", "HEAD"]).unwrap();
        run(&["checkout", "--quiet", "--orphan", "unrelated"]);
        run(&["rm", "--quiet", "-rf", "."]);
        write("unrelated.txt", "unrelated\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "unrelated root"]);
        run(&["checkout", "--quiet", "main"]);
        run(&["merge", "--quiet", "--allow-unrelated-histories", "unrelated", "--message", "join roots"]);
        run(&["checkout", "--quiet", "-b", "other", "unrelated"]);
        write("other.txt", "other\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "other work"]);
        run(&["checkout", "--quiet", "main"]);

        let edges: HashMap<_, _> = local_squash_merges(&path).into_iter().collect();
        remove_scratch_repository(&path);

        assert_eq!(edges.get(&squashed), Some(&target));
    }

    #[test]
    fn finds_the_commit_a_branch_was_squashed_into() {
        let path = env::temp_dir()
            .join(format!("git-nav-squash-{}", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        let run = |arguments: &[&str]| {
            let output = git_result(&path, arguments).unwrap();
            assert!(output.status.success(), "{arguments:?}: {}", String::from_utf8_lossy(&output.stderr));
        };
        let write = |name: &str, contents: &str| fs::write(Path::new(&path).join(name), contents).unwrap();
        let sha = |reference: &str| git_output(&path, &["rev-parse", reference]).unwrap();
        run(&["init", "--quiet", "--initial-branch=main"]);
        run(&["config", "user.email", "tests@example.com"]);
        run(&["config", "user.name", "Tests"]);
        run(&["config", "commit.gpgsign", "false"]);
        write("shared.txt", "base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);

        // Squashed straight onto the branch point, so the trees match.
        run(&["checkout", "--quiet", "-b", "onto-tip"]);
        write("onto-tip.txt", "one\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "first"]);
        write("onto-tip.txt", "one\ntwo\n");
        run(&["commit", "--quiet", "--all", "--message", "second"]);
        let onto_tip = sha("HEAD");
        run(&["checkout", "--quiet", "main"]);
        run(&["merge", "--quiet", "--squash", "onto-tip"]);
        run(&["commit", "--quiet", "--message", "Merge branch 'onto-tip'"]);
        let onto_tip_target = sha("HEAD");

        // Squashed after main moved on, so only the net change still matches.
        run(&["checkout", "--quiet", "-b", "after-drift", &onto_tip_target]);
        write("after-drift.txt", "alpha\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "drifting work"]);
        let after_drift = sha("HEAD");
        run(&["checkout", "--quiet", "main"]);
        write("unrelated.txt", "meanwhile\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "unrelated work on main"]);
        run(&["merge", "--quiet", "--squash", "after-drift"]);
        run(&["commit", "--quiet", "--message", "Merge branch 'after-drift'"]);
        let after_drift_target = sha("HEAD");

        // Genuinely unmerged, and must not be paired with anything.
        run(&["checkout", "--quiet", "-b", "still-open", "main"]);
        write("still-open.txt", "wip\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "work in progress"]);
        let still_open = sha("HEAD");
        run(&["checkout", "--quiet", "main"]);

        let edges: HashMap<_, _> = local_squash_merges(&path).into_iter().collect();
        fs::remove_dir_all(&path).unwrap();

        assert_eq!(edges.get(&onto_tip), Some(&onto_tip_target), "tree match failed");
        assert_eq!(edges.get(&after_drift), Some(&after_drift_target), "patch id fallback failed");
        assert!(!edges.contains_key(&still_open));
    }

    #[test]
    fn offers_a_squash_merged_branch_for_cleanup_without_a_pull_request() {
        let path = env::temp_dir()
            .join(format!("git-nav-squash-cleanup-{}", std::process::id()))
            .to_string_lossy()
            .to_string();
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

        for branch in ["squashed", "parked"] {
            run(&["checkout", "--quiet", "-b", branch, "main"]);
            write(&format!("{branch}.txt"), "one\n");
            run(&["add", "."]);
            run(&["commit", "--quiet", "--message", branch]);
            run(&["checkout", "--quiet", "main"]);
            run(&["merge", "--quiet", "--squash", branch]);
            run(&["commit", "--quiet", "--message", &format!("Merge branch '{branch}'")]);
        }

        run(&["checkout", "--quiet", "-b", "open", "main"]);
        write("open.txt", "wip\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "work in progress"]);
        run(&["checkout", "--quiet", "main"]);
        let worktree = env::temp_dir().join(format!("git-nav-squash-cleanup-parked-{}", std::process::id()));
        let _ = fs::remove_dir_all(&worktree);
        run(&["worktree", "add", "--quiet", &worktree.to_string_lossy(), "parked"]);

        let options = CleanupOptions { delete_merged_pull_request_branches: false, delete_merged_branches: true, delete_squash_merged_branches: true };
        let candidates = cleanup_candidates(&path, &options, None).unwrap();
        let _ = fs::remove_dir_all(&worktree);
        fs::remove_dir_all(&path).unwrap();

        let reasons: HashMap<_, _> = candidates.into_iter().map(|candidate| (candidate.branch, candidate.reasons)).collect();
        // A squash leaves no ancestry, so the merged rule cannot be the one claiming it.
        assert_eq!(reasons.get("squashed"), Some(&vec![CleanupReason::SquashedIntoDefaultBranch]));
        assert!(!reasons.contains_key("open"));
        assert!(!reasons.contains_key("parked"), "a branch held by a worktree cannot be deleted");
        assert!(!reasons.contains_key("main"));
    }

    #[test]
    fn skips_a_merged_pull_request_branch_held_by_a_worktree() {
        let (path, run) = scratch_repository("pr-cleanup-worktree");
        let write = |name: &str, contents: &str| fs::write(Path::new(&path).join(name), contents).unwrap();
        let sha = |reference: &str| git_output(&path, &["rev-parse", reference]).unwrap();
        run(&["remote", "add", "origin", "https://github.com/example/repo.git"]);
        write("shared.txt", "base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        for branch in ["merged", "parked"] {
            run(&["checkout", "--quiet", "-b", branch, "main"]);
            write(&format!("{branch}.txt"), "one\n");
            run(&["add", "."]);
            run(&["commit", "--quiet", "--message", branch]);
        }
        run(&["checkout", "--quiet", "main"]);
        let worktree = env::temp_dir().join(format!("git-nav-pr-cleanup-parked-{}", std::process::id()));
        let _ = fs::remove_dir_all(&worktree);
        run(&["worktree", "add", "--quiet", &worktree.to_string_lossy(), "parked"]);

        let database_path = Path::new(&path).join("pull-requests.sqlite");
        let connection = pull_request_database(database_path.clone()).unwrap();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
        connection
            .execute(
                "INSERT INTO pull_request_syncs (host, repository, synchronized_at) VALUES ('github.com', 'example/repo', ?1)",
                params![now],
            )
            .unwrap();
        for (number, branch) in [(1, "merged"), (2, "parked")] {
            connection
                .execute(
                    "INSERT INTO pull_requests (host, repository, number, head_sha, merged_at, updated_at) VALUES ('github.com', 'example/repo', ?1, ?2, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')",
                    params![number, sha(branch)],
                )
                .unwrap();
        }
        drop(connection);

        let candidates = merged_branch_candidates(&path, database_path).unwrap();
        let _ = fs::remove_dir_all(&worktree);
        remove_scratch_repository(&path);

        assert_eq!(candidates, ["merged"]);
    }

    #[test]
    fn detects_a_squash_merge_that_has_not_been_pushed_yet() {
        let path = env::temp_dir()
            .join(format!("git-nav-unpushed-squash-{}", std::process::id()))
            .to_string_lossy()
            .to_string();
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        let run = |arguments: &[&str]| {
            let output = git_result(&path, arguments).unwrap();
            assert!(output.status.success(), "{arguments:?}: {}", String::from_utf8_lossy(&output.stderr));
        };
        let write = |name: &str, contents: &str| fs::write(Path::new(&path).join(name), contents).unwrap();
        let sha = |reference: &str| git_output(&path, &["rev-parse", reference]).unwrap();
        run(&["init", "--quiet", "--initial-branch=main"]);
        run(&["config", "user.email", "tests@example.com"]);
        run(&["config", "user.name", "Tests"]);
        run(&["config", "commit.gpgsign", "false"]);
        write("shared.txt", "base\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);

        // The remote is left at the branch point, so the squash exists only on the local primary branch.
        run(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
        run(&["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

        run(&["checkout", "--quiet", "-b", "unpushed"]);
        write("unpushed.txt", "one\n");
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "work"]);
        let tip = sha("HEAD");
        run(&["checkout", "--quiet", "main"]);
        run(&["merge", "--quiet", "--squash", "unpushed"]);
        run(&["commit", "--quiet", "--message", "Merge branch 'unpushed'"]);
        let target = sha("HEAD");

        let primary = primary_reference(&path).unwrap();
        let reference = squash_search_reference(&path).unwrap();
        let edges: HashMap<_, _> = local_squash_merges(&path).into_iter().collect();
        fs::remove_dir_all(&path).unwrap();

        assert_eq!(primary, "origin/main");
        assert_eq!(reference, "refs/heads/main");
        assert_eq!(edges.get(&tip), Some(&target));
    }
}
