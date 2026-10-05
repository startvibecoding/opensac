// Shared provider error wrapping.
//
// Every provider used to own a private `wrapError` that flattened the original
// error into a new message and dropped it. That made a transport failure
// unreachable to retry classification: Deno reports a failed request as
// `TypeError: fetch failed` whose only real reason (connection refused, DNS
// failure, blocked port) lives on `cause`, so flattening turned a retryable
// stall into the opaque, unclassifiable string "send request: fetch failed".
//
// One owner wraps, and it always keeps the chain.

/**
 * The full message text of an error and its `cause` chain, oldest last.
 *
 * Classification reads this instead of only the top-level message, so a
 * wrapper cannot hide the underlying reason and an auth failure cannot be
 * smuggled past the permanent-failure checks.
 */
export function errorChainText(err: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current: unknown = err;
  while (current != null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      if (current.message !== "") parts.push(current.message);
      current = current.cause;
    } else if (typeof current === "object") {
      // A non-Error cause (for example a DOMException-like object) still
      // carries a usable description.
      const text = String(current);
      if (text !== "[object Object]") parts.push(text);
      break;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join("\n");
}

/**
 * The underlying reason carried by the cause chain, trimmed of the noisy
 * `error sending request for url (...)` framing Deno adds. Used to make the
 * message the user sees actionable rather than "fetch failed".
 *
 * It walks the whole chain rather than reading one level, because a provider can
 * wrap an already-wrapped error (`stream read error: send request: fetch
 * failed: …`), and stopping at the first link would surface the intermediate
 * `fetch failed` instead of the socket reason several levels down.
 */
function rootCauseDetail(err: unknown): string {
  if (!(err instanceof Error)) return "";
  // The deepest non-empty message in the chain is the real reason; every shallower
  // one is a stage prefix added on the way out.
  let deepest = "";
  const seen = new Set<unknown>();
  let current: unknown = err.cause;
  while (current != null && !seen.has(current)) {
    seen.add(current);
    const message = current instanceof Error
      ? current.message
      : (typeof current === "object" ? String(current) : String(current));
    const trimmed = message.trim();
    if (trimmed !== "" && trimmed !== "[object Object]") deepest = trimmed;
    current = (current as { cause?: unknown }).cause;
  }
  if (deepest === "") return "";
  // Keep the part after the last "Connect): "-style stage marker when present,
  // so "…: tcp connect error: Connection refused (os error 111)" reads as the
  // actual failure rather than the whole Rust-style chain.
  const match = /(?:error|failure): (.+)$/.exec(deepest);
  return match !== null ? match[1].trim() : deepest.trim();
}

/**
 * Wraps one provider failure with its stage prefix while preserving the cause
 * chain and naming the real reason in the message.
 *
 * `send request` over a dead socket therefore reports
 * `send request: fetch failed: Connection refused (os error 111)` instead of
 * the uninformative `send request: fetch failed`, and `isRetryable` can still
 * walk `cause` for a machine-readable classification.
 */
export function wrapError(context: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const detail = rootCauseDetail(err);
  const text = detail !== "" && !message.includes(detail)
    ? `${context}: ${message}: ${detail}`
    : `${context}: ${message}`;
  return new Error(text, { cause: err });
}
