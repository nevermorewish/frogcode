/**
 * OpenClawAgent — Agent adapter for the OpenClaw gateway.
 *
 * Architecture:
 *   - Starts a long-lived openclaw gateway process (shared by all chats)
 *   - Connects via WebSocket JSON-RPC v3 with Ed25519 device auth
 *   - Per-chat AgentSession sends messages via RPC and subscribes to events
 *   - WS events are normalized to AgentEvent for the card renderer
 *
 * Runtime layout (mirrors nexu):
 *   ~/.frogcode/openclaw/
 *     config/openclaw.json   ← gateway config (schema-validated writes)
 *     state/                 ← device identity, agents, extensions, skills
 *     tmp/                   ← TMPDIR passed to gateway
 *
 * The global ~/.openclaw/ directory (used by standalone openclaw CLI) is
 * intentionally NOT touched — frogcode maintains its own device identity so
 * two installs can coexist on one machine.
 *
 * Config is read from ~/.frogcode/agents/openclaw.json:
 *   { binPath, stateDir, gatewayPort, gatewayToken, controlUiOrigins }
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type {
  Agent,
  AgentEvent,
  AgentSession,
  SendOpts,
  SessionKey,
  StartSessionOpts,
} from '../types.js';
import { OpenClawProcessManager, type ProcessConfig, killProcessOnPort } from './process.js';
import { OpenClawWsClient, type WsClientConfig } from './ws-client.js';
import { OpenClawConfigWriter } from './config-writer.js';
import { initialConfig } from './migrate.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OpenClawAgentConfig {
  /** Path to openclaw binary. null = PATH / npx lookup. */
  binPath?: string | null;
  /**
   * OpenClaw state directory — device trust store, agents, canvas, cron.
   * Default: ~/.frogcode/openclaw/state
   */
  stateDir?: string;
  /**
   * Config file path.
   * Default: ~/.frogcode/openclaw/config/openclaw.json
   */
  configPath?: string;
  /**
   * TMPDIR passed to the gateway process.
   * Default: ~/.frogcode/openclaw/tmp
   */
  tmpDir?: string;
  /**
   * Plugin load directory (openclaw reads plugins.load.paths from config).
   * Default: {stateDir}/extensions
   */
  extensionsDir?: string;
  /**
   * Skill extra-dirs for hot-loading.
   * Default: {stateDir}/skills
   */
  skillsDir?: string;
  /** Gateway port. Default: 18789 */
  gatewayPort?: number;
  /** Optional explicit gateway auth token. */
  gatewayToken?: string | null;
}

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const DEFAULT_RUNTIME_ROOT = path.join(HOME, '.frogcode', 'openclaw');
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_RUNTIME_ROOT, 'config', 'openclaw.json');
const DEFAULT_STATE_DIR = path.join(DEFAULT_RUNTIME_ROOT, 'state');
const DEFAULT_TMP_DIR = path.join(DEFAULT_RUNTIME_ROOT, 'tmp');
const DEFAULT_EXTENSIONS_DIR = path.join(DEFAULT_STATE_DIR, 'extensions');
const DEFAULT_SKILLS_DIR = path.join(DEFAULT_STATE_DIR, 'skills');
// 18789 is the canonical openclaw gateway port. If a globally installed
// standalone openclaw is holding it (e.g. as a Windows scheduled task),
// stop that instance — we don't work around the collision by moving ports.
const DEFAULT_PORT = 18789;

function log(level: string, ...parts: any[]) {
  const msg = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  process.stderr.write(`[openclaw ${level}] ${msg}\n`);
}

/**
 * Provider defaults mirroring nexu's BYOK_DEFAULT_BASE_URLS.
 * Used when user specifies a providerId without explicit baseUrl.
 */
const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; api: string }> = {
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic-messages' },
  openai: { baseUrl: 'https://api.openai.com/v1', api: 'openai-completions' },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    api: 'openai-completions',
  },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions' },
  siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', api: 'openai-completions' },
  moonshot: { baseUrl: 'https://api.moonshot.cn/v1', api: 'openai-completions' },
  zai: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions' },
  ollama: { baseUrl: 'http://127.0.0.1:11434', api: 'ollama' },
};

function buildModelEntry(id: string, name?: string) {
  return {
    id,
    name: name ?? id,
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
    compat: { supportsStore: false },
  };
}

/**
 * Frogcode-side provider config (set via UI). Writes into openclaw's
 * config.models.providers.{providerId} on each gateway start.
 */
export interface OpenClawProviderConfig {
  providerId: string;      // 'anthropic' | 'openai' | 'openrouter' | ...
  baseUrl?: string;        // override default base URL
  apiKey: string;          // Bearer token
  models: string[];        // e.g. ['claude-sonnet-4-6', 'claude-opus-4-6']
}

/**
 * Splice provider entries into an existing config object, preserving all
 * other fields. Used by BYOK flows where the user adds/changes API keys
 * after the initial config was bootstrapped from template or legacy.
 */
function applyProviders(
  config: Record<string, any>,
  providers: OpenClawProviderConfig[],
): void {
  const providersMap: Record<string, any> = {};
  for (const p of providers) {
    if (!p.apiKey || !p.models.length) continue;
    const defaults = PROVIDER_DEFAULTS[p.providerId] ?? {
      baseUrl: p.baseUrl ?? '',
      api: 'openai-completions',
    };
    providersMap[p.providerId] = {
      baseUrl: p.baseUrl || defaults.baseUrl,
      apiKey: p.apiKey,
      api: defaults.api,
      models: p.models.map((id) => buildModelEntry(id)),
    };
  }

  if (Object.keys(providersMap).length > 0) {
    config.models = { mode: 'merge', providers: providersMap };
  } else {
    delete config.models;
  }
}

/**
 * Update an existing config file with new provider entries. Preserves all
 * other fields. Used by external call sites that want to inject BYOK keys
 * without owning an OpenClawAgent instance. Prefer calling
 * OpenClawAgent.updateProviders() instead when an agent instance is
 * available — it reuses a writer with a warm content cache.
 */
export function updateConfigProviders(
  configPath: string,
  providers: OpenClawProviderConfig[],
): void {
  const writer = new OpenClawConfigWriter(configPath);
  let config: Record<string, any>;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // File doesn't exist or is corrupt — bootstrap from legacy/template
    // then splice providers on top.
    config = initialConfig(DEFAULT_STATE_DIR, DEFAULT_EXTENSIONS_DIR, DEFAULT_PORT);
  }
  applyProviders(config, providers);
  writer.write(config);
}

// ---------------------------------------------------------------------------
// Resolve the openclaw binary — error if not found
// ---------------------------------------------------------------------------

/** Check if a TCP port is already listening (used before spawning gateway). */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port, timeout: 1000 });
    sock.on('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => {
      sock.destroy();
      resolve(false);
    });
  });
}

function resolveOpenClawBin(binPath?: string | null): string {
  if (binPath) return binPath;

  // Check PATH
  const { execSync } = require('node:child_process');
  const cmd = process.platform === 'win32' ? 'where openclaw' : 'which openclaw';
  try {
    const result = execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim();
    if (result) return result.split('\n')[0].trim();
  } catch {
    // not in PATH
  }

  throw new Error(
    'openclaw binary not found. Install it first: npm install -g openclaw\n' +
      'Or set binPath in ~/.frogcode/agents/openclaw.json',
  );
}

// ---------------------------------------------------------------------------
// Session — one per (platform:channel:user)
// ---------------------------------------------------------------------------

class OpenClawSession implements AgentSession {
  readonly sessionKey: SessionKey;
  private readonly emitter = new EventEmitter();
  private readonly ws: OpenClawWsClient;
  private sessionId: string | null;
  private closed = false;

  constructor(opts: StartSessionOpts, ws: OpenClawWsClient) {
    this.sessionKey = opts.sessionKey;
    this.sessionId = opts.resumeSessionId ?? null;
    this.ws = ws;
    this.emitter.setMaxListeners(20);
  }

  events(): EventEmitter {
    return this.emitter;
  }

  currentSessionId(): string | null {
    return this.sessionId;
  }

  async send(opts: SendOpts): Promise<void> {
    if (this.closed) throw new Error('session closed');
    if (!this.ws.isConnected()) throw new Error('openclaw gateway not connected');

    const emit = (evt: AgentEvent) => this.emitter.emit('event', evt);

    // Build the RPC params (OpenClaw chat.send schema)
    const params: Record<string, unknown> = {
      message: opts.prompt,
      sessionKey: this.sessionKey,
      idempotencyKey: randomUUID(),
    };
    if (opts.files?.length) {
      params.attachments = opts.files;
    }

    emit({ type: 'system' });

    const startedAt = Date.now();
    try {
      // chat.send returns immediately with { runId, status } — the actual
      // AI response arrives asynchronously via WS gateway events.
      const result = await this.ws.request<any>('chat.send', params, {
        timeoutMs: 30_000,
      });

      log('info', `chat.send response: ${JSON.stringify(result)?.slice(0, 500)}`);

      const runId = typeof result?.runId === 'string' ? result.runId : null;
      if (runId) {
        this.sessionId = runId;
        emit({ type: 'session', sessionId: runId });
      }

      // If the response already contains the full text (synchronous mode),
      // emit it directly and we're done.
      if (typeof result?.text === 'string' && result.text) {
        emit({ type: 'text', delta: result.text });
        if (Array.isArray(result.toolCalls)) {
          for (const tc of result.toolCalls) {
            emit({ type: 'tool_use', name: tc.name || 'tool', detail: tc.detail || '' });
            emit({ type: 'tool_result', ok: !tc.error });
          }
        }
        emit({
          type: 'result',
          durationMs: Date.now() - startedAt,
          costUsd: typeof result.costUsd === 'number' ? result.costUsd : undefined,
          totalTokens: typeof result.totalTokens === 'number' ? result.totalTokens : undefined,
        });
        return;
      }

      // Async mode — subscribe to WS gateway events and wait for the run
      // to complete. OpenClaw event format (from logs):
      //
      //   event "agent"  stream="assistant"  data.delta → text chunk
      //   event "agent"  stream="lifecycle"  data.phase="start" → run started
      //   event "agent"  stream="lifecycle"  data.phase="end"   → run finished
      //   event "agent"  stream="tool_use"   → tool call
      //   event "agent"  stream="tool_result" → tool result
      //   event "chat"   state="delta"  message.content → incremental message
      //   event "chat"   state="final"  message.content → final complete message
      //
      // Each event carries a runId — we filter to only process events for our run.
      await new Promise<void>((resolve) => {
        const TIMEOUT_MS = 300_000; // 5 min
        let resolved = false;

        const finish = (error?: string) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          this.ws.off('gateway-event', onEvent);
          emit({
            type: 'result',
            durationMs: Date.now() - startedAt,
            error,
          });
          resolve();
        };

        const timer = setTimeout(() => {
          finish('openclaw response timed out (5min)');
        }, TIMEOUT_MS);

        let textAccum = '';  // accumulate text for logging

        const onEvent = (eventName: string, payload: any) => {
          // Filter: only process events for our run
          if (runId && payload?.runId && payload.runId !== runId) return;

          // ── "agent" events ──────────────────────────────────────────
          if (eventName === 'agent') {
            const stream = payload?.stream;
            const data = payload?.data;

            if (stream === 'assistant' && typeof data?.delta === 'string') {
              textAccum += data.delta;
              emit({ type: 'text', delta: data.delta });
              return;
            }

            if (stream === 'lifecycle') {
              log('info', `event agent/lifecycle phase=${data?.phase} runId=${payload?.runId?.slice(0, 8)}`);
              if (data?.phase === 'end') {
                log('info', `model response (${textAccum.length} chars): ${textAccum.slice(0, 200)}${textAccum.length > 200 ? '...' : ''}`);
                finish();
                return;
              }
              // phase === 'start' — no action needed
              return;
            }

            if (stream === 'tool_use' || stream === 'tool_call') {
              log('info', `event agent/${stream} name=${data?.name || data?.tool || '?'}`);
              emit({
                type: 'tool_use',
                name: data?.name || data?.tool || 'tool',
                detail: typeof data?.detail === 'string' ? data.detail : '',
              });
              return;
            }

            if (stream === 'tool_result') {
              log('info', `event agent/tool_result ok=${!data?.error}`);
              emit({ type: 'tool_result', ok: !data?.error });
              return;
            }

            if (stream === 'error') {
              log('error', `event agent/error: ${data?.message || data?.error}`);
              finish(data?.message || data?.error || 'openclaw agent error');
              return;
            }

            // Unknown stream — log for debugging
            log('info', `event agent/${stream} (unhandled) data=${JSON.stringify(data)?.slice(0, 200)}`);
            return;
          }

          // ── "chat" events (alternative completion path) ─────────────
          if (eventName === 'chat') {
            log('info', `event chat state=${payload?.state} contentLen=${JSON.stringify(payload?.message?.content)?.length ?? 0}`);
            if (payload?.state === 'final') {
              // Extract final text from message content
              const content = payload?.message?.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block?.type === 'text' && typeof block.text === 'string') {
                    // Only emit if we haven't streamed deltas (avoid double text)
                    // The card renderer handles dedup, so safe to emit
                  }
                }
              }
              if (textAccum.length === 0) {
                log('warn', 'chat.final arrived but no text was streamed via agent/assistant deltas');
              }
              log('info', `model response (${textAccum.length} chars): ${textAccum.slice(0, 200)}${textAccum.length > 200 ? '...' : ''}`);
              finish();
              return;
            }
            // state === 'delta' — already covered by agent/assistant events
            return;
          }

          // ── "error" event ───────────────────────────────────────────
          if (eventName === 'error') {
            log('error', `event error: ${payload?.message || payload?.error}`);
            finish(payload?.message || payload?.error || 'openclaw error');
            return;
          }

          // Unknown event — log for debugging
          log('info', `event ${eventName} (unhandled) payload=${JSON.stringify(payload)?.slice(0, 200)}`);
        };

        this.ws.on('gateway-event', onEvent);
      });
    } catch (err: any) {
      log('error', `send failed: ${err.message}`);
      emit({
        type: 'result',
        durationMs: Date.now() - startedAt,
        error: err.message || String(err),
      });
    }
  }

  async cancel(): Promise<void> {
    if (!this.ws.isConnected()) return;
    try {
      await this.ws.request('chat.cancel', { sessionKey: this.sessionKey }, { timeoutMs: 5000 });
    } catch {
      // best effort
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.emitter.emit('close');
    this.emitter.removeAllListeners();
  }
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export interface OpenClawStatus {
  processAlive: boolean;
  wsConnected: boolean;
  gatewayPort: number;
  started: boolean;
  binPath: string | null;
  stateDir: string;
  error: string | null;
  logPath: string | null;
  logTail: string[];
}

export class OpenClawAgent implements Agent {
  readonly name = 'openclaw' as const;
  private readonly config: OpenClawAgentConfig;
  private processManager: OpenClawProcessManager | null = null;
  private wsClient: OpenClawWsClient | null = null;
  private started = false;
  private lastError: string | null = null;
  /** Lazy writer — constructed in ensureGateway, reused across provider updates. */
  private configWriter: OpenClawConfigWriter | null = null;

  constructor(config: OpenClawAgentConfig = {}) {
    this.config = config;
  }

  status(): OpenClawStatus {
    const stateDir = this.config.stateDir || DEFAULT_STATE_DIR;
    // Prefer a fatal error from the process manager (port conflict etc) over
    // the agent-level lastError since it's more specific and actionable.
    const fatal = this.processManager?.getFatalError() ?? null;
    const error = fatal ?? this.lastError;
    return {
      processAlive: this.processManager?.isAlive() ?? false,
      wsConnected: this.wsClient?.isConnected() ?? false,
      gatewayPort: this.config.gatewayPort || DEFAULT_PORT,
      started: this.started,
      binPath: this.config.binPath || null,
      stateDir,
      error,
      logPath: this.processManager?.getLogPath() ?? path.join(stateDir, 'openclaw.log'),
      logTail: this.processManager?.getLogTail() ?? [],
    };
  }

  /**
   * Update the provider list in the live config. Preserves every other
   * field (agents, channels, bindings, plugins…) and routes through the
   * writer with content-hash dedup. Openclaw's file watcher picks up the
   * change via hybrid reload — no restart needed.
   */
  updateProviders(providers: OpenClawProviderConfig[]): void {
    const configPath = this.config.configPath || DEFAULT_CONFIG_PATH;
    const writer = this.configWriter ?? new OpenClawConfigWriter(configPath);
    this.configWriter = writer;

    let config: Record<string, any>;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      config = this.bootstrapConfig();
    }
    applyProviders(config, providers);
    try {
      writer.write(config);
    } catch (err: any) {
      this.lastError = `config write failed: ${err.message || String(err)}`;
      throw err;
    }
  }

  /**
   * Produce the initial config object for first-time writes. Prefers the
   * user's legacy ~/.openclaw/openclaw.json, falls back to the bundled
   * template. Path fields are rewritten to point at frogcode's stateDir.
   */
  private bootstrapConfig(): Record<string, any> {
    const stateDir = this.config.stateDir || DEFAULT_STATE_DIR;
    const extensionsDir =
      this.config.extensionsDir || path.join(stateDir, 'extensions');
    const port = this.config.gatewayPort || DEFAULT_PORT;
    return initialConfig(stateDir, extensionsDir, port);
  }

  async restart(): Promise<void> {
    log('info', 'restarting openclaw...');
    await this.stop();
    // Wait for port release before re-spawning
    await new Promise((r) => setTimeout(r, 2000));
    this.lastError = null;
    try {
      await this.ensureGateway();
    } catch (err: any) {
      this.lastError = err.message || String(err);
    }
  }

  async startGateway(): Promise<void> {
    if (this.started) return;
    try {
      await this.ensureGateway();
      this.lastError = null;
    } catch (err: any) {
      this.lastError = err.message || String(err);
    }
  }

  async stopGateway(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.stop();
      this.wsClient = null;
    }
    if (this.processManager) {
      await this.processManager.stop();
      this.processManager = null;
    }
    this.started = false;
    log('info', 'gateway stopped');
  }

  async startSession(opts: StartSessionOpts): Promise<AgentSession> {
    // Lazily start gateway + WS on first session request
    if (!this.started) {
      try {
        await this.ensureGateway();
        this.lastError = null;
      } catch (err: any) {
        this.lastError = err.message || String(err);
        throw err;
      }
    }

    if (!this.wsClient?.isConnected()) {
      const msg = 'OpenClaw gateway not connected. Check `openclaw` is installed and running.';
      this.lastError = msg;
      throw new Error(msg);
    }

    return new OpenClawSession(opts, this.wsClient);
  }

  /** Proactively initialize the gateway (called by manager on startup). */
  async warmUp(): Promise<void> {
    if (this.started) return;
    try {
      await this.ensureGateway();
      this.lastError = null;
    } catch (err: any) {
      this.lastError = err.message || String(err);
      // Don't throw — warm-up is best-effort; surfaces via status()
    }
  }

  async stop(): Promise<void> {
    await this.stopGateway();
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private async ensureGateway(): Promise<void> {
    // Resolve binary (throws if not found — user gets clear error)
    const binPath = resolveOpenClawBin(this.config.binPath);
    const stateDir = this.config.stateDir || DEFAULT_STATE_DIR;
    const configPath = this.config.configPath || DEFAULT_CONFIG_PATH;
    const tmpDir = this.config.tmpDir || DEFAULT_TMP_DIR;
    const extensionsDir =
      this.config.extensionsDir || path.join(stateDir, 'extensions');
    const skillsDir = this.config.skillsDir || path.join(stateDir, 'skills');
    const port = this.config.gatewayPort || DEFAULT_PORT;

    // Ensure runtime dirs exist (config dir is handled by the writer)
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(extensionsDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    // Always write through the config writer. It seeds its cache from the
    // existing file on first call, so no-op writes are silently skipped and
    // openclaw's file watcher is not triggered unnecessarily.
    this.configWriter = this.configWriter ?? new OpenClawConfigWriter(configPath);
    try {
      let config: Record<string, any>;
      if (!fs.existsSync(configPath)) {
        // First cold start — bootstrap from legacy ~/.openclaw/openclaw.json
        // or from the bundled openclaw-template.json.
        config = this.bootstrapConfig();
        log('info', `bootstrapping config at ${configPath}`);
      } else {
        // Existing config — load it, but force gateway.port/bind back to
        // frogcode's source of truth every time. This fixes users stuck on
        // an older bootstrap that wrote port 18789 before we switched to
        // 18790, and guarantees the port we spawn on always matches the
        // port the config tells openclaw to bind.
        try {
          config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (e: any) {
          log('warn', `config JSON corrupt (${e.message}), re-bootstrapping`);
          config = this.bootstrapConfig();
        }
      }
      // Force port + auth scopes to our authoritative values. The writer's
      // content dedup will skip the write if everything matches.
      config.gateway = config.gateway || {};
      if (config.gateway.port !== port) {
        log('info', `rewriting gateway.port ${config.gateway.port} → ${port}`);
        config.gateway.port = port;
      }
      // Ensure auth.scopes includes operator.write — newer openclaw versions
      // require explicit scope grants instead of treating operator.admin as
      // a superscope.
      const requiredScopes = ['operator.admin', 'operator.read', 'operator.write'];
      config.gateway.auth = config.gateway.auth || {};
      const currentScopes: string[] = Array.isArray(config.gateway.auth.scopes)
        ? config.gateway.auth.scopes
        : [];
      const missingScopes = requiredScopes.filter(s => !currentScopes.includes(s));
      if (missingScopes.length > 0) {
        config.gateway.auth.scopes = [...new Set([...currentScopes, ...requiredScopes])];
        log('info', `rewriting gateway.auth.scopes → ${JSON.stringify(config.gateway.auth.scopes)}`);
      }
      this.configWriter.write(config);
    } catch (err: any) {
      throw new Error(
        `failed to write openclaw config at ${configPath}: ${err.message || String(err)}`,
      );
    }

    log('info', `stateDir=${stateDir}`);
    log('info', `configPath=${configPath}`);
    log('info', `extensionsDir=${extensionsDir}`);
    log('info', `tmpDir=${tmpDir}`);

    // Port preflight — if in use, actively kill the holder so we can bind.
    if (await isPortInUse(port)) {
      log('info', `port ${port} in use; killing occupying process...`);
      killProcessOnPort(port, (msg) => log('info', msg));
      // Re-check after kill
      if (await isPortInUse(port)) {
        log('warn', `port ${port} still in use after kill attempt; spawn may fail`);
      } else {
        log('info', `port ${port} released successfully`);
      }
    }

    // Start process — log file goes next to the config
    const logPath = path.join(path.dirname(configPath), 'openclaw.log');
    const procConfig: ProcessConfig = {
      binPath,
      stateDir,
      configPath,
      gatewayPort: port,
      tmpDir,
      extensionsDir,
      logPath,
    };
    this.processManager = new OpenClawProcessManager(procConfig);
    // ONE-SHOT start — no auto-restart. If the gateway dies, the user
    // clicks Start again from the OpenClaw Sessions view.
    this.processManager.start();

    // Start WS client — resolve gateway token from agent config or openclaw.json
    let resolvedGatewayToken = this.config.gatewayToken || undefined;
    if (!resolvedGatewayToken) {
      try {
        const ocCfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const cfgToken = ocCfg?.gateway?.auth?.token;
        if (typeof cfgToken === 'string' && cfgToken) {
          resolvedGatewayToken = cfgToken;
        }
      } catch { /* ignore */ }
    }
    const wsConfig: WsClientConfig = {
      baseUrl: `http://127.0.0.1:${port}`,
      gatewayToken: resolvedGatewayToken,
      stateDir,
    };
    this.wsClient = new OpenClawWsClient(wsConfig);

    // Wait for gateway to be ready (TCP probe) before connecting WS
    await this.waitForGateway(port, 30_000);

    this.wsClient.connect();

    // Wait for WS handshake
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('OpenClaw WS handshake timed out (15s)'));
      }, 15_000);
      this.wsClient!.once('connected', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.started = true;
    log('info', `gateway ready on port ${port}, WS connected`);
  }

  private async waitForGateway(port: number, maxMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (this.processManager && await this.processManager.probeHealth()) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`OpenClaw gateway not reachable on port ${port} after ${maxMs}ms`);
  }
}
