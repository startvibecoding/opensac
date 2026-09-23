import { assertEquals } from "@std/assert";
import { defaultToolExecutionMaxConcurrency } from "../config/settings.ts";
import { boundedParallel } from "./parallel.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trackPeak<T>(
  fn: (item: T) => Promise<void>,
): { peak: () => number; fn: (item: T) => Promise<void> } {
  let active = 0;
  let peak = 0;
  return {
    peak: () => peak,
    fn: async (item: T) => {
      active++;
      if (active > peak) peak = active;
      try {
        await fn(item);
      } finally {
        active--;
      }
    },
  };
}

Deno.test("boundedParallel preserves order and concurrency limit", async () => {
  const items = Array.from({ length: 32 }, (_v, i) => i);
  const tracker = trackPeak<number>(async (item) => {
    await sleep((items.length - item) % 4 + 1);
  });

  const results = await boundedParallel(3, items, async (item) => {
    await tracker.fn(item);
    return item * 2;
  });

  assertEquals(tracker.peak() <= 3, true);
  assertEquals(results.length, items.length);
  for (let i = 0; i < results.length; i++) {
    assertEquals(results[i], i * 2);
  }
});

Deno.test("boundedParallel default and serial limits", async () => {
  const items = Array.from(
    { length: defaultToolExecutionMaxConcurrency + 4 },
    (_v, i) => i,
  );

  const tracker = trackPeak<number>(async () => {
    await sleep(1);
  });
  await boundedParallel(0, items, (item) => tracker.fn(item));
  assertEquals(
    tracker.peak() <= defaultToolExecutionMaxConcurrency,
    true,
  );

  const serial = trackPeak<number>(async () => {
    await sleep(1);
  });
  await boundedParallel(1, items, (item) => serial.fn(item));
  assertEquals(serial.peak(), 1);
});
