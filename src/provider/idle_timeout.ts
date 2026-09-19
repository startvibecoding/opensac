// Ported from internal/provider/idle_timeout.go

/**
 * The maximum time a streaming response body may go without delivering any data
 * before it is considered stalled and aborted. Unlike a fixed wall-clock
 * timeout, this only fires when the upstream stops sending data.
 */
export const streamIdleTimeoutMs = 30 * 60 * 1000;

/** Error raised when a streaming body stalls past the idle window. */
export class StreamTimeoutError extends Error {
  constructor(message = "stream idle timeout") {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Wraps a streaming body so that a read that does not deliver data within the
 * idle window is aborted. Every delivered chunk resets the idle window.
 * If body is null or idleMs <= 0, body is returned unchanged.
 *
 * Reads are pulled lazily (one source read per consumer read) so a source that
 * fails after delivering data surfaces the buffered data first, matching the
 * Go ReadCloser wrapper used by the providers.
 */
export function newIdleTimeoutStream(
  body: ReadableStream<Uint8Array> | null,
  idleMs: number,
): ReadableStream<Uint8Array> | null {
  if (body === null || idleMs <= 0) return body;
  const reader = body.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // Close the underlying body to unblock any pending read. The
        // connection is aborted and will not be reused; a fresh request is
        // made on retry.
        reader.cancel().catch(() => {});
      }, idleMs);
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (err) {
        clearTimeout(timer);
        controller.error(err);
        return;
      }
      clearTimeout(timer);
      if (timedOut) {
        controller.error(new StreamTimeoutError());
        return;
      }
      if (result.done) {
        controller.close();
        return;
      }
      if (result.value !== undefined) controller.enqueue(result.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * Reports whether err indicates an upstream/stream timeout (idle stream stall,
 * response-header timeout, or a wrapped deadline). It is distinct from
 * user-initiated cancellation.
 */
export function isStreamTimeoutError(err: unknown): boolean {
  if (err == null) return false;
  if (err instanceof StreamTimeoutError) return true;
  if (err instanceof DOMException && err.name === "TimeoutError") return true;
  if (err instanceof Error && err.name === "TimeoutError") return true;
  const s = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return s.includes("deadline exceeded") || s.includes("timed out") ||
    s.includes("timeout");
}
