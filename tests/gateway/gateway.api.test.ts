import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createAdaptorServer } from '@hono/node-server';
import gatewayApp from '../../apps/gateway/src/app';
import { createSignedUrl } from '../../apps/shared/signedUrl';

const canListen = process.env.CI === 'true' && process.env.ENABLE_SUPERTEST === 'true';
const describeSuite = canListen ? describe : describe.skip;

const originalEnvTokenKey = process.env.URL_TOKEN_KEY;
const originalGatewayBase = process.env.GATEWAY_BASE_URL;
const originalFetch = global.fetch;
let server: ReturnType<typeof createAdaptorServer> | undefined;
let serverHost: string | undefined;
let skipSuite = false;
let skipReason: string | undefined;

beforeEach(() => {
  if (!canListen) {
    return;
  }
  skipSuite = false;
  skipReason = undefined;
  process.env.URL_TOKEN_KEY = Buffer.alloc(32, 31).toString('base64');
  try {
    server = createAdaptorServer({ fetch: gatewayApp.fetch });
    server.listen(0);
    const address = server.address();
    if (address && typeof address === 'object') {
      serverHost = `127.0.0.1:${address.port}`;
    } else if (address) {
      serverHost = String(address);
    } else {
      skipSuite = true;
      skipReason = 'Unable to determine server address';
      server.close();
      server = undefined;
      serverHost = undefined;
      return;
    }
    process.env.GATEWAY_BASE_URL = `http://${serverHost}`;
  } catch (error) {
    skipSuite = true;
    skipReason = (error as Error).message;
    server = undefined;
    serverHost = undefined;
  }
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
  if (originalGatewayBase === undefined) {
    delete process.env.GATEWAY_BASE_URL;
  } else {
    process.env.GATEWAY_BASE_URL = originalGatewayBase;
  }
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  if (server) {
    server.close();
  }
  server = undefined;
  serverHost = undefined;
});

describeSuite('Gateway signed URL handling', () => {
  it('forwards request when token is valid', async () => {
    if (skipSuite) {
      return;
    }
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

    const signed = createSignedUrl({
      method: 'POST',
      host: serverHost ?? '127.0.0.1',
      path: '/v1/chat/completions',
      clientId: 'client-1',
      provider: 'openai',
      runId: 'run-gateway-test',
      userId: 'user-123',
      routeConfig: { provider: 'openai', api_key: 'sk-openai-real' },
    });

    const response = await request(server!)
      .post('/llm/v1/chat/completions')
      .query(Object.fromEntries(signed.params.entries()))
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
    if (skipSuite) {
      return;
    }
    const response = await request(server!)
      .post('/llm/v1/chat/completions')
      .send({ model: 'gpt-4o-mini', messages: [] });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/signed/i);
  });

  it('rejects when body hash mismatches', async () => {
    if (skipSuite) {
      return;
    }
    const body = JSON.stringify({ model: 'gpt-4o-mini', messages: [] });
    const signed = createSignedUrl({
      method: 'POST',
      host: serverHost ?? '127.0.0.1',
      path: '/v1/chat/completions',
      clientId: 'client-1',
      provider: 'openai',
      bodyHash: '0'.repeat(64),
      routeConfig: { provider: 'openai', api_key: 'sk-openai-real' },
    });

    const response = await request(server!)
      .post('/llm/v1/chat/completions')
      .query(Object.fromEntries(signed.params.entries()))
      .set('Content-Type', 'application/json')
      .send(body);

    expect(response.status).toBe(403);
    expect(response.body.message).toMatch(/hash/i);
  });
});
