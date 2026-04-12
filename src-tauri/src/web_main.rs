//! Entry point for the `frogcode-web` binary.
//!
//! Runs an Axum + WebSocket HTTP server that exposes a subset of frogcode's
//! functionality to browsers / mobile devices. Shares the same Rust backend
//! code as the Tauri desktop binary via the `_with_deps` functions in
//! `commands::claude::cli_runner`.
//!
//! Default data dir lives alongside the desktop app's `agents.db` so both
//! run from the same SQLite database (SQLite is put into WAL mode to
//! tolerate concurrent access).
//!
//! Example usage:
//!
//! ```bash
//! frogcode-web --port 8080 --openclaw-url http://127.0.0.1:7890
//! ```

use std::path::PathBuf;

use clap::Parser;

// The web binary needs its own copy of every module the cli_runner reaches
// into transitively. Keep this in sync with `main.rs` when adding or
// removing top-level modules.
mod claude_binary;
mod commands;
mod process;
mod utils;

mod mcp;
mod claude_mcp;
mod codex_mcp;
mod gemini_mcp;

mod web_server;

#[derive(Parser, Debug)]
#[command(
    name = "frogcode-web",
    about = "frogcode web server — browser access to the Claude runner"
)]
struct Args {
    /// TCP port to bind.
    #[arg(short, long, default_value_t = 8080)]
    port: u16,

    /// Host interface to bind (use 0.0.0.0 for LAN access).
    #[arg(short = 'H', long, default_value = "0.0.0.0")]
    host: String,

    /// App data directory (where `agents.db` lives). If omitted, uses the
    /// same default location as the desktop binary.
    #[arg(long)]
    data_dir: Option<PathBuf>,

    /// OpenClaw Node sidecar base URL. When set, `/api/openclaw/*` requests
    /// are transparently proxied to this URL. Leave unset to disable the
    /// proxy.
    #[arg(long)]
    openclaw_url: Option<String>,
}

fn default_data_dir() -> PathBuf {
    // Match the desktop app's `app_data_dir` convention so both binaries
    // read/write the same agents.db.
    //
    // Tauri's `app_data_dir` resolves to:
    //   * Windows: %APPDATA%\com.frog-code.app   (but actual frogcode uses
    //     the `productName` from tauri.conf.json)
    //   * macOS: ~/Library/Application Support/<productName>
    //   * Linux: ~/.config/<productName>
    //
    // In practice the desktop app writes to `~/.frogcode/` based on the
    // existing `~/.frogcode` references in the codebase. We default to that
    // to keep both binaries pointed at the same place.
    if let Some(home) = dirs::home_dir() {
        home.join(".frogcode")
    } else {
        PathBuf::from(".frogcode")
    }
}

#[tokio::main]
async fn main() {
    env_logger::init();
    let args = Args::parse();

    let data_dir = args.data_dir.unwrap_or_else(default_data_dir);
    if !data_dir.exists() {
        if let Err(e) = std::fs::create_dir_all(&data_dir) {
            eprintln!("Failed to create data dir {:?}: {}", data_dir, e);
            std::process::exit(1);
        }
    }

    println!("🚀 Starting frogcode-web");
    println!("   data_dir    : {:?}", data_dir);
    println!("   openclaw_url: {:?}", args.openclaw_url);

    if let Err(e) = web_server::start(args.host, args.port, data_dir, args.openclaw_url).await {
        eprintln!("❌ frogcode-web failed: {}", e);
        std::process::exit(1);
    }
}
