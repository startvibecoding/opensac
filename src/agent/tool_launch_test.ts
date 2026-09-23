// Focused unit tests for the parallel tool-launch start-order primitive. The Go
// tool_launch_test.go exercises the same contract through the agent loop.

import { assert, assertEquals } from "@std/assert";
import { createToolLaunchOrder } from "./tool_launch.ts";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([
    p,
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), ms)
    ),
  ]);
}

Deno.test("tool launch order: first call is always free to start", async () => {
  const order = createToolLaunchOrder(3)!;
  const h0 = order.handle(0);
  assertEquals(await withTimeout(h0.waitStart(), 50), undefined);
});

Deno.test("tool launch order: later calls wait for predecessor start", async () => {
  const order = createToolLaunchOrder(3)!;
  const h0 = order.handle(0);
  const h1 = order.handle(1);
  const h2 = order.handle(2);

  assertEquals(await withTimeout(h1.waitStart(), 20), "timeout");
  assertEquals(await withTimeout(h2.waitStart(), 20), "timeout");

  h0.markStarted();
  assertEquals(await withTimeout(h1.waitStart(), 50), undefined);
  assertEquals(await withTimeout(h2.waitStart(), 20), "timeout");

  h1.markStarted();
  assertEquals(await withTimeout(h2.waitStart(), 50), undefined);
});

Deno.test("tool launch order: release unblocks the queue idempotently", async () => {
  const order = createToolLaunchOrder(2)!;
  const h0 = order.handle(0);
  const h1 = order.handle(1);

  h0.release();
  h0.release(); // idempotent
  assertEquals(await withTimeout(h1.waitStart(), 50), undefined);
});

Deno.test("tool launch order: null handle operations are safe", async () => {
  const order = createToolLaunchOrder(0);
  assertEquals(order, null);
  const handle = createToolLaunchOrder(1)!.handle(0);
  handle.release();
  await handle.waitStart();
  assert(true);
});
