/**
 * OpenClaw process manager — spawn/stop/restart the gateway process.
 * Simplified port from nexu/openclaw-process.ts (664 lines → ~180 lines).
 *
 * Simplifications over nexu:
 *   - No Electron RUN_AS_NODE detection (we always use Node / system binary)
 *   - No workspace root resolution (openclaw is found via PATH or explicit binPath)
 *   - No controlled-restart successor-pid tracking (v1: just SIGTERM + SIGKILL)
 *   - Restart logic kept simple: exponential backoff, max 10 per 120s
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import net from 'node:net';

export interface ProcessConfig {
  /** Path to openclaw binary. If empty, resolves via PATH. */
  binPath?: string;
  /** Working directory / state root for openclaw (OPENCLAW_STATE_DIR). */
  stateDir: string;
  /** Path to the compiled openclaw config JSON (OPENCLAW_CONFIG_PATH). */
  configPath: string;
  /** Gateway port (for health probe, also passed as OPENCLAW_GATEWAY_PORT). */
  gatewayPort: number;
  /** Temp directory for the gateway (TMPDIR env var). */
  tmpDir: string;
  /** Plugin load directory (OPENCLAW_EXTENSIONS_DIR env var). */
  extensionsDir: string;
  /** Log file path. Defaults to {stateDir}/openclaw.log */
  logPath?: string;
}

const MAX_LOG_LINES = 500;

const MAX_RESTARTS = 10;
const RESTART_WINDOW_MS = 120_000;
const BASE_DELAY_MS = 3_000;
/**
 * If the gateway process exits within this many milliseconds of spawn, we
 * treat it as a "fast failure" — usually port-in-use or an immediate config
 * error. After MAX_FAST_FAILURES consecutive fast failures we stop the
 * auto-restart loop so the user isn't stuck watching endless retries.
 */
const FAST_FAILURE_THRESHOLD_MS = 10_000;
const MAX_FAST_FAILURES = 3;
const NEXU_EVENT_MARKER = 'NEXU_EVENT ';

function log(level: string, ...parts: any[]) {
  const msg = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  process.stderr.write(`[openclaw-proc ${level}] ${msg}\n`);
}

export interface OpenClawRuntimeEvent {
  event: string;
  payload?: unknown;
}

export class OpenClawProcessManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private readonly config: ProcessConfig;
  private autoRestart = false;
  private restartCount = 0;
  private windowStart = 0;
  private logStream: fs.WriteStream | null = null;
  private logTail: string[] = [];
  private readonly logPath: string;
  /** Timestamp of the last spawn, used to detect fast-failures. */
  private spawnStartedAt = 0;
  /** Consecutive fast-failure (exit <FAST_FAILURE_THRESHOLD_MS) count. */
  private fastFailureCount = 0;
  /** Terminal error message if auto-restart gave up. Exposed via getFatalError(). */
  private fatalError: string | null = null;

  constructor(config: ProcessConfig) {
    super();
    this.setMaxListeners(20);
    this.config = config;
    this.logPath = config.logPath || path.join(config.stateDir, 'openclaw.log');
  }

  getLogPath(): string {
    return this.logPath;
  }

  /** Return the last N lines from the in-memory log tail. */
  getLogTail(): string[] {
    return [...this.logTail];
  }

  /**
   * If auto-restart gave up (e.g. port is permanently held by another
   * process), this returns a human-readable reason. Cleared by start().
   */
  getFatalError(): string | null {
    return this.fatalError;
  }

  private writeLog(level: string, line: string): void {
    const ts = new Date().toISOString();
    const entry = `[${ts}] [${level}] ${line}`;
    this.logTail.push(entry);
    if (this.logTail.length > MAX_LOG_LINES) this.logTail.shift();
    if (this.logStream) {
      try {
        this.logStream.write(entry + '\n');
      } catch {
        // ignore
      }
    }
    log(level, line);
  }

  private openLogStream(): void {
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      this.logStream?.end();
      this.logStream = fs.createWriteStream(this.logPath, { flags: 'a' });
      this.writeLog('info', `=== log opened at ${new Date().toISOString()} ===`);
    } catch (e: any) {
      log('warn', `failed to open log: ${e.message}`);
    }
  }

  isAlive(): boolean {
    if (!this.child || this.child.killed) return false;
    try {
      process.kill(this.child.pid!, 0);
      return true;
    } catch {
      return false;
    }
  }

  enableAutoRestart(): void {
    this.autoRestart = true;
  }

  start(): void {
    if (this.child && !this.child.killed) return;

    // Clear any previous fatal state so the caller can retry after fixing
    // the root cause (e.g. stopping the conflicting process).
    this.fatalError = null;

    this.openLogStream();

    // Ensure runtime dirs exist before spawn. stateDir/extensionsDir are
    // created defensively here (also by ensureGateway), tmpDir must be
    // present because we pass it as TMPDIR and openclaw may rely on it
    // before doing its own mkdir.
    try {
      fs.mkdirSync(this.config.stateDir, { recursive: true });
      fs.mkdirSync(this.config.extensionsDir, { recursive: true });
      fs.mkdirSync(this.config.tmpDir, { recursive: true });
    } catch (e: any) {
      this.writeLog('warn', `failed to mkdir runtime dirs: ${e.message}`);
    }

    // Kill any orphan openclaw from a previous crashed run (recorded in pid file)
    reapOrphanFromPidFile(this.config.stateDir, (msg) => this.writeLog('info', msg));

    const cmd = this.config.binPath || 'openclaw';
    // Gateway mode, bind, and force behaviors now come from the config file:
    //   gateway.mode: 'local'   ← replaces --allow-unconfigured
    //   gateway.bind: 'loopback' ← replaces --bind loopback
    //   reapOrphanFromPidFile   ← replaces --force (safer, only kills our own)
    const args = ['gateway', 'run'];

    this.writeLog('info', `spawn ${cmd} ${args.join(' ')} cwd=${this.config.stateDir}`);
    this.writeLog('info', `config: ${this.config.configPath}`);

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: this.config.stateDir,
        env: {
          ...process.env,
          OPENCLAW_LOG_LEVEL: 'info',
          OPENCLAW_CONFIG_PATH: this.config.configPath,
          OPENCLAW_STATE_DIR: this.config.stateDir,
          OPENCLAW_EXTENSIONS_DIR: this.config.extensionsDir,
          OPENCLAW_GATEWAY_PORT: String(this.config.gatewayPort),
          TMPDIR: this.config.tmpDir,
          ...(process.platform === 'darwin' ? { OPENCLAW_IMAGE_BACKEND: 'sips' } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: process.platform === 'win32', // allow .cmd shim resolution
      });
    } catch (e: any) {
      this.writeLog('error', `spawn threw: ${e.message}`);
      this.emit('error', e);
      return;
    }

    this.child = child;
    this.spawnStartedAt = Date.now();
    this.windowStart = this.windowStart || Date.now();

    // Record PID for orphan reaping next run
    if (child.pid) {
      writePidFile(this.config.stateDir, child.pid);
      this.writeLog('info', `pid=${child.pid} written to gateway.pid`);
    }

    // stdout: log + parse NEXU_EVENT markers
    if (child.stdout) {
      createInterface({ input: child.stdout }).on('line', (line) => {
        this.writeLog('out', line);
        this.parseEventLine(line);
      });
    }
    if (child.stderr) {
      createInterface({ input: child.stderr }).on('line', (line) => {
        this.writeLog('err', line);
      });
    }

    child.on('close', (code) => {
      const uptime = Date.now() - this.spawnStartedAt;
      this.writeLog('info', `exited code=${code} uptime=${uptime}ms`);
      this.child = null;
      clearPidFile(this.config.stateDir);
      this.emit('exit', code);

      // A healthy gateway runs for minutes/hours. If it died within
      // FAST_FAILURE_THRESHOLD_MS it's almost certainly a startup error
      // (port conflict, bad config, missing binary) and retrying without
      // user intervention will just loop forever.
      if (uptime < FAST_FAILURE_THRESHOLD_MS) {
        this.fastFailureCount++;
        this.writeLog(
          'warn',
          `fast failure ${this.fastFailureCount}/${MAX_FAST_FAILURES} (exited in ${uptime}ms)`,
        );
        if (this.fastFailureCount >= MAX_FAST_FAILURES) {
          this.autoRestart = false;
          // Surface a hint pulled from recent stderr if we can find one.
          const hint = this.extractFailureHint();
          this.fatalError =
            hint ||
            `openclaw gateway exited ${MAX_FAST_FAILURES} times in a row within ${FAST_FAILURE_THRESHOLD_MS}ms. Check logs; likely a port conflict or config error.`;
          this.writeLog('error', `giving up: ${this.fatalError}`);
          this.emit('max-restarts', this.fatalError);
          return;
        }
      } else {
        // Long-running success reset
        this.fastFailureCount = 0;
      }

      this.maybeAutoRestart();
    });

    child.on('error', (err) => {
      this.writeLog('error', `spawn error: ${err.message}`);
      this.child = null;
      this.emit('error', err);
      this.maybeAutoRestart();
    });
  }

  async stop(): Promise<void> {
    this.autoRestart = false;
    if (!this.child || this.child.killed) {
      this.logStream?.end();
      this.logStream = null;
      return;
    }
    const child = this.child;
    this.writeLog('info', 'stopping...');
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
        resolve();
      }, 5000);
      child.on('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    this.child = null;
    this.logStream?.end();
    this.logStream = null;
  }

  /**
   * TCP probe: can we connect to the gateway port?
   */
  async probeHealth(): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.createConnection(
        { host: '127.0.0.1', port: this.config.gatewayPort, timeout: 2000 },
        () => {
          sock.destroy();
          resolve(true);
        },
      );
      sock.on('error', () => resolve(false));
      sock.on('timeout', () => {
        sock.destroy();
        resolve(false);
      });
    });
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  /**
   * Scan the recent log tail for well-known openclaw startup errors and
   * produce an actionable hint. Returns null if nothing matches.
   */
  private extractFailureHint(): string | null {
    // Walk backwards through the tail, newest first.
    for (let i = this.logTail.length - 1; i >= 0; i--) {
      const line = this.logTail[i];
      if (line.includes('Port') && line.includes('already in use')) {
        return (
          `Port ${this.config.gatewayPort} is already in use by another process. ` +
          `This usually means a global openclaw install is running as a Windows ` +
          `scheduled task ("OpenClaw Gateway"). Stop it with: ` +
          `schtasks /End /TN "OpenClaw Gateway"   or   openclaw gateway stop. ` +
          `You can also change frogcode's gatewayPort in ~/.anycode/agents/openclaw.json.`
        );
      }
      if (line.includes('gateway already running')) {
        return (
          `Another openclaw gateway is already holding the lock. ` +
          `Run:   openclaw gateway stop   or   schtasks /End /TN "OpenClaw Gateway"`
        );
      }
      if (line.includes('Gateway service appears registered')) {
        return (
          `A Windows scheduled task is keeping openclaw alive in the background. ` +
          `Disable it with:   schtasks /Change /TN "OpenClaw Gateway" /DISABLE`
        );
      }
      if (line.includes('ENOENT') || line.includes('not found')) {
        return `openclaw binary not found — check binPath in ~/.anycode/agents/openclaw.json`;
      }
    }
    return null;
  }

  private maybeAutoRestart(): void {
    if (!this.autoRestart) return;

    // Reset counter if outside window
    if (Date.now() - this.windowStart > RESTART_WINDOW_MS) {
      this.restartCount = 0;
      this.windowStart = Date.now();
    }
    this.restartCount++;

    if (this.restartCount > MAX_RESTARTS) {
      log('error', `exceeded max restarts (${MAX_RESTARTS} in ${RESTART_WINDOW_MS}ms)`);
      this.emit('max-restarts');
      return;
    }

    const delay = BASE_DELAY_MS * Math.min(this.restartCount, 5);
    log('info', `auto-restart in ${delay}ms (attempt ${this.restartCount}/${MAX_RESTARTS})`);
    setTimeout(() => {
      if (this.autoRestart && !this.child) this.start();
    }, delay);
  }

  private parseEventLine(line: string): void {
    const idx = line.indexOf(NEXU_EVENT_MARKER);
    if (idx < 0) return;
    const rest = line.slice(idx + NEXU_EVENT_MARKER.length).trim();
    const spaceIdx = rest.indexOf(' ');
    const eventName = spaceIdx >= 0 ? rest.slice(0, spaceIdx) : rest;
    const rawPayload = spaceIdx >= 0 ? rest.slice(spaceIdx + 1).trim() : '';
    if (!eventName) return;

    let payload: unknown;
    if (rawPayload) {
      try {
        payload = JSON.parse(rawPayload);
      } catch {
        return;
      }
    }

    this.emit('runtime-event', { event: eventName, payload } as OpenClawRuntimeEvent);
  }
}

// ---------------------------------------------------------------------------
// PID file helpers (orphan reaping across app restarts)
// ---------------------------------------------------------------------------

function pidFilePath(stateDir: string): string {
  return path.join(stateDir, '.gateway.pid');
}

function writePidFile(stateDir: string, pid: number): void {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(pidFilePath(stateDir), String(pid));
  } catch {
    // ignore
  }
}

function clearPidFile(stateDir: string): void {
  try {
    fs.unlinkSync(pidFilePath(stateDir));
  } catch {
    // ignore
  }
}

/**
 * Read the PID file from a previous run. If that PID is still alive, kill it.
 * This handles the Windows case where child processes outlive their parent.
 */
function reapOrphanFromPidFile(stateDir: string, logFn: (msg: string) => void): void {
  const fp = pidFilePath(stateDir);
  let pid: number;
  try {
    const raw = fs.readFileSync(fp, 'utf8').trim();
    pid = parseInt(raw, 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      clearPidFile(stateDir);
      return;
    }
  } catch {
    return; // no pid file
  }

  // Check if alive
  try {
    process.kill(pid, 0);
  } catch {
    // not alive
    clearPidFile(stateDir);
    return;
  }

  // Alive — kill it
  logFn(`reaping orphan openclaw pid=${pid} from previous run`);
  try {
    if (process.platform === 'win32') {
      // Windows: use taskkill /f /t to kill the whole tree
      require('node:child_process').execSync(`taskkill /f /t /pid ${pid}`, {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch (e: any) {
    logFn(`failed to kill orphan: ${e.message}`);
  }
  clearPidFile(stateDir);

  // Wait briefly for the port to be released
  const start = Date.now();
  while (Date.now() - start < 2000) {
    // spin; synchronous delay is ok here since this runs rarely
    try {
      require('node:child_process').execSync(
        process.platform === 'win32' ? 'timeout /t 1 /nobreak > nul' : 'sleep 0.2',
        { stdio: 'ignore' },
      );
    } catch {
      break;
    }
    break;
  }
}
