/**
 * IM Bridge Module
 *
 * Manages a Node.js sidecar process that bridges IM platforms (Feishu, WeChat)
 * to Claude Code. The sidecar runs an HTTP+SSE server on localhost; this module
 * spawns/kills it and relays SSE events to the Tauri frontend.
 *
 * Pattern copied from commands/acemcp.rs (sidecar extraction, Windows flags).
 */
use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::AsyncBufReadExt;
use tokio::sync::Mutex;

#[cfg(target_os = "windows")]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

// Embedded sidecar bytes (release builds only)
const IM_SIDECAR_BYTES: &[u8] = include_bytes!("../../binaries/frogcode-im-sidecar.cjs");

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
}

impl Default for FeishuConfig {
    fn default() -> Self {
        Self {
            app_id: String::new(),
            app_secret: String::new(),
            project_path: String::new(),
            enabled: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Managed state
// ---------------------------------------------------------------------------

pub struct ImBridgeState {
    inner: Arc<Mutex<ImBridgeInner>>,
}

struct ImBridgeInner {
    child: Option<tokio::process::Child>,
    port: Option<u16>,
    status: BridgeStatus,
    error: Option<String>,
    feishu_status: Option<String>,
    sse_abort: Option<tokio::sync::oneshot::Sender<()>>,
}

impl Default for ImBridgeState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(ImBridgeInner {
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

fn config_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".anycode"))
        .ok_or_else(|| "Cannot find home directory".to_string())
}

fn config_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("im-config.json"))
}

fn read_config() -> Result<FeishuConfig, String> {
    let p = config_path()?;
    if !p.exists() {
        return Ok(FeishuConfig::default());
    }
    let raw = std::fs::read_to_string(&p).map_err(|e| format!("read config: {}", e))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse config: {}", e))
}

fn write_config(cfg: &FeishuConfig) -> Result<(), String> {
    let dir = config_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {}", e))?;
    let p = dir.join("im-config.json");
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| format!("serialize: {}", e))?;
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
            .join("frogcode-im-sidecar.cjs"))
    } else {
        // Release: extract to ~/.anycode/
        // Always overwrite if the embedded bytes differ from what's on disk —
        // the embedded bundle is the authoritative version for this build.
        let dir = config_dir()?;
        let target = dir.join("frogcode-im-sidecar.cjs");
        // Always overwrite — compare content hash, not just size
        let should_write = match std::fs::read(&target) {
            Ok(existing) => existing != IM_SIDECAR_BYTES,
            Err(_) => true,
        };
        if should_write {
            info!("Extracting IM sidecar to {:?} ({} bytes)", target, IM_SIDECAR_BYTES.len());
            std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {}", e))?;
            std::fs::write(&target, IM_SIDECAR_BYTES)
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
    inner: Arc<Mutex<ImBridgeInner>>,
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

                                            // Handle execute event: sidecar requests Claude execution
                                            if event_type == "execute" {
                                                let chat_id = evt.get("chatId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                                let prompt = evt.get("prompt").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                                let cwd = evt.get("cwd").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                                let session_id = evt.get("sessionId")
                                                    .and_then(|v| v.as_str())
                                                    .map(|s| s.to_string());
                                                let reply_to = evt.get("replyToMessageId")
                                                    .and_then(|v| v.as_str())
                                                    .map(|s| s.to_string());
                                                let image_files: Vec<String> = evt.get("imageFiles")
                                                    .and_then(|v| v.as_array())
                                                    .map(|arr| arr.iter()
                                                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                                        .collect())
                                                    .unwrap_or_default();
                                                if !chat_id.is_empty() && !prompt.is_empty() {
                                                    let app_for_exec = app.clone();
                                                    tauri::async_runtime::spawn(async move {
                                                        if let Err(e) = execute_claude_for_chat(
                                                            app_for_exec, port, chat_id, prompt, cwd, session_id,
                                                            reply_to, image_files,
                                                        ).await {
                                                            warn!("execute_claude_for_chat failed: {}", e);
                                                        }
                                                    });
                                                }
                                                continue;
                                            }

                                            let event_name = format!("im-bridge:{}", event_type);
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
// Claude execution — spawn claude CLI, parse JSONL, POST card updates to sidecar
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
struct CardState {
    status: String,        // thinking | running | complete | error
    #[serde(rename = "responseText")]
    response_text: String,
    #[serde(rename = "toolCalls")]
    tool_calls: Vec<CardToolCall>,
    #[serde(rename = "errorMessage", skip_serializing_if = "Option::is_none")]
    error_message: Option<String>,
    #[serde(rename = "totalTokens", skip_serializing_if = "Option::is_none")]
    total_tokens: Option<u64>,
    #[serde(rename = "contextWindow", skip_serializing_if = "Option::is_none")]
    context_window: Option<u64>,
    #[serde(rename = "costUsd", skip_serializing_if = "Option::is_none")]
    cost_usd: Option<f64>,
    #[serde(rename = "durationMs", skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
    #[serde(rename = "model", skip_serializing_if = "Option::is_none")]
    model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct CardToolCall {
    name: String,
    detail: String,
    status: String, // running | complete
}

async fn post_card_to_sidecar(
    client: &reqwest::Client,
    port: u16,
    chat_id: &str,
    card_state: &CardState,
    action: &str,
    reply_to_message_id: Option<&str>,
) {
    let url = format!("http://127.0.0.1:{}/feishu-card", port);
    let body = serde_json::json!({
        "chatId": chat_id,
        "cardState": card_state,
        "action": action,
        "replyToMessageId": reply_to_message_id,
    });
    if let Err(e) = client.post(&url).json(&body).send().await {
        debug!("post_card_to_sidecar failed: {}", e);
    }
}

async fn save_session_on_sidecar(
    client: &reqwest::Client,
    port: u16,
    chat_id: &str,
    session_id: &str,
) {
    let url = format!("http://127.0.0.1:{}/save-session", port);
    let body = serde_json::json!({ "chatId": chat_id, "sessionId": session_id });
    let _ = client.post(&url).json(&body).send().await;
}

async fn execute_claude_for_chat(
    app: tauri::AppHandle,
    sidecar_port: u16,
    chat_id: String,
    prompt: String,
    cwd: String,
    session_id: Option<String>,
    reply_to_message_id: Option<String>,
    image_files: Vec<String>,
) -> Result<(), String> {
    info!("execute_claude_for_chat: chat={}, cwd={}, has_session={}, images={}", chat_id, cwd, session_id.is_some(), image_files.len());

    let claude_path = crate::claude_binary::find_claude_binary(&app)?;

    let working_dir = if cwd.is_empty() {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string())
    } else {
        cwd
    };

    // Build prompt: if there are image files, prepend them as context
    let final_prompt = if image_files.is_empty() {
        prompt.clone()
    } else {
        let file_refs: Vec<String> = image_files.iter()
            .map(|f| format!("[Attached file: {}]", f))
            .collect();
        format!("{}\n\n{}", file_refs.join("\n"), prompt)
    };

    // Build args matching frogcode's approach
    let mut args: Vec<String> = Vec::new();
    if let Some(ref sid) = session_id {
        args.push("--resume".to_string());
        args.push(sid.clone());
    }
    args.push("--output-format".to_string());
    args.push("stream-json".to_string());
    args.push("--verbose".to_string());
    args.push("--dangerously-skip-permissions".to_string());
    args.push("-p".to_string());
    args.push(final_prompt);

    let mut cmd = tokio::process::Command::new(&claude_path);
    cmd.args(&args);
    cmd.current_dir(&working_dir);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.stdin(std::process::Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn claude: {}", e))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let http = reqwest::Client::new();
    let started_at = std::time::Instant::now();

    // Send initial "thinking" card
    let mut card = CardState {
        status: "thinking".to_string(),
        response_text: String::new(),
        tool_calls: Vec::new(),
        error_message: None,
        total_tokens: None,
        context_window: None,
        cost_usd: None,
        duration_ms: None,
        model: None,
    };
    post_card_to_sidecar(&http, sidecar_port, &chat_id, &card, "send", reply_to_message_id.as_deref()).await;

    // Read stderr in background (for error reporting)
    let stderr_buf = Arc::new(std::sync::Mutex::new(String::new()));
    let stderr_buf_clone = stderr_buf.clone();
    let stderr_handle = tauri::async_runtime::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => {
                    if let Ok(mut buf) = stderr_buf_clone.lock() {
                        if buf.len() > 4096 {
                            buf.drain(..2048);
                        }
                        buf.push_str(&line);
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Read stdout JSONL
    let mut reader = tokio::io::BufReader::new(stdout);
    let mut line_buf = String::new();
    let mut last_update = std::time::Instant::now();
    let update_interval = std::time::Duration::from_millis(300);

    loop {
        line_buf.clear();
        match reader.read_line(&mut line_buf).await {
            Ok(0) => break, // EOF
            Ok(_) => {}
            Err(e) => {
                warn!("read stdout: {}", e);
                break;
            }
        }

        let trimmed = line_buf.trim();
        if trimmed.is_empty() {
            continue;
        }

        let msg: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // Extract session_id
        if let Some(sid) = msg.get("session_id").and_then(|v| v.as_str()) {
            save_session_on_sidecar(&http, sidecar_port, &chat_id, sid).await;
        }

        let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");

        // Init / system message — capture model info
        if msg_type == "system" {
            card.status = "running".to_string();
            if let Some(model) = msg.get("model").and_then(|v| v.as_str()) {
                card.model = Some(model.to_string());
            }
        }

        // Assistant message with content blocks
        if msg_type == "assistant" {
            if let Some(content) = msg.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
                for block in content {
                    let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if block_type == "text" {
                        if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                            card.status = "running".to_string();
                            card.response_text.push_str(text);
                        }
                    } else if block_type == "tool_use" {
                        let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("tool").to_string();
                        let mut detail = String::new();
                        if let Some(input) = block.get("input").and_then(|v| v.as_object()) {
                            if let Some(cmd) = input.get("command").and_then(|v| v.as_str()) {
                                detail = cmd.chars().take(80).collect();
                            } else if let Some(fp) = input.get("file_path").or(input.get("path")).and_then(|v| v.as_str()) {
                                detail = fp.chars().take(80).collect();
                            }
                        }
                        card.status = "running".to_string();
                        card.tool_calls.push(CardToolCall { name, detail, status: "running".to_string() });
                    }
                }
            }
        }

        // tool_result → mark last tool complete
        if msg_type == "user" {
            if let Some(content) = msg.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
                for block in content {
                    if block.get("type").and_then(|v| v.as_str()) == Some("tool_result") {
                        if let Some(last) = card.tool_calls.last_mut() {
                            last.status = "complete".to_string();
                        }
                    }
                }
            }
        }

        // Result — capture stats
        if msg_type == "result" {
            let is_error = msg.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false)
                || msg.get("subtype").and_then(|v| v.as_str()) == Some("error");
            if is_error {
                card.status = "error".to_string();
                card.error_message = msg.get("result").and_then(|v| v.as_str()).map(|s| s.to_string())
                    .or_else(|| msg.get("error").and_then(|v| v.as_str()).map(|s| s.to_string()));
            } else {
                card.status = "complete".to_string();
                if card.response_text.is_empty() {
                    if let Some(r) = msg.get("result").and_then(|v| v.as_str()) {
                        card.response_text = r.to_string();
                    }
                }
            }
            // Extract stats
            card.duration_ms = Some(started_at.elapsed().as_millis() as u64);
            if let Some(cost) = msg.get("total_cost_usd").and_then(|v| v.as_f64()) {
                card.cost_usd = Some(cost);
            }
            if let Some(dm) = msg.get("duration_ms").and_then(|v| v.as_u64()) {
                card.duration_ms = Some(dm);
            }
            // Model usage — extract total tokens from modelUsage
            if let Some(usage) = msg.get("modelUsage").and_then(|v| v.as_object()) {
                let mut total = 0u64;
                let mut ctx = 0u64;
                for (_model_name, stats) in usage {
                    if let Some(inp) = stats.get("inputTokens").and_then(|v| v.as_u64()) {
                        total += inp;
                    }
                    if let Some(out) = stats.get("outputTokens").and_then(|v| v.as_u64()) {
                        total += out;
                    }
                    if let Some(cw) = stats.get("contextWindow").and_then(|v| v.as_u64()) {
                        if cw > ctx { ctx = cw; }
                    }
                }
                if total > 0 { card.total_tokens = Some(total); }
                if ctx > 0 { card.context_window = Some(ctx); }
            }
        }

        // Throttled update
        if last_update.elapsed() >= update_interval {
            last_update = std::time::Instant::now();
            post_card_to_sidecar(&http, sidecar_port, &chat_id, &card, "auto", None).await;
        }
    }

    // Wait for process to finish
    let exit_status = child.wait().await;
    let _ = stderr_handle.await;

    // Finalize card
    if card.status != "complete" && card.status != "error" {
        match exit_status {
            Ok(status) if !status.success() => {
                card.status = "error".to_string();
                card.error_message = Some(
                    stderr_buf.lock().ok()
                        .map(|b| b.chars().rev().take(500).collect::<String>().chars().rev().collect())
                        .unwrap_or_else(|| format!("claude exited with {:?}", status.code()))
                );
            }
            _ if !card.response_text.is_empty() => {
                card.status = "complete".to_string();
            }
            _ => {
                card.status = "error".to_string();
                card.error_message = Some("No response received".to_string());
            }
        }
    }

    // Final update
    post_card_to_sidecar(&http, sidecar_port, &chat_id, &card, "auto", None).await;
    info!("execute_claude_for_chat done: chat={}, status={}", chat_id, card.status);

    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn im_bridge_get_config() -> Result<FeishuConfig, String> {
    read_config()
}

#[tauri::command]
pub async fn im_bridge_save_config(config: FeishuConfig) -> Result<(), String> {
    write_config(&config)
}

#[tauri::command]
pub async fn im_bridge_start(
    state: tauri::State<'_, ImBridgeState>,
    app: tauri::AppHandle,
) -> Result<BridgeStatusInfo, String> {
    let inner = state.inner.clone();
    let mut g = inner.lock().await;

    // Already running?
    if g.status == BridgeStatus::Running && g.child.is_some() {
        return Ok(BridgeStatusInfo {
            status: BridgeStatus::Running,
            port: g.port,
            error: None,
            feishu_status: g.feishu_status.clone(),
        });
    }

    g.status = BridgeStatus::Starting;
    g.error = None;

    // Resolve sidecar path
    let sidecar_path = get_or_extract_sidecar()?;
    if !sidecar_path.exists() {
        g.status = BridgeStatus::Error;
        g.error = Some(format!("sidecar not found: {:?}", sidecar_path));
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

    // Spawn
    let mut cmd = tokio::process::Command::new("node");
    cmd.arg(&sidecar_path)
        .arg("--port")
        .arg("0")
        .arg("--config")
        .arg(cfg_path.to_string_lossy().as_ref())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

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
            return Err(g.error.clone().unwrap());
        }
        Err(_) => {
            let _ = child.kill().await;
            g.status = BridgeStatus::Error;
            g.error = Some("sidecar did not emit READY within 10s".to_string());
            return Err(g.error.clone().unwrap());
        }
    }

    // Parse port from "FROGCODE_SIDECAR_READY port=<N>"
    let port: u16 = line
        .trim()
        .strip_prefix("FROGCODE_SIDECAR_READY port=")
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| {
            format!("unexpected sidecar stdout: {}", line.trim())
        })?;

    info!("IM sidecar ready on port {}", port);

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
pub async fn im_bridge_stop(
    state: tauri::State<'_, ImBridgeState>,
) -> Result<(), String> {
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
        info!("IM sidecar process killed");
    }

    g.port = None;
    g.status = BridgeStatus::Stopped;
    g.error = None;
    g.feishu_status = None;

    Ok(())
}

#[tauri::command]
pub async fn im_bridge_status(
    state: tauri::State<'_, ImBridgeState>,
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
pub async fn im_bridge_connect_feishu(
    state: tauri::State<'_, ImBridgeState>,
) -> Result<bool, String> {
    let g = state.inner.lock().await;
    let port = g.port.ok_or("sidecar not running")?;
    drop(g);

    let url = format!("http://127.0.0.1:{}/connect", port);
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("connect: {}", e))?;
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("json: {}", e))?;
    Ok(body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false))
}
