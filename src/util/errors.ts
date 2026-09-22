// Shared error classification for cancellation and timeout detection.
//
// One owner for the checks every adapter/runtime needs when mapping a thrown
// value onto "user cancelled" versus "timed out". The strict `isAbortError` /
// `isTimeoutError` pair matches by error name only; the `*Like` pair adds the
// message/cause-chain heuristics retry policies need for transport errors.

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Reports whether `err` is a cancellation by error name. */
export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  return err instanceof Error && err.name === "AbortError";
}

/** Reports whether `err` is a deadline/timeout by error name. */
export function isTimeoutError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "TimeoutError") return true;
  if (err instanceof Error && err.name === "TimeoutError") return true;
  return err instanceof Error && err.name === "DeadlineExceededError";
}

/**
 * Broad cancellation detection for retry decisions: also matches wrapped
 * transport aborts by message wording.
 */
export function isAbortLike(err: unknown): boolean {
  if (isAbortError(err)) return true;
  return errText(err).toLowerCase().includes("operation was aborted");
}

/**
 * Broad timeout detection for retry decisions: also walks the cause chain and
 * matches timeout wording in messages.
 */
export function isTimeoutLike(err: unknown): boolean {
  if (isTimeoutError(err)) return true;
  if (err instanceof Error && err.cause != null && isTimeoutLike(err.cause)) {
    return true;
  }
  const s = errText(err).toLowerCase();
  return s.includes("deadline exceeded") || s.includes("timed out") ||
    s.includes("timeout");
}
