//! Axum + WebSocket server for the `frogcode-web` binary.
//!
//! This module is only compiled into the `frogcode-web` binary. It reuses
//! the transport-agnostic command implementations from `commands::claude::*`
//! (the `_with_deps` variants) so the browser path runs the same streaming
//! logic as the desktop Tauri binary.
//!
//! High-level layout:
//!   * REST routes under `/api/*` mirror a minimal subset of the Tauri
//!     commands — projects, sessions, history, cancel, running sessions.
//!   * WebSocket route `/ws/exec` accepts execute/continue/resume requests
//!     and streams the emitted events back as JSON envelopes.
//!   * `/api/openclaw/*` is a transparent reverse proxy to the Node sidecar
//!     so the OpenClaw UI works unchanged.
//!   * Static frontend is served from an embedded copy of `dist/`.
//!
//! The `AppState` owns a fresh `ProcessRegistry` shared across all
//! connections — cancel goes through the same Arc as the execution path,
//! matching the desktop cancel semantics and avoiding opcode's "cancel is a
//! stub" pitfall.

use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket},
        Path as AxumPath, Query, State as AxumState, WebSocketUpgrade,
    },
    http::{header, HeaderMap, Method, Request, StatusCode, Uri},
    response::{Html, IntoResponse, Json, Response},
    routing::{any, get, post},
    Router,
};
use futures_util::{SinkExt, StreamExt};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Mutex as TokioMutex};
use tower_http::cors::{Any, CorsLayer};

use crate::commands;
use crate::commands::claude::{
    cancel_claude_execution_with_deps, continue_claude_code_with_deps,
    execute_claude_code_with_deps, resume_claude_code_with_deps, ClaudeSpawnDeps,
};
use crate::process::{ProcessRegistry, SharedEventSink, WsEventSink};

// ---------------------------------------------------------------------------
// Embedded frontend assets
// ---------------------------------------------------------------------------

#[derive(RustEmbed)]
#[folder = "../dist"]
struct Assets;

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

/// Shared state for all web handlers. Cloned cheaply into each request.
#[derive(Clone)]
pub struct WebAppState {
    /// Shared process registry — cancels go through the same Arc as spawns.
    pub registry: Arc<ProcessRegistry>,
    /// Legacy `current_process` slot, kept around for cancel fallback path.
    /// Web mode only uses ProcessRegistry as the authoritative source.
    pub current_process: Arc<TokioMutex<Option<tokio::process::Child>>>,
    /// Last spawned PID — another cancel fallback path.
    pub last_spawned_pid: Arc<TokioMutex<Option<u32>>>,
    /// App data dir (where `agents.db` and cached claude binary path live).
    pub data_dir: PathBuf,
    /// Base URL of the Node platform sidecar for OpenClaw proxying, e.g.
    /// `http://127.0.0.1:7890`. None disables the proxy.
    pub openclaw_base: Option<String>,
    /// Shared reqwest client used by the OpenClaw reverse proxy.
    pub http_client: reqwest::Client,
}

impl WebAppState {
    pub fn new(data_dir: PathBuf, openclaw_base: Option<String>) -> Self {
        // Construct the legacy fields as bare `Arc<Mutex<Option<...>>>` rather
        // than via `ClaudeProcessState::default()`. The reason is that
        // `ClaudeProcessState` has a `Drop` impl that calls `handle.block_on`,
        // which panics if it fires from inside a tokio runtime — and a
        // temporary `default()` value would be dropped at the end of this
        // function while `#[tokio::main]` is active, triggering exactly that.
        // On the desktop binary the singleton is only dropped at app exit
        // (outside the runtime) so it's fine there.
        Self {
            registry: Arc::new(ProcessRegistry::new()),
            current_process: Arc::new(TokioMutex::new(None)),
            last_spawned_pid: Arc::new(TokioMutex::new(None)),
            data_dir,
            openclaw_base,
            http_client: reqwest::Client::new(),
        }
    }

    /// Build a `ClaudeSpawnDeps` bound to the given per-connection event sink.
    fn claude_deps(&self, sink: SharedEventSink) -> ClaudeSpawnDeps {
        ClaudeSpawnDeps {
            sink,
            registry: self.registry.clone(),
            auto_compact: None, // Web mode: no auto-compaction background task.
            current_process: self.current_process.clone(),
            last_spawned_pid: self.last_spawned_pid.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// API response envelope
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl<T> ApiResponse<T> {
    pub fn ok(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
        }
    }
    pub fn err<E: ToString>(e: E) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(e.to_string()),
        }
    }
}

// ---------------------------------------------------------------------------
// Static frontend handlers
// ---------------------------------------------------------------------------

async fn serve_frontend() -> Response {
    match Assets::get("index.html") {
        Some(content) => Html(String::from_utf8_lossy(&content.data).into_owned()).into_response(),
        None => (StatusCode::NOT_FOUND, "index.html not embedded").into_response(),
    }
}

async fn serve_asset(AxumPath(path): AxumPath<String>) -> Response {
    let full_path = format!("assets/{}", path);
    match Assets::get(&full_path) {
        Some(content) => {
            let mime = mime_for(&path);
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, mime)],
                content.data.to_vec(),
            )
                .into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "js" | "mjs" => "application/javascript",
        "css" => "text/css",
        "html" => "text/html",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

// ---------------------------------------------------------------------------
// REST handlers
// ---------------------------------------------------------------------------

async fn rest_list_projects() -> Json<ApiResponse<Vec<commands::claude::Project>>> {
    match commands::claude::list_projects().await {
        Ok(v) => Json(ApiResponse::ok(v)),
        Err(e) => Json(ApiResponse::err(e)),
    }
}

async fn rest_get_project_sessions(
    AxumPath(project_id): AxumPath<String>,
) -> Json<ApiResponse<Vec<commands::claude::Session>>> {
    match commands::claude::get_project_sessions(project_id).await {
        Ok(v) => Json(ApiResponse::ok(v)),
        Err(e) => Json(ApiResponse::err(e)),
    }
}

async fn rest_load_session_history(
    AxumPath((session_id, project_id)): AxumPath<(String, String)>,
) -> Json<ApiResponse<Vec<serde_json::Value>>> {
    match commands::claude::load_session_history(session_id, project_id).await {
        Ok(v) => Json(ApiResponse::ok(v)),
        Err(e) => Json(ApiResponse::err(e)),
    }
}

async fn rest_list_running_claude_sessions(
    AxumState(state): AxumState<WebAppState>,
) -> Json<ApiResponse<Vec<crate::process::ProcessInfo>>> {
    match state.registry.get_running_claude_sessions() {
        Ok(v) => Json(ApiResponse::ok(v)),
        Err(e) => Json(ApiResponse::err(e)),
    }
}

#[derive(Deserialize)]
struct CancelRequest {
    session_id: Option<String>,
}

async fn rest_cancel_claude_execution(
    AxumState(state): AxumState<WebAppState>,
    Json(req): Json<CancelRequest>,
) -> Json<ApiResponse<()>> {
    // Cancel goes through a null sink — there's no WebSocket to forward
    // events to for a REST-triggered cancel. The events would be lost,
    // but the kill still happens via ProcessRegistry which is what matters.
    let sink: SharedEventSink = Arc::new(crate::process::NullEventSink);
    let deps = state.claude_deps(sink);
    match cancel_claude_execution_with_deps(deps, req.session_id).await {
        Ok(()) => Json(ApiResponse::ok(())),
        Err(e) => Json(ApiResponse::err(e)),
    }
}

async fn rest_get_claude_session_output(
    AxumState(state): AxumState<WebAppState>,
    AxumPath(session_id): AxumPath<String>,
) -> Json<ApiResponse<String>> {
    match state.registry.get_claude_session_by_id(&session_id) {
        Ok(Some(info)) => match state.registry.get_live_output(info.run_id) {
            Ok(out) => Json(ApiResponse::ok(out)),
            Err(e) => Json(ApiResponse::err(e)),
        },
        Ok(None) => Json(ApiResponse::ok(String::new())),
        Err(e) => Json(ApiResponse::err(e)),
    }
}

// ---------------------------------------------------------------------------
// Platform / Feishu config (shared with the desktop binary via
// `~/.frogcode/platform-config.json` + `~/.frogcode/agents/{type}.json`)
// ---------------------------------------------------------------------------

async fn rest_platform_get_config(
) -> Json<ApiResponse<commands::platform_bridge::FeishuConfig>> {
    match commands::platform_bridge::platform_get_config().await {
        Ok(v) => Json(ApiResponse::ok(v)),
        Err(e) => Json(ApiResponse::err(e)),
    }
}

#[derive(Deserialize)]
struct SaveFeishuConfigBody {
    config: commands::platform_bridge::FeishuConfig,
}

async fn rest_platform_save_config(
    Json(body): Json<SaveFeishuConfigBody>,
) -> Json<ApiResponse<()>> {
    match commands::platform_bridge::platform_save_config(body.config).await {
        Ok(()) => Json(ApiResponse::ok(())),
        Err(e) => Json(ApiResponse::err(e)),
    }
}

async fn rest_platform_get_agent_config(
    AxumPath(agent_type): AxumPath<String>,
) -> Json<ApiResponse<serde_json::Value>> {
    match commands::platform_bridge::platform_get_agent_config(agent_type).await {
        Ok(v) => Json(ApiResponse::ok(v)),
        Err(e) => Json(ApiResponse::err(e)),
    }
}

#[derive(Deserialize)]
struct SaveAgentConfigBody {
    config: serde_json::Value,
}

async fn rest_platform_save_agent_config(
    AxumPath(agent_type): AxumPath<String>,
    Json(body): Json<SaveAgentConfigBody>,
) -> Json<ApiResponse<()>> {
    match commands::platform_bridge::platform_save_agent_config(agent_type, body.config).await {
        Ok(()) => Json(ApiResponse::ok(())),
        Err(e) => Json(ApiResponse::err(e)),
    }
}

// ---------------------------------------------------------------------------
// Platform sidecar proxies (web mode cannot spawn the sidecar itself — the
// external Node sidecar is expected to be running already, typically started
// by the desktop Tauri app. These handlers forward the Tauri `platform_*`
// commands to that sidecar over HTTP so the Feishu setup flow works.)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeStatusPayload {
    status: String,
    port: Option<u16>,
    error: Option<String>,
    feishu_status: Option<String>,
}

/// Derive a `(port, feishu_status)` tuple from the sidecar `/health` endpoint.
async fn sidecar_health(state: &WebAppState) -> Result<(u16, Option<String>), String> {
    let base = state
        .openclaw_base
        .as_ref()
        .ok_or_else(|| "sidecar base URL not configured (--openclaw-url)".to_string())?;
    let url = format!("{}/health", base.trim_end_matches('/'));
    let resp = state
        .http_client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("sidecar unreachable at {}: {}", base, e))?;
    if !resp.status().is_success() {
        return Err(format!("sidecar /health returned {}", resp.status()));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("parse /health: {}", e))?;
    let feishu_status = body
        .get("feishu")
        .and_then(|f| f.get("status"))
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());
    let port = base
        .trim_end_matches('/')
        .rsplit(':')
        .next()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);
    Ok((port, feishu_status))
}

async fn rest_platform_start(
    AxumState(state): AxumState<WebAppState>,
) -> Json<ApiResponse<BridgeStatusPayload>> {
    // Web mode can't spawn the sidecar — just report whether the configured
    // sidecar is alive. Desktop owns the real spawn/kill lifecycle.
    match sidecar_health(&state).await {
        Ok((port, feishu_status)) => Json(ApiResponse::ok(BridgeStatusPayload {
            status: "running".to_string(),
            port: Some(port),
            error: None,
            feishu_status,
        })),
        Err(e) => Json(ApiResponse::ok(BridgeStatusPayload {
            status: "error".to_string(),
            port: None,
            error: Some(e),
            feishu_status: None,
        })),
    }
}

async fn rest_platform_stop() -> Json<ApiResponse<()>> {
    // No-op in web mode; the sidecar is owned by the desktop process.
    Json(ApiResponse::ok(()))
}

async fn rest_platform_status(
    AxumState(state): AxumState<WebAppState>,
) -> Json<ApiResponse<BridgeStatusPayload>> {
    // Identical to start — both just describe the current state of the
    // pre-existing sidecar.
    rest_platform_start(AxumState(state)).await
}

/// Generic POST proxy to the sidecar, returning whatever JSON it returns.
async fn sidecar_post_proxy(
    state: &WebAppState,
    path: &str,
) -> Result<serde_json::Value, String> {
    let base = state
        .openclaw_base
        .as_ref()
        .ok_or_else(|| "sidecar base URL not configured".to_string())?;
    let url = format!("{}{}", base.trim_end_matches('/'), path);
    let resp = state
        .http_client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("sidecar POST {} failed: {}", path, e))?;
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("parse sidecar response: {}", e))
}

async fn sidecar_get_proxy(
    state: &WebAppState,
    path: &str,
) -> Result<serde_json::Value, String> {
    let base = state
        .openclaw_base
        .as_ref()
        .ok_or_else(|| "sidecar base URL not configured".to_string())?;
    let url = format!("{}{}", base.trim_end_matches('/'), path);
    let resp = state
        .http_client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("sidecar GET {} failed: {}", path, e))?;
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("parse sidecar response: {}", e))
}

async fn rest_platform_connect_feishu(
    AxumState(state): AxumState<WebAppState>,
) -> Json<ApiResponse<bool>> {
    match sidecar_post_proxy(&state, "/connect").await {
        Ok(v) => {
            let ok = v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false);
            Json(ApiResponse::ok(ok))
        }
        Err(e) => Json(ApiResponse::err(e)),
    }
}

async fn rest_platform_get_openclaw_status(
    AxumState(state): AxumState<WebAppState>,
) -> Json<ApiResponse<serde_json::Value>> {
    match sidecar_get_proxy(&state, "/openclaw/status").await {
        Ok(v) => Json(ApiResponse::ok(v)),
        Err(e) => Json(ApiResponse::err(e)),
    }
}

async fn rest_platform_openclaw_start(
    AxumState(state): AxumState<WebAppState>,
) -> Json<ApiResponse<serde_json::Value>> {
    match sidecar_post_proxy(&state, "/openclaw/start").await {
        Ok(v) => Json(ApiResponse::ok(v)),
        Err(e) => Json(ApiResponse::err(e)),
    }
}

async fn rest_platform_openclaw_stop(
    AxumState(state): AxumState<WebAppState>,
) -> Json<ApiResponse<serde_json::Value>> {
    match sidecar_post_proxy(&state, "/openclaw/stop").await {
        Ok(v) => Json(ApiResponse::ok(v)),
        Err(e) => Json(ApiResponse::err(e)),
    }
}

async fn rest_platform_openclaw_restart(
    AxumState(state): AxumState<WebAppState>,
) -> Json<ApiResponse<serde_json::Value>> {
    match sidecar_post_proxy(&state, "/openclaw/restart").await {
        Ok(v) => Json(ApiResponse::ok(v)),
        Err(e) => Json(ApiResponse::err(e)),
    }
}

async fn rest_platform_list_openclaw_sessions(
    AxumState(state): AxumState<WebAppState>,
) -> Json<ApiResponse<serde_json::Value>> {
    match sidecar_get_proxy(&state, "/openclaw/sessions").await {
        Ok(v) => Json(ApiResponse::ok(v)),
        Err(e) => Json(ApiResponse::err(e)),
    }
}

#[derive(Deserialize)]
struct OpenclawSessionIdBody {
    id: String,
}

async fn rest_platform_get_openclaw_session(
    AxumState(state): AxumState<WebAppState>,
    Json(body): Json<OpenclawSessionIdBody>,
) -> Json<ApiResponse<serde_json::Value>> {
    let encoded: String = body
        .id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c.to_string()
            } else {
                format!("%{:02X}", c as u32)
            }
        })
        .collect();
    match sidecar_get_proxy(&state, &format!("/openclaw/sessions/{}", encoded)).await {
        Ok(v) => Json(ApiResponse::ok(v)),
        Err(e) => Json(ApiResponse::err(e)),
    }
}

// ---------------------------------------------------------------------------
// Frogclaw authentication — plain HTTP, no AppHandle/state required
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct AuthLoginBody {
    username: String,
    password: String,
}

async fn rest_auth_login(
    Json(body): Json<AuthLoginBody>,
) -> Json<ApiResponse<commands::auth::UserData>> {
    match commands::auth::login_to_frogclaw(body.username, body.password).await {
        Ok(v) => Json(ApiResponse::ok(v)),
        Err(e) => Json(ApiResponse::err(e)),
    }
}

async fn rest_auth_providers(
    Json(body): Json<AuthLoginBody>,
) -> Json<ApiResponse<commands::auth::FrogclawLoginSession>> {
    match commands::auth::fetch_frogclaw_providers(body.username, body.password).await {
        Ok(v) => Json(ApiResponse::ok(v)),
        Err(e) => Json(ApiResponse::err(e)),
    }
}

#[derive(Deserialize)]
struct ApplyOpenclawConfigBody {
    config_json: String,
}

async fn rest_apply_openclaw_config(
    Json(body): Json<ApplyOpenclawConfigBody>,
) -> Json<ApiResponse<()>> {
    match commands::auth::apply_openclaw_config(body.config_json).await {
        Ok(v) => Json(ApiResponse::ok(v)),
        Err(e) => Json(ApiResponse::err(e)),
    }
}

async fn rest_get_im_channels() -> Json<ApiResponse<serde_json::Value>> {
    match commands::platform_bridge::get_im_channels().await {
        Ok(v) => Json(ApiResponse::ok(v)),
        Err(e) => Json(ApiResponse::err(e)),
    }
}

async fn rest_save_im_channels(
    Json(body): Json<serde_json::Value>,
) -> Json<ApiResponse<()>> {
    match commands::platform_bridge::save_im_channels(body).await {
        Ok(()) => Json(ApiResponse::ok(())),
        Err(e) => Json(ApiResponse::err(e)),
    }
}

// ---------------------------------------------------------------------------
// WebSocket handler — /ws/exec
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct WsExecRequest {
    /// "execute" | "continue" | "resume"
    command_type: String,
    project_path: String,
    prompt: String,
    #[serde(default)]
    model: Option<String>,
    /// Required only for `resume`.
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    plan_mode: Option<bool>,
    #[serde(default)]
    max_thinking_tokens: Option<u32>,
    #[serde(default)]
    tab_id: Option<String>,
}

async fn ws_exec(
    ws: WebSocketUpgrade,
    AxumState(state): AxumState<WebAppState>,
) -> Response {
    ws.on_upgrade(move |socket| ws_exec_handler(socket, state))
}

async fn ws_exec_handler(socket: WebSocket, state: WebAppState) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Per-connection mpsc: the WsEventSink on the execution side `try_send`s
    // envelopes here, and a background forwarder drains them to the WebSocket.
    let (sink_tx, mut sink_rx) = mpsc::channel::<String>(1024);
    let sink: SharedEventSink = Arc::new(WsEventSink::new(sink_tx));

    // Forwarder task: drain sink_rx → write to WebSocket.
    let forward = tokio::spawn(async move {
        while let Some(envelope) = sink_rx.recv().await {
            if ws_tx.send(Message::Text(envelope.into())).await.is_err() {
                break;
            }
        }
        // Close the WebSocket cleanly when the sink channel is dropped.
        let _ = ws_tx.close().await;
    });

    // Read loop: each incoming text frame is an execute/continue/resume
    // request. Requests are handled concurrently inside `tokio::spawn` so a
    // slow Claude process doesn't block further incoming frames.
    while let Some(msg) = ws_rx.next().await {
        let text = match msg {
            Ok(Message::Text(t)) => t.to_string(),
            Ok(Message::Close(_)) => break,
            Ok(_) => continue, // ignore ping/pong/binary
            Err(e) => {
                log::warn!("ws_exec: receive error: {}", e);
                break;
            }
        };

        let request: WsExecRequest = match serde_json::from_str(&text) {
            Ok(r) => r,
            Err(e) => {
                log::warn!("ws_exec: bad request JSON: {}", e);
                let envelope = json!({
                    "event": "claude-error",
                    "payload": format!("Invalid WebSocket request: {}", e),
                })
                .to_string();
                // Push directly into the sink so the same forwarder delivers it.
                let sink_clone = sink.clone();
                use crate::process::EventSink;
                sink_clone.emit_json("claude-error", envelope);
                continue;
            }
        };

        let state_clone = state.clone();
        let sink_clone = sink.clone();
        tokio::spawn(async move {
            let deps = state_clone.claude_deps(sink_clone);
            let data_dir = state_clone.data_dir.clone();
            let model = request.model.unwrap_or_else(|| "sonnet".to_string());
            let result = match request.command_type.as_str() {
                "execute" => {
                    execute_claude_code_with_deps(
                        deps,
                        &data_dir,
                        request.project_path,
                        request.prompt,
                        model,
                        request.plan_mode,
                        request.max_thinking_tokens,
                        request.tab_id,
                    )
                    .await
                }
                "continue" => {
                    continue_claude_code_with_deps(
                        deps,
                        &data_dir,
                        request.project_path,
                        request.prompt,
                        model,
                        request.plan_mode,
                        request.max_thinking_tokens,
                        request.tab_id,
                    )
                    .await
                }
                "resume" => {
                    let sid = match request.session_id {
                        Some(s) => s,
                        None => {
                            return log::warn!("ws_exec: resume without session_id");
                        }
                    };
                    resume_claude_code_with_deps(
                        deps,
                        &data_dir,
                        request.project_path,
                        sid,
                        request.prompt,
                        model,
                        request.plan_mode,
                        request.max_thinking_tokens,
                        request.tab_id,
                    )
                    .await
                }
                other => {
                    log::warn!("ws_exec: unknown command_type {}", other);
                    return;
                }
            };
            if let Err(e) = result {
                log::warn!("ws_exec: command failed: {}", e);
            }
        });
    }

    // Client disconnected — drop the sink so the forwarder exits and closes
    // the WebSocket. Any still-running Claude processes continue and will
    // emit their events into a closed channel, which is harmless (try_send
    // returns an error that the sink ignores).
    drop(sink);
    let _ = forward.await;
}

// ---------------------------------------------------------------------------
// OpenClaw reverse proxy
// ---------------------------------------------------------------------------

async fn openclaw_proxy(
    AxumState(state): AxumState<WebAppState>,
    req: Request<Body>,
) -> Response {
    let Some(base) = state.openclaw_base.as_ref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "OpenClaw sidecar URL not configured",
        )
            .into_response();
    };

    let (parts, body) = req.into_parts();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    // Strip the `/api/openclaw` prefix so the sidecar sees its own paths.
    let forwarded_path = path_and_query
        .strip_prefix("/api/openclaw")
        .unwrap_or(path_and_query);
    let target_url = format!("{}{}", base.trim_end_matches('/'), forwarded_path);

    let body_bytes = match axum::body::to_bytes(body, 32 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, format!("read body: {}", e)).into_response();
        }
    };

    let mut req_builder = state
        .http_client
        .request(parts.method.clone(), &target_url)
        .body(body_bytes.to_vec());

    // Forward non-hop-by-hop headers.
    for (name, value) in parts.headers.iter() {
        if should_forward_header(name.as_str()) {
            req_builder = req_builder.header(name.as_str(), value.clone());
        }
    }

    match req_builder.send().await {
        Ok(resp) => {
            let status = resp.status();
            let headers = resp.headers().clone();
            let stream = resp.bytes_stream();
            let body = Body::from_stream(stream);
            let mut out = Response::new(body);
            *out.status_mut() =
                StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            for (k, v) in headers.iter() {
                if should_forward_header(k.as_str()) {
                    if let (Ok(name), Ok(val)) = (
                        axum::http::HeaderName::from_bytes(k.as_str().as_bytes()),
                        axum::http::HeaderValue::from_bytes(v.as_bytes()),
                    ) {
                        out.headers_mut().insert(name, val);
                    }
                }
            }
            out
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            format!("OpenClaw proxy error: {}", e),
        )
            .into_response(),
    }
}

fn should_forward_header(name: &str) -> bool {
    // Strip hop-by-hop headers and a few that `reqwest` / `axum` will set
    // themselves. Everything else is forwarded verbatim.
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "host"
            | "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailers"
            | "transfer-encoding"
            | "upgrade"
            | "content-length"
    )
}

// ---------------------------------------------------------------------------
// Router assembly + server entry point
// ---------------------------------------------------------------------------

pub fn build_router(state: WebAppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::PATCH,
            Method::OPTIONS,
        ])
        .allow_headers(Any);

    Router::new()
        // Frontend entry
        .route("/", get(serve_frontend))
        .route("/index.html", get(serve_frontend))
        .route("/assets/{*path}", get(serve_asset))
        // REST — Claude projects / sessions
        .route("/api/projects", get(rest_list_projects))
        .route(
            "/api/projects/{project_id}/sessions",
            get(rest_get_project_sessions),
        )
        .route(
            "/api/sessions/{session_id}/history/{project_id}",
            get(rest_load_session_history),
        )
        .route("/api/sessions/running", get(rest_list_running_claude_sessions))
        .route("/api/sessions/cancel", post(rest_cancel_claude_execution))
        .route(
            "/api/sessions/{session_id}/output",
            get(rest_get_claude_session_output),
        )
        // Platform / Feishu config (shared with desktop via ~/.frogcode/)
        .route(
            "/api/platform/config",
            get(rest_platform_get_config).post(rest_platform_save_config),
        )
        .route(
            "/api/platform/agent-config/{agent_type}",
            get(rest_platform_get_agent_config).post(rest_platform_save_agent_config),
        )
        // IM channels unified storage
        .route("/api/im-channels", get(rest_get_im_channels).post(rest_save_im_channels))
        // Frogclaw auth (pure HTTP passthrough — no state needed)
        .route("/api/auth/login", post(rest_auth_login))
        .route("/api/auth/providers", post(rest_auth_providers))
        .route("/api/auth/apply-openclaw-config", post(rest_apply_openclaw_config))
        // Platform sidecar proxies — forward to the external Node sidecar
        // running at `openclaw_base`. Start/Stop become no-ops because the
        // desktop process owns the sidecar lifecycle.
        .route("/api/platform/start", post(rest_platform_start))
        .route("/api/platform/stop", post(rest_platform_stop))
        .route("/api/platform/status", get(rest_platform_status))
        .route(
            "/api/platform/connect-feishu",
            post(rest_platform_connect_feishu),
        )
        .route(
            "/api/platform/openclaw/status",
            get(rest_platform_get_openclaw_status),
        )
        .route(
            "/api/platform/openclaw/start",
            post(rest_platform_openclaw_start),
        )
        .route(
            "/api/platform/openclaw/stop",
            post(rest_platform_openclaw_stop),
        )
        .route(
            "/api/platform/openclaw/restart",
            post(rest_platform_openclaw_restart),
        )
        .route(
            "/api/platform/openclaw/sessions",
            get(rest_platform_list_openclaw_sessions),
        )
        .route(
            "/api/platform/openclaw/session",
            post(rest_platform_get_openclaw_session),
        )
        // OpenClaw reverse proxy (all methods)
        .route("/api/openclaw", any(openclaw_proxy))
        .route("/api/openclaw/{*rest}", any(openclaw_proxy))
        // WebSocket
        .route("/ws/exec", get(ws_exec))
        .layer(cors)
        .with_state(state)
}

/// Start the web server on the given host/port. Runs until the process
/// is killed or the listener returns an error.
pub async fn start(
    host: String,
    port: u16,
    data_dir: PathBuf,
    openclaw_base: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    // Mirror the desktop main.rs behavior: if the user enabled
    // `openclawAutoStart` in ~/.frogcode/platform-config.json, fire a
    // `/openclaw/start` against the external sidecar. The sidecar itself
    // is user-managed (systemd/pm2) in web mode so we only POST, not spawn.
    if let Some(base) = openclaw_base.as_ref() {
        if read_openclaw_auto_start_flag() {
            let base = base.clone();
            tokio::spawn(async move {
                auto_start_openclaw(base).await;
            });
        }
    }

    let state = WebAppState::new(data_dir, openclaw_base);
    let app = build_router(state);

    let addr = format!("{}:{}", host, port);
    log::info!("frogcode-web listening on http://{}", addr);
    println!("🌐 frogcode-web listening on http://{}", addr);
    println!("📱 Access from phone: http://YOUR_PC_IP:{}", port);

    let listener = TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

/// Read `openclawAutoStart` from `~/.frogcode/platform-config.json`.
/// Returns false on any error so we never block startup on config issues.
fn read_openclaw_auto_start_flag() -> bool {
    let Some(home) = dirs::home_dir() else { return false };
    let path = home.join(".frogcode").join("platform-config.json");
    let Ok(raw) = std::fs::read_to_string(&path) else { return false };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else { return false };
    value
        .get("openclawAutoStart")
        .or_else(|| value.get("openclaw_auto_start"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// POST `{base}/openclaw/start` with retries. Sidecar may boot after
/// frogcode-web when both are managed by the same systemd unit, so we
/// retry for up to ~20s before giving up.
async fn auto_start_openclaw(base: String) {
    let url = format!("{}/openclaw/start", base.trim_end_matches('/'));
    let client = reqwest::Client::new();
    log::info!("OpenClaw auto-start: will POST {}", url);
    println!("🔁 OpenClaw auto-start enabled — target {}", url);
    for attempt in 1..=10u32 {
        match client.post(&url).send().await {
            Ok(r) if r.status().is_success() => {
                log::info!("OpenClaw auto-start: OK on attempt {}", attempt);
                println!("✅ OpenClaw gateway auto-started (attempt {})", attempt);
                return;
            }
            Ok(r) => log::warn!(
                "OpenClaw auto-start attempt {}: HTTP {}",
                attempt,
                r.status()
            ),
            Err(e) => log::warn!("OpenClaw auto-start attempt {}: {}", attempt, e),
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    log::error!("OpenClaw auto-start: giving up after 10 attempts");
    eprintln!("⚠️  OpenClaw auto-start failed after 10 retries");
}

// Suppress unused-warnings for items only used by the web binary.
#[allow(dead_code)]
fn _referenced(_: Query<()>, _: HeaderMap, _: Uri) {}
