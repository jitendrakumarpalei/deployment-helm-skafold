import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSignedUrl, verifySignedRequest } from '@stringcost/shared/signedUrl';

describe('signedUrl', () => {
  const key = Buffer.alloc(32, 1).toString('base64');
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.URL_TOKEN_KEY;
    process.env.URL_TOKEN_KEY = key;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.URL_TOKEN_KEY;
    } else {
      process.env.URL_TOKEN_KEY = originalKey;
    }
  });

  it('round-trips signed parameters', async () => {
    const signed = createSignedUrl({
      method: 'POST',
      host: 'api.stringcost.com',
      path: '/v1/chat/completions',
      clientId: 'client-123',
      provider: 'openai',
      runId: 'run-1',
      userId: 'user-7',
      metadata: { tier: 'test' },
      routeConfig: { provider: 'openai', api_key: 'sk-test' },
    });

    const verified = await verifySignedRequest(signed.params, {
      method: 'POST',
      host: 'api.stringcost.com',
      path: '/v1/chat/completions',
    });

    expect(verified.provider).toBe('openai');
    expect(verified.clientId).toBe('client-123');
    expect(verified.runId).toBe('run-1');
    expect(verified.userId).toBe('user-7');
    expect(verified.metadata).toEqual({ tier: 'test' });
    expect(verified.routeConfig.api_key).toBe('sk-test');
  });
});
