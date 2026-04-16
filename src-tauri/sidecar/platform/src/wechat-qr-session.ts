/**
 * WeChat QR Login Session Manager.
 *
 * Tracks active QR login flows with TTL-based cleanup.
 * Each session has a sessionKey that the client uses to poll.
 */

import * as crypto from 'node:crypto';
import { fetchQrCode, pollQrStatus, DEFAULT_BASE_URL } from './wechat-bot.js';

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 min
const MAX_QR_REFRESHES = 3;
const POLL_INTERVAL_MS = 1000;
const DEFAULT_WAIT_TIMEOUT_MS = 8 * 60 * 1000; // 8 min

interface ActiveSession {
  sessionKey: string;
  qrKey: string;
  qrUrl: string;
  baseUrl: string;
  createdAt: number;
  aborted: boolean;
}

const sessions = new Map<string, ActiveSession>();

function log(level: string, ...parts: any[]) {
  const msg = parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ');
  try { process.stderr.write(`[wechat-qr ${level}] ${msg}\n`); } catch {}
}

function purgeExpired(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [k, s] of sessions) {
    if (s.createdAt < cutoff) sessions.delete(k);
  }
}

export async function startQrLogin(baseUrl?: string): Promise<{ sessionKey: string; qrUrl: string }> {
  purgeExpired();
  const actualBase = baseUrl || DEFAULT_BASE_URL;
  const { qrKey, qrUrl } = await fetchQrCode(actualBase);
  const sessionKey = crypto.randomBytes(16).toString('hex');
  sessions.set(sessionKey, {
    sessionKey,
    qrKey,
    qrUrl,
    baseUrl: actualBase,
    createdAt: Date.now(),
    aborted: false,
  });
  log('info', `started sessionKey=${sessionKey.slice(0, 8)} qrKey=${qrKey.slice(0, 12)}`);
  return { sessionKey, qrUrl };
}

export interface QrWaitResult {
  confirmed: boolean;
  botToken?: string;
  ilinkBotId?: string;
  ilinkUserId?: string;
  baseUrl?: string;
  error?: string;
  qrUrl?: string;         // Included when QR was refreshed
}

export async function waitQrLogin(sessionKey: string, timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS): Promise<QrWaitResult> {
  const session = sessions.get(sessionKey);
  if (!session) return { confirmed: false, error: 'session not found' };

  const deadline = Date.now() + timeoutMs;
  let refreshCount = 0;

  while (Date.now() < deadline) {
    if (session.aborted) return { confirmed: false, error: 'aborted' };

    try {
      const status = await pollQrStatus(session.qrKey, session.baseUrl);

      if (status.status === 'confirmed') {
        if (!status.botToken || !status.ilinkBotId) {
          return { confirmed: false, error: 'confirmed but missing token/bot_id' };
        }
        sessions.delete(sessionKey);
        return {
          confirmed: true,
          botToken: status.botToken,
          ilinkBotId: status.ilinkBotId,
          ilinkUserId: status.ilinkUserId,
          baseUrl: status.baseUrl || session.baseUrl,
        };
      }

      if (status.status === 'expired') {
        if (refreshCount >= MAX_QR_REFRESHES) {
          sessions.delete(sessionKey);
          return { confirmed: false, error: 'QR expired (max refreshes)' };
        }
        refreshCount++;
        log('info', `QR expired, refreshing (${refreshCount}/${MAX_QR_REFRESHES})`);
        try {
          const fresh = await fetchQrCode(session.baseUrl);
          session.qrKey = fresh.qrKey;
          session.qrUrl = fresh.qrUrl;
          // Let client know by returning qrUrl — but first call returns immediately
          return {
            confirmed: false,
            qrUrl: fresh.qrUrl,
            error: 'refreshed',
          };
        } catch (err: any) {
          return { confirmed: false, error: `refresh failed: ${err.message}` };
        }
      }
      // wait / scaned → keep polling
    } catch (err: any) {
      log('warn', `poll failed: ${err.message}`);
      // Keep trying on transient errors
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  sessions.delete(sessionKey);
  return { confirmed: false, error: 'timeout' };
}

export function cancelQrLogin(sessionKey: string): boolean {
  const session = sessions.get(sessionKey);
  if (!session) return false;
  session.aborted = true;
  sessions.delete(sessionKey);
  log('info', `cancelled sessionKey=${sessionKey.slice(0, 8)}`);
  return true;
}

export function getActiveSession(sessionKey: string): { qrUrl: string } | null {
  const s = sessions.get(sessionKey);
  return s ? { qrUrl: s.qrUrl } : null;
}
