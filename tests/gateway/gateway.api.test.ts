import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createAdaptorServer } from '@hono/node-server';
import gatewayApp from '../../apps/gateway/src/app';
import { sealSignedRequest, type SignedRequestPayload } from '../../apps/shared/urlToken';

const canListen = process.env.CI === 'true' || process.env.ENABLE_SUPERTEST === 'true';
const describeSuite = canListen ? describe : describe.skip;

const originalEnvTokenKey = process.env.URL_TOKEN_KEY;
const originalFetch = global.fetch;
let server: ReturnType<typeof createAdaptorServer> | undefined;

beforeEach(() => {
  if (!canListen) {
    return;
  }
  process.env.URL_TOKEN_KEY = Buffer.alloc(32, 31).toString('base64');
  server = createAdaptorServer({ fetch: gatewayApp.fetch });
  server.listen(0);
});

afterEach(() => {
  if (!canListen) {
    return;
  }
  if (originalEnvTokenKey === undefined) {
    delete process.env.URL_TOKEN_KEY;
  } else {
    process.env.URL_TOKEN_KEY = originalEnvTokenKey;
  }
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  if (server) {
    server.close();
  }
  server = undefined;
});

describeSuite('Gateway signed URL handling', () => {
  it('forwards request when token is valid', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'Signed URL OK' },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const payload: SignedRequestPayload = {
      v: 1,
      client_id: 'client-1',
      provider: 'openai',
      route_config: { provider: 'openai', api_key: 'sk-openai-real' },
      method: 'POST',
      path: '/v1/chat/completions',
      run_id: 'run-gateway-test',
      user_id: 'user-123',
      issued_at: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
      nonce: 'nonce-1',
    };
    const token = sealSignedRequest(payload);

    const response = await request(server!)
      .post('/v1/chat/completions')
      .query({ token })
      .send({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'ping' }],
      })
      .set('Content-Type', 'application/json')
      .set('Authorization', 'Bearer sk-openai-real');

    expect(response.status).toBe(200);
    expect(response.body.choices[0].message.content).toContain('Signed URL OK');
  });

  it('rejects when token is missing', async () => {
    const response = await request(server!)
      .post('/v1/chat/completions')
      .send({ model: 'gpt-4o-mini', messages: [] });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/token/i);
  });

  it('rejects when body hash mismatches', async () => {
    const body = JSON.stringify({ model: 'gpt-4o-mini', messages: [] });
    const payload: SignedRequestPayload = {
      v: 1,
      client_id: 'client-1',
      provider: 'openai',
      route_config: { provider: 'openai', api_key: 'sk-openai-real' },
      method: 'POST',
      path: '/v1/chat/completions',
      issued_at: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
      nonce: 'nonce-2',
      body_sha256: '0'.repeat(64),
    };
    const token = sealSignedRequest(payload);

    const response = await request(server!)
      .post('/v1/chat/completions')
      .query({ token })
      .set('Content-Type', 'application/json')
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/hash/i);
  });
});
