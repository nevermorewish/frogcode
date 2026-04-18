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
  private logStream: fs.WriteStream | null = null;
  private logTail: string[] = [];
  private readonly logPath: string;
  /** Terminal error from the last spawn attempt. Cleared by start(). */
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
   * Human-readable error from the last spawn attempt (e.g. "port in use"),
   * or null if the process is running or hasn't been started. Cleared at
   * the top of start(), populated from stderr on exit.
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

  /**
   * Spawn the openclaw gateway. ONE-SHOT — no automatic restart on failure.
   * If the process dies, it stays dead. The user can hit Start again from
   * the OpenClaw Sessions view (which goes through ensureGateway and
   * constructs a fresh ProcessManager).
   */
  start(): void {
    if (this.child && !this.child.killed) return;

    // Clear any previous fatal state — fresh attempt.
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

    // Clean up stale gateway lock files left by crashed openclaw processes.
    // openclaw writes lock files to %TEMP%/openclaw/gateway.*.lock (or $TMPDIR)
    // and checks them on startup — stale locks cause false "already running" errors.
    cleanStaleLockFiles(this.config.tmpDir, (msg) => this.writeLog('info', msg));

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
    const spawnStartedAt = Date.now();

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
      const uptime = Date.now() - spawnStartedAt;
      this.writeLog('info', `exited code=${code} uptime=${uptime}ms`);
      this.child = null;
      clearPidFile(this.config.stateDir);

      // Populate fatalError from stderr so the UI banner can surface the
      // actual cause (port conflict, missing bin, etc). No auto-restart —
      // one shot, stays dead.
      const hint = this.extractFailureHint();
      this.fatalError =
        hint ?? `openclaw gateway exited with code ${code} after ${uptime}ms`;
      this.writeLog('error', `stopped: ${this.fatalError}`);
      this.emit('exit', code);
    });

    child.on('error', (err) => {
      this.writeLog('error', `spawn error: ${err.message}`);
      this.child = null;
      this.fatalError = err.message;
      this.emit('error', err);
    });
  }

  async stop(): Promise<void> {
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
          `You can also change frogcode's gatewayPort in ~/.frogcode/agents/openclaw.json.`
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
        return `openclaw binary not found — check binPath in ~/.frogcode/agents/openclaw.json`;
      }
    }
    return null;
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
 * Find the PID holding a TCP port and kill it. Cross-platform:
 *   - Windows: netstat -ano → taskkill /f /t
 *   - Unix:    lsof -ti → SIGKILL
 * Returns true if a process was killed.
 */
export function killProcessOnPort(
  port: number,
  logFn: (msg: string) => void,
): boolean {
  const { execSync } = require('node:child_process') as typeof import('node:child_process');

  let pids: number[] = [];

  try {
    if (process.platform === 'win32') {
      // netstat output: "  TCP    0.0.0.0:18789    0.0.0.0:0    LISTENING    1234"
      const out = execSync(`netstat -ano | findstr :${port}`, {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      for (const line of out.split('\n')) {
        if (/LISTENING/i.test(line)) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[parts.length - 1], 10);
          if (pid > 0 && !pids.includes(pid)) pids.push(pid);
        }
      }
    } else {
      // Unix: try lsof → ss → fuser in order. `lsof` is absent on minimal
      // Linux containers (we saw this bite us on gpufree) so we must have
      // fallbacks. Any tool that returns one or more PIDs short-circuits.
      const tryCollect = (cmd: string, parse: (stdout: string) => number[]): boolean => {
        try {
          const out = execSync(cmd, { encoding: 'utf8', timeout: 5000 });
          for (const pid of parse(out)) {
            if (pid > 0 && !pids.includes(pid)) pids.push(pid);
          }
          return pids.length > 0;
        } catch {
          return false; // command missing OR no match — try next
        }
      };

      const parseOnePerLine = (s: string): number[] =>
        s.split('\n').map((l) => parseInt(l.trim(), 10)).filter((n) => n > 0);

      const parseSs = (s: string): number[] => {
        // ss -lntpH output (one listener per line):
        //   LISTEN 0 511 0.0.0.0:18789 0.0.0.0:* users:(("openclaw-gatewa",pid=124285,fd=21))
        const out: number[] = [];
        for (const line of s.split('\n')) {
          const m = line.match(/pid=(\d+)/);
          if (m) out.push(parseInt(m[1], 10));
        }
        return out;
      };

      if (!tryCollect(`lsof -ti :${port} 2>/dev/null`, parseOnePerLine)) {
        if (!tryCollect(`ss -lntpH 'sport = :${port}' 2>/dev/null`, parseSs)) {
          tryCollect(`fuser -n tcp ${port} 2>/dev/null`, parseOnePerLine);
        }
      }
    }
  } catch {
    // Nothing worked — fall through; caller decides what to do
    return false;
  }

  if (pids.length === 0) return false;

  for (const pid of pids) {
    logFn(`killing process pid=${pid} occupying port ${port}`);
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /f /t /pid ${pid}`, {
          stdio: 'ignore',
          timeout: 5000,
          windowsHide: true,
        });
      } else {
        // Enumerate direct children (pgrep exits 1 when none → swallow)
        let childPids: number[] = [];
        try {
          const out = execSync(`pgrep -P ${pid}`, { encoding: 'utf8', timeout: 3000 });
          childPids = out.split(/\s+/).map((s) => parseInt(s, 10)).filter((n) => n > 0);
        } catch { /* no children */ }
        try { process.kill(-pid, 'SIGKILL'); } catch { /* group gone */ }
        for (const cpid of childPids) {
          try { process.kill(cpid, 'SIGKILL'); } catch { /* gone */ }
        }
        try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      }
    } catch (e: any) {
      logFn(`failed to kill pid=${pid}: ${e.message}`);
    }
  }

  // Brief wait for port release
  try {
    execSync(
      process.platform === 'win32'
        ? 'timeout /t 2 /nobreak > nul'
        : 'sleep 1',
      { stdio: 'ignore', timeout: 5000 },
    );
  } catch { /* ignore */ }

  return true;
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

  // Alive — kill it.
  // On Linux, `openclaw` is a CLI wrapper that spawns the actual
  // `openclaw-gateway` binary in a separate process group. SIGKILL'ing just
  // the wrapper leaves the gateway child reparented to init, still bound to
  // port 18789 — exactly the "port in use" zombie we keep seeing. Kill the
  // whole process group (`kill(-pid)`) plus any direct children via pgrep,
  // so no descendant survives.
  logFn(`reaping orphan openclaw pid=${pid} from previous run`);
  try {
    if (process.platform === 'win32') {
      // Windows: taskkill /f /t walks the whole tree
      require('node:child_process').execSync(`taskkill /f /t /pid ${pid}`, {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      const { execSync } = require('node:child_process') as typeof import('node:child_process');
      // First enumerate descendants via pgrep -P (direct children); openclaw
      // only nests one level deep, so this is sufficient.
      let childPids: number[] = [];
      try {
        const out = execSync(`pgrep -P ${pid}`, { encoding: 'utf8', timeout: 3000 });
        childPids = out.split(/\s+/).map((s) => parseInt(s, 10)).filter((n) => n > 0);
      } catch { /* pgrep exits 1 when no children — fine */ }

      // Kill the whole process group (covers children that joined the group)
      try { process.kill(-pid, 'SIGKILL'); } catch { /* group may not exist */ }
      // Then SIGKILL each enumerated child directly, in case they escaped the group
      for (const cpid of childPids) {
        try { process.kill(cpid, 'SIGKILL'); } catch { /* already gone */ }
      }
      // Finally, the tracked pid itself
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
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

/**
 * Remove stale gateway lock files whose owning PID is no longer alive.
 * openclaw writes `gateway.<hash>.lock` containing `{"pid":…}` into its
 * temp directory. If the process crashes without cleanup, the lock file
 * persists and the next `openclaw gateway run` refuses to start with
 * "gateway already running" / "Gateway service appears registered".
 *
 * We scan both the configured tmpDir and the OS default temp location
 * (`%TEMP%/openclaw` on Windows, `/tmp/openclaw` elsewhere).
 */
function cleanStaleLockFiles(tmpDir: string, logFn: (msg: string) => void): void {
  const osTmpOpenClaw = path.join(
    process.env.TEMP || process.env.TMPDIR || '/tmp',
    'openclaw',
  );
  const dirs = [tmpDir, osTmpOpenClaw];
  // Deduplicate (tmpDir may already point to the OS temp location)
  const seen = new Set<string>();

  for (const dir of dirs) {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    let entries: string[];
    try {
      entries = fs.readdirSync(resolved);
    } catch {
      continue; // dir doesn't exist
    }

    for (const entry of entries) {
      if (!entry.startsWith('gateway.') || !entry.endsWith('.lock')) continue;
      const lockPath = path.join(resolved, entry);
      try {
        const raw = fs.readFileSync(lockPath, 'utf8');
        const data = JSON.parse(raw);
        const pid = data?.pid;
        if (typeof pid !== 'number' || pid <= 0) continue;

        // Check if the process is still alive
        try {
          process.kill(pid, 0);
          // Process alive — leave it alone
        } catch {
          // Process dead — remove stale lock
          fs.unlinkSync(lockPath);
          logFn(`removed stale lock ${entry} (pid=${pid} dead)`);
        }
      } catch {
        // Malformed lock file — remove it
        try {
          fs.unlinkSync(lockPath);
          logFn(`removed malformed lock ${entry}`);
        } catch { /* ignore */ }
      }
    }
  }
}
