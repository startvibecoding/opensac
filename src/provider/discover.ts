import { runtime } from "../platform/runtime.ts";
import { type HttpClient } from "./http_client.ts";
import { applyHeaders, createHttpClient } from "./http_client.ts";

/** Bounds a single model-discovery request. */
export const defaultDiscoverTimeoutMs = 30_000;

/** Caps how much of a /models response body is read. */
export const discoverMaxResponseBytes = 8 << 20;

/**
 * DiscoveredModel is a model entry normalized from a provider /models listing
 * endpoint. It is intentionally separate from config.ModelConfig because
 * discovery results are drafts until a user explicitly adds them.
 */
export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  reasoning?: boolean;
}

/** Describes how to reach a provider /models endpoint. */
export interface DiscoverModelsOptions {
  api: string;
  baseUrl: string;
  /** literal key or a ${ENV_VAR} reference */
  apiKey: string;
  httpProxy?: string;
  forceHTTP11?: boolean;
  headers?: Record<string, string>;
  /** zero means defaultDiscoverTimeoutMs */
  timeoutMs?: number;
}

/** Derives the absolute /models URL from a provider base URL. */
export function modelsEndpoint(raw: string): string {
  const trimmed = raw.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error("baseUrl must be an absolute http(s) URL");
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.host === "") {
    throw new Error("baseUrl must be an absolute http(s) URL");
  }
  let path = u.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/models")) path += "/models";
  u.pathname = path;
  return u.toString();
}

/**
 * Expands ${ENV_VAR} references against the environment and returns any other
 * value unchanged.
 */
export function resolveSecretRef(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("${") && trimmed.endsWith("}")) {
    return runtime.env.get(trimmed.slice(2, -1)) ?? "";
  }
  return trimmed;
}

/**
 * Sets API-type specific auth headers plus any custom headers on a discovery
 * request.
 */
export function applyDiscoveryAuthHeaders(
  headers: Headers,
  api: string,
  apiKey: string,
  custom: Record<string, string> | undefined,
): void {
  const lower = api.trim().toLowerCase();
  if (lower.startsWith("anthropic")) {
    headers.set("x-api-key", apiKey);
    headers.set("anthropic-version", "2023-06-01");
  } else if (lower.startsWith("google")) {
    if (apiKey.startsWith("ya29.") || apiKey.startsWith("gya29.")) {
      headers.set("Authorization", `Bearer ${apiKey}`);
    } else {
      headers.set("x-goog-api-key", apiKey);
    }
  } else {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  headers.set("Accept", "application/json");
  applyHeaders(headers, custom);
}

/**
 * Issues a GET against endpoint using client and parses the response. Errors
 * never include the upstream response body: providers can return credentials,
 * private diagnostics, or arbitrary HTML there, and the HTTP status alone is
 * enough to explain a discovery failure.
 */
export async function fetchDiscoveredModels(
  signal: AbortSignal | undefined,
  client: HttpClient,
  endpoint: string,
  api: string,
  apiKey: string,
  headers: Record<string, string> | undefined,
): Promise<DiscoveredModel[]> {
  const requestHeaders = new Headers();
  applyDiscoveryAuthHeaders(requestHeaders, api, apiKey, headers);

  let resp: Response;
  try {
    resp = await client.fetch(endpoint, {
      method: "GET",
      headers: requestHeaders,
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (err) {
    throw new Error(`fetch models: ${message(err)}`);
  }

  let body: Uint8Array;
  try {
    body = await readLimited(resp, discoverMaxResponseBytes);
  } catch (err) {
    throw new Error(`read models response: ${message(err)}`);
  }
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`models endpoint returned HTTP ${resp.status}`);
  }
  try {
    return parseDiscoveredModels(body);
  } catch (err) {
    throw new Error(`parse models response: ${message(err)}`);
  }
}

/**
 * Validates the base URL, builds an HTTP client honoring proxy and HTTP/1.1
 * options, and fetches the provider /models listing.
 */
export async function discoverModels(
  signal: AbortSignal | undefined,
  opts: DiscoverModelsOptions,
): Promise<DiscoveredModel[]> {
  const endpoint = modelsEndpoint(opts.baseUrl);
  const timeout =
    (opts.timeoutMs ?? 0) <= 0
      ? defaultDiscoverTimeoutMs
      : (opts.timeoutMs as number);
  const client = createHttpClient(timeout, {
    proxyUrl: opts.httpProxy,
    forceHTTP11: opts.forceHTTP11,
  });
  try {
    return await fetchDiscoveredModels(
      signal,
      client,
      endpoint,
      opts.api,
      resolveSecretRef(opts.apiKey),
      opts.headers,
    );
  } finally {
    client.close();
  }
}

/**
 * Normalizes a /models response body from the common provider envelope shapes
 * ({"data": [...]}, {"models": [...]}, or a bare array) into DiscoveredModel
 * entries.
 */
export function parseDiscoveredModels(
  body: Uint8Array | string,
): DiscoveredModel[] {
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }

  let items: unknown[];
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed != null && typeof parsed === "object") {
    const envelope = parsed as { data?: unknown; models?: unknown };
    if (Array.isArray(envelope.data) && envelope.data.length > 0) {
      items = envelope.data;
    } else if (Array.isArray(envelope.models)) {
      items = envelope.models;
    } else {
      items = [];
    }
  } else {
    items = [];
  }

  const result: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    if (raw == null || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    const num = (v: unknown): number => (typeof v === "number" ? v : 0);
    const strArray = (v: unknown): string[] | undefined => {
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
        return v as string[];
      }
      return undefined;
    };

    const id =
      normalizeDiscoveredModelId(str(item.id)) ||
      normalizeDiscoveredModelId(str(item.name));
    if (id === "") continue;
    if (seen.has(id)) continue;
    seen.add(id);

    let name = str(item.name).trim();
    if (name === "" || normalizeDiscoveredModelId(name) === id) {
      name = str(item.displayName).trim();
    }
    if (name === "") name = id;

    const input = strArray(item.input) ??
      strArray(item.input_modalities) ?? ["text"];

    let contextWindow = num(item.contextWindow);
    if (contextWindow === 0) contextWindow = num(item.context_length);
    let maxTokens = num(item.maxTokens);
    if (maxTokens === 0) maxTokens = num(item.max_output_tokens);
    if (maxTokens === 0) maxTokens = num(item.max_tokens);

    result.push({
      id,
      name,
      contextWindow,
      maxTokens,
      input,
      reasoning: item.reasoning === true,
    });
  }
  return result;
}

function normalizeDiscoveredModelId(value: string): string {
  let v = value.trim();
  const marker = v.lastIndexOf("/models/");
  if (marker >= 0) {
    v = v.slice(marker + "/models/".length);
  } else if (v.startsWith("models/")) {
    v = v.slice("models/".length);
  }
  return v.trim();
}

async function readLimited(resp: Response, limit: number): Promise<Uint8Array> {
  const reader = resp.body?.getReader();
  if (reader == null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    const remaining = limit - total;
    const chunk =
      value.length > remaining ? value.subarray(0, remaining) : value;
    chunks.push(chunk);
    total += chunk.length;
  }
  await reader.cancel().catch(() => {});
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
