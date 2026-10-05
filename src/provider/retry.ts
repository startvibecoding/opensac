import { isContentRejectionError } from "./content_rejection.ts";
import { isContextOverflowError } from "./context_overflow.ts";
import { errorChainText } from "./errors.ts";
import { isAbortLike } from "../util/errors.ts";

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

/**
 * A deliberate cancellation anywhere in the chain. Go/Deno call it several
 * things (`context canceled`, `The operation was aborted.`), and none of them
 * become retryable because a provider wrapped them in `fetch failed`.
 */
const explicitCancellationPattern =
  /operation was aborted|context canceled|context cancelled|\baborterror\b/;

/** Phrases and statuses that identify a permanent credential/permission failure. */
const authenticationFailurePattern =
  /authentication fail|auth(?:entication)? error|unauthori[sz]ed|forbidden|invalid[\s_-]*api[\s_-]*key|api[\s_-]*key.{0,40}invalid|api[\s_-]*key.{0,40}incorrect|incorrect api key|invalid[\s_-]*credential|wrong api key|(?:http|api error|status)\s*[:=]?\s*(?:401|403)\b/;

/**
 * A rejected credential or permission can never succeed on retry. These are
 * genuine boundaries (not recoverable transport failures): the run must fail
 * with the actionable configuration error instead of retrying forever.
 */
function isAuthenticationFailure(err: unknown, statusCode: number): boolean {
  if (statusCode === 401 || statusCode === 403) return true;
  if (err == null) return false;
  // The chain, not just the top message: a wrapped 401 must stay permanent.
  return authenticationFailurePattern.test(errorChainText(err).toLowerCase());
}

/**
 * Determines whether an error or HTTP status code warrants a retry.
 *
 * Retry is the default. A long task keeps its continuity budget, so the
 * transport, gateway, and unrecognizable failures that previously required an
 * exact matched phrase to be retried are now retried with the caller's bounded
 * backoff instead of terminalizing a live run: an unavailable origin, a stalled
 * stream, a DNS blip, a transient TLS handshake, or even a fault no rule
 * recognizes is an availability problem, not task completion. The provider and
 * agent loops keep their own side-effect and visibility fences, so a broad
 * classifier cannot blindly replay an emitted tool call.
 *
 * The only failures that must *not* be replayed are genuine boundaries where the
 * identical request cannot succeed:
 * - an explicit user cancellation (a stop, not a failure to recover),
 * - a rejected credential or permission (the key must be fixed, not retried),
 * - a provider content-policy refusal (the dedicated strip-and-retry path owns
 *   it, so a blind replay would only re-trigger the same refusal),
 * - an oversized context (recovered by compaction/truncation, not a replay).
 */
export function isRetryable(err: unknown, statusCode: number): boolean {
  // Permanent provider refusals (content inspection/moderation) are never
  // transient, and the dedicated strip-and-retry path owns them.
  if (err != null && isContentRejectionError(err)) return false;

  // A rejected credential or permission can never succeed on retry. Checked
  // before the null short-circuit because it keys on `statusCode` too.
  if (isAuthenticationFailure(err, statusCode)) return false;

  // With no error object, an HTTP 4xx/5xx is still a retryable gateway failure;
  // anything else has nothing to retry.
  if (err == null) return statusCode >= 400 && statusCode < 600;

  // A deliberate cancellation anywhere in the chain is a stop, never a retry.
  // `isAbortLike` reads the whole `cause` chain, so a provider that renamed an
  // abort into `fetch failed` cannot smuggle a cancelled run back onto the wire.
  if (isAbortLike(err)) return false;
  if (explicitCancellationPattern.test(errorChainText(err).toLowerCase())) {
    return false;
  }

  // An oversized context fails identically until it is compacted; the agent's
  // truncation path owns recovery, so the generic classifier must not replay it.
  if (isContextOverflowError(err)) return false;

  // Everything else is retried within the caller's bounded budget.
  return true;
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
    retryErrorDetail(err) || "an error"
  } — waiting ${formatDelay(delayMs)}...`;
}

/**
 * Returns only the sanitized reason for a retryable error, without the
 * "Retrying (n/m)" wrapper. The result is always single-line and length-bounded.
 *
 * Classification is purely diagnostic and runs inside the provider retry loop,
 * so it must never throw: a malformed or hostile error shape (a throwing getter,
 * a circular cause, a symbol message) must degrade to a best-effort line rather
 * than abort the loop and terminalize a live run that would otherwise keep
 * retrying. The `null`/empty cases are handled by the caller's own guards.
 */
export function retryErrorDetail(err: unknown): string {
  if (err == null) return "";
  try {
    return classifyRetryError(err);
  } catch {
    // Last-resort: name the value's constructor without trusting any field.
    const name = err instanceof Error ? err.name : typeof err;
    return `error: ${truncateErr(sanitizeRetryDetail(name), 80)}`;
  }
}

/**
 * Maps an error to a single-line, bounded reason: a JSON error payload first,
 * then known transport/HTTP classifications, then a truncated raw fallback.
 *
 * It reads the whole cause chain and matches phrases case-insensitively, because
 * the reason a run is retrying usually arrives from the socket layer with its own
 * capitalisation (`Connection refused (os error 111)`) rather than as a
 * lower-cased constant.
 */
function classifyRetryError(err: unknown): string {
  const chain = err == null ? "" : errorChainText(err);
  const errStr = chain;
  const lower = chain.toLowerCase();

  const msg = extractJSONErrorMessage(errStr);
  if (msg !== "") return msg;

  // Permanent transport facts are named first, mirroring `isRetryable`: they
  // must not be reported as a generic timeout or "network request failed", since
  // the whole point of showing them is that retrying cannot help and the
  // configuration has to change.
  const permanent = permanentTransportReason(lower);
  if (permanent !== "") return permanent;

  if (reportsHttpStatus(lower, 524)) return "origin timeout (HTTP 524)";
  if (lower.includes("overloaded")) return "server overloaded";
  // Both spellings count: `isTimeoutLike` matches "timed out" as two words, which
  // is exactly what Deno and undici emit, so reporting only "timeout" would show
  // a raw fallback for a reason the classifier already recognised.
  if (
    lower.includes("timeout") || lower.includes("timed out") ||
    chain.includes("DeadlineExceeded")
  ) {
    return "request timed out";
  }
  if (lower.includes("connection refused")) return "connection refused";
  if (lower.includes("connection reset")) return "connection reset";
  if (lower.includes("broken pipe")) return "broken pipe";
  if (
    lower.includes("dns error") || lower.includes("failed to lookup address")
  ) {
    return "dns lookup failed";
  }
  if (reportsHttpStatus(lower, 429)) return "rate limited (HTTP 429)";
  if (reportsHttpStatus(lower, 500)) return "internal server error (HTTP 500)";
  if (reportsHttpStatus(lower, 502)) return "bad gateway (HTTP 502)";
  if (reportsHttpStatus(lower, 503)) return "service unavailable (HTTP 503)";
  if (reportsHttpStatus(lower, 504)) return "gateway timeout (HTTP 504)";
  if (lower.includes("stream_read_error")) return "upstream stream read error";
  if (lower.includes("eof")) return "connection closed unexpectedly";
  if (lower.includes("fetch failed")) return "network request failed";
  return `error: ${truncateErr(sanitizeRetryDetail(errStr), 80)}`;
}

/**
 * Reports whether the text names `status` as an HTTP status code rather than as
 * digits embedded in an unrelated number.
 *
 * The bare `lower.includes("500")` form fabricated a wrong HTTP label out of the
 * original error ("used 1500 tokens" became "internal server error (HTTP 500)",
 * "latency 4429ms" became "rate limited (HTTP 429)"), which is the opposite of
 * showing the user the real reason: a fabricated label both hides the original
 * text and points them at the wrong fix. A word boundary means `500` matches
 * "HTTP 500"/"status: 500" but not "1500" or "5000".
 */
function reportsHttpStatus(lower: string, status: number): boolean {
  return new RegExp(`\\b${status}\\b`).test(lower);
}

/**
 * Names a permanent transport failure in user terms, or "" when none applies.
 *
 * This is the single owner of the phrase set. It is consulted only by
 * `classifyRetryError`, never by `isRetryable`: under the retry-by-default policy
 * these faults are retried like any other transport failure, and this naming
 * exists purely so the reason shown to the user names the configuration problem
 * rather than hiding it behind "network request failed" or a wrong HTTP label.
 *
 * Deno blocks reserved ports and rejects malformed URLs at the fetch layer, and
 * both arrive with the same `fetch failed` shape as a real network fault, so
 * they must be separated in the message. TLS text is
 * matched broadly (`certificate`, `tls handshake`, `ssl`, `self-signed`,
 * `hostname mismatch`) because Deno reports every certificate refusal inside a
 * generic `fetch failed` whose only distinguishing words live on `cause`.
 */
function permanentTransportReason(lower: string): string {
  if (/requests to port \d+ are blocked/.test(lower)) {
    return "blocked reserved port";
  }
  if (lower.includes("invalid url") || lower.includes("url is invalid")) {
    return "invalid request URL";
  }
  if (
    /scheme '[^']*' not supported|not supported url|unsupported url scheme/
      .test(lower)
  ) {
    return "unsupported URL scheme";
  }
  if (
    lower.includes("certificate") || lower.includes("tls handshake") ||
    lower.includes("ssl") || /self.?signed/.test(lower) ||
    lower.includes("hostname mismatch")
  ) {
    return "TLS certificate verification failed";
  }
  return "";
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
