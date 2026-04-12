/**
 * OpenClaw WebSocket Client — JSON-RPC v3 protocol with Ed25519 device auth.
 * Ported from nexu/openclaw-ws-client.ts (839 lines → simplified for our use case).
 *
 * Uses Node's native WebSocket (Node 21+) or falls back to `ws` npm package.
 * Handles: connect → challenge → handshake → ready, heartbeat, auto-reconnect.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WsLib, { type WebSocket as WsSocket } from 'ws';
import {
  type DeviceIdentity,
  buildDeviceAuthPayloadV3,
  clearStoredDeviceToken,
  loadOrCreateDeviceIdentity,
  loadStoredDeviceToken,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
  storeDeviceToken,
} from './device.js';

// ---------------------------------------------------------------------------
// Protocol types (subset of openclaw/src/gateway/protocol)
// ---------------------------------------------------------------------------

interface RequestFrame {
  type: 'req';
  id: string;
  method: string;
  params?: unknown;
}

interface ResponseFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
}

interface EventFrame {
  type: 'event';
  event: string;
  payload?: unknown;
}

type Frame = RequestFrame | ResponseFrame | EventFrame;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface WsClientConfig {
  /** Base URL of the openclaw gateway (http://127.0.0.1:18789). */
  baseUrl: string;
  /** Optional explicit gateway token (overrides stored device token). */
  gatewayToken?: string;
  /** State directory (for device identity + token storage). */
  stateDir: string;
}

const PROTOCOL_VERSION = 3;
const MAX_BACKOFF_MS = 4_000;
const REQUEST_TIMEOUT_MS = 15_000;

function log(level: string, ...parts: any[]) {
  const msg = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  process.stderr.write(`[openclaw-ws ${level}] ${msg}\n`);
}

function resolveWsUrl(baseUrl: string): string {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.href.replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class OpenClawWsClient extends EventEmitter {
  private ws: WsSocket | null = null;
  private pending = new Map<string, Pending>();
  private _connected = false;
  private closed = false;
  private backoffMs = 500;
  private lastTick: number | null = null;
  private tickIntervalMs = 30_000;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly url: string;
  private readonly token: string;
  private readonly stateDir: string;
  private readonly deviceIdentity: DeviceIdentity;

  constructor(config: WsClientConfig) {
    super();
    this.setMaxListeners(20);
    this.url = resolveWsUrl(config.baseUrl);
    this.token = config.gatewayToken ?? '';
    this.stateDir = config.stateDir;
    this.deviceIdentity = loadOrCreateDeviceIdentity(config.stateDir);
    log('info', `device id: ${this.deviceIdentity.deviceId}`);
  }

  isConnected(): boolean {
    return this._connected;
  }

  connect(): void {
    if (this.closed || this.ws) return;
    log('info', `connecting to ${this.url}`);

    const ws = new WsLib(this.url);
    this.ws = ws;

    ws.on('message', (data: Buffer | string) => {
      this.handleMessage(typeof data === 'string' ? data : data.toString('utf8'));
    });

    let didCleanup = false;
    const cleanupOnce = () => {
      if (didCleanup) return;
      didCleanup = true;
      this.cleanup();
      this.scheduleReconnect();
    };

    ws.on('close', (code: number, reasonBuf: Buffer) => {
      const reason = reasonBuf.toString('utf8').trim().toLowerCase();
      if (
        code === 1008 &&
        (reason.includes('device token mismatch') || reason.includes('device signature invalid'))
      ) {
        clearStoredDeviceToken({
          stateDir: this.stateDir,
          deviceId: this.deviceIdentity.deviceId,
          role: 'operator',
        });
      }
      log('info', `closed code=${code} reason=${reason}`);
      cleanupOnce();
    });

    ws.on('error', (err: Error) => {
      log('warn', 'ws error:', err.message);
      cleanupOnce();
    });
  }

  stop(): void {
    this.closed = true;
    this.cleanup();
    this.ws?.close();
    this.ws = null;
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WsLib.OPEN || !this._connected) {
      throw new Error('openclaw gateway not connected');
    }
    const id = randomUUID();
    const frame: RequestFrame = { type: 'req', id, method, params };
    const timeoutMs = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`openclaw request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      this.ws?.send(JSON.stringify(frame));
    });
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    let parsed: Frame;
    try {
      parsed = JSON.parse(raw) as Frame;
    } catch {
      return;
    }

    if (parsed.type === 'event') {
      this.handleEvent(parsed);
      return;
    }
    if (parsed.type === 'res') {
      this.handleResponse(parsed);
    }
  }

  private handleEvent(evt: EventFrame): void {
    if (evt.event === 'connect.challenge') {
      const nonce = (evt.payload as { nonce?: string } | undefined)?.nonce;
      if (!nonce) {
        log('error', 'missing nonce in challenge');
        this.ws?.close(4008, 'missing nonce');
        return;
      }
      this.sendConnectRequest(nonce);
      return;
    }

    if (evt.event === 'tick') {
      this.lastTick = Date.now();
      return;
    }

    if (evt.event === 'shutdown') {
      const payload = evt.payload as { restartExpectedMs?: number; reason?: string } | undefined;
      this.emit('shutdown', {
        restartExpectedMs: typeof payload?.restartExpectedMs === 'number' ? payload.restartExpectedMs : null,
        reason: typeof payload?.reason === 'string' ? payload.reason : null,
      });
      return;
    }

    // Forward all other events (e.g. session.*, channel.*, message.*)
    this.emit('gateway-event', evt.event, evt.payload);
  }

  private handleResponse(res: ResponseFrame): void {
    const pending = this.pending.get(res.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(res.id);

    if (res.ok) {
      pending.resolve(res.payload);
    } else {
      pending.reject(new Error(res.error?.message ?? 'openclaw request failed'));
    }
  }

  private sendConnectRequest(nonce: string): void {
    const id = randomUUID();
    const signedAtMs = Date.now();
    const role = 'operator';
    const scopes = ['operator.admin'];
    // The gateway validates client.id against a whitelist of known clients:
    // webchat-ui, openclaw-control-ui, webchat, cli, gateway-client,
    // openclaw-macos, openclaw-ios, openclaw-android, node-host, test, etc.
    const clientId = 'gateway-client';
    const clientMode = 'backend';
    const platform = process.platform;

    const explicitToken = this.token.trim() || undefined;
    const storedToken = loadStoredDeviceToken({
      stateDir: this.stateDir,
      deviceId: this.deviceIdentity.deviceId,
      role,
    });
    const resolvedDeviceToken = explicitToken ? undefined : (storedToken ?? undefined);
    const authToken = explicitToken ?? resolvedDeviceToken;

    // When we have an explicit gateway token, use token-only auth and skip
    // device signature — the gateway validates the signature first and rejects
    // the connection before it even looks at the token.
    let deviceBlock: Record<string, unknown> | undefined;
    if (!explicitToken) {
      const payloadStr = buildDeviceAuthPayloadV3({
        deviceId: this.deviceIdentity.deviceId,
        clientId,
        clientMode,
        role,
        scopes,
        signedAtMs,
        token: authToken ?? '',
        nonce,
        platform,
      });
      const signature = signDevicePayload(this.deviceIdentity.privateKeyPem, payloadStr);
      deviceBlock = {
        id: this.deviceIdentity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(this.deviceIdentity.publicKeyPem),
        signature,
        signedAt: signedAtMs,
        nonce,
      };
    }

    const frame: RequestFrame = {
      type: 'req',
      id,
      method: 'connect',
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: { id: clientId, version: '1.0.0', platform, mode: clientMode },
        ...(deviceBlock ? { device: deviceBlock } : {}),
        auth:
          authToken || resolvedDeviceToken
            ? { token: authToken, deviceToken: resolvedDeviceToken }
            : undefined,
        role,
        scopes,
      },
    };

    const timer = setTimeout(() => {
      this.pending.delete(id);
      log('error', 'connect handshake timeout');
      this.ws?.close(4008, 'connect timeout');
    }, 10_000);

    this.pending.set(id, {
      resolve: (helloOk) => {
        this._connected = true;
        this.backoffMs = 500;

        // Store device token if returned
        const authInfo =
          helloOk && typeof helloOk === 'object'
            ? ((helloOk as Record<string, unknown>).auth as Record<string, unknown> | undefined)
            : undefined;
        if (typeof authInfo?.deviceToken === 'string') {
          storeDeviceToken({
            stateDir: this.stateDir,
            deviceId: this.deviceIdentity.deviceId,
            role: typeof authInfo.role === 'string' ? authInfo.role : role,
            token: authInfo.deviceToken,
            scopes: Array.isArray(authInfo.scopes)
              ? authInfo.scopes.filter((s): s is string => typeof s === 'string')
              : scopes,
          });
        }

        const policy = (helloOk as Record<string, unknown>)?.policy as
          | { tickIntervalMs?: number }
          | undefined;
        if (typeof policy?.tickIntervalMs === 'number') {
          this.tickIntervalMs = policy.tickIntervalMs;
        }
        this.lastTick = Date.now();
        this.startTickWatch();

        log('info', 'connected and authenticated');
        this.emit('connected');
      },
      reject: (err) => {
        log('error', 'connect failed:', err.message);
        this.ws?.close(4008, 'connect failed');
      },
      timer,
    });

    this.ws?.send(JSON.stringify(frame));
  }

  private startTickWatch(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => {
      if (this.closed || !this.lastTick) return;
      const gap = Date.now() - this.lastTick;
      if (gap > this.tickIntervalMs * 2) {
        log('warn', `tick timeout gap=${gap}ms`);
        this.ws?.close(4000, 'tick timeout');
      }
    }, Math.max(this.tickIntervalMs, 1000));
  }

  private cleanup(): void {
    this._connected = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('openclaw gateway disconnected'));
    }
    this.pending.clear();
  }

  retryNow(): void {
    if (this.closed || this.ws) return;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.backoffMs = 500;
    this.connect();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.ws = null;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    log('info', `reconnect in ${delay}ms`);
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      this.connect();
    }, delay);
  }
}
