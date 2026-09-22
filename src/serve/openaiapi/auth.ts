// Ported from internal/serve/openaiapi/auth.go plus server.go's
// writeJSON/writeError/writeErrorInfo helpers (the error half lives in
// `respond.ts` because TypeScript splits server.go's helper surface across
// modules). Go's `http.Handler` maps to `(Request) => Response | Promise<Response>`,
// `http.SetCookie` maps to a hand-built `Set-Cookie` header, and
// `crypto/subtle`/`crypto/hmac` map to `node:crypto`. Request TLS is not
// observable in Deno, so `requestIsHTTPS` only honors X-Forwarded-Proto.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { type ErrorDetail, type ErrorResponse } from "./types.ts";
import type { AuthConfig, CORSConfig } from "./config.ts";
import {
  classifyError,
  displayErrorMessage,
  PhaseAdmission,
  PhasePersistence,
} from "../../agentruntime/error_info.ts";

export type { CORSConfig };

/** The Go `http.Handler` projection used by every middleware in this module. */
export type HTTPHandler = (request: Request) => Response | Promise<Response>;

export const webUISessionCookieName = "opensac_webui_auth";

/**
 * AuthMiddleware validates Bearer tokens or a Web UI session cookie. If auth
 * is disabled, the handler is called directly.
 */
export function authMiddleware(
  cfg: AuthConfig,
  next: HTTPHandler,
): HTTPHandler {
  return authMiddlewareForConfig(() => cfg, next);
}

/**
 * AuthMiddlewareForConfig validates each request against the current auth
 * configuration. It lets a running Serve instance apply auth changes without
 * rebuilding its HTTP handler tree.
 */
export function authMiddlewareForConfig(
  getConfig: (() => AuthConfig) | null,
  next: HTTPHandler,
): HTTPHandler {
  return (request) => {
    const cfg = getAuthConfig(getConfig);
    if (!cfg.enabled) return next(request);
    if (isPublicWebUIAssetRequest(request)) return next(request);
    if (!hasConfiguredTokens(cfg)) {
      return writeError(
        401,
        "authentication is enabled but no API tokens are configured",
        "authentication_error",
      );
    }
    if (!isAuthorizedRequest(request, cfg)) {
      return writeError(
        401,
        "missing or invalid authentication credentials",
        "authentication_error",
      );
    }
    return next(request);
  };
}

/**
 * WebUILoginHandler accepts one configured API auth token as the Web UI
 * password and creates an HttpOnly signed browser session cookie.
 */
export function webUILoginHandler(cfg: AuthConfig): HTTPHandler {
  return webUILoginHandlerForConfig(() => cfg);
}

/** WebUILoginHandlerForConfig reads the current runtime auth configuration. */
export function webUILoginHandlerForConfig(
  getConfig: (() => AuthConfig) | null,
): HTTPHandler {
  return async (request) => {
    if (request.method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: new Headers({ allow: "POST" }),
      });
    }
    const cfg = getAuthConfig(getConfig);
    if (!cfg.enabled) {
      return writeJSON(200, { authenticated: true, authEnabled: false });
    }

    let password = "";
    try {
      const body = await readBoundedBody(request, 16 << 10) as {
        password?: unknown;
      };
      password = typeof body.password === "string" ? body.password : "";
    } catch {
      // oversized or malformed body: fall through to the invalid-password path
    }
    if (!validToken(cfg.tokens ?? [], password)) {
      return writeError(401, "invalid password", "authentication_error");
    }

    const sessionValue = newWebUISessionValue(password);
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const maxAge = Math.floor((expires.getTime() - Date.now()) / 1000);
    const headers = new Headers({ "content-type": "application/json" });
    headers.set(
      "set-cookie",
      `${webUISessionCookieName}=${sessionValue}; Path=/; Expires=${expires.toUTCString()}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${
        requestIsHTTPS(request) ? "; Secure" : ""
      }`,
    );
    return new Response(
      JSON.stringify({ authenticated: true, authEnabled: true }) + "\n",
      {
        status: 200,
        headers,
      },
    );
  };
}

/**
 * WebUIAuthStatusHandler reports whether the current browser request has an
 * authenticated Web UI session. It never exposes configured tokens.
 */
export function webUIAuthStatusHandler(cfg: AuthConfig): HTTPHandler {
  return webUIAuthStatusHandlerForConfig(() => cfg);
}

/** WebUIAuthStatusHandlerForConfig reads the current runtime auth configuration. */
export function webUIAuthStatusHandlerForConfig(
  getConfig: (() => AuthConfig) | null,
): HTTPHandler {
  return (request) => {
    if (request.method !== "GET") {
      return new Response(null, {
        status: 405,
        headers: new Headers({ allow: "GET" }),
      });
    }
    const cfg = getAuthConfig(getConfig);
    return writeJSON(200, {
      authenticated: !cfg.enabled ||
        (hasConfiguredTokens(cfg) && isAuthorizedRequest(request, cfg)),
      authEnabled: cfg.enabled,
    });
  };
}

/**
 * WebUILogoutHandler clears the Web UI session cookie. It is intentionally
 * callable without an existing session so a stale or invalid cookie can be
 * removed.
 */
export function webUILogoutHandler(): HTTPHandler {
  return (request) => {
    if (request.method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: new Headers({ allow: "POST" }),
      });
    }
    const headers = new Headers({ "content-type": "application/json" });
    headers.set(
      "set-cookie",
      `${webUISessionCookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${
        requestIsHTTPS(request) ? "; Secure" : ""
      }`,
    );
    return new Response(JSON.stringify({ authenticated: false }) + "\n", {
      status: 200,
      headers,
    });
  };
}

function getAuthConfig(getConfig: (() => AuthConfig) | null): AuthConfig {
  if (getConfig === null) return { enabled: false };
  return getConfig();
}

function hasConfiguredTokens(cfg: AuthConfig): boolean {
  return (cfg.tokens?.length ?? 0) > 0;
}

function isAuthorizedRequest(request: Request, cfg: AuthConfig): boolean {
  return validToken(cfg.tokens ?? [], extractBearerToken(request)) ||
    validWebUISession(cfg.tokens ?? [], request);
}

export function validToken(tokens: string[], candidate: string): boolean {
  if (candidate === "") return false;
  let matched = 0;
  const candidateBytes = new TextEncoder().encode(candidate);
  for (const token of tokens) {
    if (token.length === candidate.length) {
      matched |= constantTimeEqual(
        new TextEncoder().encode(token),
        candidateBytes,
      );
    }
  }
  return matched === 1;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): 0 | 1 {
  if (a.length !== b.length) return 0;
  return timingSafeEqual(a, b) ? 1 : 0;
}

function newWebUISessionValue(token: string): string {
  const nonce = randomBytes(32);
  return base64RawUrlEncode(nonce) + "." +
    base64RawUrlEncode(signWebUISession(token, nonce));
}

function validWebUISession(tokens: string[], request: Request): boolean {
  const value = requestCookie(request, webUISessionCookieName);
  if (value === "") return false;
  const parts = value.split(".");
  if (parts.length !== 2) return false;
  const nonce = base64RawUrlDecode(parts[0]);
  const signature = base64RawUrlDecode(parts[1]);
  if (nonce === null || nonce.length !== 32) return false;
  if (signature === null || signature.length !== 32) return false;

  let matched = 0;
  for (const token of tokens) {
    const expected = signWebUISession(token, nonce);
    matched |= constantTimeEqual(expected, signature);
  }
  return matched === 1;
}

function signWebUISession(token: string, nonce: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha256", token).update(nonce).digest());
}

function requestIsHTTPS(request: Request): boolean {
  return (request.headers.get("x-forwarded-proto") ?? "").toLowerCase() ===
    "https";
}

export function isPublicWebUIAssetRequest(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const path = new URL(request.url).pathname;
  switch (path) {
    case "/":
    case "/index.html":
    case "/opensac-small.ico":
      return true;
    default:
      return path.startsWith("/assets/");
  }
}

/** CORSMiddleware adds CORS headers when enabled. */
export function corsMiddleware(
  cfg: CORSConfig,
  next: HTTPHandler,
): HTTPHandler {
  if (!cfg.enabled) return next;
  return async (request) => {
    const headers = new Headers();
    const origin = allowedCORSOrigin(cfg, request.headers.get("origin") ?? "");
    if (origin !== "") headers.set("access-control-allow-origin", origin);
    headers.set(
      "access-control-allow-methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    headers.set("access-control-allow-headers", "Content-Type, Authorization");
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }
    const response = await next(request);
    const merged = new Headers(response.headers);
    for (const [key, value] of headers) {
      if (!merged.has(key)) merged.set(key, value);
    }
    return new Response(response.body, {
      status: response.status,
      headers: merged,
    });
  };
}

export function allowedCORSOrigin(
  cfg: CORSConfig,
  requestOrigin: string,
): string {
  const allowOrigins = cfg.allowOrigins ?? [];
  if (allowOrigins.length === 0) return "*";
  for (const allowed of allowOrigins) {
    if (allowed === "*") return "*";
    if (requestOrigin !== "" && allowed === requestOrigin) return requestOrigin;
  }
  if (requestOrigin === "" && allowOrigins.length === 1) return allowOrigins[0];
  return "";
}

/**
 * ConcurrencyMiddleware limits the number of concurrent in-flight requests.
 * If maxConcurrent <= 0, no limit is applied.
 */
export function concurrencyMiddleware(
  maxConcurrent: number,
  next: HTTPHandler,
): HTTPHandler {
  if (maxConcurrent <= 0) return next;
  let inFlight = 0;
  return async (request) => {
    if (inFlight >= maxConcurrent) {
      return writeError(
        429,
        "server is at capacity, please retry later",
        "rate_limit_error",
      );
    }
    inFlight += 1;
    try {
      return await next(request);
    } finally {
      inFlight -= 1;
    }
  };
}

export function extractBearerToken(request: Request): string {
  const auth = request.headers.get("authorization") ?? "";
  if (auth === "") return "";
  const prefix = "Bearer ";
  if (!auth.startsWith(prefix)) return "";
  return auth.slice(prefix.length).trim();
}

function requestCookie(request: Request, name: string): string {
  const header = request.headers.get("cookie") ?? "";
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim();
    if (key === name) return pair.slice(eq + 1).trim();
  }
  return "";
}

function base64RawUrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

function base64RawUrlDecode(value: string): Uint8Array | null {
  try {
    let normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    while (normalized.length % 4 !== 0) normalized += "=";
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const reader = request.body?.getReader();
  if (reader === undefined) return {};
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // consumer already gone
      }
      throw new Error("request body too large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(merged));
}

/** writeJSON ports server.go's helper (Content-Type json + trailing newline). */
export function writeJSON(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body) + "\n", {
    status,
    headers: new Headers({ "content-type": "application/json" }),
  });
}

/**
 * writeError ports server.go's helper: the message is redacted for 5xx /
 * server_error, classified through the shared ErrorInfo contract, and
 * projected into the OpenAI error envelope.
 */
export function writeError(
  status: number,
  message: string,
  errType: string,
): Response {
  let safe = message.trim();
  if (status >= 500 || errType.trim().toLowerCase() === "server_error") {
    safe = "";
  }
  const phase = status >= 500 ? PhasePersistence : PhaseAdmission;
  const info = classifyError(new Error(message), {
    type: errType,
    message: safe,
    phase,
    httpStatus: status,
  });
  return writeErrorInfo(status, info);
}

/** writeErrorInfo ports server.go's ErrorInfo projection. */
export function writeErrorInfo(
  status: number,
  info: ReturnType<typeof classifyError>,
): Response {
  if (info.message === undefined || info.message === "") {
    info.message = "The request could not be completed.";
  }
  const message = displayErrorMessage(info);
  if (info.type === undefined || info.type === "") info.type = "server_error";
  const headers = new Headers({ "content-type": "application/json" });
  if ((info.retryAfterMs ?? 0) > 0) {
    const seconds = Math.floor(((info.retryAfterMs ?? 0) + 999) / 1000);
    headers.set("retry-after", String(seconds));
  }
  const detail: ErrorDetail = {
    message,
    type: info.type,
    code: info.code,
    failureClass: info.failureClass,
    phase: info.phase,
    messageKey: info.messageKey,
    detail: info.detail,
    retryMode: info.retryMode,
    retryable: info.retryable,
    retryAfterMs: info.retryAfterMs,
    attempt: info.attempt,
    maxAttempts: info.maxAttempts,
    sideEffectState: info.sideEffectState,
    partialOutput: info.partialOutput,
    runId: info.runId,
    intentId: info.intentId,
    requestId: info.requestId,
  };
  const body: ErrorResponse = { error: detail };
  return new Response(JSON.stringify(body) + "\n", { status, headers });
}
