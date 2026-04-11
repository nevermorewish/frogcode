/**
 * apiAdapter — drop-in replacement for @tauri-apps/api `invoke` and `listen`
 * that also works in a browser when the app is served by `frogcode-web`.
 *
 * In Tauri (desktop): everything passes through to the real Tauri APIs, so
 * existing code is 100% unchanged.
 *
 * In a plain browser: `invoke` is routed to REST (`/api/*`) or a shared
 * WebSocket (`/ws/exec`) per command name, and `compatListen` hooks into
 * the same DOM CustomEvents that the WebSocket envelope handler dispatches.
 *
 * This module is intentionally boring: it reuses whatever the Rust side
 * already sends over the wire, and only adapts the transport.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
    __TAURI_METADATA__?: unknown;
  }
}

let cachedIsTauri: boolean | null = null;

export function isTauri(): boolean {
  if (cachedIsTauri !== null) return cachedIsTauri;
  if (typeof window === "undefined") {
    cachedIsTauri = false;
    return false;
  }
  cachedIsTauri = !!(
    window.__TAURI__ ||
    window.__TAURI_INTERNALS__ ||
    window.__TAURI_METADATA__ ||
    navigator.userAgent.includes("Tauri")
  );
  return cachedIsTauri;
}

// ---------------------------------------------------------------------------
// REST + WS base URL
// ---------------------------------------------------------------------------

function httpBase(): string {
  return `${window.location.protocol}//${window.location.host}`;
}

function wsBase(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}`;
}

// ---------------------------------------------------------------------------
// REST dispatch
// ---------------------------------------------------------------------------

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

async function restGet<T>(path: string): Promise<T> {
  const res = await fetch(`${httpBase()}${path}`, { method: "GET" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as ApiResponse<T>;
  if (!body.success) throw new Error(body.error || "API call failed");
  return body.data as T;
}

async function restPost<T>(path: string, bodyJson: unknown): Promise<T> {
  const res = await fetch(`${httpBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyJson ?? {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as ApiResponse<T>;
  if (!body.success) throw new Error(body.error || "API call failed");
  return body.data as T;
}

// ---------------------------------------------------------------------------
// Command → REST endpoint routing
// ---------------------------------------------------------------------------

/**
 * Maps Tauri command names to the REST handlers exposed by `web_server.rs`.
 * Commands missing from this table are either streaming (handled by the
 * WebSocket branch below) or unsupported in web mode.
 */
type RestRoute = (args: Record<string, unknown> | undefined) => Promise<unknown>;

const REST_ROUTES: Record<string, RestRoute> = {
  list_projects: () => restGet("/api/projects"),

  get_project_sessions: (args) => {
    const projectId = encodeURIComponent(String(args?.projectId));
    return restGet(`/api/projects/${projectId}/sessions`);
  },

  load_session_history: (args) => {
    const sessionId = encodeURIComponent(String(args?.sessionId));
    const projectId = encodeURIComponent(String(args?.projectId));
    return restGet(`/api/sessions/${sessionId}/history/${projectId}`);
  },

  list_running_claude_sessions: () => restGet("/api/sessions/running"),

  get_claude_session_output: (args) => {
    const sessionId = encodeURIComponent(String(args?.sessionId));
    return restGet(`/api/sessions/${sessionId}/output`);
  },

  cancel_claude_execution: (args) =>
    restPost("/api/sessions/cancel", { session_id: args?.sessionId ?? null }),

  // Platform / Feishu config
  platform_get_config: () => restGet("/api/platform/config"),
  platform_save_config: (args) =>
    restPost("/api/platform/config", { config: args?.config }),
  platform_get_agent_config: (args) => {
    const agentType = encodeURIComponent(String(args?.agentType));
    return restGet(`/api/platform/agent-config/${agentType}`);
  },
  platform_save_agent_config: (args) => {
    const agentType = encodeURIComponent(String(args?.agentType));
    return restPost(`/api/platform/agent-config/${agentType}`, {
      config: args?.config,
    });
  },

  // Frogclaw authentication
  login_to_frogclaw: (args) =>
    restPost("/api/auth/login", {
      username: args?.username ?? "",
      password: args?.password ?? "",
    }),
  fetch_frogclaw_providers: (args) =>
    restPost("/api/auth/providers", {
      username: args?.username ?? "",
      password: args?.password ?? "",
    }),

  // Platform sidecar lifecycle + passthrough
  platform_start: () => restPost("/api/platform/start", {}),
  platform_stop: () => restPost("/api/platform/stop", {}),
  platform_status: () => restGet("/api/platform/status"),
  platform_connect_feishu: () => restPost("/api/platform/connect-feishu", {}),
  platform_get_openclaw_status: () => restGet("/api/platform/openclaw/status"),
  platform_openclaw_start: () => restPost("/api/platform/openclaw/start", {}),
  platform_openclaw_stop: () => restPost("/api/platform/openclaw/stop", {}),
  platform_openclaw_restart: () =>
    restPost("/api/platform/openclaw/restart", {}),
  platform_list_openclaw_sessions: () =>
    restGet("/api/platform/openclaw/sessions"),
  platform_get_openclaw_session: (args) =>
    restPost("/api/platform/openclaw/session", { id: String(args?.id ?? "") }),
};

// ---------------------------------------------------------------------------
// WebSocket exec channel (singleton per browser session)
// ---------------------------------------------------------------------------

/**
 * One shared WebSocket for all streaming commands in a browser tab. The Rust
 * side delivers every event as a JSON envelope `{event, payload}` — we
 * immediately re-dispatch that as a DOM CustomEvent so `compatListen` can
 * hand it back to callers via the same interface Tauri's `listen` uses.
 */
class ExecWs {
  private ws: WebSocket | null = null;
  private pending: string[] = [];
  private readyPromise: Promise<void> | null = null;

  private ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBase()}/ws/exec`);
      this.ws = ws;

      ws.onopen = () => {
        for (const msg of this.pending) ws.send(msg);
        this.pending = [];
        resolve();
      };

      ws.onmessage = (evt) => {
        try {
          const envelope = JSON.parse(evt.data) as {
            event: string;
            payload: unknown;
          };
          window.dispatchEvent(
            new CustomEvent(envelope.event, { detail: envelope.payload }),
          );
        } catch (e) {
          console.warn("[apiAdapter] bad WS envelope:", e, evt.data);
        }
      };

      ws.onerror = (e) => {
        console.error("[apiAdapter] WS error", e);
        reject(new Error("WebSocket connection failed"));
        this.readyPromise = null;
        this.ws = null;
      };

      ws.onclose = () => {
        this.ws = null;
        this.readyPromise = null;
      };
    });
    return this.readyPromise;
  }

  async send(request: Record<string, unknown>): Promise<void> {
    const text = JSON.stringify(request);
    await this.ensureConnected();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(text);
    } else {
      this.pending.push(text);
    }
  }
}

const execWs = new ExecWs();

// ---------------------------------------------------------------------------
// Streaming command dispatch
// ---------------------------------------------------------------------------

type StreamingCommand = "execute_claude_code" | "continue_claude_code" | "resume_claude_code";

function isStreamingCommand(cmd: string): cmd is StreamingCommand {
  return (
    cmd === "execute_claude_code" ||
    cmd === "continue_claude_code" ||
    cmd === "resume_claude_code"
  );
}

async function dispatchStreaming(
  cmd: StreamingCommand,
  args: Record<string, unknown> | undefined,
): Promise<void> {
  const command_type =
    cmd === "execute_claude_code"
      ? "execute"
      : cmd === "continue_claude_code"
        ? "continue"
        : "resume";

  await execWs.send({
    command_type,
    project_path: args?.projectPath ?? "",
    prompt: args?.prompt ?? "",
    model: args?.model ?? "sonnet",
    session_id: args?.sessionId ?? null,
    plan_mode: args?.planMode ?? null,
    max_thinking_tokens: args?.maxThinkingTokens ?? null,
    tab_id: args?.tabId ?? null,
  });
  // Tauri's execute_claude_code resolves with `()` once the command is
  // accepted — the actual output arrives asynchronously via events. We
  // mirror that semantics by resolving immediately after the WS send.
}

// ---------------------------------------------------------------------------
// Public: invoke wrapper
// ---------------------------------------------------------------------------

/**
 * Drop-in replacement for `@tauri-apps/api/core`'s `invoke`. In Tauri it's
 * a transparent passthrough; in a browser it routes to REST or WebSocket.
 */
export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (isTauri()) {
    return tauriInvoke<T>(cmd, args);
  }

  if (isStreamingCommand(cmd)) {
    await dispatchStreaming(cmd, args);
    return undefined as T;
  }

  const route = REST_ROUTES[cmd];
  if (route) {
    return (await route(args)) as T;
  }

  // Unsupported in web mode. We don't silently no-op — callers deserve a
  // clear error so the UI can show something useful.
  throw new Error(
    `[apiAdapter] command "${cmd}" is not available in web mode (v1 supports Claude + OpenClaw only)`,
  );
}

// ---------------------------------------------------------------------------
// Public: compatListen wrapper
// ---------------------------------------------------------------------------

/**
 * Drop-in replacement for `@tauri-apps/api/event`'s `listen`. In Tauri it's
 * a transparent passthrough. In a browser, the ExecWs handler dispatches
 * events as window CustomEvents so we just register a DOM listener that
 * surfaces them back through the same callback shape Tauri uses.
 */
export async function compatListen<T>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
  if (isTauri()) {
    return tauriListen<T>(event, handler);
  }

  const wrapped = (e: Event) => {
    // DOM CustomEvent always fires through here in web mode.
    const custom = e as CustomEvent<T>;
    handler({ payload: custom.detail });
  };
  window.addEventListener(event, wrapped as EventListener);
  return () => {
    window.removeEventListener(event, wrapped as EventListener);
  };
}
