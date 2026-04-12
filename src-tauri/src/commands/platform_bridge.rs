/**
 * Platform Bridge Module
 *
 * Manages a Node.js sidecar process that bridges IM platforms (Feishu) to
 * pluggable CLI backends (Claude Code / OpenClaw / ...) via an Agent adapter
 * layer inside the sidecar. This Rust module handles only:
 *   - sidecar process lifecycle (spawn/kill/status)
 *   - config file read/write
 *   - SSE event relay from sidecar to Tauri frontend
 *
 * All CLI execution, JSONL parsing, and card rendering lives in the sidecar
 * (see src-tauri/sidecar/platform/src/agents/).
 */
use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::AsyncBufReadExt;
use tokio::sync::Mutex;

#[cfg(target_os = "windows")]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

// Embedded sidecar bytes (release builds only)
const PLATFORM_SIDECAR_BYTES: &[u8] = include_bytes!("../../binaries/frogcode-platform-sidecar.cjs");

// Windows: hide console window
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum BridgeStatus {
    Stopped,
    Starting,
    Running,
    Error,
}

impl Default for BridgeStatus {
    fn default() -> Self {
        Self::Stopped
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatusInfo {
    pub status: BridgeStatus,
    pub port: Option<u16>,
    pub error: Option<String>,
    pub feishu_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuConfig {
    pub app_id: String,
    pub app_secret: String,
    pub project_path: String,
    pub enabled: bool,
    /// CLI backend for the IM (Feishu) bridge: "claudecode" | "openclaw".
    /// Defaults to "claudecode" — OpenClaw gateway is available regardless
    /// of this setting, since the sidecar constructs a singleton OpenClawAgent
    /// at startup that is reachable via /openclaw/* endpoints independently
    /// of which agent handles IM messages.
    #[serde(default = "default_agent_type")]
    pub agent_type: String,
}

fn default_agent_type() -> String {
    "claudecode".to_string()
}

impl Default for FeishuConfig {
    fn default() -> Self {
        Self {
            app_id: String::new(),
            app_secret: String::new(),
            project_path: String::new(),
            enabled: false,
            agent_type: default_agent_type(),
        }
    }
}

// ---------------------------------------------------------------------------
// Managed state
// ---------------------------------------------------------------------------

pub struct PlatformBridgeState {
    inner: Arc<Mutex<PlatformBridgeInner>>,
}

struct PlatformBridgeInner {
    child: Option<tokio::process::Child>,
    port: Option<u16>,
    status: BridgeStatus,
    error: Option<String>,
    feishu_status: Option<String>,
    sse_abort: Option<tokio::sync::oneshot::Sender<()>>,
}

impl Default for PlatformBridgeState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(PlatformBridgeInner {
                child: None,
                port: None,
                status: BridgeStatus::Stopped,
                error: None,
                feishu_status: None,
                sse_abort: None,
            })),
        }
    }
}

// ---------------------------------------------------------------------------
// Config file helpers
// ---------------------------------------------------------------------------
//
// Storage layout (v2 — per-agent Feishu credentials):
//
//   ~/.anycode/platform-config.json          ← only project_path / enabled / agent_type
//   ~/.anycode/agents/claudecode.json        ← { ..., feishu: { app_id, app_secret } }
//   ~/.anycode/agents/openclaw.json          ← { ..., feishu: { app_id, app_secret } }
//
// The public FeishuConfig (frontend wire shape) still carries app_id/app_secret
// so the UI contract is unchanged — we just merge/split at the file boundary.
//
// Legacy migration: old installs stored `appId` + `appSecret` at the root of
// platform-config.json. read_config() detects this on load, moves the creds
// into the *currently active* agent's file under `feishu`, and rewrites the
// root file without them. Writers never re-introduce root credentials.

fn config_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".anycode"))
        .ok_or_else(|| "Cannot find home directory".to_string())
}

/// Append a lifecycle event to the sidecar log file. Used to record
/// spawn/kill/error events from the Rust parent so the user sees them
/// in the same log stream as the sidecar's own stderr output.
fn append_lifecycle_log(event: &str, detail: &str) {
    let Ok(dir) = config_dir() else { return };
    let path = dir.join("platform-sidecar.log");
    // Best effort — never fail the parent operation because logging failed.
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::io::Write;
        let ts = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f");
        let _ = writeln!(f, "[{}] [rust {}] {}", ts, event, detail);
    }
}

fn config_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("platform-config.json"))
}

/// Read a per-agent config file as a JSON object, or an empty object if missing.
fn read_agent_config_value(agent_type: &str) -> Result<serde_json::Value, String> {
    let p = agent_config_path(agent_type)?;
    if !p.exists() {
        return Ok(serde_json::json!({}));
    }
    let raw = std::fs::read_to_string(&p).map_err(|e| format!("read agent config: {}", e))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse agent config: {}", e))
}

/// Write a per-agent config value to disk as pretty-printed JSON.
fn write_agent_config_value(agent_type: &str, value: &serde_json::Value) -> Result<(), String> {
    let p = agent_config_path(agent_type)?;
    let dir = p.parent().ok_or_else(|| "no parent dir".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create agents dir: {}", e))?;
    let raw = serde_json::to_string_pretty(value).map_err(|e| format!("serialize: {}", e))?;
    std::fs::write(&p, raw).map_err(|e| format!("write agent config: {}", e))?;
    Ok(())
}

/// Extract `feishu.appId` / `feishu.appSecret` from a per-agent config Value.
fn extract_feishu_creds(agent_cfg: &serde_json::Value) -> (String, String) {
    let empty = serde_json::json!({});
    let feishu = agent_cfg.get("feishu").unwrap_or(&empty);
    let read_field = |camel: &str, snake: &str| -> String {
        feishu
            .get(camel)
            .and_then(|v| v.as_str())
            .or_else(|| feishu.get(snake).and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string()
    };
    (read_field("appId", "app_id"), read_field("appSecret", "app_secret"))
}

/// Merge `feishu: { appId, appSecret }` into an agent config Value.
fn inject_feishu_creds(agent_cfg: &mut serde_json::Value, app_id: &str, app_secret: &str) {
    if !agent_cfg.is_object() {
        *agent_cfg = serde_json::json!({});
    }
    let obj = agent_cfg.as_object_mut().unwrap();
    obj.insert(
        "feishu".to_string(),
        serde_json::json!({
            "appId": app_id,
            "appSecret": app_secret,
        }),
    );
}

/// The only fields actually persisted at the platform-config.json root now.
/// (`app_id` / `app_secret` live under each agent's config file.)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PlatformRootConfig {
    #[serde(default)]
    project_path: String,
    #[serde(default)]
    enabled: bool,
    #[serde(default = "default_agent_type")]
    agent_type: String,
}

fn read_config() -> Result<FeishuConfig, String> {
    let p = config_path()?;
    if !p.exists() {
        return Ok(FeishuConfig::default());
    }
    let raw = std::fs::read_to_string(&p).map_err(|e| format!("read config: {}", e))?;
    // Parse as raw Value first so we can detect legacy root-level credentials
    // without failing strict deserialization.
    let mut value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse config: {}", e))?;

    // Extract active agent type.
    let agent_type = value
        .get("agentType")
        .and_then(|v| v.as_str())
        .or_else(|| value.get("agent_type").and_then(|v| v.as_str()))
        .unwrap_or("openclaw")
        .to_string();

    // Legacy migration: if root has appId/appSecret, move them into the
    // currently active agent's file and rewrite the root without them.
    let legacy_app_id = value
        .get("appId")
        .and_then(|v| v.as_str())
        .or_else(|| value.get("app_id").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    let legacy_app_secret = value
        .get("appSecret")
        .and_then(|v| v.as_str())
        .or_else(|| value.get("app_secret").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();

    if !legacy_app_id.is_empty() || !legacy_app_secret.is_empty() {
        // Only migrate if the agent's file does not already carry feishu creds
        // — we don't want to clobber credentials a user has already set under
        // the per-agent file.
        let mut agent_cfg = read_agent_config_value(&agent_type)?;
        let (existing_id, existing_secret) = extract_feishu_creds(&agent_cfg);
        if existing_id.is_empty() && existing_secret.is_empty() {
            inject_feishu_creds(&mut agent_cfg, &legacy_app_id, &legacy_app_secret);
            write_agent_config_value(&agent_type, &agent_cfg)?;
            info!(
                "Migrated legacy Feishu credentials from platform-config.json into agents/{}.json",
                agent_type
            );
        } else {
            info!(
                "Legacy Feishu credentials found at root but agents/{}.json already has them — keeping per-agent values",
                agent_type
            );
        }

        // Strip legacy fields from the root file.
        if let Some(obj) = value.as_object_mut() {
            obj.remove("appId");
            obj.remove("app_id");
            obj.remove("appSecret");
            obj.remove("app_secret");
        }
        let stripped = serde_json::to_string_pretty(&value)
            .map_err(|e| format!("serialize stripped: {}", e))?;
        std::fs::write(&p, stripped).map_err(|e| format!("rewrite root config: {}", e))?;
    }

    // Re-read the root as a typed PlatformRootConfig.
    let root: PlatformRootConfig =
        serde_json::from_value(value).map_err(|e| format!("root shape: {}", e))?;

    // Pull credentials from the active agent's file.
    let agent_cfg = read_agent_config_value(&root.agent_type)?;
    let (app_id, app_secret) = extract_feishu_creds(&agent_cfg);

    Ok(FeishuConfig {
        app_id,
        app_secret,
        project_path: root.project_path,
        enabled: root.enabled,
        agent_type: root.agent_type,
    })
}

fn write_config(cfg: &FeishuConfig) -> Result<(), String> {
    let dir = config_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {}", e))?;

    // 1) Write / merge credentials into the active agent's file.
    let mut agent_cfg = read_agent_config_value(&cfg.agent_type)?;
    inject_feishu_creds(&mut agent_cfg, &cfg.app_id, &cfg.app_secret);
    write_agent_config_value(&cfg.agent_type, &agent_cfg)?;

    // 2) Write the root platform-config.json with shared fields only.
    let root = PlatformRootConfig {
        project_path: cfg.project_path.clone(),
        enabled: cfg.enabled,
        agent_type: cfg.agent_type.clone(),
    };
    let p = dir.join("platform-config.json");
    let raw = serde_json::to_string_pretty(&root).map_err(|e| format!("serialize: {}", e))?;
    std::fs::write(&p, raw).map_err(|e| format!("write config: {}", e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Sidecar extraction
// ---------------------------------------------------------------------------

fn get_or_extract_sidecar() -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        // Dev: use from source tree
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
            .map_err(|_| "CARGO_MANIFEST_DIR not set".to_string())?;
        Ok(PathBuf::from(manifest_dir)
            .join("binaries")
            .join("frogcode-platform-sidecar.cjs"))
    } else {
        // Release: extract to ~/.anycode/
        // Always overwrite if the embedded bytes differ from what's on disk —
        // the embedded bundle is the authoritative version for this build.
        let dir = config_dir()?;
        let target = dir.join("frogcode-platform-sidecar.cjs");
        // Always overwrite — compare content hash, not just size
        let should_write = match std::fs::read(&target) {
            Ok(existing) => existing != PLATFORM_SIDECAR_BYTES,
            Err(_) => true,
        };
        if should_write {
            info!("Extracting Platform sidecar to {:?} ({} bytes)", target, PLATFORM_SIDECAR_BYTES.len());
            std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {}", e))?;
            std::fs::write(&target, PLATFORM_SIDECAR_BYTES)
                .map_err(|e| format!("write sidecar: {}", e))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = std::fs::metadata(&target)
                    .map_err(|e| e.to_string())?
                    .permissions();
                perms.set_mode(0o755);
                std::fs::set_permissions(&target, perms).map_err(|e| e.to_string())?;
            }
        }
        Ok(target)
    }
}

// ---------------------------------------------------------------------------
// SSE listener (background task)
// ---------------------------------------------------------------------------

fn spawn_sse_listener(
    port: u16,
    app: tauri::AppHandle,
    inner: Arc<Mutex<PlatformBridgeInner>>,
    mut abort_rx: tokio::sync::oneshot::Receiver<()>,
) {
    use tauri::Emitter;

    tauri::async_runtime::spawn(async move {
        let url = format!("http://127.0.0.1:{}/events", port);
        info!("SSE listener connecting to {}", url);

        let client = reqwest::Client::new();
        let resp = match client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => {
                warn!("SSE connect failed: {}", e);
                return;
            }
        };

        let mut stream = resp.bytes_stream();
        use futures::StreamExt;
        let mut buf = String::new();

        loop {
            tokio::select! {
                _ = &mut abort_rx => {
                    debug!("SSE listener aborted");
                    return;
                }
                chunk = stream.next() => {
                    match chunk {
                        Some(Ok(bytes)) => {
                            buf.push_str(&String::from_utf8_lossy(&bytes));
                            // Parse SSE lines
                            while let Some(pos) = buf.find("\n\n") {
                                let block = buf[..pos].to_string();
                                buf = buf[pos + 2..].to_string();

                                for line in block.lines() {
                                    if let Some(data) = line.strip_prefix("data: ") {
                                        if let Ok(evt) = serde_json::from_str::<serde_json::Value>(data) {
                                            let event_type = evt.get("type")
                                                .and_then(|t| t.as_str())
                                                .unwrap_or("unknown");

                                            // Update inner state for status events
                                            if event_type == "status" {
                                                if let Ok(mut g) = inner.try_lock() {
                                                    if let Some(fs) = evt.get("feishu")
                                                        .and_then(|f| f.get("status"))
                                                        .and_then(|s| s.as_str())
                                                    {
                                                        g.feishu_status = Some(fs.to_string());
                                                    }
                                                }
                                            }

                                            let event_name = format!("platform:{}", event_type);
                                            if let Err(e) = app.emit(&event_name, &evt) {
                                                debug!("emit {} failed: {}", event_name, e);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        Some(Err(e)) => {
                            warn!("SSE read error: {}", e);
                            return;
                        }
                        None => {
                            info!("SSE stream ended");
                            return;
                        }
                    }
                }
            }
        }
    });
}


// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn platform_get_config() -> Result<FeishuConfig, String> {
    read_config()
}

#[tauri::command]
pub async fn platform_save_config(config: FeishuConfig) -> Result<(), String> {
    write_config(&config)
}

// ---------------------------------------------------------------------------
// Per-agent config files (~/.anycode/agents/{type}.json)
// ---------------------------------------------------------------------------

fn agent_config_path(agent_type: &str) -> Result<PathBuf, String> {
    // Validate to prevent path traversal
    if !agent_type.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("invalid agent type: {}", agent_type));
    }
    Ok(config_dir()?.join("agents").join(format!("{}.json", agent_type)))
}

#[tauri::command]
pub async fn platform_get_agent_config(agent_type: String) -> Result<serde_json::Value, String> {
    let p = agent_config_path(&agent_type)?;
    if !p.exists() {
        // Return sensible defaults per agent type
        let default = match agent_type.as_str() {
            "claudecode" => serde_json::json!({
                "binPath": null,
                "extraArgs": [],
                "mode": "default"
            }),
            "openclaw" => serde_json::json!({
                "binPath": null,
                "stateDir": null,
                "configPath": null,
                "gatewayPort": 18789,
                "gatewayToken": null
            }),
            _ => serde_json::json!({}),
        };
        return Ok(default);
    }
    let raw = std::fs::read_to_string(&p).map_err(|e| format!("read agent config: {}", e))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse agent config: {}", e))
}

#[tauri::command]
pub async fn platform_save_agent_config(
    agent_type: String,
    config: serde_json::Value,
) -> Result<(), String> {
    let p = agent_config_path(&agent_type)?;
    let dir = p.parent().ok_or_else(|| "no parent dir".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create agents dir: {}", e))?;
    let raw = serde_json::to_string_pretty(&config).map_err(|e| format!("serialize: {}", e))?;
    std::fs::write(&p, raw).map_err(|e| format!("write agent config: {}", e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// OpenClaw session history proxies (sidecar HTTP → Tauri)
// ---------------------------------------------------------------------------

async fn sidecar_port(state: &tauri::State<'_, PlatformBridgeState>) -> Result<u16, String> {
    let g = state.inner.lock().await;
    g.port.ok_or_else(|| "platform sidecar not running".to_string())
}

async fn sidecar_post(state: &tauri::State<'_, PlatformBridgeState>, path: &str) -> Result<serde_json::Value, String> {
    let port = sidecar_port(state).await?;
    let url = format!("http://127.0.0.1:{}{}", port, path);
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("http post: {}", e))?;
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("json parse: {}", e))
}

#[tauri::command]
pub async fn platform_openclaw_start(
    state: tauri::State<'_, PlatformBridgeState>,
) -> Result<serde_json::Value, String> {
    sidecar_post(&state, "/openclaw/start").await
}

#[tauri::command]
pub async fn platform_openclaw_stop(
    state: tauri::State<'_, PlatformBridgeState>,
) -> Result<serde_json::Value, String> {
    sidecar_post(&state, "/openclaw/stop").await
}

#[tauri::command]
pub async fn platform_openclaw_restart(
    state: tauri::State<'_, PlatformBridgeState>,
) -> Result<serde_json::Value, String> {
    sidecar_post(&state, "/openclaw/restart").await
}

#[tauri::command]
pub async fn platform_get_openclaw_status(
    state: tauri::State<'_, PlatformBridgeState>,
) -> Result<serde_json::Value, String> {
    let port = sidecar_port(&state).await?;
    let url = format!("http://127.0.0.1:{}/openclaw/status", port);
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("http get: {}", e))?;
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("json parse: {}", e))
}

#[tauri::command]
pub async fn platform_list_openclaw_sessions(
    state: tauri::State<'_, PlatformBridgeState>,
) -> Result<serde_json::Value, String> {
    let port = sidecar_port(&state).await?;
    let url = format!("http://127.0.0.1:{}/openclaw/sessions", port);
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("http get: {}", e))?;
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("json parse: {}", e))
}

#[tauri::command]
pub async fn platform_get_openclaw_session(
    state: tauri::State<'_, PlatformBridgeState>,
    id: String,
) -> Result<serde_json::Value, String> {
    let port = sidecar_port(&state).await?;
    let encoded = urlencoding::encode(&id);
    let url = format!("http://127.0.0.1:{}/openclaw/sessions/{}", port, encoded);
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("http get: {}", e))?;
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("json parse: {}", e))
}

#[tauri::command]
pub async fn platform_start(
    state: tauri::State<'_, PlatformBridgeState>,
    app: tauri::AppHandle,
) -> Result<BridgeStatusInfo, String> {
    append_lifecycle_log("start", "platform_start command invoked");

    let inner = state.inner.clone();
    let mut g = inner.lock().await;

    // Kill any existing child process first (prevents zombie sidecar from previous version)
    if let Some(abort) = g.sse_abort.take() {
        let _ = abort.send(());
    }
    if let Some(port) = g.port {
        let url = format!("http://127.0.0.1:{}/disconnect", port);
        let client = reqwest::Client::new();
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            client.post(&url).send(),
        ).await;
    }
    if let Some(mut child) = g.child.take() {
        let _ = child.kill().await;
        info!("Killed previous Platform sidecar");
        append_lifecycle_log("kill", "killed previous sidecar before spawning new one");
    }
    g.port = None;
    g.feishu_status = None;

    g.status = BridgeStatus::Starting;
    g.error = None;

    // Resolve sidecar path
    let sidecar_path = get_or_extract_sidecar()?;
    if !sidecar_path.exists() {
        g.status = BridgeStatus::Error;
        g.error = Some(format!("sidecar not found: {:?}", sidecar_path));
        append_lifecycle_log("error", &format!("sidecar binary not found at {:?}", sidecar_path));
        return Err(g.error.clone().unwrap());
    }

    // Config path
    let cfg_path = config_path()?;

    // Check node is available
    {
        let mut check = tokio::process::Command::new("node");
        check.arg("--version");
        #[cfg(target_os = "windows")]
        check.creation_flags(CREATE_NO_WINDOW);
        if check.output().await.is_err() {
            g.status = BridgeStatus::Error;
            g.error = Some("Node.js not found".to_string());
            return Err(g.error.clone().unwrap());
        }
    }

    // Spawn — redirect stderr to a log file so the user can diagnose
    // event subscription / agent errors from the sidecar.
    // On each start, rename the old log with a timestamp so previous
    // runs are preserved for debugging (e.g. platform-sidecar.2026-04-12_11-24-31.log).
    let dir = config_dir()?;
    let log_path = dir.join("platform-sidecar.log");
    if log_path.exists() {
        let ts = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S");
        let archive = dir.join(format!("platform-sidecar.{}.log", ts));
        let _ = std::fs::rename(&log_path, &archive);
    }
    let stderr_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
        .map_err(|e| format!("open sidecar log: {}", e))?;
    info!("Sidecar log: {:?}", log_path);

    let mut cmd = tokio::process::Command::new("node");
    cmd.arg(&sidecar_path)
        .arg("--port")
        .arg("0")
        .arg("--config")
        .arg(cfg_path.to_string_lossy().as_ref())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::from(stderr_file));

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| {
        g.status = BridgeStatus::Error;
        g.error = Some(format!("spawn failed: {}", e));
        g.error.clone().unwrap()
    })?;

    // Read first stdout line to get port
    let stdout = child.stdout.take().ok_or_else(|| {
        g.status = BridgeStatus::Error;
        "no stdout".to_string()
    })?;
    let mut reader = tokio::io::BufReader::new(stdout);
    let mut line = String::new();

    let read_result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        reader.read_line(&mut line),
    )
    .await;

    match read_result {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            let _ = child.kill().await;
            g.status = BridgeStatus::Error;
            g.error = Some(format!("read stdout: {}", e));
            append_lifecycle_log("error", &format!("read stdout failed: {}", e));
            return Err(g.error.clone().unwrap());
        }
        Err(_) => {
            let _ = child.kill().await;
            g.status = BridgeStatus::Error;
            g.error = Some("sidecar did not emit READY within 10s".to_string());
            append_lifecycle_log("error", "sidecar did not emit READY within 10s");
            return Err(g.error.clone().unwrap());
        }
    }

    // Parse port from "FROGCODE_PLATFORM_READY port=<N>"
    let port: u16 = line
        .trim()
        .strip_prefix("FROGCODE_PLATFORM_READY port=")
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| {
            let msg = format!("unexpected sidecar stdout: {}", line.trim());
            append_lifecycle_log("error", &msg);
            msg
        })?;

    info!("Platform sidecar ready on port {}", port);
    append_lifecycle_log("ready", &format!("sidecar READY on port {}", port));

    // CRITICAL: keep reading stdout forever so the pipe stays open.
    // The sidecar redirects console.* to stderr, but any rogue write to
    // stdout (e.g. a dependency logging an unexpected warning) would
    // cause EPIPE and crash the sidecar process if we don't drain. We
    // just discard every line — interesting output already goes to stderr.
    tauri::async_runtime::spawn(async move {
        let mut drain = reader;
        let mut discard = String::new();
        loop {
            discard.clear();
            match drain.read_line(&mut discard).await {
                Ok(0) => return, // EOF
                Ok(_) => {}      // discard
                Err(_) => return,
            }
        }
    });

    // Abort channel for SSE listener
    let (abort_tx, abort_rx) = tokio::sync::oneshot::channel::<()>();

    g.child = Some(child);
    g.port = Some(port);
    g.status = BridgeStatus::Running;
    g.sse_abort = Some(abort_tx);

    // Start SSE listener in background
    spawn_sse_listener(port, app, inner.clone(), abort_rx);

    Ok(BridgeStatusInfo {
        status: BridgeStatus::Running,
        port: Some(port),
        error: None,
        feishu_status: g.feishu_status.clone(),
    })
}

#[tauri::command]
pub async fn platform_stop(
    state: tauri::State<'_, PlatformBridgeState>,
) -> Result<(), String> {
    append_lifecycle_log("stop", "platform_stop command invoked");

    let inner = state.inner.clone();
    let mut g = inner.lock().await;

    // Abort SSE listener
    if let Some(abort) = g.sse_abort.take() {
        let _ = abort.send(());
    }

    // Try graceful disconnect first
    if let Some(port) = g.port {
        let url = format!("http://127.0.0.1:{}/disconnect", port);
        let client = reqwest::Client::new();
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            client.post(&url).send(),
        )
        .await;
    }

    // Kill child
    if let Some(mut child) = g.child.take() {
        let _ = child.kill().await;
        info!("Platform sidecar process killed");
        append_lifecycle_log("kill", "sidecar process killed (graceful stop)");
    }

    g.port = None;
    g.status = BridgeStatus::Stopped;
    g.error = None;
    g.feishu_status = None;

    append_lifecycle_log("stopped", "platform bridge state reset");
    Ok(())
}

/// Read the last N lines (default 200) from the sidecar stderr log.
/// Useful for diagnosing "bot didn't respond" issues — every received
/// Feishu event is logged there, so the user can tell the difference
/// between "event not received" (empty log) and "event filtered out"
/// (log shows the event but an early-return hit).
#[tauri::command]
pub async fn platform_read_log(
    lines: Option<usize>,
) -> Result<serde_json::Value, String> {
    let path = config_dir()?.join("platform-sidecar.log");
    if !path.exists() {
        return Ok(serde_json::json!({
            "path": path.to_string_lossy(),
            "exists": false,
            "lines": [],
        }));
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("read log: {}", e))?;
    let n = lines.unwrap_or(200);
    let all: Vec<&str> = raw.lines().collect();
    let tail: Vec<String> = all
        .iter()
        .skip(all.len().saturating_sub(n))
        .map(|s| s.to_string())
        .collect();
    Ok(serde_json::json!({
        "path": path.to_string_lossy(),
        "exists": true,
        "totalLines": all.len(),
        "lines": tail,
    }))
}

#[tauri::command]
pub async fn platform_status(
    state: tauri::State<'_, PlatformBridgeState>,
) -> Result<BridgeStatusInfo, String> {
    let g = state.inner.lock().await;
    Ok(BridgeStatusInfo {
        status: g.status.clone(),
        port: g.port,
        error: g.error.clone(),
        feishu_status: g.feishu_status.clone(),
    })
}

/// POST /connect to the sidecar to trigger Feishu connection
#[tauri::command]
pub async fn platform_connect_feishu(
    state: tauri::State<'_, PlatformBridgeState>,
) -> Result<bool, String> {
    append_lifecycle_log("feishu", "connect_feishu invoked");
    let g = state.inner.lock().await;
    let port = g.port.ok_or("sidecar not running")?;
    drop(g);

    let url = format!("http://127.0.0.1:{}/connect", port);
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .send()
        .await
        .map_err(|e| {
            let msg = format!("connect: {}", e);
            append_lifecycle_log("feishu-error", &msg);
            msg
        })?;
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("json: {}", e))?;
    let ok = body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if ok {
        append_lifecycle_log("feishu", "Feishu WS connection succeeded");
    } else {
        let err = body.get("error").and_then(|v| v.as_str()).unwrap_or("unknown");
        append_lifecycle_log("feishu-error", &format!("Feishu connect failed: {}", err));
    }
    Ok(ok)
}
