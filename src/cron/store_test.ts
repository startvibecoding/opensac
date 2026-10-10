//
// The Go concurrency cases (two goroutines racing ClaimDue, 500 goroutines
// minting IDs) reduce to deterministic sequential assertions because Deno is
// single-threaded: the claim is atomic at the SQL level, so a second claim in the
// same thread must lose exactly as a racing goroutine would.

import { assert, assertEquals, assertThrows } from "../compat/assert.ts";
import { createCronID, runningLeaseTimeoutMs } from "./cron.ts";
import { createSQLiteCronStore, type SQLiteCronStore } from "./sqlite_store.ts";
import { test } from "#testing";

function createStore(): SQLiteCronStore {
  return createSQLiteCronStore(
    Deno.makeTempDirSync({ prefix: "opensac-cron-store-" }),
  );
}

test("SQLiteCronStoreCreate", () => {
  const store = createStore();
  const job = store.create({
    name: "test job",
    prompt: "do something",
    schedule: "0 9 * * *",
    mode: "agent",
    enabled: true,
  });
  assert(job.id !== "", "expected non-empty ID");
  assertEquals(job.name, "test job");
  assert(job.createdAt !== null, "expected CreatedAt to be set");
});

test("SQLiteCronStoreCreateDuplicate", () => {
  const store = createStore();
  store.create({ id: "j1", name: "first" });
  assertThrows(
    () => store.create({ id: "j1", name: "duplicate" }),
    Error,
    undefined,
    "expected error for duplicate ID",
  );
});

test("NewCronIDUnique", () => {
  const count = 500;
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const id = createCronID();
    assert(!seen.has(id), `duplicate id: ${id}`);
    seen.add(id);
  }
  assertEquals(seen.size, count);
});

test("SQLiteCronStoreList", () => {
  const store = createStore();
  store.create({ name: "job1" });
  store.create({ name: "job2" });
  store.create({ name: "job3" });
  assertEquals(store.list().length, 3);
});

test("SQLiteCronStoreGet", () => {
  const store = createStore();
  const created = store.create({ id: "j1", name: "test" });
  const got = store.get("j1");
  assertEquals(got.name, created.name);
});

test("SQLiteCronStoreGetNotFound", () => {
  const store = createStore();
  assertThrows(() => store.get("nonexistent"));
});

test("SQLiteCronStoreUpdate", () => {
  const store = createStore();
  store.create({ id: "j1", name: "original" });
  const job = store.get("j1");
  job.name = "updated";
  job.runCount = 5;
  store.update(job);
  const got = store.get("j1");
  assertEquals(got.name, "updated");
  assertEquals(got.runCount, 5);
});

test("SQLiteCronStoreUpdateNotFound", () => {
  const store = createStore();
  assertThrows(() => store.update({ id: "nonexistent" }));
});

test("SQLiteCronStoreDelete", () => {
  const store = createStore();
  store.create({ id: "j1", name: "to delete" });
  store.delete("j1");
  assertThrows(() => store.get("j1"));
});

test("SQLiteCronStoreDeleteNotFound", () => {
  const store = createStore();
  assertThrows(() => store.delete("nonexistent"));
});

test("SQLiteCronStoreClaimDueIsAtomic", () => {
  const store = createStore();
  store.create({ id: "due", name: "due", enabled: true });

  const first = store.claimDue("due", new Date());
  const second = store.claimDue("due", new Date());
  assert(first, "expected the unstarted enabled job to be claimed once");
  assert(!second, "expected the second claim to lose");
});

test("SQLiteCronStoreClaimDueHonorsFutureNextRun", () => {
  const store = createStore();
  const future = new Date(Date.now() + 3_600_000);
  store.create({
    id: "future",
    enabled: true,
    schedule: "@hourly",
    nextRun: future,
  });
  assert(!store.claimDue("future", new Date()), "future job was claimed early");
});

test("SQLiteCronStoreClaimDueReclaimsStaleRunning", () => {
  const store = createStore();
  const old = new Date(Date.now() - runningLeaseTimeoutMs - 60_000);
  store.create({
    id: "stale",
    enabled: true,
    lastRun: old,
    nextRun: new Date(old.getTime() + 3_600_000),
    lastStatus: "running",
  });
  assert(
    store.claimDue("stale", new Date()),
    "stale running job not reclaimed",
  );
});

test("SQLiteCronStorePersistence", () => {
  const dir = Deno.makeTempDirSync({ prefix: "opensac-cron-persist-" });
  const store1 = createSQLiteCronStore(dir);
  store1.create({ id: "j1", name: "persistent", prompt: "test" });

  const store2 = createSQLiteCronStore(dir);
  const got = store2.get("j1");
  assertEquals(got.name, "persistent");
});
