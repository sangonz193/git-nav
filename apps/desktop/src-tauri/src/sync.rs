//! Keeps a repository's remote state fresh once for every window that shows it. Windows on different
//! worktrees of one repository share a single fetch and a single GitHub sync, and each trigger
//! (a timer, a window gaining focus, the Fetch action) asks for freshness rather than starting work of
//! its own, so overlapping requests join the run already going instead of adding to it.

use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Condvar, Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

use crate::git::{git_output_allow_empty, git_result, project_id};
use crate::process::external_command;
use crate::pull_requests::{
    github_repositories, pull_request_database, pull_request_database_path, sync_pull_requests, GithubRepository,
    RateLimit, SyncFailure, RATE_LIMIT_RESERVE,
};
use crate::storage::load_settings;

const SYNCED_EVENT: &str = "repository-synced";

/// A watcher that has not renewed within this long is taken to have closed without saying so.
const WATCH_TTL: Duration = Duration::from_secs(60);
const TICK: Duration = Duration::from_secs(5);
const PULL_REQUEST_INTERVAL: Duration = Duration::from_secs(60);
const FETCH_INTERVAL: Duration = Duration::from_secs(300);
const FOCUS_PULL_REQUEST_MAX_AGE: Duration = Duration::from_secs(30);
const FOCUS_FETCH_MAX_AGE: Duration = Duration::from_secs(60);
const MAX_BACKOFF: Duration = Duration::from_secs(1800);
const FETCH_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Kind {
    Fetch,
    PullRequests,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Reason {
    /// The user asked: runs now, whatever failed before.
    Manual,
    /// A window came to the front: only worth a run when the last one is getting old.
    Focus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Freshness {
    Now,
    Within(Duration),
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrackStatus {
    pub(crate) is_running: bool,
    /// Milliseconds since the Unix epoch of the last run to finish, however it went.
    pub(crate) completed_at: Option<u64>,
    /// Milliseconds since the Unix epoch of the last run that succeeded.
    pub(crate) succeeded_at: Option<u64>,
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncStatus {
    pub(crate) project_id: String,
    pub(crate) auto_fetch: bool,
    pub(crate) fetch: TrackStatus,
    pub(crate) pull_requests: TrackStatus,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncedEvent {
    project_id: String,
    kind: Kind,
    status: SyncStatus,
}

#[derive(Debug, Default)]
struct Track {
    is_running: bool,
    is_manual: bool,
    /// Counts completed runs so a waiter can tell the run it joined apart from a later one.
    generation: u64,
    completed_at: Option<Instant>,
    completed_wall_clock: Option<SystemTime>,
    succeeded_at: Option<SystemTime>,
    error: Option<String>,
    result: Option<Result<(), String>>,
    manual_result: Option<(u64, Result<(), String>)>,
    failures: u32,
}

impl Track {
    fn status(&self) -> TrackStatus {
        TrackStatus {
            is_running: self.is_running,
            completed_at: self.completed_wall_clock.map(epoch_millis),
            succeeded_at: self.succeeded_at.map(epoch_millis),
            error: self.error.clone(),
        }
    }

    fn is_fresh(&self, freshness: Freshness, now: Instant) -> bool {
        let Freshness::Within(max_age) = freshness else {
            return false;
        };
        if self.is_running {
            return false;
        }
        let Some(completed_at) = self.completed_at else {
            return false;
        };
        now.duration_since(completed_at) < max_age.max(backoff(self.failures))
    }

    fn record(&mut self, result: Result<(), String>, now: Instant) {
        self.is_running = false;
        self.generation += 1;
        self.completed_at = Some(now);
        self.completed_wall_clock = Some(SystemTime::now());
        self.result = Some(result.clone());
        if self.is_manual {
            self.manual_result = Some((self.generation, result.clone()));
        }
        self.is_manual = false;
        match result {
            Ok(()) => {
                self.succeeded_at = Some(SystemTime::now());
                self.error = None;
                self.failures = 0;
            }
            Err(message) => {
                self.error = Some(message);
                self.failures = self.failures.saturating_add(1);
            }
        }
    }
}

// Each failure doubles the wait before the next unattended attempt, so a remote that is down or a
// signed-out GitHub CLI is not retried every minute.
fn backoff(failures: u32) -> Duration {
    if failures == 0 {
        return Duration::ZERO;
    }
    let scale = 2u32.saturating_pow(failures.saturating_sub(1)).min(1 << 10);
    (Duration::from_secs(60) * scale).min(MAX_BACKOFF)
}

fn epoch_millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as u64).unwrap_or_default()
}

#[derive(Debug)]
struct Watcher {
    repo_path: String,
    is_visible: bool,
    seen_at: Instant,
}

#[derive(Debug, Default)]
struct RemoteTrack {
    failures: u32,
    completed_at: Option<Instant>,
}

#[derive(Debug, Default)]
struct Repository {
    watchers: HashMap<String, Watcher>,
    fetch: Track,
    pull_requests: Track,
    /// Failures are kept per remote so one that is unreachable does not hold back the others.
    remotes: HashMap<String, RemoteTrack>,
}

impl Repository {
    fn track(&self, kind: Kind) -> &Track {
        match kind {
            Kind::Fetch => &self.fetch,
            Kind::PullRequests => &self.pull_requests,
        }
    }

    fn track_mut(&mut self, kind: Kind) -> &mut Track {
        match kind {
            Kind::Fetch => &mut self.fetch,
            Kind::PullRequests => &mut self.pull_requests,
        }
    }

    fn has_visible_watcher(&self) -> bool {
        self.watchers.values().any(|watcher| watcher.is_visible)
    }

    /// The worktree most recently watched, which is as good as any for reaching the shared remotes.
    fn repo_path(&self) -> Option<String> {
        self.watchers.values().max_by_key(|watcher| watcher.seen_at).map(|watcher| watcher.repo_path.clone())
    }

    fn status(&self, project_id: &str, auto_fetch: bool) -> SyncStatus {
        SyncStatus {
            project_id: project_id.to_string(),
            auto_fetch,
            fetch: self.fetch.status(),
            pull_requests: self.pull_requests.status(),
        }
    }
}

#[derive(Default)]
struct Registry {
    repositories: HashMap<String, Repository>,
}

static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
static COMPLETED: Condvar = Condvar::new();
static SCHEDULER: OnceLock<()> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Lets completed runs reach the windows. Without it (the headless server) windows poll instead.
pub(crate) fn attach(app: AppHandle) {
    let _ = APP.set(app);
}

fn lock_registry() -> std::sync::MutexGuard<'static, Registry> {
    REGISTRY.get_or_init(Mutex::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn auto_fetch_setting(project_id: &str) -> String {
    format!("sync.autoFetch:{project_id}")
}

fn auto_fetch_enabled(settings: &BTreeMap<String, serde_json::Value>, project_id: &str) -> bool {
    settings
        .get(&auto_fetch_setting(project_id))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true)
}

fn emit_synced(project_id: &str, kind: Kind, status: SyncStatus) {
    if let Some(app) = APP.get() {
        let _ = app.emit(SYNCED_EVENT, SyncedEvent { project_id: project_id.to_string(), kind, status });
    }
}

/// Makes sure `kind` has run recently enough, running it when not and otherwise joining a run in
/// progress. Answers with the outcome of the run this call waited on, or the stored one when nothing needed
/// doing.
fn ensure_fresh(project_id: &str, repo_path: &str, kind: Kind, freshness: Freshness) -> Result<(), String> {
    ensure_fresh_with(lock_registry(), project_id, kind, freshness, || match kind {
        Kind::Fetch => fetch_remotes(project_id, repo_path, freshness == Freshness::Now),
        Kind::PullRequests => sync_github(repo_path),
    })
}

fn ensure_fresh_with(
    mut registry: std::sync::MutexGuard<'_, Registry>,
    project_id: &str,
    kind: Kind,
    freshness: Freshness,
    run: impl FnOnce() -> Outcome,
) -> Result<(), String> {
    let needs_manual_fetch = kind == Kind::Fetch && freshness == Freshness::Now;
    let initial_generation = registry.repositories.entry(project_id.to_string()).or_default().track(kind).generation;
    loop {
        let repository = registry.repositories.entry(project_id.to_string()).or_default();
        let track = repository.track_mut(kind);
        if needs_manual_fetch {
            if let Some((generation, result)) = &track.manual_result {
                if *generation > initial_generation {
                    return result.clone();
                }
            }
        }
        if track.is_running {
            let generation = track.generation;
            registry = COMPLETED
                .wait_while(registry, |registry| {
                    registry
                        .repositories
                        .get(project_id)
                        .is_some_and(|repository| repository.track(kind).generation == generation)
                })
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if needs_manual_fetch {
                continue;
            }
            return registry
                .repositories
                .get(project_id)
                .and_then(|repository| repository.track(kind).result.clone())
                .unwrap_or(Ok(()));
        }
        if track.is_fresh(freshness, Instant::now()) {
            return track.result.clone().unwrap_or(Ok(()));
        }
        track.is_running = true;
        track.is_manual = needs_manual_fetch;
        break;
    }
    drop(registry);

    let outcome = run();

    let auto_fetch = auto_fetch_enabled(&load_settings().unwrap_or_default(), project_id);
    let mut registry = lock_registry();
    let repository = registry.repositories.entry(project_id.to_string()).or_default();
    let now = Instant::now();
    for (remote, result) in &outcome.remotes {
        let track = repository.remotes.entry(remote.clone()).or_default();
        track.completed_at = Some(now);
        track.failures = if result.is_ok() { 0 } else { track.failures.saturating_add(1) };
    }
    let track = repository.track_mut(kind);
    track.record(outcome.result.clone(), now);
    // A remote that failed while the others went through is worth showing without holding the others back.
    if outcome.partial_error.is_some() {
        track.error = outcome.partial_error;
    }
    let status = repository.status(project_id, auto_fetch);
    drop(registry);
    COMPLETED.notify_all();
    emit_synced(project_id, kind, status);
    outcome.result
}

struct Outcome {
    /// Failed only when nothing went through; with several remotes, a lone failure is a partial error.
    result: Result<(), String>,
    partial_error: Option<String>,
    remotes: Vec<(String, Result<(), String>)>,
}

impl Outcome {
    fn failed(error: String) -> Self {
        Self { result: Err(error), ..Self::default() }
    }

    /// Fails when every attempt did and otherwise keeps the failures as a partial error.
    fn from_attempts(attempted: usize, failures: Vec<String>) -> Self {
        if attempted > 0 && failures.len() == attempted {
            return Self::failed(failures.join("\n"));
        }
        Self { partial_error: (!failures.is_empty()).then(|| failures.join("\n")), ..Self::default() }
    }
}

impl Default for Outcome {
    fn default() -> Self {
        Self { result: Ok(()), partial_error: None, remotes: Vec::new() }
    }
}

fn fetch_remotes(project_id: &str, repo_path: &str, is_manual: bool) -> Outcome {
    let remotes = match git_output_allow_empty(repo_path, &["remote"]) {
        Ok(remotes) => remotes,
        Err(error) => return Outcome::failed(error),
    };
    let now = Instant::now();
    let due: Vec<String> = {
        let registry = lock_registry();
        let repository = registry.repositories.get(project_id);
        remotes
            .lines()
            .filter(|remote| {
                is_manual
                    || repository
                        .and_then(|repository| repository.remotes.get(*remote))
                        .and_then(|track| track.completed_at.map(|at| (track.failures, at)))
                        .map_or(true, |(failures, at)| now.duration_since(at) >= backoff(failures))
            })
            .map(str::to_string)
            .collect()
    };
    let results: Vec<(String, Result<(), String>)> = due
        .into_iter()
        .map(|remote| {
            let result = fetch_remote(repo_path, &remote, is_manual);
            (remote, result)
        })
        .collect();
    let failures = results
        .iter()
        .filter_map(|(remote, result)| result.as_ref().err().map(|error| format!("{remote}: {error}")))
        .collect();
    Outcome { remotes: results.clone(), ..Outcome::from_attempts(results.len(), failures) }
}

fn fetch_command(repo_path: &str, remote: &str, is_manual: bool) -> Result<std::process::Command, String> {
    let mut command = external_command("git");
    command.args(["-C", repo_path]);
    if !is_manual {
        let configured_ssh = git_result(repo_path, &["config", "--get-regexp", "^(core\\.sshcommand|ssh\\.variant)$"])?;
        let custom_ssh = match configured_ssh.status.code() {
            Some(0) => true,
            Some(1) => false,
            _ => return Err(String::from_utf8_lossy(&configured_ssh.stderr).trim().to_string()),
        } || ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_SSH_VARIANT"].iter().any(|name| std::env::var_os(name).is_some());
        command
            .args(["-c", "credential.helper=", "-c", "core.askPass="])
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_ASKPASS", "")
            .env("SSH_ASKPASS", "")
            .env("SSH_ASKPASS_REQUIRE", "never");
        if custom_ssh {
            // Custom SSH programs have no shared noninteractive contract; leave them to manual fetches.
            command.args(["-c", "protocol.ssh.allow=never"]);
            if let Some(protocols) = std::env::var_os("GIT_ALLOW_PROTOCOL") {
                command.env("GIT_ALLOW_PROTOCOL", protocols.to_string_lossy().split(':').filter(|protocol| *protocol != "ssh").collect::<Vec<_>>().join(":"));
            }
        } else {
            command.env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes").env("GIT_SSH_VARIANT", "ssh");
        }
    }
    command.args(["fetch", "--prune", "--", remote]);
    Ok(command)
}

fn fetch_remote(repo_path: &str, remote: &str, is_manual: bool) -> Result<(), String> {
    let mut command = fetch_command(repo_path, remote, is_manual)?;
    let output = crate::process::output_with_timeout(&mut command, FETCH_TIMEOUT)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("git fetch {remote} did not finish within {} seconds.", FETCH_TIMEOUT.as_secs()))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.strip_prefix("fatal: ").unwrap_or(line).to_string())
        .unwrap_or_else(|| "git fetch failed without a message.".to_string()))
}

fn sync_github(repo_path: &str) -> Outcome {
    let repositories = github_repositories(repo_path);
    // A repository hosted elsewhere has nothing to sync, which is not a failure worth reporting every minute.
    if repositories.is_empty() {
        return Outcome::default();
    }
    let database_path = match pull_request_database_path() {
        Ok(path) => path,
        Err(error) => return Outcome::failed(error),
    };
    let mut connection = match pull_request_database(database_path) {
        Ok(connection) => connection,
        Err(error) => return Outcome::failed(error),
    };
    sync_github_repositories(&repositories, |host, repository| sync_pull_requests(&mut connection, host, repository))
}

fn sync_github_repositories(
    repositories: &[GithubRepository],
    mut sync_repository: impl FnMut(&str, &str) -> Result<Option<RateLimit>, SyncFailure>,
) -> Outcome {
    let mut held_hosts = HashSet::new();
    let mut failures = Vec::new();
    let mut attempted = 0;
    for GithubRepository { host, repository } in repositories {
        if held_hosts.contains(host.as_str()) {
            continue;
        }
        attempted += 1;
        let held = match sync_repository(host, repository) {
            Ok(limit) => limit.is_some_and(|limit| limit.remaining < RATE_LIMIT_RESERVE),
            Err(failure) => {
                failures.push(if repositories.len() == 1 { failure.message } else { format!("{repository}: {}", failure.message) });
                failure.retry_at.is_some() || failure.rate_limit.is_some_and(|limit| limit.remaining < RATE_LIMIT_RESERVE)
            }
        };
        if held {
            held_hosts.insert(host.as_str());
        }
    }
    Outcome::from_attempts(attempted, failures)
}

fn prune_watchers(registry: &mut Registry, now: Instant) {
    for repository in registry.repositories.values_mut() {
        repository.watchers.retain(|_, watcher| now.duration_since(watcher.seen_at) < WATCH_TTL);
    }
}

fn start_scheduler() {
    SCHEDULER.get_or_init(|| {
        thread::Builder::new()
            .name("repository-sync".to_string())
            .spawn(|| loop {
                thread::sleep(TICK);
                tick();
            })
            .expect("could not start the repository sync scheduler");
    });
}

fn tick() {
    let settings = load_settings().unwrap_or_default();
    let now = Instant::now();
    let due: Vec<(String, String, Kind)> = {
        let mut registry = lock_registry();
        prune_watchers(&mut registry, now);
        registry.repositories.retain(|_, repository| !repository.watchers.is_empty() || repository.fetch.is_running || repository.pull_requests.is_running);
        registry
            .repositories
            .iter()
            .filter(|(_, repository)| repository.has_visible_watcher())
            .filter_map(|(project_id, repository)| repository.repo_path().map(|path| (project_id, path, repository)))
            .flat_map(|(project_id, repo_path, repository)| {
                let mut due = Vec::new();
                if !repository.pull_requests.is_fresh(Freshness::Within(PULL_REQUEST_INTERVAL), now)
                    && !repository.pull_requests.is_running
                {
                    due.push((project_id.clone(), repo_path.clone(), Kind::PullRequests));
                }
                if auto_fetch_enabled(&settings, project_id)
                    && !repository.fetch.is_fresh(Freshness::Within(FETCH_INTERVAL), now)
                    && !repository.fetch.is_running
                {
                    due.push((project_id.clone(), repo_path, Kind::Fetch));
                }
                due
            })
            .collect()
    };
    for (project_id, repo_path, kind) in due {
        let interval = match kind {
            Kind::Fetch => FETCH_INTERVAL,
            Kind::PullRequests => PULL_REQUEST_INTERVAL,
        };
        let _ = thread::Builder::new().name(format!("repository-sync-{kind:?}")).spawn(move || {
            let _ = ensure_fresh(&project_id, &repo_path, kind, Freshness::Within(interval));
        });
    }
}

fn status_of(project_id: &str) -> SyncStatus {
    let auto_fetch = auto_fetch_enabled(&load_settings().unwrap_or_default(), project_id);
    let registry = lock_registry();
    registry
        .repositories
        .get(project_id)
        .map(|repository| repository.status(project_id, auto_fetch))
        .unwrap_or_else(|| Repository::default().status(project_id, auto_fetch))
}

fn watch(repo_path: &str, client_id: &str, is_visible: bool) -> Result<SyncStatus, String> {
    let project_id = project_id(repo_path)?;
    start_scheduler();
    {
        let mut registry = lock_registry();
        let repository = registry.repositories.entry(project_id.clone()).or_default();
        repository.watchers.insert(
            client_id.to_string(),
            Watcher { repo_path: repo_path.to_string(), is_visible, seen_at: Instant::now() },
        );
    }
    Ok(status_of(&project_id))
}

fn unwatch(client_id: &str) {
    let mut registry = lock_registry();
    for repository in registry.repositories.values_mut() {
        repository.watchers.remove(client_id);
    }
}

fn refresh(repo_path: &str, reason: Reason) -> Result<SyncStatus, String> {
    let project_id = project_id(repo_path)?;
    let (fetch, pull_requests) = match reason {
        Reason::Manual => (Some(Freshness::Now), Freshness::Now),
        Reason::Focus => (
            auto_fetch_enabled(&load_settings().unwrap_or_default(), &project_id).then_some(Freshness::Within(FOCUS_FETCH_MAX_AGE)),
            Freshness::Within(FOCUS_PULL_REQUEST_MAX_AGE),
        ),
    };
    let fetched = fetch.map(|freshness| ensure_fresh(&project_id, repo_path, Kind::Fetch, freshness));
    let synced = ensure_fresh(&project_id, repo_path, Kind::PullRequests, pull_requests);
    if reason == Reason::Manual {
        if let Some(Err(error)) = fetched {
            return Err(error);
        }
        synced?;
    }
    Ok(status_of(&project_id))
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn watch_repository(repo_path: String, client_id: String, is_visible: bool) -> Result<SyncStatus, String> {
    tauri::async_runtime::spawn_blocking(move || watch(&repo_path, &client_id, is_visible))
        .await
        .map_err(|error| error.to_string())?
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn unwatch_repository(client_id: String) {
    unwatch(&client_id);
}

#[git_nav_macros::http_command]
#[tauri::command]
pub(crate) async fn refresh_repository(repo_path: String, reason: Reason) -> Result<SyncStatus, String> {
    tauri::async_runtime::spawn_blocking(move || refresh(&repo_path, reason))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_successful_low_quota_sync_holds_before_the_next_remote() {
        let repositories = ["fork/repo", "upstream/repo"].map(|repository| GithubRepository {
            host: "github.com".to_string(),
            repository: repository.to_string(),
        });
        for succeeds in [true, false] {
            let mut attempted = Vec::new();
            let outcome = sync_github_repositories(&repositories, |host, repository| {
                assert_eq!(host, "github.com");
                attempted.push(repository.to_string());
                let rate_limit = Some(RateLimit { remaining: 99, reset: 900 });
                if succeeds {
                    Ok(rate_limit)
                } else {
                    Err(SyncFailure { message: "quota exhausted".to_string(), rate_limit, retry_at: None })
                }
            });

            assert_eq!(attempted, vec!["fork/repo"]);
            assert_eq!(outcome.result.is_ok(), succeeds);
            assert!(outcome.partial_error.is_none());
        }
    }

    #[test]
    fn quota_holds_skip_peer_remotes_without_holding_independent_hosts() {
        let repositories = [
            ("github.com", "fork/repo"),
            ("github.com", "upstream/repo"),
            ("git.example.com", "other/repo"),
            ("github.com", "another/repo"),
            ("git.example.com", "last/repo"),
        ].map(|(host, repository)| GithubRepository { host: host.to_string(), repository: repository.to_string() });
        for (succeeds, secondary_limit) in [(true, false), (false, false), (false, true)] {
            let mut track = Track::default();
            for _ in 0..4 {
                let mut attempted = Vec::new();
                let outcome = sync_github_repositories(&repositories, |host, repository| {
                    attempted.push(repository.to_string());
                    if host != "github.com" {
                        return Ok(Some(RateLimit { remaining: 4000, reset: 900 }));
                    }
                    let rate_limit = Some(RateLimit { remaining: if secondary_limit { 4500 } else { 99 }, reset: 900 });
                    if succeeds {
                        Ok(rate_limit)
                    } else {
                        Err(SyncFailure { message: "rate limited".to_string(), rate_limit, retry_at: secondary_limit.then_some(3600) })
                    }
                });

                assert_eq!(attempted, vec!["fork/repo", "other/repo", "last/repo"]);
                assert_eq!(outcome.result, Ok(()));
                assert_eq!(outcome.partial_error, (!succeeds).then(|| "fork/repo: rate limited".to_string()));
                let now = Instant::now();
                track.record(outcome.result, now);
                assert!(!track.is_fresh(Freshness::Within(PULL_REQUEST_INTERVAL), now + PULL_REQUEST_INTERVAL));
            }
        }
    }

    #[test]
    #[cfg(unix)]
    fn fetch_invokes_ssh_in_batch_mode() {
        use std::{fs, os::unix::fs::PermissionsExt, path::Path};
        use crate::test_support::{scratch_repository, remove_scratch_repository};

        let (repo_path, git) = scratch_repository("fetch-ssh-batch-mode");
        git(&["remote", "add", "origin", "git@example.invalid:owner/repository.git"]);
        let bin = Path::new(&repo_path).join("bin");
        fs::create_dir(&bin).unwrap();
        let ssh = bin.join("ssh");
        fs::write(&ssh, "#!/bin/sh\nprintf '%s\\n' \"$@\" >&2\nexit 1\n").unwrap();
        fs::set_permissions(&ssh, fs::Permissions::from_mode(0o755)).unwrap();
        let mut command = fetch_command(&repo_path, "origin", false).unwrap();
        let inherited_path = command.get_envs()
            .find(|(name, _)| *name == "PATH")
            .and_then(|(_, value)| value.map(|value| value.to_os_string()))
            .or_else(|| std::env::var_os("PATH"))
            .unwrap();
        let paths = std::iter::once(bin).chain(std::env::split_paths(&inherited_path));
        command.env("PATH", std::env::join_paths(paths).unwrap());

        let output = crate::process::output_with_timeout(&mut command, Duration::from_secs(5)).unwrap().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);

        assert!(!output.status.success());
        assert!(stderr.lines().any(|line| line == "-oBatchMode=yes"), "{stderr}");
        assert!(stderr.lines().any(|line| line == "git@example.invalid"), "{stderr}");
        assert!(!stderr.contains("BatchMode=no"), "{stderr}");
        remove_scratch_repository(&repo_path);
    }

    #[test]
    #[cfg(unix)]
    fn custom_ssh_transport_is_preserved_for_manual_fetches() {
        use crate::test_support::{remove_scratch_repository, scratch_repository};

        let (repo_path, git) = scratch_repository("fetch-custom-ssh");
        git(&["remote", "add", "origin", "ssh://git@example.invalid:2222/owner/repository.git"]);
        git(&["config", "ssh.variant", "plink"]);
        git(&["config", "core.sshCommand", "printf 'configured-transport %s\\n' >&2; printf '%s\\n' >&2"]);

        let mut automatic = fetch_command(&repo_path, "origin", false).unwrap();
        let output = crate::process::output_with_timeout(&mut automatic, Duration::from_secs(5)).unwrap().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success());
        assert!(stderr.contains("transport 'ssh' not allowed"), "{stderr}");
        assert!(!stderr.contains("configured-transport"), "{stderr}");

        let mut manual = fetch_command(&repo_path, "origin", true).unwrap();
        let output = crate::process::output_with_timeout(&mut manual, Duration::from_secs(5)).unwrap().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("configured-transport"), "{stderr}");
        assert!(stderr.lines().any(|line| line == "-P"), "{stderr}");
        assert!(stderr.lines().any(|line| line == "2222"), "{stderr}");
        assert!(!stderr.contains("BatchMode"), "{stderr}");
        assert!(!manual.get_envs().any(|(name, _)| matches!(name.to_str(), Some("GIT_SSH_COMMAND" | "GIT_SSH_VARIANT" | "GIT_SSH"))));
        remove_scratch_repository(&repo_path);
    }

    #[test]
    #[cfg(unix)]
    fn automatic_http_fetch_does_not_run_credential_helpers_or_askpass() {
        use std::{fs, io::{Read, Write}, net::TcpListener, os::unix::fs::PermissionsExt, path::Path};
        use crate::test_support::{remove_scratch_repository, scratch_repository};

        let (repo_path, git) = scratch_repository("fetch-http-credentials");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut requests = 0;
            while requests < 2 && Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                        let mut request = [0; 4096];
                        stream.read(&mut request).unwrap();
                        stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"test\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                        requests += 1;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(10)),
                    Err(error) => panic!("{error}"),
                }
            }
            requests
        });
        let url = format!("http://{address}/repository.git");
        git(&["remote", "add", "origin", &url]);
        git(&["config", "credential.helper", ""]);
        git(&["config", &format!("credential.{url}.helper"), "!printf 'helper\\n' >> authentication-attempts"]);
        let askpass = Path::new(&repo_path).join("askpass");
        fs::write(&askpass, "#!/bin/sh\nprintf 'askpass\\n' >> authentication-attempts\nexit 1\n").unwrap();
        fs::set_permissions(&askpass, fs::Permissions::from_mode(0o755)).unwrap();
        git(&["config", "core.askPass", askpass.to_str().unwrap()]);
        let attempts = Path::new(&repo_path).join("authentication-attempts");

        let mut automatic = fetch_command(&repo_path, "origin", false).unwrap();
        let output = crate::process::output_with_timeout(&mut automatic, Duration::from_secs(5)).unwrap().unwrap();
        assert!(!output.status.success());
        assert!(!attempts.exists(), "{}", fs::read_to_string(&attempts).unwrap_or_default());

        let mut manual = fetch_command(&repo_path, "origin", true).unwrap();
        manual.env_remove("GIT_ASKPASS").env_remove("SSH_ASKPASS").env("GIT_TERMINAL_PROMPT", "0");
        let output = crate::process::output_with_timeout(&mut manual, Duration::from_secs(5)).unwrap().unwrap();
        assert!(!output.status.success());
        let attempts = fs::read_to_string(attempts).unwrap();
        assert!(attempts.contains("helper"), "{attempts}");
        assert!(attempts.contains("askpass"), "{attempts}");
        assert_eq!(server.join().unwrap(), 2);
        remove_scratch_repository(&repo_path);
    }

    #[test]
    fn auto_fetch_preferences_are_scoped_to_the_repository() {
        let mut settings = BTreeMap::new();
        settings.insert(auto_fetch_setting("/first/.git"), serde_json::json!(false));

        assert!(!auto_fetch_enabled(&settings, "/first/.git"));
        assert!(auto_fetch_enabled(&settings, "/second/.git"));

        settings.insert(auto_fetch_setting("/second/.git"), serde_json::json!(false));
        settings.insert(auto_fetch_setting("/first/.git"), serde_json::json!(true));

        assert!(auto_fetch_enabled(&settings, "/first/.git"));
        assert!(!auto_fetch_enabled(&settings, "/second/.git"));
    }

    #[test]
    fn backs_off_exponentially_and_caps_the_wait() {
        assert_eq!(backoff(0), Duration::ZERO);
        assert_eq!(backoff(1), Duration::from_secs(60));
        assert_eq!(backoff(2), Duration::from_secs(120));
        assert_eq!(backoff(4), Duration::from_secs(480));
        assert_eq!(backoff(40), MAX_BACKOFF);
    }

    #[test]
    fn a_manual_request_is_never_satisfied_by_a_stored_run() {
        let now = Instant::now();
        let mut track = Track::default();
        track.record(Ok(()), now);

        assert!(track.is_fresh(Freshness::Within(Duration::from_secs(60)), now));
        assert!(!track.is_fresh(Freshness::Now, now));
    }

    #[test]
    fn a_failed_run_stretches_the_wait_before_the_next_unattended_one() {
        let now = Instant::now();
        let mut track = Track::default();
        track.record(Err("offline".to_string()), now);
        track.record(Err("offline".to_string()), now);

        let later = now + Duration::from_secs(90);
        assert!(track.is_fresh(Freshness::Within(Duration::from_secs(30)), later));
        assert!(!track.is_fresh(Freshness::Within(Duration::from_secs(30)), now + Duration::from_secs(121)));
        assert_eq!(track.error.as_deref(), Some("offline"));
    }

    #[test]
    fn a_success_clears_the_failure_history() {
        let now = Instant::now();
        let mut track = Track::default();
        track.record(Err("offline".to_string()), now);
        track.record(Ok(()), now);

        assert_eq!(track.failures, 0);
        assert!(track.error.is_none());
        assert!(track.succeeded_at.is_some());
    }

    #[test]
    fn completed_pull_request_tracks_are_due_again_at_the_poll_interval() {
        let now = Instant::now();
        let mut track = Track::default();
        track.record(Ok(()), now);

        assert!(track.is_fresh(Freshness::Within(Duration::from_secs(60)), now));
        assert!(!track.is_fresh(Freshness::Within(Duration::from_secs(60)), now + Duration::from_secs(60)));
        assert!(!track.is_fresh(Freshness::Now, now));
    }

    #[test]
    fn a_running_track_is_not_fresh() {
        let now = Instant::now();
        let mut track = Track::default();
        track.record(Ok(()), now);
        track.is_running = true;

        assert!(!track.is_fresh(Freshness::Within(Duration::from_secs(60)), now));
    }

    #[test]
    fn partial_fetch_results_are_consistent_for_all_callers() {
        let project_id = format!("test-partial-run-{}", std::process::id());
        let warning = "upstream: offline".to_string();
        let owner_result = ensure_fresh_with(lock_registry(), &project_id, Kind::Fetch, Freshness::Now, || Outcome {
            remotes: vec![("origin".to_string(), Ok(())), ("upstream".to_string(), Err("offline".to_string()))],
            ..Outcome::from_attempts(2, vec![warning.clone()])
        });
        assert_eq!(owner_result, Ok(()));
        assert_eq!(
            ensure_fresh_with(lock_registry(), &project_id, Kind::Fetch, Freshness::Within(FETCH_INTERVAL), || {
                panic!("a fresh partial success must be reused")
            }),
            owner_result
        );

        let mut registry = lock_registry();
        let repository = registry.repositories.get_mut(&project_id).unwrap();
        assert_eq!(repository.fetch.error.as_ref(), Some(&warning));
        assert_eq!(repository.fetch.failures, 0);
        assert!(repository.fetch.succeeded_at.is_some());
        assert_eq!(repository.remotes["origin"].failures, 0);
        assert_eq!(repository.remotes["upstream"].failures, 1);
        repository.fetch.is_running = true;
        repository.fetch.is_manual = true;

        let completion = {
            let project_id = project_id.clone();
            thread::spawn(move || {
                let mut registry = lock_registry();
                let repository = registry.repositories.get_mut(&project_id).unwrap();
                repository.fetch.record(Ok(()), Instant::now());
                repository.fetch.error = Some(warning);
                drop(registry);
                COMPLETED.notify_all();
            })
        };
        assert_eq!(
            ensure_fresh_with(registry, &project_id, Kind::Fetch, Freshness::Now, || {
                panic!("an overlapping request must join the running fetch")
            }),
            owner_result
        );
        completion.join().unwrap();
        lock_registry().repositories.remove(&project_id);
    }

    #[test]
    fn failed_fetch_results_are_consistent_for_all_callers() {
        let project_id = format!("test-failed-run-{}", std::process::id());
        let failure = "origin: offline".to_string();
        let owner_result = ensure_fresh_with(lock_registry(), &project_id, Kind::Fetch, Freshness::Now, || {
            Outcome::from_attempts(1, vec![failure.clone()])
        });
        assert_eq!(owner_result, Err(failure.clone()));
        assert_eq!(
            ensure_fresh_with(lock_registry(), &project_id, Kind::Fetch, Freshness::Within(FETCH_INTERVAL), || {
                panic!("a failure in backoff must be reused")
            }),
            owner_result
        );

        let mut registry = lock_registry();
        let repository = registry.repositories.get_mut(&project_id).unwrap();
        assert_eq!(repository.fetch.failures, 1);
        assert!(repository.fetch.succeeded_at.is_none());
        repository.fetch.is_running = true;
        repository.fetch.is_manual = true;
        let completion = {
            let project_id = project_id.clone();
            thread::spawn(move || {
                let mut registry = lock_registry();
                registry.repositories.get_mut(&project_id).unwrap().fetch.record(Err(failure), Instant::now());
                drop(registry);
                COMPLETED.notify_all();
            })
        };
        assert_eq!(
            ensure_fresh_with(registry, &project_id, Kind::Fetch, Freshness::Now, || {
                panic!("an overlapping request must join the running fetch")
            }),
            owner_result
        );
        completion.join().unwrap();
        lock_registry().repositories.remove(&project_id);
    }

    #[test]
    fn manual_fetches_wait_for_automatic_work_and_share_a_manual_run() {
        use std::sync::mpsc;

        for automatic_result in [Ok(()), Err("restricted authentication".to_string())] {
            let project_id = format!("test-manual-after-automatic-{}", std::process::id());
            let (automatic_started, automatic_running) = mpsc::channel();
            let (finish_automatic, automatic_finished) = mpsc::channel();
            let automatic = {
                let project_id = project_id.clone();
                thread::spawn(move || {
                    ensure_fresh_with(lock_registry(), &project_id, Kind::Fetch, Freshness::Within(FETCH_INTERVAL), || {
                        automatic_started.send(()).unwrap();
                        automatic_finished.recv_timeout(Duration::from_secs(5)).unwrap();
                        Outcome { result: automatic_result, ..Outcome::default() }
                    })
                })
            };
            automatic_running.recv_timeout(Duration::from_secs(5)).unwrap();

            let (manual_waiting, waiting_for_automatic) = mpsc::channel();
            let (manual_started, manual_running) = mpsc::channel();
            let manual = (0..2).map(|_| {
                let project_id = project_id.clone();
                let manual_waiting = manual_waiting.clone();
                let manual_started = manual_started.clone();
                let (finish_manual, manual_finished) = mpsc::channel();
                let request = thread::spawn(move || {
                    let registry = lock_registry();
                    manual_waiting.send(()).unwrap();
                    ensure_fresh_with(registry, &project_id, Kind::Fetch, Freshness::Now, || {
                        manual_started.send(()).unwrap();
                        manual_finished.recv_timeout(Duration::from_secs(5)).unwrap();
                        Outcome::default()
                    })
                });
                (request, finish_manual)
            }).collect::<Vec<_>>();
            waiting_for_automatic.recv_timeout(Duration::from_secs(5)).unwrap();
            waiting_for_automatic.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(manual_running.try_recv().is_err());

            finish_automatic.send(()).unwrap();
            manual_running.recv_timeout(Duration::from_secs(5)).unwrap();
            for (_, finish_manual) in &manual {
                finish_manual.send(()).ok();
            }
            for (request, _) in manual {
                assert_eq!(request.join().unwrap(), Ok(()));
            }
            assert!(manual_running.try_recv().is_err());
            automatic.join().unwrap().ok();
            let repository = lock_registry().repositories.remove(&project_id).unwrap();
            assert_eq!(repository.fetch.generation, 2);
            assert_eq!(repository.fetch.manual_result, Some((2, Ok(()))));
        }
    }

    #[test]
    fn watchers_expire_when_they_stop_renewing() {
        let mut registry = Registry::default();
        let now = Instant::now();
        let repository = registry.repositories.entry("project".to_string()).or_default();
        repository.watchers.insert(
            "stale".to_string(),
            Watcher { repo_path: "/a".to_string(), is_visible: true, seen_at: now - WATCH_TTL },
        );
        repository.watchers.insert(
            "live".to_string(),
            Watcher { repo_path: "/b".to_string(), is_visible: false, seen_at: now },
        );

        prune_watchers(&mut registry, now);

        let repository = &registry.repositories["project"];
        assert_eq!(repository.watchers.len(), 1);
        assert!(repository.watchers.contains_key("live"));
        assert!(!repository.has_visible_watcher());
        assert_eq!(repository.repo_path().as_deref(), Some("/b"));
    }
}
