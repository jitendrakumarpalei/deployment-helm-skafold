import { Buffer } from 'node:buffer';
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import app from '../../apps/gateway/src/app';
import portkeyApp from '../../vendor/portkey-gateway/src/index';
import { sealSignedRequest } from '../../apps/shared/urlToken';

let portkeyFetchSpy: ReturnType<typeof vi.spyOn> | undefined;
let forwardedRequest: Request | undefined;
const originalEnv = process.env.URL_TOKEN_KEY;
const urlTokenKey = Buffer.alloc(32, 3).toString('base64');

describe('StringCost Gateway Wrapper', () => {
  beforeEach(() => {
    forwardedRequest = undefined;
    process.env.URL_TOKEN_KEY = urlTokenKey;
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

    const payload = {
      v: 1,
      client_id: 'client-1',
      provider: 'openai',
      route_config: { provider: 'openai', api_key: 'sk-openai-real' },
      virtual_key: 'vk-openai-demo',
      method: 'POST',
      path: '/v1/chat/completions',
      run_id: 'run-123',
      user_id: 'user-456',
      metadata: { tier: 'gold' },
      issued_at: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
      nonce: 'nonce-1'
    };
    const token = sealSignedRequest(payload);

    const response = await app.request(`http://test/llm${payload.path}?token=${token}`, {
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
    expect(body.message).toMatch(/token/i);
  });
});
