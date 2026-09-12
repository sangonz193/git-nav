use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, io::ErrorKind, path::PathBuf, time::SystemTime, time::UNIX_EPOCH};
use crate::process::external_command;
use crate::storage::data_dir;
use crate::git::{git_output, git_output_allow_empty};

const PULL_REQUEST_SYNC_INTERVAL_SECONDS: u64 = 60;

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
    number: i64,
    state: String,
    title: String,
    url: String,
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

fn github_pull_request_page(host: &str, repository: &str, state: &str) -> Result<Vec<GithubPullRequest>, String> {
    let endpoint = format!("repos/{repository}/pulls?state={state}&sort=updated&direction=desc&per_page=100");
    let mut command = external_command("gh");
    command.args(["api", "--method", "GET", "--header", "Accept: application/vnd.github+json"]);
    if host != "github.com" {
        command.args(["--hostname", host]);
    }
    let output = command
        .arg(endpoint)
        .output()
        .map_err(|error| github_pull_request_failure_message(GithubPullRequestFailure::Spawn(error.kind())))?;
    if !output.status.success() {
        return Err(github_pull_request_failure_message(GithubPullRequestFailure::Exit {
            code: output.status.code(),
            stderr: &output.stderr,
        }));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|_| github_pull_request_failure_message(GithubPullRequestFailure::UnreadableResponse))
}

// Closed pull requests are what a merge is recognised by, and open ones are what a branch is marked with, and
// each page only reaches as far back as its own state, so both are read.
fn github_pull_requests(host: &str, repository: &str) -> Result<Vec<GithubPullRequest>, String> {
    let mut pull_requests = github_pull_request_page(host, repository, "closed")?;
    pull_requests.extend(github_pull_request_page(host, repository, "open")?);
    Ok(pull_requests)
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
    Ok(())
}

pub(crate) fn pull_request_database(path: PathBuf) -> Result<Connection, String> {
    let mut connection = Connection::open(path).map_err(|error| error.to_string())?;
    migrate_pull_request_database(&mut connection)?;
    Ok(connection)
}

pub(crate) fn should_sync_pull_requests(connection: &Connection, host: &str, repository: &str) -> Result<bool, String> {
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

pub(crate) fn sync_pull_requests(connection: &mut Connection, host: &str, repository: &str) -> Result<(), String> {
    let pull_requests = github_pull_requests(host, repository)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    for pull_request in pull_requests {
        // A pull request raised from a fork names a branch in that fork, and names like "patch-1" are common
        // enough there to land on a local branch that has nothing to do with it.
        let head_ref = pull_request
            .head
            .repo
            .as_ref()
            .is_some_and(|repo| repo.full_name.eq_ignore_ascii_case(repository))
            .then_some(pull_request.head.reference.as_str());
        transaction
            .execute(
                "
                INSERT INTO pull_requests (host, repository, number, head_sha, head_ref, merge_commit_sha, merged_at, state, title, is_draft, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                ON CONFLICT(host, repository, number) DO UPDATE SET
                  head_sha = excluded.head_sha,
                  head_ref = excluded.head_ref,
                  merge_commit_sha = excluded.merge_commit_sha,
                  merged_at = excluded.merged_at,
                  state = excluded.state,
                  title = excluded.title,
                  is_draft = excluded.is_draft,
                  updated_at = excluded.updated_at
                WHERE excluded.updated_at > pull_requests.updated_at OR pull_requests.head_ref IS NULL
                ",
                params![
                    host,
                    repository,
                    pull_request.number,
                    pull_request.head.sha,
                    head_ref,
                    pull_request.merge_commit_sha,
                    pull_request.merged_at,
                    pull_request.state,
                    pull_request.title,
                    pull_request.draft,
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
fn rank_branch_pull_requests(host: &str, repository: &str, rows: Vec<PullRequestRow>) -> Vec<BranchPullRequest> {
    let mut best: HashMap<String, BranchPullRequest> = HashMap::new();
    for (branch, number, state, is_draft, merged_at, title) in rows {
        let state = pull_request_state(&state, is_draft, merged_at.as_deref());
        if best.get(&branch).is_some_and(|current| {
            (pull_request_rank(&current.state), current.number) > (pull_request_rank(state), number)
        }) {
            continue;
        }
        let url = format!("https://{host}/{repository}/pull/{number}");
        best.insert(branch.clone(), BranchPullRequest { branch, number, state: state.to_string(), title, url });
    }
    let mut pull_requests: Vec<_> = best.into_values().collect();
    pull_requests.sort_by(|a, b| a.branch.cmp(&b.branch));
    pull_requests
}

fn pull_requests_by_branch(repo_path: &str, database_path: PathBuf) -> Result<Vec<BranchPullRequest>, String> {
    let remote = git_output(repo_path, &["remote", "get-url", "origin"]).ok_or_else(|| "Could not identify the origin remote.".to_string())?;
    let (host, repository) = github_repository(&remote).ok_or_else(|| "Only GitHub remotes are supported.".to_string())?;
    let mut connection = pull_request_database(database_path)?;
    // What is already stored still answers the question when the remote cannot be reached.
    if should_sync_pull_requests(&connection, &host, &repository)? {
        let _ = sync_pull_requests(&mut connection, &host, &repository);
    }
    let mut statement = connection
        .prepare(
            "
            SELECT head_ref, number, state, is_draft, merged_at, title
            FROM pull_requests
            WHERE host = ?1 AND repository = ?2 AND head_ref IS NOT NULL
            ",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![host, repository], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                row.get::<_, bool>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            ))
        })
        .map_err(|error| error.to_string())?
        .flatten()
        .collect();
    Ok(rank_branch_pull_requests(&host, &repository, rows))
}

fn fetch_and_sync_repository(repo_path: &str, database_path: PathBuf) -> Result<(), String> {
    git_output_allow_empty(repo_path, &["fetch", "--prune", "origin"])?;
    let remote = git_output(repo_path, &["remote", "get-url", "origin"])
        .ok_or_else(|| "Could not identify the origin remote.".to_string())?;
    let (host, repository) = github_repository(&remote)
        .ok_or_else(|| "Only GitHub remotes are supported.".to_string())?;
    let mut connection = pull_request_database(database_path)?;
    sync_pull_requests(&mut connection, &host, &repository)
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn fetch_and_sync_pull_requests(repo_path: String) -> Result<(), String> {
    let database_path = pull_request_database_path()?;
    tauri::async_runtime::spawn_blocking(move || fetch_and_sync_repository(&repo_path, database_path))
        .await
        .map_err(|error| error.to_string())?
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
        assert_eq!(version, 2);
        connection
            .execute(
                "INSERT INTO pull_requests (host, repository, number, head_sha, head_ref, state, title, is_draft, updated_at) VALUES ('github.com', 'octocat/hello-world', 1, 'abc', 'feature', 'open', 'A title', 0, '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
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

        let pull_requests = rank_branch_pull_requests("github.com", "octocat/hello-world", rows);

        assert_eq!(
            pull_requests,
            vec![BranchPullRequest {
                branch: "feature".to_string(),
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

        let pull_requests = rank_branch_pull_requests("github.com", "octocat/hello-world", rows);

        assert_eq!(pull_requests[0].number, 7);
        assert_eq!(pull_requests[0].state, "merged");
    }
}
