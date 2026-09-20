// Translated from internal/cron/tool_test.go.

import { assert, assertEquals, assertThrows } from "@std/assert";
import type { CronJob } from "./cron.ts";
import {
  newSessionScopedStore,
  newSessionScopedStoreWithWorkDir,
} from "./session_store.ts";
import { newSQLiteCronStore, type SQLiteCronStore } from "./sqlite_store.ts";
import { newCronTool } from "./tool.ts";

function newStore(): SQLiteCronStore {
  return newSQLiteCronStore(
    Deno.makeTempDirSync({ prefix: "mothx-cron-tool-" }),
  );
}

function create(store: SQLiteCronStore, job: CronJob): CronJob {
  return store.create(job);
}

Deno.test("CronToolCreateOneShot", () => {
  const store = newStore();
  const tool = newCronTool(store);

  const result = tool.execute({}, {
    action: "create",
    name: "test-task",
    prompt: "do something",
    oneshot: true,
  });
  assert(result.text !== "", "expected non-empty result");

  const jobs = store.list();
  assertEquals(jobs.length, 1);
  assert(jobs[0].oneShot, "expected oneshot=true");
  assertEquals(jobs[0].schedule, "");
});

Deno.test("CronToolCreatePeriodic", () => {
  const store = newStore();
  const tool = newCronTool(store);

  const result = tool.execute({}, {
    action: "create",
    name: "daily-check",
    prompt: "check status",
    schedule: "@daily",
  });
  assert(result.text !== "", "expected non-empty result");

  const jobs = store.list();
  assertEquals(jobs.length, 1);
  assert(!jobs[0].oneShot, "expected oneshot=false for periodic");
  assertEquals(jobs[0].schedule, "@daily");
  assert(
    jobs[0].nextRun !== null,
    "expected non-null NextRun for periodic job",
  );
});

Deno.test("CronToolCreateDefaultOneShot", () => {
  const store = newStore();
  const tool = newCronTool(store);

  tool.execute({}, {
    action: "create",
    name: "default-task",
    prompt: "do stuff",
    // no schedule, no oneshot → should default to one-shot
  });

  const jobs = store.list();
  assert(jobs[0].oneShot, "expected default to be one-shot when no schedule");
});

Deno.test("CronToolList", () => {
  const store = newStore();
  const tool = newCronTool(store);

  // Empty list
  let result = tool.execute({}, { action: "list" });
  assertEquals(result.text, "No cron jobs configured.");

  // Add a job and list
  create(store, { name: "test", prompt: "test", enabled: true });
  result = tool.execute({}, { action: "list" });
  assert(result.text !== "No cron jobs configured.", "expected non-empty list");
});

Deno.test("CronToolEnableDisable", () => {
  const store = newStore();
  const tool = newCronTool(store);

  const job = create(store, { name: "test", prompt: "test", enabled: true });

  tool.execute({}, { action: "disable", id: job.id });
  assert(!store.get(job.id!).enabled, "expected disabled");

  tool.execute({}, { action: "enable", id: job.id });
  assert(store.get(job.id!).enabled, "expected enabled");
});

Deno.test("CronToolRunReenablesDisabledJob", () => {
  const store = newStore();
  const tool = newCronTool(store);
  const job = create(store, {
    id: "manual",
    name: "manual",
    prompt: "run",
    schedule: "@hourly",
    enabled: false,
    nextRun: new Date(Date.now() + 3_600_000),
    lastStatus: "failed",
  });

  tool.execute({}, { action: "run", id: job.id });

  const got = store.get(job.id!);
  assert(got.enabled, "expected enabled after manual run");
  assertEquals(got.lastRun, null);
  assertEquals(got.nextRun, null);
  assertEquals(got.lastStatus, "");
});

Deno.test("CronToolRemove", () => {
  const store = newStore();
  const tool = newCronTool(store);

  const job = create(store, { name: "test", prompt: "test", enabled: true });

  tool.execute({}, { action: "remove", id: job.id });
  assertEquals(store.list().length, 0);
});

Deno.test("CronToolSessionScopedCreateAndDeleteByName", () => {
  const base = newStore();
  const current = newSessionScopedStoreWithWorkDir(
    base,
    "session-a",
    "/tmp/session-a",
  );
  const other = newSessionScopedStore(base, "session-b");
  const tool = newCronTool(current);

  other.create({ name: "other", prompt: "other", enabled: true });
  tool.execute({}, {
    action: "create",
    name: "daily",
    prompt: "summarize this session",
  });

  const jobs = current.list();
  assertEquals(jobs.length, 1);
  assertEquals(jobs[0].sessionId, "session-a");
  assertEquals(jobs[0].workDir, "/tmp/session-a");

  const otherJobs = other.list();
  assertEquals(otherJobs.length, 1);
  assertEquals(otherJobs[0].name, "other");

  tool.execute({}, { action: "delete", name: "daily" });
  assertEquals(current.list().length, 0);
  assertEquals(other.list().length, 1);
});

Deno.test("CronToolMissingParams", () => {
  const store = newStore();
  const tool = newCronTool(store);

  assertThrows(
    () => tool.execute({}, { action: "create", prompt: "test" }),
    Error,
    undefined,
    "expected error for missing name",
  );
  assertThrows(
    () => tool.execute({}, { action: "create", name: "test" }),
    Error,
    undefined,
    "expected error for missing prompt",
  );
  assertThrows(
    () => tool.execute({}, { action: "enable" }),
    Error,
    undefined,
    "expected error for missing id",
  );
});

Deno.test("CronToolUnknownAction", () => {
  const store = newStore();
  const tool = newCronTool(store);
  assertThrows(() => tool.execute({}, { action: "invalid" }));
});
