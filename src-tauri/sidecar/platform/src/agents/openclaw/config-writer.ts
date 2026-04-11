/**
 * OpenClawConfigWriter — atomic, deduped config writer.
 *
 * Ported from nexu/apps/controller/src/runtime/openclaw-config-writer.ts
 * with weixin-account sync removed and zod validation dropped (the content
 * is now sourced from the user's existing config or openclaw.json.template,
 * both of which are trusted inputs written by openclaw itself).
 *
 * Responsibilities:
 *   1. Cache the last written content so no-op writes don't trigger openclaw's
 *      file watcher (which would otherwise cause spurious hybrid reloads).
 *   2. Seed the cache from disk on cold start so the first write() after a
 *      sidecar restart is correctly identified as unchanged.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

function log(level: string, ...parts: any[]) {
  const msg = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  process.stderr.write(`[openclaw-writer ${level}] ${msg}\n`);
}

export class OpenClawConfigWriter {
  /** Last content successfully written — used to skip redundant writes. */
  private lastWrittenContent: string | null = null;

  constructor(private readonly configPath: string) {}

  /**
   * Stringify and atomically write the config. Returns true if the file was
   * actually written, false if the content was unchanged.
   */
  write(config: unknown): boolean {
    const content = `${JSON.stringify(config, null, 2)}\n`;

    // Seed cache from existing file on first write after process start, so
    // we don't trigger an unnecessary openclaw reload when syncing a config
    // that already matches disk.
    if (this.lastWrittenContent === null) {
      try {
        this.lastWrittenContent = fs.readFileSync(this.configPath, 'utf8');
      } catch {
        // File doesn't exist yet — leave cache empty so the first write goes
        // through.
      }
    }

    if (content === this.lastWrittenContent) {
      log('debug', `write skipped (unchanged) ${this.configPath}`);
      return false;
    }

    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, content, 'utf8');
    this.lastWrittenContent = content;

    log('info', `wrote ${content.length} bytes to ${this.configPath}`);
    return true;
  }

  /** Force the next write() to go through, regardless of cached content. */
  invalidateCache(): void {
    this.lastWrittenContent = null;
  }
}
