//! Entry point for the `frogcode-cli` binary.
//!
//! Headless CLI for Linux/macOS/Windows users who want to manage Frog Code
//! without the Tauri GUI. Shares the same Rust backend — login reuses
//! `commands::auth`, IM channel CRUD reuses `commands::platform_bridge` —
//! so GUI and CLI operate on the same `~/.frogcode/*.json` files and are
//! fully interoperable.
//!
//! Example usage:
//!
//! ```bash
//! frogcode-cli login --username alice --password s3cret
//! frogcode-cli im add --platform feishu --app-id cli_abc --app-secret xyz --label prod --assign claudecode
//! frogcode-cli im list
//! frogcode-cli im remove feishu-cli_abc
//! ```

use std::io::Write;
use std::path::PathBuf;

use base64::Engine;
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// Module tree — must match what web_main.rs / main.rs pull in so the reached
// command functions compile in this binary too.
mod claude_binary;
mod commands;
mod process;
mod utils;

mod mcp;
mod claude_mcp;
mod codex_mcp;
mod gemini_mcp;

use commands::auth::{FrogclawLoginSession, FrogclawToken, UserData};

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

#[derive(Parser, Debug)]
#[command(
    name = "frogcode-cli",
    about = "Frog Code headless CLI — login and IM channel management without the GUI",
    version
)]
struct Cli {
    #[command(subcommand)]
    cmd: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Log in to frogclaw and cache the session on disk
    Login {
        #[arg(short, long)]
        username: Option<String>,
        #[arg(short, long)]
        password: Option<String>,
        /// Persist credentials (base64) to ~/.frogcode/cli-session.json for later auto-login
        #[arg(long)]
        save_creds: bool,
    },
    /// Remove the cached session file
    Logout,
    /// Show the currently logged-in user
    Whoami,
    /// IM channel management
    Im {
        #[command(subcommand)]
        action: ImAction,
    },
    /// Development environment: check & install tools (Node.js, Git, Claude Code, Codex, Gemini, OpenClaw)
    Env {
        #[command(subcommand)]
        action: EnvAction,
    },
}

#[derive(Subcommand, Debug)]
enum EnvAction {
    /// Print a status table for all supported tools
    Check {
        /// Emit JSON instead of a table
        #[arg(long)]
        json: bool,
    },
    /// Install one tool by id, or all missing tools when no id is given.
    /// Valid ids: node, git, claude, codex, gemini, openclaw
    Install {
        /// Optional tool id. Omit to install every missing tool in dependency order.
        tool: Option<String>,
        /// Reinstall even if the tool is already detected.
        #[arg(long)]
        force: bool,
    },
}

#[derive(Subcommand, Debug)]
enum ImAction {
    /// Add a new IM channel (errors if the id already exists)
    Add {
        #[arg(long, value_parser = ["feishu", "qq", "wechat"])]
        platform: String,
        #[arg(long)]
        app_id: String,
        #[arg(long)]
        app_secret: String,
        #[arg(long)]
        label: Option<String>,
        #[arg(long, default_value = "none", value_parser = ["claudecode", "openclaw", "none"])]
        assign: String,
        /// QQ Bot only: use the sandbox API
        #[arg(long)]
        sandbox: bool,
    },
    /// List all configured IM channels
    List {
        /// Emit full JSON (including app secrets) instead of a table
        #[arg(long)]
        json: bool,
    },
    /// Remove a channel by id (e.g. feishu-cli_abc)
    Remove { id: String },
}

// ---------------------------------------------------------------------------
// Session file
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
struct CliSession {
    user: UserData,
    tokens: Vec<FrogclawToken>,
    saved_at: String,
    /// base64("username:password") — only present if user passed --save-creds
    credentials_b64: Option<String>,
}

fn home_dir() -> anyhow::Result<PathBuf> {
    dirs::home_dir().ok_or_else(|| anyhow::anyhow!("Cannot determine home directory"))
}

fn frogcode_dir() -> anyhow::Result<PathBuf> {
    let dir = home_dir()?.join(".frogcode");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn session_path() -> anyhow::Result<PathBuf> {
    Ok(frogcode_dir()?.join("cli-session.json"))
}

fn read_session() -> anyhow::Result<Option<CliSession>> {
    let p = session_path()?;
    if !p.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&p)?;
    let s: CliSession = serde_json::from_str(&raw)?;
    Ok(Some(s))
}

fn write_session(sess: &CliSession) -> anyhow::Result<()> {
    let p = session_path()?;
    let dir = p.parent().unwrap();
    let raw = serde_json::to_string_pretty(sess)?;

    // Atomic replace: write to a sibling tmp then rename.
    let tmp = dir.join(format!(
        "cli-session.json.tmp.{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    std::fs::write(&tmp, raw)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&tmp)?.permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&tmp, perms)?;
    }
    if cfg!(windows) && p.exists() {
        let _ = std::fs::remove_file(&p);
    }
    std::fs::rename(&tmp, &p)?;
    Ok(())
}

fn append_cli_log(event: &str, detail: &str) {
    let Ok(path) = frogcode_dir().map(|d| d.join("platform-sidecar.log")) else { return };
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let ts = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f");
        let _ = writeln!(f, "[{}] [cli {}] {}", ts, event, detail);
    }
}

// ---------------------------------------------------------------------------
// login / logout / whoami
// ---------------------------------------------------------------------------

fn prompt_line(prompt: &str) -> anyhow::Result<String> {
    print!("{}", prompt);
    std::io::stdout().flush()?;
    let mut s = String::new();
    std::io::stdin().read_line(&mut s)?;
    Ok(s.trim().to_string())
}

fn resolve_credentials(
    arg_user: Option<String>,
    arg_pass: Option<String>,
) -> anyhow::Result<(String, String)> {
    // Priority: CLI args > existing saved creds > interactive prompt.
    let saved = read_session().ok().flatten();
    let saved_decoded: Option<(String, String)> = saved
        .as_ref()
        .and_then(|s| s.credentials_b64.as_ref())
        .and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|s| {
            let mut it = s.splitn(2, ':');
            Some((it.next()?.to_string(), it.next()?.to_string()))
        });

    let username = match arg_user {
        Some(u) => u,
        None => match saved_decoded.as_ref().map(|(u, _)| u.clone()) {
            Some(u) => {
                println!("Using saved username: {}", u);
                u
            }
            None => prompt_line("Username: ")?,
        },
    };
    if username.is_empty() {
        anyhow::bail!("username must not be empty");
    }

    let password = match arg_pass {
        Some(p) => p,
        None => match saved_decoded.as_ref().map(|(_, p)| p.clone()) {
            Some(p) => p,
            None => rpassword::prompt_password("Password: ")?,
        },
    };
    if password.is_empty() {
        anyhow::bail!("password must not be empty");
    }

    Ok((username, password))
}

async fn cmd_login(
    username_arg: Option<String>,
    password_arg: Option<String>,
    save_creds: bool,
) -> anyhow::Result<()> {
    let (username, password) = resolve_credentials(username_arg, password_arg)?;

    println!("Logging in as {}...", username);
    let session: FrogclawLoginSession =
        commands::auth::fetch_frogclaw_providers(username.clone(), password.clone())
            .await
            .map_err(|e| anyhow::anyhow!(e))?;

    // If the server advertises an openclaw CLI provider, write its config
    // just like the GUI AuthContext does on successful login.
    let mut openclaw_applied = false;
    if let Some(oc) = session
        .cli_providers
        .iter()
        .find(|p| p.provider_type == "openclaw")
    {
        if let Some(cfg) = &oc.settings_config {
            match commands::auth::apply_openclaw_config(cfg.clone()).await {
                Ok(_) => openclaw_applied = true,
                Err(e) => eprintln!("warn: failed to apply openclaw config: {}", e),
            }
        }
    }

    let credentials_b64 = if save_creds {
        Some(
            base64::engine::general_purpose::STANDARD
                .encode(format!("{}:{}", username, password).as_bytes()),
        )
    } else {
        None
    };

    let cli_session = CliSession {
        user: session.user,
        tokens: session.tokens,
        saved_at: chrono::Local::now().to_rfc3339(),
        credentials_b64,
    };
    write_session(&cli_session)?;

    println!(
        "✓ Logged in as {} ({})",
        cli_session.user.display_name, cli_session.user.group
    );
    println!("  tokens cached: {}", cli_session.tokens.len());
    if openclaw_applied {
        println!("  openclaw config applied -> ~/.frogcode/openclaw/config/openclaw.json");
    }
    if save_creds {
        println!("  credentials saved (base64) in ~/.frogcode/cli-session.json");
    }

    append_cli_log(
        "login",
        &format!(
            "user {} ({}) 通过 CLI 登录成功",
            cli_session.user.username, cli_session.user.id
        ),
    );
    Ok(())
}

fn cmd_logout() -> anyhow::Result<()> {
    let p = session_path()?;
    if p.exists() {
        std::fs::remove_file(&p)?;
        println!("✓ Logged out (removed {})", p.display());
        append_cli_log("logout", "CLI 会话文件已删除");
    } else {
        println!("No session to clear.");
    }
    Ok(())
}

fn cmd_whoami() -> anyhow::Result<()> {
    let Some(s) = read_session()? else {
        anyhow::bail!("not logged in — run `frogcode-cli login`");
    };
    println!("username     : {}", s.user.username);
    println!("display_name : {}", s.user.display_name);
    println!("id           : {}", s.user.id);
    println!("group        : {}", s.user.group);
    println!("tokens       : {}", s.tokens.len());
    println!("saved_at     : {}", s.saved_at);
    println!(
        "credentials  : {}",
        if s.credentials_b64.is_some() { "stored" } else { "not stored" }
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// im add / list / remove
// ---------------------------------------------------------------------------

fn mask(s: &str) -> String {
    // Keep first 4 and last 2 chars, mask the middle. Short strings get full mask.
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= 6 {
        return "*".repeat(chars.len());
    }
    let head: String = chars.iter().take(4).collect();
    let tail: String = chars.iter().rev().take(2).collect::<String>().chars().rev().collect();
    format!("{}…{}", head, tail)
}

fn channel_id(platform: &str, app_id: &str) -> String {
    format!("{}-{}", platform, app_id)
}

async fn read_im_value() -> anyhow::Result<Value> {
    commands::platform_bridge::get_im_channels()
        .await
        .map_err(|e| anyhow::anyhow!(e))
}

async fn write_im_value(value: Value) -> anyhow::Result<()> {
    commands::platform_bridge::save_im_channels(value)
        .await
        .map_err(|e| anyhow::anyhow!(e))
}

async fn cmd_im_add(
    platform: String,
    app_id: String,
    app_secret: String,
    label: Option<String>,
    assign: String,
    sandbox: bool,
) -> anyhow::Result<()> {
    let mut root = read_im_value().await?;
    let obj = root.as_object_mut().ok_or_else(|| anyhow::anyhow!("corrupt im-channels.json"))?;
    let channels = obj
        .entry("channels".to_string())
        .or_insert_with(|| Value::Array(vec![]));
    let arr = channels.as_array_mut().ok_or_else(|| anyhow::anyhow!("channels is not an array"))?;

    let id = channel_id(&platform, &app_id);
    if arr.iter().any(|c| c.get("id").and_then(|v| v.as_str()) == Some(id.as_str())) {
        anyhow::bail!("channel '{}' already exists — run `im remove {}` first", id, id);
    }

    let mut entry = json!({
        "id": id,
        "platform": platform,
        "appId": app_id,
        "appSecret": app_secret,
        "label": label.unwrap_or_default(),
        "assignment": assign,
    });
    if platform == "qq" && sandbox {
        entry["sandbox"] = Value::Bool(true);
    }
    arr.push(entry);

    write_im_value(root).await?;
    println!("✓ Added channel {}", id);
    append_cli_log("im-add", &format!("CLI 添加 IM 通道 {}", id));
    Ok(())
}

async fn cmd_im_list(as_json: bool) -> anyhow::Result<()> {
    let root = read_im_value().await?;
    let empty = Vec::new();
    let channels: &Vec<Value> = root
        .get("channels")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);

    if as_json {
        let out = json!({
            "channels": channels,
            "suppressedAppIds": root.get("suppressedAppIds").cloned().unwrap_or(json!([])),
        });
        println!("{}", serde_json::to_string_pretty(&out)?);
        return Ok(());
    }

    if channels.is_empty() {
        println!("No IM channels configured.");
        return Ok(());
    }

    // Columns: ID | PLATFORM | LABEL | APP_ID | ASSIGN
    println!(
        "{:<28} {:<9} {:<16} {:<18} {}",
        "ID", "PLATFORM", "LABEL", "APP_ID", "ASSIGN"
    );
    println!("{}", "-".repeat(80));
    for c in channels {
        let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let platform = c.get("platform").and_then(|v| v.as_str()).unwrap_or("");
        let label = c.get("label").and_then(|v| v.as_str()).unwrap_or("");
        let app_id = c.get("appId").and_then(|v| v.as_str()).unwrap_or("");
        let assign = c.get("assignment").and_then(|v| v.as_str()).unwrap_or("none");
        println!(
            "{:<28} {:<9} {:<16} {:<18} {}",
            truncate(id, 28),
            platform,
            truncate(label, 16),
            mask(app_id),
            assign
        );
    }
    Ok(())
}

async fn cmd_im_remove(id: String) -> anyhow::Result<()> {
    let mut root = read_im_value().await?;
    let obj = root.as_object_mut().ok_or_else(|| anyhow::anyhow!("corrupt im-channels.json"))?;
    let before_len: usize;
    let after_len: usize;
    {
        let arr = obj
            .get_mut("channels")
            .and_then(|v| v.as_array_mut())
            .ok_or_else(|| anyhow::anyhow!("channels array missing"))?;
        before_len = arr.len();
        arr.retain(|c| c.get("id").and_then(|v| v.as_str()) != Some(id.as_str()));
        after_len = arr.len();
    }
    if before_len == after_len {
        anyhow::bail!("no channel with id '{}'", id);
    }
    write_im_value(root).await?;
    println!("✓ Removed channel {}", id);
    append_cli_log("im-remove", &format!("CLI 删除 IM 通道 {}", id));
    Ok(())
}

fn truncate(s: &str, n: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= n {
        s.to_string()
    } else {
        let head: String = chars.iter().take(n.saturating_sub(1)).collect();
        format!("{}…", head)
    }
}

// ---------------------------------------------------------------------------
// env check / env install
// ---------------------------------------------------------------------------

const TOOL_ORDER: &[&str] = &["node", "git", "claude", "codex", "gemini", "openclaw"];

async fn cmd_env_check(as_json: bool) -> anyhow::Result<()> {
    let status = commands::home::check_tools_installed()
        .await
        .map_err(|e| anyhow::anyhow!(e))?;

    if as_json {
        println!("{}", serde_json::to_string_pretty(&status.tools)?);
        return Ok(());
    }

    println!("{:<10} {:<14} {:<10} {}", "ID", "NAME", "STATUS", "VERSION / PATH");
    println!("{}", "-".repeat(80));
    for t in &status.tools {
        let status_text = if t.installed { "installed" } else { "missing" };
        let detail = match (&t.version, &t.path) {
            (Some(v), _) => v.clone(),
            (None, Some(p)) => p.clone(),
            _ => "-".to_string(),
        };
        println!(
            "{:<10} {:<14} {:<10} {}",
            t.id,
            truncate(&t.name, 14),
            status_text,
            truncate(&detail, 50)
        );
    }
    let missing: Vec<_> = status.tools.iter().filter(|t| !t.installed && t.installable).collect();
    if missing.is_empty() {
        println!("\nAll tools installed.");
    } else {
        let ids: Vec<_> = missing.iter().map(|t| t.id.as_str()).collect();
        println!("\n{} missing: {}", missing.len(), ids.join(", "));
        println!("Run: frogcode-cli env install   (installs everything missing)");
    }
    Ok(())
}

async fn install_one(id: &str) -> anyhow::Result<bool> {
    println!("→ Installing {}...", id);
    append_cli_log("env-install", &format!("开始安装 {}", id));
    let res = commands::home::install_tool(id.to_string())
        .await
        .map_err(|e| anyhow::anyhow!(e))?;

    if !res.stdout.trim().is_empty() {
        println!("{}", res.stdout.trim_end());
    }
    if !res.stderr.trim().is_empty() {
        eprintln!("{}", res.stderr.trim_end());
    }

    if res.success {
        println!("✓ {} installed", id);
        append_cli_log("env-install", &format!("{} 安装成功", id));
        Ok(true)
    } else {
        println!("✗ {} failed: {}", id, res.message);
        if let Some(log) = &res.log_file {
            println!("  详细日志: {}", log);
        }
        append_cli_log("env-install", &format!("{} 安装失败: {}", id, res.message));
        Ok(false)
    }
}

async fn cmd_env_install(tool: Option<String>, force: bool) -> anyhow::Result<()> {
    // Specific tool requested.
    if let Some(id) = tool {
        if !TOOL_ORDER.contains(&id.as_str()) {
            anyhow::bail!(
                "unknown tool '{}' — valid: {}",
                id,
                TOOL_ORDER.join(", ")
            );
        }
        if !force {
            let status = commands::home::check_tools_installed()
                .await
                .map_err(|e| anyhow::anyhow!(e))?;
            if status.tools.iter().any(|t| t.id == id && t.installed) {
                println!(
                    "{} already installed. Use --force to reinstall.",
                    id
                );
                return Ok(());
            }
        }
        let ok = install_one(&id).await?;
        if !ok {
            anyhow::bail!("installation of '{}' failed", id);
        }
        return Ok(());
    }

    // Install all missing tools in dependency order.
    let status = commands::home::check_tools_installed()
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    let installed_ids: std::collections::HashSet<String> = status
        .tools
        .iter()
        .filter(|t| t.installed)
        .map(|t| t.id.clone())
        .collect();

    let mut failed: Vec<String> = Vec::new();
    let mut installed_any = false;
    for id in TOOL_ORDER {
        if installed_ids.contains(*id) && !force {
            println!("· {} already installed, skipping", id);
            continue;
        }
        let ok = install_one(id).await?;
        if ok {
            installed_any = true;
        } else {
            failed.push((*id).to_string());
        }
    }

    println!();
    if failed.is_empty() {
        if installed_any {
            println!("✓ All requested tools installed. Run `frogcode-cli env check` to verify.");
        } else {
            println!("Nothing to install. Everything already present.");
        }
    } else {
        println!("✗ {} failed: {}", failed.len(), failed.join(", "));
        anyhow::bail!("{} tool(s) failed to install", failed.len());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() -> std::process::ExitCode {
    env_logger::init();
    let cli = Cli::parse();

    let result: anyhow::Result<()> = match cli.cmd {
        Command::Login { username, password, save_creds } => {
            cmd_login(username, password, save_creds).await
        }
        Command::Logout => cmd_logout(),
        Command::Whoami => cmd_whoami(),
        Command::Im { action } => match action {
            ImAction::Add { platform, app_id, app_secret, label, assign, sandbox } => {
                cmd_im_add(platform, app_id, app_secret, label, assign, sandbox).await
            }
            ImAction::List { json } => cmd_im_list(json).await,
            ImAction::Remove { id } => cmd_im_remove(id).await,
        },
        Command::Env { action } => match action {
            EnvAction::Check { json } => cmd_env_check(json).await,
            EnvAction::Install { tool, force } => cmd_env_install(tool, force).await,
        },
    };

    match result {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {}", e);
            std::process::ExitCode::FAILURE
        }
    }
}
