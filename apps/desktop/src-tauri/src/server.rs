//! Serves the same commands the Tauri webview invokes over HTTP so a browser can drive the app.

use axum::{
    body::Body,
    extract::{Query, Request, State},
    http::{header, HeaderValue, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, MethodRouter},
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
    IpcCommand,
    OpenWorktrees,
    directory_listing,
    launch_worktree,
    project_at,
    recent_project_list,
    remember_repository,
    walk_commit_graph_page,
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
pub(crate) struct CommandError(String);

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

pub(crate) type CommandResult = Result<Json<Value>, CommandError>;

pub(crate) fn ok<T: serde::Serialize>(value: T) -> CommandResult {
    Ok(Json(serde_json::to_value(value).map_err(|error| CommandError(error.to_string()))?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathArg {
    path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeArgs {
    path: String,
    target: String,
}

/// Git work is blocking, so each command runs on the blocking pool rather than stalling the runtime.
pub(crate) async fn blocking<T, F>(task: F) -> Result<T, CommandError>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(task)
        .await
        .map_err(|error| CommandError(error.to_string()))?
        .map_err(CommandError)
}

/// Whether a command is reachable over HTTP. The match is exhaustive over every declared command,
/// so adding one without deciding how the browser reaches it is a compile error rather than a 405.
enum Exposure {
    Api(MethodRouter<Arc<ServerState>>),
    /// Acts on the machine running the app, so it has no meaning for a remote browser.
    DesktopOnly,
}

fn exposure(command: &IpcCommand) -> Exposure {
    match command {
        IpcCommand::recent_projects => Exposure::Api(post(recent_projects)),
        IpcCommand::clear_recent_projects => Exposure::Api(post(clear_recent_projects)),
        IpcCommand::open_repository => Exposure::Api(post(open_repository)),
        IpcCommand::show_launcher | IpcCommand::choose_repository | IpcCommand::zoom => {
            Exposure::DesktopOnly
        }
        IpcCommand::update_command => Exposure::DesktopOnly,
        IpcCommand::open_worktree => Exposure::Api(post(open_worktree)),
        IpcCommand::open_url => Exposure::DesktopOnly,
        IpcCommand::project_snapshot => Exposure::Api(post(project_snapshot)),
        IpcCommand::stream_commit_graph => Exposure::Api(get(stream_commit_graph)),
        IpcCommand::repository_fingerprint => Exposure::Api(post(crate::__http_repository_fingerprint)),
        IpcCommand::branch_sync => Exposure::Api(post(crate::__http_branch_sync)),
        IpcCommand::worktree_status => Exposure::Api(post(crate::__http_worktree_status)),
        IpcCommand::inferred_squash_merge_edges => Exposure::Api(post(crate::__http_inferred_squash_merge_edges)),
        IpcCommand::fetch_and_sync_pull_requests => Exposure::Api(post(crate::__http_fetch_and_sync_pull_requests)),
        IpcCommand::branch_pull_requests => Exposure::Api(post(crate::__http_branch_pull_requests)),
        IpcCommand::squashed_branch_candidates => Exposure::Api(post(crate::__http_squashed_branch_candidates)),
        IpcCommand::preview_cleanup_candidates => Exposure::Api(post(crate::__http_preview_cleanup_candidates)),
        IpcCommand::delete_squashed_branches => Exposure::Api(post(crate::__http_delete_squashed_branches)),
        IpcCommand::delete_branch => Exposure::Api(post(crate::__http_delete_branch)),
        IpcCommand::compare_refs => Exposure::Api(post(crate::__http_compare_refs)),
        IpcCommand::reference_picker_commits => Exposure::Api(post(crate::__http_reference_picker_commits)),
        IpcCommand::repository_references => Exposure::Api(post(crate::__http_repository_references)),
        IpcCommand::resolve_revision => Exposure::Api(post(crate::__http_resolve_revision)),
        IpcCommand::select_branch_range => Exposure::Api(post(crate::__http_select_branch_range)),
        IpcCommand::diff_file => Exposure::Api(post(crate::__http_diff_file)),
        IpcCommand::predict_rebase_conflicts => Exposure::Api(post(crate::__http_predict_rebase_conflicts)),
        IpcCommand::branch_operation_state => Exposure::Api(post(crate::__http_branch_operation_state)),
        IpcCommand::repository_state => Exposure::Api(post(crate::__http_repository_state)),
        IpcCommand::merge_base => Exposure::Api(post(crate::__http_merge_base)),
        IpcCommand::rebase_onto => Exposure::Api(post(crate::__http_rebase_onto)),
        IpcCommand::checkout_ref => Exposure::Api(post(crate::__http_checkout_ref)),
        IpcCommand::push_ref => Exposure::Api(post(crate::__http_push_ref)),
        IpcCommand::pull_branch => Exposure::Api(post(crate::__http_pull_branch)),
        IpcCommand::merge_ref => Exposure::Api(post(crate::__http_merge_ref)),
        IpcCommand::predict_merge_conflicts => Exposure::Api(post(crate::__http_predict_merge_conflicts)),
        IpcCommand::predict_revert_conflicts => Exposure::Api(post(crate::__http_predict_revert_conflicts)),
        IpcCommand::create_branch => Exposure::Api(post(crate::__http_create_branch)),
        IpcCommand::rename_branch => Exposure::Api(post(crate::__http_rename_branch)),
        IpcCommand::create_tag => Exposure::Api(post(crate::__http_create_tag)),
        IpcCommand::delete_tag => Exposure::Api(post(crate::__http_delete_tag)),
        IpcCommand::cherry_pick_range => Exposure::Api(post(crate::__http_cherry_pick_range)),
        IpcCommand::revert_range => Exposure::Api(post(crate::__http_revert_range)),
        IpcCommand::reset_current => Exposure::Api(post(crate::__http_reset_current)),
        IpcCommand::stash_list => Exposure::Api(post(crate::__http_stash_list)),
        IpcCommand::stash_changes => Exposure::Api(post(crate::__http_stash_changes)),
        IpcCommand::stash_action => Exposure::Api(post(crate::__http_stash_action)),
        IpcCommand::undo_ref_updates => Exposure::Api(post(crate::__http_undo_ref_updates)),
        IpcCommand::settings => Exposure::Api(post(settings)),
        IpcCommand::set_setting => Exposure::Api(post(set_setting)),
        IpcCommand::repository_layout => Exposure::Api(post(repository_layout)),
        IpcCommand::save_repository_layout => Exposure::Api(post(save_repository_layout)),
    }
}

pub async fn serve(options: Options) -> Result<(), String> {
    if asset("index.html").is_none() {
        return Err("The web assets are missing. Build the frontend before serving.".to_string());
    }

    let state = Arc::new(ServerState {
        open_worktrees: OpenWorktrees::default(),
        token: options.token.clone(),
    });

    // Only the browser needs a folder picker; the desktop app uses the native dialog.
    let mut api = Router::new().route("/list_directory", post(list_directory));
    for command in IpcCommand::ALL {
        if let Exposure::Api(route) = exposure(command) {
            api = api.route(&format!("/{}", command.name()), route);
        }
    }

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

async fn clear_recent_projects() -> CommandResult {
    ok(blocking(|| crate::clear_recent_paths(None)).await?)
}

async fn settings() -> CommandResult {
    ok(crate::load_settings()?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingArgs {
    key: String,
    value: Value,
}

async fn set_setting(Json(args): Json<SettingArgs>) -> CommandResult {
    ok(blocking(move || crate::save_setting(args.key, args.value)).await?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryLayoutArgs {
    path: String,
    client_id: String,
}

async fn repository_layout(Json(args): Json<RepositoryLayoutArgs>) -> CommandResult {
    ok(blocking(move || crate::load_repository_layout(args.path, args.client_id)).await?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveRepositoryLayoutArgs {
    path: String,
    client_id: String,
    layout: Value,
}

async fn save_repository_layout(Json(args): Json<SaveRepositoryLayoutArgs>) -> CommandResult {
    ok(
        blocking(move || crate::save_repository_layout(args.path, args.client_id, args.layout))
            .await?,
    )
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
    let project = remember_repository(&path, &state.open_worktrees, None)?;
    ok(json!({ "path": project.path }))
}

async fn open_worktree(
    State(state): State<Arc<ServerState>>,
    Json(args): Json<WorktreeArgs>,
) -> CommandResult {
    if args.target == "git-nav" {
        let project = remember_repository(&args.path, &state.open_worktrees, None)?;
        return ok(json!({ "path": project.path }));
    }
    launch_worktree(&args.path, &args.target)?;
    ok(json!({ "path": args.path }))
}

async fn list_directory(Json(args): Json<PathArg>) -> CommandResult {
    ok(blocking(move || directory_listing(args.path.as_deref())).await?)
}



































/// Streams commit batches as SSE, standing in for the Tauri `Channel` the desktop app uses.
async fn stream_commit_graph(Query(args): Query<HashMap<String, String>>) -> Response {
    let Some(repo_path) = args.get("repoPath").cloned() else {
        return (StatusCode::BAD_REQUEST, "repoPath is required.").into_response();
    };
    let offset = match args.get("offset").map(|value| value.parse::<usize>()) {
        Some(Ok(value)) => value,
        Some(Err(_)) => return (StatusCode::BAD_REQUEST, "offset must be a non-negative integer.").into_response(),
        None => 0,
    };
    let limit = match args.get("limit").map(|value| value.parse::<usize>()) {
        Some(Ok(0) | Err(_)) => return (StatusCode::BAD_REQUEST, "limit must be a positive integer.").into_response(),
        Some(Ok(value)) => value,
        None => 2_000,
    };

    let (sender, receiver) = mpsc::channel::<String>(4);
    tokio::task::spawn_blocking(move || {
        let result = walk_commit_graph_page(&repo_path, offset, limit, |batch| {
            let payload = serde_json::to_string(&batch).map_err(|error| error.to_string())?;
            sender
                .blocking_send(format!("event: batch\ndata: {payload}\n\n"))
                .map_err(|_| "The client disconnected.".to_string())
        });
        let closing = match result {
            Ok(has_more) => format!("event: done\ndata: {{\"hasMore\":{has_more}}}\n\n"),
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
