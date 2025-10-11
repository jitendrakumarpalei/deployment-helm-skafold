import { Buffer } from 'node:buffer';

const STRINGCOST_PREFIX = 'x-stringcost-';
const PORTKEY_PREFIX = 'x-portkey-';
const PORTKEY_TOKEN = 'portkey';
const STRINGCOST_TOKEN = 'stringcost';

export async function adaptResponse(response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  let headersModified = false;

  for (const [key, value] of Array.from(headers.entries())) {
    if (key.startsWith(PORTKEY_PREFIX)) {
      headers.delete(key);
      headers.set(STRINGCOST_PREFIX + key.slice(PORTKEY_PREFIX.length), value);
      headersModified = true;
    }
  }

  const contentType = headers.get('content-type') ?? '';
  let bodyModified = false;
  let payload: string | undefined;

  if (contentType.includes('application/json') || contentType.startsWith('text/')) {
    const text = await response.clone().text();
    let replaced = text.replaceAll(PORTKEY_PREFIX, STRINGCOST_PREFIX);
    if (replaced.includes(PORTKEY_TOKEN)) {
      replaced = replaced.replaceAll(PORTKEY_TOKEN, STRINGCOST_TOKEN);
    }
    if (replaced !== text) {
      bodyModified = true;
      payload = replaced;
      headers.set('content-length', Buffer.byteLength(replaced).toString());
    }
  }

  if (!headersModified && !bodyModified) {
    return response;
  }

  const init: ResponseInit = {
    status: response.status,
    statusText: response.statusText,
    headers,
  };

  const body = bodyModified && payload !== undefined ? payload : response.body;
  const finalResponse = new Response(body, init);
  return finalResponse;
}
