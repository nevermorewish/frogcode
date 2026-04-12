/**
 * AgentManager — routes (platform, channelId, userId) messages to AgentSession.
 *
 * Responsibilities:
 *  - Lazily create one AgentSession per SessionKey
 *  - Map CLI-native session ids to persistent storage (for resume across restarts)
 *  - Fan out AgentEvent to subscribers (card renderer, logger, ...)
 *  - Tear down on cancel/reset/shutdown
 *
 * One AgentManager instance per sidecar. The agent type is chosen at construction
 * time from config (`agentType` field) and cannot be swapped per-session in v1
 * — matches cc-connect's "one project = one agent" constraint.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  Agent,
  AgentEvent,
  AgentSession,
  AgentType,
  SendOpts,
  SessionKey,
} from './types.js';
import { makeSessionKey } from './types.js';

// ---------------------------------------------------------------------------
// Persistence — session id lookup across sidecar restarts
// ---------------------------------------------------------------------------

const sessionsDir = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.frogcode',
  'platform-sessions',
);

interface StoredSession {
  sessionId: string;
  lastUsed: number;
}

function sessionFile(key: SessionKey): string {
  return path.join(sessionsDir, `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

export function loadStoredSession(key: SessionKey): string | null {
  try {
    const p = sessionFile(key);
    if (!fs.existsSync(p)) return null;
    const data: StoredSession = JSON.parse(fs.readFileSync(p, 'utf8'));
    // 24h TTL
    if (Date.now() - data.lastUsed > 24 * 60 * 60 * 1000) {
      fs.unlinkSync(p);
      return null;
    }
    return data.sessionId;
  } catch {
    return null;
  }
}

export function saveStoredSession(key: SessionKey, sessionId: string): void {
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      sessionFile(key),
      JSON.stringify({ sessionId, lastUsed: Date.now() }),
    );
  } catch {
    // best effort
  }
}

export function deleteStoredSession(key: SessionKey): void {
  try {
    const p = sessionFile(key);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// AgentManager
// ---------------------------------------------------------------------------

export interface HandleMessageOpts {
  platform: string;      // "feishu"
  channelId: string;     // chat id
  userId: string;        // sender open_id
  cwd: string;           // project path
  prompt: string;
  files?: string[];
}

export type AgentEventListener = (key: SessionKey, evt: AgentEvent) => void;

export class AgentManager {
  private readonly agent: Agent;
  private readonly sessions = new Map<SessionKey, AgentSession>();
  private readonly bus = new EventEmitter();

  constructor(agent: Agent) {
    this.agent = agent;
    this.bus.setMaxListeners(50);
  }

  get agentName(): AgentType {
    return this.agent.name;
  }

  /** Expose the underlying Agent instance for status/introspection. */
  getAgent(): Agent {
    return this.agent;
  }

  onEvent(listener: AgentEventListener): () => void {
    const wrapped = (key: SessionKey, evt: AgentEvent) => listener(key, evt);
    this.bus.on('agent-event', wrapped);
    return () => this.bus.off('agent-event', wrapped);
  }

  /**
   * Handle an incoming user message from a platform. Creates a session on demand.
   * Returns immediately; events flow asynchronously through the bus.
   */
  async handle(opts: HandleMessageOpts): Promise<SessionKey> {
    const key = makeSessionKey(opts.platform, opts.channelId, opts.userId);

    let session = this.sessions.get(key);
    if (!session) {
      const resumeSessionId = loadStoredSession(key);
      session = await this.agent.startSession({
        cwd: opts.cwd,
        resumeSessionId,
        sessionKey: key,
      });
      this.sessions.set(key, session);

      // Wire the session's event emitter to the manager bus
      session.events().on('event', (evt: AgentEvent) => {
        // Persist CLI-native session id as soon as we see it
        if (evt.type === 'session') {
          saveStoredSession(key, evt.sessionId);
        }
        this.bus.emit('agent-event', key, evt);
      });
      session.events().on('close', () => {
        // Keep the session entry around — CLIs like Claude Code can resume later.
        // We only drop it if explicitly reset() or the CLI reports a fatal error.
      });
    }

    await session.send({ prompt: opts.prompt, files: opts.files });
    return key;
  }

  async cancel(key: SessionKey): Promise<void> {
    const session = this.sessions.get(key);
    if (session) await session.cancel();
  }

  /**
   * Reset a chat's session: stops the current AgentSession, deletes persisted
   * CLI session id, and drops the in-memory entry. Next message will start fresh.
   */
  async reset(key: SessionKey): Promise<void> {
    const session = this.sessions.get(key);
    if (session) {
      await session.close();
      this.sessions.delete(key);
    }
    deleteStoredSession(key);
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      try {
        await session.close();
      } catch {
        // ignore
      }
    }
    this.sessions.clear();
    await this.agent.stop();
    this.bus.removeAllListeners();
  }
}
