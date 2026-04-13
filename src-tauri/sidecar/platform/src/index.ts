#!/usr/bin/env node
/**
 * Frogcode Platform Sidecar — Multi-Bot Architecture
 *
 * Bridges IM platforms (Feishu) to pluggable CLI backends via an
 * Agent adapter layer (ClaudeCodeAgent / OpenClawAgent / ...).
 *
 * Each configured Feishu bot gets its own independent:
 *   - lark.Client (API calls)
 *   - lark.WSClient (event subscription)
 *   - AgentManager (session routing)
 *   - CardRenderer (Feishu card updates)
 *
 * This ensures Bot A's events are always replied to via Bot A's
 * API client, eliminating 230002 "Bot not in chat" errors caused
 * by credential mismatch.
 */

// ============================================================================
// CRITICAL: redirect console.{log,info,warn,debug} to stderr BEFORE any import.
// ============================================================================
import * as path from 'node:path';
const _sdkLogPath = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.frogcode',
  'platform-sidecar.log',
);
function _sdkLog(prefix: string, args: any[]) {
  const line = `[sdk ${prefix}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
  try { process.stderr.write(line); } catch {}
  try { require('fs').appendFileSync(_sdkLogPath, line); } catch {}
}
const _origConsoleLog = console.log;
console.log = (...args: any[]) => _sdkLog('log', args);
console.info = (...args: any[]) => _sdkLog('info', args);
console.warn = (...args: any[]) => _sdkLog('warn', args);
console.debug = (...args: any[]) => _sdkLog('debug', args);

import * as http from 'node:http';
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import * as lark from '@larksuiteoapi/node-sdk';

import type { Agent, AgentType } from './agents/types.js';
import { AgentManager } from './agents/manager.js';
import { ClaudeCodeAgent } from './agents/claudecode.js';
import { OpenClawAgent, type OpenClawStatus } from './agents/openclaw/index.js';
import { listSessions as ocListSessions, getSession as ocGetSession } from './agents/openclaw/sessions.js';
import { CardRenderer } from './card-renderer.js';

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
const _logFilePath = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.frogcode',
  'platform-sidecar.log',
);
function log(level: string, ...parts: any[]) {
  const msg = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  const line = `[sidecar ${level}] ${msg}\n`;
  try { process.stderr.write(line); } catch {}
  try { fs.appendFileSync(_logFilePath, line); } catch {}
}

// ============================================================================
// Event Bus (SSE fan-out to Rust)
// ============================================================================
const bus = new EventEmitter();
bus.setMaxListeners(50);

// ============================================================================
// IM Channel Config (read from im-channels.json)
// ============================================================================
interface IMChannelConfig {
  id: string;
  platform: string;
  appId: string;
  appSecret: string;
  label: string;
  assignment: AgentType | 'none';
}

// Platform config (read from platform-config.json) — for projectPath only
interface PlatformConfig {
  projectPath: string;
  enabled: boolean;
  agentType: AgentType;
  openclawAutoStart?: boolean;
}

// ============================================================================
// Kill old frogcode sidecar processes on startup
// ============================================================================
const SIDECAR_TITLE = 'frogcode-platform-sidecar';

// Set process title so we can identify our processes later
process.title = SIDECAR_TITLE;

/**
 * Kill all existing node processes with our title, then grab the port.
 * On Windows: use wmic to find by CommandLine containing our title.
 */
function killOldSidecars(): void {
  try {
    const { execSync } = require('child_process') as typeof import('child_process');
    if (process.platform === 'win32') {
      // Find node processes whose command line contains our sidecar script name
      const out = execSync(
        'wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:csv',
        { encoding: 'utf8', timeout: 5000, windowsHide: true },
      );
      for (const line of out.split('\n')) {
        if (!line.includes('frogcode-platform-sidecar')) continue;
        const parts = line.trim().split(',');
        const pid = parseInt(parts[parts.length - 1], 10);
        if (!pid || pid === process.pid) continue;
        log('info', `killing old sidecar pid=${pid}`);
        try {
          execSync(`taskkill /PID ${pid} /F /T`, { timeout: 3000, windowsHide: true });
        } catch {}
      }
    } else {
      // Unix: pkill by process title
      try {
        execSync(`pkill -f "${SIDECAR_TITLE}" || true`, { timeout: 3000 });
      } catch {}
    }
  } catch (e: any) {
    log('warn', 'killOldSidecars:', e.message);
  }
}

killOldSidecars();

const startedAt = Date.now();
let platformConfig: PlatformConfig | null = null;

function loadPlatformConfig(configPath: string): PlatformConfig | null {
  if (!configPath) return null;
  try {
    if (!fs.existsSync(configPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return {
      projectPath: cfg.projectPath || cfg.project_path || defaultProjectPath(),
      enabled: !!cfg.enabled,
      agentType: (cfg.agentType as AgentType) || 'claudecode',
      openclawAutoStart: !!cfg.openclawAutoStart,
    };
  } catch (e: any) {
    log('warn', 'Failed to load platform config:', e.message);
    return null;
  }
}

function defaultProjectPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return home ? path.join(home, '.openclaw', 'workspace') : '';
}

function loadChannelsFromDisk(): IMChannelConfig[] {
  const p = path.join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.frogcode',
    'im-channels.json',
  );
  try {
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(data.channels) ? data.channels : [];
  } catch (e: any) {
    log('warn', 'Failed to load im-channels.json:', e.message);
    return [];
  }
}

// ============================================================================
// Per-agent config loader
// ============================================================================
function loadAgentConfig(agentType: AgentType): any {
  const p = path.join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.frogcode',
    'agents',
    `${agentType}.json`,
  );
  try {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (e: any) {
    log('warn', `load ${agentType} config:`, e.message);
  }
  return {};
}

// ============================================================================
// Agent initialization
// ============================================================================

/** Module-level OpenClawAgent singleton — shared across all bots assigned to openclaw. */
let openclawAgent: OpenClawAgent | null = null;
function getOpenClawAgent(): OpenClawAgent {
  if (!openclawAgent) {
    openclawAgent = new OpenClawAgent(loadAgentConfig('openclaw'));
  }
  return openclawAgent;
}

function createAgent(type: AgentType): Agent {
  switch (type) {
    case 'claudecode':
      return new ClaudeCodeAgent(loadAgentConfig('claudecode'));
    case 'openclaw':
      return getOpenClawAgent();
    default: {
      const _exhaustive: never = type;
      throw new Error(`unknown agent type: ${_exhaustive}`);
    }
  }
}

// ============================================================================
// BotConnection — one per Feishu bot
// ============================================================================

interface BotConnection {
  appId: string;
  appSecret: string;
  assignment: AgentType | 'none';
  label: string;
  larkClient: lark.Client;
  wsClient: lark.WSClient | null;
  botOpenId: string | null;
  agentManager: AgentManager | null;
  cardRenderer: CardRenderer;
  status: 'stopped' | 'starting' | 'running' | 'error';
  error: string | null;
  /** Track recent chats so we can send notification cards on assignment switch. */
  recentChats: Map<string, string>; // chatId → userId
}

const bots = new Map<string, BotConnection>();

// ============================================================================
// Media temp dir
// ============================================================================
const tmpDir = path.join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'frogcode-platform-media');
fs.mkdirSync(tmpDir, { recursive: true });

// ============================================================================
// Feishu API helpers (per-bot)
// ============================================================================

async function sendText(client: lark.Client, chatId: string, text: string, userId?: string): Promise<void> {
  const content = JSON.stringify({ text });
  try {
    await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, content, msg_type: 'text' },
    });
    return;
  } catch (err: any) {
    log('warn', `sendText chat_id failed: ${err.message?.slice(0, 120)}`);
  }
  if (userId) {
    try {
      await client.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: { receive_id: userId, content, msg_type: 'text' },
      });
    } catch (err: any) {
      log('error', `sendText open_id fallback failed: ${err.message?.slice(0, 120)}`);
    }
  }
}

async function downloadFeishuImage(client: lark.Client, messageId: string, imageKey: string): Promise<string | null> {
  try {
    const resp = await (client as any).im.v1.messageResource.get({
      path: { message_id: messageId, file_key: imageKey },
      params: { type: 'image' },
    });
    if (resp) {
      const filePath = path.join(tmpDir, `${imageKey}.png`);
      await resp.writeFile(filePath);
      return filePath;
    }
  } catch (err: any) {
    log('error', 'downloadImage:', err.message);
  }
  return null;
}

async function downloadFeishuFile(
  client: lark.Client,
  messageId: string,
  fileKey: string,
  fileName: string,
): Promise<string | null> {
  try {
    const resp = await (client as any).im.v1.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: 'file' },
    });
    if (resp) {
      const filePath = path.join(tmpDir, fileName);
      await resp.writeFile(filePath);
      return filePath;
    }
  } catch (err: any) {
    log('error', 'downloadFile:', err.message);
  }
  return null;
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
// Notification Cards (switch / unassign)
// ============================================================================

function buildNotificationCard(title: string, color: string, body: string): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: color,
      title: { content: title, tag: 'plain_text' },
    },
    elements: [{ tag: 'markdown', content: body }],
  });
}

async function sendNotificationCard(client: lark.Client, chatId: string, cardJson: string, userId?: string): Promise<void> {
  // Try chat_id first, then open_id fallback
  try {
    await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, content: cardJson, msg_type: 'interactive' },
    });
    return;
  } catch {}
  if (userId) {
    try {
      await client.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: { receive_id: userId, content: cardJson, msg_type: 'interactive' },
      });
    } catch {}
  }
}

/**
 * Fetch all P2P chats the bot is in via Feishu API, then send a notification
 * card to each. Used when recentChats is empty (e.g. sidecar just started).
 */
async function broadcastNotificationCard(client: lark.Client, cardJson: string): Promise<number> {
  let sent = 0;
  try {
    const resp = await (client as any).im.v1.chat.list({
      params: { page_size: 50 },
    });
    const items = resp?.data?.items || [];
    for (const chat of items) {
      // Only send to P2P chats — group chats can be noisy
      if (chat.chat_type !== 'p2p' || !chat.chat_id) continue;
      try {
        await client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chat.chat_id, content: cardJson, msg_type: 'interactive' },
        });
        sent++;
      } catch (e: any) {
        log('warn', `broadcastNotificationCard chat=${chat.chat_id?.slice(0, 12)}: ${e.message?.slice(0, 80)}`);
      }
    }
  } catch (e: any) {
    log('warn', 'broadcastNotificationCard list chats failed:', e.message?.slice(0, 120));
  }
  return sent;
}

// ============================================================================
// Feishu Event Handler — per-bot
// ============================================================================

/** Per-bot TTL-based dedup cache to ignore duplicate Feishu event deliveries.
 *  Key includes appId so group-chat events are deduplicated per bot, not globally. */
const recentMessageIds = new Map<string, number>();
const DEDUP_TTL_MS = 30_000;

function isDuplicateMessage(appId: string, messageId: string): boolean {
  const key = `${appId}:${messageId}`;
  const now = Date.now();
  if (recentMessageIds.size > 400) {
    for (const [id, ts] of recentMessageIds) {
      if (now - ts > DEDUP_TTL_MS) recentMessageIds.delete(id);
    }
  }
  if (recentMessageIds.has(key)) return true;
  recentMessageIds.set(key, now);
  return false;
}

function createEventDispatcher(bot: BotConnection): lark.EventDispatcher {
  const dispatcher = new lark.EventDispatcher({});
  log('info', `[${bot.appId.slice(0, 12)}] Registering event handler`);

  dispatcher.register({
    'im.message.receive_v1': async (data: any) => {
      try {
        const message = data.message;
        const sender = data.sender;
        const msgType = message?.message_type;
        const chatId = message?.chat_id;
        const chatType = message?.chat_type;
        const messageId = message?.message_id;
        const userId = sender?.sender_id?.open_id;

        log(
          'event',
          `[${bot.appId.slice(0, 12)}] RECV chat=${chatType}/${chatId?.slice(0, 12)} user=${userId?.slice(0, 12)} msg=${messageId?.slice(0, 12)} type=${msgType}`,
        );

        if (messageId && isDuplicateMessage(bot.appId, messageId)) {
          log('event', `DROP: duplicate messageId=${messageId.slice(0, 12)}`);
          return;
        }

        if (!['text', 'post', 'image', 'file'].includes(msgType)) {
          log('event', `DROP: unsupported msgType=${msgType}`);
          return;
        }

        if (!userId) {
          log('event', `DROP: missing sender.sender_id.open_id`);
          return;
        }

        // In group chats, only respond when @mentioned
        if (chatType === 'group') {
          const mentions = message.mentions;
          if (!Array.isArray(mentions) || mentions.length === 0) {
            log('event', `DROP: group chat, no @mentions`);
            return;
          }
          const mentioned = mentions.some(
            (m: any) => !bot.botOpenId || m.id?.open_id === bot.botOpenId,
          );
          if (!mentioned) {
            log('event', `DROP: group chat, bot not @mentioned`);
            return;
          }
        }

        let text = '';
        let imageKey: string | undefined;
        let fileKey: string | undefined;
        let fileName: string | undefined;

        if (msgType === 'image') {
          try {
            const content = JSON.parse(message.content);
            imageKey = content.image_key;
          } catch { return; }
          text = '请分析这张图片';
        } else if (msgType === 'file') {
          try {
            const content = JSON.parse(message.content);
            fileKey = content.file_key;
            fileName = content.file_name;
          } catch { return; }
          text = `请分析这个文件: ${fileName}`;
        } else if (msgType === 'post') {
          try {
            const content = JSON.parse(message.content);
            text = extractTextFromPost(content);
          } catch { return; }
        } else {
          try {
            const content = JSON.parse(message.content);
            text = content.text || '';
          } catch { return; }
        }

        // Strip @mention tags
        text = text.replace(/@_\w+\s*/g, '').trim();
        if (!text && !imageKey && !fileKey) return;

        log(
          'info',
          `[${bot.appId.slice(0, 12)}] [${chatType}] ${userId.slice(0, 12)}: ${text.slice(0, 80)}${imageKey ? ' +img' : ''}${fileKey ? ' +file' : ''}`,
        );

        // Track recent chats for notification cards on assignment switch
        bot.recentChats.set(chatId, userId);

        // ─── Unassigned bot: reply with "未分配" message ─────────────
        if (bot.assignment === 'none' || !bot.agentManager) {
          log('info', `[${bot.appId.slice(0, 12)}] bot unassigned, sending 未分配 reply`);
          await sendText(bot.larkClient, chatId, '该机器人还未分配CLI后端，请在 Frog Code 应用中为此通道分配 Claude Code 或 OpenClaw。', userId);
          return;
        }

        // Must match makeSessionKey(platform, channelId, userId) format
        const sessionKey = `feishu:${chatId}:${userId}`;

        // ─── Slash commands ──────────────────────────────────────────
        const lower = text.toLowerCase();
        if (lower === '/new' || lower === '/reset') {
          await bot.agentManager.reset(sessionKey);
          await sendText(bot.larkClient, chatId, '\u2705 会话已重置，下次消息将开始新对话。', userId);
          return;
        }
        if (lower === '/stop') {
          await bot.agentManager.cancel(sessionKey);
          await sendText(bot.larkClient, chatId, '\u23F9 已请求停止当前任务。', userId);
          return;
        }
        if (lower === '/status') {
          const lines = [
            `**Bot:** \`${bot.appId.slice(0, 16)}...\` ${bot.label ? `(${bot.label})` : ''}`,
            `**Chat:** \`${chatId.slice(0, 12)}...\``,
            `**User:** \`${userId.slice(0, 12)}...\``,
            `**Agent:** ${bot.agentManager.agentName}`,
            `**Project:** \`${platformConfig?.projectPath || 'N/A'}\``,
            `**Status:** ${bot.status}`,
          ];
          await sendText(bot.larkClient, chatId, lines.join('\n'), userId);
          return;
        }

        // ─── Download media if present ───────────────────────────────
        const files: string[] = [];
        if (imageKey) {
          const p = await downloadFeishuImage(bot.larkClient, messageId, imageKey);
          if (p) files.push(p);
        }
        if (fileKey && fileName) {
          const p = await downloadFeishuFile(bot.larkClient, messageId, fileKey, fileName);
          if (p) files.push(p);
        }

        // ─── Pre-flight check for openclaw ───────────────────────────
        if (bot.agentManager.agentName === 'openclaw') {
          try {
            const ocStatus = getOpenClawAgent().status();
            if (!ocStatus.started || !ocStatus.processAlive) {
              log('warn', `OpenClaw gateway not running, notifying user`);
              await sendText(bot.larkClient, chatId, '\u26A0\uFE0F OpenClaw 网关未启动，请先在应用中启动 OpenClaw 后再发送消息。', userId);
              return;
            }
            if (!ocStatus.wsConnected) {
              log('warn', 'OpenClaw gateway WS not connected');
              await sendText(bot.larkClient, chatId, '\u26A0\uFE0F OpenClaw 网关 WebSocket 未连接，请检查日志。', userId);
              return;
            }
          } catch {}
        }

        log(
          'event',
          `[${bot.appId.slice(0, 12)}] DISPATCH → agent=${bot.agentManager.agentName} prompt="${text.slice(0, 40)}" files=${files.length}`,
        );

        // Begin card rendering for this turn — if there's already an
        // active card (previous turn still running), don't create a new one
        // to avoid orphaning the old card at "Running" forever.
        const cardStarted = bot.cardRenderer.begin(chatId, messageId, userId);
        if (!cardStarted) {
          await sendText(bot.larkClient, chatId, '\u23F3 当前有任务正在执行，请等待完成后再发送新消息。', userId);
          return;
        }
        bot.cardRenderer.addTypingReaction(chatId, messageId).catch(() => {});

        try {
          await bot.agentManager.handle({
            platform: 'feishu',
            channelId: chatId,
            userId,
            cwd: platformConfig?.projectPath || '',
            prompt: text,
            files,
          });
          log('event', `[${bot.appId.slice(0, 12)}] DONE chat=${chatId?.slice(0, 12)}`);
        } catch (err: any) {
          log('error', `[${bot.appId.slice(0, 12)}] agentManager.handle:`, err.message);
          await bot.cardRenderer.processEvent(chatId, {
            type: 'result',
            error: err.message || String(err),
          });
        }
      } catch (err: any) {
        log('error', `[${bot.appId.slice(0, 12)}] event handler:`, err.message);
      }
    },
  });

  return dispatcher;
}

// ============================================================================
// Bot lifecycle
// ============================================================================

async function connectBot(channel: IMChannelConfig): Promise<BotConnection> {
  const { appId, appSecret, assignment, label } = channel;
  log('info', `connectBot ${appId.slice(0, 12)} assignment=${assignment} label=${label}`);

  const larkClient = new lark.Client({
    appId,
    appSecret,
    disableTokenCache: false,
  });

  const cardRenderer = new CardRenderer({ larkClient });

  // Init agentManager if assigned
  let agentManager: AgentManager | null = null;
  if (assignment !== 'none') {
    const agent = createAgent(assignment as AgentType);
    agentManager = new AgentManager(agent);
    // Wire agent events → this bot's card renderer
    agentManager.onEvent((_key, evt) => {
      // sessionKey format: "feishu:chatId:userId" (from makeSessionKey)
      const [, chatId] = _key.split(':');
      cardRenderer.processEvent(chatId, evt).catch((e) =>
        log('error', `[${appId.slice(0, 12)}] cardRenderer.processEvent:`, e.message),
      );
    });
  }

  const bot: BotConnection = {
    appId,
    appSecret,
    assignment: assignment as AgentType | 'none',
    label,
    larkClient,
    wsClient: null,
    botOpenId: null,
    agentManager,
    cardRenderer,
    status: 'starting',
    error: null,
    recentChats: new Map(),
  };

  // Fetch bot's own open_id for group-chat @mention matching
  try {
    let info: any;
    if ((larkClient as any).bot?.v3?.botInfo?.get) {
      info = await (larkClient as any).bot.v3.botInfo.get();
    } else {
      info = await larkClient.request({
        method: 'GET',
        url: 'https://open.feishu.cn/open-apis/bot/v3/info',
      });
    }
    bot.botOpenId = info?.data?.bot?.open_id || info?.bot?.open_id || null;
    log('info', `[${appId.slice(0, 12)}] Bot open_id: ${bot.botOpenId}`);
  } catch (e: any) {
    log('warn', `[${appId.slice(0, 12)}] Could not get bot info:`, e.message);
  }

  // Create event dispatcher and connect WSClient
  const dispatcher = createEventDispatcher(bot);
  try {
    const wsClient = new lark.WSClient({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel.info,
    });
    await wsClient.start({ eventDispatcher: dispatcher });
    bot.wsClient = wsClient;
    bot.status = 'running';
    log('info', `[${appId.slice(0, 12)}] WSClient connected`);
  } catch (err: any) {
    bot.status = 'error';
    bot.error = err.message;
    log('error', `[${appId.slice(0, 12)}] WSClient connect failed:`, err.message);
  }

  bots.set(appId, bot);
  emitStatus();
  return bot;
}

async function disconnectBot(appId: string): Promise<void> {
  const bot = bots.get(appId);
  if (!bot) return;
  log('info', `disconnectBot ${appId.slice(0, 12)}`);

  // Detach agentManager (keep underlying agent alive)
  if (bot.agentManager) {
    try { await bot.agentManager.detach(); } catch {}
    bot.agentManager = null;
  }

  // Shutdown card renderer
  try { await bot.cardRenderer.shutdown(); } catch {}

  // WSClient — no explicit close method, just null the reference
  bot.wsClient = null;

  bot.status = 'stopped';
  bot.error = null;
  bots.delete(appId);
  emitStatus();
}

/**
 * reconcileBots — read im-channels.json and sync with live bots Map.
 * - New assigned channels → connectBot
 * - Removed channels → disconnectBot
 * - Assignment changed → send notification card, reconnect with new agent
 * - Unassigned channels → disconnect (per user requirement)
 */
let reconciling = false;
async function reconcileBots(): Promise<void> {
  if (reconciling) {
    log('info', 'reconcileBots already in progress, skipping');
    return;
  }
  reconciling = true;
  try {
    await _reconcileBotsInner();
  } finally {
    reconciling = false;
  }
}
async function _reconcileBotsInner(): Promise<void> {
  const channels = loadChannelsFromDisk();
  const desiredAppIds = new Set<string>();
  const projectPath = platformConfig?.projectPath || defaultProjectPath();

  for (const ch of channels) {
    if (!ch.appId || !ch.appSecret) continue;

    desiredAppIds.add(ch.appId);
    const existing = bots.get(ch.appId);

    if (!existing) {
      // New channel — connect (both assigned and unassigned bots connect,
      // so unassigned bots can reply "该机器人还未分配CLI")
      await connectBot(ch);
    } else if (existing.assignment !== ch.assignment) {
      // Assignment changed
      const oldAssignment = existing.assignment;
      const newAssignment = ch.assignment;
      const agentLabel = newAssignment === 'claudecode' ? 'Claude Code'
        : newAssignment === 'openclaw' ? 'OpenClaw' : '';

      if (newAssignment === 'none') {
        // Switched to unassigned → send farewell card to all recent chats
        log('info', `[${ch.appId.slice(0, 12)}] switched to unassigned, sending farewell cards`);
        const oldLabel = oldAssignment === 'claudecode' ? 'Claude Code'
          : oldAssignment === 'openclaw' ? 'OpenClaw' : 'CLI';
        const card = buildNotificationCard(
          '\u{1F534} 已断开连接',
          'red',
          `该机器人已断开 **${oldLabel}** 后端连接。\n\n如需继续使用，请在 Frog Code 应用中重新分配 CLI 后端。`,
        );
        if (existing.recentChats.size > 0) {
          for (const [chatId, uId] of existing.recentChats) {
            await sendNotificationCard(existing.larkClient, chatId, card, uId);
          }
        } else {
          await broadcastNotificationCard(existing.larkClient, card);
        }
        // Detach agentManager but keep bot connected (so it can reply "未分配")
        if (existing.agentManager) {
          try { await existing.agentManager.detach(); } catch {}
        }
        existing.agentManager = null;
        existing.assignment = 'none';
        existing.label = ch.label;
        emitStatus();
      } else {
        // Switched to a different agent
        log('info', `[${ch.appId.slice(0, 12)}] switching ${oldAssignment} → ${newAssignment}`);

        // Detach old agentManager
        if (existing.agentManager) {
          try { await existing.agentManager.detach(); } catch {}
        }

        // Create new agentManager
        const agent = createAgent(newAssignment as AgentType);
        const agentManager = new AgentManager(agent);
        agentManager.onEvent((_key, evt) => {
          const [, chatId] = _key.split(':');
          existing.cardRenderer.processEvent(chatId, evt).catch((e) =>
            log('error', `[${ch.appId.slice(0, 12)}] cardRenderer.processEvent:`, e.message),
          );
        });

        existing.agentManager = agentManager;
        existing.assignment = newAssignment as AgentType | 'none';
        existing.label = ch.label;

        // Send success notification card
        const card = buildNotificationCard(
          '\u{1F7E2} 连接成功',
          'green',
          `该机器人已成功连接 **${agentLabel}** 后端。\n\n现在可以直接发送消息开始 AI 对话。`,
        );
        if (existing.recentChats.size > 0) {
          for (const [chatId, uId] of existing.recentChats) {
            await sendNotificationCard(existing.larkClient, chatId, card, uId);
          }
        } else {
          // No recent chats — fetch bot's P2P chat list from Feishu API and send
          log('info', `[${ch.appId.slice(0, 12)}] no recent chats, fetching chat list to send notification`);
          const sent = await broadcastNotificationCard(existing.larkClient, card);
          log('info', `[${ch.appId.slice(0, 12)}] notification card sent to ${sent} P2P chats`);
        }

        log('info', `[${ch.appId.slice(0, 12)}] now assigned to ${newAssignment}`);
        emitStatus();
      }
    } else {
      // Same assignment — update label if changed
      existing.label = ch.label;
    }
  }

  // Disconnect bots no longer in im-channels.json
  for (const [appId] of bots) {
    if (!desiredAppIds.has(appId)) {
      log('info', `[${appId.slice(0, 12)}] removed from channels, disconnecting`);
      await disconnectBot(appId);
    }
  }
}

// ============================================================================
// Status emission
// ============================================================================

function emitStatus() {
  const botStatuses: any[] = [];
  for (const [appId, bot] of bots) {
    botStatuses.push({
      appId,
      label: bot.label,
      assignment: bot.assignment,
      status: bot.status,
      error: bot.error,
      agent: bot.agentManager?.agentName ?? null,
    });
  }

  bus.emit('event', {
    type: 'status',
    // Backward compat: report first running bot's status as the "feishu" status
    feishu: {
      status: botStatuses.find((b) => b.status === 'running')
        ? 'running'
        : botStatuses.find((b) => b.status === 'starting')
          ? 'starting'
          : botStatuses.find((b) => b.status === 'error')
            ? 'error'
            : 'stopped',
      error: botStatuses.find((b) => b.error)?.error ?? null,
      appId: botStatuses.find((b) => b.status === 'running')?.appId ?? null,
    },
    bots: botStatuses,
    agent: botStatuses.find((b) => b.agent)?.agent ?? null,
    uptimeMs: Date.now() - startedAt,
  });
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
    try {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch {}
  };
  bus.on('event', listener);

  // Initial snapshot
  emitStatus();

  const ping = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch {}
  }, 15000);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('event', listener);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const p = url.pathname;
    const m = req.method || 'GET';

    if (m === 'GET' && p === '/health') {
      const botStatuses: any[] = [];
      for (const [appId, bot] of bots) {
        botStatuses.push({
          appId,
          label: bot.label,
          assignment: bot.assignment,
          status: bot.status,
          error: bot.error,
          agent: bot.agentManager?.agentName ?? null,
        });
      }
      return sendJson(res, 200, {
        ok: true,
        uptimeMs: Date.now() - startedAt,
        bots: botStatuses,
        // Backward compat
        feishu: {
          status: botStatuses.find((b) => b.status === 'running')
            ? 'running'
            : botStatuses.find((b) => b.status === 'error')
              ? 'error'
              : 'stopped',
          error: botStatuses.find((b) => b.error)?.error ?? null,
          appId: botStatuses.find((b) => b.status === 'running')?.appId ?? null,
        },
        agent: botStatuses.find((b) => b.agent)?.agent ?? null,
      });
    }
    if (m === 'GET' && p === '/events') return handleSse(req, res);

    // Legacy /config endpoint — update platform config only
    if (m === 'POST' && p === '/config') {
      const body = await readBody(req);
      try {
        const cfg = JSON.parse(body || '{}');
        platformConfig = {
          projectPath: cfg.projectPath || '',
          enabled: !!cfg.enabled,
          agentType: (cfg.agentType as AgentType) || 'claudecode',
        };
        if (args.config) {
          try {
            fs.mkdirSync(path.dirname(args.config), { recursive: true });
            fs.writeFileSync(args.config, JSON.stringify(platformConfig, null, 2));
          } catch {}
        }
        emitStatus();
        return sendJson(res, 200, { ok: true });
      } catch (e: any) {
        return sendJson(res, 400, { ok: false, error: e.message });
      }
    }

    // Hot-reload: re-read im-channels.json + platform-config.json, reconcile bots
    if (m === 'POST' && p === '/reload') {
      try {
        const fresh = loadPlatformConfig(args.config);
        if (fresh) platformConfig = fresh;
        await reconcileBots();
        return sendJson(res, 200, { ok: true, reloaded: true, bots: bots.size });
      } catch (e: any) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }

    // Connect all assigned bots (backward compat)
    if (m === 'POST' && p === '/connect') {
      try {
        await reconcileBots();
        const running = [...bots.values()].filter((b) => b.status === 'running').length;
        return sendJson(res, 200, { ok: true, botsConnected: running });
      } catch (e: any) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }

    // Disconnect all bots
    if (m === 'POST' && p === '/disconnect') {
      for (const [appId] of bots) {
        await disconnectBot(appId);
      }
      emitStatus();
      return sendJson(res, 200, { ok: true });
    }

    // ─── OpenClaw controls ──────────────────────────────────────────────
    if (m === 'POST' && p === '/openclaw/start') {
      try {
        await getOpenClawAgent().startGateway();
        return sendJson(res, 200, { ok: true });
      } catch (e: any) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }
    if (m === 'POST' && p === '/openclaw/stop') {
      try {
        await getOpenClawAgent().stopGateway();
        return sendJson(res, 200, { ok: true });
      } catch (e: any) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }
    if (m === 'POST' && p === '/openclaw/restart') {
      try {
        await getOpenClawAgent().restart();
        return sendJson(res, 200, { ok: true });
      } catch (e: any) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }

    // ─── OpenClaw status + session history ──────────────────────────────
    if (m === 'GET' && p === '/openclaw/status') {
      let ocStatus: OpenClawStatus | null = null;
      try {
        ocStatus = getOpenClawAgent().status();
      } catch {}
      return sendJson(res, 200, {
        ok: true,
        active: true,
        agentType: 'openclaw',
        ...(ocStatus ?? { processAlive: false, wsConnected: false, started: false, error: 'agent not initialized' }),
      });
    }
    if (m === 'GET' && p === '/openclaw/sessions') {
      try {
        const stateDir = loadAgentConfig('openclaw').stateDir || undefined;
        const sessions = ocListSessions(stateDir);
        return sendJson(res, 200, { ok: true, sessions });
      } catch (e: any) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }
    if (m === 'GET' && p.startsWith('/openclaw/sessions/')) {
      const id = decodeURIComponent(p.slice('/openclaw/sessions/'.length));
      try {
        const stateDir = loadAgentConfig('openclaw').stateDir || undefined;
        const detail = ocGetSession(id, stateDir);
        if (!detail) return sendJson(res, 404, { ok: false, error: 'session not found' });
        return sendJson(res, 200, { ok: true, ...detail });
      } catch (e: any) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (e: any) {
    log('error', 'handler:', e.message);
    try {
      sendJson(res, 500, { ok: false, error: e.message });
    } catch {}
  }
});

// ============================================================================
// Startup
// ============================================================================
platformConfig = loadPlatformConfig(args.config);
if (!platformConfig) {
  platformConfig = {
    projectPath: defaultProjectPath(),
    enabled: false,
    agentType: 'claudecode',
  };
  log('info', 'no platform config on disk, using defaults');
} else {
  log('info', 'platform config loaded');
}

// NOTE: we deliberately do NOT auto-connect bots here. The Rust parent
// (main.rs) is the single source of truth — it calls platform_connect_feishu
// after the sidecar signals READY. If we auto-connected here too, both
// paths would create competing WSClient instances for the same bot.
// The Rust parent's /connect call triggers reconcileBots().

server.listen(args.port, '127.0.0.1', () => {
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : args.port;
  process.stdout.write(`FROGCODE_PLATFORM_READY port=${actualPort}\n`);
  log('info', `listening on 127.0.0.1:${actualPort}`);
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
  (async () => {
    for (const [appId] of bots) {
      try { await disconnectBot(appId); } catch {}
    }
    // Stop openclaw gateway if running
    try {
      if (openclawAgent) await openclawAgent.stopGateway();
    } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  })();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e: Error) => {
  log('error', 'uncaughtException:', e.stack || e.message);
});
