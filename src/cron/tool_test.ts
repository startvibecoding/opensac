import { runtime } from "../platform/runtime.ts";
import { assert, assertEquals, assertThrows } from "../compat/assert.ts";
import { type CronJob } from "./cron.ts";
import { createSessionScopedStore } from "./session_store.ts";
import { createSQLiteCronStore, type SQLiteCronStore } from "./sqlite_store.ts";
import { createCronTool } from "./tool.ts";
import { test } from "#testing";

function createStore(): SQLiteCronStore {
  return createSQLiteCronStore(
    runtime.makeTempDirSync({ prefix: "opensac-cron-tool-" }),
  );
}

function create(store: SQLiteCronStore, job: CronJob): CronJob {
  return store.create(job);
}

test("CronToolCreateOneShot", () => {
  const store = createStore();
  const tool = createCronTool(store);

  const result = tool.execute(
    {},
    {
      action: "create",
      name: "test-task",
      prompt: "do something",
      oneshot: true,
    },
  );
  assert(result.text !== "", "expected non-empty result");

  const jobs = store.list();
  assertEquals(jobs.length, 1);
  assert(jobs[0].oneShot, "expected oneshot=true");
  assertEquals(jobs[0].schedule, "");
});

test("CronToolCreatePeriodic", () => {
  const store = createStore();
  const tool = createCronTool(store);

  const result = tool.execute(
    {},
    {
      action: "create",
      name: "daily-check",
      prompt: "check status",
      schedule: "@daily",
    },
  );
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

test("CronToolCreateDefaultOneShot", () => {
  const store = createStore();
  const tool = createCronTool(store);

  tool.execute(
    {},
    {
      action: "create",
      name: "default-task",
      prompt: "do stuff",
      // no schedule, no oneshot → should default to one-shot
    },
  );

  const jobs = store.list();
  assert(jobs[0].oneShot, "expected default to be one-shot when no schedule");
});

test("CronToolList", () => {
  const store = createStore();
  const tool = createCronTool(store);

  // Empty list
  let result = tool.execute({}, { action: "list" });
  assertEquals(result.text, "No cron jobs configured.");

  // Add a job and list
  create(store, { name: "test", prompt: "test", enabled: true });
  result = tool.execute({}, { action: "list" });
  assert(result.text !== "No cron jobs configured.", "expected non-empty list");
});

test("CronToolEnableDisable", () => {
  const store = createStore();
  const tool = createCronTool(store);

  const job = create(store, { name: "test", prompt: "test", enabled: true });

  tool.execute({}, { action: "disable", id: job.id });
  assert(!store.get(job.id!).enabled, "expected disabled");

  tool.execute({}, { action: "enable", id: job.id });
  assert(store.get(job.id!).enabled, "expected enabled");
});

test("CronToolRunReenablesDisabledJob", () => {
  const store = createStore();
  const tool = createCronTool(store);
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

test("CronToolRemove", () => {
  const store = createStore();
  const tool = createCronTool(store);

  const job = create(store, { name: "test", prompt: "test", enabled: true });

  tool.execute({}, { action: "remove", id: job.id });
  assertEquals(store.list().length, 0);
});

test("CronToolSessionScopedCreateAndDeleteByName", () => {
  const base = createStore();
  const current = createSessionScopedStore(base, "session-a", "/tmp/session-a");
  const other = createSessionScopedStore(base, "session-b");
  const tool = createCronTool(current);

  other.create({ name: "other", prompt: "other", enabled: true });
  tool.execute(
    {},
    {
      action: "create",
      name: "daily",
      prompt: "summarize this session",
    },
  );

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

test("CronToolMissingParams", () => {
  const store = createStore();
  const tool = createCronTool(store);

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

test("CronToolUnknownAction", () => {
  const store = createStore();
  const tool = createCronTool(store);
  assertThrows(() => tool.execute({}, { action: "invalid" }));
});
