// Ported from internal/session/lock_registry_test.go

import { assert } from "@std/assert";
import { newLockRegistry } from "./lock_registry.ts";

// Pins the M4 fix: per-key mutexes must be removed once no caller references
// them, so long-running processes do not accumulate one mutex per historical
// key. Mutual exclusion must still hold across an eviction boundary.
Deno.test("LockRegistryEvictsUnreferencedEntries", async () => {
  const registry = newLockRegistry();

  const lock = registry.acquire("k");
  assert(registry.has("k"), "entry missing after acquire");

  await lock.lock();
  lock.unlock();
  registry.drop("k", lock);

  assert(
    !registry.has("k"),
    "entry not evicted after the last reference dropped",
  );
});

// Proves an entry survives while any reference remains, so two concurrent
// holders never operate on different mutexes for the same key.
Deno.test("LockRegistryKeepsEntryWhileReferenced", async () => {
  const registry = newLockRegistry();

  const first = registry.acquire("k");
  const second = registry.acquire("k");

  await first.lock();
  first.unlock();
  registry.drop("k", first);

  assert(
    registry.has("k"),
    "entry evicted while a second reference was still held",
  );

  await second.lock();
  second.unlock();
  registry.drop("k", second);

  assert(!registry.has("k"), "entry not evicted after every reference dropped");
});
