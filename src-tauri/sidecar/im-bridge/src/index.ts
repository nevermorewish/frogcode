#!/usr/bin/env node
/**
 * Frogcode IM Bridge Sidecar
 *
 * Bridges Feishu (飞书) messages to Claude Code via the `claude` CLI binary
 * (stream-json output, same approach as frogcode's main backend).
 * Exposes HTTP + SSE for the Rust parent to manage lifecycle and receive events.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
// child_process not needed — Claude execution delegated to Rust parent
import { EventEmitter } from 'node:events';
import * as lark from '@larksuiteoapi/node-sdk';

// ============================================================================
// CLI args
// ============================================================================
function parseArgs(argv: string[]) {
  const out = { port: 0, config: '' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = parseInt(argv[++i], 10) || 0;
    else if (argv[i] === '--config') out.config = argv[++i];
  }
  return out;
}
const args = parseArgs(process.argv);

// ============================================================================
// Logger
// ============================================================================
function log(level: string, ...parts: any[]) {
  const msg = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  process.stderr.write(`[sidecar ${level}] ${msg}\n`);
}

// ============================================================================
// Event Bus (SSE fan-out)
// ============================================================================
const bus = new EventEmitter();
bus.setMaxListeners(50);

// ============================================================================
// State
// ============================================================================
const startedAt = Date.now();

interface FeishuConfig {
  appId: string;
  appSecret: string;
  projectPath: string;
  enabled: boolean;
}

let currentConfig: FeishuConfig | null = null;
let feishuStatus: 'stopped' | 'starting' | 'running' | 'error' = 'stopped';
let feishuError: string | null = null;
let larkClient: lark.Client | null = null;
let wsClient: lark.WSClient | null = null;
let botOpenId: string | null = null;

// (Claude execution now happens in Rust parent; no per-chat state here)

// ============================================================================
// Config I/O
// ============================================================================
function loadConfig(configPath: string): FeishuConfig | null {
  if (!configPath) return null;
  try {
    if (!fs.existsSync(configPath)) return null;
    const raw = fs.readFileSync(configPath, 'utf8');
    const cfg = JSON.parse(raw);
    return {
      appId: cfg.appId || cfg.app_id || '',
      appSecret: cfg.appSecret || cfg.app_secret || '',
      projectPath: cfg.projectPath || cfg.project_path || '',
      enabled: !!cfg.enabled,
    };
  } catch (e: any) {
    log('warn', 'Failed to load config:', e.message);
    return null;
  }
}

// ============================================================================
// Session Manager
// ============================================================================
const sessionsDir = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.anycode',
  'im-sessions',
);

interface SessionData {
  sessionId: string;
  lastUsed: number;
}

function getSessionPath(chatId: string): string {
  return path.join(sessionsDir, `${chatId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

function loadSession(chatId: string): SessionData | null {
  try {
    const p = getSessionPath(chatId);
    if (!fs.existsSync(p)) return null;
    const data: SessionData = JSON.parse(fs.readFileSync(p, 'utf8'));
    // 24h TTL
    if (Date.now() - data.lastUsed > 24 * 60 * 60 * 1000) {
      fs.unlinkSync(p);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function saveSession(chatId: string, sessionId: string) {
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(getSessionPath(chatId), JSON.stringify({ sessionId, lastUsed: Date.now() }));
  } catch (e: any) {
    log('warn', 'save session:', e.message);
  }
}

// ============================================================================
// Claude execution is delegated to the Rust parent (im_bridge.rs).
// The sidecar never spawns `claude` directly — it emits an `execute` SSE event
// and the Rust parent calls back via HTTP to send/update Feishu cards.
// ============================================================================
const isWindows = process.platform === 'win32';

// Card state for building Feishu cards
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
}

// ============================================================================
// Card Builder (Feishu interactive card JSON)
// ============================================================================
const STATUS_CONFIG: Record<CardStatus, { color: string; title: string; icon: string }> = {
  thinking: { color: 'blue', title: 'Thinking...', icon: '🔵' },
  running: { color: 'blue', title: 'Running...', icon: '🔵' },
  complete: { color: 'green', title: 'Complete', icon: '🟢' },
  error: { color: 'red', title: 'Error', icon: '🔴' },
};

const MAX_CARD_LEN = 28000;
function truncate(text: string): string {
  if (text.length <= MAX_CARD_LEN) return text;
  const half = Math.floor(MAX_CARD_LEN / 2) - 50;
  return text.slice(0, half) + '\n\n... (truncated) ...\n\n' + text.slice(-half);
}

function buildCard(state: CardState): string {
  const cfg = STATUS_CONFIG[state.status];
  const elements: any[] = [];

  if (state.toolCalls.length > 0) {
    const lines = state.toolCalls.map(
      (t) => `${t.status === 'running' ? '⏳' : '✅'} **${t.name}** ${t.detail}`,
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

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: cfg.color,
      title: { content: `${cfg.icon} ${cfg.title}`, tag: 'plain_text' },
    },
    elements,
  });
}

// ============================================================================
// Message Sender (Feishu API)
// ============================================================================
async function sendCard(chatId: string, content: string): Promise<string | undefined> {
  if (!larkClient) return undefined;
  try {
    const resp = await larkClient.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, content, msg_type: 'interactive' },
    });
    return (resp as any)?.data?.message_id;
  } catch (err: any) {
    log('error', 'sendCard:', err.message);
    return undefined;
  }
}

async function updateCard(messageId: string, content: string): Promise<void> {
  if (!larkClient) return;
  try {
    await larkClient.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content },
    });
  } catch (err: any) {
    log('error', 'updateCard:', err.message);
  }
}

// ============================================================================
// Claude Execution — delegated to Rust parent via SSE event.
// Rust calls back to POST /feishu-card to send/update Feishu cards.
// ============================================================================

// Track per-chat Feishu messageId so Rust can update cards
const chatCardMap = new Map<string, string>(); // chatId → feishu messageId

function requestClaudeExecution(chatId: string, prompt: string) {
  const session = loadSession(chatId);
  const cwd = currentConfig?.projectPath || '';

  // Emit SSE event — Rust picks this up and spawns claude CLI
  bus.emit('event', {
    type: 'execute',
    chatId,
    prompt,
    cwd,
    sessionId: session?.sessionId || null,
  });
  log('info', `Requested Rust to execute claude for chat ${chatId}`);
}

// ============================================================================
// Feishu Event Handler
// ============================================================================
function createEventDispatcher(onMessage: (msg: any) => void): lark.EventDispatcher {
  const dispatcher = new lark.EventDispatcher({});

  dispatcher.register({
    'im.message.receive_v1': async (data: any) => {
      try {
        const message = data.message;
        const sender = data.sender;
        const msgType = message.message_type;

        if (msgType !== 'text' && msgType !== 'post') {
          return;
        }

        const userId = sender?.sender_id?.open_id;
        if (!userId) return;

        const chatId = message.chat_id;
        const chatType = message.chat_type;
        const messageId = message.message_id;

        // In group chats, only respond when @mentioned
        if (chatType === 'group') {
          const mentions = message.mentions;
          const mentioned = mentions?.some((m: any) => !botOpenId || m.id?.open_id === botOpenId);
          if (!mentioned) return;
        }

        let text = '';
        if (msgType === 'post') {
          try {
            const content = JSON.parse(message.content);
            text = extractTextFromPost(content);
          } catch {
            return;
          }
        } else {
          try {
            const content = JSON.parse(message.content);
            text = content.text || '';
          } catch {
            return;
          }
        }

        // Strip @mention tags
        text = text.replace(/@_\w+\s*/g, '').trim();
        if (!text) return;

        log('info', `[${chatType}] ${userId}: ${text.slice(0, 80)}`);
        onMessage({ messageId, chatId, chatType, userId, text });
      } catch (err: any) {
        log('error', 'event handler:', err.message);
      }
    },
  });

  return dispatcher;
}

function extractTextFromPost(content: Record<string, unknown>): string {
  const bodies: Array<Record<string, unknown>> = [];
  if (Array.isArray(content.content)) {
    bodies.push(content);
  } else {
    for (const locale of Object.values(content)) {
      if (locale && typeof locale === 'object' && !Array.isArray(locale)) {
        const loc = locale as Record<string, unknown>;
        if (Array.isArray(loc.content)) bodies.push(loc);
      }
    }
  }
  for (const body of bodies) {
    const parts: string[] = [];
    if (body.title && typeof body.title === 'string') parts.push(body.title);
    const paragraphs = body.content as unknown[][];
    for (const paragraph of paragraphs) {
      if (!Array.isArray(paragraph)) continue;
      const line: string[] = [];
      for (const el of paragraph) {
        if (!el || typeof el !== 'object') continue;
        const e = el as Record<string, unknown>;
        if ((e.tag === 'text' || e.tag === 'a') && typeof e.text === 'string') line.push(e.text);
      }
      if (line.length > 0) parts.push(line.join(''));
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return '';
}

// ============================================================================
// Feishu Connection
// ============================================================================
function emitStatus() {
  bus.emit('event', {
    type: 'status',
    feishu: { status: feishuStatus, error: feishuError, appId: currentConfig?.appId || null },
    uptimeMs: Date.now() - startedAt,
  });
}

async function connectFeishu(): Promise<{ ok: boolean; error?: string }> {
  if (!currentConfig?.appId || !currentConfig?.appSecret) {
    feishuStatus = 'error';
    feishuError = 'missing appId/appSecret';
    emitStatus();
    return { ok: false, error: feishuError };
  }

  feishuStatus = 'starting';
  feishuError = null;
  emitStatus();

  try {
    larkClient = new lark.Client({
      appId: currentConfig.appId,
      appSecret: currentConfig.appSecret,
      disableTokenCache: false,
    });

    // Get bot info
    try {
      const info = await (larkClient as any).bot.v3.botInfo.get();
      botOpenId = info?.bot?.open_id || null;
      log('info', 'Bot open_id:', botOpenId);
    } catch (e: any) {
      log('warn', 'Could not get bot info:', e.message);
    }

    // Create event dispatcher — delegates Claude execution to Rust parent
    const dispatcher = createEventDispatcher((msg: any) => {
      requestClaudeExecution(msg.chatId, msg.text);
    });

    // WebSocket long connection
    wsClient = new lark.WSClient({
      appId: currentConfig.appId,
      appSecret: currentConfig.appSecret,
      loggerLevel: lark.LoggerLevel.info,
    });
    await wsClient.start({ eventDispatcher: dispatcher });

    feishuStatus = 'running';
    emitStatus();
    log('info', 'Feishu WSClient connected');
    return { ok: true };
  } catch (err: any) {
    feishuStatus = 'error';
    feishuError = err.message;
    emitStatus();
    log('error', 'Feishu connect failed:', err.message);
    return { ok: false, error: err.message };
  }
}

async function disconnectFeishu(): Promise<{ ok: boolean }> {
  chatCardMap.clear();
  wsClient = null;
  larkClient = null;
  botOpenId = null;
  feishuStatus = 'stopped';
  feishuError = null;
  emitStatus();
  return { ok: true };
}

// ============================================================================
// HTTP Server
// ============================================================================
async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c: string) => (buf += c));
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, obj: any) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function handleSse(req: http.IncomingMessage, res: http.ServerResponse) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');

  const listener = (evt: any) => {
    try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch {}
  };
  bus.on('event', listener);

  // Initial snapshot
  listener({
    type: 'status',
    feishu: { status: feishuStatus, error: feishuError, appId: currentConfig?.appId || null },
    uptimeMs: Date.now() - startedAt,
  });

  const ping = setInterval(() => { try { res.write(`: ping\n\n`); } catch {} }, 15000);
  req.on('close', () => { clearInterval(ping); bus.off('event', listener); });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const p = url.pathname;
    const m = req.method || 'GET';

    if (m === 'GET' && p === '/health') {
      return sendJson(res, 200, {
        ok: true,
        uptimeMs: Date.now() - startedAt,
        feishu: { status: feishuStatus, error: feishuError, appId: currentConfig?.appId || null },
      });
    }
    if (m === 'GET' && p === '/events') return handleSse(req, res);
    if (m === 'POST' && p === '/config') {
      const body = await readBody(req);
      try {
        const cfg = JSON.parse(body || '{}');
        currentConfig = {
          appId: cfg.appId || '',
          appSecret: cfg.appSecret || '',
          projectPath: cfg.projectPath || '',
          enabled: !!cfg.enabled,
        };
        if (args.config) {
          try {
            fs.mkdirSync(path.dirname(args.config), { recursive: true });
            fs.writeFileSync(args.config, JSON.stringify(currentConfig, null, 2));
          } catch {}
        }
        emitStatus();
        return sendJson(res, 200, { ok: true });
      } catch (e: any) {
        return sendJson(res, 400, { ok: false, error: e.message });
      }
    }
    if (m === 'POST' && p === '/connect') {
      const r = await connectFeishu();
      return sendJson(res, r.ok ? 200 : 500, r);
    }
    if (m === 'POST' && p === '/disconnect') {
      const r = await disconnectFeishu();
      return sendJson(res, 200, r);
    }

    // Rust → Sidecar callback: send or update a Feishu card.
    // Body: { chatId, cardState: CardState, action?: 'auto'|'send'|'update' }
    // Returns: { ok, messageId }
    if (m === 'POST' && p === '/feishu-card') {
      const body = await readBody(req);
      try {
        const { chatId, cardState, action } = JSON.parse(body || '{}');
        if (!chatId || !cardState) {
          return sendJson(res, 400, { ok: false, error: 'chatId and cardState required' });
        }
        const content = buildCard(cardState);
        const existingMsgId = chatCardMap.get(chatId);
        let messageId: string | undefined;

        if ((action === 'send') || (action !== 'update' && !existingMsgId)) {
          messageId = await sendCard(chatId, content);
          if (messageId) chatCardMap.set(chatId, messageId);
        } else {
          messageId = existingMsgId;
          if (messageId) await updateCard(messageId, content);
        }

        // On final state, clear the map so next message starts fresh
        if (cardState.status === 'complete' || cardState.status === 'error') {
          chatCardMap.delete(chatId);
        }

        return sendJson(res, 200, { ok: true, messageId });
      } catch (e: any) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }

    // Rust → Sidecar callback: persist a claude session_id for a chat.
    if (m === 'POST' && p === '/save-session') {
      const body = await readBody(req);
      try {
        const { chatId, sessionId } = JSON.parse(body || '{}');
        if (chatId && sessionId) saveSession(chatId, sessionId);
        return sendJson(res, 200, { ok: true });
      } catch (e: any) {
        return sendJson(res, 400, { ok: false, error: e.message });
      }
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (e: any) {
    log('error', 'handler:', e.message);
    try { sendJson(res, 500, { ok: false, error: e.message }); } catch {}
  }
});

// ============================================================================
// Startup
// ============================================================================
currentConfig = loadConfig(args.config);
log('info', 'starting, config=', currentConfig ? 'loaded' : 'none');

server.listen(args.port, '127.0.0.1', () => {
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : args.port;
  process.stdout.write(`FROGCODE_SIDECAR_READY port=${actualPort}\n`);
  log('info', `listening on 127.0.0.1:${actualPort}`);

  if (currentConfig && currentConfig.enabled) {
    connectFeishu().catch((e: any) => log('warn', 'auto-connect failed:', e.message));
  }
});

server.on('error', (e: any) => {
  log('error', 'server error:', e.message);
  process.exit(1);
});

// ============================================================================
// Shutdown
// ============================================================================
let shuttingDown = false;
function shutdown(sig: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', `received ${sig}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e: Error) => {
  log('error', 'uncaughtException:', e.stack || e.message);
});
