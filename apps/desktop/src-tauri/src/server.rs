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
use futures_util::{FutureExt, StreamExt};
use serde::Deserialize;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
};
use tokio::sync::{mpsc, oneshot};
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

#[derive(Clone)]
pub(crate) struct Options {
    pub host: IpAddr,
    pub port: u16,
    pub token: Option<String>,
    pub public_url: Option<String>,
}

struct ServerState {
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
        // A browser cannot put anything on the path of the machine it is reading.
        IpcCommand::command_line_link | IpcCommand::install_command_line_link => {
            Exposure::DesktopOnly
        }
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
        IpcCommand::viewed_files => Exposure::Api(post(crate::__http_viewed_files)),
        IpcCommand::set_file_viewed => Exposure::Api(post(crate::__http_set_file_viewed)),
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
        IpcCommand::start_sharing
        | IpcCommand::stop_sharing
        | IpcCommand::sharing_state
        | IpcCommand::rotate_sharing_token
        | IpcCommand::update_sharing_setting => {
            Exposure::DesktopOnly
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SharingState {
    pub sharing: bool,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub entry_urls: Vec<String>,
}

pub(crate) struct RunningServer {
    options: Options,
    state: SharingState,
    shutdown: Option<oneshot::Sender<()>>,
    released: Option<std::sync::mpsc::Receiver<()>>,
}

impl RunningServer {
    pub(crate) fn options(&self) -> &Options {
        &self.options
    }

    pub(crate) fn state(&self) -> SharingState {
        self.state.clone()
    }

    /// Waits for the listener socket to close, reporting whether it did. A false return leaves the
    /// port bound; the kernel can still refuse a rebind for a few milliseconds after a true one.
    #[must_use]
    pub(crate) fn stop(mut self) -> bool {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        let Some(released) = self.released.take() else {
            return true;
        };
        // A disconnect means the server task ended without ever serving, which drops the listener
        // just the same.
        !matches!(
            released.recv_timeout(std::time::Duration::from_secs(5)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        )
    }
}

/// Signals when the listener has actually closed. Axum drops the listener as soon as the graceful
/// shutdown signal fires, so the port frees before in-flight connections finish draining.
struct WatchedListener {
    listener: Option<tokio::net::TcpListener>,
    released: std::sync::mpsc::Sender<()>,
}

impl Drop for WatchedListener {
    fn drop(&mut self) {
        self.listener.take();
        let _ = self.released.send(());
    }
}

impl axum::serve::Listener for WatchedListener {
    type Io = tokio::net::TcpStream;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let listener = self.listener.as_mut().expect("listener is only taken on drop");
        axum::serve::Listener::accept(listener).await
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.listener.as_ref().expect("listener is only taken on drop").local_addr()
    }
}

struct BoundServer {
    options: Options,
    state: SharingState,
    listener: std::net::TcpListener,
    router: Router,
}

// Binding synchronously lets the single-instance callback start a server from inside the async
// runtime, where block_on panics.
fn bind(options: Options, open_worktrees: OpenWorktrees) -> Result<BoundServer, String> {
    // The assets are embedded from a frontend build that a bare `cargo test` never runs, and the
    // tests that bind a server are about the listener rather than what it serves.
    if !cfg!(test) && asset("index.html").is_none() {
        return Err("The web assets are missing. Build the frontend before serving.".to_string());
    }

    let state = Arc::new(ServerState {
        open_worktrees,
        token: options.token.clone(),
    });

    // Only the browser needs a folder picker; the desktop app uses the native dialog.
    let mut api = Router::new().route("/list_directory", post(list_directory));
    for command in IpcCommand::ALL {
        if let Exposure::Api(route) = exposure(command) {
            api = api.route(&format!("/{}", command.name()), route);
        }
    }

    let router = Router::new()
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
    let listener = std::net::TcpListener::bind(address).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AddrInUse {
            format!("Port {} is already in use.", options.port)
        } else {
            format!("Could not bind port {}: {error}", options.port)
        }
    })?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;
    let state = SharingState {
        sharing: true,
        host: Some(address.ip().to_string()),
        port: Some(address.port()),
        entry_urls: entry_urls(&address, options.token.as_deref(), options.public_url.as_deref()),
    };
    Ok(BoundServer {
        options,
        state,
        listener,
        router,
    })
}

pub(crate) fn start(options: Options, open_worktrees: OpenWorktrees) -> Result<RunningServer, String> {
    let BoundServer { options, state, listener, router } = bind(options, open_worktrees)?;
    let (shutdown, stopped) = oneshot::channel();
    let (released_sender, released) = std::sync::mpsc::channel();
    let stopped = async { let _ = stopped.await; }.shared();
    tauri::async_runtime::spawn(async move {
        let result = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => {
                let listener = WatchedListener { listener: Some(listener), released: released_sender };
                let server = axum::serve(listener, router).with_graceful_shutdown(stopped.clone());
                tokio::select! {
                    result = server => result.map_err(|error| error.to_string()),
                    _ = async move {
                        stopped.await;
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    } => {
                        log::warn!("Git Nav sharing server did not shut down within five seconds.");
                        Ok(())
                    }
                }
            }
            Err(error) => Err(error.to_string()),
        };
        if let Err(error) = result {
            log::error!("Git Nav sharing server stopped unexpectedly: {error}");
        }
    });
    Ok(RunningServer { options, state, shutdown: Some(shutdown), released: Some(released) })
}

pub async fn serve(options: Options) -> Result<(), String> {
    let BoundServer { state, listener, router, .. } = bind(options, OpenWorktrees::default())?;
    for url in &state.entry_urls {
        println!("Git Nav is serving at {url}");
    }
    if state.host.as_deref() == Some("127.0.0.1") {
        println!("Pass --host 0.0.0.0 to reach it from other devices on your network.");
    }
    let listener = tokio::net::TcpListener::from_std(listener).map_err(|error| error.to_string())?;
    axum::serve(listener, router)
        .await
        .map_err(|error| error.to_string())
}

fn entry_urls(
    address: &SocketAddr,
    token: Option<&str>,
    public_url: Option<&str>,
) -> Vec<String> {
    if let Some(public_url) = public_url {
        if let Some(public_url) = public_entry_url(public_url) {
            return vec![append_token(public_url, token)];
        }
        eprintln!("Ignoring invalid serve.publicUrl: {public_url}");
    }

    let addresses = match address.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => local_addresses()
            .into_iter()
            .map(IpAddr::V4)
            .collect(),
        ip => vec![ip],
    };
    let addresses = if addresses.is_empty() {
        vec![IpAddr::V4(Ipv4Addr::LOCALHOST)]
    } else {
        addresses
    };
    addresses
        .into_iter()
        .map(|ip| append_token(format!("http://{}", SocketAddr::new(ip, address.port())), token))
        .collect()
}

pub(crate) fn public_entry_url(value: &str) -> Option<String> {
    let mut url = url::Url::parse(value).ok()?;
    if url.host_str().is_none() || !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string().trim_end_matches('/').to_string())
}

fn append_token(base: String, token: Option<&str>) -> String {
    if let Some(token) = token {
        match url::Url::parse(&base) {
            Ok(mut url) => {
                url.query_pairs_mut().append_pair("token", token);
                url.to_string()
            }
            Err(error) => {
                eprintln!("Could not add the token to server entry URL {base}: {error}");
                base
            }
        }
    } else {
        base
    }
}

pub(crate) fn local_addresses() -> Vec<Ipv4Addr> {
    let addresses = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .map(|interface| interface.ip());
    non_loopback_ipv4_addresses(addresses, primary_local_address())
}

fn non_loopback_ipv4_addresses(
    addresses: impl IntoIterator<Item = IpAddr>,
    primary: Option<Ipv4Addr>,
) -> Vec<Ipv4Addr> {
    let mut addresses = addresses
        .into_iter()
        .filter_map(|address| match address {
            IpAddr::V4(address) if !address.is_loopback() && !address.is_unspecified() => Some(address),
            _ => None,
        })
        .collect();
    order_local_addresses(&mut addresses, primary);
    addresses
}

fn order_local_addresses(addresses: &mut Vec<Ipv4Addr>, primary: Option<Ipv4Addr>) {
    addresses.sort_unstable();
    addresses.dedup();
    if let Some(primary) = primary {
        if let Some(index) = addresses.iter().position(|address| *address == primary) {
            addresses.swap(0, index);
        }
    }
}

fn primary_local_address() -> Option<Ipv4Addr> {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| {
            socket.connect("192.168.0.1:80")?;
            socket.local_addr()
        })
        .ok()
        .and_then(|address| match address.ip() {
            IpAddr::V4(address) if !address.is_loopback() => Some(address),
            _ => None,
        })
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
        let secure = request_is_https(&request);
        let mut response = next.run(request).await;
        if let Ok(cookie) = HeaderValue::from_str(&auth_cookie(&expected, secure)) {
            response.headers_mut().insert(header::SET_COOKIE, cookie);
        }
        return response;
    }

    (StatusCode::UNAUTHORIZED, "Add ?token=… to the URL to open Git Nav.").into_response()
}

fn request_is_https(request: &Request) -> bool {
    // TLS-terminating proxies set this header, so it is trusted to mark the auth cookie Secure.
    request
        .headers()
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(',').any(|value| value.trim().eq_ignore_ascii_case("https")))
}

fn auth_cookie(token: &str, secure: bool) -> String {
    let secure = if secure { "; Secure" } else { "" };
    format!("{TOKEN_COOKIE}={token}; Path=/; SameSite=Lax; HttpOnly; Max-Age=31536000{secure}")
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
    let mut settings = crate::load_settings()?;
    redact_network_sharing_settings(&mut settings);
    ok(settings)
}

fn redact_network_sharing_settings(settings: &mut BTreeMap<String, Value>) {
    settings.retain(|key, _| !key.starts_with("serve."));
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingArgs {
    key: String,
    value: Value,
}

async fn set_setting(Json(args): Json<SettingArgs>) -> Response {
    if args.key.starts_with("serve.") {
        return (
            StatusCode::FORBIDDEN,
            "Network sharing settings cannot be changed over HTTP. Change them on the machine running the server.",
        )
            .into_response();
    }
    match blocking(move || crate::save_setting(args.key, args.value)).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.into_response(),
    }
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
        blocking(move || {
            crate::save_repository_layout(args.path, args.client_id, args.layout)
        })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_addresses_are_deduplicated_and_put_the_primary_first() {
        let primary = Ipv4Addr::new(10, 0, 0, 4);
        let mut addresses = vec![
            Ipv4Addr::new(192, 168, 1, 3),
            primary,
            Ipv4Addr::new(192, 168, 1, 3),
        ];

        order_local_addresses(&mut addresses, Some(primary));

        assert_eq!(
            addresses,
            vec![primary, Ipv4Addr::new(192, 168, 1, 3)]
        );
    }

    #[test]
    fn address_enumeration_excludes_loopback_and_ipv6() {
        let addresses = non_loopback_ipv4_addresses(
            [
                IpAddr::V4(Ipv4Addr::LOCALHOST),
                IpAddr::V6("::1".parse().unwrap()),
                IpAddr::V4(Ipv4Addr::new(192, 168, 1, 3)),
            ],
            None,
        );

        assert_eq!(addresses, vec![Ipv4Addr::new(192, 168, 1, 3)]);
    }

    #[test]
    fn public_url_replaces_the_listener_url() {
        let urls = entry_urls(
            &SocketAddr::from(([0, 0, 0, 0], 4300)),
            Some("secret"),
            Some("https://git-nav.example"),
        );

        assert_eq!(urls, vec!["https://git-nav.example/?token=secret"]);
    }

    #[test]
    fn entry_url_encodes_the_token() {
        let urls = entry_urls(
            &SocketAddr::from(([127, 0, 0, 1], 4300)),
            Some("a&b#c=d"),
            None,
        );
        let url = url::Url::parse(&urls[0]).unwrap();

        assert_eq!(
            url.query_pairs().find(|(key, _)| key == "token").unwrap().1,
            "a&b#c=d"
        );
    }

    #[test]
    fn ipv6_entry_url_is_bracketed() {
        let urls = entry_urls(
            &SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], 4300)),
            Some("secret"),
            None,
        );

        assert_eq!(urls, vec!["http://[::1]:4300/?token=secret"]);
    }

    #[test]
    fn ephemeral_port_keeps_the_requested_option_and_reports_the_bound_port() {
        let bound = bind(
            Options {
                host: IpAddr::V4(Ipv4Addr::LOCALHOST),
                port: 0,
                token: None,
                public_url: None,
            },
            OpenWorktrees::default(),
        )
        .unwrap();

        assert_eq!(bound.options.port, 0);
        assert!(bound.state.port.is_some_and(|port| port != 0));
    }

    fn local_options(port: u16) -> Options {
        Options {
            host: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port,
            token: None,
            public_url: None,
        }
    }

    #[test]
    fn stopping_waits_for_the_listener_to_close() {
        let server = start(local_options(0), OpenWorktrees::default()).unwrap();

        // Jam every runtime worker so the server task cannot close its listener promptly; a stop()
        // that gave up on the release instead of waiting for it would report false here.
        for _ in 0..64 {
            tauri::async_runtime::spawn(async {
                std::thread::sleep(std::time::Duration::from_millis(100));
            });
        }
        std::thread::sleep(std::time::Duration::from_millis(50));

        assert!(server.stop());
    }

    #[test]
    fn authentication_cookie_is_secure_for_forwarded_https() {
        let request = Request::builder()
            .header("x-forwarded-proto", "https")
            .body(Body::empty())
            .unwrap();

        assert!(request_is_https(&request));
        assert!(auth_cookie("secret", request_is_https(&request)).ends_with("; Secure"));
        assert!(!auth_cookie("secret", false).ends_with("; Secure"));
        assert!(auth_cookie("secret", false).contains("; HttpOnly"));
    }

    #[tokio::test]
    async fn remote_clients_cannot_change_network_sharing_settings() {
        let response = set_setting(Json(SettingArgs {
            key: "serve.token".to_string(),
            value: json!("replacement"),
        }))
        .await;

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn remote_clients_cannot_read_network_sharing_settings() {
        let mut settings = BTreeMap::from([
            ("graph.layout".to_string(), json!("vertical")),
            ("serve.host".to_string(), json!("0.0.0.0")),
            ("serve.token".to_string(), json!("secret")),
        ]);

        redact_network_sharing_settings(&mut settings);

        assert_eq!(
            settings,
            BTreeMap::from([("graph.layout".to_string(), json!("vertical"))])
        );
    }
}
