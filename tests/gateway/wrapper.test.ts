import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import app from '../../apps/gateway/src/app';
import portkeyApp from '../../vendor/portkey-gateway/src/index';

const CONTROL_PLANE_URL = 'http://control.local';
const originalFetch = global.fetch;
let portkeyFetchSpy: ReturnType<typeof vi.spyOn> | undefined;
let forwardedRequest: Request | undefined;

describe('StringCost Gateway Wrapper', () => {
  beforeEach(() => {
    forwardedRequest = undefined;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CONTROL_PLANE_URL;
    portkeyFetchSpy?.mockRestore();
    portkeyFetchSpy = undefined;
    vi.restoreAllMocks();
  });

  it('translates headers and forwards requests via control plane resolution', async () => {
    process.env.CONTROL_PLANE_URL = CONTROL_PLANE_URL;
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

    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;

      if (url.startsWith(CONTROL_PLANE_URL)) {
        return new Response(
          JSON.stringify({
            provider: 'openai',
            config: {
              provider: 'openai',
              virtual_key: 'vk-openai-demo',
              config: { api_key: 'sk-openai-real' }
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      // Upstream provider response
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

    global.fetch = fetchSpy as unknown as typeof global.fetch;

    const response = await app.request('http://test/llm/v1/chat/completions', {
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

    const body = await response.json();

    expect(response.status).not.toBe(502);
    if (response.status === 200) {
      expect(body.choices?.[0]?.message?.content).toBe('wrapper-ok');
    }
    expect(fetchSpy).toHaveBeenCalled();

    expect(forwardedRequest).toBeDefined();
    if (forwardedRequest) {
      expect(forwardedRequest.headers.get('x-portkey-provider')).toBe('openai');
      expect(forwardedRequest.headers.get('authorization')).toBe('Bearer stringcost-test-key');
      expect(forwardedRequest.headers.get('x-portkey-config')).toBeTruthy();
    }
  });

  it('returns an informative error when no provider configuration is available', async () => {
    const response = await app.request('http://test/llm/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: 'fake', messages: [] })
    });

    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.message).toMatch(/provider configuration/i);
  });
});
