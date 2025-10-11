const WRAPPER_PREFIX = '/llm';
const STRINGCOST_PREFIX = 'x-stringcost-';
const PORTKEY_PREFIX = 'x-portkey-';

const METHODS_WITHOUT_BODY = new Set(['GET', 'HEAD']);

export async function createForwardRequest(original: Request): Promise<Request> {
  const clone = original.clone();
  const originalUrl = new URL(clone.url);
  const internalPath = originalUrl.pathname.startsWith(WRAPPER_PREFIX)
    ? originalUrl.pathname.slice(WRAPPER_PREFIX.length) || '/'
    : originalUrl.pathname;

  const internalUrl = new URL(clone.url);
  internalUrl.pathname = internalPath;

  const headers = new Headers(clone.headers);
  const method = clone.method.toUpperCase();
  const hasBody = !METHODS_WITHOUT_BODY.has(method);

  const init: RequestInit = {
    method,
    headers,
  };

  if (hasBody) {
    init.body = clone.body ?? undefined;
    (init as any).duplex = 'half';
  }

  return new Request(internalUrl.toString(), init);
}

export function enrichRequestHeaders(headers: Headers): void {
  for (const [key, value] of Array.from(headers.entries())) {
    if (key.startsWith(STRINGCOST_PREFIX)) {
      headers.set(PORTKEY_PREFIX + key.slice(STRINGCOST_PREFIX.length), value);
    }
  }
}
