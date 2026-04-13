/**
 * CardRenderer — subscribes to AgentEvent and drives Feishu card create/update.
 *
 * Migrated from Rust im_bridge.rs CardState + post_card_to_sidecar (300 lines)
 * into a self-contained TS module. Now runs in-process, one hop fewer.
 *
 * Throttles updates at 300ms to avoid Feishu API rate limits.
 */

import type * as lark from '@larksuiteoapi/node-sdk';
import type { AgentEvent, SessionKey } from './agents/types.js';

// ---------------------------------------------------------------------------
// Card state (one per active chat)
// ---------------------------------------------------------------------------

type CardStatus = 'thinking' | 'running' | 'complete' | 'error';
interface ToolCall {
  name: string;
  detail: string;
  status: 'running' | 'complete';
}

interface CardState {
  status: CardStatus;
  responseText: string;
  toolCalls: ToolCall[];
  errorMessage?: string;
  totalTokens?: number;
  contextWindow?: number;
  costUsd?: number;
  durationMs?: number;
  model?: string;
}

function freshState(): CardState {
  return {
    status: 'thinking',
    responseText: '',
    toolCalls: [],
  };
}

// ---------------------------------------------------------------------------
// Card JSON builder (Feishu interactive card)
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<CardStatus, { color: string; title: string; icon: string }> = {
  thinking: { color: 'blue', title: 'Thinking...', icon: '\u{1F535}' },
  running: { color: 'blue', title: 'Running...', icon: '\u{1F535}' },
  complete: { color: 'green', title: 'Complete', icon: '\u{1F7E2}' },
  error: { color: 'red', title: 'Error', icon: '\u{1F534}' },
};

const MAX_CARD_LEN = 28000;
function truncate(text: string): string {
  if (text.length <= MAX_CARD_LEN) return text;
  const half = Math.floor(MAX_CARD_LEN / 2) - 50;
  return text.slice(0, half) + '\n\n... (truncated) ...\n\n' + text.slice(-half);
}

function buildCardJson(state: CardState): string {
  const cfg = STATUS_CONFIG[state.status];
  const elements: any[] = [];

  if (state.toolCalls.length > 0) {
    const lines = state.toolCalls.map(
      (t) => `${t.status === 'running' ? '\u23F3' : '\u2705'} **${t.name}** ${t.detail}`,
    );
    elements.push({ tag: 'markdown', content: lines.join('\n') });
    elements.push({ tag: 'hr' });
  }

  if (state.responseText) {
    elements.push({ tag: 'markdown', content: truncate(state.responseText) });
  } else if (state.status === 'thinking') {
    elements.push({ tag: 'markdown', content: '_Claude is thinking..._' });
  }

  if (state.errorMessage) {
    elements.push({ tag: 'markdown', content: `**Error:** ${state.errorMessage}` });
  }

  // Stats note footer
  {
    const parts: string[] = [];
    if (state.totalTokens && state.contextWindow) {
      const pct = Math.round((state.totalTokens / state.contextWindow) * 100);
      const tokensK =
        state.totalTokens >= 1000
          ? `${(state.totalTokens / 1000).toFixed(1)}k`
          : `${state.totalTokens}`;
      const ctxK = `${Math.round(state.contextWindow / 1000)}k`;
      parts.push(`ctx: ${tokensK}/${ctxK} (${pct}%)`);
    }
    if ((state.status === 'complete' || state.status === 'error') && state.model) {
      parts.push(state.model.replace(/^claude-/, ''));
    }
    if (state.durationMs !== undefined && (state.status === 'complete' || state.status === 'error')) {
      parts.push(`${(state.durationMs / 1000).toFixed(1)}s`);
    }
    if (state.costUsd !== undefined && (state.status === 'complete' || state.status === 'error')) {
      parts.push(`$${state.costUsd.toFixed(4)}`);
    }
    if (parts.length > 0) {
      elements.push({
        tag: 'note',
        elements: [{ tag: 'plain_text', content: parts.join(' | ') }],
      });
    }
  }

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: cfg.color,
      title: { content: `${cfg.icon} ${cfg.title}`, tag: 'plain_text' },
    },
    elements,
  });
}

/**
 * Extract a plain-text summary from CardState — used as last-resort fallback
 * when interactive card delivery fails completely.
 */
function buildPlainText(state: CardState): string {
  const parts: string[] = [];
  if (state.errorMessage) {
    parts.push(`[Error] ${state.errorMessage}`);
  }
  if (state.responseText) {
    parts.push(state.responseText.slice(0, 4000));
  }
  if (state.toolCalls.length > 0) {
    parts.push(state.toolCalls.map((t) => `[${t.status}] ${t.name} ${t.detail}`).join('\n'));
  }
  if (parts.length === 0 && state.status === 'thinking') {
    parts.push('(thinking...)');
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// CardRenderer
// ---------------------------------------------------------------------------

export interface CardRendererDeps {
  larkClient: lark.Client | null;
}

interface ChatCardState {
  cardState: CardState;
  feishuMessageId: string | null;
  lastFlush: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Feishu message_id of the user's message (for reply-in-thread). */
  replyToMessageId?: string;
  /** User open_id — used as fallback receive_id when chat_id fails. */
  userId?: string;
  /** Emoji reaction on the original message to show "typing". */
  typingReaction?: { messageId: string; reactionId: string };
  /** Guard against concurrent sendCard — wait for this before flushing. */
  createPromise: Promise<string | null> | null;
}

const THROTTLE_MS = 300;

export class CardRenderer {
  private deps: CardRendererDeps;
  private chats = new Map<string, ChatCardState>();

  constructor(deps: CardRendererDeps) {
    this.deps = deps;
  }

  /** Call this when the lark client changes (connect/disconnect). */
  setLarkClient(client: lark.Client | null): void {
    this.deps.larkClient = client;
  }

  /** Check whether a card turn is currently active for a chatId. */
  hasActiveChat(chatId: string): boolean {
    return this.chats.has(chatId);
  }

  /**
   * Begin tracking a new turn for a chat.
   * chatId is the Feishu chat_id; replyToMessageId for thread mode.
   * userId is the sender's open_id — used as fallback when chat_id send fails.
   *
   * If there is already an active (non-finalized) card for this chatId,
   * the call is SKIPPED to prevent orphaning the previous card at "Running".
   * Returns true if a new turn was started, false if skipped.
   */
  begin(chatId: string, replyToMessageId?: string, userId?: string): boolean {
    const existing = this.chats.get(chatId);
    // Guard: if there's already an active card (not finalized), skip
    if (existing && existing.cardState.status !== 'complete' && existing.cardState.status !== 'error') {
      log('warn', `begin: chatId=${chatId.slice(0, 12)} already has active card (${existing.cardState.status}), skipping`);
      return false;
    }
    // Clean up any existing flush timer
    if (existing?.flushTimer) clearTimeout(existing.flushTimer);

    this.chats.set(chatId, {
      cardState: freshState(),
      feishuMessageId: null,
      lastFlush: 0,
      flushTimer: null,
      replyToMessageId,
      userId,
      createPromise: null,
    });
    return true;
  }

  /**
   * Process one AgentEvent. Updates internal state and schedules a Feishu card update.
   */
  async processEvent(chatId: string, evt: AgentEvent): Promise<void> {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    const { cardState } = chat;

    switch (evt.type) {
      case 'system':
        cardState.status = 'running';
        if (evt.model) cardState.model = evt.model;
        break;
      case 'text':
        cardState.status = 'running';
        cardState.responseText += evt.delta;
        break;
      case 'tool_use':
        cardState.status = 'running';
        cardState.toolCalls.push({ name: evt.name, detail: evt.detail, status: 'running' });
        break;
      case 'tool_result': {
        const last = cardState.toolCalls[cardState.toolCalls.length - 1];
        if (last) last.status = 'complete';
        break;
      }
      case 'result':
        if (evt.error) {
          cardState.status = 'error';
          cardState.errorMessage = evt.error;
        } else {
          cardState.status = 'complete';
        }
        if (evt.costUsd !== undefined) cardState.costUsd = evt.costUsd;
        if (evt.durationMs !== undefined) cardState.durationMs = evt.durationMs;
        if (evt.totalTokens !== undefined) cardState.totalTokens = evt.totalTokens;
        if (evt.contextWindow !== undefined) cardState.contextWindow = evt.contextWindow;
        break;
      case 'session':
        // No card change, session persistence handled by AgentManager
        break;
    }

    // Final states flush immediately; in-progress throttled
    const isFinal = cardState.status === 'complete' || cardState.status === 'error';
    if (isFinal) {
      if (chat.flushTimer) {
        clearTimeout(chat.flushTimer);
        chat.flushTimer = null;
      }
      await this.flush(chatId);
      await this.removeTypingReaction(chat);
      this.chats.delete(chatId);
    } else {
      this.scheduleFlush(chatId);
    }
  }

  private scheduleFlush(chatId: string): void {
    const chat = this.chats.get(chatId);
    if (!chat || chat.flushTimer) return;
    const elapsed = Date.now() - chat.lastFlush;
    const delay = Math.max(0, THROTTLE_MS - elapsed);
    chat.flushTimer = setTimeout(async () => {
      chat.flushTimer = null;
      await this.flush(chatId);
    }, delay);
  }

  private async flush(chatId: string): Promise<void> {
    const chat = this.chats.get(chatId);
    if (!chat || !this.deps.larkClient) return;

    // If a sendCard is in flight, wait for it to complete first so we
    // don't create a duplicate card (race between scheduled flush and
    // the immediate final-state flush).
    if (chat.createPromise) {
      await chat.createPromise;
    }

    const content = buildCardJson(chat.cardState);
    chat.lastFlush = Date.now();

    if (!chat.feishuMessageId) {
      // First flush: create card — store the promise so concurrent
      // callers wait instead of creating a second card.
      const p = this.sendCard(chatId, content, chat.replyToMessageId, chat.userId);
      chat.createPromise = p;
      chat.feishuMessageId = await p;
      chat.createPromise = null;

      // Card delivery completely failed — fall back to plain text so the
      // user always gets a response in Feishu no matter what.
      if (!chat.feishuMessageId) {
        const plainText = buildPlainText(chat.cardState);
        if (plainText) {
          await this.sendPlainText(chatId, plainText, chat.replyToMessageId, chat.userId);
        }
      }
    } else {
      // Update existing card
      await this.updateCard(chat.feishuMessageId, content);
    }
  }

  // ─── Feishu API helpers ─────────────────────────────────────────────────

  private async sendCard(
    chatId: string,
    content: string,
    replyToMessageId?: string,
    userId?: string,
  ): Promise<string | null> {
    const client = this.deps.larkClient;
    if (!client) return null;
    try {
      // 1. Try reply to the original message
      if (replyToMessageId) {
        try {
          const resp = await (client as any).im.v1.message.reply({
            path: { message_id: replyToMessageId },
            data: { content, msg_type: 'interactive', reply_in_thread: false },
          });
          const mid = resp?.data?.message_id;
          if (mid) return mid;
        } catch {
          // fallback to create
        }
      }
      // 2. Try create with chat_id
      try {
        const resp = await client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, content, msg_type: 'interactive' },
        });
        const mid = (resp as any)?.data?.message_id;
        if (mid) return mid;
      } catch (err: any) {
        log('warn', `sendCard chat_id failed: ${err.message?.slice(0, 120)}`);
      }
      // 3. Fallback: try create with open_id (P2P chats where bot is "not in chat")
      if (userId) {
        try {
          const resp = await client.im.v1.message.create({
            params: { receive_id_type: 'open_id' },
            data: { receive_id: userId, content, msg_type: 'interactive' },
          });
          const mid = (resp as any)?.data?.message_id;
          if (mid) {
            log('info', 'sendCard succeeded via open_id fallback');
            return mid;
          }
        } catch (err: any) {
          log('error', `sendCard open_id fallback failed: ${err.message?.slice(0, 120)}`);
        }
      }
      return null;
    } catch (err: any) {
      log('error', 'sendCard:', err.message);
      return null;
    }
  }

  /**
   * Last-resort plain text delivery when all card methods fail.
   * Tries: reply → chat_id text → open_id text.
   */
  private async sendPlainText(
    chatId: string,
    text: string,
    replyToMessageId?: string,
    userId?: string,
  ): Promise<void> {
    const client = this.deps.larkClient;
    if (!client) return;
    const content = JSON.stringify({ text });

    // 1. reply
    if (replyToMessageId) {
      try {
        const resp = await (client as any).im.v1.message.reply({
          path: { message_id: replyToMessageId },
          data: { content, msg_type: 'text', reply_in_thread: false },
        });
        if (resp?.data?.message_id) { log('info', 'plainText reply succeeded'); return; }
      } catch {}
    }
    // 2. chat_id
    try {
      const resp = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, content, msg_type: 'text' },
      });
      if ((resp as any)?.data?.message_id) { log('info', 'plainText chat_id succeeded'); return; }
    } catch {}
    // 3. open_id
    if (userId) {
      try {
        const resp = await client.im.v1.message.create({
          params: { receive_id_type: 'open_id' },
          data: { receive_id: userId, content, msg_type: 'text' },
        });
        if ((resp as any)?.data?.message_id) { log('info', 'plainText open_id succeeded'); return; }
      } catch {}
    }
    log('error', `ALL delivery methods failed for chat=${chatId.slice(0, 12)}`);
  }

  private async updateCard(messageId: string, content: string): Promise<void> {
    const client = this.deps.larkClient;
    if (!client) return;
    try {
      await client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content },
      });
    } catch (err: any) {
      log('error', 'updateCard:', err.message);
    }
  }

  // ─── Typing reaction ───────────────────────────────────────────────────

  async addTypingReaction(chatId: string, messageId: string): Promise<void> {
    const client = this.deps.larkClient;
    const chat = this.chats.get(chatId);
    if (!client || !chat) return;
    try {
      const resp = await (client as any).im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: 'THUMBSUP' } },
      });
      const reactionId = resp?.data?.reaction_id;
      if (reactionId) {
        chat.typingReaction = { messageId, reactionId };
      }
    } catch {
      // best effort
    }
  }

  private async removeTypingReaction(chat: ChatCardState): Promise<void> {
    const client = this.deps.larkClient;
    if (!client || !chat.typingReaction) return;
    try {
      await (client as any).im.v1.messageReaction.delete({
        path: {
          message_id: chat.typingReaction.messageId,
          reaction_id: chat.typingReaction.reactionId,
        },
      });
    } catch {
      // best effort
    }
  }

  async shutdown(): Promise<void> {
    for (const chat of this.chats.values()) {
      if (chat.flushTimer) clearTimeout(chat.flushTimer);
    }
    this.chats.clear();
  }
}

// ---------------------------------------------------------------------------
// Logger (stderr, same as existing sidecar pattern)
// ---------------------------------------------------------------------------

function log(level: string, ...parts: any[]) {
  const msg = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  process.stderr.write(`[card-renderer ${level}] ${msg}\n`);
}
