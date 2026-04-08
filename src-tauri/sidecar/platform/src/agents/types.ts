/**
 * Agent abstraction — mirrors cc-connect's core/interfaces.go Agent/AgentSession.
 *
 * An Agent represents a CLI backend (claudecode, openclaw, ...).
 * An AgentSession is a live conversation with that backend for one (platform,channel,user) triple.
 *
 * All UI layers (card renderer, stats, tool list) consume AgentEvent — they never
 * need to know which CLI is underneath. Adding a new CLI = one file implementing Agent.
 */

import type { EventEmitter } from 'node:events';

export type AgentType = 'claudecode' | 'openclaw';

/**
 * Session key format: "platform:channelId:userId" (cc-connect core/message.go:131).
 * - platform: "feishu" | "wecom" | ...
 * - channelId: Feishu chat_id / Slack channel / ...
 * - userId: sender open_id / user id
 *
 * Two users in the same group chat get independent sessions.
 */
export type SessionKey = string;

export function makeSessionKey(platform: string, channelId: string, userId: string): SessionKey {
  return `${platform}:${channelId}:${userId}`;
}

export interface StartSessionOpts {
  /** Working directory for the CLI (project root). */
  cwd: string;
  /** Previously persisted CLI-native session id to resume, if any. */
  resumeSessionId?: string | null;
  /** Unique key identifying this platform:channel:user triple. */
  sessionKey: SessionKey;
}

export interface SendOpts {
  /** User prompt text (already stripped of @mentions). */
  prompt: string;
  /** Local file paths to attach (images, documents). */
  files?: string[];
}

/**
 * One live conversation with a CLI backend.
 * Emits AgentEvent on the `events` EventEmitter until `close()` is called.
 */
export interface AgentSession {
  readonly sessionKey: SessionKey;

  /** Send a user message; events are fired on the events() emitter until the CLI finishes one turn. */
  send(opts: SendOpts): Promise<void>;

  /** Request cancellation of the current in-flight turn (if any). */
  cancel(): Promise<void>;

  /** CLI-native session id, populated after the first `session` event. null before then. */
  currentSessionId(): string | null;

  /** Event emitter. Listen on 'event' for AgentEvent, 'close' when session is done. */
  events(): EventEmitter;

  /** Fully close the session and release resources. */
  close(): Promise<void>;
}

/**
 * Factory for a CLI backend. One Agent instance is created per sidecar startup;
 * it produces AgentSession per (platform:channel:user).
 */
export interface Agent {
  readonly name: AgentType;

  /** Start a new session (or prepare to resume one). */
  startSession(opts: StartSessionOpts): Promise<AgentSession>;

  /** Stop the agent and all its sessions. Called on sidecar shutdown. */
  stop(): Promise<void>;
}

/**
 * Normalized event stream. Every Agent must emit these types regardless of
 * the underlying wire protocol (Claude stream-json, OpenClaw WS JSON-RPC, ...).
 */
export type AgentEvent =
  | { type: 'system'; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; name: string; detail: string }
  | { type: 'tool_result'; ok: boolean }
  | {
      type: 'result';
      costUsd?: number;
      durationMs?: number;
      totalTokens?: number;
      contextWindow?: number;
      error?: string;
    }
  | { type: 'session'; sessionId: string };
