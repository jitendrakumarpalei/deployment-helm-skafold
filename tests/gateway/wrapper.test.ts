import { Buffer } from 'node:buffer';
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import app from '../../apps/gateway/src/app';
import portkeyApp from '../../vendor/portkey-gateway/src/index';
import { createSignedUrl } from '@stringcost/shared/signedUrl';

let portkeyFetchSpy: ReturnType<typeof vi.spyOn> | undefined;
let forwardedRequest: Request | undefined;
const originalEnv = process.env.URL_TOKEN_KEY;
const urlTokenKey = Buffer.alloc(32, 3).toString('base64');

describe('StringCost Gateway Wrapper', () => {
  beforeEach(() => {
    forwardedRequest = undefined;
    process.env.URL_TOKEN_KEY = urlTokenKey;
    process.env.GATEWAY_BASE_URL = 'http://test';
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.URL_TOKEN_KEY;
    } else {
      process.env.URL_TOKEN_KEY = originalEnv;
    }
    portkeyFetchSpy?.mockRestore();
    portkeyFetchSpy = undefined;
    vi.restoreAllMocks();
  });

  it('validates signed token and forwards requests to Portkey', async () => {
    portkeyFetchSpy = vi
      .spyOn(portkeyApp, 'fetch')
      .mockImplementation(async (request) => {
        forwardedRequest = request as Request;
        return new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content: 'wrapper-ok' }
              }
            ]
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-portkey-request-id': 'abc123'
            }
          }
        );
      });

    const signed = createSignedUrl({
      method: 'POST',
      host: 'test',
      path: '/v1/chat/completions',
      clientId: 'client-1',
      provider: 'openai',
      runId: 'run-123',
      userId: 'user-456',
      metadata: { tier: 'gold' },
      routeConfig: { provider: 'openai', api_key: 'sk-openai-real' }
    });

    const url = new URL('http://test/llm/v1/chat/completions');
    signed.params.forEach((value, key) => url.searchParams.set(key, value));

    const response = await app.request(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer stringcost-test-key'
      },
      body: JSON.stringify({
        model: 'fake-model',
        messages: [{ role: 'user', content: 'ping' }]
      })
    });

    expect(response.status).toBe(200);

    expect(forwardedRequest).toBeDefined();
    const forwarded = forwardedRequest!;
    const forwardedUrl = new URL(forwarded.url);
    expect(forwardedUrl.searchParams.get('token')).toBeNull();
    expect(forwarded.headers.get('x-portkey-provider')).toBe('openai');
    expect(forwarded.headers.get('authorization')).toBe('Bearer stringcost-test-key');
    expect(forwarded.headers.get('x-portkey-config')).toBeTruthy();
    expect(forwarded.headers.get('x-stringcost-run-id')).toBe('run-123');
  });

  it('returns an informative error when no token is provided', async () => {
    const response = await app.request('http://test/llm/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: 'fake', messages: [] })
    });

    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.message).toMatch(/signed/i);
  });
});
