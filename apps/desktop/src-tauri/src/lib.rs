use serde::{Deserialize, Serialize};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    ipc::Channel, webview::PageLoadEvent, AppHandle, Manager, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};

const MAX_RECENT_REPOSITORIES: usize = 8;
const COMMIT_BATCH_SIZE: usize = 500;
const PULL_REQUEST_SYNC_INTERVAL_SECONDS: u64 = 60;
const MINIMUM_MERGE_TREE_VERSION: (u32, u32) = (2, 38);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Worktree {
    path: String,
    name: String,
    branch: String,
    head: String,
    is_main: bool,
    is_detached: bool,
    is_locked: bool,
    is_prunable: bool,
    is_open: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    name: String,
    path: String,
    worktrees: Vec<Worktree>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangedFile {
    status: String,
    old_path: Option<String>,
    new_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Comparison {
    base_sha: String,
    head_sha: String,
    files: Vec<ChangedFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileDiff {
    old_file_name: Option<String>,
    new_file_name: Option<String>,
    old_content: Option<String>,
    new_content: Option<String>,
    hunks: Vec<String>,
    is_binary: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BranchSelection {
    base_sha: String,
    head_sha: String,
    base_label: String,
    head_label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BranchCleanup {
    candidates: Vec<String>,
    deleted: Vec<String>,
    failed: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum CleanupReason {
    SquashMergedPullRequest,
    MergedIntoDefaultBranch,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupCandidate {
    branch: String,
    reasons: Vec<CleanupReason>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanupOptions {
    delete_merged_pull_request_branches: bool,
    delete_merged_branches: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PredictedConflict {
    commit: String,
    subject: String,
    files: Vec<String>,
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
enum ConflictPrediction {
    Clean,
    Conflicts(PredictedConflict),
    Unknown { reason: String },
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum PendingOperation {
    Rebase,
    Merge,
    CherryPick,
    Bisect,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BranchOperability {
    exists: bool,
    sha: Option<String>,
    worktree_path: Option<String>,
    is_current_worktree: bool,
    is_dirty: bool,
    pending_operation: Option<PendingOperation>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RefUpdate {
    reference: String,
    before: String,
    after: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompletedRebase {
    branch: String,
    head_sha: String,
    updates: Vec<RefUpdate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FailedRebase {
    message: String,
    files: Vec<String>,
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
enum RebaseResult {
    Completed(CompletedRebase),
    Failed(FailedRebase),
}

struct WorktreeRecord {
    path: String,
    branch: String,
    head: String,
    is_main: bool,
    is_detached: bool,
    is_locked: bool,
    is_prunable: bool,
}

#[derive(Default, Deserialize, Serialize)]
struct RecentRepositories {
    #[serde(default)]
    projects: Vec<String>,
    #[serde(default)]
    repositories: Vec<String>,
}

#[derive(Clone)]
struct OpenWorktree {
    project_id: String,
    worktree_path: String,
}

#[derive(Default)]
struct OpenWorktrees(Mutex<HashMap<String, OpenWorktree>>);

fn recent_repositories_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    Ok(data_dir.join("recent-repositories.json"))
}

fn pull_request_database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    Ok(data_dir.join("pull-requests.sqlite3"))
}

fn load_recent_paths(app: &AppHandle) -> Result<Vec<String>, String> {
    let path = recent_repositories_path(app)?;
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };

    serde_json::from_str::<RecentRepositories>(&contents)
        .map(|recent| {
            if recent.projects.is_empty() {
                recent.repositories
            } else {
                recent.projects
            }
        })
        .map_err(|error| error.to_string())
}

fn save_recent_path(app: &AppHandle, repository_path: &str) -> Result<(), String> {
    let mut paths = load_recent_paths(app)?;
    paths.retain(|path| path != repository_path);
    paths.insert(0, repository_path.to_string());
    paths.truncate(MAX_RECENT_REPOSITORIES);

    let contents = serde_json::to_string(&RecentRepositories {
        projects: paths,
        repositories: Vec::new(),
    })
    .map_err(|error| error.to_string())?;
    fs::write(recent_repositories_path(app)?, contents).map_err(|error| error.to_string())
}

fn git_output(path: &str, arguments: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let value = String::from_utf8(output.stdout).ok()?;
    let value = value.trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn git_output_bytes(path: &str, arguments: &[&str]) -> Option<Vec<u8>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .output()
        .ok()?;

    output.status.success().then_some(output.stdout)
}

fn git_output_allow_empty(path: &str, arguments: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    String::from_utf8(output.stdout).map_err(|error| error.to_string())
}

fn resolve_commit(path: &str, reference: &str) -> Result<String, String> {
    let revision = format!("{reference}^{{commit}}");
    git_output_allow_empty(path, &["rev-parse", "--verify", "--end-of-options", &revision])
        .map(|value| value.trim().to_string())
        .and_then(|value| (!value.is_empty()).then_some(value).ok_or_else(|| format!("Could not resolve {reference}.")))
}

fn changed_files(path: &str, base_sha: &str, head_sha: &str) -> Result<Vec<ChangedFile>, String> {
    let output = git_output_bytes(path, &["diff", "--no-ext-diff", "--find-renames", "--find-copies", "--name-status", "-z", base_sha, head_sha])
        .ok_or_else(|| "git diff failed.".to_string())?;
    let fields = output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .map(|field| String::from_utf8(field.to_vec()).map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let mut files = Vec::new();
    let mut index = 0;
    while let Some(status) = fields.get(index) {
        index += 1;
        let kind = status.chars().next().ok_or_else(|| "Invalid git diff status.".to_string())?;
        let first_path = fields.get(index).ok_or_else(|| "Invalid git diff path.".to_string())?.clone();
        index += 1;
        let (old_path, new_path, status) = match kind {
            'A' => (None, Some(first_path), "added"),
            'D' => (Some(first_path), None, "deleted"),
            'R' => {
                let new_path = fields.get(index).ok_or_else(|| "Invalid renamed path.".to_string())?.clone();
                index += 1;
                (Some(first_path), Some(new_path), "renamed")
            }
            'C' => {
                let new_path = fields.get(index).ok_or_else(|| "Invalid copied path.".to_string())?.clone();
                index += 1;
                (Some(first_path), Some(new_path), "copied")
            }
            _ => (Some(first_path.clone()), Some(first_path), "modified"),
        };
        files.push(ChangedFile { status: status.to_string(), old_path, new_path });
    }
    Ok(files)
}

fn primary_reference(path: &str) -> Result<String, String> {
    if let Some(reference) = git_output(path, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]) {
        if resolve_commit(path, &reference).is_ok() {
            return Ok(reference);
        }
    }
    for reference in ["main", "master", "HEAD"] {
        if resolve_commit(path, reference).is_ok() {
            return Ok(reference.to_string());
        }
    }
    Err("Could not identify the primary branch.".to_string())
}

fn worktree_path(path: &str) -> Result<String, String> {
    git_output(path, &["rev-parse", "--show-toplevel"])
        .ok_or_else(|| "Choose a Git repository.".to_string())
}

fn project_id(path: &str) -> Result<String, String> {
    let worktree_path = worktree_path(path)?;
    let common_dir = git_output(&worktree_path, &["rev-parse", "--git-common-dir"])
        .ok_or_else(|| "Could not identify the Git project.".to_string())?;
    let common_dir = PathBuf::from(common_dir);
    let common_dir = if common_dir.is_absolute() {
        common_dir
    } else {
        PathBuf::from(worktree_path).join(common_dir)
    };

    fs::canonicalize(common_dir)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| error.to_string())
}

fn worktree_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
        .to_string()
}

#[derive(Deserialize)]
struct GithubPullRequest {
    number: i64,
    merged_at: Option<String>,
    merge_commit_sha: Option<String>,
    updated_at: String,
    head: GithubPullRequestHead,
}

#[derive(Deserialize)]
struct GithubPullRequestHead {
    sha: String,
}

fn github_repository(remote: &str) -> Option<(String, String)> {
    let remote = remote.trim_end_matches('/').trim_end_matches(".git");
    let (host, path) = if let Some(remote) = remote.strip_prefix("git@") {
        remote.split_once(':')?
    } else if let Some(remote) = remote.strip_prefix("ssh://git@") {
        remote.split_once('/')?
    } else {
        let remote = remote
            .strip_prefix("https://")
            .or_else(|| remote.strip_prefix("http://"))?;
        remote.split_once('/')?
    };
    let (owner, repository) = path.split_once('/')?;
    (!owner.is_empty() && !repository.is_empty()).then_some((host.to_string(), format!("{owner}/{repository}")))
}

fn github_pull_requests(host: &str, repository: &str) -> Option<Vec<GithubPullRequest>> {
    let endpoint = format!("repos/{repository}/pulls?state=closed&sort=updated&direction=desc&per_page=100");
    let mut command = Command::new("gh");
    command.args(["api", "--method", "GET", "--header", "Accept: application/vnd.github+json"]);
    if host != "github.com" {
        command.args(["--hostname", host]);
    }
    let output = command.arg(endpoint).output().ok()?;
    output
        .status
        .success()
        .then(|| serde_json::from_slice(&output.stdout).ok())
        .flatten()
}

fn git_succeeds(path: &str, arguments: &[&str]) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .status()
        .is_ok_and(|status| status.success())
}

fn migrate_pull_request_database(connection: &mut Connection) -> Result<(), String> {
    connection
        .execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)")
        .map_err(|error| error.to_string())?;
    let version = connection
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get::<_, Option<i64>>(0))
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    if version < 1 {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction
            .execute_batch(
                "
                CREATE TABLE pull_requests (
                  host TEXT NOT NULL,
                  repository TEXT NOT NULL,
                  number INTEGER NOT NULL,
                  head_sha TEXT NOT NULL,
                  merge_commit_sha TEXT,
                  merged_at TEXT,
                  updated_at TEXT NOT NULL,
                  PRIMARY KEY (host, repository, number)
                );
                CREATE TABLE pull_request_syncs (
                  host TEXT NOT NULL,
                  repository TEXT NOT NULL,
                  synchronized_at INTEGER NOT NULL,
                  PRIMARY KEY (host, repository)
                );
                INSERT INTO schema_migrations (version) VALUES (1);
                ",
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn pull_request_database(path: PathBuf) -> Result<Connection, String> {
    let mut connection = Connection::open(path).map_err(|error| error.to_string())?;
    migrate_pull_request_database(&mut connection)?;
    Ok(connection)
}

fn should_sync_pull_requests(connection: &Connection, host: &str, repository: &str) -> Result<bool, String> {
    let synchronized_at = connection
        .query_row(
            "SELECT synchronized_at FROM pull_request_syncs WHERE host = ?1 AND repository = ?2",
            params![host, repository],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    Ok(match synchronized_at {
        Some(synchronized_at) => now.saturating_sub(synchronized_at as u64) >= PULL_REQUEST_SYNC_INTERVAL_SECONDS,
        None => true,
    })
}

fn sync_pull_requests(connection: &mut Connection, host: &str, repository: &str) -> Result<(), String> {
    let pull_requests = github_pull_requests(host, repository).ok_or_else(|| "Could not load pull requests.".to_string())?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    for pull_request in pull_requests {
        transaction
            .execute(
                "
                INSERT INTO pull_requests (host, repository, number, head_sha, merge_commit_sha, merged_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                ON CONFLICT(host, repository, number) DO UPDATE SET
                  head_sha = excluded.head_sha,
                  merge_commit_sha = excluded.merge_commit_sha,
                  merged_at = excluded.merged_at,
                  updated_at = excluded.updated_at
                WHERE excluded.updated_at > pull_requests.updated_at
                ",
                params![
                    host,
                    repository,
                    pull_request.number,
                    pull_request.head.sha,
                    pull_request.merge_commit_sha,
                    pull_request.merged_at,
                    pull_request.updated_at,
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    let synchronized_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs() as i64;
    transaction
        .execute(
            "
            INSERT INTO pull_request_syncs (host, repository, synchronized_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(host, repository) DO UPDATE SET synchronized_at = excluded.synchronized_at
            ",
            params![host, repository, synchronized_at],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn fetch_and_sync_repository(repo_path: &str, database_path: PathBuf) -> Result<(), String> {
    git_output_allow_empty(repo_path, &["fetch", "origin"])?;
    let remote = git_output(repo_path, &["remote", "get-url", "origin"])
        .ok_or_else(|| "Could not identify the origin remote.".to_string())?;
    let (host, repository) = github_repository(&remote)
        .ok_or_else(|| "Only GitHub remotes are supported.".to_string())?;
    let mut connection = pull_request_database(database_path)?;
    sync_pull_requests(&mut connection, &host, &repository)
}

fn inferred_squash_merges(repo_path: &str, database_path: PathBuf) -> Vec<(String, String)> {
    let Some(remote) = git_output(repo_path, &["remote", "get-url", "origin"]) else {
        return Vec::new();
    };
    let Some((host, repository)) = github_repository(&remote) else {
        return Vec::new();
    };
    let Ok(primary) = primary_reference(repo_path) else {
        return Vec::new();
    };
    let Some(refs) = git_output(repo_path, &["for-each-ref", "--format=%(objectname)", "refs/heads", "refs/remotes"]) else {
        return Vec::new();
    };
    let Ok(mut connection) = pull_request_database(database_path) else {
        return Vec::new();
    };
    if should_sync_pull_requests(&connection, &host, &repository).unwrap_or(false) {
        let _ = sync_pull_requests(&mut connection, &host, &repository);
    }
    let ref_hashes: HashSet<_> = refs.lines().collect();
    let mut edges = HashSet::new();
    let mut statement = match connection.prepare(
        "
        SELECT head_sha, merge_commit_sha
        FROM pull_requests
        WHERE host = ?1 AND repository = ?2 AND merged_at IS NOT NULL AND merge_commit_sha IS NOT NULL
        ",
    ) {
        Ok(statement) => statement,
        Err(_) => return Vec::new(),
    };
    let pull_requests = match statement.query_map(params![host, repository], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))) {
        Ok(pull_requests) => pull_requests,
        Err(_) => return Vec::new(),
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

    Ok(refs
        .split('\n')
        .filter_map(|line| line.split_once('\0'))
        .filter(|(branch, hash)| !protected.contains(branch) && merged_heads.contains(*hash))
        .map(|(branch, _)| branch.to_string())
        .collect())
}

fn merged_local_branch_candidates(repo_path: &str) -> Result<Vec<String>, String> {
    let primary = primary_reference(repo_path)?;
    let primary_branch = primary.strip_prefix("origin/").unwrap_or(&primary);
    let protected = ["main", "master", primary_branch]
        .into_iter()
        .collect::<HashSet<_>>();
    let refs = git_output_allow_empty(
        repo_path,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    )?;
    let worktrees = git_output_allow_empty(repo_path, &["worktree", "list", "--porcelain", "-z"])?;
    let checked_out = parse_worktree_records(&worktrees)
        .into_iter()
        .filter(|worktree| !worktree.is_detached)
        .map(|worktree| worktree.branch)
        .collect::<HashSet<_>>();

    Ok(refs
        .lines()
        .filter(|branch| !protected.contains(branch) && !checked_out.contains(*branch))
        .filter(|branch| {
            git_succeeds(
                repo_path,
                &["merge-base", "--is-ancestor", branch, &primary],
            )
        })
        .map(str::to_string)
        .collect())
}

fn cleanup_candidates(
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
    let mut candidates = candidates
        .into_iter()
        .map(|(branch, reasons)| CleanupCandidate { branch, reasons })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| left.branch.cmp(&right.branch));
    Ok(candidates)
}

fn parse_worktree_records(output: &str) -> Vec<WorktreeRecord> {
    let mut worktrees = Vec::new();

    for (index, record) in output
        .split('\0')
        .collect::<Vec<_>>()
        .split(|field| field.is_empty())
        .enumerate()
    {
        let mut path = None;
        let mut head = None;
        let mut branch = None;
        let mut detached = false;
        let mut locked = false;
        let mut prunable = false;

        for field in record {
            if let Some(value) = field.strip_prefix("worktree ") {
                path = Some(value.to_string());
            } else if let Some(value) = field.strip_prefix("HEAD ") {
                head = Some(value.to_string());
            } else if let Some(value) = field.strip_prefix("branch refs/heads/") {
                branch = Some(value.to_string());
            } else if *field == "detached" {
                detached = true;
            } else if field.starts_with("locked") {
                locked = true;
            } else if field.starts_with("prunable") {
                prunable = true;
            }
        }

        if let Some(path) = path {
            worktrees.push(WorktreeRecord {
                path,
                branch: branch.unwrap_or_else(|| "Detached HEAD".to_string()),
                head: head.unwrap_or_default(),
                is_main: index == 0,
                is_detached: detached,
                is_locked: locked,
                is_prunable: prunable,
            });
        }
    }

    worktrees
}

fn project_at(path: &str, open_worktrees: &OpenWorktrees) -> Result<Project, String> {
    let id = project_id(path)?;
    let output = git_output_bytes(path, &["worktree", "list", "--porcelain", "-z"])
        .ok_or_else(|| "Could not list Git worktrees.".to_string())?;
    let output = String::from_utf8(output).map_err(|error| error.to_string())?;
    let open_worktrees = open_worktrees.0.lock().map_err(|error| error.to_string())?;
    let worktrees = parse_worktree_records(&output)
        .into_iter()
        .map(|worktree| {
            let path = worktree.path;
            let is_open = open_worktrees
                .values()
                .any(|worktree| worktree.project_id == id && worktree.worktree_path == path);
            Worktree {
                name: worktree_name(&path),
                path,
                branch: worktree.branch,
                head: worktree.head,
                is_main: worktree.is_main,
                is_detached: worktree.is_detached,
                is_locked: worktree.is_locked,
                is_prunable: worktree.is_prunable,
                is_open,
            }
        })
        .collect::<Vec<_>>();

    let main = worktrees
        .first()
        .ok_or_else(|| "No usable Git worktrees were found.".to_string())?;
    Ok(Project {
        id,
        name: worktree_name(&main.path),
        path: main.path.clone(),
        worktrees,
    })
}

#[tauri::command]
fn recent_projects(
    app: AppHandle,
    open_worktrees: tauri::State<OpenWorktrees>,
) -> Result<Vec<Project>, String> {
    let mut project_ids = HashSet::new();
    Ok(load_recent_paths(&app)?
        .into_iter()
        .filter_map(|path| project_at(&path, &open_worktrees).ok())
        .filter(|project| project_ids.insert(project.id.clone()))
        .collect())
}

#[tauri::command]
fn project_snapshot(
    path: String,
    open_worktrees: tauri::State<OpenWorktrees>,
) -> Result<Project, String> {
    project_at(&path, &open_worktrees)
}

fn open_repository_window(app: &AppHandle, path: &str) -> Result<(), String> {
    let worktree_path = worktree_path(path)?;
    let project = project_at(&worktree_path, &app.state::<OpenWorktrees>())?;
    save_recent_path(app, &project.path)?;
    let label = format!(
        "repository-{}",
        worktree_path.as_bytes().iter().fold(0u64, |hash, byte| hash
            .wrapping_mul(31)
            .wrapping_add(*byte as u64))
    );

    if let Some(window) = app.get_webview_window(&label) {
        window.set_focus().map_err(|error| error.to_string())?;
    } else {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("repository", &worktree_path)
            .finish();
        let url = format!("/?{query}");
        let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
            .title(format!("{} · Git Nav", worktree_name(&worktree_path)))
            .inner_size(800.0, 600.0)
            .visible(false)
            .build()
            .map_err(|error| error.to_string())?;
        window.on_window_event({
            let app = app.clone();
            let label = label.clone();
            move |event| {
                if matches!(event, WindowEvent::Destroyed) {
                    if let Ok(mut worktrees) = app.state::<OpenWorktrees>().0.lock() {
                        worktrees.remove(&label);
                    }
                }
            }
        });
        app.state::<OpenWorktrees>()
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .insert(
                label,
                OpenWorktree {
                    project_id: project.id,
                    worktree_path,
                },
            );
    }

    if let Some(window) = app.get_webview_window("main") {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn repository_path_from_args(args: &[String], cwd: &str) -> Option<String> {
    let path = args.get(1)?;
    let path = PathBuf::from(path);
    Some(
        if path.is_absolute() {
            path
        } else {
            PathBuf::from(cwd).join(path)
        }
        .to_string_lossy()
        .into_owned(),
    )
}

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

fn parse_commit(
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

#[tauri::command]
fn stream_commit_graph(
    repo_path: String,
    on_batch: Channel<Vec<Vec<serde_json::Value>>>,
) -> Result<(), String> {
    let mut reserved_tip = primary_reference(&repo_path)
        .and_then(|reference| resolve_commit(&repo_path, &reference))
        .ok();
    let mut child = Command::new("git")
        .args([
            "--no-optional-locks",
            "-C",
            &repo_path,
            "log",
            "--all",
            "--topo-order",
            "--format=%H%x00%P%x00%an%x00%aI%x00%D%x00%s",
        ])
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read git output.".to_string())?;
    let mut lanes = Vec::new();
    let mut batch = Vec::with_capacity(COMMIT_BATCH_SIZE);

    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|error| error.to_string())?;
        if let Some(commit) = parse_commit(&line, &mut lanes, &mut reserved_tip) {
            batch.push(commit);
        }

        if batch.len() == COMMIT_BATCH_SIZE {
            on_batch.send(batch).map_err(|error| error.to_string())?;
            batch = Vec::with_capacity(COMMIT_BATCH_SIZE);
        }
    }

    if !batch.is_empty() {
        on_batch.send(batch).map_err(|error| error.to_string())?;
    }

    let status = child.wait().map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("git log failed.".to_string())
    }
}

#[tauri::command]
async fn inferred_squash_merge_edges(app: AppHandle, repo_path: String) -> Vec<(String, String)> {
    let Ok(database_path) = pull_request_database_path(&app) else {
        return Vec::new();
    };
    tauri::async_runtime::spawn_blocking(move || inferred_squash_merges(&repo_path, database_path))
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn fetch_and_sync_pull_requests(app: AppHandle, repo_path: String) -> Result<(), String> {
    let database_path = pull_request_database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || fetch_and_sync_repository(&repo_path, database_path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn squashed_branch_candidates(app: AppHandle, repo_path: String) -> Result<Vec<String>, String> {
    let database_path = pull_request_database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || merged_branch_candidates(&repo_path, database_path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn preview_cleanup_candidates(
    app: AppHandle,
    repo_path: String,
    options: CleanupOptions,
) -> Result<Vec<CleanupCandidate>, String> {
    let database_path = options
        .delete_merged_pull_request_branches
        .then(|| pull_request_database_path(&app))
        .transpose()?;
    tauri::async_runtime::spawn_blocking(move || {
        cleanup_candidates(&repo_path, &options, database_path)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn delete_squashed_branches(
    app: AppHandle,
    repo_path: String,
    options: CleanupOptions,
) -> Result<BranchCleanup, String> {
    let database_path = options
        .delete_merged_pull_request_branches
        .then(|| pull_request_database_path(&app))
        .transpose()?;
    tauri::async_runtime::spawn_blocking(move || {
        let candidates = cleanup_candidates(&repo_path, &options, database_path)?
            .into_iter()
            .map(|candidate| candidate.branch)
            .collect::<Vec<_>>();
        let mut deleted = Vec::new();
        let mut failed = Vec::new();
        for branch in &candidates {
            if git_succeeds(&repo_path, &["branch", "-D", "--", branch]) {
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
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn delete_branch(repo_path: String, branch: String) -> Result<(), String> {
    git_output_allow_empty(&repo_path, &["branch", "-D", "--", &branch]).map(|_| ())
}

#[tauri::command]
fn compare_refs(repo_path: String, base_ref: String, head_ref: String) -> Result<Comparison, String> {
    let base_sha = resolve_commit(&repo_path, &base_ref)?;
    let head_sha = resolve_commit(&repo_path, &head_ref)?;
    Ok(Comparison {
        files: changed_files(&repo_path, &base_sha, &head_sha)?,
        base_sha,
        head_sha,
    })
}

#[tauri::command]
fn reference_picker_commits(repo_path: String) -> Result<Vec<Vec<serde_json::Value>>, String> {
    let output = git_output_allow_empty(
        &repo_path,
        &[
            "log",
            "--all",
            "--topo-order",
            "--max-count=250",
            "--format=%H%x00%P%x00%an%x00%aI%x00%D%x00%s",
        ],
    )?;
    let mut lanes = Vec::new();
    Ok(output
        .lines()
        .filter_map(|line| parse_commit(line, &mut lanes, &mut None))
        .collect())
}

#[tauri::command]
fn select_branch_range(repo_path: String, reference: String) -> Result<BranchSelection, String> {
    let primary = primary_reference(&repo_path)?;
    let primary_sha = resolve_commit(&repo_path, &primary)?;
    let head_sha = resolve_commit(&repo_path, &reference)?;
    let base_sha = git_output_allow_empty(&repo_path, &["merge-base", &primary_sha, &head_sha])?
        .trim()
        .to_string();
    if base_sha.is_empty() {
        return Err(format!("Could not find a merge base for {reference}."));
    }
    Ok(BranchSelection {
        base_sha,
        head_sha,
        base_label: format!("merge-base({primary}, {reference})"),
        head_label: reference,
    })
}

#[tauri::command]
fn diff_file(
    repo_path: String,
    base_sha: String,
    head_sha: String,
    old_path: Option<String>,
    new_path: Option<String>,
) -> Result<FileDiff, String> {
    let path = new_path.as_ref().or(old_path.as_ref()).ok_or_else(|| "No file path was provided.".to_string())?;
    let numstat = git_output_allow_empty(&repo_path, &["diff", "--no-ext-diff", "--numstat", &base_sha, &head_sha, "--", path])?;
    let is_binary = numstat.lines().next().is_some_and(|line| line.starts_with("-\t-\t"));
    if is_binary {
        return Ok(FileDiff {
            old_file_name: old_path,
            new_file_name: new_path,
            old_content: None,
            new_content: None,
            hunks: Vec::new(),
            is_binary: true,
        });
    }

    let old_content = old_path.as_ref().map(|path| git_output_allow_empty(&repo_path, &["show", &format!("{base_sha}:{path}")])).transpose()?;
    let new_content = new_path.as_ref().map(|path| git_output_allow_empty(&repo_path, &["show", &format!("{head_sha}:{path}")])).transpose()?;
    let patch = git_output_allow_empty(&repo_path, &["diff", "--no-ext-diff", "--find-renames", "--find-copies", "--no-color", "--unified=3", &base_sha, &head_sha, "--", path])?;

    Ok(FileDiff {
        old_file_name: old_path,
        new_file_name: new_path,
        old_content,
        new_content,
        hunks: (!patch.is_empty()).then_some(vec![patch]).unwrap_or_default(),
        is_binary: false,
    })
}

fn git_result(path: &str, arguments: &[&str]) -> Result<Output, String> {
    Command::new("git")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| error.to_string())
}

fn parse_git_version(output: &str) -> Option<(u32, u32)> {
    let mut parts = output.split_whitespace().nth(2)?.split('.');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

fn git_version(path: &str) -> Option<(u32, u32)> {
    git_output(path, &["--version"]).as_deref().and_then(parse_git_version)
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

fn predicted_conflicts(repo_path: &str, onto: &str, upstream: &str, branch: &str) -> Result<ConflictPrediction, String> {
    let Some(version) = git_version(repo_path) else {
        return Ok(ConflictPrediction::Unknown { reason: "Could not read the installed Git version.".to_string() });
    };
    if version < MINIMUM_MERGE_TREE_VERSION {
        let (major, minor) = MINIMUM_MERGE_TREE_VERSION;
        return Ok(ConflictPrediction::Unknown {
            reason: format!("Predicting conflicts requires Git {major}.{minor} or newer."),
        });
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

fn existing_git_path(worktree: &str, name: &str) -> Option<PathBuf> {
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
fn worktree_for_branch(repo_path: &str, branch: &str) -> Result<Option<String>, String> {
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

fn pending_operation(worktree: &str) -> Option<PendingOperation> {
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

fn worktree_is_dirty(worktree: &str) -> Result<bool, String> {
    let output = git_output_allow_empty(worktree, &["status", "--porcelain", "--untracked-files=no"])?;
    Ok(!output.trim().is_empty())
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

fn parse_ref_shas(output: &str) -> HashMap<String, String> {
    output
        .lines()
        .filter_map(|line| line.split_once('\0'))
        .map(|(reference, sha)| (reference.to_string(), sha.to_string()))
        .collect()
}

fn branch_shas(repo_path: &str) -> Result<HashMap<String, String>, String> {
    git_output_allow_empty(repo_path, &["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads"])
        .map(|output| parse_ref_shas(&output))
}

fn changed_refs(before: &HashMap<String, String>, after: &HashMap<String, String>) -> Vec<RefUpdate> {
    let mut updates = before
        .iter()
        .filter_map(|(reference, sha)| {
            let current = after.get(reference)?;
            (current != sha).then(|| RefUpdate {
                reference: reference.clone(),
                before: sha.clone(),
                after: current.clone(),
            })
        })
        .collect::<Vec<_>>();
    updates.sort_by(|left, right| left.reference.cmp(&right.reference));
    updates
}

fn conflicted_files(worktree: &str) -> Vec<String> {
    git_output_allow_empty(worktree, &["diff", "--name-only", "--diff-filter=U"])
        .map(|output| output.lines().map(str::to_string).collect())
        .unwrap_or_default()
}

fn failed_rebase(worktree: &str, output: &Output) -> RebaseResult {
    RebaseResult::Failed(FailedRebase {
        files: conflicted_files(worktree),
        message: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

fn completed_rebase(repo_path: &str, branch: &str, before: &HashMap<String, String>) -> Result<RebaseResult, String> {
    Ok(RebaseResult::Completed(CompletedRebase {
        head_sha: resolve_commit(repo_path, &format!("refs/heads/{branch}"))?,
        branch: branch.to_string(),
        updates: changed_refs(before, &branch_shas(repo_path)?),
    }))
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

fn rebase_branch_onto(repo_path: &str, onto: &str, upstream: &str, branch: &str) -> Result<RebaseResult, String> {
    let reference = format!("refs/heads/{branch}");
    resolve_commit(repo_path, &reference)?;
    resolve_commit(repo_path, onto)?;
    resolve_commit(repo_path, upstream)?;
    let before = branch_shas(repo_path)?;

    if let Some(worktree) = worktree_for_branch(repo_path, branch)? {
        if pending_operation(&worktree).is_some() {
            return Err(format!("{worktree} already has a Git operation in progress."));
        }
        if worktree_is_dirty(&worktree)? {
            return Err(format!("{worktree} has uncommitted changes."));
        }
        let output = git_result(&worktree, &["rebase", "--onto", onto, upstream, branch])?;
        if output.status.success() {
            return completed_rebase(repo_path, branch, &before);
        }
        let failure = failed_rebase(&worktree, &output);
        let _ = git_result(&worktree, &["rebase", "--abort"]);
        return Ok(failure);
    }

    // Rebasing an unchecked-out branch from the user's own worktree would move that worktree onto it.
    let worktree = temporary_worktree_path("rebase");
    git_output_allow_empty(repo_path, &["worktree", "add", "--detach", &worktree, &reference])?;
    let result = git_result(&worktree, &["rebase", "--onto", onto, upstream, branch]).and_then(|output| {
        if output.status.success() {
            completed_rebase(repo_path, branch, &before)
        } else {
            Ok(failed_rebase(&worktree, &output))
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
        worktrees.push(worktree);
    }
    for update in updates {
        git_output_allow_empty(repo_path, &["update-ref", &update.reference, &update.before, &update.after])?;
    }
    for worktree in worktrees {
        git_output_allow_empty(&worktree, &["reset", "--hard"])?;
    }
    Ok(())
}

#[tauri::command]
async fn predict_rebase_conflicts(
    repo_path: String,
    onto: String,
    upstream: String,
    branch: String,
) -> Result<ConflictPrediction, String> {
    tauri::async_runtime::spawn_blocking(move || predicted_conflicts(&repo_path, &onto, &upstream, &branch))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn branch_operation_state(repo_path: String, branch: String) -> Result<BranchOperability, String> {
    branch_operability(&repo_path, &branch)
}

#[tauri::command]
async fn rebase_onto(
    repo_path: String,
    onto: String,
    upstream: String,
    branch: String,
) -> Result<RebaseResult, String> {
    tauri::async_runtime::spawn_blocking(move || rebase_branch_onto(&repo_path, &onto, &upstream, &branch))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn undo_ref_updates(repo_path: String, updates: Vec<RefUpdate>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || restore_refs(&repo_path, &updates))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_the_invocation_directory_for_relative_paths() {
        let path = repository_path_from_args(
            &["git-nav".to_string(), "repository".to_string()],
            "/workspace",
        );

        assert_eq!(path.as_deref(), Some("/workspace/repository"));
    }

    #[test]
    fn preserves_absolute_paths() {
        let path = repository_path_from_args(
            &["git-nav".to_string(), "/workspace/repository".to_string()],
            "/other-workspace",
        );

        assert_eq!(path.as_deref(), Some("/workspace/repository"));
    }

    #[test]
    fn parses_main_and_linked_worktrees_from_porcelain_output() {
        let worktrees = parse_worktree_records(
            "worktree /workspace/project\0HEAD main-sha\0branch refs/heads/main\0\0worktree /workspace/fix\0HEAD fix-sha\0branch refs/heads/fix\0locked\0\0worktree /workspace/old\0HEAD old-sha\0detached\0prunable missing\0\0",
        );

        assert_eq!(worktrees.len(), 3);
        assert!(worktrees[0].is_main);
        assert_eq!(worktrees[0].branch, "main");
        assert_eq!(worktrees[1].branch, "fix");
        assert!(worktrees[1].is_locked);
        assert!(worktrees[2].is_detached);
        assert!(worktrees[2].is_prunable);
        assert_eq!(worktrees[2].branch, "Detached HEAD");
    }

    #[test]
    fn parses_github_remote_urls() {
        assert_eq!(
            github_repository("git@github.com:octocat/hello-world.git"),
            Some(("github.com".to_string(), "octocat/hello-world".to_string()))
        );
        assert_eq!(
            github_repository("https://github.com/octocat/hello-world.git"),
            Some(("github.com".to_string(), "octocat/hello-world".to_string()))
        );
    }

    #[test]
    fn migrates_pull_request_database() {
        let mut connection = Connection::open_in_memory().unwrap();

        migrate_pull_request_database(&mut connection).unwrap();

        let version = connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get::<_, i64>(0))
            .unwrap();
        assert_eq!(version, 1);
    }

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
    fn reads_the_major_and_minor_git_version() {
        assert_eq!(parse_git_version("git version 2.50.1 (Apple Git-155)"), Some((2, 50)));
        assert_eq!(parse_git_version("git version 2.39.5"), Some((2, 39)));
        assert_eq!(parse_git_version("not git"), None);
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
    fn reports_only_the_refs_an_operation_moved() {
        let before = parse_ref_shas("refs/heads/main\0aaa\nrefs/heads/topic\0bbb\nrefs/heads/other\0ccc");
        let after = parse_ref_shas("refs/heads/main\0aaa\nrefs/heads/topic\0ddd");

        let updates = changed_refs(&before, &after);

        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].reference, "refs/heads/topic");
        assert_eq!(updates[0].before, "bbb");
        assert_eq!(updates[0].after, "ddd");
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
        assert!(matches!(rebase, RebaseResult::Completed(_)));
        assert_eq!(replayed.lines().collect::<Vec<_>>(), vec!["add a file"]);
    }
}

#[tauri::command]
fn open_repository(app: AppHandle, path: String) -> Result<(), String> {
    open_repository_window(&app, &path)
}

#[tauri::command]
fn open_worktree(app: AppHandle, path: String, target: String) -> Result<(), String> {
    if target == "git-nav" {
        return open_repository_window(&app, &path);
    }
    #[cfg(target_os = "macos")]
    {
        let arguments = match target.as_str() {
            "vscode" => vec!["-a", "Visual Studio Code", &path],
            "terminal" => vec!["-a", "Terminal", &path],
            "finder" => vec![path.as_str()],
            _ => return Err("Unknown worktree target.".to_string()),
        };
        Command::new("open")
            .args(arguments)
            .status()
            .map_err(|error| error.to_string())?
            .success()
            .then_some(())
            .ok_or_else(|| format!("Could not open {target}."))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, path, target);
        Err("Opening worktrees outside Git Nav is currently supported on macOS only.".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<_> = env::args().collect();
    let cwd = env::current_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let repository_path = repository_path_from_args(&args, &cwd);

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(path) = repository_path_from_args(&args, &cwd) {
                let _ = open_repository_window(app, &path);
            }
        }));
    }

    builder
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = webview.window().show();
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .manage(OpenWorktrees::default())
        .invoke_handler(tauri::generate_handler![
            recent_projects,
            open_repository,
            open_worktree,
            project_snapshot,
            stream_commit_graph,
            inferred_squash_merge_edges,
            fetch_and_sync_pull_requests,
            squashed_branch_candidates,
            preview_cleanup_candidates,
            delete_squashed_branches,
            delete_branch,
            compare_refs,
            reference_picker_commits,
            select_branch_range,
            diff_file,
            predict_rebase_conflicts,
            branch_operation_state,
            rebase_onto,
            undo_ref_updates
        ])
        .setup(move |app| {
            if let Some(path) = &repository_path {
                open_repository_window(app.handle(), path)?;
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
