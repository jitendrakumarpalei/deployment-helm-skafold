import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import app from '../../apps/gateway/src/app';

const originalFetch = global.fetch;

const WRAPPER_ORIGIN = 'http://stringcost.local';
const WRAPPER_BASE = `${WRAPPER_ORIGIN}/llm`;

function createLocalFetch(
  providerResponder: (request: Request) => Promise<Response>,
  onWrapperRequest?: (request: Request) => void
) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request =
      input instanceof Request
        ? input
        : new Request(typeof input === 'string' ? input : input.toString(), init);

    if (request.url.startsWith(WRAPPER_BASE)) {
      const internalUrl = request.url.replace(WRAPPER_ORIGIN, 'http://test');
      const internalRequest = new Request(internalUrl, request);
      onWrapperRequest?.(internalRequest);
      return app.fetch(internalRequest, {} as any, undefined);
    }

    return providerResponder(request);
  };
}

describe('SDK integration via OpenAI client', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('routes OpenAI SDK calls through the wrapper with StringCost headers', async () => {
    const providerFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'Seven wonders incoming!' }
            }
          ]
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-portkey-request-id': 'req-xyz'
          }
        }
      );
    });

    let wrapperRequestHeaders: Headers | undefined;

    const localFetch = createLocalFetch(
      providerFetch as unknown as (request: Request) => Promise<Response>,
      (req) => {
        wrapperRequestHeaders = new Headers(req.headers);
      }
    );

    global.fetch = localFetch;

    const client = new OpenAI({
      apiKey: 'unused-openai-key',
      baseURL: `${WRAPPER_BASE}/v1`,
      fetch: localFetch,
      defaultHeaders: {
        Authorization: 'Bearer stringcost-live-key',
        'x-stringcost-provider': 'openai',
        'x-stringcost-virtual-key': 'open-ai-key-04ba3e',
        'x-stringcost-config': JSON.stringify({
          retry: { attempts: 3, on_status_codes: [429] }
        }),
        'x-stringcost-run-id': 'run-sdk-123'
      },
      defaultQuery: {
        run_id: 'run-sdk-123'
      }
    });

    const completion = await client.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: [
        {
          role: 'user',
          content: 'What are the seven wonders of the world?'
        }
      ]
    });

    expect(providerFetch).toHaveBeenCalledOnce();
    const providerRequest = providerFetch.mock.calls[0][0] as Request;
    const providerHeaders = providerRequest.headers;
    expect(providerHeaders.get('authorization')).toBe('Bearer stringcost-live-key');

    expect(completion.choices[0].message?.content).toBe('Seven wonders incoming!');
    expect(completion.choices[0].message?.role).toBe('assistant');
  });
});
