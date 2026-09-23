import { assert, assertEquals } from "@std/assert";
import {
  createIdleTimeoutStream,
  isStreamTimeoutError,
  StreamTimeoutError,
} from "./mod.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkStream(
  chunks: string[],
  onBlocked?: () => void,
): ReadableStream<Uint8Array> {
  let idx = 0;
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (idx < chunks.length) {
        controller.enqueue(encoder.encode(chunks[idx]));
        idx++;
        return;
      }
      onBlocked?.();
      // Block like a stalled network read forever (the wrapper's idle timer
      // aborts it).
      return new Promise<void>(() => {});
    },
  });
}

Deno.test("IdleTimeoutAllowsContinuousData", async () => {
  const stream = createIdleTimeoutStream(chunkStream(["a", "b", "c"]), 50);
  assert(stream !== null);
  const reader = stream!.getReader();
  const decoder = new TextDecoder();
  let got = "";
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        // The stream ends by firing the idle timeout once the source stalls
        // (matching the Go chunkReader whose final Read blocks until closed).
        break;
      }
      if (result.done) break;
      got += decoder.decode(result.value, { stream: true });
      await sleep(10);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  assertEquals(got, "abc");
});

Deno.test("IdleTimeoutFiresOnStall", async () => {
  const stream = createIdleTimeoutStream(chunkStream(["a"]), 50);
  assert(stream !== null);
  const reader = stream!.getReader();

  const first = await reader.read();
  assert(!first.done);
  assertEquals(new TextDecoder().decode(first.value), "a");

  const start = Date.now();
  let err: unknown = null;
  try {
    await reader.read();
  } catch (e) {
    err = e;
  }
  assert(
    err instanceof StreamTimeoutError,
    `expected StreamTimeoutError, got ${err}`,
  );
  assert(Date.now() - start <= 2000, "idle timeout took too long");
});

Deno.test("IsStreamTimeoutError", () => {
  const cases: Array<[unknown, boolean]> = [
    [new StreamTimeoutError(), true],
    [new Error("stream read error: context deadline exceeded"), true],
    [new Error("net/http: timeout awaiting response headers"), true],
    [new Error("request timed out"), true],
    [new DOMException("aborted", "AbortError"), false],
    [new Error("connection refused"), false],
    [null, false],
  ];
  for (const [err, want] of cases) {
    assertEquals(isStreamTimeoutError(err), want, String(err));
  }
});
