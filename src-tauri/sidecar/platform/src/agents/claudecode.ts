/**
 * ClaudeCodeAgent — spawns `claude` CLI, parses stream-json output, emits AgentEvent.
 *
 * Translated from Rust im_bridge.rs execute_claude_for_chat (~270 lines) into TS.
 * Semantics must match exactly — same flags, same JSONL schema, same stats extraction.
 *
 * One ClaudeCodeSession per (platform,channel,user). Claude Code has native
 * --resume support, so resuming across sidecar restarts works naturally.
 *
 * Important differences from the Rust version:
 *   - No HTTP callbacks; events go through EventEmitter to card-renderer
 *   - Throttling moved out (card-renderer handles 300ms debounce)
 *   - Per-turn spawn (claude exits after each -p prompt); session continuity via --resume
 */

import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as readline from 'node:readline';
import type {
  Agent,
  AgentEvent,
  AgentSession,
  SendOpts,
  SessionKey,
  StartSessionOpts,
} from './types.js';
import { deleteStoredSession } from './manager.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ClaudeCodeAgentConfig {
  /** Absolute path to `claude` binary. If null, uses PATH lookup. */
  binPath?: string | null;
  /** Extra CLI args appended after the defaults. */
  extraArgs?: string[];
  /** Mode — currently only bypassPermissions is supported via flag. */
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

class ClaudeCodeSession implements AgentSession {
  readonly sessionKey: SessionKey;
  private readonly cwd: string;
  private readonly config: ClaudeCodeAgentConfig;
  private readonly emitter = new EventEmitter();
  private sessionId: string | null;
  private currentChild: ChildProcess | null = null;
  private closed = false;

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

  async send(opts: SendOpts): Promise<void> {
    if (this.closed) throw new Error('session closed');
    if (this.currentChild) throw new Error('a turn is already in flight');

    const resumeId = this.sessionId;
    // When resuming, suppress the error result event so the card stays alive
    // for the retry — otherwise the card finalizes as "error" and the retry's
    // events have nowhere to go.
    const result = await this._doSpawn(opts, resumeId, {
      suppressErrorResult: !!resumeId,
    });

    // If resume failed, delete the stale session file and retry fresh
    if (result.sawError && resumeId) {
      log('info', `resume ${resumeId} failed, deleting stale session and retrying fresh`);
      this.sessionId = null;
      deleteStoredSession(this.sessionKey);
      await this._doSpawn(opts, null);
    }
  }

  private async _doSpawn(
    opts: SendOpts,
    resumeId: string | null,
    spawnOpts?: { suppressErrorResult?: boolean },
  ): Promise<{ sawError: boolean }> {
    // Prepend attached files as simple file references (matches Rust behaviour)
    const finalPrompt =
      opts.files && opts.files.length > 0
        ? `${opts.files.map((f) => `[Attached file: ${f}]`).join('\n')}\n\n${opts.prompt}`
        : opts.prompt;

    const args: string[] = [];
    if (resumeId) {
      args.push('--resume', resumeId);
    }
    args.push('--output-format', 'stream-json');
    args.push('--verbose');
    // v1: force bypass, matches current Rust impl. TODO: map config.mode
    // Claude CLI refuses --dangerously-skip-permissions under root/sudo.
    // On Linux-root, drop the flag so spawn doesn't hard-fail.
    const isLinuxRoot =
      process.platform === 'linux' &&
      typeof process.getuid === 'function' &&
      process.getuid() === 0;
    if (!isLinuxRoot) {
      args.push('--dangerously-skip-permissions');
    } else {
      log('warn', 'running as linux root; omitting --dangerously-skip-permissions');
    }
    if (this.config.extraArgs?.length) {
      args.push(...this.config.extraArgs);
    }
    args.push('-p', finalPrompt);

    const binPath = this.config.binPath || 'claude';
    log('info', `spawn ${binPath} cwd=${this.cwd} resume=${resumeId ?? 'none'}`);

    const child = spawn(binPath, args, {
      cwd: this.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: isWindows, // allow `claude.cmd` resolution on Windows
    });
    this.currentChild = child;

    const startedAt = Date.now();
    const stderrBuf: string[] = [];

    // Collect stderr (capped) for error reporting + diagnostics
    child.stderr!.on('data', (chunk: Buffer) => {
      const s = chunk.toString();
      stderrBuf.push(s);
      if (stderrBuf.length > 32) stderrBuf.shift();
      // Log stderr lines for diagnostics
      for (const line of s.split('\n')) {
        const t = line.trim();
        if (t) log('stderr', t);
      }
    });

    // Parse stdout JSONL line-by-line
    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    let sawAny = false;
    let sawResult = false;
    let sawError = false;
    let lastDurationMs: number | undefined;

    const emit = (evt: AgentEvent) => this.emitter.emit('event', evt);

    rl.on('line', (raw) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      let msg: any;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      sawAny = true;

      // Extract CLI-native session_id
      if (typeof msg.session_id === 'string' && msg.session_id !== this.sessionId) {
        this.sessionId = msg.session_id;
        emit({ type: 'session', sessionId: msg.session_id });
      }

      const msgType = typeof msg.type === 'string' ? msg.type : '';

      // system / init — model info
      if (msgType === 'system') {
        const model = typeof msg.model === 'string' ? msg.model : undefined;
        emit({ type: 'system', model });
        return;
      }

      // assistant — text + tool_use blocks
      if (msgType === 'assistant') {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const blockType = block?.type;
            if (blockType === 'text' && typeof block.text === 'string') {
              emit({ type: 'text', delta: block.text });
            } else if (blockType === 'tool_use') {
              const name: string = typeof block.name === 'string' ? block.name : 'tool';
              let detail = '';
              const input = block.input;
              if (input && typeof input === 'object') {
                if (typeof input.command === 'string') {
                  detail = input.command.slice(0, 80);
                } else if (typeof input.file_path === 'string') {
                  detail = input.file_path.slice(0, 80);
                } else if (typeof input.path === 'string') {
                  detail = input.path.slice(0, 80);
                }
              }
              emit({ type: 'tool_use', name, detail });
            }
          }
        }
        return;
      }

      // user — tool_result blocks mark previous tool complete
      if (msgType === 'user') {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_result') {
              emit({ type: 'tool_result', ok: true });
            }
          }
        }
        return;
      }

      // result — final stats + cost + context
      if (msgType === 'result') {
        sawResult = true;
        const isError = msg.is_error === true || msg.subtype === 'error';
        sawError = isError;

        const errorMsg = isError
          ? typeof msg.result === 'string'
            ? msg.result
            : typeof msg.error === 'string'
              ? msg.error
              : 'claude reported an error'
          : undefined;

        if (errorMsg) log('error', `result error: ${errorMsg}`);

        // When a resume attempt fails and we're going to retry, suppress
        // the error result so the card stays alive (in 'running' state)
        // for the retry. If we emitted it, the card would finalize as
        // "error" and the retry's events would be lost.
        if (isError && spawnOpts?.suppressErrorResult) {
          log('info', `result error suppressed (will retry without --resume)`);
          return;
        }

        let costUsd: number | undefined;
        let durationMs: number | undefined = Date.now() - startedAt;
        let totalTokens: number | undefined;
        let contextWindow: number | undefined;

        if (typeof msg.total_cost_usd === 'number') costUsd = msg.total_cost_usd;
        if (typeof msg.duration_ms === 'number') durationMs = msg.duration_ms;
        lastDurationMs = durationMs;

        const usage = msg.modelUsage;
        if (usage && typeof usage === 'object') {
          let total = 0;
          let ctx = 0;
          for (const stats of Object.values(usage as Record<string, any>)) {
            if (stats && typeof stats === 'object') {
              if (typeof stats.inputTokens === 'number') total += stats.inputTokens;
              if (typeof stats.outputTokens === 'number') total += stats.outputTokens;
              if (typeof stats.contextWindow === 'number' && stats.contextWindow > ctx) {
                ctx = stats.contextWindow;
              }
            }
          }
          if (total > 0) totalTokens = total;
          if (ctx > 0) contextWindow = ctx;
        }

        emit({
          type: 'result',
          costUsd,
          durationMs,
          totalTokens,
          contextWindow,
          error: errorMsg,
        });
      }
    });

    // Wait for process exit
    await new Promise<void>((resolve) => {
      child.on('close', (code) => {
        rl.close();
        this.currentChild = null;

        // If we never saw a `result` event, synthesize one so the UI finalizes
        if (!sawResult) {
          sawError = code !== 0 && code !== null;
          const stderr = stderrBuf.join('').slice(-500);
          if (sawError) {
            emit({
              type: 'result',
              durationMs: lastDurationMs ?? Date.now() - startedAt,
              error: stderr || `claude exited with code ${code}`,
            });
          } else if (!sawAny) {
            emit({
              type: 'result',
              durationMs: lastDurationMs ?? Date.now() - startedAt,
              error: 'No response received',
            });
          } else {
            // Stream ended cleanly with assistant output but no explicit result
            emit({
              type: 'result',
              durationMs: lastDurationMs ?? Date.now() - startedAt,
            });
          }
        }
        log('info', `exit code=${code} sawResult=${sawResult} sawError=${sawError}`);
        resolve();
      });
      child.on('error', (err) => {
        rl.close();
        this.currentChild = null;
        sawError = true;
        emit({
          type: 'result',
          durationMs: Date.now() - startedAt,
          error: `spawn failed: ${err.message}`,
        });
        resolve();
      });
    });

    return { sawError };
  }

  async cancel(): Promise<void> {
    if (this.currentChild && !this.currentChild.killed) {
      this.currentChild.kill(isWindows ? undefined : 'SIGTERM');
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.cancel();
    this.emitter.emit('close');
    this.emitter.removeAllListeners();
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
    // Per-turn spawn means nothing to stop at the agent level
  }
}
