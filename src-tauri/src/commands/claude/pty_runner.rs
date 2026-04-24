//! PTY-channel executor for Claude CLI.
//!
//! Sister to `cli_runner.rs`. Spawns the `claude` binary inside a pseudo-
//! terminal (via `portable-pty`) so the CLI's interactive Ink-based menus
//! (e.g. "Detected a custom API key... 1. Yes 2. No", `/login` wizard) work
//! correctly. The frontend renders raw PTY output through xterm.js.
//!
//! The default channel remains `cli_runner.rs` (stream-json). PTY mode is
//! triggered manually from the UI or automatically for blacklisted slash
//! commands (`/login`, `/init`, `/logout`, `/setup-token`).

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::json;
use std::io::Read;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use super::cli_runner::map_model_to_claude_alias;
use crate::commands::permission_config::{build_execution_args, ClaudeExecutionConfig};
use crate::process::ProcessRegistryState;

/// Local copy of `cli_runner::is_slash_command` (4 LOC, easier to duplicate
/// than to make `pub(super)` and risk leaking).
fn is_slash_command(prompt: &str) -> bool {
    let trimmed = prompt.trim();
    trimmed.starts_with('/') && !trimmed.contains('\n') && trimmed.len() < 256
}

/// Spawn Claude inside a PTY. Returns a synthetic `session_id` (`pty-<uuid>`)
/// the frontend uses to subscribe to `pty-output:<sid>` events and to call
/// `pty_send_input` / `pty_resize` / `cancel_claude_execution`.
#[tauri::command]
pub async fn execute_claude_pty(
    app: AppHandle,
    registry: tauri::State<'_, ProcessRegistryState>,
    project_path: String,
    prompt: String,
    model: String,
    tab_id: Option<String>,
) -> Result<String, String> {
    // Synthetic session id (PTY mode never gets a real one from Claude init).
    let session_id = format!("pty-{}", Uuid::new_v4());

    // Resolve claude binary.
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app_data_dir: {}", e))?;
    let claude_path = crate::claude_binary::find_claude_binary_with_data_dir(&data_dir)?;

    // 🔥 REMOVED: apiKeyHelper auto-injection causes "Auth conflict" with ANTHROPIC_API_KEY
    // Claude CLI error: "Both a token (apiKeyHelper) and an API key (ANTHROPIC_API_KEY) are set"
    // Solution: Let users manage apiKeyHelper manually if needed, don't auto-inject

    // Build CLI args via the same builder cli_runner uses, so permission
    // config and skip flags stay consistent across both channels.
    let execution_config = super::config::load_claude_execution_config()
        .await
        .unwrap_or_else(|e| {
            log::warn!("[pty] load_claude_execution_config fallback: {}", e);
            ClaudeExecutionConfig::default()
        });
    let mapped_model = map_model_to_claude_alias(&model);
    let mut args = build_execution_args(&execution_config, &mapped_model);

    // PTY mode runs the native TUI — strip stream-json output flags.
    let mut filtered: Vec<String> = Vec::with_capacity(args.len());
    let mut skip_next = false;
    for a in args.drain(..) {
        if skip_next {
            skip_next = false;
            continue;
        }
        if a == "--output-format" || a == "--input-format" {
            skip_next = true;
            continue;
        }
        if a.starts_with("--output-format=") || a.starts_with("--input-format=") {
            continue;
        }
        filtered.push(a);
    }
    args = filtered;

    // Slash-command prompts go via -p so the CLI parses them as commands.
    if is_slash_command(&prompt) {
        args.push("-p".to_string());
        args.push(prompt.clone());
    }

    // Build CommandBuilder for portable-pty.
    let mut cmd = CommandBuilder::new(&claude_path);
    for arg in &args {
        cmd.arg(arg);
    }
    cmd.cwd(&project_path);
    // Inherit current env, then override the bits we care about.
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("ANTHROPIC_MODEL", &mapped_model);
    // Pre-empt other interactive prompts (auto-update / telemetry).
    cmd.env("DISABLE_AUTOUPDATER", "1");
    cmd.env("DISABLE_TELEMETRY", "1");
    cmd.env("DISABLE_BUG_COMMAND", "1");
    cmd.env("DISABLE_ERROR_REPORTING", "1");
    cmd.env("CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL", "1");

    // Open PTY pair.
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {}", e))?;

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn_command: {}", e))?;
    let pid = child.process_id().unwrap_or(0);

    // ⚠️ Do NOT `drop(pair.slave)` here. portable-pty's SlavePty/MasterPty
    // share an `Arc<Inner>`; releasing the slave reference too early on
    // Windows races libuv inside Node (Claude CLI is a Node process), which
    // panics with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
    // (libuv `src/win/async.c:76`). Keep the slave alive until after
    // `child.wait()` returns. See openai/codex#14679 for the same root cause.
    let slave_keepalive = pair.slave;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("try_clone_reader: {}", e))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {}", e))?;

    // Register with ProcessRegistry (PID side — for list/kill/cancel).
    let run_id = registry.0.register_claude_session_with_job(
        session_id.clone(),
        pid,
        project_path.clone(),
        prompt.clone(),
        model.clone(),
        None,
    )?;

    // Register PTY side (writer + master for input/resize).
    registry.0.register_pty(session_id.clone(), writer, pair.master)?;

    crate::commands::platform_bridge::append_session_log(
        "rust",
        "info",
        "cli",
        &format!(
            "[pty] spawned pid={} sid={} run_id={} tab={:?}",
            pid, session_id, run_id, tab_id
        ),
    );

    // Notify frontend the session started (mirrors cli_runner's payload shape
    // with an extra `mode: "pty"` discriminator).
    let _ = app.emit(
        "claude-session-state",
        json!({
            "session_id": session_id,
            "project_path": project_path,
            "model": model,
            "status": "started",
            "pid": pid,
            "run_id": run_id,
            "mode": "pty",
        }),
    );

    // Reader thread: pump PTY output → frontend xterm via Tauri events.
    let sid_for_reader = session_id.clone();
    let app_for_reader = app.clone();
    tokio::task::spawn_blocking(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_for_reader
                        .emit(&format!("pty-output:{}", sid_for_reader), &chunk);
                }
                Err(_) => break,
            }
        }
    });

    // For non-slash prompts, write the prompt + newline to the PTY now so the
    // user sees Claude start working without having to type anything.
    if !is_slash_command(&prompt) && !prompt.is_empty() {
        let mut prompt_to_send = prompt.clone();
        if !prompt_to_send.ends_with('\n') {
            prompt_to_send.push('\n');
        }
        if let Err(e) = registry
            .0
            .write_pty_input(&session_id, prompt_to_send.as_bytes())
        {
            crate::commands::platform_bridge::append_session_log(
                "rust",
                "warn",
                "cli",
                &format!("[pty] initial prompt write failed: {}", e),
            );
        }
    }

    // Wait task: emit completion + clean up registry on exit.
    // `slave_keepalive` is moved in so the SlavePty Arc reference outlives
    // child.wait(); only after the child has fully exited do we let it drop,
    // avoiding the libuv UV_HANDLE_CLOSING assertion inside Node.
    let sid_for_wait = session_id.clone();
    let app_for_wait = app.clone();
    let registry_arc = registry.0.clone();
    tokio::task::spawn_blocking(move || {
        let status = child.wait();
        let success = status.as_ref().map(|s| s.success()).unwrap_or(false);
        let exit_code = status.as_ref().ok().map(|s| s.exit_code());
        crate::commands::platform_bridge::append_session_log(
            "rust",
            "info",
            "cli",
            &format!(
                "[pty] exit sid={} success={} code={:?}",
                sid_for_wait, success, exit_code
            ),
        );
        let _ = app_for_wait.emit(&format!("claude-complete:{}", sid_for_wait), &success);
        let _ = app_for_wait.emit(
            "claude-session-state",
            json!({
                "session_id": sid_for_wait,
                "status": "stopped",
                "success": success,
                "mode": "pty",
            }),
        );
        // Drop order matters on Windows: child is already dead, now release
        // the slave (its half of ConPTY) BEFORE the master gets dropped via
        // `unregister_pty`. Explicit drop ensures the order even if rustc
        // would otherwise reorder.
        drop(slave_keepalive);
        let _ = registry_arc.unregister_pty(&sid_for_wait);
    });

    Ok(session_id)
}

/// Forward bytes from the frontend xterm to the PTY's stdin.
#[tauri::command]
pub async fn pty_send_input(
    registry: tauri::State<'_, ProcessRegistryState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    registry.0.write_pty_input(&session_id, data.as_bytes())
}

/// Resize the PTY when the xterm container resizes.
#[tauri::command]
pub async fn pty_resize(
    registry: tauri::State<'_, ProcessRegistryState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    registry.0.resize_pty(&session_id, cols, rows)
}
