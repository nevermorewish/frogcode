/**
 * WeChat (Personal) ilink Gateway Client.
 *
 * Connects to https://ilinkai.weixin.qq.com via HTTP long-polling.
 * Protocol reference: cc-connect/platform/weixin/*.go
 *
 * Features:
 *  - QR-scan login (two-step: get QR → poll status)
 *  - Long-poll getUpdates with cursor persistence
 *  - sendText with 3800-rune chunking
 *  - sendImage / sendFile via CDN + AES-128-ECB encryption
 *  - Download + decrypt inbound media
 *  - Context token persistence per peer
 *  - Message deduplication
 */

import { EventEmitter } from 'node:events';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const CHANNEL_VERSION = 'frogcode-weixin/1.0';

const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;

const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;
// const ITEM_VOICE = 3;
const ITEM_FILE = 4;
// const ITEM_VIDEO = 5;

const MEDIA_TYPE_IMAGE = 1;
// const MEDIA_TYPE_VIDEO = 2;
const MEDIA_TYPE_FILE = 3;

const SESSION_EXPIRED_ERRCODE = -14;
const MAX_CHUNK_RUNES = 3800;
const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const INITIAL_POLL_TIMEOUT_MS = 3000;
const INITIAL_POLL_COUNT = 3;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const SESSION_PAUSE_MS = 60 * 60 * 1000; // 1 hour on errcode -14
const OLD_MESSAGE_THRESHOLD_MS = 2 * 60 * 1000; // skip messages older than 2 min at startup

// ============================================================================
// Types
// ============================================================================

export interface WeChatBotConfig {
  token: string;
  ilinkBotId: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
  routeTag?: string;
  stateDir?: string;
}

export interface WeChatInboundMessage {
  messageId: string;
  fromUserId: string;
  seq: number;
  createTimeMs: number;
  clientId: string;
  text: string;
  imagePaths: string[];    // Downloaded local paths of decrypted images
  filePaths: string[];     // Downloaded local paths of decrypted files
}

interface MessageItem {
  type: number;
  text_item?: { text?: string };
  voice_item?: { text?: string; media?: CdnMedia };
  image_item?: { media?: CdnMedia; aeskey?: string; mid_size?: number };
  file_item?: { media?: CdnMedia; file_name?: string; len?: string };
  video_item?: { media?: CdnMedia };
  ref_msg?: any;
}

interface CdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
}

interface WeixinMessage {
  seq?: number;
  message_id?: number | string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

interface GetUploadUrlResp {
  upload_param?: string;
  thumb_upload_param?: string;
}

export interface QRStatus {
  status: string;         // "wait" | "scaned" | "expired" | "confirmed"
  botToken?: string;
  ilinkBotId?: string;
  ilinkUserId?: string;
  baseUrl?: string;
}

// ============================================================================
// Logger
// ============================================================================

function log(level: string, ...parts: any[]) {
  const msg = parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ');
  try { process.stderr.write(`[wechat ${level}] ${msg}\n`); } catch {}
}

// ============================================================================
// Helpers
// ============================================================================

function randomWechatUIN(): string {
  const b = crypto.randomBytes(4);
  const n = (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3];
  return Buffer.from(String(n >>> 0), 'utf8').toString('base64');
}

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

function md5Hex(buf: Buffer): string {
  return crypto.createHash('md5').update(buf).digest('hex');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(), ms);
    if (signal) {
      const onAbort = () => { clearTimeout(t); reject(new Error('aborted')); };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function splitUtf8(s: string, maxRunes: number): string[] {
  const runes = Array.from(s);
  if (runes.length <= maxRunes) return [s];
  const out: string[] = [];
  for (let i = 0; i < runes.length; i += maxRunes) {
    out.push(runes.slice(i, i + maxRunes).join(''));
  }
  return out;
}

function aesEcbPaddedSize(rawSize: number): number {
  return Math.floor(rawSize / 16) * 16 + 16;
}

// ============================================================================
// AES-128-ECB with PKCS#7 padding
// ============================================================================

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) throw new Error(`aes key must be 16 bytes, got ${key.length}`);
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true); // PKCS#7
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) throw new Error(`aes key must be 16 bytes, got ${key.length}`);
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Parse aes_key field which may be raw 16 bytes in base64, OR base64 of 32-char hex ASCII. */
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64.trim(), 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32) {
    const s = decoded.toString('ascii');
    if (/^[0-9a-fA-F]{32}$/.test(s)) return Buffer.from(s, 'hex');
  }
  throw new Error(`invalid aes_key: got ${decoded.length} bytes after base64 decode`);
}

// ============================================================================
// HTTP request helper (using global fetch, Node 18+)
// ============================================================================

interface RequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: any;                // Will be JSON.stringify'd if not Buffer
  timeoutMs?: number;
  raw?: boolean;             // Return raw Buffer instead of JSON parsing
}

async function doRequest(opts: RequestOptions): Promise<any> {
  const controller = new AbortController();
  const timer = opts.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs) : null;

  const isBuffer = Buffer.isBuffer(opts.body);
  const bodyStr = opts.body != null
    ? (isBuffer ? undefined : JSON.stringify(opts.body))
    : undefined;
  const bodyRaw = isBuffer ? opts.body : undefined;

  try {
    const resp = await fetch(opts.url, {
      method: opts.method,
      headers: opts.headers,
      body: (bodyRaw as any) ?? bodyStr,
      signal: controller.signal,
    });
    if (timer) clearTimeout(timer);
    if (opts.raw) {
      const ab = await resp.arrayBuffer();
      return { status: resp.status, headers: resp.headers, body: Buffer.from(ab) };
    }
    const text = await resp.text();
    if (resp.status >= 400) {
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return { __rawText: text };
    }
  } catch (err: any) {
    if (timer) clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('timeout');
    throw err;
  }
}

function ilinkHeaders(token: string, routeTag?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'Authorization': `Bearer ${token}`,
    'X-WECHAT-UIN': randomWechatUIN(),
  };
  if (routeTag) h['SKRouteTag'] = routeTag;
  return h;
}

// ============================================================================
// QR Login (static helpers)
// ============================================================================

export async function fetchQrCode(
  baseUrl: string = DEFAULT_BASE_URL,
  routeTag?: string,
): Promise<{ qrKey: string; qrUrl: string }> {
  const url = `${baseUrl.replace(/\/$/, '')}/ilink/bot/get_bot_qrcode?bot_type=3`;
  const headers: Record<string, string> = { 'X-WECHAT-UIN': randomWechatUIN() };
  if (routeTag) headers['SKRouteTag'] = routeTag;

  const resp = await doRequest({ method: 'GET', url, headers, timeoutMs: 15000 });
  const qrKey = resp.qrcode;
  const qrUrl = resp.qrcode_img_content;
  if (!qrKey || !qrUrl) throw new Error('invalid QR response');
  return { qrKey, qrUrl };
}

export async function pollQrStatus(
  qrKey: string,
  baseUrl: string = DEFAULT_BASE_URL,
  routeTag?: string,
): Promise<QRStatus> {
  const url = `${baseUrl.replace(/\/$/, '')}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrKey)}`;
  const headers: Record<string, string> = {
    'iLink-App-ClientVersion': '1',
    'X-WECHAT-UIN': randomWechatUIN(),
  };
  if (routeTag) headers['SKRouteTag'] = routeTag;

  const resp = await doRequest({ method: 'GET', url, headers, timeoutMs: 40000 });
  return {
    status: resp.status || '',
    botToken: resp.bot_token,
    ilinkBotId: resp.ilink_bot_id,
    ilinkUserId: resp.ilink_user_id,
    baseUrl: resp.baseurl,
  };
}

// ============================================================================
// WeChatBotClient
// ============================================================================

export class WeChatBotClient extends EventEmitter {
  private readonly token: string;
  readonly ilinkBotId: string;
  private readonly baseUrl: string;
  private readonly cdnBaseUrl: string;
  private readonly routeTag?: string;
  private readonly stateDir: string;
  private readonly mediaTmpDir: string;

  private running = false;
  private cursor = '';
  private pollCount = 0;
  private sessionPausedUntil = 0;
  private consecutiveFailures = 0;
  private abortController: AbortController | null = null;

  /** peerUserId → contextToken */
  private contextTokens = new Map<string, string>();

  /** dedupKey → timestamp */
  private recentMessages = new Map<string, number>();

  /** startup time to filter old messages */
  private startedAt = 0;

  constructor(config: WeChatBotConfig) {
    super();
    this.token = config.token;
    this.ilinkBotId = config.ilinkBotId;
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.cdnBaseUrl = (config.cdnBaseUrl || DEFAULT_CDN_BASE_URL).replace(/\/$/, '');
    this.routeTag = config.routeTag;

    const home = process.env.HOME || process.env.USERPROFILE || '';
    const baseStateDir = config.stateDir || path.join(home, '.frogcode', 'wechat-state');
    this.stateDir = path.join(baseStateDir, this.sanitizePathSegment(this.ilinkBotId));
    this.mediaTmpDir = path.join(
      process.env.TEMP || process.env.TMPDIR || '/tmp',
      'frogcode-wechat-media',
    );

    try { fs.mkdirSync(this.stateDir, { recursive: true }); } catch {}
    try { fs.mkdirSync(this.mediaTmpDir, { recursive: true }); } catch {}

    this.loadState();
    this.setMaxListeners(20);
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this.abortController = new AbortController();
    log('info', `starting bot=${this.ilinkBotId.slice(0, 16)}`);
    // Fire-and-forget the poll loop
    void this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async sendText(peerId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const chunks = splitUtf8(trimmed, MAX_CHUNK_RUNES);
    for (const chunk of chunks) {
      await this.doSendMessage(peerId, [{
        type: ITEM_TEXT,
        text_item: { text: chunk },
      }]);
    }
  }

  async sendImage(peerId: string, imagePath: string): Promise<void> {
    const plaintext = fs.readFileSync(imagePath);
    const uploaded = await this.uploadMedia(peerId, plaintext, MEDIA_TYPE_IMAGE);
    await this.doSendMessage(peerId, [{
      type: ITEM_IMAGE,
      image_item: {
        media: {
          encrypt_query_param: uploaded.downloadParam,
          aes_key: uploaded.aesKeyBase64,
          encrypt_type: 1,
        },
        mid_size: uploaded.cipherSize,
      },
    }]);
  }

  async sendFile(peerId: string, filePath: string, fileName: string): Promise<void> {
    const plaintext = fs.readFileSync(filePath);
    const uploaded = await this.uploadMedia(peerId, plaintext, MEDIA_TYPE_FILE);
    await this.doSendMessage(peerId, [{
      type: ITEM_FILE,
      file_item: {
        media: {
          encrypt_query_param: uploaded.downloadParam,
          aes_key: uploaded.aesKeyBase64,
          encrypt_type: 1,
        },
        file_name: fileName,
        len: String(uploaded.rawSize),
      },
    }]);
  }

  // --------------------------------------------------------------------------
  // Poll loop
  // --------------------------------------------------------------------------

  private async pollLoop(): Promise<void> {
    while (this.running) {
      // Check session pause
      const now = Date.now();
      if (this.sessionPausedUntil > now) {
        await sleep(Math.min(this.sessionPausedUntil - now, 60000), this.abortController?.signal);
        continue;
      }

      const timeoutMs = this.pollCount < INITIAL_POLL_COUNT
        ? INITIAL_POLL_TIMEOUT_MS
        : DEFAULT_LONG_POLL_TIMEOUT_MS;
      this.pollCount++;

      try {
        const resp = await this.getUpdates(timeoutMs + 5000); // http timeout slightly above server timeout
        this.consecutiveFailures = 0;

        if (resp.errcode === SESSION_EXPIRED_ERRCODE) {
          log('warn', `session expired, pausing ${SESSION_PAUSE_MS / 60000}min`);
          this.sessionPausedUntil = Date.now() + SESSION_PAUSE_MS;
          this.emit('error', new Error('session expired'));
          continue;
        }

        if (resp.get_updates_buf) {
          this.cursor = resp.get_updates_buf;
          this.saveCursor();
        }

        for (const raw of resp.msgs || []) {
          try {
            await this.processInbound(raw);
          } catch (err: any) {
            log('error', `processInbound: ${err.message}`);
          }
        }
      } catch (err: any) {
        if (!this.running) break;
        if (err.message === 'aborted') break;
        // timeout is expected for long-poll — treat as empty response, not failure
        if (err.message === 'timeout') {
          continue;
        }
        this.consecutiveFailures++;
        log('warn', `getUpdates failed (${this.consecutiveFailures}): ${err.message}`);
        const delay = this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
          ? BACKOFF_DELAY_MS
          : RETRY_DELAY_MS;
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) this.consecutiveFailures = 0;
        await sleep(delay, this.abortController?.signal);
      }
    }
    log('info', 'poll loop exited');
  }

  private async getUpdates(timeoutMs: number): Promise<GetUpdatesResp> {
    const url = `${this.baseUrl}/ilink/bot/getupdates`;
    const body = {
      get_updates_buf: this.cursor,
      base_info: { channel_version: CHANNEL_VERSION },
    };
    return await doRequest({
      method: 'POST',
      url,
      headers: ilinkHeaders(this.token, this.routeTag),
      body,
      timeoutMs,
    });
  }

  // --------------------------------------------------------------------------
  // Inbound message processing
  // --------------------------------------------------------------------------

  private async processInbound(raw: WeixinMessage): Promise<void> {
    const fromUserId = raw.from_user_id || '';
    const messageId = String(raw.message_id || '');
    const seq = Number(raw.seq || 0);
    const createTimeMs = Number(raw.create_time_ms || 0);
    const clientId = (raw.client_id || '').trim();

    if (!fromUserId || !messageId) return;

    // Filter our own messages
    if (raw.message_type === MSG_TYPE_BOT) return;

    // Old message filter (startup)
    if (createTimeMs > 0 && createTimeMs < this.startedAt - OLD_MESSAGE_THRESHOLD_MS) {
      log('debug', `skip old msg create=${createTimeMs}`);
      return;
    }

    // Dedup
    const dedupKey = `${fromUserId}|${messageId}|${seq}|${createTimeMs}|${clientId}`;
    if (this.recentMessages.has(dedupKey)) return;
    this.recentMessages.set(dedupKey, Date.now());
    this.pruneDedup();

    // Update context token
    if (raw.context_token) {
      this.contextTokens.set(fromUserId, raw.context_token);
      this.saveContextTokens();
    }

    // Extract text + media
    const parsed = await this.parseItems(raw.item_list || []);
    if (!parsed.text && parsed.imagePaths.length === 0 && parsed.filePaths.length === 0) return;

    const msg: WeChatInboundMessage = {
      messageId,
      fromUserId,
      seq,
      createTimeMs,
      clientId,
      text: parsed.text,
      imagePaths: parsed.imagePaths,
      filePaths: parsed.filePaths,
    };

    this.emit('message', msg);
  }

  private async parseItems(items: MessageItem[]): Promise<{ text: string; imagePaths: string[]; filePaths: string[] }> {
    let text = '';
    const imagePaths: string[] = [];
    const filePaths: string[] = [];

    for (const item of items) {
      if (item.type === ITEM_TEXT && item.text_item?.text) {
        text = item.text_item.text;
      } else if (item.type === 3 /* voice */ && item.voice_item?.text) {
        // Use ASR transcript if available
        if (!text) text = item.voice_item.text;
      } else if (item.type === ITEM_IMAGE && item.image_item?.media) {
        const p = await this.downloadAndDecryptMedia(item.image_item.media, '.jpg').catch((e) => {
          log('warn', `image download failed: ${e.message}`);
          return null;
        });
        if (p) imagePaths.push(p);
      } else if (item.type === ITEM_FILE && item.file_item?.media) {
        const name = item.file_item.file_name || `file-${randomHex(4)}`;
        const ext = path.extname(name) || '.bin';
        const p = await this.downloadAndDecryptMedia(item.file_item.media, ext, name).catch((e) => {
          log('warn', `file download failed: ${e.message}`);
          return null;
        });
        if (p) filePaths.push(p);
      }
    }

    return { text, imagePaths, filePaths };
  }

  private async downloadAndDecryptMedia(media: CdnMedia, extHint: string, nameHint?: string): Promise<string | null> {
    if (!media.encrypt_query_param || !media.aes_key) return null;

    const url = `${this.cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
    const resp = await doRequest({
      method: 'GET',
      url,
      headers: { 'X-WECHAT-UIN': randomWechatUIN() },
      timeoutMs: 30000,
      raw: true,
    });
    const ciphertext: Buffer = resp.body;
    const key = parseAesKey(media.aes_key);
    const plaintext = decryptAesEcb(ciphertext, key);

    const fname = nameHint || `media-${Date.now()}-${randomHex(3)}${extHint}`;
    const out = path.join(this.mediaTmpDir, fname);
    fs.writeFileSync(out, plaintext);
    return out;
  }

  // --------------------------------------------------------------------------
  // Outbound: sendMessage + CDN upload
  // --------------------------------------------------------------------------

  private async doSendMessage(peerId: string, items: MessageItem[]): Promise<void> {
    const contextToken = this.contextTokens.get(peerId) || '';
    const url = `${this.baseUrl}/ilink/bot/sendmessage`;
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: peerId,
        client_id: 'fc-' + randomHex(6),
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: items,
        context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    };
    const resp = await doRequest({
      method: 'POST',
      url,
      headers: ilinkHeaders(this.token, this.routeTag),
      body,
      timeoutMs: 30000,
    });
    if (resp.ret !== 0 && resp.errcode && resp.errcode !== 0) {
      throw new Error(`sendmessage failed: ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg || ''}`);
    }
  }

  private async uploadMedia(peerId: string, plaintext: Buffer, mediaType: number): Promise<{
    downloadParam: string;
    aesKeyBase64: string;
    rawSize: number;
    cipherSize: number;
  }> {
    const aesKey = crypto.randomBytes(16);
    const filekey = randomHex(16);
    const rawSize = plaintext.length;
    const rawMd5 = md5Hex(plaintext);
    const cipherSize = aesEcbPaddedSize(rawSize);

    // Step 1: request upload URL
    const urlBody = {
      filekey,
      media_type: mediaType,
      to_user_id: peerId,
      rawsize: rawSize,
      rawfilemd5: rawMd5,
      filesize: cipherSize,
      no_need_thumb: true,
      aeskey: aesKey.toString('hex'),
      base_info: { channel_version: CHANNEL_VERSION },
    };
    const urlResp: GetUploadUrlResp = await doRequest({
      method: 'POST',
      url: `${this.baseUrl}/ilink/bot/getuploadurl`,
      headers: ilinkHeaders(this.token, this.routeTag),
      body: urlBody,
      timeoutMs: 30000,
    });
    if (!urlResp.upload_param) throw new Error('getuploadurl: no upload_param');

    // Step 2: encrypt
    const ciphertext = encryptAesEcb(plaintext, aesKey);

    // Step 3: upload to CDN
    const cdnUrl = `${this.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(urlResp.upload_param)}&filekey=${encodeURIComponent(filekey)}`;
    const cdnResp = await doRequest({
      method: 'POST',
      url: cdnUrl,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-WECHAT-UIN': randomWechatUIN(),
      },
      body: ciphertext,
      timeoutMs: 60000,
      raw: true,
    });
    const downloadParam = cdnResp.headers.get('x-encrypted-param') || cdnResp.headers.get('X-Encrypted-Param');
    if (!downloadParam) throw new Error('CDN upload: missing x-encrypted-param header');

    return {
      downloadParam,
      aesKeyBase64: aesKey.toString('base64'),
      rawSize,
      cipherSize,
    };
  }

  // --------------------------------------------------------------------------
  // State persistence
  // --------------------------------------------------------------------------

  private cursorFile(): string { return path.join(this.stateDir, 'cursor.txt'); }
  private ctxFile(): string { return path.join(this.stateDir, 'context_tokens.json'); }

  private loadState(): void {
    try {
      if (fs.existsSync(this.cursorFile())) {
        this.cursor = fs.readFileSync(this.cursorFile(), 'utf8').trim();
      }
    } catch {}
    try {
      if (fs.existsSync(this.ctxFile())) {
        const data = JSON.parse(fs.readFileSync(this.ctxFile(), 'utf8'));
        if (data && typeof data === 'object') {
          for (const [k, v] of Object.entries(data)) {
            if (typeof v === 'string') this.contextTokens.set(k, v);
          }
        }
      }
    } catch {}
  }

  private saveCursor(): void {
    try {
      fs.writeFileSync(this.cursorFile(), this.cursor, { mode: 0o600 });
    } catch (e: any) {
      log('warn', `saveCursor: ${e.message}`);
    }
  }

  private saveContextTokens(): void {
    try {
      const obj: Record<string, string> = {};
      for (const [k, v] of this.contextTokens) obj[k] = v;
      fs.writeFileSync(this.ctxFile(), JSON.stringify(obj), { mode: 0o600 });
    } catch (e: any) {
      log('warn', `saveContextTokens: ${e.message}`);
    }
  }

  private pruneDedup(): void {
    if (this.recentMessages.size < 200) return;
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    for (const [k, ts] of this.recentMessages) {
      if (ts < cutoff) this.recentMessages.delete(k);
    }
  }

  private sanitizePathSegment(s: string): string {
    return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'default';
  }
}
