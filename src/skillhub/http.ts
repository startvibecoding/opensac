//
// The Go port injects an *http.Client / http.RoundTripper for tests; here the
// equivalent seam is a plain fetch-like function so callers and tests can
// substitute network behavior without patching the global fetch.

/** Default per-request timeout, mirroring Go's defaultRequestTimeout. */
export const defaultRequestTimeout = 20_000;

// errBodyBytes bounds error response bodies kept for inspection. Sized to fit
// ClawHub AMBIGUOUS_SKILL_SLUG payloads with many candidate matches.
export const errBodyBytes = 64 << 10;

// defaultMaxJSONBytes caps successful JSON response bodies for getJSON callers.
export const defaultMaxJSONBytes = 16 << 20;

/** A minimal injectable HTTP client: a fetch function. */
export type HttpClient = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

/** Builds a default fetch-based client when none is supplied. */
export function createHTTPClient(client?: HttpClient): HttpClient {
  if (client !== undefined) return client;
  return defaultHttpClient;
}

/** The default client applies the Go request timeout to every call. */
export const defaultHttpClient: HttpClient = (url, init) =>
  fetch(url, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(defaultRequestTimeout),
  });

/** Result of a GET that preserves the status/body even for error responses. */
export interface StatusResponse {
  status: number;
  body: Uint8Array;
  error?: Error;
}

/** Performs a GET and decodes the body as JSON. */
export async function getJSON<T = unknown>(
  client: HttpClient,
  endpoint: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await getWithStatus(
    client,
    endpoint,
    defaultMaxJSONBytes,
    signal,
  );
  if (response.error) throw response.error;
  return decodeJSON(endpoint, response.body) as T;
}

/**
 * Performs a GET and returns the status code and response body.
 *
 * Error responses keep a bounded body so callers can inspect structured API
 * errors (e.g. ClawHub AMBIGUOUS_SKILL_SLUG payloads). Mirrors Go's
 * `getWithStatus` (status, body, error): the returned value carries both the
 * body and the error instead of throwing, so callers can disambiguate.
 */
export async function getWithStatus(
  client: HttpClient,
  endpoint: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<StatusResponse> {
  let response: Response;
  try {
    response = await client(endpoint, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    return { status: 0, body: new Uint8Array(0), error: asError(error) };
  }
  if (response.status < 200 || response.status >= 300) {
    const body = await readBodyLimited(response, errBodyBytes);
    const text = new TextDecoder().decode(body).trim();
    return {
      status: response.status,
      body,
      error: new Error(
        `GET ${endpoint}: ${statusText(response)}: ${text}`,
      ),
    };
  }
  const body = await readBodyLimited(response, maxBytes);
  return { status: response.status, body };
}

/** Decodes a JSON body into a value, throwing a descriptive error. */
export function decodeJSON(endpoint: string, body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch (error) {
    throw new Error(`decode ${endpoint}: ${asError(error).message}`);
  }
}

/** Builds a request URL from a base, path, and query values. */
export function endpoint(
  base: string,
  path: string,
  query?: Record<string, string[]>,
): string {
  const url = new URL(trimRight(base, "/") + path);
  if (query) {
    const params = new URLSearchParams();
    for (const key of Object.keys(query).sort()) {
      for (const value of query[key]) params.append(key, value);
    }
    url.search = params.toString();
  }
  return url.toString();
}

/** A status line such as "200 OK", reconstructed when fetch omits it. */
export function statusText(response: Response): string {
  if (response.statusText) return `${response.status} ${response.statusText}`;
  return `${response.status}`;
}

async function readBodyLimited(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const stream = response.body;
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      // io.LimitReader semantics: read at most maxBytes bytes.
      if (total + value.length > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function trimRight(value: string, cutset: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === cutset) end--;
  return value.slice(0, end);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
