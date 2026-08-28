//! Serves the same commands the Tauri webview invokes over HTTP so a browser can drive the app.

use axum::{
    body::Body,
    extract::{Query, Request, State},
    http::{header, HeaderValue, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tower_http::compression::{
    predicate::{NotForContentType, Predicate, SizeAbove},
    CompressionLayer,
};

use crate::{
    branch_operability, branch_range, comparison, delete_cleanup_candidates, cleanup_candidates,
    cleanup_database_path, directory_listing, fetch_and_sync_repository, file_diff,
    git_output_allow_empty, inferred_squash_merges, launch_worktree, merged_branch_candidates,
    picker_commits, predicted_conflicts, project_at, pull_request_database_path,
    rebase_branch_onto, recent_project_list, remember_repository, restore_refs, walk_commit_graph,
    CleanupOptions, OpenWorktrees, RefUpdate,
};

include!(concat!(env!("OUT_DIR"), "/assets.rs"));

fn asset(path: &str) -> Option<&'static [u8]> {
    ASSETS
        .iter()
        .find(|(name, _)| *name == path)
        .map(|(_, contents)| *contents)
}

const TOKEN_COOKIE: &str = "git_nav_token";

pub struct Options {
    pub host: IpAddr,
    pub port: u16,
    pub token: Option<String>,
}

struct ServerState {
    // Server mode has no windows to track, so every worktree reports itself as closed.
    open_worktrees: OpenWorktrees,
    token: Option<String>,
}

/// `Err(String)` from a command becomes a 500 whose body is the message, matching `invoke`'s reject.
struct CommandError(String);

impl IntoResponse for CommandError {
    fn into_response(self) -> Response {
        (StatusCode::INTERNAL_SERVER_ERROR, self.0).into_response()
    }
}

impl From<String> for CommandError {
    fn from(message: String) -> Self {
        Self(message)
    }
}

type CommandResult = Result<Json<Value>, CommandError>;

fn ok<T: serde::Serialize>(value: T) -> CommandResult {
    Ok(Json(serde_json::to_value(value).map_err(|error| CommandError(error.to_string()))?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoPath {
    repo_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathArg {
    path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BranchArgs {
    repo_path: String,
    branch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanupArgs {
    repo_path: String,
    options: CleanupOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompareArgs {
    repo_path: String,
    base_ref: String,
    head_ref: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReferenceArgs {
    repo_path: String,
    reference: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffFileArgs {
    repo_path: String,
    base_sha: String,
    head_sha: String,
    old_path: Option<String>,
    new_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RebaseArgs {
    repo_path: String,
    onto: String,
    upstream: String,
    branch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UndoArgs {
    repo_path: String,
    updates: Vec<RefUpdate>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeArgs {
    path: String,
    target: String,
}

/// Git work is blocking, so each command runs on the blocking pool rather than stalling the runtime.
async fn blocking<T, F>(task: F) -> Result<T, CommandError>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(task)
        .await
        .map_err(|error| CommandError(error.to_string()))?
        .map_err(CommandError)
}

pub async fn serve(options: Options) -> Result<(), String> {
    if asset("index.html").is_none() {
        return Err("The web assets are missing. Build the frontend before serving.".to_string());
    }

    let state = Arc::new(ServerState {
        open_worktrees: OpenWorktrees::default(),
        token: options.token.clone(),
    });

    let api = Router::new()
        .route("/recent_projects", post(recent_projects))
        .route("/project_snapshot", post(project_snapshot))
        .route("/open_repository", post(open_repository))
        .route("/open_worktree", post(open_worktree))
        .route("/list_directory", post(list_directory))
        .route("/inferred_squash_merge_edges", post(inferred_squash_merge_edges))
        .route("/fetch_and_sync_pull_requests", post(fetch_and_sync_pull_requests))
        .route("/squashed_branch_candidates", post(squashed_branch_candidates))
        .route("/preview_cleanup_candidates", post(preview_cleanup_candidates))
        .route("/delete_squashed_branches", post(delete_squashed_branches))
        .route("/delete_branch", post(delete_branch))
        .route("/compare_refs", post(compare_refs))
        .route("/reference_picker_commits", post(reference_picker_commits))
        .route("/select_branch_range", post(select_branch_range))
        .route("/diff_file", post(diff_file))
        .route("/predict_rebase_conflicts", post(predict_rebase_conflicts))
        .route("/branch_operation_state", post(branch_operation_state))
        .route("/rebase_onto", post(rebase_onto))
        .route("/undo_ref_updates", post(undo_ref_updates))
        .route("/branch_sync", post(branch_sync))
        .route("/worktree_status", post(worktree_status))
        .route("/repository_state", post(repository_state))
        .route("/stash_list", post(stash_list))
        .route("/repository_fingerprint", post(repository_fingerprint))
        .route("/stream_commit_graph", get(stream_commit_graph));

    let app = Router::new()
        .nest("/api", api)
        .fallback(get(static_asset))
        .layer(middleware::from_fn_with_state(state.clone(), authenticate))
        // The default predicate skips SSE, but the commit graph stream is the payload that most
        // needs compressing: it gzips roughly ten to one.
        .layer(CompressionLayer::new().compress_when(
            SizeAbove::new(512)
                .and(NotForContentType::GRPC)
                .and(NotForContentType::IMAGES),
        ))
        .with_state(state);

    let address = SocketAddr::new(options.host, options.port);
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|error| format!("Could not bind {address}: {error}"))?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;

    println!("Git Nav is serving at {}", entry_url(&address, options.token.as_deref()));
    if options.host == IpAddr::V4(Ipv4Addr::LOCALHOST) {
        println!("Pass --host 0.0.0.0 to reach it from other devices on your network.");
    }

    axum::serve(listener, app)
        .await
        .map_err(|error| error.to_string())
}

fn entry_url(address: &SocketAddr, token: Option<&str>) -> String {
    let host = match address.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => local_address(),
        ip => ip.to_string(),
    };
    let base = format!("http://{host}:{}", address.port());
    match token {
        Some(token) => format!("{base}/?token={token}"),
        None => base,
    }
}

/// Reports the address a LAN client should use when the listener is bound to every interface.
fn local_address() -> String {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| {
            socket.connect("192.168.0.1:80")?;
            socket.local_addr()
        })
        .map(|address| address.ip().to_string())
        .unwrap_or_else(|_| "localhost".to_string())
}

fn cookie_token(request: &Request) -> Option<String> {
    request
        .headers()
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == TOKEN_COOKIE)
        .map(|(_, value)| value.to_string())
}

fn query_token(request: &Request) -> Option<String> {
    let query = request.uri().query()?;
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(name, _)| name == "token")
        .map(|(_, value)| value.into_owned())
}

/// Accepts `?token=` once and pins it to a cookie so `EventSource`, which cannot set headers, works.
async fn authenticate(
    State(state): State<Arc<ServerState>>,
    request: Request,
    next: Next,
) -> Response {
    let Some(expected) = state.token.clone() else {
        return next.run(request).await;
    };

    if cookie_token(&request).as_deref() == Some(expected.as_str()) {
        return next.run(request).await;
    }

    if query_token(&request).as_deref() == Some(expected.as_str()) {
        let mut response = next.run(request).await;
        if let Ok(cookie) = HeaderValue::from_str(&format!(
            "{TOKEN_COOKIE}={expected}; Path=/; SameSite=Lax; Max-Age=31536000"
        )) {
            response.headers_mut().insert(header::SET_COOKIE, cookie);
        }
        return response;
    }

    (StatusCode::UNAUTHORIZED, "Add ?token=… to the URL to open Git Nav.").into_response()
}

async fn static_asset(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let Some(contents) = asset(path) else {
        // Unknown paths fall through to the SPA so `/?repository=…` deep links load.
        return index_html();
    };
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let cache = if path == "index.html" {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    };
    (
        [
            (header::CONTENT_TYPE, mime.as_ref()),
            (header::CACHE_CONTROL, cache),
        ],
        contents,
    )
        .into_response()
}

fn index_html() -> Response {
    match asset("index.html") {
        Some(contents) => (
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            contents,
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "Missing index.html").into_response(),
    }
}

async fn recent_projects(State(state): State<Arc<ServerState>>) -> CommandResult {
    ok(recent_project_list(&state.open_worktrees)?)
}

async fn project_snapshot(
    State(state): State<Arc<ServerState>>,
    Json(args): Json<PathArg>,
) -> CommandResult {
    let path = args.path.unwrap_or_default();
    ok(project_at(&path, &state.open_worktrees)?)
}

/// The browser cannot open a window from the server, so it gets the path back and navigates itself.
async fn open_repository(
    State(state): State<Arc<ServerState>>,
    Json(args): Json<PathArg>,
) -> CommandResult {
    let path = args.path.unwrap_or_default();
    let project = remember_repository(&path, &state.open_worktrees)?;
    ok(json!({ "path": project.path }))
}

async fn open_worktree(
    State(state): State<Arc<ServerState>>,
    Json(args): Json<WorktreeArgs>,
) -> CommandResult {
    if args.target == "git-nav" {
        let project = remember_repository(&args.path, &state.open_worktrees)?;
        return ok(json!({ "path": project.path }));
    }
    launch_worktree(&args.path, &args.target)?;
    ok(json!({ "path": args.path }))
}

async fn list_directory(Json(args): Json<PathArg>) -> CommandResult {
    ok(blocking(move || directory_listing(args.path.as_deref())).await?)
}

async fn branch_sync(Json(args): Json<RepoPath>) -> CommandResult {
    ok(blocking(move || crate::branch_sync(args.repo_path)).await?)
}

async fn worktree_status(Json(args): Json<RepoPath>) -> CommandResult {
    ok(blocking(move || crate::worktree_status(args.repo_path)).await?)
}

async fn repository_state(Json(args): Json<RepoPath>) -> CommandResult {
    ok(blocking(move || crate::repository_state(args.repo_path)).await?)
}

async fn stash_list(Json(args): Json<RepoPath>) -> CommandResult {
    ok(blocking(move || crate::stash_list(args.repo_path)).await?)
}

async fn repository_fingerprint(Json(args): Json<RepoPath>) -> CommandResult {
    ok(blocking(move || Ok(crate::repository_fingerprint(args.repo_path))).await?)
}

async fn inferred_squash_merge_edges(Json(args): Json<RepoPath>) -> CommandResult {
    let Ok(database_path) = pull_request_database_path() else {
        return ok(Vec::<(String, String)>::new());
    };
    let edges = tokio::task::spawn_blocking(move || {
        inferred_squash_merges(&args.repo_path, database_path)
    })
    .await
    .unwrap_or_default();
    ok(edges)
}

async fn fetch_and_sync_pull_requests(Json(args): Json<RepoPath>) -> CommandResult {
    let database_path = pull_request_database_path()?;
    blocking(move || fetch_and_sync_repository(&args.repo_path, database_path)).await?;
    ok(Value::Null)
}

async fn squashed_branch_candidates(Json(args): Json<RepoPath>) -> CommandResult {
    let database_path = pull_request_database_path()?;
    ok(blocking(move || merged_branch_candidates(&args.repo_path, database_path)).await?)
}

async fn preview_cleanup_candidates(Json(args): Json<CleanupArgs>) -> CommandResult {
    let database_path = cleanup_database_path(&args.options)?;
    ok(blocking(move || cleanup_candidates(&args.repo_path, &args.options, database_path)).await?)
}

async fn delete_squashed_branches(Json(args): Json<CleanupArgs>) -> CommandResult {
    let database_path = cleanup_database_path(&args.options)?;
    ok(
        blocking(move || delete_cleanup_candidates(&args.repo_path, &args.options, database_path))
            .await?,
    )
}

async fn delete_branch(Json(args): Json<BranchArgs>) -> CommandResult {
    blocking(move || {
        git_output_allow_empty(&args.repo_path, &["branch", "-D", "--", &args.branch]).map(|_| ())
    })
    .await?;
    ok(Value::Null)
}

async fn compare_refs(Json(args): Json<CompareArgs>) -> CommandResult {
    ok(blocking(move || comparison(&args.repo_path, &args.base_ref, &args.head_ref)).await?)
}

async fn reference_picker_commits(Json(args): Json<RepoPath>) -> CommandResult {
    ok(blocking(move || picker_commits(&args.repo_path)).await?)
}

async fn select_branch_range(Json(args): Json<ReferenceArgs>) -> CommandResult {
    ok(blocking(move || branch_range(&args.repo_path, &args.reference)).await?)
}

async fn diff_file(Json(args): Json<DiffFileArgs>) -> CommandResult {
    ok(blocking(move || {
        file_diff(
            &args.repo_path,
            &args.base_sha,
            &args.head_sha,
            args.old_path,
            args.new_path,
        )
    })
    .await?)
}

async fn predict_rebase_conflicts(Json(args): Json<RebaseArgs>) -> CommandResult {
    ok(blocking(move || {
        predicted_conflicts(&args.repo_path, &args.onto, &args.upstream, &args.branch)
    })
    .await?)
}

async fn branch_operation_state(Json(args): Json<BranchArgs>) -> CommandResult {
    ok(blocking(move || branch_operability(&args.repo_path, &args.branch)).await?)
}

async fn rebase_onto(Json(args): Json<RebaseArgs>) -> CommandResult {
    ok(blocking(move || {
        rebase_branch_onto(&args.repo_path, &args.onto, &args.upstream, &args.branch)
    })
    .await?)
}

async fn undo_ref_updates(Json(args): Json<UndoArgs>) -> CommandResult {
    blocking(move || restore_refs(&args.repo_path, &args.updates)).await?;
    ok(Value::Null)
}

/// Streams commit batches as SSE, standing in for the Tauri `Channel` the desktop app uses.
async fn stream_commit_graph(Query(args): Query<HashMap<String, String>>) -> Response {
    let Some(repo_path) = args.get("repoPath").cloned() else {
        return (StatusCode::BAD_REQUEST, "repoPath is required.").into_response();
    };

    let (sender, receiver) = mpsc::channel::<String>(4);
    tokio::task::spawn_blocking(move || {
        let result = walk_commit_graph(&repo_path, |batch| {
            let payload = serde_json::to_string(&batch).map_err(|error| error.to_string())?;
            sender
                .blocking_send(format!("event: batch\ndata: {payload}\n\n"))
                .map_err(|_| "The client disconnected.".to_string())
        });
        let closing = match result {
            Ok(()) => "event: done\ndata: {}\n\n".to_string(),
            Err(error) => {
                let error = serde_json::to_string(&error).unwrap_or_else(|_| "\"\"".to_string());
                format!("event: failed\ndata: {error}\n\n")
            }
        };
        let _ = sender.blocking_send(closing);
    });

    let stream = ReceiverStream::new(receiver).map(Ok::<String, std::convert::Infallible>);

    (
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-cache"),
            (header::CONNECTION, "keep-alive"),
        ],
        Body::from_stream(stream),
    )
        .into_response()
}
