/**
 * OpenClaw device identity — Ed25519 keypair + challenge-response signing.
 * Ported from nexu/openclaw-ws-client.ts (lines 20-264).
 *
 * Uses Node's built-in `crypto` (no external deps) matching OpenClaw protocol v3.
 * Keys are stored at {stateDir}/identity/device.json with mode 0o600.
 */

import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/g, '');
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const spki = crypto
    .createPublicKey(publicKeyPem)
    .export({ type: 'spki', format: 'der' });
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

export function fingerprintPublicKey(publicKeyPem: string): string {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

export function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  return base64UrlEncode(
    crypto.sign(null, Buffer.from(payload, 'utf8'), key) as unknown as Buffer,
  );
}

/**
 * v3 auth payload format:
 *   v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily
 */
export function buildDeviceAuthPayloadV3(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string;
  nonce: string;
  platform: string;
  deviceFamily?: string;
}): string {
  return [
    'v3',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAtMs),
    params.token,
    params.nonce,
    params.platform.trim().toLowerCase(),
    (params.deviceFamily ?? '').trim().toLowerCase(),
  ].join('|');
}

// ---------------------------------------------------------------------------
// Identity file I/O
// ---------------------------------------------------------------------------

export function loadOrCreateDeviceIdentity(stateDir: string): DeviceIdentity {
  const filePath = path.join(stateDir, 'identity', 'device.json');
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (
        parsed?.version === 1 &&
        typeof parsed.deviceId === 'string' &&
        typeof parsed.publicKeyPem === 'string' &&
        typeof parsed.privateKeyPem === 'string'
      ) {
        const derivedId = fingerprintPublicKey(parsed.publicKeyPem as string);
        return {
          deviceId: derivedId,
          publicKeyPem: parsed.publicKeyPem as string,
          privateKeyPem: parsed.privateKeyPem as string,
        };
      }
    }
  } catch {
    // fall through to generation
  }

  // Generate new Ed25519 keypair
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const deviceId = fingerprintPublicKey(publicKeyPem);

  const stored = {
    version: 1,
    deviceId,
    publicKeyPem,
    privateKeyPem,
    createdAtMs: Date.now(),
  };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // ignore chmod failure on Windows
  }

  return { deviceId, publicKeyPem, privateKeyPem };
}

// ---------------------------------------------------------------------------
// Device-token store ({stateDir}/identity/device-auth.json)
// ---------------------------------------------------------------------------

interface DeviceAuthStore {
  version: 1;
  deviceId: string;
  tokens: Record<
    string,
    { token: string; role: string; scopes: string[]; updatedAtMs: number }
  >;
}

function authPath(stateDir: string): string {
  return path.join(stateDir, 'identity', 'device-auth.json');
}

function readStore(filePath: string): DeviceAuthStore | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== 1 || typeof parsed.deviceId !== 'string') return null;
    if (!parsed.tokens || typeof parsed.tokens !== 'object') return null;
    return parsed as unknown as DeviceAuthStore;
  } catch {
    return null;
  }
}

function writeStore(filePath: string, store: DeviceAuthStore): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // ignore
  }
}

export function loadStoredDeviceToken(params: {
  stateDir: string;
  deviceId: string;
  role: string;
}): string | null {
  const store = readStore(authPath(params.stateDir));
  if (!store || store.deviceId !== params.deviceId) return null;
  const entry = store.tokens[params.role];
  return entry?.token?.trim() || null;
}

export function storeDeviceToken(params: {
  stateDir: string;
  deviceId: string;
  role: string;
  token: string;
  scopes: string[];
}): void {
  const fp = authPath(params.stateDir);
  const existing = readStore(fp);
  const next: DeviceAuthStore = {
    version: 1,
    deviceId: params.deviceId,
    tokens:
      existing && existing.deviceId === params.deviceId ? { ...existing.tokens } : {},
  };
  next.tokens[params.role] = {
    token: params.token,
    role: params.role,
    scopes: [...new Set(params.scopes.map((s) => s.trim()).filter(Boolean))].sort(),
    updatedAtMs: Date.now(),
  };
  writeStore(fp, next);
}

export function clearStoredDeviceToken(params: {
  stateDir: string;
  deviceId: string;
  role: string;
}): void {
  const fp = authPath(params.stateDir);
  const existing = readStore(fp);
  if (!existing || existing.deviceId !== params.deviceId) return;
  if (!existing.tokens[params.role]) return;
  const next: DeviceAuthStore = {
    version: 1,
    deviceId: existing.deviceId,
    tokens: { ...existing.tokens },
  };
  delete next.tokens[params.role];
  writeStore(fp, next);
}
