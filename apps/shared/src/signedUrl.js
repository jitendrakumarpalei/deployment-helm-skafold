import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual, } from 'node:crypto';
const DEFAULT_TTL_SECONDS = Number(process.env.SIGNED_URL_DEFAULT_TTL ?? '60');
const MAX_TTL_SECONDS = Number(process.env.SIGNED_URL_MAX_TTL ?? '600');
const CONFIG_KEY_LENGTH = 32;
const SIGNING_KEY_LENGTH = 32;
const AES_IV_LENGTH = 12;
class MissingEnvError extends Error {
}
function base64urlEncode(buffer) {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}
function base64urlDecode(value) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    return Buffer.from(padded, 'base64');
}
function sha256Base64url(value) {
    return base64urlEncode(createHash('sha256').update(value).digest());
}
function loadSigningKeys() {
    const entries = [];
    const multi = process.env.URL_TOKEN_KEYS;
    const single = process.env.URL_TOKEN_KEY;
    if (multi) {
        for (const part of multi.split(',')) {
            const [kid, keyValue] = part.split(':');
            if (!kid || !keyValue)
                continue;
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
function selectPrimaryKey(keys) {
    const preferred = process.env.URL_TOKEN_PRIMARY_KID;
    if (preferred) {
        const match = keys.find((entry) => entry.kid === preferred);
        if (match)
            return match;
    }
    return keys[0];
}
function loadConfigEncryptionKey() {
    const raw = process.env.URL_TOKEN_CONFIG_KEY ?? process.env.URL_TOKEN_KEY;
    if (!raw) {
        throw new MissingEnvError('URL_TOKEN_CONFIG_KEY (or URL_TOKEN_KEY fallback) must be set');
    }
    let key;
    try {
        key = Buffer.from(raw, 'base64');
    }
    catch {
        key = Buffer.from(raw, 'utf8');
    }
    if (key.length !== CONFIG_KEY_LENGTH) {
        throw new MissingEnvError('Config encryption key must be 32 bytes (base64)');
    }
    return key;
}
function encryptConfig(config) {
    const key = loadConfigEncryptionKey();
    const iv = randomBytes(AES_IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const plaintext = Buffer.from(JSON.stringify(config), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const combined = Buffer.concat([iv, authTag, ciphertext]);
    const hash = sha256Base64url(ciphertext);
    return { ciphertext: base64urlEncode(combined), hash };
}
function decryptConfig(ciphertext) {
    const key = loadConfigEncryptionKey();
    const combined = base64urlDecode(ciphertext);
    if (combined.length < AES_IV_LENGTH + 16) {
        throw new Error('Ciphertext too short');
    }
    const iv = combined.subarray(0, AES_IV_LENGTH);
    const authTag = combined.subarray(AES_IV_LENGTH, AES_IV_LENGTH + 16);
    const payload = combined.subarray(AES_IV_LENGTH + 16);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
}
function canonicalString(input) {
    return [
        input.method,
        input.host,
        input.path,
        input.bodyHash ?? '',
        input.exp,
        input.nonce,
        input.sessionId,
        input.clientId,
        input.provider,
        input.scope ?? '',
        input.cfgHash,
        input.runId ?? '',
        input.userId ?? '',
        input.metadataHash ?? '',
    ].join('\n');
}
function canonicalConfigHash(config) {
    return sha256Base64url(JSON.stringify(config));
}
function coerceTtl(params) {
    const requested = params.expiresIn ?? DEFAULT_TTL_SECONDS;
    return Math.min(Math.max(requested, 1), MAX_TTL_SECONDS);
}
export function createSignedUrl(params) {
    const signingKeys = loadSigningKeys();
    const key = selectPrimaryKey(signingKeys);
    const sessionId = params.sessionId ?? randomUUID();
    const nonce = params.nonce ?? randomUUID();
    const ttl = coerceTtl(params);
    const expiresAt = Math.floor(Date.now() / 1000) + ttl;
    const metadataEncoded = params.metadata ? Buffer.from(JSON.stringify(params.metadata), 'utf8').toString('base64') : undefined;
    const metadataHash = metadataEncoded ? sha256Base64url(metadataEncoded) : undefined;
    const { ciphertext, hash } = encryptConfig(params.routeConfig);
    const canonical = canonicalString({
        method: params.method.toUpperCase(),
        host: params.host,
        path: params.path,
        bodyHash: params.bodyHash,
        exp: expiresAt,
        nonce,
        sessionId,
        clientId: params.clientId,
        provider: params.provider,
        scope: params.scope,
        cfgHash: hash,
        runId: params.runId,
        userId: params.userId,
        metadataHash,
    });
    const signature = createHmac('sha256', key.key).update(canonical, 'utf8').digest();
    const search = new URLSearchParams();
    search.set('kid', key.kid);
    search.set('client', params.clientId);
    search.set('provider', params.provider);
    search.set('method', params.method.toUpperCase());
    search.set('host', params.host);
    search.set('path', params.path);
    search.set('exp', String(expiresAt));
    search.set('nonce', nonce);
    search.set('session', sessionId);
    search.set('cfg', ciphertext);
    search.set('cfg_h', hash);
    if (metadataEncoded)
        search.set('meta', metadataEncoded);
    const bodyHash = params.bodyHash ? params.bodyHash.toLowerCase() : undefined;
    const canonicalBodyHash = bodyHash ? sha256Base64url(bodyHash) : undefined;
    const signaturePayload = canonicalString({
        method: params.method.toUpperCase(),
        host: params.host,
        path: params.path,
        bodyHash: canonicalBodyHash,
        exp: expiresAt,
        nonce,
        sessionId,
        clientId: params.clientId,
        provider: params.provider,
        scope: params.scope,
        cfgHash: hash,
        runId: params.runId,
        userId: params.userId,
        metadataHash,
    });
    const encodedSignaturePayload = Buffer.from(signaturePayload, 'utf8');
    const combinedSignature = Buffer.concat([encodedSignaturePayload, signature]);
    const signatureDigest = createHash('sha256').update(combinedSignature).digest();
    search.set('sig', base64urlEncode(signatureDigest));
    if (params.scope)
        search.set('scope', params.scope);
    if (bodyHash)
        search.set('body', bodyHash);
    if (params.runId)
        search.set('run', params.runId);
    if (params.userId)
        search.set('user', params.userId);
    if (metadataEncoded)
        search.set('meta', metadataEncoded);
    return { params: search, expiresAt, sessionId, nonce };
}
export async function verifySignedRequest(search, request) {
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
    let metadata;
    if (metadataEncoded) {
        const decoded = Buffer.from(metadataEncoded, 'base64');
        metadata = JSON.parse(decoded.toString('utf8'));
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
