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
  /** Emoji reaction on the original message to show "typing". */
  typingReaction?: { messageId: string; reactionId: string };
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

  /**
   * Begin tracking a new turn for a chat.
   * chatId is the Feishu chat_id; replyToMessageId for thread mode.
   */
  begin(chatId: string, replyToMessageId?: string): void {
    // Clean up any existing flush timer
    const existing = this.chats.get(chatId);
    if (existing?.flushTimer) clearTimeout(existing.flushTimer);

    this.chats.set(chatId, {
      cardState: freshState(),
      feishuMessageId: null,
      lastFlush: 0,
      flushTimer: null,
      replyToMessageId,
    });
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

    const content = buildCardJson(chat.cardState);
    chat.lastFlush = Date.now();

    if (!chat.feishuMessageId) {
      // First flush: create card
      chat.feishuMessageId = await this.sendCard(chatId, content, chat.replyToMessageId);
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
  ): Promise<string | null> {
    const client = this.deps.larkClient;
    if (!client) return null;
    try {
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
      const resp = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, content, msg_type: 'interactive' },
      });
      return (resp as any)?.data?.message_id ?? null;
    } catch (err: any) {
      log('error', 'sendCard:', err.message);
      return null;
    }
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
