// Focused tests for sync_output.ts: every string write must leave the stream
// as one DEC 2026 synchronized-output frame; other traffic passes through.

import { assert, assertEquals } from "@std/assert";
import { atomicStdout } from "./sync_output.ts";

interface Call {
  chunk: unknown;
  args: unknown[];
}

function fakeStream() {
  const calls: Call[] = [];
  const inner = {
    marker: 42,
    write(chunk: unknown, ...args: unknown[]): boolean {
      calls.push({ chunk, args });
      return true;
    },
    describe(): number {
      return this.marker;
    },
  };
  return { calls, inner };
}

Deno.test("string writes are framed as one atomic frame", () => {
  const { calls, inner } = fakeStream();
  const out = atomicStdout(inner);
  out.write("hello");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].chunk, "\u001B[?2026hhello\u001B[?2026l");
});

Deno.test("callbacks and binary chunks pass through unwrapped", () => {
  const { calls, inner } = fakeStream();
  const out = atomicStdout(inner);
  const done = () => {};
  const bytes = new Uint8Array([1, 2]);
  out.write("x", done);
  out.write(bytes);
  assertEquals(calls[0].args, [done]);
  assertEquals(calls[1].chunk, bytes);
  // Members stay live: methods see the wrapped target as `this`.
  // deno-lint-ignore no-explicit-any
  const anyOut = out as any;
  assertEquals(anyOut.describe(), 42);
  assert(anyOut.marker === 42);
});
