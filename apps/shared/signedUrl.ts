import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_SECONDS = Number(process.env.SIGNED_URL_DEFAULT_TTL ?? '60');
const MAX_TTL_SECONDS = Number(process.env.SIGNED_URL_MAX_TTL ?? '600');

const CONFIG_KEY_LENGTH = 32;
const SIGNING_KEY_LENGTH = 32;
const AES_IV_LENGTH = 12;

export interface SigningKey {
  kid: string;
  key: Buffer;
}

export interface PresignConfig {
  method: string;
  host: string;
  path: string;
  bodyHash?: string;
  clientId: string;
  provider: string;
  scope?: string;
  sessionId?: string;
  runId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  nonce?: string;
  expiresIn?: number;
  routeConfig: Record<string, unknown>;
}

export interface SignedUrlComponents {
  params: URLSearchParams;
  expiresAt: number;
  sessionId: string;
  nonce: string;
}

export interface VerifiedSignedRequest {
  clientId: string;
  provider: string;
  scope?: string;
  sessionId: string;
  nonce: string;
  runId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  bodyHash?: string;
  expiresAt: number;
  routeConfig: Record<string, unknown>;
}

class MissingEnvError extends Error {}

function base64urlEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function base64urlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function sha256Base64url(value: string | Buffer): string {
  return base64urlEncode(createHash('sha256').update(value).digest());
}

function loadSigningKeys(): SigningKey[] {
  const entries: SigningKey[] = [];
  const multi = process.env.URL_TOKEN_KEYS;
  const single = process.env.URL_TOKEN_KEY;

  if (multi) {
    for (const part of multi.split(',')) {
      const [kid, keyValue] = part.split(':');
      if (!kid || !keyValue) continue;
      const key = Buffer.from(keyValue, 'base64');
      if (key.length !== SIGNING_KEY_LENGTH) {
        throw new MissingEnvError(`Signing key for kid ${kid} must be 32 bytes base64`);
      }
      entries.push({ kid, key });
    }
  }

  if (!entries.length && single) {
    const key = Buffer.from(single, 'base64');
    if (key.length !== SIGNING_KEY_LENGTH) {
      throw new MissingEnvError('URL_TOKEN_KEY must decode to 32 bytes');
    }
    entries.push({ kid: 'default', key });
  }

  if (!entries.length) {
    throw new MissingEnvError('URL_TOKEN_KEYS or URL_TOKEN_KEY must be configured');
  }

  return entries;
}

function selectPrimaryKey(keys: SigningKey[]): SigningKey {
  const preferred = process.env.URL_TOKEN_PRIMARY_KID;
  if (preferred) {
    const match = keys.find((entry) => entry.kid === preferred);
    if (match) return match;
  }
  return keys[0];
}

function loadConfigEncryptionKey(): Buffer {
  const raw = process.env.URL_TOKEN_CONFIG_KEY ?? process.env.URL_TOKEN_KEY;
  if (!raw) {
    throw new MissingEnvError('URL_TOKEN_CONFIG_KEY (or URL_TOKEN_KEY fallback) must be set');
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    key = Buffer.from(raw, 'utf8');
  }
  if (key.length !== CONFIG_KEY_LENGTH) {
    throw new MissingEnvError('Config encryption key must be 32 bytes (base64)');
  }
  return key;
}

function encryptConfig(config: Record<string, unknown>): { ciphertext: string; hash: string } {
  const key = loadConfigEncryptionKey();
  const iv = randomBytes(AES_IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const plaintext = Buffer.from(JSON.stringify(config), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, encrypted]);
  const cipherText = base64urlEncode(payload);
  return { ciphertext: cipherText, hash: sha256Base64url(cipherText) };
}

function decryptConfig(ciphertext: string): Record<string, unknown> {
  const key = loadConfigEncryptionKey();
  const payload = base64urlDecode(ciphertext);
  if (payload.length <= AES_IV_LENGTH + 16) {
    throw new Error('Encrypted config payload too short');
  }
  const iv = payload.subarray(0, AES_IV_LENGTH);
  const tag = payload.subarray(AES_IV_LENGTH, AES_IV_LENGTH + 16);
  const encrypted = payload.subarray(AES_IV_LENGTH + 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

function clampExpiry(expiresIn?: number): { expiresAt: number; ttl: number } {
  const base = Number.isFinite(expiresIn) ? Number(expiresIn) : DEFAULT_TTL_SECONDS;
  const ttl = Math.max(1, Math.min(base, MAX_TTL_SECONDS));
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  return { expiresAt, ttl };
}

function canonicalString(params: {
  method: string;
  host: string;
  path: string;
  bodyHash?: string;
  exp: number;
  nonce: string;
  sessionId: string;
  clientId: string;
  provider: string;
  scope?: string;
  cfgHash: string;
  runId?: string;
  userId?: string;
  metadataHash?: string;
}): string {
  return [
    params.method,
    params.host,
    params.path,
    params.bodyHash ?? '',
    String(params.exp),
    params.nonce,
    params.sessionId,
    params.clientId,
    params.provider,
    params.scope ?? '',
    params.cfgHash,
    params.runId ?? '',
    params.userId ?? '',
    params.metadataHash ?? '',
  ].join('\n');
}

function generateSessionId(): string {
  // TODO: replace with UUIDv7 when Node provides native support.
  return randomUUID();
}

export function createSignedUrl(params: PresignConfig): SignedUrlComponents {
  const keys = loadSigningKeys();
  const signingKey = selectPrimaryKey(keys);
  const { expiresAt } = clampExpiry(params.expiresIn);
  const sessionId = params.sessionId ?? generateSessionId();
  const nonce = params.nonce ?? randomUUID();

  const { ciphertext: cfgCipher, hash: cfgHash } = encryptConfig(params.routeConfig);

  const metadataString = params.metadata ? JSON.stringify(params.metadata) : '';
  const metadataEncoded = metadataString ? base64urlEncode(Buffer.from(metadataString, 'utf8')) : undefined;
  const metadataHash = metadataEncoded ? sha256Base64url(metadataEncoded) : undefined;

  const bodyHash = params.bodyHash ? params.bodyHash.toLowerCase() : undefined;

  const canonical = canonicalString({
    method: params.method.toUpperCase(),
    host: params.host,
    path: params.path,
    bodyHash,
    exp: expiresAt,
    nonce,
    sessionId,
    clientId: params.clientId,
    provider: params.provider,
    scope: params.scope,
    cfgHash,
    runId: params.runId,
    userId: params.userId,
    metadataHash,
  });

  const signature = createHmac('sha256', signingKey.key)
    .update(canonical, 'utf8')
    .digest();

  const search = new URLSearchParams();
  search.set('kid', signingKey.kid);
  search.set('client', params.clientId);
  search.set('provider', params.provider);
  search.set('method', params.method.toUpperCase());
  search.set('host', params.host);
  search.set('path', params.path);
  search.set('exp', String(expiresAt));
  search.set('nonce', nonce);
  search.set('session', sessionId);
  search.set('cfg', cfgCipher);
  search.set('cfg_h', cfgHash);
  search.set('sig', base64urlEncode(signature));

  if (params.scope) search.set('scope', params.scope);
  if (bodyHash) search.set('body', bodyHash);
  if (params.runId) search.set('run', params.runId);
  if (params.userId) search.set('user', params.userId);
  if (metadataEncoded) search.set('meta', metadataEncoded);

  return { params: search, expiresAt, sessionId, nonce };
}

export interface VerificationOptions {
  method: string;
  host: string;
  path: string;
  bodyHash?: string;
}

export async function verifySignedRequest(
  search: URLSearchParams,
  request: VerificationOptions
): Promise<VerifiedSignedRequest> {
  const keys = loadSigningKeys();
  const keyMap = new Map(keys.map((entry) => [entry.kid, entry]));

  const kid = search.get('kid');
  const entry = kid ? keyMap.get(kid) : undefined;
  if (!entry) {
    throw new Error('Unknown signing key');
  }

  const method = (search.get('method') ?? '').toUpperCase();
  const host = search.get('host') ?? '';
  const path = search.get('path') ?? '';
  const exp = Number(search.get('exp'));
  const nonce = search.get('nonce') ?? '';
  const sessionId = search.get('session') ?? '';
  const clientId = search.get('client') ?? '';
  const provider = search.get('provider') ?? '';
  const scope = search.get('scope') ?? undefined;
  const cfgCipher = search.get('cfg');
  const cfgHash = search.get('cfg_h');
  const runId = search.get('run') ?? undefined;
  const userId = search.get('user') ?? undefined;
  const metadataEncoded = search.get('meta') ?? undefined;
  const signature = search.get('sig');
  const bodyHash = search.get('body') ?? undefined;

  if (!method || !host || !path || !exp || !nonce || !sessionId || !clientId || !provider || !cfgCipher || !cfgHash || !signature) {
    throw new Error('Signed URL missing required parameters');
  }

  const metadataHash = metadataEncoded ? sha256Base64url(metadataEncoded) : undefined;
  const canonical = canonicalString({
    method,
    host,
    path,
    bodyHash,
    exp,
    nonce,
    sessionId,
    clientId,
    provider,
    scope,
    cfgHash,
    runId,
    userId,
    metadataHash,
  });

  const expectedSignature = createHmac('sha256', entry.key).update(canonical, 'utf8').digest();
  const providedSig = base64urlDecode(signature);
  if (expectedSignature.length !== providedSig.length || !timingSafeEqual(expectedSignature, providedSig)) {
    throw new Error('Invalid signature');
  }

  const now = Math.floor(Date.now() / 1000);
  if (exp < now) {
    throw new Error('Signed URL expired');
  }

  if (request.method.toUpperCase() !== method) {
    throw new Error('HTTP method mismatch');
  }
  if (host && host !== request.host) {
    const [expectedHost, expectedPort] = host.split(':');
    const [actualHost, actualPort] = request.host.split(':');
    if (expectedHost !== actualHost) {
      throw new Error('Host mismatch');
    }
    if (expectedPort && expectedPort !== actualPort) {
      throw new Error('Host mismatch');
    }
  }
  if (path !== request.path) {
    throw new Error('Path mismatch');
  }

  if (bodyHash) {
    if (!request.bodyHash) {
      throw new Error('Body hash expected but no body provided');
    }
    if (request.bodyHash.toLowerCase() !== bodyHash.toLowerCase()) {
      throw new Error('Request body hash mismatch');
    }
  }

  const routeConfig = decryptConfig(cfgCipher);
  let metadata: Record<string, unknown> | undefined;
  if (metadataEncoded) {
    const decoded = Buffer.from(metadataEncoded, 'base64');
    metadata = JSON.parse(decoded.toString('utf8')) as Record<string, unknown>;
  }

  return {
    clientId,
    provider,
    scope,
    sessionId,
    nonce,
    runId,
    userId,
    metadata,
    bodyHash,
    expiresAt: exp,
    routeConfig,
  };
}
