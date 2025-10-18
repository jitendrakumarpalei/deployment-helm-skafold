import { randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';

export interface SignedRequestPayload {
  v: number;
  client_id: string;
  provider: string;
  route_config: Record<string, unknown>;
  virtual_key?: string;
  credential_metadata?: Record<string, unknown>;
  method: string;
  path: string;
  run_id?: string;
  user_id?: string;
  metadata?: Record<string, unknown>;
  body_sha256?: string;
  issued_at: number;
  exp: number;
  nonce: string;
}

const TOKEN_AAD = Buffer.from('stringcost-url-token-v1');
const REQUIRED_VERSION = 1;
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

function base64urlEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function base64urlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

export function resolveUrlTokenKey(): Buffer {
  const secret = process.env.URL_TOKEN_KEY;
  if (!secret) {
    throw new Error('URL_TOKEN_KEY is required to seal signed request tokens');
  }
  const key = (() => {
    try {
      return Buffer.from(secret, 'base64');
    } catch {
      return Buffer.from(secret, 'utf8');
    }
  })();
  if (key.length !== KEY_LENGTH) {
    throw new Error('URL_TOKEN_KEY must decode to 32 bytes (base64-encoded)');
  }
  return key;
}

export function sealSignedRequest(payload: SignedRequestPayload, key: Buffer = resolveUrlTokenKey()): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(TOKEN_AAD, { plaintextLength: undefined });
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${base64urlEncode(iv)}.${base64urlEncode(encrypted)}.${base64urlEncode(tag)}`;
}

export function unsealSignedRequest(token: string, key: Buffer = resolveUrlTokenKey()): SignedRequestPayload {
  const segments = token.split('.');
  if (segments.length !== 3) {
    throw new Error('Malformed signed token');
  }
  const [ivB64, cipherB64, tagB64] = segments;
  const iv = base64urlDecode(ivB64);
  const ciphertext = base64urlDecode(cipherB64);
  const tag = base64urlDecode(tagB64);
  if (iv.length !== IV_LENGTH) {
    throw new Error('Invalid IV length');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAAD(TOKEN_AAD, { plaintextLength: undefined });
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const payload = JSON.parse(decrypted.toString('utf8')) as SignedRequestPayload;
  validatePayload(payload);
  return payload;
}

function validatePayload(payload: SignedRequestPayload): void {
  if (payload.v !== REQUIRED_VERSION) {
    throw new Error(`Unsupported token version: ${payload.v}`);
  }
  if (typeof payload.exp !== 'number' || payload.exp <= 0) {
    throw new Error('Signed token missing exp');
  }
  if (typeof payload.method !== 'string' || typeof payload.path !== 'string') {
    throw new Error('Signed token missing method/path');
  }
  if (typeof payload.client_id !== 'string' || typeof payload.provider !== 'string') {
    throw new Error('Signed token missing client/provider');
  }
  if (!payload.route_config || typeof payload.route_config !== 'object') {
    throw new Error('Signed token missing route_config');
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    throw new Error('Signed token expired');
  }
  if (!payload.nonce) {
    throw new Error('Signed token missing nonce');
  }
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
