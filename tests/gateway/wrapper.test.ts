import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import app from '../../apps/gateway/src/app';

const originalFetch = global.fetch;

describe('StringCost Gateway Wrapper', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('reports healthy status via the wrapper', async () => {
    const response = await app.request('http://test/healthz');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
  });

  it('translates headers and forwards requests in-process', async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
      const headers = init?.headers instanceof Headers
        ? init.headers
        : new Headers(init?.headers ?? {});

      expect(headers.get('authorization')).toBe('Bearer test-key');

      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: 'wrapper-ok' }, finish_reason: 'stop', index: 0 }
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
        authorization: 'Bearer test-key',
        'x-stringcost-provider': 'openai'
      },
      body: JSON.stringify({
        model: 'fake-model',
        messages: [{ role: 'user', content: 'ping' }]
      })
    });

    const body = await response.json();

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(body.choices[0].message.content).toBe('wrapper-ok');
    expect(
      Array.from(response.headers.keys()).some((key) => key.startsWith('x-portkey-'))
    ).toBe(false);
  });

  it('returns StringCost-branded validation errors when metadata is missing', async () => {
    const response = await app.request('http://test/llm/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-key'
      },
      body: JSON.stringify({
        model: 'fake-model',
        messages: [{ role: 'user', content: 'ping' }]
      })
    });

    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.message).toContain('x-stringcost-');
    expect(body.message).not.toContain('x-portkey-');
  });
});
