import { assert } from "../compat/assert.ts";
import { createLockRegistry } from "./lock_registry.ts";
import { test } from "#testing";

// Pins the M4 fix: per-key mutexes must be removed once no caller references
// them, so long-running processes do not accumulate one mutex per historical
// key. Mutual exclusion must still hold across an eviction boundary.
test("LockRegistryEvictsUnreferencedEntries", async () => {
  const registry = createLockRegistry();

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
test("LockRegistryKeepsEntryWhileReferenced", async () => {
  const registry = createLockRegistry();

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
