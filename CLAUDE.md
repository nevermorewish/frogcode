# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Frog Code** (v1.0.1) — A professional desktop GUI for AI-driven code development, wrapping Claude Code CLI, OpenAI Codex API, and Google Gemini CLI into a unified Tauri application. Licensed AGPL-3.0, targets Windows/macOS/Linux.

## Build & Development Commands

```bash
# Frontend dev server (Vite, port 1420)
npm run dev

# Full Tauri dev mode with hot reload
npm run tauri:dev

# TypeScript check + Vite build (frontend only)
npm run build

# Production build (uses build.ps1 on Windows)
npm run tauri:build

# Fast dev-profile build for testing
npm run tauri:build-fast

# CI production build (no PowerShell wrapper)
npm run tauri:build-ci

# Rust backend only (from src-tauri/)
cargo build
cargo build --release
cargo build --profile dev-release
```

No test runner or linter is configured in package.json. TypeScript strict mode with `noUnusedLocals` and `noUnusedParameters` is enforced via `tsc` during `npm run build`.

## Architecture

### Three-Layer Tauri Stack

```
React/TS Frontend (src/)  ──IPC──►  Tauri Bridge  ──async──►  Rust Backend (src-tauri/src/)
```

- **Frontend** (`src/`): React 18 + TypeScript + Tailwind CSS 4 + Radix UI. State via 8 React Context providers (`src/contexts/`) and 20+ custom hooks (`src/hooks/`).
- **Backend** (`src-tauri/src/`): Rust + Tokio async. Process spawning for CLI engines, SQLite storage (rusqlite), HTTP clients (reqwest), MCP protocol support.
- **IPC**: All frontend→backend calls go through `src/lib/api.ts` (126KB, the unified Tauri command interface).

### Three-Engine Architecture

Each AI engine has its own integration path:

| Engine | Frontend converter | Backend commands | Process model |
|--------|-------------------|-----------------|---------------|
| Claude Code | Direct | `src-tauri/src/commands/claude/` + `claude_binary.rs` (86KB) | CLI subprocess, JSONL stream |
| OpenAI Codex | `src/lib/codexConverter.ts` | `src-tauri/src/commands/codex/` | HTTP API, JSON stream |
| Google Gemini | `src/lib/geminiConverter.ts` | `src-tauri/src/commands/gemini/` | CLI subprocess or API |

### Key Frontend Files

- **Entry**: `src/main.tsx` → `App.tsx` → `AppLayout` → `ViewRouter`
- **Core hook**: `src/hooks/usePromptExecution.ts` (76KB) — orchestrates input validation, translation, Tauri command invocation, stream handling, cost calculation
- **API layer**: `src/lib/api.ts` — all Tauri `invoke()` calls centralized here
- **Streaming**: `src/components/message/StreamMessageV2.tsx` — real-time message rendering
- **Sessions**: `src/contexts/SessionContext.tsx` + `src/hooks/useTabs.tsx` — multi-tab session management
- **Pricing**: `src/lib/pricing.ts` — model pricing data for cost tracking

### Key Backend Files

- **Entry**: `src-tauri/src/main.rs` (22KB) — Tauri setup, command registration
- **Claude binary**: `src-tauri/src/claude_binary.rs` (86KB) — CLI detection, spawning, lifecycle
- **MCP**: `src-tauri/src/commands/mcp.rs` (37KB) + `commands/acemcp.rs` (59KB)
- **Storage**: `src-tauri/src/commands/storage.rs` — SQLite operations
- **WSL**: `src-tauri/src/commands/wsl_utils.rs` (75KB) — Windows Subsystem for Linux support

### Cross-Cutting Concerns

- **Translation middleware** (`src/lib/translationMiddleware.ts`, `progressiveTranslation.ts`): Transparent Chinese↔English translation with 8 content extraction strategies, caching in SQLite
- **Cost tracking** (`src/hooks/useSessionCostCalculation.ts`, `src/lib/pricing.ts`): Per-message token counting, multi-model pricing with cache hit awareness
- **Context compression** (`src-tauri/src/commands/context_manager.rs`): Auto-detect token limits, compress conversation history

## Path Alias

TypeScript uses `@/*` → `./src/*` (configured in `tsconfig.json`).

## Internationalization

i18next with two locales: `src/i18n/locales/en.json` and `zh.json`. The app has significant Chinese-first user focus with built-in translation middleware.

## Vite Code Splitting

Manual chunks configured in `vite.config.ts`: `react-vendor`, `ui-vendor`, `editor-vendor`, `tauri`, `syntax-vendor`. Chunk size warning limit is 2000KB.

## Data Storage

- Session data: `~/.claude/projects/` (JSONL format)
- App settings: `~/.frogcode/` (JSON configs)
- Translation/usage caches: SQLite via Rust backend
