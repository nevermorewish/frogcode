/**
 * OpenClawAgent — Agent adapter for the OpenClaw gateway.
 *
 * Architecture:
 *   - Starts a long-lived openclaw gateway process (shared by all chats)
 *   - Connects via WebSocket JSON-RPC v3 with Ed25519 device auth
 *   - Per-chat AgentSession sends messages via RPC and subscribes to events
 *   - WS events are normalized to AgentEvent for the card renderer
 *
 * Config is read from ~/.anycode/agents/openclaw.json:
 *   { binPath, stateDir, gatewayPort, gatewayToken }
 */

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
import { OpenClawProcessManager, type ProcessConfig } from './process.js';
import { OpenClawWsClient, type WsClientConfig } from './ws-client.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OpenClawAgentConfig {
  /** Path to openclaw binary. null = PATH / npx lookup. */
  binPath?: string | null;
  /**
   * OpenClaw state directory — must match where the gateway stores its
   * device trust store / plugins / canvas. Default: ~/.openclaw
   * This is the SAME directory openclaw gateway uses globally, so our
   * device.json writes land where the gateway expects them.
   */
  stateDir?: string;
  /**
   * Frogcode-owned config path. Independent from openclaw's global state.
   * Default: ~/.anycode/openclaw/config.json
   */
  configPath?: string;
  /** Gateway port. Default: 18789 */
  gatewayPort?: number;
  /** Optional explicit gateway auth token. */
  gatewayToken?: string | null;
}

// OpenClaw's global state dir — shared with the openclaw CLI itself.
// Using this lets us write our device identity into the same trust store
// that the gateway will recognize on handshake.
const DEFAULT_STATE_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.openclaw',
);
// Frogcode-owned config path, kept separate from openclaw's global state.
const DEFAULT_CONFIG_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.anycode',
  'openclaw',
  'config.json',
);
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
 * Write a minimal valid openclaw config. Schema matches nexu's
 * openclaw-config-compiler.ts → openclawConfigSchema.parse().
 *
 * If `providers` are supplied, inject them under config.models.providers
 * so the gateway's internal claude/openai calls can find API URL + key.
 */
function writeDefaultConfig(
  configPath: string,
  port: number,
  providers: OpenClawProviderConfig[] = [],
): void {
  // Compile providers → openclaw models.providers map
  const providersMap: Record<string, any> = {};
  let defaultModel = 'anthropic/claude-sonnet-4-6';

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
    // First provider's first model becomes default
    if (providers[0] === p && p.models[0]) {
      defaultModel = `${p.providerId}/${p.models[0]}`;
    }
  }

  const hasModels = Object.keys(providersMap).length > 0;

  const config: Record<string, any> = {
    gateway: {
      port,
      mode: 'local',
      bind: 'loopback',
      auth: { mode: 'none' },
    },
    agents: {
      defaults: {
        model: { primary: defaultModel },
        timeoutSeconds: 300,
      },
      list: [],
    },
    tools: {
      exec: { security: 'full', ask: 'off', host: 'gateway' },
    },
    session: {
      dmScope: 'per-peer',
      reset: { mode: 'idle', idleMinutes: 525600 },
    },
    channels: {},
    bindings: [],
  };

  if (hasModels) {
    config.models = {
      mode: 'merge',
      providers: providersMap,
    };
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/**
 * Update an existing config with provider entries. Preserves all other
 * fields (e.g. agents list, channels, bindings). Called on provider changes.
 */
export function updateConfigProviders(
  configPath: string,
  providers: OpenClawProviderConfig[],
): void {
  let config: Record<string, any>;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    writeDefaultConfig(configPath, DEFAULT_PORT, providers);
    return;
  }

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

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
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
      'Or set binPath in ~/.anycode/agents/openclaw.json',
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

    // Build the RPC params
    const params: Record<string, unknown> = {
      prompt: opts.prompt,
      sessionKey: this.sessionKey,
    };
    if (this.sessionId) {
      params.sessionId = this.sessionId;
    }
    if (opts.files?.length) {
      params.files = opts.files;
    }

    emit({ type: 'system' });

    const startedAt = Date.now();
    try {
      // Send prompt to openclaw gateway via RPC. The gateway processes
      // the message and returns a result with the full response.
      // TODO: For streaming, we may need to subscribe to session events
      // via the WS event stream and emit incremental AgentEvent.
      const result = await this.ws.request<any>('chat.send', params, {
        timeoutMs: 300_000, // 5 min for long tasks
      });

      // Extract session id
      if (typeof result?.sessionId === 'string') {
        this.sessionId = result.sessionId;
        emit({ type: 'session', sessionId: result.sessionId });
      }

      // Normalize response
      if (typeof result?.text === 'string') {
        emit({ type: 'text', delta: result.text });
      }

      // Tool calls if returned
      if (Array.isArray(result?.toolCalls)) {
        for (const tc of result.toolCalls) {
          emit({ type: 'tool_use', name: tc.name || 'tool', detail: tc.detail || '' });
          emit({ type: 'tool_result', ok: !tc.error });
        }
      }

      // Stats
      emit({
        type: 'result',
        durationMs: Date.now() - startedAt,
        costUsd: typeof result?.costUsd === 'number' ? result.costUsd : undefined,
        totalTokens: typeof result?.totalTokens === 'number' ? result.totalTokens : undefined,
        contextWindow: typeof result?.contextWindow === 'number' ? result.contextWindow : undefined,
        error: result?.error ? String(result.error) : undefined,
      });
    } catch (err: any) {
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

  constructor(config: OpenClawAgentConfig = {}) {
    this.config = config;
  }

  status(): OpenClawStatus {
    const stateDir = this.config.stateDir || DEFAULT_STATE_DIR;
    return {
      processAlive: this.processManager?.isAlive() ?? false,
      wsConnected: this.wsClient?.isConnected() ?? false,
      gatewayPort: this.config.gatewayPort || DEFAULT_PORT,
      started: this.started,
      binPath: this.config.binPath || null,
      stateDir,
      error: this.lastError,
      logPath: this.processManager?.getLogPath() ?? path.join(stateDir, 'openclaw.log'),
      logTail: this.processManager?.getLogTail() ?? [],
    };
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
    const port = this.config.gatewayPort || DEFAULT_PORT;

    // Ensure state + config dirs exist
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    // Write a minimal valid config if none exists. Schema matches nexu's
    // openclaw-config-compiler.ts output — see openclawConfigSchema in openclaw/src/config.
    if (!fs.existsSync(configPath)) {
      writeDefaultConfig(configPath, port);
      log('info', `wrote default config to ${configPath}`);
    }

    log('info', `stateDir=${stateDir}`);
    log('info', `configPath=${configPath}`);

    // Port preflight — if in use, give it a moment (TIME_WAIT from our own stop),
    // then re-check. Note: we pass --force to openclaw so it will kill stale
    // listeners itself if our own process managed to hold the port.
    if (await isPortInUse(port)) {
      log('info', `port ${port} appears in use; waiting 2s for release...`);
      await new Promise((r) => setTimeout(r, 2000));
      if (await isPortInUse(port)) {
        // Still in use — let openclaw --force deal with it. We log a warning
        // but don't throw; openclaw will either take over the port or error.
        log('warn', `port ${port} still in use; relying on openclaw --force`);
      }
    }

    // Start process — log file goes to frogcode's config dir (not ~/.openclaw)
    const logPath = path.join(path.dirname(configPath), 'openclaw.log');
    const procConfig: ProcessConfig = {
      binPath,
      stateDir,
      configPath,
      gatewayPort: port,
      logPath,
    };
    this.processManager = new OpenClawProcessManager(procConfig);
    this.processManager.enableAutoRestart();
    this.processManager.start();

    // Start WS client
    const wsConfig: WsClientConfig = {
      baseUrl: `http://127.0.0.1:${port}`,
      gatewayToken: this.config.gatewayToken || undefined,
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
