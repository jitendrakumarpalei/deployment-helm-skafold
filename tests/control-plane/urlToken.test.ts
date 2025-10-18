import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sealSignedRequest, unsealSignedRequest, resolveUrlTokenKey } from '../../apps/shared/urlToken';

describe('urlToken', () => {
  const key = Buffer.alloc(32, 1);
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.URL_TOKEN_KEY;
    process.env.URL_TOKEN_KEY = key.toString('base64');
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.URL_TOKEN_KEY;
    } else {
      process.env.URL_TOKEN_KEY = originalEnv;
    }
  });

  it('round-trips payloads via seal/unseal', () => {
    const payload = {
      v: 1,
      client_id: 'client-123',
      provider: 'openai',
      route_config: { provider: 'openai', api_key: 'sk-test' },
      method: 'POST',
      path: '/v1/chat/completions',
      issued_at: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
      nonce: 'abc',
    };

    const token = sealSignedRequest(payload, resolveUrlTokenKey());
    const decoded = unsealSignedRequest(token, resolveUrlTokenKey());
    expect(decoded.provider).toBe(payload.provider);
    expect(decoded.route_config).toEqual(payload.route_config);
    expect(decoded.method).toBe('POST');
  });
});
