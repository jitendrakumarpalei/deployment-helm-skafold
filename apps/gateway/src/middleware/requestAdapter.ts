const WRAPPER_PREFIX = '/llm';
const METHODS_WITHOUT_BODY = new Set(['GET', 'HEAD']);

interface ForwardOptions {
  stripQueryParams?: string[];
}

export async function createForwardRequest(
  original: Request,
  overrideHeaders?: Headers,
  options: ForwardOptions = {}
): Promise<Request> {
  const clone = original.clone();
  const originalUrl = new URL(clone.url);
  const internalPath = originalUrl.pathname.startsWith(WRAPPER_PREFIX)
    ? originalUrl.pathname.slice(WRAPPER_PREFIX.length) || '/'
    : originalUrl.pathname;

  const internalUrl = new URL(clone.url);
  internalUrl.pathname = internalPath;
  if (options.stripQueryParams?.length) {
    for (const param of options.stripQueryParams) {
      internalUrl.searchParams.delete(param);
    }
  }

  const headers = overrideHeaders ? new Headers(overrideHeaders) : new Headers(clone.headers);
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
