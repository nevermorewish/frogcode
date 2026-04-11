#!/usr/bin/env node
/**
 * Frogcode Platform Sidecar
 *
 * Bridges IM platforms (currently Feishu) to pluggable CLI backends via an
 * Agent adapter layer (ClaudeCodeAgent / OpenClawAgent / ...).
 *
 * Architecture (mirrors cc-connect):
 *   Feishu WS  →  AgentManager.handle()  →  Agent.startSession().send()
 *                                         →  AgentEvent stream
 *                                         →  CardRenderer  →  Feishu API
 *
 * Rust parent manages lifecycle only (spawn/kill, config r/w, SSE relay).
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
function log(level: string, ...parts: any[]) {
  const msg = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  process.stderr.write(`[sidecar ${level}] ${msg}\n`);
}

// ============================================================================
// Event Bus (SSE fan-out to Rust)
// ============================================================================
const bus = new EventEmitter();
bus.setMaxListeners(50);

// ============================================================================
// Config
// ============================================================================
interface PlatformConfig {
  appId: string;
  appSecret: string;
  projectPath: string;
  enabled: boolean;
  agentType: AgentType;
}

const startedAt = Date.now();
let currentConfig: PlatformConfig | null = null;
let feishuStatus: 'stopped' | 'starting' | 'running' | 'error' = 'stopped';
let feishuError: string | null = null;
let larkClient: lark.Client | null = null;
let wsClient: lark.WSClient | null = null;
let botOpenId: string | null = null;

// Agent layer (one agent instance, one manager per sidecar)
let agentManager: AgentManager | null = null;
let cardRenderer: CardRenderer = new CardRenderer({ larkClient: null });

function loadConfig(configPath: string): PlatformConfig | null {
  if (!configPath) return null;
  try {
    if (!fs.existsSync(configPath)) return null;
    const raw = fs.readFileSync(configPath, 'utf8');
    const cfg = JSON.parse(raw);
    const agentType: AgentType = (cfg.agentType as AgentType) || 'openclaw';
    // Feishu credentials live under each agent's per-agent config file as of
    // v5.29 — pull them from agents/<type>.json's `feishu` sub-object. Fall
    // back to root appId/appSecret (legacy layout) if the agent file has none,
    // so old installs still work until the next write migrates them.
    const agentCfg = loadAgentConfig(agentType) || {};
    const agentFeishu = (agentCfg.feishu as { appId?: string; appSecret?: string } | undefined) || {};
    return {
      appId:
        agentFeishu.appId ||
        cfg.appId ||
        cfg.app_id ||
        '',
      appSecret:
        agentFeishu.appSecret ||
        cfg.appSecret ||
        cfg.app_secret ||
        '',
      projectPath: cfg.projectPath || cfg.project_path || '',
      enabled: !!cfg.enabled,
      // Default to 'openclaw' (matches Rust default_agent_type) so a fresh
      // install lands on the OpenClaw adapter.
      agentType,
    };
  } catch (e: any) {
    log('warn', 'Failed to load config:', e.message);
    return null;
  }
}

/** Default config synthesized when no platform-config.json exists on disk. */
function defaultConfig(): PlatformConfig {
  return {
    appId: '',
    appSecret: '',
    projectPath: '',
    enabled: false,
    agentType: 'openclaw',
  };
}

// ============================================================================
// Per-agent config loader
// ============================================================================
function loadAgentConfig(agentType: AgentType): any {
  const p = path.join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.anycode',
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
function createAgent(type: AgentType): Agent {
  switch (type) {
    case 'claudecode':
      return new ClaudeCodeAgent(loadAgentConfig('claudecode'));
    case 'openclaw':
      return new OpenClawAgent(loadAgentConfig('openclaw'));
    default: {
      const _exhaustive: never = type;
      throw new Error(`unknown agent type: ${_exhaustive}`);
    }
  }
}

async function initAgentManager(type: AgentType): Promise<void> {
  if (agentManager) {
    await agentManager.shutdown();
    agentManager = null;
  }
  const agent = createAgent(type);
  agentManager = new AgentManager(agent);
  // Wire agent events → card renderer
  agentManager.onEvent((_key, evt) => {
    // sessionKey format: "feishu:chatId:userId" — extract chatId for the renderer
    const [, chatId] = _key.split(':');
    cardRenderer.processEvent(chatId, evt).catch((e) =>
      log('error', 'cardRenderer.processEvent:', e.message),
    );
  });
  log('info', `AgentManager initialized with agent=${type}`);
  // Note: openclaw gateway is NOT auto-started. User must click Start
  // from the OpenClaw Sessions page, or first Feishu message triggers it.
}

// ============================================================================
// Media temp dir
// ============================================================================
const tmpDir = path.join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'frogcode-platform-media');
fs.mkdirSync(tmpDir, { recursive: true });

// ============================================================================
// Feishu API helpers (non-card)
// ============================================================================

// Plain-text reply (for slash command ACKs)
async function sendText(chatId: string, text: string): Promise<void> {
  if (!larkClient) return;
  try {
    await larkClient.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ text }),
        msg_type: 'text',
      },
    });
  } catch (err: any) {
    log('error', 'sendText:', err.message);
  }
}

async function downloadFeishuImage(messageId: string, imageKey: string): Promise<string | null> {
  if (!larkClient) return null;
  try {
    const resp = await (larkClient as any).im.v1.messageResource.get({
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
  messageId: string,
  fileKey: string,
  fileName: string,
): Promise<string | null> {
  if (!larkClient) return null;
  try {
    const resp = await (larkClient as any).im.v1.messageResource.get({
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
// Feishu Event Handler
// ============================================================================
function createEventDispatcher(): lark.EventDispatcher {
  const dispatcher = new lark.EventDispatcher({});

  dispatcher.register({
    'im.message.receive_v1': async (data: any) => {
      try {
        const message = data.message;
        const sender = data.sender;
        const msgType = message.message_type;

        if (!['text', 'post', 'image', 'file'].includes(msgType)) return;

        const userId = sender?.sender_id?.open_id;
        if (!userId) return;

        const chatId = message.chat_id;
        const chatType = message.chat_type;
        const messageId = message.message_id;

        // In group chats, only respond when @mentioned
        if (chatType === 'group') {
          const mentions = message.mentions;
          const mentioned = mentions?.some(
            (m: any) => !botOpenId || m.id?.open_id === botOpenId,
          );
          if (!mentioned) return;
        }

        let text = '';
        let imageKey: string | undefined;
        let fileKey: string | undefined;
        let fileName: string | undefined;

        if (msgType === 'image') {
          try {
            const content = JSON.parse(message.content);
            imageKey = content.image_key;
          } catch {
            return;
          }
          text = '请分析这张图片';
        } else if (msgType === 'file') {
          try {
            const content = JSON.parse(message.content);
            fileKey = content.file_key;
            fileName = content.file_name;
          } catch {
            return;
          }
          text = `请分析这个文件: ${fileName}`;
        } else if (msgType === 'post') {
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
        if (!text && !imageKey && !fileKey) return;

        log(
          'info',
          `[${chatType}] ${userId}: ${text.slice(0, 80)}${imageKey ? ' +img' : ''}${fileKey ? ' +file' : ''}`,
        );

        const sessionKey = `feishu:${chatId}:${userId}`;

        // ─── Slash commands ───────────────────────────────────────────────
        const lower = text.toLowerCase();
        if (lower === '/new' || lower === '/reset') {
          if (agentManager) await agentManager.reset(sessionKey);
          await sendText(chatId, '\u2705 会话已重置，下次消息将开始新对话。');
          return;
        }
        if (lower === '/stop') {
          if (agentManager) await agentManager.cancel(sessionKey);
          await sendText(chatId, '\u23F9 已请求停止当前任务。');
          return;
        }
        if (lower === '/status') {
          const lines = [
            `**Chat:** \`${chatId.slice(0, 12)}...\``,
            `**User:** \`${userId.slice(0, 12)}...\``,
            `**Agent:** ${agentManager?.agentName ?? 'none'}`,
            `**Project:** \`${currentConfig?.projectPath || 'N/A'}\``,
            `**Feishu:** ${feishuStatus}`,
          ];
          await sendText(chatId, lines.join('\n'));
          return;
        }

        // ─── Download media if present ────────────────────────────────────
        const files: string[] = [];
        if (imageKey) {
          const p = await downloadFeishuImage(messageId, imageKey);
          if (p) files.push(p);
        }
        if (fileKey && fileName) {
          const p = await downloadFeishuFile(messageId, fileKey, fileName);
          if (p) files.push(p);
        }

        // ─── Dispatch to agent ────────────────────────────────────────────
        if (!agentManager) {
          await sendText(chatId, '\u26A0\uFE0F Agent not initialized. Check sidecar logs.');
          return;
        }

        // Begin card rendering for this turn (creates thinking card + typing reaction)
        cardRenderer.begin(chatId, messageId);
        cardRenderer.addTypingReaction(chatId, messageId).catch(() => {});

        try {
          await agentManager.handle({
            platform: 'feishu',
            channelId: chatId,
            userId,
            cwd: currentConfig?.projectPath || '',
            prompt: text,
            files,
          });
        } catch (err: any) {
          log('error', 'agentManager.handle:', err.message);
          await cardRenderer.processEvent(chatId, {
            type: 'result',
            error: err.message || String(err),
          });
        }
      } catch (err: any) {
        log('error', 'event handler:', err.message);
      }
    },
  });

  return dispatcher;
}

// ============================================================================
// Feishu Connection
// ============================================================================
function emitStatus() {
  bus.emit('event', {
    type: 'status',
    feishu: {
      status: feishuStatus,
      error: feishuError,
      appId: currentConfig?.appId || null,
    },
    agent: agentManager?.agentName ?? null,
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
    // Ensure agent manager exists before accepting messages
    if (!agentManager) {
      await initAgentManager(currentConfig.agentType);
    }

    larkClient = new lark.Client({
      appId: currentConfig.appId,
      appSecret: currentConfig.appSecret,
      disableTokenCache: false,
    });
    cardRenderer.setLarkClient(larkClient);

    try {
      const info = await (larkClient as any).bot.v3.botInfo.get();
      botOpenId = info?.bot?.open_id || null;
      log('info', 'Bot open_id:', botOpenId);
    } catch (e: any) {
      log('warn', 'Could not get bot info:', e.message);
    }

    const dispatcher = createEventDispatcher();
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
  wsClient = null;
  larkClient = null;
  cardRenderer.setLarkClient(null);
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
    try {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch {}
  };
  bus.on('event', listener);

  // Initial snapshot
  listener({
    type: 'status',
    feishu: {
      status: feishuStatus,
      error: feishuError,
      appId: currentConfig?.appId || null,
    },
    agent: agentManager?.agentName ?? null,
    uptimeMs: Date.now() - startedAt,
  });

  const ping = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {}
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
      return sendJson(res, 200, {
        ok: true,
        uptimeMs: Date.now() - startedAt,
        feishu: {
          status: feishuStatus,
          error: feishuError,
          appId: currentConfig?.appId || null,
        },
        agent: agentManager?.agentName ?? null,
      });
    }
    if (m === 'GET' && p === '/events') return handleSse(req, res);

    if (m === 'POST' && p === '/config') {
      const body = await readBody(req);
      try {
        const cfg = JSON.parse(body || '{}');
        const newAgentType: AgentType = (cfg.agentType as AgentType) || 'claudecode';
        const prevAgentType = currentConfig?.agentType;
        currentConfig = {
          appId: cfg.appId || '',
          appSecret: cfg.appSecret || '',
          projectPath: cfg.projectPath || '',
          enabled: !!cfg.enabled,
          agentType: newAgentType,
        };
        if (args.config) {
          try {
            fs.mkdirSync(path.dirname(args.config), { recursive: true });
            fs.writeFileSync(args.config, JSON.stringify(currentConfig, null, 2));
          } catch {}
        }
        // Re-init agent if type changed
        if (newAgentType !== prevAgentType) {
          await initAgentManager(newAgentType);
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

    // ─── OpenClaw controls ──────────────────────────────────────────────
    if (m === 'POST' && p === '/openclaw/start') {
      const agent = agentManager?.getAgent();
      if (!agent || agent.name !== 'openclaw') {
        return sendJson(res, 400, { ok: false, error: 'agent is not openclaw' });
      }
      try {
        await (agent as OpenClawAgent).startGateway();
        return sendJson(res, 200, { ok: true });
      } catch (e: any) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }
    if (m === 'POST' && p === '/openclaw/stop') {
      const agent = agentManager?.getAgent();
      if (!agent || agent.name !== 'openclaw') {
        return sendJson(res, 400, { ok: false, error: 'agent is not openclaw' });
      }
      try {
        await (agent as OpenClawAgent).stopGateway();
        return sendJson(res, 200, { ok: true });
      } catch (e: any) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }
    if (m === 'POST' && p === '/openclaw/restart') {
      const agent = agentManager?.getAgent();
      if (!agent || agent.name !== 'openclaw') {
        return sendJson(res, 400, { ok: false, error: 'agent is not openclaw' });
      }
      try {
        await (agent as OpenClawAgent).restart();
        return sendJson(res, 200, { ok: true });
      } catch (e: any) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }

    // ─── OpenClaw status + session history ──────────────────────────────
    // GET /openclaw/status               → gateway process + ws status
    // GET /openclaw/sessions             → list all sessions (summaries)
    // GET /openclaw/sessions/:id         → full detail incl. messages
    if (m === 'GET' && p === '/openclaw/status') {
      // Check if agent is openclaw and get its status
      const isOc = currentConfig?.agentType === 'openclaw';
      if (!isOc) {
        return sendJson(res, 200, {
          ok: true,
          active: false,
          agentType: currentConfig?.agentType ?? 'claudecode',
        });
      }
      let ocStatus: OpenClawStatus | null = null;
      try {
        const agent = agentManager?.getAgent();
        if (agent && agent.name === 'openclaw') {
          ocStatus = (agent as OpenClawAgent).status();
        }
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
currentConfig = loadConfig(args.config);
if (!currentConfig) {
  // No platform-config.json yet — synthesize one so the agent manager can
  // initialize and the OpenClaw Sessions controls are usable immediately.
  // We do NOT persist this to disk; the first real saveConfig() call from
  // the UI will write the file.
  currentConfig = defaultConfig();
  log('info', 'no config on disk, using default (agentType=openclaw)');
} else {
  log('info', 'config loaded');
}

// Initialize agent manager eagerly so it's ready when Feishu connects OR
// when the user hits the OpenClaw Sessions page.
initAgentManager(currentConfig.agentType).catch((e: any) =>
  log('error', 'initAgentManager:', e.message),
);

server.listen(args.port, '127.0.0.1', () => {
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : args.port;
  process.stdout.write(`FROGCODE_PLATFORM_READY port=${actualPort}\n`);
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
  (async () => {
    try {
      if (agentManager) await agentManager.shutdown();
    } catch {}
    try {
      await cardRenderer.shutdown();
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
