use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, collections::HashSet, io::ErrorKind, path::PathBuf, process::Command, sync::{Arc, Mutex, OnceLock}, time::{Duration, SystemTime, UNIX_EPOCH}};
use crate::process::{external_command, output_with_timeout};
use crate::storage::data_dir;
use crate::git::git_output_allow_empty;

const PAGE_SIZE: usize = 100;
const HEAD_REPOSITORY_BATCH_SIZE: usize = 10;
pub(crate) const RATE_LIMIT_RESERVE: u64 = 100;
const GITHUB_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

static GITHUB_QUOTAS: OnceLock<Mutex<HashMap<String, Arc<Mutex<GithubQuota>>>>> = OnceLock::new();

pub(crate) fn pull_request_database_path() -> Result<PathBuf, String> {
    data_dir().map(|dir| dir.join("pull-requests.sqlite3"))
}

#[derive(Deserialize)]
pub(crate) struct GithubPullRequest {
    number: i64,
    title: String,
    state: String,
    draft: bool,
    merged_at: Option<String>,
    merge_commit_sha: Option<String>,
    updated_at: String,
    head: GithubPullRequestHead,
}

#[derive(Deserialize)]
pub(crate) struct GithubPullRequestHead {
    #[serde(rename = "ref")]
    reference: String,
    repo: Option<GithubRepositoryRef>,
    sha: String,
}

#[derive(Deserialize)]
pub(crate) struct GithubRepositoryRef {
    full_name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BranchPullRequest {
    branch: String,
    remote: String,
    host: String,
    repository: String,
    number: i64,
    state: String,
    title: String,
    url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct GithubRepository {
    pub(crate) host: String,
    pub(crate) repository: String,
}

pub(crate) fn github_repository(remote: &str) -> Option<(String, String)> {
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

/// The GitHub repositories behind a repository's remotes, origin first and each listed once however many
/// remotes point at it.
pub(crate) fn github_repositories(repo_path: &str) -> Vec<GithubRepository> {
    let mut seen = HashSet::new();
    github_remotes(repo_path)
        .into_iter()
        .filter_map(|(_, repository)| seen.insert(repository.clone()).then_some(repository))
        .collect()
}

fn github_remotes(repo_path: &str) -> Vec<(String, GithubRepository)> {
    let remotes = git_output_allow_empty(repo_path, &["remote", "--verbose"]).unwrap_or_default();
    parse_github_remotes(&remotes, |host| {
        if std::env::var("GH_HOST").is_ok_and(|configured| host.eq_ignore_ascii_case(&configured)) {
            return true;
        }
        external_command("gh")
            .args(["config", "get", "user", "--host", host])
            .output()
            .is_ok_and(|output| output.status.success() && !output.stdout.trim_ascii().is_empty())
    })
}

fn parse_github_remotes(remotes: &str, mut configured_host: impl FnMut(&str) -> bool) -> Vec<(String, GithubRepository)> {
    let mut named: Vec<(String, GithubRepository)> = Vec::new();
    let mut hosts = HashMap::new();
    for line in remotes.lines() {
        let mut fields = line.split_whitespace();
        let (Some(name), Some(url), Some("(fetch)")) = (fields.next(), fields.next(), fields.next()) else {
            continue;
        };
        let Some((host, repository)) = github_repository(url) else {
            continue;
        };
        let host = host.to_ascii_lowercase();
        let is_github = hosts.entry(host.clone()).or_insert_with(|| {
            host == "github.com" || host.ends_with(".ghe.com") || configured_host(&host)
        });
        if !*is_github {
            continue;
        }
        named.push((name.to_string(), GithubRepository { host, repository }));
    }
    named.sort_by_key(|(name, _)| name != "origin");
    named
}

pub(crate) enum GithubPullRequestFailure<'a> {
    Spawn(ErrorKind),
    Exit { code: Option<i32>, stderr: &'a [u8] },
    UnreadableResponse,
}

fn github_pull_request_failure_message(failure: GithubPullRequestFailure<'_>) -> String {
    match failure {
        GithubPullRequestFailure::Spawn(ErrorKind::NotFound) => {
            "GitHub CLI was not found; install it to enable pull request information.".to_string()
        }
        GithubPullRequestFailure::Spawn(_) => "Could not start GitHub CLI.".to_string(),
        GithubPullRequestFailure::Exit { code: Some(4), .. } => {
            "GitHub CLI is not signed in; run gh auth login.".to_string()
        }
        GithubPullRequestFailure::Exit { stderr, .. } => String::from_utf8_lossy(stderr)
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(|line| line.strip_prefix("gh: ").unwrap_or(line).to_string())
            .unwrap_or_else(|| "Could not load pull requests from GitHub.".to_string()),
        GithubPullRequestFailure::UnreadableResponse => {
            "Could not read the pull request response from GitHub.".to_string()
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RateLimit {
    pub(crate) remaining: u64,
    /// Seconds since the Unix epoch at which the quota refills.
    pub(crate) reset: u64,
}

#[derive(Debug, PartialEq, Eq)]
struct GithubResponse {
    status: u16,
    etag: Option<String>,
    rate_limit: Option<RateLimit>,
    retry_after: Option<u64>,
    body: Vec<u8>,
}

// `gh api --include` writes the status line and headers ahead of the body, separated by a blank line. The
// header lines keep the CRLF endings they arrived with while the status line gets a bare LF.
fn split_header_block(output: &[u8]) -> Option<(&[u8], &[u8])> {
    let mut index = 0;
    while let Some(offset) = output[index..].iter().position(|byte| *byte == b'\n') {
        let newline = index + offset;
        if output.get(newline + 1) == Some(&b'\n') {
            return Some((&output[..newline], &output[newline + 2..]));
        }
        if output.get(newline + 1..newline + 3) == Some(b"\r\n") {
            return Some((&output[..newline], &output[newline + 3..]));
        }
        index = newline + 1;
    }
    None
}

fn parse_github_response(output: &[u8]) -> Option<GithubResponse> {
    let mut rest = output;
    loop {
        let (head, body) = split_header_block(rest)?;
        let head = String::from_utf8_lossy(head);
        let mut lines = head.lines();
        let status = lines.next()?.split_whitespace().nth(1)?.parse().ok()?;
        let mut etag = None;
        let mut remaining = None;
        let mut reset = None;
        let mut retry_after = None;
        for line in lines {
            let Some((name, value)) = line.split_once(':') else { continue };
            let value = value.trim();
            if name.eq_ignore_ascii_case("etag") {
                etag = Some(value.to_string());
            } else if name.eq_ignore_ascii_case("x-ratelimit-remaining") {
                remaining = value.parse().ok();
            } else if name.eq_ignore_ascii_case("x-ratelimit-reset") {
                reset = value.parse().ok();
            } else if name.eq_ignore_ascii_case("retry-after") {
                retry_after = value.parse().ok();
            }
        }
        // A redirect leaves the answer it was redirected to behind its own header block.
        if (300..400).contains(&status) && status != 304 && body.starts_with(b"HTTP/") {
            rest = body;
            continue;
        }
        let rate_limit = remaining.zip(reset).map(|(remaining, reset)| RateLimit { remaining, reset });
        return Some(GithubResponse { status, etag, rate_limit, retry_after, body: body.to_vec() });
    }
}

/// Why a sync stopped, along with the quota GitHub reported on the way, which is what tells a refusal for
/// being over the limit apart from one that a retry could fix.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SyncFailure {
    pub(crate) message: String,
    pub(crate) rate_limit: Option<RateLimit>,
    pub(crate) retry_at: Option<u64>,
}

impl From<String> for SyncFailure {
    fn from(message: String) -> Self {
        Self { message, rate_limit: None, retry_at: None }
    }
}

#[derive(Default)]
struct GithubQuota {
    rate_limit: Option<RateLimit>,
    retry_at: Option<u64>,
}

impl GithubQuota {
    fn hold_until_epoch(&self) -> Option<u64> {
        self.rate_limit.filter(|limit| limit.remaining < RATE_LIMIT_RESERVE).map(|limit| limit.reset).max(self.retry_at)
    }
}

fn github_host_quota(host: &str) -> Arc<Mutex<GithubQuota>> {
    let mut quotas = GITHUB_QUOTAS.get_or_init(Mutex::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    quotas.entry(host.to_ascii_lowercase()).or_default().clone()
}

fn with_github_quota(
    quota: &Mutex<GithubQuota>,
    request: impl FnOnce() -> Result<GithubResponse, SyncFailure>,
) -> Result<GithubResponse, SyncFailure> {
    // gh uses one active account per host, so every repository and page shares this request gate.
    let mut quota = quota.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    if quota.hold_until_epoch().is_some_and(|until| now < until) {
        return Err(SyncFailure {
            message: "GitHub pull request sync paused until the API rate limit resets.".to_string(),
            rate_limit: quota.rate_limit,
            retry_at: quota.retry_at,
        });
    }
    let response = request();
    match &response {
        Ok(response) => quota.rate_limit = response.rate_limit.or(quota.rate_limit),
        Err(failure) => {
            quota.rate_limit = failure.rate_limit.or(quota.rate_limit);
            quota.retry_at = failure.retry_at.max(quota.retry_at);
        }
    }
    response
}

fn github_request(host: &str, endpoint: &str, etag: Option<&str>) -> Result<GithubResponse, SyncFailure> {
    let mut command = external_command("gh");
    command.args(["api", "--include", "--method", "GET", "--header", "Accept: application/vnd.github+json"]);
    if let Some(etag) = etag {
        command.args(["--header", &format!("If-None-Match: {etag}")]);
    }
    command.args(["--hostname", host]);
    command.arg(endpoint);
    with_github_quota(&github_host_quota(host), || execute_github_request(&mut command, GITHUB_REQUEST_TIMEOUT))
}

fn execute_github_request(command: &mut Command, timeout: Duration) -> Result<GithubResponse, SyncFailure> {
    let output = output_with_timeout(command, timeout)
        .map_err(|error| github_pull_request_failure_message(GithubPullRequestFailure::Spawn(error.kind())))?
        .ok_or_else(|| format!("GitHub CLI did not finish within {} seconds.", timeout.as_secs()))?;
    let response = parse_github_response(&output.stdout);
    // gh counts a 304 as a failed request, though it is the answer the ETag was sent for.
    if !output.status.success() && !response.as_ref().is_some_and(|response| response.status == 304) {
        return Err(SyncFailure {
            message: github_pull_request_failure_message(GithubPullRequestFailure::Exit {
                code: output.status.code(),
                stderr: &output.stderr,
            }),
            rate_limit: response.as_ref().and_then(|response| response.rate_limit),
            retry_at: response
                .filter(|response| matches!(response.status, 403 | 429))
                .and_then(|response| response.retry_after)
                .map(|seconds| SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs().saturating_add(seconds)),
        });
    }
    response.ok_or_else(|| github_pull_request_failure_message(GithubPullRequestFailure::UnreadableResponse).into())
}

fn pulls_endpoint(repository: &str, state: &str, page: usize) -> String {
    format!("repos/{repository}/pulls?state={state}&sort=updated&direction=desc&per_page={PAGE_SIZE}&page={page}")
}

fn parse_pull_requests(body: &[u8]) -> Result<Vec<GithubPullRequest>, String> {
    serde_json::from_slice(body)
        .map_err(|_| github_pull_request_failure_message(GithubPullRequestFailure::UnreadableResponse))
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
    if version < 2 {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        // Clearing the sync record brings the next read forward so the rows already stored gain the new columns.
        transaction
            .execute_batch(
                "
                ALTER TABLE pull_requests ADD COLUMN head_ref TEXT;
                ALTER TABLE pull_requests ADD COLUMN state TEXT;
                ALTER TABLE pull_requests ADD COLUMN title TEXT;
                ALTER TABLE pull_requests ADD COLUMN is_draft INTEGER NOT NULL DEFAULT 0;
                DELETE FROM pull_request_syncs;
                INSERT INTO schema_migrations (version) VALUES (2);
                ",
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    if version < 3 {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction
            .execute_batch(
                "
                ALTER TABLE pull_request_syncs ADD COLUMN etag TEXT;
                INSERT INTO schema_migrations (version) VALUES (3);
                ",
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    if version < 4 {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction
            .execute_batch(
                "
                ALTER TABLE pull_requests ADD COLUMN head_repository TEXT;
                DELETE FROM pull_request_syncs;
                INSERT INTO schema_migrations (version) VALUES (4);
                ",
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    if version < 5 {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction
            .execute_batch(
                "
                ALTER TABLE pull_requests ADD COLUMN head_repository_resolved INTEGER NOT NULL DEFAULT 0;
                UPDATE pull_requests SET head_repository_resolved = 1 WHERE head_repository IS NOT NULL;
                INSERT INTO schema_migrations (version) VALUES (5);
                ",
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn pull_request_database(path: PathBuf) -> Result<Connection, String> {
    let mut connection = Connection::open(path).map_err(|error| error.to_string())?;
    migrate_pull_request_database(&mut connection)?;
    Ok(connection)
}

fn stored_etag(connection: &Connection, host: &str, repository: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT etag FROM pull_request_syncs WHERE host = ?1 AND repository = ?2",
            params![host, repository],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(Option::flatten)
        .map_err(|error| error.to_string())
}

fn has_synchronized(connection: &Connection, host: &str, repository: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM pull_request_syncs WHERE host = ?1 AND repository = ?2)",
            params![host, repository],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

fn newest_stored_update(connection: &Connection, host: &str, repository: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT MAX(updated_at) FROM pull_requests WHERE host = ?1 AND repository = ?2
             AND EXISTS (SELECT 1 FROM pull_request_syncs WHERE host = ?1 AND repository = ?2)",
            params![host, repository],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(|error| error.to_string())
}

fn store_pull_requests(
    connection: &mut Connection,
    host: &str,
    repository: &str,
    pull_requests: &[GithubPullRequest],
    etag: Option<&str>,
) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    for pull_request in pull_requests {
        transaction
            .execute(
                "
                INSERT INTO pull_requests (host, repository, number, head_sha, head_ref, merge_commit_sha, merged_at, state, title, is_draft, updated_at, head_repository, head_repository_resolved)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1)
                ON CONFLICT(host, repository, number) DO UPDATE SET
                  head_sha = excluded.head_sha,
                  head_ref = excluded.head_ref,
                  head_repository = excluded.head_repository,
                  head_repository_resolved = 1,
                  merge_commit_sha = excluded.merge_commit_sha,
                  merged_at = excluded.merged_at,
                  state = excluded.state,
                  title = excluded.title,
                  is_draft = excluded.is_draft,
                  updated_at = excluded.updated_at
                WHERE excluded.updated_at >= pull_requests.updated_at
                ",
                params![
                    host,
                    repository,
                    pull_request.number,
                    pull_request.head.sha,
                    pull_request.head.reference,
                    pull_request.merge_commit_sha,
                    pull_request.merged_at,
                    pull_request.state,
                    pull_request.title,
                    pull_request.draft,
                    pull_request.updated_at,
                    pull_request.head.repo.as_ref().map(|repo| &repo.full_name),
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
            INSERT INTO pull_request_syncs (host, repository, synchronized_at, etag)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(host, repository) DO UPDATE SET
              synchronized_at = excluded.synchronized_at,
              etag = COALESCE(excluded.etag, pull_request_syncs.etag)
            ",
            params![host, repository, synchronized_at, etag],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

/// Brings the stored pull requests of one GitHub repository up to date and reports the quota GitHub
/// answered with.
///
/// The first sync reconciles the newest closed and open pages against the combined list. Later syncs
/// walk pull requests by update time until the stored ones are reached, carrying the newest page's ETag.
pub(crate) fn sync_pull_requests(
    connection: &mut Connection,
    host: &str,
    repository: &str,
) -> Result<Option<RateLimit>, SyncFailure> {
    sync_pull_requests_with(connection, host, repository, github_request)
}

fn sync_pull_requests_with(
    connection: &mut Connection,
    host: &str,
    repository: &str,
    mut request: impl FnMut(&str, &str, Option<&str>) -> Result<GithubResponse, SyncFailure>,
) -> Result<Option<RateLimit>, SyncFailure> {
    let mut rate_limit = None;
    let mut newest = newest_stored_update(connection, host, repository)?;
    let etag = stored_etag(connection, host, repository)?;
    let mut pull_requests = Vec::new();
    if !has_synchronized(connection, host, repository)? {
        let closed = request(host, &pulls_endpoint(repository, "closed", 1), None)?;
        if closed.rate_limit.is_some_and(|limit| limit.remaining < RATE_LIMIT_RESERVE) {
            return Err(SyncFailure {
                message: "GitHub pull request sync paused until the API quota resets.".to_string(),
                rate_limit: closed.rate_limit,
                retry_at: None,
            });
        }
        let open = request(host, &pulls_endpoint(repository, "open", 1), None)?;
        rate_limit = open.rate_limit.or(closed.rate_limit);
        pull_requests = parse_pull_requests(&closed.body)?;
        // A PR can close between these requests, so reconcile from the first snapshot before checkpointing.
        newest = pull_requests.iter().map(|pull_request| &pull_request.updated_at).max().cloned();
        pull_requests.extend(parse_pull_requests(&open.body)?);
    }
    let mut first_page_etag = None;
    for page in 1.. {
        if rate_limit.is_some_and(|limit| limit.remaining < RATE_LIMIT_RESERVE) {
            return Err(SyncFailure {
                message: "GitHub pull request sync paused until the API quota resets.".to_string(),
                rate_limit,
                retry_at: None,
            });
        }
        let response = request(host, &pulls_endpoint(repository, "all", page), etag.as_deref().filter(|_| page == 1))?;
        rate_limit = response.rate_limit.or(rate_limit);
        if response.status == 304 {
            return hydrate_head_repositories(connection, host, repository, rate_limit, &mut request);
        }
        if page == 1 {
            first_page_etag = response.etag;
        }
        let batch = parse_pull_requests(&response.body)?;
        let reached_stored = newest.as_ref().is_some_and(|newest| batch.iter().any(|pull_request| pull_request.updated_at < *newest));
        let is_last_page = batch.len() < PAGE_SIZE;
        pull_requests.extend(batch.into_iter().filter(|pull_request| newest.as_ref().is_none_or(|newest| pull_request.updated_at >= *newest)));
        if reached_stored || is_last_page {
            break;
        }
    }
    store_pull_requests(connection, host, repository, &pull_requests, first_page_etag.as_deref())?;
    hydrate_head_repositories(connection, host, repository, rate_limit, &mut request)
}

fn hydrate_head_repositories(
    connection: &Connection,
    host: &str,
    repository: &str,
    mut rate_limit: Option<RateLimit>,
    request: &mut impl FnMut(&str, &str, Option<&str>) -> Result<GithubResponse, SyncFailure>,
) -> Result<Option<RateLimit>, SyncFailure> {
    let mut statement = connection
        .prepare("SELECT number FROM pull_requests WHERE host = ?1 AND repository = ?2 AND head_repository_resolved = 0 ORDER BY number LIMIT ?3")
        .map_err(|error| error.to_string())?;
    let numbers = statement
        .query_map(params![host, repository, HEAD_REPOSITORY_BATCH_SIZE], |row| row.get::<_, i64>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    for number in numbers {
        if rate_limit.is_some_and(|limit| limit.remaining < RATE_LIMIT_RESERVE) {
            break;
        }
        let response = request(host, &format!("repos/{repository}/pulls/{number}"), None)?;
        rate_limit = response.rate_limit.or(rate_limit);
        let pull_request: GithubPullRequest = serde_json::from_slice(&response.body)
            .map_err(|_| github_pull_request_failure_message(GithubPullRequestFailure::UnreadableResponse))?;
        connection
            .execute(
                "UPDATE pull_requests SET head_repository = ?1, head_ref = ?2, head_repository_resolved = 1
                 WHERE host = ?3 AND repository = ?4 AND number = ?5",
                params![pull_request.head.repo.map(|repo| repo.full_name), pull_request.head.reference, host, repository, number],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(rate_limit)
}

fn pull_request_state(state: &str, is_draft: bool, merged_at: Option<&str>) -> &'static str {
    if merged_at.is_some() {
        "merged"
    } else if state != "open" {
        "closed"
    } else if is_draft {
        "draft"
    } else {
        "open"
    }
}

fn pull_request_rank(state: &str) -> u8 {
    match state {
        "open" | "draft" => 2,
        "merged" => 1,
        _ => 0,
    }
}

pub(crate) type PullRequestRow = (String, i64, String, bool, Option<String>, String);

// A branch name outlives the pull requests raised from it, so the one it is marked with is whichever is still
// open, and failing that the newest one that closed.
fn rank_branch_pull_requests(host: &str, repository: &str, remote: &str, rows: Vec<PullRequestRow>) -> Vec<BranchPullRequest> {
    let mut best: HashMap<String, BranchPullRequest> = HashMap::new();
    for (branch, number, state, is_draft, merged_at, title) in rows {
        let state = pull_request_state(&state, is_draft, merged_at.as_deref());
        if best.get(&branch).is_some_and(|current| {
            (pull_request_rank(&current.state), current.number) > (pull_request_rank(state), number)
        }) {
            continue;
        }
        let url = format!("https://{host}/{repository}/pull/{number}");
        best.insert(branch.clone(), BranchPullRequest {
            branch,
            remote: remote.to_string(),
            host: host.to_string(),
            repository: repository.to_string(),
            number,
            state: state.to_string(),
            title,
            url,
        });
    }
    let mut pull_requests: Vec<_> = best.into_values().collect();
    pull_requests.sort_by(|a, b| a.branch.cmp(&b.branch));
    pull_requests
}

fn pull_requests_by_branch(repo_path: &str, database_path: PathBuf) -> Result<Vec<BranchPullRequest>, String> {
    let remotes = github_remotes(repo_path);
    if remotes.is_empty() {
        return Err("Only GitHub remotes are supported.".to_string());
    }
    let connection = pull_request_database(database_path)?;
    let mut statement = connection
        .prepare(
            "
            SELECT head_ref, number, state, is_draft, merged_at, title, head_repository
            FROM pull_requests
            WHERE host = ?1 AND repository = ?2 AND head_ref IS NOT NULL
            ",
        )
        .map_err(|error| error.to_string())?;
    let mut seen = HashSet::new();
    let mut pull_requests = Vec::new();
    for (_, GithubRepository { host, repository }) in &remotes {
        if !seen.insert((host, repository)) {
            continue;
        }
        let rows = statement
            .query_map(params![host, repository], |row| {
                Ok((row.get::<_, Option<String>>(6)?, (
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    row.get::<_, bool>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                )))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        for (remote, head_repository) in &remotes {
            let matching_rows = rows.iter().filter_map(|(head, row)| {
                (head_repository.host.eq_ignore_ascii_case(host)
                    && head.as_deref().is_some_and(|head| head_repository.repository.eq_ignore_ascii_case(head)))
                    .then(|| row.clone())
            }).collect();
            pull_requests.extend(rank_branch_pull_requests(host, repository, remote, matching_rows));
        }
    }
    Ok(pull_requests)
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn branch_pull_requests(repo_path: String) -> Result<Vec<BranchPullRequest>, String> {
    let database_path = pull_request_database_path()?;
    tauri::async_runtime::spawn_blocking(move || pull_requests_by_branch(&repo_path, database_path))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn github_pull_request_failures_explain_missing_cli() {
        assert_eq!(
            github_pull_request_failure_message(GithubPullRequestFailure::Spawn(ErrorKind::NotFound)),
            "GitHub CLI was not found; install it to enable pull request information."
        );
    }

    #[test]
    fn github_pull_request_failures_explain_sign_in() {
        assert_eq!(
            github_pull_request_failure_message(GithubPullRequestFailure::Exit {
                code: Some(4),
                stderr: b"To get started with GitHub CLI, please run: gh auth login\n",
            }),
            "GitHub CLI is not signed in; run gh auth login."
        );
    }

    #[test]
    fn github_pull_request_failures_include_credentials_error() {
        assert_eq!(
            github_pull_request_failure_message(GithubPullRequestFailure::Exit {
                code: Some(1),
                stderr: b"gh: Bad credentials (HTTP 401)\n",
            }),
            "Bad credentials (HTTP 401)"
        );
    }

    #[test]
    fn github_pull_request_failures_include_repository_access_error() {
        assert_eq!(
            github_pull_request_failure_message(GithubPullRequestFailure::Exit {
                code: Some(1),
                stderr: b"gh: Not Found (HTTP 404)\n",
            }),
            "Not Found (HTTP 404)"
        );
    }

    #[test]
    fn github_pull_request_failures_fall_back_when_stderr_is_empty() {
        assert_eq!(
            github_pull_request_failure_message(GithubPullRequestFailure::Exit { code: Some(1), stderr: b"" }),
            "Could not load pull requests from GitHub."
        );
    }

    #[test]
    fn github_pull_request_failures_include_connectivity_host() {
        assert_eq!(
            github_pull_request_failure_message(GithubPullRequestFailure::Exit {
                code: Some(1),
                stderr: b"error connecting to does-not-resolve.invalid\ncheck your internet connection or https://githubstatus.com\n",
            }),
            "error connecting to does-not-resolve.invalid"
        );
    }

    #[test]
    fn github_pull_request_failures_explain_unreadable_responses() {
        assert_eq!(
            github_pull_request_failure_message(GithubPullRequestFailure::UnreadableResponse),
            "Could not read the pull request response from GitHub."
        );
    }

    #[test]
    fn migrates_pull_request_database() {
        let mut connection = Connection::open_in_memory().unwrap();

        migrate_pull_request_database(&mut connection).unwrap();

        let version = connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get::<_, i64>(0))
            .unwrap();
        assert_eq!(version, 5);
        connection
            .execute(
                "INSERT INTO pull_requests (host, repository, number, head_sha, head_ref, state, title, is_draft, updated_at) VALUES ('github.com', 'octocat/hello-world', 1, 'abc', 'feature', 'open', 'A title', 0, '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO pull_request_syncs (host, repository, synchronized_at, etag) VALUES ('github.com', 'octocat/hello-world', 1, 'W/\"abc\"')",
                [],
            )
            .unwrap();
        assert_eq!(stored_etag(&connection, "github.com", "octocat/hello-world").unwrap().as_deref(), Some("W/\"abc\""));
        assert_eq!(
            newest_stored_update(&connection, "github.com", "octocat/hello-world").unwrap().as_deref(),
            Some("2026-01-01T00:00:00Z")
        );
        assert_eq!(newest_stored_update(&connection, "github.com", "octocat/other").unwrap(), None);
    }

    #[test]
    fn invalidates_old_sync_checkpoints_to_reload_head_repositories() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate_pull_request_database(&mut connection).unwrap();
        connection.execute_batch(
            "ALTER TABLE pull_requests DROP COLUMN head_repository;
             ALTER TABLE pull_requests DROP COLUMN head_repository_resolved;
             DELETE FROM schema_migrations WHERE version >= 4;
             INSERT INTO pull_requests (host, repository, number, head_sha, head_ref, state, title, updated_at)
             VALUES ('github.com', 'upstream/repo', 1, 'a', 'feature', 'open', 'First', '2026-01-01T00:00:00Z');
             INSERT INTO pull_request_syncs (host, repository, synchronized_at, etag)
             VALUES ('github.com', 'upstream/repo', 1, 'old');"
        ).unwrap();

        migrate_pull_request_database(&mut connection).unwrap();

        assert_eq!(stored_etag(&connection, "github.com", "upstream/repo").unwrap(), None);
        assert_eq!(newest_stored_update(&connection, "github.com", "upstream/repo").unwrap(), None);
        sync_pull_requests_with(&mut connection, "github.com", "upstream/repo", |_, endpoint, etag| {
            assert_eq!(etag, None);
            let body = if endpoint.contains("state=open") {
                serde_json::to_vec(&serde_json::json!([
                    {"number":1,"title":"First","state":"open","draft":false,"updated_at":"2026-01-01T00:00:00Z","head":{"ref":"feature","sha":"a","repo":{"full_name":"first/repo"}}}
                ])).unwrap()
            } else {
                b"[]".to_vec()
            };
            Ok(GithubResponse { status: 200, etag: None, rate_limit: None, retry_after: None, body })
        }).unwrap();

        assert_eq!(connection.query_row("SELECT head_repository FROM pull_requests", [], |row| row.get::<_, String>(0)).unwrap(), "first/repo");
    }

    #[test]
    fn empty_repositories_advance_to_conditional_requests() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate_pull_request_database(&mut connection).unwrap();
        let mut bootstrap_calls = Vec::new();
        sync_pull_requests_with(&mut connection, "github.com", "owner/empty", |_, endpoint, etag| {
            bootstrap_calls.push(endpoint.to_string());
            assert_eq!(etag, None);
            let etag = if endpoint.contains("state=all") { "all-empty" } else { "state-specific" };
            Ok(GithubResponse { status: 200, etag: Some(etag.to_string()), rate_limit: None, retry_after: None, body: b"[]".to_vec() })
        }).unwrap();
        assert_eq!(bootstrap_calls, vec![
            pulls_endpoint("owner/empty", "closed", 1),
            pulls_endpoint("owner/empty", "open", 1),
            pulls_endpoint("owner/empty", "all", 1),
        ]);
        assert_eq!(newest_stored_update(&connection, "github.com", "owner/empty").unwrap(), None);
        assert!(has_synchronized(&connection, "github.com", "owner/empty").unwrap());

        let mut incremental_calls = 0;
        sync_pull_requests_with(&mut connection, "github.com", "owner/empty", |_, endpoint, etag| {
            incremental_calls += 1;
            assert_eq!(endpoint, pulls_endpoint("owner/empty", "all", 1));
            assert_eq!(etag, Some("all-empty"));
            Ok(GithubResponse { status: 200, etag: Some("all-empty".to_string()), rate_limit: None, retry_after: None, body: b"[]".to_vec() })
        }).unwrap();
        assert_eq!(incremental_calls, 1);

        let mut conditional_calls = 0;
        sync_pull_requests_with(&mut connection, "github.com", "owner/empty", |_, endpoint, etag| {
            conditional_calls += 1;
            assert_eq!(endpoint, pulls_endpoint("owner/empty", "all", 1));
            assert_eq!(etag, Some("all-empty"));
            Ok(GithubResponse { status: 304, etag: None, rate_limit: None, retry_after: None, body: Vec::new() })
        }).unwrap();
        assert_eq!(conditional_calls, 1);
    }

    #[test]
    fn bootstrap_reconciles_pull_requests_that_close_between_state_snapshots() {
        for closed_was_empty in [false, true] {
            let mut connection = Connection::open_in_memory().unwrap();
            migrate_pull_request_database(&mut connection).unwrap();
            let pull = |number, state, updated_at| serde_json::json!({
                "number":number,"title":"Pull request","state":state,"draft":false,"updated_at":updated_at,
                "head":{"ref":format!("feature-{number}"),"sha":"head","repo":{"full_name":"owner/repo"}}
            });
            let closed = pull(1, "closed", "2026-01-01T00:00:00Z");
            let missed = pull(2, "closed", "2026-01-02T00:00:00Z");
            let newer: Vec<_> = (3..3 + PAGE_SIZE).map(|number| pull(number, "open", "2026-01-03T00:00:00Z")).collect();
            for fail_last_page in [true, false] {
                let mut calls = 0;
                let result = sync_pull_requests_with(&mut connection, "github.com", "owner/repo", |_, endpoint, etag| {
                    calls += 1;
                    assert_eq!(etag, None);
                    let body = match calls {
                        1 => {
                            assert_eq!(endpoint, pulls_endpoint("owner/repo", "closed", 1));
                            if closed_was_empty { Vec::new() } else { vec![closed.clone()] }
                        }
                        2 => {
                            assert_eq!(endpoint, pulls_endpoint("owner/repo", "open", 1));
                            newer.clone()
                        }
                        3 => {
                            assert_eq!(endpoint, pulls_endpoint("owner/repo", "all", 1));
                            newer.clone()
                        }
                        4 => {
                            assert_eq!(endpoint, pulls_endpoint("owner/repo", "all", 2));
                            if fail_last_page {
                                return Err("offline".to_string().into());
                            }
                            vec![missed.clone(), closed.clone()]
                        }
                        _ => panic!("unexpected request: {endpoint}"),
                    };
                    Ok(GithubResponse {
                        status: 200, etag: Some(format!("response-{calls}")), rate_limit: None, retry_after: None,
                        body: serde_json::to_vec(&body).unwrap(),
                    })
                });
                assert_eq!(calls, 4);
                assert_eq!(result.is_err(), fail_last_page);
                assert_eq!(has_synchronized(&connection, "github.com", "owner/repo").unwrap(), !fail_last_page);
                if fail_last_page {
                    assert_eq!(stored_etag(&connection, "github.com", "owner/repo").unwrap(), None);
                    assert_eq!(connection.query_row("SELECT COUNT(*) FROM pull_requests", [], |row| row.get::<_, usize>(0)).unwrap(), 0);
                } else {
                    assert_eq!(stored_etag(&connection, "github.com", "owner/repo").unwrap().as_deref(), Some("response-3"));
                    assert_eq!(newest_stored_update(&connection, "github.com", "owner/repo").unwrap().as_deref(), Some("2026-01-03T00:00:00Z"));
                    assert_eq!(connection.query_row("SELECT state FROM pull_requests WHERE number = 2", [], |row| row.get::<_, String>(0)).unwrap(), "closed");
                }
            }
        }
    }

    #[test]
    fn hydrates_historical_heads_beyond_the_bootstrap_pages_and_remembers_deleted_forks() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate_pull_request_database(&mut connection).unwrap();
        connection.execute_batch(
            "ALTER TABLE pull_requests DROP COLUMN head_repository;
             ALTER TABLE pull_requests DROP COLUMN head_repository_resolved;
             DELETE FROM schema_migrations WHERE version >= 4;
             INSERT INTO pull_requests (host, repository, number, head_sha, head_ref, state, title, updated_at)
             VALUES ('github.com', 'upstream/repo', 1, 'a', NULL, 'open', 'Legacy', '2025-01-01T00:00:00Z'),
                    ('github.com', 'upstream/repo', 2, 'b', 'deleted', 'closed', 'Deleted fork', '2025-01-01T00:00:00Z');
             INSERT INTO pull_request_syncs (host, repository, synchronized_at, etag)
             VALUES ('github.com', 'upstream/repo', 1, 'old');"
        ).unwrap();
        migrate_pull_request_database(&mut connection).unwrap();
        let mut requests = Vec::new();
        sync_pull_requests_with(&mut connection, "github.com", "upstream/repo", |_, endpoint, etag| {
            requests.push(endpoint.to_string());
            assert_eq!(etag, None);
            let body = if endpoint == "repos/upstream/repo/pulls/1" {
                serde_json::json!({"number":1,"title":"Legacy","state":"open","draft":false,"updated_at":"2025-01-01T00:00:00Z","head":{"ref":"feature","sha":"a","repo":{"full_name":"fork/repo"}}})
            } else if endpoint == "repos/upstream/repo/pulls/2" {
                serde_json::json!({"number":2,"title":"Deleted fork","state":"closed","draft":false,"updated_at":"2025-01-01T00:00:00Z","head":{"ref":"deleted","sha":"b","repo":null}})
            } else if endpoint.ends_with("&page=2") {
                serde_json::json!([])
            } else {
                let state = if endpoint.contains("state=open") { "open" } else { "closed" };
                let start = if state == "open" { 100 } else { 200 };
                serde_json::Value::Array((start..start + PAGE_SIZE).map(|number| serde_json::json!({
                    "number":number,"title":"Recent","state":state,"draft":false,"updated_at":"2026-01-01T00:00:00Z",
                    "head":{"ref":format!("feature-{number}"),"sha":"recent","repo":{"full_name":"upstream/repo"}}
                })).collect())
            };
            Ok(GithubResponse { status: 200, etag: None, rate_limit: None, retry_after: None, body: serde_json::to_vec(&body).unwrap() })
        }).unwrap();
        assert_eq!(requests, vec![
            pulls_endpoint("upstream/repo", "closed", 1),
            pulls_endpoint("upstream/repo", "open", 1),
            pulls_endpoint("upstream/repo", "all", 1),
            pulls_endpoint("upstream/repo", "all", 2),
            "repos/upstream/repo/pulls/1".to_string(),
            "repos/upstream/repo/pulls/2".to_string(),
        ]);
        assert_eq!(connection.query_row("SELECT head_repository FROM pull_requests WHERE number = 1", [], |row| row.get::<_, String>(0)).unwrap(), "fork/repo");
        assert_eq!(connection.query_row("SELECT head_ref FROM pull_requests WHERE number = 1", [], |row| row.get::<_, String>(0)).unwrap(), "feature");
        assert_eq!(connection.query_row("SELECT head_repository, head_repository_resolved FROM pull_requests WHERE number = 2", [], |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, bool>(1)?))).unwrap(), (None, true));
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM pull_requests WHERE head_repository_resolved = 0", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        let mut subsequent_calls = 0;
        sync_pull_requests_with(&mut connection, "github.com", "upstream/repo", |_, endpoint, _| {
            subsequent_calls += 1;
            assert_eq!(endpoint, pulls_endpoint("upstream/repo", "all", 1));
            Ok(GithubResponse { status: 200, etag: None, rate_limit: None, retry_after: None, body: b"[]".to_vec() })
        }).unwrap();
        assert_eq!(subsequent_calls, 1);
    }

    #[test]
    fn bounds_legacy_hydration_and_resumes_after_quota_holds_and_unchanged_lists() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate_pull_request_database(&mut connection).unwrap();
        for number in 1..=HEAD_REPOSITORY_BATCH_SIZE + 4 {
            connection.execute(
                "INSERT INTO pull_requests (host, repository, number, head_sha, updated_at)
                 VALUES ('github.com', 'upstream/repo', ?1, 'legacy', '2025-01-01T00:00:00Z')",
                [number],
            ).unwrap();
        }

        for (run, expected_details, expected_unresolved) in [(0, 10, 4), (1, 1, 3), (2, 3, 0)] {
            let mut lists = 0;
            let mut details = Vec::new();
            let result = sync_pull_requests_with(&mut connection, "github.com", "upstream/repo", |_, endpoint, etag| {
                if endpoint.contains('?') {
                    lists += 1;
                    assert_eq!(etag, (run > 0).then_some("unchanged"));
                    return Ok(GithubResponse {
                        status: if run == 2 { 304 } else { 200 },
                        etag: Some("unchanged".to_string()),
                        rate_limit: (run > 0).then_some(RateLimit { remaining: if run == 1 { 100 } else { 500 }, reset: 900 }),
                        retry_after: None,
                        body: b"[]".to_vec(),
                    });
                }
                let number = endpoint.rsplit('/').next().unwrap().parse::<usize>().unwrap();
                details.push(number);
                Ok(GithubResponse {
                    status: 200,
                    etag: None,
                    rate_limit: (run > 0).then_some(RateLimit { remaining: if run == 1 { 99 } else { 499 }, reset: 900 }),
                    retry_after: None,
                    body: serde_json::to_vec(&serde_json::json!({
                        "number":number,"title":"Legacy","state":"closed","draft":false,"updated_at":"2025-01-01T00:00:00Z",
                        "head":{"ref":format!("feature-{number}"),"sha":"legacy","repo":{"full_name":"fork/repo"}}
                    })).unwrap(),
                })
            }).unwrap();

            assert_eq!(lists, if run == 0 { 3 } else { 1 });
            assert_eq!(details.len(), expected_details);
            assert_eq!(details[0], [1, 11, 12][run]);
            assert_eq!(connection.query_row("SELECT COUNT(*) FROM pull_requests WHERE head_repository_resolved = 0", [], |row| row.get::<_, usize>(0)).unwrap(), expected_unresolved);
            if run == 1 {
                assert_eq!(result, Some(RateLimit { remaining: 99, reset: 900 }));
            }
        }
    }

    #[test]
    fn bootstrap_stops_at_the_quota_reserve_before_another_list_or_legacy_detail() {
        for low_quota_response in [1, 2, 3] {
            let mut connection = Connection::open_in_memory().unwrap();
            migrate_pull_request_database(&mut connection).unwrap();
            connection.execute_batch(
                "INSERT INTO pull_requests (host, repository, number, head_sha, updated_at)
                 VALUES ('github.com', 'upstream/repo', 1, 'legacy', '2025-01-01T00:00:00Z');"
            ).unwrap();
            let mut requests = 0;
            let result = sync_pull_requests_with(&mut connection, "github.com", "upstream/repo", |_, endpoint, _| {
                requests += 1;
                assert!(requests <= low_quota_response);
                assert!(endpoint.contains('?'));
                Ok(GithubResponse {
                    status: 200,
                    etag: None,
                    rate_limit: Some(RateLimit { remaining: if requests == low_quota_response { 99 } else { 100 }, reset: 900 }),
                    retry_after: None,
                    body: b"[]".to_vec(),
                })
            });
            assert_eq!(requests, low_quota_response);
            assert_eq!(has_synchronized(&connection, "github.com", "upstream/repo").unwrap(), low_quota_response == 3);
            assert_eq!(connection.query_row("SELECT head_repository_resolved FROM pull_requests", [], |row| row.get::<_, bool>(0)).unwrap(), false);
            let limit = match result {
                Ok(limit) => limit,
                Err(failure) => failure.rate_limit,
            };
            assert_eq!(limit, Some(RateLimit { remaining: 99, reset: 900 }));
        }
    }

    #[test]
    fn quota_holds_do_not_advance_a_partially_read_incremental_checkpoint() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate_pull_request_database(&mut connection).unwrap();
        store_pull_requests(&mut connection, "github.com", "upstream/repo", &[], Some("old")).unwrap();
        let mut requests = 0;
        let result = sync_pull_requests_with(&mut connection, "github.com", "upstream/repo", |_, _, etag| {
            requests += 1;
            assert_eq!(requests, 1);
            assert_eq!(etag, Some("old"));
            let body: Vec<_> = (1..=PAGE_SIZE).map(|number| serde_json::json!({
                "number":number,"title":"Changed","state":"closed","draft":false,"updated_at":"2026-01-01T00:00:00Z",
                "head":{"ref":format!("feature-{number}"),"sha":"changed","repo":{"full_name":"upstream/repo"}}
            })).collect();
            Ok(GithubResponse {
                status: 200,
                etag: Some("new".to_string()),
                rate_limit: Some(RateLimit { remaining: 99, reset: 900 }),
                retry_after: None,
                body: serde_json::to_vec(&body).unwrap(),
            })
        });
        assert_eq!(result.unwrap_err().rate_limit, Some(RateLimit { remaining: 99, reset: 900 }));
        assert_eq!(stored_etag(&connection, "github.com", "upstream/repo").unwrap().as_deref(), Some("old"));
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM pull_requests", [], |row| row.get::<_, usize>(0)).unwrap(), 0);
    }

    #[test]
    fn preserves_github_remote_aliases_with_origin_first() {
        let remotes = concat!(
            "upstream\thttps://github.com/octocat/hello-world.git (fetch)\n",
            "upstream\thttps://github.com/octocat/hello-world.git (push)\n",
            "mirror\tgit@gitlab.com:octocat/hello-world.git (fetch)\n",
            "origin\tgit@github.com:someone/hello-world.git (fetch)\n",
            "origin\tgit@github.com:someone/hello-world.git (push)\n",
            "backup\tssh://git@github.com/someone/hello-world.git (fetch)\n",
        );

        let repositories = parse_github_remotes(remotes, |_| false);

        assert_eq!(
            repositories,
            vec![
                ("origin".to_string(), GithubRepository { host: "github.com".to_string(), repository: "someone/hello-world".to_string() }),
                ("upstream".to_string(), GithubRepository { host: "github.com".to_string(), repository: "octocat/hello-world".to_string() }),
                ("backup".to_string(), GithubRepository { host: "github.com".to_string(), repository: "someone/hello-world".to_string() }),
            ]
        );
    }

    #[test]
    fn includes_configured_enterprise_hosts_and_checks_each_host_once() {
        let remotes = concat!(
            "origin\tgit@github.com:someone/hello-world.git (fetch)\n",
            "upstream\tgit@code.example.com:octocat/hello-world.git (fetch)\n",
            "backup\thttps://code.example.com/octocat/hello-world.git (fetch)\n",
            "mirror\thttps://gitlab.com/octocat/hello-world.git (fetch)\n",
        );
        let mut checked_hosts = Vec::new();

        let repositories = parse_github_remotes(remotes, |host| {
            checked_hosts.push(host.to_string());
            host == "code.example.com"
        });

        assert_eq!(checked_hosts, vec!["code.example.com", "gitlab.com"]);
        assert_eq!(repositories, vec![
            ("origin".to_string(), GithubRepository { host: "github.com".to_string(), repository: "someone/hello-world".to_string() }),
            ("upstream".to_string(), GithubRepository { host: "code.example.com".to_string(), repository: "octocat/hello-world".to_string() }),
            ("backup".to_string(), GithubRepository { host: "code.example.com".to_string(), repository: "octocat/hello-world".to_string() }),
        ]);
    }

    #[test]
    fn excludes_unconfigured_forges_even_for_origin_or_github_named_hosts() {
        let remotes = concat!(
            "origin\thttps://gitlab.com/octocat/hello-world.git (fetch)\n",
            "mirror\thttps://notgithub.example.com/octocat/hello-world.git (fetch)\n",
            "backup\thttps://github.com.example.com/octocat/hello-world.git (fetch)\n",
            "enterprise\thttps://company.ghe.com/octocat/hello-world.git (fetch)\n",
        );

        assert_eq!(parse_github_remotes(remotes, |_| false), vec![
            ("enterprise".to_string(), GithubRepository { host: "company.ghe.com".to_string(), repository: "octocat/hello-world".to_string() }),
        ]);
    }

    #[test]
    fn reads_the_status_etag_and_quota_ahead_of_the_body() {
        let output = concat!(
            "HTTP/2.0 200 OK\n",
            "Content-Type: application/json; charset=utf-8\n",
            "Etag: W/\"abc\"\n",
            "X-Ratelimit-Remaining: 4737\n",
            "X-Ratelimit-Reset: 1789936728\n",
            "\n",
            "[{\"number\":1}]",
        );

        let response = parse_github_response(output.as_bytes()).unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.etag.as_deref(), Some("W/\"abc\""));
        assert_eq!(response.rate_limit, Some(RateLimit { remaining: 4737, reset: 1789936728 }));
        assert_eq!(response.body, b"[{\"number\":1}]");
    }

    #[test]
    fn repositories_on_the_same_host_share_quota_holds() {
        use std::{sync::{Barrier, atomic::{AtomicUsize, Ordering}}, thread};

        let host = "shared-quota-test.github.com";
        let quota = github_host_quota(host);
        assert!(Arc::ptr_eq(&quota, &github_host_quota("SHARED-QUOTA-TEST.GITHUB.COM")));
        assert!(!Arc::ptr_eq(&quota, &github_host_quota("other-quota-test.github.com")));
        let started = Arc::new(Barrier::new(2));
        let requests = Arc::new(AtomicUsize::new(0));
        let reset = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() + 600;
        let handles = (0..2).map(|_| {
            let quota = github_host_quota(host);
            let started = started.clone();
            let requests = requests.clone();
            thread::spawn(move || {
                started.wait();
                with_github_quota(&quota, || {
                    requests.fetch_add(1, Ordering::SeqCst);
                    Ok(GithubResponse {
                        status: 200,
                        etag: None,
                        rate_limit: Some(RateLimit { remaining: 99, reset }),
                        retry_after: None,
                        body: b"[]".to_vec(),
                    })
                })
            })
        }).collect::<Vec<_>>();
        let results = handles.into_iter().map(|handle| handle.join().unwrap()).collect::<Vec<_>>();

        assert_eq!(requests.load(Ordering::SeqCst), 1);
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.into_iter().find_map(Result::err).unwrap().rate_limit, Some(RateLimit { remaining: 99, reset }));
    }

    #[test]
    fn an_expired_host_quota_allows_requests_again() {
        let quota = Mutex::new(GithubQuota { rate_limit: Some(RateLimit { remaining: 0, reset: 1 }), retry_at: Some(1) });
        let response = with_github_quota(&quota, || Ok(GithubResponse {
            status: 200,
            etag: None,
            rate_limit: Some(RateLimit { remaining: 5000, reset: u64::MAX }),
            retry_after: None,
            body: b"[]".to_vec(),
        })).unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(quota.lock().unwrap().rate_limit.unwrap().remaining, 5000);
    }

    #[test]
    #[cfg(unix)]
    fn secondary_limits_hold_peer_requests_for_retry_after() {
        for status in [403, 429] {
            let quota = Mutex::new(GithubQuota::default());
            let mut command = Command::new("sh");
            let headers = format!("HTTP/2.0 {status} Rate Limited\nX-RateLimit-Remaining: 4500\nX-RateLimit-Reset: 900\nRetry-After: 3600\n\n{{}}");
            command.args(["-c", "printf '%s' \"$1\"; exit 1", "gh", &headers]);
            let before = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
            let failure = with_github_quota(&quota, || execute_github_request(&mut command, Duration::from_secs(5))).unwrap_err();
            let after = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();

            assert_eq!(failure.rate_limit.unwrap().remaining, 4500);
            assert!((before + 3600..=after + 3600).contains(&failure.retry_at.unwrap()));
            let peer = with_github_quota(&quota, || panic!("request during secondary limit hold")).unwrap_err();
            assert_eq!(peer.retry_at, failure.retry_at);
        }
    }

    #[test]
    #[cfg(unix)]
    fn a_hung_github_request_times_out_and_releases_the_host_gate() {
        let quota = Mutex::new(GithubQuota::default());
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 5"]);
        let started = std::time::Instant::now();
        let failure = with_github_quota(&quota, || execute_github_request(&mut command, Duration::from_millis(100))).unwrap_err();

        assert!(failure.message.contains("did not finish"));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(quota.try_lock().is_ok());
        let response = with_github_quota(&quota, || Ok(GithubResponse {
            status: 304,
            etag: None,
            rate_limit: None,
            retry_after: None,
            body: Vec::new(),
        })).unwrap();
        assert_eq!(response.status, 304);
    }

    #[test]
    fn reads_headers_that_end_in_crlf() {
        let output = b"HTTP/2.0 200 OK\nEtag: W/\"abc\"\r\nX-Ratelimit-Remaining: 7\r\nX-Ratelimit-Reset: 9\r\n\r\n[]";

        let response = parse_github_response(output).unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.etag.as_deref(), Some("W/\"abc\""));
        assert_eq!(response.rate_limit, Some(RateLimit { remaining: 7, reset: 9 }));
        assert_eq!(response.body, b"[]");
    }

    #[test]
    fn reads_an_unchanged_answer_without_a_body() {
        let output = "HTTP/2.0 304 Not Modified\nX-Ratelimit-Remaining: 10\nX-Ratelimit-Reset: 5\n\n";

        let response = parse_github_response(output.as_bytes()).unwrap();

        assert_eq!(response.status, 304);
        assert!(response.body.is_empty());
        assert_eq!(response.rate_limit, Some(RateLimit { remaining: 10, reset: 5 }));
    }

    #[test]
    fn reads_the_answer_behind_a_redirect() {
        let output = "HTTP/2.0 301 Moved Permanently\nLocation: elsewhere\n\nHTTP/2.0 200 OK\nEtag: \"final\"\n\n[]";

        let response = parse_github_response(output.as_bytes()).unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.etag.as_deref(), Some("\"final\""));
        assert_eq!(response.body, b"[]");
    }

    #[test]
    fn rejects_output_without_a_header_block() {
        assert!(parse_github_response(b"[]").is_none());
        assert!(parse_github_response(b"garbage\n\n[]").is_none());
    }

    #[test]
    fn stores_unmodified_head_branches_and_repositories() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate_pull_request_database(&mut connection).unwrap();
        let payload = r#"[
            {"number":1,"title":"Own","state":"open","draft":false,"merged_at":null,"merge_commit_sha":null,"updated_at":"2026-01-01T00:00:00Z","head":{"ref":"own","sha":"a","repo":{"full_name":"octocat/hello-world"}}},
            {"number":2,"title":"Fork","state":"open","draft":false,"merged_at":null,"merge_commit_sha":null,"updated_at":"2026-01-02T00:00:00Z","head":{"ref":"fork","sha":"b","repo":{"full_name":"someone/hello-world"}}},
            {"number":3,"title":"Stranger","state":"open","draft":false,"merged_at":null,"merge_commit_sha":null,"updated_at":"2026-01-03T00:00:00Z","head":{"ref":"patch-1","sha":"c","repo":{"full_name":"stranger/hello-world"}}}
        ]"#;
        let pull_requests: Vec<GithubPullRequest> = serde_json::from_str(payload).unwrap();
        store_pull_requests(&mut connection, "github.com", "octocat/hello-world", &pull_requests, Some("W/\"1\"")).unwrap();

        let mut statement = connection.prepare("SELECT number, head_ref, head_repository FROM pull_requests ORDER BY number").unwrap();
        let rows: Vec<(i64, String, String)> = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(rows, vec![
            (1, "own".to_string(), "octocat/hello-world".to_string()),
            (2, "fork".to_string(), "someone/hello-world".to_string()),
            (3, "patch-1".to_string(), "stranger/hello-world".to_string()),
        ]);
        assert_eq!(stored_etag(&connection, "github.com", "octocat/hello-world").unwrap().as_deref(), Some("W/\"1\""));
        assert_eq!(newest_stored_update(&connection, "github.com", "octocat/hello-world").unwrap().as_deref(), Some("2026-01-03T00:00:00Z"));
    }

    #[test]
    fn keeps_a_stored_etag_when_a_sync_brings_none() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate_pull_request_database(&mut connection).unwrap();

        store_pull_requests(&mut connection, "github.com", "octocat/hello-world", &[], Some("W/\"1\"")).unwrap();
        store_pull_requests(&mut connection, "github.com", "octocat/hello-world", &[], None).unwrap();

        assert_eq!(stored_etag(&connection, "github.com", "octocat/hello-world").unwrap().as_deref(), Some("W/\"1\""));
    }

    #[test]
    fn scopes_shared_cache_reads_to_each_clones_remotes() {
        use crate::test_support::{remove_scratch_repository, scratch_repository};

        let (first, run_first) = scratch_repository("pr-first-fork");
        let (second, run_second) = scratch_repository("pr-second-fork");
        run_first(&["remote", "add", "origin", "https://github.com/first/repo.git"]);
        run_second(&["remote", "add", "origin", "https://github.com/second/repo.git"]);
        run_first(&["remote", "add", "upstream", "https://github.com/upstream/repo.git"]);
        run_second(&["remote", "add", "upstream", "https://github.com/upstream/repo.git"]);
        let database_path = PathBuf::from(&first).join("pull-requests.sqlite");
        let mut connection = pull_request_database(database_path.clone()).unwrap();
        let pulls = serde_json::from_value::<Vec<GithubPullRequest>>(serde_json::json!([
            {"number":1,"title":"First","state":"open","draft":false,"updated_at":"2026-01-01T00:00:00Z","head":{"ref":"feature","sha":"a","repo":{"full_name":"first/repo"}}},
            {"number":2,"title":"Second","state":"open","draft":false,"updated_at":"2026-01-01T00:00:00Z","head":{"ref":"feature","sha":"b","repo":{"full_name":"second/repo"}}},
            {"number":3,"title":"Deleted fork","state":"open","draft":false,"updated_at":"2026-01-01T00:00:00Z","head":{"ref":"feature","sha":"c","repo":null}}
        ])).unwrap();
        store_pull_requests(&mut connection, "github.com", "upstream/repo", &pulls, None).unwrap();
        connection.execute(
            "INSERT INTO pull_requests (host, repository, number, head_sha, head_ref, state, title, updated_at)
             VALUES ('github.com', 'upstream/repo', 4, 'd', 'feature', 'open', 'Unknown legacy fork', '2026-01-01T00:00:00Z')",
            [],
        ).unwrap();
        drop(connection);

        let first_pulls = pull_requests_by_branch(&first, database_path.clone()).unwrap();
        let second_pulls = pull_requests_by_branch(&second, database_path.clone()).unwrap();
        assert_eq!(first_pulls.len(), 1);
        assert_eq!(first_pulls[0].number, 1);
        assert_eq!(second_pulls.len(), 1);
        assert_eq!(second_pulls[0].number, 2);

        run_first(&["remote", "set-url", "origin", "https://github.com/second/repo.git"]);
        assert_eq!(pull_requests_by_branch(&first, database_path.clone()).unwrap(), second_pulls);
        run_first(&["remote", "set-url", "origin", "https://github.enterprise/first/repo.git"]);
        assert!(pull_requests_by_branch(&first, database_path).unwrap().is_empty());
        remove_scratch_repository(&first);
        remove_scratch_repository(&second);
    }

    #[test]
    fn stores_the_entire_incremental_delta_before_advancing_the_checkpoint() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate_pull_request_database(&mut connection).unwrap();
        let seed = serde_json::from_value::<Vec<GithubPullRequest>>(serde_json::json!([
            {"number":0,"title":"Existing","state":"open","draft":false,"updated_at":"2026-01-01T00:00:00Z","head":{"ref":"feature","sha":"a","repo":{"full_name":"upstream/repo"}}}
        ])).unwrap();
        store_pull_requests(&mut connection, "github.com", "upstream/repo", &seed, Some("old")).unwrap();
        let changed: Vec<_> = (1..=650).map(|number| serde_json::json!({
            "number":number,"title":"Changed","state":"closed","draft":false,"updated_at":"2026-02-01T00:00:00Z",
            "head":{"ref":format!("feature-{number}"),"sha":number.to_string(),"repo":{"full_name":"upstream/repo"}}
        })).collect();

        for fail in [true, false] {
            let mut pages = 0;
            let result = sync_pull_requests_with(&mut connection, "github.com", "upstream/repo", |_, endpoint, etag| {
                pages += 1;
                assert_eq!(endpoint, pulls_endpoint("upstream/repo", "all", pages));
                assert_eq!(etag, (pages == 1).then_some("old"));
                if fail && pages == 6 {
                    return Err("offline".to_string().into());
                }
                let start = (pages - 1) * PAGE_SIZE;
                let end = (start + PAGE_SIZE).min(changed.len());
                Ok(GithubResponse {
                    status: 200,
                    etag: Some(format!("page-{pages}")),
                    rate_limit: None,
                    retry_after: None,
                    body: serde_json::to_vec(&changed[start..end]).unwrap(),
                })
            });
            let count = connection.query_row("SELECT COUNT(*) FROM pull_requests", [], |row| row.get::<_, i64>(0)).unwrap();
            if fail {
                assert!(result.is_err());
                assert_eq!(pages, 6);
                assert_eq!(count, 1);
                assert_eq!(stored_etag(&connection, "github.com", "upstream/repo").unwrap().as_deref(), Some("old"));
                assert_eq!(newest_stored_update(&connection, "github.com", "upstream/repo").unwrap().as_deref(), Some("2026-01-01T00:00:00Z"));
            } else {
                assert!(result.is_ok());
                assert_eq!(pages, 7);
                assert_eq!(count, 651);
                assert_eq!(stored_etag(&connection, "github.com", "upstream/repo").unwrap().as_deref(), Some("page-1"));
                assert_eq!(newest_stored_update(&connection, "github.com", "upstream/repo").unwrap().as_deref(), Some("2026-02-01T00:00:00Z"));
            }
        }
    }

    #[test]
    fn preserves_same_named_heads_and_multiple_pull_request_destinations() {
        use crate::test_support::{remove_scratch_repository, scratch_repository};

        let (repo_path, run) = scratch_repository("pr-remote-identity");
        run(&["remote", "add", "origin", "https://github.com/fork/repo.git"]);
        run(&["remote", "add", "upstream", "https://github.com/upstream/repo.git"]);
        run(&["remote", "add", "backup", "https://github.com/fork/repo.git"]);
        let database_path = PathBuf::from(&repo_path).join("pull-requests.sqlite");
        let mut connection = pull_request_database(database_path.clone()).unwrap();
        let pulls = serde_json::from_value::<Vec<GithubPullRequest>>(serde_json::json!([
            {"number":1,"title":"Fork PR","state":"open","draft":false,"updated_at":"2026-01-01T00:00:00Z","head":{"ref":"feature","sha":"a","repo":{"full_name":"fork/repo"}}},
            {"number":2,"title":"Upstream PR","state":"open","draft":false,"updated_at":"2026-01-01T00:00:00Z","head":{"ref":"feature","sha":"b","repo":{"full_name":"upstream/repo"}}}
        ])).unwrap();
        store_pull_requests(&mut connection, "github.com", "upstream/repo", &pulls, None).unwrap();
        store_pull_requests(&mut connection, "github.com", "fork/repo", &pulls[..1], None).unwrap();
        connection.close().unwrap();

        let entries = pull_requests_by_branch(&repo_path, database_path).unwrap();
        let mut identities = entries.iter().map(|entry| (entry.remote.as_str(), entry.repository.as_str(), entry.branch.as_str(), entry.number)).collect::<Vec<_>>();
        identities.sort();
        assert_eq!(identities, vec![
            ("backup", "fork/repo", "feature", 1),
            ("backup", "upstream/repo", "feature", 1),
            ("origin", "fork/repo", "feature", 1),
            ("origin", "upstream/repo", "feature", 1),
            ("upstream", "upstream/repo", "feature", 2),
        ]);
        assert_eq!(github_repositories(&repo_path).len(), 2);
        remove_scratch_repository(&repo_path);
    }

    #[test]
    fn reads_the_branch_and_the_fork_a_pull_request_was_raised_from() {
        let payload = r#"[{"number":7,"title":"A title","state":"open","draft":true,"merged_at":null,"merge_commit_sha":null,"updated_at":"2026-01-01T00:00:00Z","head":{"ref":"feature","sha":"abc","repo":{"full_name":"someone/hello-world"}}}]"#;

        let pull_requests: Vec<GithubPullRequest> = serde_json::from_str(payload).unwrap();

        assert_eq!(pull_requests[0].head.reference, "feature");
        assert_eq!(pull_requests[0].head.repo.as_ref().map(|repo| repo.full_name.as_str()), Some("someone/hello-world"));
        assert!(pull_requests[0].draft);
    }

    #[test]
    fn marks_a_branch_with_the_pull_request_that_is_still_open() {
        let rows = vec![
            ("feature".to_string(), 1, "closed".to_string(), false, Some("2026-01-01T00:00:00Z".to_string()), "Merged".to_string()),
            ("feature".to_string(), 2, "open".to_string(), true, None, "Draft".to_string()),
            ("feature".to_string(), 3, "closed".to_string(), false, None, "Abandoned".to_string()),
        ];

        let pull_requests = rank_branch_pull_requests("github.com", "octocat/hello-world", "origin", rows);

        assert_eq!(
            pull_requests,
            vec![BranchPullRequest {
                branch: "feature".to_string(),
                remote: "origin".to_string(),
                host: "github.com".to_string(),
                repository: "octocat/hello-world".to_string(),
                number: 2,
                state: "draft".to_string(),
                title: "Draft".to_string(),
                url: "https://github.com/octocat/hello-world/pull/2".to_string(),
            }]
        );
    }

    #[test]
    fn falls_back_to_the_newest_merged_pull_request_of_a_branch() {
        let rows = vec![
            ("feature".to_string(), 4, "closed".to_string(), false, Some("2026-01-01T00:00:00Z".to_string()), "First".to_string()),
            ("feature".to_string(), 7, "closed".to_string(), false, Some("2026-02-01T00:00:00Z".to_string()), "Second".to_string()),
            ("feature".to_string(), 9, "closed".to_string(), false, None, "Closed".to_string()),
        ];

        let pull_requests = rank_branch_pull_requests("github.com", "octocat/hello-world", "origin", rows);

        assert_eq!(pull_requests[0].number, 7);
        assert_eq!(pull_requests[0].state, "merged");
    }
}
