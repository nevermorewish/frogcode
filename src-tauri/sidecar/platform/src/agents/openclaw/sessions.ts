/**
 * OpenClaw session history reader.
 *
 * OpenClaw gateway writes conversation history as JSONL files at:
 *   {stateDir}/agents/{botId}/sessions/{sessionKey}.jsonl
 *   {stateDir}/agents/{botId}/sessions/{sessionKey}.meta.json
 *
 * Schema (per-line entry in .jsonl):
 *   { "type": "message", "id": "...", "timestamp": "2026-04-08T...",
 *     "message": { "role": "user"|"assistant", "content": string|blocks[], "timestamp": number } }
 *
 * This module only READS — we never write to these files. OpenClaw manages them.
 * Ported from nexu/sessions-runtime.ts (simplified, ~200 lines vs 1300).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types exposed to frontend
// ---------------------------------------------------------------------------

export interface SessionSummary {
  /** filename without extension (e.g. "feishu:chat_id:user_id") */
  id: string;
  /** openclaw bot directory name */
  botId: string;
  /** session key parsed from filename */
  sessionKey: string;
  title: string;
  channelType: string | null;
  channelId: string | null;
  status: string;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: unknown; // string | content blocks
  createdAt: string | null;
  timestamp: number | null;
}

export interface SessionDetail {
  summary: SessionSummary;
  messages: ChatMessage[];
}

// ---------------------------------------------------------------------------
// Metadata file I/O
// ---------------------------------------------------------------------------

interface RawMeta {
  title?: string;
  channelType?: string | null;
  channelId?: string | null;
  status?: string;
  messageCount?: number;
  lastMessageAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

function metaPath(jsonlPath: string): string {
  return jsonlPath.replace(/\.jsonl$/, '.meta.json');
}

function readMeta(jsonlPath: string): RawMeta {
  try {
    const raw = fs.readFileSync(metaPath(jsonlPath), 'utf8');
    return JSON.parse(raw) as RawMeta;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// JSONL message reader
// ---------------------------------------------------------------------------

function readMessages(jsonlPath: string, limit = Number.POSITIVE_INFINITY): ChatMessage[] {
  let raw: string;
  try {
    raw = fs.readFileSync(jsonlPath, 'utf8');
  } catch {
    return [];
  }

  const messages: ChatMessage[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        id?: string;
        timestamp?: string;
        message?: { role?: string; content?: unknown; timestamp?: number };
      };
      if (entry.type !== 'message' || !entry.message) continue;
      const role = entry.message.role;
      if (role !== 'user' && role !== 'assistant') continue;

      messages.push({
        id: entry.id ?? '',
        role,
        content: entry.message.content ?? '',
        createdAt: entry.timestamp ?? null,
        timestamp: entry.message.timestamp ?? null,
      });
    } catch {
      // skip malformed lines
    }
  }

  if (limit !== Number.POSITIVE_INFINITY && limit > 0) {
    return messages.slice(-limit);
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function defaultStateDir(): string {
  return path.join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.frogcode',
    'openclaw',
  );
}

/**
 * List all sessions across all bots under {stateDir}/agents/.
 * Returns summaries sorted by updatedAt descending.
 */
export function listSessions(stateDir?: string): SessionSummary[] {
  const agentsDir = path.join(stateDir || defaultStateDir(), 'agents');

  let botDirs: string[];
  try {
    botDirs = fs
      .readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const sessions: SessionSummary[] = [];

  for (const botId of botDirs) {
    const sessionsDir = path.join(agentsDir, botId, 'sessions');
    let files: string[];
    try {
      files = fs
        .readdirSync(sessionsDir, { withFileTypes: true })
        .filter((f) => f.isFile() && f.name.endsWith('.jsonl'))
        .map((f) => f.name);
    } catch {
      continue;
    }

    for (const fileName of files) {
      const filePath = path.join(sessionsDir, fileName);
      const sessionKey = fileName.replace(/\.jsonl$/, '');

      let stats: fs.Stats;
      try {
        stats = fs.statSync(filePath);
      } catch {
        continue;
      }

      const meta = readMeta(filePath);
      const messages = readMessages(filePath); // full read for accurate count
      const lastMsg = messages[messages.length - 1];

      sessions.push({
        id: fileName,
        botId,
        sessionKey,
        title: meta.title || sessionKey,
        channelType: meta.channelType ?? null,
        channelId: meta.channelId ?? null,
        status: meta.status ?? 'active',
        messageCount: messages.length,
        lastMessageAt: lastMsg?.createdAt ?? stats.mtime.toISOString(),
        createdAt: meta.createdAt ?? stats.birthtime.toISOString(),
        updatedAt: meta.updatedAt ?? stats.mtime.toISOString(),
      });
    }
  }

  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Read one session including all messages.
 * `id` is the .jsonl filename (e.g. "feishu:xxx:yyy.jsonl").
 */
export function getSession(id: string, stateDir?: string): SessionDetail | null {
  const all = listSessions(stateDir);
  const summary = all.find((s) => s.id === id);
  if (!summary) return null;

  const filePath = path.join(
    stateDir || defaultStateDir(),
    'agents',
    summary.botId,
    'sessions',
    id,
  );
  const messages = readMessages(filePath);
  return { summary, messages };
}
