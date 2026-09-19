// Ported from internal/agent/parallel.go.
//
// BoundedParallel applies fn to every item with at most max concurrent workers.
// Results retain the input order even when calls finish out of order. A
// non-positive max uses the product default. The helper always drains every
// item so callers can preserve one result per provider tool call.
//
// Deviation: Go's goroutine fan-out maps to async workers; fn returns a
// Promise and the helper is awaited.

import { DefaultToolExecutionMaxConcurrency } from "../config/settings.ts";

export async function boundedParallel<T, R>(
  max: number,
  items: readonly T[],
  fn: (item: T) => Promise<R> | R,
): Promise<R[]> {
  if (items.length === 0) return [];
  // A single call is already serial; avoid allocating workers.
  if (items.length === 1) {
    return [await fn(items[0])];
  }
  if (max <= 0) max = DefaultToolExecutionMaxConcurrency;
  if (max > items.length) max = items.length;

  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < max; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
