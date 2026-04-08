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
  /** Working directory / state root for openclaw. */
  stateDir: string;
  /** Path to the compiled openclaw config JSON. */
  configPath: string;
  /** Gateway port (for health probe). */
  gatewayPort: number;
  /** Log file path. Defaults to {stateDir}/openclaw.log */
  logPath?: string;
}

const MAX_LOG_LINES = 500;

const MAX_RESTARTS = 10;
const RESTART_WINDOW_MS = 120_000;
const BASE_DELAY_MS = 3_000;
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

    this.openLogStream();

    // Kill any orphan openclaw from a previous crashed run (recorded in pid file)
    reapOrphanFromPidFile(this.config.stateDir, (msg) => this.writeLog('info', msg));

    const cmd = this.config.binPath || 'openclaw';
    // --allow-unconfigured lets openclaw start without gateway.mode=local in config
    // --bind loopback binds to 127.0.0.1 only (local RPC, no external access)
    const args = [
      'gateway',
      'run',
      '--allow-unconfigured',
      '--bind',
      'loopback',
      '--force',  // kill any stale listener on the target port
    ];

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
          OPENCLAW_GATEWAY_PORT: String(this.config.gatewayPort),
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
      this.writeLog('info', `exited code=${code}`);
      this.child = null;
      clearPidFile(this.config.stateDir);
      this.emit('exit', code);
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
