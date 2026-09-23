import { isContentRejectionError } from "./content_rejection.ts";
import { errMessage } from "./context_overflow.ts";
import { isAbortLike, isTimeoutLike } from "../util/errors.ts";

/**
 * Cloudflare's non-standard HTTP status for an upstream origin that did not
 * respond before the proxy timeout.
 */
export const httpStatusOriginTimeout = 524;

/** RetryConfig controls automatic retry behavior for API calls. */
export interface RetryConfig {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
}

/** Extracts a Node-style error code from an error or its cause chain. */
function errorCode(err: unknown): string {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current != null && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "object") {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && code !== "") return code;
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return "";
}

const retryableHTTPStatusPattern =
  /(?:http|api error|status)\s*[:=]?\s*([45][0-9]{2})/;

/**
 * Determines whether an error or HTTP status code warrants a retry. Provider
 * gateways frequently use 4xx for temporary quota, routing, and compatibility
 * failures, so every HTTP 4xx/5xx response is retryable here.
 */
export function isRetryable(err: unknown, statusCode: number): boolean {
  // Permanent provider refusals (content inspection/moderation) are never
  // transient.
  if (isContentRejectionError(err)) return false;

  if (statusCode >= 400 && statusCode < 600) return true;

  if (err == null) return false;

  // Context cancellation is never retryable (user abort), but a timeout is.
  if (isAbortLike(err)) return false;
  if (isTimeoutLike(err)) return true;

  // A truncated HTTP/SSE response is retryable.
  const lower = errMessage(err).toLowerCase();
  if (
    lower.includes("unexpected eof") || lower.includes("unexpected end of file")
  ) {
    return true;
  }

  // Network-level transient errors (Deno surfaces these as TypeErrors whose
  // cause carries a socket error code).
  const code = errorCode(err);
  if (
    code === "ECONNRESET" || code === "ECONNREFUSED" || code === "EPIPE" ||
    code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "EAI_AGAIN" ||
    code === "UND_ERR_CONNECT_TIMEOUT" || code === "ECONNABORTED"
  ) {
    return true;
  }
  if (
    lower.includes("dns error") || lower.includes("failed to lookup address") ||
    lower.includes("error trying to connect")
  ) {
    return true;
  }

  // Generic "server closed connection" type errors.
  if (retryableHTTPStatusPattern.test(lower)) return true;
  if (
    lower.includes("connection reset") ||
    lower.includes("connection refused") ||
    lower.includes("broken pipe") ||
    lower.includes("eof") ||
    lower.includes("overloaded") ||
    lower.includes("internal_error") ||
    lower.includes("server_error") ||
    lower.includes("stream_read_error") ||
    lower.includes("responses stream failed") ||
    lower.includes("rate_limit") ||
    lower.includes("http 502") ||
    lower.includes("http 503") ||
    lower.includes("http 524")
  ) {
    return true;
  }

  return false;
}

/**
 * Calculates the delay in milliseconds before the next retry attempt using
 * exponential backoff, capped at 30 seconds.
 */
export function retryDelay(attempt: number, baseDelayMs: number): number {
  let base = baseDelayMs;
  if (base <= 0) base = 2000;
  let delay = base * Math.pow(2, attempt);
  if (delay > 30000) delay = 30000;
  return delay;
}

/** Returns a user-visible message for a retry attempt. */
export function formatRetryMessage(
  attempt: number,
  maxRetries: number,
  delayMs: number,
  err: unknown,
): string {
  return `Retrying (${attempt + 1}/${maxRetries}): ${
    classifyRetryError(err)
  } — waiting ${formatDelay(delayMs)}...`;
}

/**
 * Returns only the sanitized reason for a retryable error, without the
 * "Retrying (n/m)" wrapper. The result is always single-line and length-bounded.
 */
export function retryErrorDetail(err: unknown): string {
  if (err == null) return "";
  return classifyRetryError(err);
}

/**
 * Maps an error to a single-line, bounded reason: a JSON error payload first,
 * then known transport/HTTP classifications, then a truncated raw fallback.
 */
function classifyRetryError(err: unknown): string {
  const errStr = err == null ? "" : errMessage(err);

  const msg = extractJSONErrorMessage(errStr);
  if (msg !== "") return msg;

  if (errStr.includes("524")) return "origin timeout (HTTP 524)";
  if (errStr.toLowerCase().includes("overloaded")) return "server overloaded";
  if (errStr.includes("timeout") || errStr.includes("DeadlineExceeded")) {
    return "request timed out";
  }
  if (errStr.includes("connection refused")) return "connection refused";
  if (errStr.includes("connection reset")) return "connection reset";
  if (errStr.includes("429")) return "rate limited (HTTP 429)";
  if (errStr.includes("500")) return "internal server error (HTTP 500)";
  if (errStr.includes("502")) return "bad gateway (HTTP 502)";
  if (errStr.includes("503")) return "service unavailable (HTTP 503)";
  if (errStr.includes("504")) return "gateway timeout (HTTP 504)";
  if (errStr.toLowerCase().includes("stream_read_error")) {
    return "upstream stream read error";
  }
  if (errStr.includes("EOF") || errStr.includes("eof")) {
    return "connection closed unexpectedly";
  }
  return `error: ${truncateErr(sanitizeRetryDetail(errStr), 80)}`;
}

/**
 * Attempts to extract the "message" field from a JSON error response. It
 * handles common API error formats like OpenAI's error response.
 */
function extractJSONErrorMessage(errStr: string): string {
  const jsonStart = errStr.indexOf("{");
  if (jsonStart === -1) return "";

  const jsonStr = errStr.slice(jsonStart);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return "";
  }
  if (parsed == null || typeof parsed !== "object") return "";
  const obj = parsed as Record<string, unknown>;
  const errorField = obj.error;
  if (errorField != null && typeof errorField === "object") {
    const nested = (errorField as Record<string, unknown>).message;
    if (typeof nested === "string" && nested !== "") {
      return truncateErr(sanitizeRetryDetail(nested), 200);
    }
  }
  const topMessage = obj.message;
  if (typeof topMessage === "string" && topMessage !== "") {
    return truncateErr(sanitizeRetryDetail(topMessage), 200);
  }
  return "";
}

/**
 * Collapses newlines and control characters into single spaces so retry
 * diagnostics always render as one bounded line.
 */
export function sanitizeRetryDetail(s: string): string {
  let out = "";
  let pendingSpace = false;
  for (const r of s) {
    const code = r.codePointAt(0) as number;
    if (code <= 0x20 || code === 0x7f) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && out.length > 0) out += " ";
    pendingSpace = false;
    out += r;
  }
  return out;
}

/**
 * Truncates an error string to maxLen UTF-8 bytes without splitting multi-byte
 * runes.
 */
export function truncateErr(s: string, maxLen: number): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= maxLen) return s;
  let cut = maxLen - 3;
  while (cut > 0 && !isRuneStart(bytes[cut])) cut--;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return decoder.decode(bytes.subarray(0, cut)) + "...";
}

function isRuneStart(b: number): boolean {
  return (b & 0xc0) !== 0x80;
}

/** Formats a delay in milliseconds in a human-readable way. */
function formatDelay(d: number): string {
  if (d < 1000) return `${Math.trunc(d)}ms`;
  return `${(d / 1000).toFixed(1)}s`;
}
