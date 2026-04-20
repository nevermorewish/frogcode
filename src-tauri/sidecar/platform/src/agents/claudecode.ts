/**
 * ClaudeCodeAgent — long-lived `claude` session driven by stream-json.
 *
 * Replaces the previous per-turn `claude -p <prompt>` spawn. Based on
 * cc-connect (Go)'s approach:
 *
 *   claude \
 *     --output-format stream-json \
 *     --input-format stream-json \
 *     --permission-prompt-tool stdio \
 *     --verbose \
 *     [--resume <sessionId>]
 *
 * stdin is piped; user turns written as JSONL:
 *   {"type":"user","message":{"role":"user","content":"<prompt>"}}
 *
 * Tool permission requests arrive as:
 *   {"type":"control_request","request_id":"<id>",
 *    "request":{"subtype":"can_use_tool","tool_name":"...","input":{...}}}
 * We auto-allow (bypassPermissions semantics) by writing:
 *   {"type":"control_response","response":{
 *      "subtype":"success","request_id":"<id>",
 *      "response":{"behavior":"allow","updatedInput":<input>}}}
 *
 * Benefits over `-p` mode:
 *   - Avoids the Claude 2.x trust-dialog rejection that fires when
 *     headless + stdin-ignored (the root cause of the GBK-encoded
 *     Windows error we were seeing on remote machines).
 *   - One process per SessionKey → turn-to-turn warm cache, no spawn cost.
 *   - Session id stays stable; resume is an optimization, not a crutch.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  Agent,
  AgentEvent,
  AgentSession,
  SendOpts,
  SessionKey,
  StartSessionOpts,
} from './types.js';
import { deleteStoredSession } from './manager.js';

/**
 * Defense in depth — even in stream-json mode we keep pre-seeding
 * ~/.claude.json projects[cwd].hasTrustDialogAccepted=true so nothing
 * ever prompts for a trust confirmation we can't answer.
 */
function ensureWorkspaceTrusted(cwd: string, log: (level: string, msg: string) => void): void {
  try {
    const cfgPath = path.join(os.homedir(), '.claude.json');
    let cfg: any = {};
    if (fs.existsSync(cfgPath)) {
      const raw = fs.readFileSync(cfgPath, 'utf8');
      try {
        cfg = JSON.parse(raw);
      } catch {
        log('warn', `pre-trust: ${cfgPath} unparseable, skip`);
        return;
      }
    }
    const key = cwd.replace(/\\/g, '/');
    cfg.projects = cfg.projects || {};
    const existing = cfg.projects[key];
    if (existing && existing.hasTrustDialogAccepted === true) return;
    cfg.projects[key] = { ...(existing || {}), hasTrustDialogAccepted: true };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    log('info', `pre-trusted workspace ${key}`);
  } catch (e) {
    log('warn', `pre-trust failed: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ClaudeCodeAgentConfig {
  /** Absolute path to `claude` binary. If null, uses PATH lookup. */
  binPath?: string | null;
  /** Extra CLI args appended after the defaults. */
  extraArgs?: string[];
  /**
   * Permission mode. Stream-json + permission-prompt-tool stdio is
   * incompatible with --dangerously-skip-permissions — we auto-allow
   * in-process via control_response instead. `bypassPermissions` is
   * the effective behavior; other modes get --permission-mode added.
   */
  mode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
}

const isWindows = process.platform === 'win32';

function log(level: string, ...parts: any[]) {
  const msg = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  process.stderr.write(`[claudecode ${level}] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** How long to wait after no stdout within an in-flight turn before killing. */
const TURN_IDLE_TIMEOUT_MS = 180_000;
/** Graceful shutdown: stdin close → wait → SIGTERM → wait → SIGKILL. */
const CLOSE_GRACE_MS = 5_000;
const CLOSE_SIGTERM_GRACE_MS = 3_000;

interface InFlight {
  resolve: () => void;
  reject: (err: Error) => void;
  startedAt: number;
  idleTimer: NodeJS.Timeout | null;
  /** When the current turn has emitted at least one event we know claude is alive. */
  receivedAny: boolean;
  /** If true, the next error result from claude will be swallowed (retry in progress). */
  suppressNextErrorResult: boolean;
  /** Used to distinguish "result with is_error:true" from abnormal process exit. */
  sawResult: boolean;
  sawError: boolean;
}

class ClaudeCodeSession implements AgentSession {
  readonly sessionKey: SessionKey;
  private readonly cwd: string;
  private readonly config: ClaudeCodeAgentConfig;
  private readonly emitter = new EventEmitter();
  private sessionId: string | null;
  private child: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private closed = false;
  /** Accumulated stderr (capped). Used for crash diagnostics. */
  private stderrBuf: string[] = [];
  /** Current turn state, or null when idle. */
  private turn: InFlight | null = null;
  /** Pending sends — serialized so only one turn is in flight per session. */
  private sendChain: Promise<void> = Promise.resolve();

  constructor(opts: StartSessionOpts, config: ClaudeCodeAgentConfig) {
    this.sessionKey = opts.sessionKey;
    this.cwd = opts.cwd || process.cwd();
    this.config = config;
    this.sessionId = opts.resumeSessionId ?? null;
    this.emitter.setMaxListeners(20);
  }

  events(): EventEmitter {
    return this.emitter;
  }

  currentSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Send a prompt. Serialized — if a previous turn is still running the
   * new send waits for it to finish. This matches the old per-turn spawn
   * semantics (one turn at a time per session).
   */
  async send(opts: SendOpts): Promise<void> {
    if (this.closed) throw new Error('session closed');

    // Queue behind any in-flight send
    const runPromise = this.sendChain.then(() => this._runOneTurn(opts));
    this.sendChain = runPromise.catch(() => {});
    return runPromise;
  }

  private async _runOneTurn(opts: SendOpts): Promise<void> {
    if (this.closed) throw new Error('session closed');

    // Spawn on demand (first turn, or after a previous crash)
    if (!this.child || this.child.killed || this.child.exitCode !== null) {
      await this._spawnChild();
    }

    // Build user payload. Attachments are still referenced by path
    // prefix (multimodal content array can come later).
    const promptText =
      opts.files && opts.files.length > 0
        ? `${opts.files.map((f) => `[Attached file: ${f}]`).join('\n')}\n\n${opts.prompt}`
        : opts.prompt;

    const userMessage = {
      type: 'user',
      message: { role: 'user', content: promptText },
    };

    // Open an in-flight promise before writing so we can't miss early events.
    const turn = await this._startTurn();

    try {
      await this._writeJSON(userMessage);
    } catch (err) {
      this._endTurn(new Error(`write stdin failed: ${(err as Error).message}`));
      throw err;
    }

    // Wait for the result event (or abnormal termination / timeout).
    await new Promise<void>((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
    }).catch(async (err) => {
      // If the turn failed with something claude-side (error result, crash)
      // and we were resuming a persisted session, drop the stale sessionId
      // and let the next send spawn fresh. This mirrors the old behavior.
      if (turn.sawError && this.sessionId) {
        log('info', `turn failed; clearing stale session ${this.sessionId}`);
        this.sessionId = null;
        deleteStoredSession(this.sessionKey);
      }
      throw err;
    });
  }

  private async _startTurn(): Promise<InFlight> {
    const turn: InFlight = {
      resolve: () => {},
      reject: () => {},
      startedAt: Date.now(),
      idleTimer: null,
      receivedAny: false,
      suppressNextErrorResult: false,
      sawResult: false,
      sawError: false,
    };
    this.turn = turn;
    this._armIdleTimer();
    return turn;
  }

  private _endTurn(err?: Error): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    if (turn.idleTimer) {
      clearTimeout(turn.idleTimer);
      turn.idleTimer = null;
    }
    if (err) turn.reject(err);
    else turn.resolve();
  }

  private _armIdleTimer(): void {
    const turn = this.turn;
    if (!turn) return;
    if (turn.idleTimer) clearTimeout(turn.idleTimer);
    turn.idleTimer = setTimeout(() => {
      log('warn', `turn idle ${TURN_IDLE_TIMEOUT_MS}ms, killing claude pid=${this.child?.pid}`);
      // Synthesize error result so the card finalizes
      this._emit({
        type: 'result',
        durationMs: Date.now() - turn.startedAt,
        error: `claude 无响应超时 (${Math.round(TURN_IDLE_TIMEOUT_MS / 1000)}s)，已强制终止`,
      });
      turn.sawError = true;
      this._endTurn();
      this._killChild();
    }, TURN_IDLE_TIMEOUT_MS);
    turn.idleTimer.unref?.();
  }

  private async _spawnChild(): Promise<void> {
    const args: string[] = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--permission-prompt-tool', 'stdio',
      '--verbose',
    ];
    if (this.sessionId) {
      args.push('--resume', this.sessionId);
    }
    // Map optional mode to --permission-mode (default is omitted)
    const mode = this.config.mode;
    if (mode && mode !== 'default' && mode !== 'bypassPermissions') {
      args.push('--permission-mode', mode);
    }
    if (this.config.extraArgs?.length) args.push(...this.config.extraArgs);

    const binPath = this.config.binPath || 'claude';
    ensureWorkspaceTrusted(this.cwd, log);
    log('info', `spawn ${binPath} cwd=${this.cwd} resume=${this.sessionId ?? 'none'}`);

    const child = spawn(binPath, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: isWindows,
    });
    this.child = child;
    this.stderrBuf = [];

    child.stderr!.on('data', (chunk: Buffer) => {
      const s = chunk.toString();
      this.stderrBuf.push(s);
      if (this.stderrBuf.length > 64) this.stderrBuf.shift();
      for (const line of s.split('\n')) {
        const t = line.trim();
        if (t) log('stderr', t);
      }
    });

    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    this.rl = rl;
    rl.on('line', (raw) => this._onLine(raw));

    child.on('close', (code) => this._onChildClose(code));
    child.on('error', (err) => this._onChildError(err));
  }

  private async _writeJSON(obj: any): Promise<void> {
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed) {
      throw new Error('child stdin is not writable');
    }
    const data = JSON.stringify(obj) + '\n';
    return new Promise<void>((resolve, reject) => {
      child.stdin!.write(data, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private _emit(evt: AgentEvent): void {
    this.emitter.emit('event', evt);
  }

  private _onLine(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) return;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (this.turn) {
      this.turn.receivedAny = true;
      this._armIdleTimer(); // reset idle on any output
    }

    // Extract CLI-native session_id whenever it appears
    if (typeof msg.session_id === 'string' && msg.session_id !== this.sessionId) {
      this.sessionId = msg.session_id;
      this._emit({ type: 'session', sessionId: msg.session_id });
    }

    const msgType = typeof msg.type === 'string' ? msg.type : '';

    switch (msgType) {
      case 'system':
        this._emit({
          type: 'system',
          model: typeof msg.model === 'string' ? msg.model : undefined,
        });
        return;

      case 'assistant': {
        const content = msg.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          const blockType = block?.type;
          if (blockType === 'text' && typeof block.text === 'string') {
            this._emit({ type: 'text', delta: block.text });
          } else if (blockType === 'tool_use') {
            const name: string = typeof block.name === 'string' ? block.name : 'tool';
            let detail = '';
            const input = block.input;
            if (input && typeof input === 'object') {
              if (typeof input.command === 'string') detail = input.command.slice(0, 80);
              else if (typeof input.file_path === 'string') detail = input.file_path.slice(0, 80);
              else if (typeof input.path === 'string') detail = input.path.slice(0, 80);
            }
            this._emit({ type: 'tool_use', name, detail });
          }
        }
        return;
      }

      case 'user': {
        const content = msg.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block?.type === 'tool_result') {
            this._emit({ type: 'tool_result', ok: block.is_error !== true });
          }
        }
        return;
      }

      case 'result':
        this._handleResult(msg);
        return;

      case 'control_request':
        this._handleControlRequest(msg);
        return;

      case 'control_cancel_request':
        // No-op; we don't initiate cancels via stdio.
        return;
    }
  }

  private _handleResult(msg: any): void {
    const turn = this.turn;
    const isError = msg.is_error === true || msg.subtype === 'error';
    const errorMsg = isError
      ? typeof msg.result === 'string'
        ? msg.result
        : typeof msg.error === 'string'
          ? msg.error
          : 'claude reported an error'
      : undefined;
    if (errorMsg) log('error', `result error: ${errorMsg}`);

    let costUsd: number | undefined;
    let durationMs: number | undefined =
      typeof msg.duration_ms === 'number'
        ? msg.duration_ms
        : turn
          ? Date.now() - turn.startedAt
          : undefined;
    let totalTokens: number | undefined;
    let contextWindow: number | undefined;

    if (typeof msg.total_cost_usd === 'number') costUsd = msg.total_cost_usd;

    const usage = msg.modelUsage;
    if (usage && typeof usage === 'object') {
      let total = 0;
      let ctx = 0;
      for (const stats of Object.values(usage as Record<string, any>)) {
        if (stats && typeof stats === 'object') {
          if (typeof (stats as any).inputTokens === 'number') total += (stats as any).inputTokens;
          if (typeof (stats as any).outputTokens === 'number') total += (stats as any).outputTokens;
          if (
            typeof (stats as any).contextWindow === 'number' &&
            (stats as any).contextWindow > ctx
          ) {
            ctx = (stats as any).contextWindow;
          }
        }
      }
      if (total > 0) totalTokens = total;
      if (ctx > 0) contextWindow = ctx;
    }

    if (turn) {
      turn.sawResult = true;
      turn.sawError = isError;
    }

    this._emit({
      type: 'result',
      costUsd,
      durationMs,
      totalTokens,
      contextWindow,
      error: errorMsg,
    });

    // Turn done; keep the child alive for the next send.
    this._endTurn();
  }

  private _handleControlRequest(msg: any): void {
    const requestId: string = typeof msg.request_id === 'string' ? msg.request_id : '';
    const req = msg.request;
    const subtype: string = req && typeof req.subtype === 'string' ? req.subtype : '';
    if (subtype !== 'can_use_tool') {
      // Unknown control subtype — ignore (claude will time out its side if needed)
      return;
    }
    const input = (req && req.input && typeof req.input === 'object') ? req.input : {};

    // Auto-allow (bypassPermissions semantics). Tool_use/tool_result events
    // still flow through the normal assistant/user channels for card display.
    const resp = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          behavior: 'allow',
          updatedInput: input,
        },
      },
    };
    this._writeJSON(resp).catch((err) => {
      log('error', `failed to write control_response: ${err.message}`);
    });
  }

  private _onChildClose(code: number | null): void {
    const pid = this.child?.pid;
    const stderr = this.stderrBuf.join('').slice(-500);
    log('info', `child exited code=${code} pid=${pid}`);

    const turn = this.turn;
    if (turn) {
      // Process died mid-turn. Synthesize an error result so the card finalizes.
      const exitedAbnormally = code !== 0 && code !== null;
      turn.sawError = true;
      if (!turn.sawResult) {
        this._emit({
          type: 'result',
          durationMs: Date.now() - turn.startedAt,
          error:
            exitedAbnormally || !turn.receivedAny
              ? stderr || `claude exited with code ${code}`
              : 'claude stream ended unexpectedly',
        });
      }
      this._endTurn();
    }

    // Clean up child references; next send will respawn.
    this._teardownChild();
  }

  private _onChildError(err: Error): void {
    log('error', `child spawn error: ${err.message}`);
    const turn = this.turn;
    if (turn && !turn.sawResult) {
      this._emit({
        type: 'result',
        durationMs: Date.now() - turn.startedAt,
        error: `spawn failed: ${err.message}`,
      });
      turn.sawError = true;
      this._endTurn();
    }
    this._teardownChild();
  }

  private _teardownChild(): void {
    if (this.rl) {
      try { this.rl.close(); } catch {}
      this.rl = null;
    }
    this.child = null;
  }

  private _killChild(): void {
    const child = this.child;
    if (!child || child.killed) return;
    try {
      child.kill(isWindows ? undefined : 'SIGTERM');
    } catch {}
    setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        try { child.kill('SIGKILL' as any); } catch {}
      }
    }, CLOSE_SIGTERM_GRACE_MS).unref?.();
  }

  async cancel(): Promise<void> {
    // Best-effort: kill the child; the turn's reject path handles the rest.
    this._killChild();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this._teardownChild();
      this.emitter.emit('close');
      this.emitter.removeAllListeners();
      return;
    }

    // Phase 1: close stdin, wait for graceful exit
    try { child.stdin?.end(); } catch {}
    const exited = await this._waitForExit(CLOSE_GRACE_MS);
    if (!exited) {
      log('warn', `close: stdin close timed out after ${CLOSE_GRACE_MS}ms, sending SIGTERM`);
      try { child.kill(isWindows ? undefined : 'SIGTERM'); } catch {}
      const exited2 = await this._waitForExit(CLOSE_SIGTERM_GRACE_MS);
      if (!exited2) {
        log('warn', `close: SIGTERM timed out, sending SIGKILL`);
        try { child.kill('SIGKILL' as any); } catch {}
      }
    }
    this._teardownChild();
    this.emitter.emit('close');
    this.emitter.removeAllListeners();
  }

  private _waitForExit(ms: number): Promise<boolean> {
    const child = this.child;
    if (!child || child.exitCode !== null) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      t.unref?.();
      child.once('close', () => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class ClaudeCodeAgent implements Agent {
  readonly name = 'claudecode' as const;
  private readonly config: ClaudeCodeAgentConfig;

  constructor(config: ClaudeCodeAgentConfig = {}) {
    this.config = config;
  }

  async startSession(opts: StartSessionOpts): Promise<AgentSession> {
    return new ClaudeCodeSession(opts, this.config);
  }

  async stop(): Promise<void> {
    // Sessions manage their own lifecycle; nothing at the agent level.
  }
}
