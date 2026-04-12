/**
 * First-run config bootstrap for the OpenClaw adapter.
 *
 * Priority for producing the initial ~/.frogcode/openclaw/config/openclaw.json:
 *   1. If the user has an existing ~/.openclaw/openclaw.json (from the
 *      standalone openclaw CLI), copy it and rewrite paths so extensions,
 *      workspace, and plugin-install metadata all live under frogcode's
 *      own stateDir rather than the global ~/.openclaw.
 *   2. Otherwise, fall back to openclaw-template.json — a copy of
 *      E:/Claude/frogcode/openclaw.json.template bundled into the sidecar
 *      via the prebuild script.
 *
 * Path rewriting is greedy but distinctive: every string value containing
 * `\.openclaw\` or `/.openclaw/` has that segment replaced with the
 * equivalent `\.frogcode\openclaw\state\`. `plugins.load.paths` is then
 * collapsed to a single entry pointing at the new extensions dir —
 * openclaw auto-discovers plugins inside it, matching nexu's convention.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// Import the template as JSON at build time. This file is refreshed from
// the repo-root openclaw.json.template by the sidecar's prebuild script.
import openclawTemplate from './openclaw-template.json';

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const LEGACY_CONFIG_PATH = path.join(HOME, '.openclaw', 'openclaw.json');

function log(level: string, ...parts: any[]) {
  const msg = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  process.stderr.write(`[openclaw-migrate ${level}] ${msg}\n`);
}

/**
 * Rewrite any `\.openclaw\` or `/.openclaw/` substring inside `s` to point
 * at frogcode's state dir. Preserves the original path separator style
 * (Windows backslashes vs Unix forward slashes).
 */
function rewritePathString(s: string): string {
  // Match: <some prefix><sep>.openclaw<sep><rest>
  // Capture the two separators so we preserve the input's style.
  return s.replace(/([\\/])\.openclaw([\\/])/g, (_m, sepBefore: string, sepAfter: string) => {
    // Use sepBefore as the separator for all three new path segments
    return `${sepBefore}.frogcode${sepBefore}openclaw${sepBefore}state${sepAfter}`;
  });
}

/** Walk an arbitrary JSON value and apply `fn` to every string leaf. */
function walkStrings(value: any, fn: (s: string) => string): any {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => walkStrings(v, fn));
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value)) {
      out[k] = walkStrings(value[k], fn);
    }
    return out;
  }
  return value;
}

/**
 * Read the user's standalone-openclaw config if present. Returns the parsed
 * object or null if the file doesn't exist / is unreadable. Never throws.
 */
function loadLegacyConfig(): Record<string, any> | null {
  try {
    if (!fs.existsSync(LEGACY_CONFIG_PATH)) return null;
    const raw = fs.readFileSync(LEGACY_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      log('info', `found legacy config at ${LEGACY_CONFIG_PATH}`);
      return parsed;
    }
    return null;
  } catch (e: any) {
    log('warn', `failed to load legacy config: ${e.message}`);
    return null;
  }
}

/**
 * Apply frogcode-specific fixups to a config object in-place:
 *   - Rewrite all `.openclaw` path segments to `.frogcode/openclaw/state`
 *   - Collapse `plugins.load.paths` to a single entry pointing at
 *     frogcode's extensionsDir (discovery-based, matches nexu)
 *   - Normalize `agents.defaults.workspace` to the new state/workspace
 *   - Strip `plugins.installs` (stale metadata tied to the old extensions
 *     dir on disk — openclaw will rebuild it as it discovers plugins)
 *   - Force `gateway.port` to frogcode's port so we never collide with a
 *     standalone openclaw install on the same machine
 */
function applyFrogcodeFixups(
  config: Record<string, any>,
  stateDir: string,
  extensionsDir: string,
  port: number,
): Record<string, any> {
  // 1. Walk every string leaf and rewrite `.openclaw` path segments.
  const rewritten = walkStrings(config, rewritePathString) as Record<string, any>;

  // 2. Collapse plugins.load.paths to a single discovery directory.
  if (rewritten.plugins && typeof rewritten.plugins === 'object') {
    rewritten.plugins.load = rewritten.plugins.load || {};
    rewritten.plugins.load.paths = [extensionsDir];

    // 3. Drop plugins.installs — install metadata references file paths at
    //    the old location. Letting openclaw re-scan extensionsDir is
    //    safer than fudging the metadata.
    if ('installs' in rewritten.plugins) {
      delete rewritten.plugins.installs;
    }
  }

  // 4. Force workspace to live under the new stateDir.
  if (rewritten.agents?.defaults) {
    rewritten.agents.defaults.workspace = path.join(stateDir, 'workspace');
  }

  // 5. Drop meta.lastTouchedVersion — openclaw will write its own.
  if (rewritten.meta) {
    delete rewritten.meta.lastTouchedVersion;
    if (Object.keys(rewritten.meta).length === 0) delete rewritten.meta;
  }

  // 6. Force gateway.port to our own so we never collide with the globally
  //    installed standalone openclaw (which defaults to 18789 and often
  //    runs as a Windows scheduled task).
  rewritten.gateway = rewritten.gateway || {};
  rewritten.gateway.port = port;

  return rewritten;
}

/**
 * Build the initial config for frogcode's OpenClaw adapter. Tries the
 * user's legacy ~/.openclaw/openclaw.json first, then falls back to the
 * bundled template. Always returns a valid object.
 */
export function initialConfig(
  stateDir: string,
  extensionsDir: string,
  port: number,
): Record<string, any> {
  log('info', 'bootstrapping from bundled openclaw-template.json');
  const clone = JSON.parse(JSON.stringify(openclawTemplate));
  return applyFrogcodeFixups(clone, stateDir, extensionsDir, port);
}
