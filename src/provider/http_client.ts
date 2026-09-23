//
// Deviation: Go returns *http.Client whose Transport exposes Proxy/HTTP2 knobs;
// Deno has no pluggable Transport. We expose a small HttpClient wrapper over
// `fetch` that applies Deno.createHttpClient proxy / HTTP-version options and an
// optional request timeout via AbortSignal.

/** HTTPClientOptions controls provider HTTP transport behavior. */
export interface HTTPClientOptions {
  proxyUrl?: string;
  forceHTTP11?: boolean;
}

/** A provider HTTP client bound to the given transport options. */
export interface HttpClient {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  /** Releases the underlying connection pool. */
  close(): void;
  /** `using`-compatible alias of `close()`. */
  [Symbol.dispose]?(): void;
  /** The normalized proxy URL, when one was configured. */
  readonly proxyUrl?: string;
  /** Whether HTTP/2 was disabled. */
  readonly forceHTTP11?: boolean;
}

/** Stream transport timeouts (phasic; see the port notes in TS docs). */
export const streamConnectTimeoutMs = 30_000;
export const streamResponseHeaderTimeoutMs = 2 * 60 * 1000;

function normalizeProxyUrl(proxyUrl: string | undefined): string | undefined {
  const trimmed = (proxyUrl ?? "").trim();
  if (trimmed === "") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("proxy URL must include scheme and host");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("proxy URL must include scheme and host");
  }
  if (parsed.host === "") {
    throw new Error("proxy URL must include scheme and host");
  }
  if (parsed.pathname === "/" && parsed.search === "" && parsed.hash === "") {
    return parsed.origin;
  }
  return parsed.toString();
}

function build(opts: HTTPClientOptions, timeoutMs: number): HttpClient {
  const proxy = normalizeProxyUrl(opts.proxyUrl);
  const forceHTTP11 = opts.forceHTTP11 === true;
  const client = Deno.createHttpClient({
    ...(proxy !== undefined ? { proxy: { url: proxy } } : {}),
    ...(forceHTTP11 ? { http2: false } : {}),
  });

  const result: HttpClient = {
    fetch(input: string | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input.toString();
      let signal = init?.signal ?? undefined;
      if (timeoutMs > 0) {
        const timeout = AbortSignal.timeout(timeoutMs);
        signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      }
      const merged: RequestInit = { ...init };
      if (signal !== undefined) merged.signal = signal;
      // deno-lint-ignore no-explicit-any
      (merged as any).client = client;
      return fetch(url, merged);
    },
    close(): void {
      client.close();
    },
    [Symbol.dispose](): void {
      client.close();
    },
  };
  if (proxy !== undefined) {
    Object.defineProperty(result, "proxyUrl", {
      value: proxy,
      enumerable: true,
    });
  }
  Object.defineProperty(result, "forceHTTP11", {
    value: forceHTTP11,
    enumerable: true,
  });
  return result;
}

/** Returns a provider HTTP client with transport options. */
export function createHttpClient(
  timeoutMs: number,
  opts: HTTPClientOptions = {},
): HttpClient {
  return build(opts, timeoutMs);
}

/**
 * Returns an HTTP client suited to long-lived streaming requests. It does not
 * impose a single wall-clock timeout that would cap the entire (potentially
 * long) SSE body; callers bound stalls with the idle-timeout stream wrapper
 * instead.
 */
export function createStreamHttpClient(
  opts: HTTPClientOptions = {},
): HttpClient {
  return build(opts, 0);
}

/** Applies configured custom headers after provider defaults. */
export function applyHeaders(
  headers: Headers,
  custom: Record<string, string> | undefined,
): void {
  for (const [rawName, value] of Object.entries(custom ?? {})) {
    const name = rawName.trim();
    if (name === "") continue;
    headers.set(name, value);
  }
}
