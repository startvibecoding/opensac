// Shared error classification for cancellation and timeout detection.
//
// One owner for the checks every adapter/runtime needs when mapping a thrown
// value onto "user cancelled" versus "timed out". The strict `isAbortError` /
// `isTimeoutError` pair matches by error name only; the `*Like` pair adds the
// message/cause-chain heuristics retry policies need for transport errors.

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Walks an error's `cause` chain, guarding against a self-referencing cause.
 * The caller decides what each link contributes; a non-Error link is skipped
 * because its `String()` carries no classification-worthy text (`[object Object]`).
 */
function* errorChain(err: unknown): Generator<unknown> {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current != null && !seen.has(current)) {
    seen.add(current);
    yield current;
    if (!(current instanceof Error) && !(typeof current === "object")) break;
    current = (current as { cause?: unknown }).cause;
  }
}

/** Reports whether `err` is a cancellation by error name. */
export function isAbortError(err: unknown): boolean {
  for (const link of errorChain(err)) {
    if (link instanceof DOMException && link.name === "AbortError") return true;
    if (link instanceof Error && link.name === "AbortError") return true;
  }
  return false;
}

/** Reports whether `err` is a deadline/timeout by error name. */
export function isTimeoutError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "TimeoutError") return true;
  if (err instanceof Error && err.name === "TimeoutError") return true;
  return err instanceof Error && err.name === "DeadlineExceededError";
}

/**
 * Broad cancellation detection for retry decisions: matches a deliberate abort
 * anywhere in the `cause` chain, by error name or by a distinctive phrase.
 *
 * It must read the whole chain rather than only the top message, because Node
 * surfaces a cancelled fetch as `TypeError: "fetch failed"` whose real reason is
 * a `DOMException("Aborted", "AbortError")` or the default `signal.reason`
 * ("The signal has been aborted") on `cause`, and every provider yields a
 * literal `new Error("aborted")` sentinel when it observes its own abort signal.
 *
 * The wording is deliberately narrow: it names the exact provider sentinel and
 * the specific "...was/hath been aborted" phrasings rather than a bare "aborted"
 * substring, so a real transient socket fault like "connection aborted" is NOT
 * mistaken for a user cancel and wrongly kept off the retry path.
 */
const abortPhrasePattern =
  /\boperation was aborted\b|\bsignal has been aborted\b|\brequest was aborted\b|\bfetch was aborted\b/;

export function isAbortLike(err: unknown): boolean {
  for (const link of errorChain(err)) {
    if (link instanceof DOMException && link.name === "AbortError") return true;
    if (link instanceof Error && link.name === "AbortError") return true;
    const message = errText(link).trim().toLowerCase();
    // The exact provider abort sentinel (message is just "aborted").
    if (message === "aborted") return true;
    if (abortPhrasePattern.test(message)) return true;
  }
  return false;
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
  return (
    s.includes("deadline exceeded") ||
    s.includes("timed out") ||
    s.includes("timeout")
  );
}
