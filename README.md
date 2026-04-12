# Frog Code

> Professional AI Code Assistant Desktop App - Multi-engine, IM Integration, Modern GUI Toolkit

[![Release](https://img.shields.io/github/v/release/nevermorewish/frogcode?style=flat-square)](https://github.com/nevermorewish/frogcode/releases)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg?style=flat-square)](https://github.com/nevermorewish/frogcode)
[![Made with Tauri](https://img.shields.io/badge/Made%20with-Tauri-FFC131?style=flat-square&logo=tauri)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react)](https://react.dev/)
[![Rust](https://img.shields.io/badge/Rust-Latest-orange?style=flat-square&logo=rust)](https://rust-lang.org/)

---

## Introduction

Frog Code is a professional desktop application for AI-driven code development workflows. It supports [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/overview), [OpenAI Codex](https://openai.com/index/openai-codex/), [Google Gemini CLI](https://github.com/google-gemini/gemini-cli), and [OpenClaw](https://openclaw.com/) as AI backends. Through Feishu (Lark) IM integration, you can chat with AI coding assistants directly from your messaging app.

### Key Highlights

- **Multi-Engine Architecture** - Claude Code, OpenAI Codex, Google Gemini, and OpenClaw, switchable with one click
- **Feishu IM Integration** - Chat with AI directly in Feishu, with streaming card updates and interactive buttons
- **Multi-Bot Support** - Add multiple Feishu bots, each assignable to a different AI backend
- **Frogclaw Server** - Login to get API tokens, OpenClaw config, and Feishu credentials automatically
- **OpenClaw Gateway** - Built-in process management with auto-start, session history browser, and log viewer
- **Complete Session Management** - Multi-tab sessions, history, real-time streaming, cross-engine unified management
- **Cost Tracking** - Multi-model pricing, token statistics, usage analytics dashboard
- **Smart Translation** - Transparent Chinese-English translation middleware with 8 content extraction strategies
- **Auto Context Management** - Intelligent monitoring, auto compression, token optimization
- **Modern UI/UX** - Dark/light theme, smooth animations, responsive design, i18n support

---

## Quick Start (3 Steps)

### Step 1: Install Dev Environment

Launch Frog Code and the homepage will detect required tools automatically. Click **One-Click Install** to install missing tools:

| Tool | Purpose |
|------|---------|
| Node.js | Runtime for sidecar processes |
| Git | Version control |
| Claude Code | Official Claude CLI (requires Claude Max subscription) |
| OpenClaw | Alternative AI gateway (via Frogclaw server) |

### Step 2: Login to Frogclaw

Enter your Frogclaw username and password on the homepage. After login, the app automatically:
- Fetches API tokens for authentication
- Downloads OpenClaw model configuration
- Syncs Feishu app credentials into IM channel settings

### Step 3: Configure Feishu Channel

Go to **IM Channels** page and:
1. Click **Add Channel** to enter your Feishu bot's App ID and App Secret
2. Use the dropdown to assign an AI backend:
   - **Claude Code** - Uses official Claude Max subscription
   - **OpenClaw** - Routes through Frogclaw server with configurable models
3. The bot connects automatically. Send a message in Feishu to start coding with AI!

> Multiple Feishu bots are supported. Each backend can only be bound to one channel at a time.

---

## AI Engines

<table>
<tr>
<td width="25%">

**Claude Code CLI**
- Official Claude Code CLI integration
- All Claude models (Opus, Sonnet, etc.)
- Plan Mode read-only analysis
- Full MCP and tool support
- Smart Hooks automation

</td>
<td width="25%">

**OpenAI Codex**
- Codex API deep integration
- Full Auto / Danger Full Access / Read-only modes
- Configurable models and output schema
- JSON format streaming

</td>
<td width="25%">

**Google Gemini**
- Gemini CLI integration
- Gemini 3 Pro, 2.5 Pro/Flash
- Google OAuth / API Key / Vertex AI
- Million-token context window

</td>
<td width="25%">

**OpenClaw**
- Alternative AI gateway
- Configurable model routing
- Built-in process management
- Auto-start on app launch
- Session history browser

</td>
</tr>
</table>

---

## Feishu IM Integration

The platform bridge connects Feishu (Lark) messaging to AI backends through a Node.js sidecar:

```
Feishu Bot  -->  Platform Sidecar  -->  Claude Code CLI / OpenClaw Gateway
                      |
                  Streaming card updates with code blocks and interactive buttons
```

**Features:**
- Real-time streaming responses rendered as Feishu message cards
- Multiple bot support with per-channel backend assignment
- Auto-connect on app startup when credentials are configured
- Session persistence in `~/.frogcode/openclaw/agents/*/sessions/`

**OpenClaw Sessions page:**
- Two-pane browser: session list (left) + message detail (right)
- Gateway status banner with Start/Stop/Restart controls
- Collapsible gateway log viewer
- Import historical sessions from disk

---

## Core Features

### Session Management
- Multi-tab sessions with drag-and-drop reordering
- Real-time Markdown streaming with code highlighting
- Continue / Resume / Cancel controls
- Message rollback and prompt history
- Cross-engine unified session list

### Cost Tracking
- Multi-model pricing (Opus, Sonnet, etc.)
- Cache read/write split billing
- Per-session and per-project analytics
- Usage dashboard with date trends and export

### Developer Tools
- **MCP Integration** - Add/manage MCP servers, import from Claude Desktop, marketplace
- **Claude Extensions** - Plugins, Subagents, Agent Skills viewer
- **Hooks Automation** - Pre-commit review, security scan, custom hook chains
- **Code Context Search** - Acemcp-based semantic search with auto-indexing

### Translation Middleware
- Transparent Chinese-English translation
- 8 content extraction strategies
- Progressive translation with priority queue
- Translation cache with MD5 deduplication

### Auto Context Management
- Real-time token usage monitoring
- Automatic compression triggers
- Compression history and statistics
- Configurable retention strategies

---

## Installation

### Pre-built Releases (Recommended)

Download from [Releases](https://github.com/nevermorewish/frogcode/releases):

| Platform | Formats | Auto-Update |
|----------|---------|-------------|
| **Windows** | NSIS Setup (.exe), Portable (.exe) | NSIS only |
| **macOS** | DMG (ARM + Intel) | Yes |
| **Linux** | AppImage, DEB, RPM | AppImage only |

<details>
<summary><b>macOS Gatekeeper Fix</b></summary>

If macOS blocks the app with "damaged" or "unverified developer" errors:

```bash
sudo xattr -r -d com.apple.quarantine "/Applications/Frog Code.app"
```

</details>

### Build from Source

```bash
# Clone
git clone https://github.com/nevermorewish/frogcode.git
cd frogcode

# Install dependencies
npm install

# Development mode (hot reload)
npm run tauri:dev

# Production build
npm run tauri:build

# Fast build (dev-release profile)
npm run tauri:build-fast
```

**Requirements:** Node.js 18+, Rust 1.70+, platform-specific toolchain (WebView2 for Windows, webkit2gtk for Linux)

---

## Architecture

```
┌─────────────────────┬─────────────────┬───────────────────────┐
│   React Frontend    │   Tauri Bridge  │   Rust Backend        │
│                     │                 │                       │
│ - React 18 + TS     │ - IPC calls     │ - Multi-engine mgmt   │
│ - Tailwind CSS 4    │ - Type safety   │ - Process spawning    │
│ - Radix UI          │ - Event stream  │ - SQLite storage      │
│ - Framer Motion     │                 │ - MCP management      │
│ - i18next           │                 │ - Translation service │
└─────────────────────┴─────────────────┴───────────────────────┘
         │                                        │
         └──────── IPC Event Stream ──────────────┘
                          │
    ┌─────────────┬───────┴───────┬──────────────┐
    │ Claude CLI  │ OpenAI Codex  │ Gemini CLI   │
    └─────────────┴───────────────┴──────────────┘

    Platform Sidecar (Node.js)
    ├── Agent Manager (Claude Code / OpenClaw adapters)
    ├── Feishu Card Renderer (streaming updates)
    └── OpenClaw Gateway (process + WebSocket)
```

### Tech Stack

| Layer | Technologies |
|-------|-------------|
| **Frontend** | React 18, TypeScript 5.9, Tailwind CSS 4, Radix UI, Framer Motion, i18next |
| **Backend** | Tauri 2.9, Rust 2021, Tokio, rusqlite, reqwest, serde |
| **Sidecar** | Node.js, TypeScript, Axum (web mode), WebSocket |
| **Build** | Vite 6, cargo, GitHub Actions CI/CD |

### Data Storage

| Data | Location |
|------|----------|
| Session data | `~/.claude/projects/` (JSONL) |
| App settings | `~/.frogcode/` (JSON configs) |
| Platform config | `~/.frogcode/platform-config.json` |
| Agent configs | `~/.frogcode/agents/{type}.json` |
| IM channels | `~/.frogcode/im-channels.json` |
| OpenClaw state | `~/.frogcode/openclaw/state/` |
| Translation cache | SQLite via Rust backend |

---

## Configuration

### Platform Config (`~/.frogcode/platform-config.json`)

```json
{
  "projectPath": "~/.openclaw/workspace",
  "enabled": true,
  "agentType": "openclaw",
  "openclawAutoStart": true
}
```

### MCP Server Config

```json
{
  "acemcp": {
    "transport": "stdio",
    "command": "acemcp",
    "args": [],
    "env": { "ACEMCP_PROJECT_ROOT": "/path/to/project" }
  }
}
```

### Gemini Config (`~/.frogcode/gemini/config.json`)

```json
{
  "authMethod": "google_oauth",
  "defaultModel": "gemini-2.5-pro",
  "approvalMode": "auto_edit"
}
```

---

## Changelog

### v1.0.2 (2026-04)

- Homepage three-step setup guide with completion indicators
- OpenClaw start button and running status on homepage
- OpenClaw auto-start toggle (persisted in platform config)
- IM Channels page usage instructions
- OpenClaw Sessions page usage guide
- Feishu credential auto-sync from Frogclaw server login
- Fixed updater signing strip issue (`debuginfo` instead of `true`)

### v1.0.1 (2026-04)

- Global brand rename: Any Code -> Frog Code
- Bundled OpenClaw skills and plugins installed on first launch
- Default workspace `~/.openclaw/workspace` for Feishu sessions
- Auto-update endpoint and pubkey updated
- CI: Node.js 24 compatibility, GitHub Actions v5

### Previous Versions

<details>
<summary><b>v5.x (pre-rename)</b></summary>

- v5.6.6: Google Gemini engine, three-engine architecture
- v4.4.0: OpenAI Codex integration, enhanced translation, auto context management
- v4.0.1: Claude extension manager, MCP marketplace, cost tracking

</details>

---

## Contributing

```bash
# Fork and clone
git clone https://github.com/YOUR_USERNAME/frogcode.git
cd frogcode

# Install and develop
npm install
npm run tauri:dev

# Commit convention
# feat: / fix: / docs: / refactor: / perf: / chore:
```

---

## Troubleshooting

<details>
<summary><b>App won't start</b></summary>

1. Check Claude Code CLI: `claude --version`
2. Windows: Ensure WebView2 Runtime is installed
3. Check logs: `%APPDATA%/frog-code/logs` (Win) / `~/Library/Application Support/frog-code/logs` (Mac)

</details>

<details>
<summary><b>Feishu bot not responding</b></summary>

1. Check IM Channels page — ensure channel has a backend assigned (not "Unassigned")
2. Verify platform sidecar is running (green status in homepage Step 1)
3. Check Feishu App ID and Secret are correct
4. View system logs page for detailed error info

</details>

<details>
<summary><b>OpenClaw gateway won't start</b></summary>

1. Check if OpenClaw is installed (homepage dev environment detection)
2. Verify port 18789 is not in use
3. Check OpenClaw Sessions page status banner for error details
4. View gateway log (collapsible panel below status banner)

</details>

---

## License

**AGPL-3.0** - See [LICENSE](LICENSE) file.

---

## Links

- [Claude Code Docs](https://docs.claude.com/en/docs/claude-code/overview)
- [Google Gemini CLI](https://github.com/google-gemini/gemini-cli)
- [Tauri Framework](https://tauri.app/)
- [MCP Protocol](https://modelcontextprotocol.io/)

---

<div align="center">

**Frog Code** - Multi-engine AI desktop app with Feishu IM integration

Made with care by the Frog Code Team

[GitHub](https://github.com/nevermorewish/frogcode) | [Releases](https://github.com/nevermorewish/frogcode/releases)

</div>
