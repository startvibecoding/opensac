// Translated from the Scheduler and maintenance cases of
// internal/cron/cron_test.go, internal/cron/manage_runnow_test.go, and
// internal/cron/maintenance_test.go.
//
// The Go concurrency cases (20 racing Start/Stop goroutines) reduce to
// deterministic assertions because Deno is single-threaded: `start()` performs
// its synchronous prologue before any await, and `stop()` awaits the loop and
// every in-flight job.

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertThrows,
} from "@std/assert";
import * as path from "@std/path";
import {
  DefaultMaintenancePolicy,
  IsMaintenanceCronJobID,
  MaintenanceCronJobPrefix,
  MaintenanceStorageReconcileJobID,
  MaintenanceStorageReconcileJobName,
  MaintenanceStorageReconcileSchedule,
} from "../agentruntime/maintenance_cron.ts";
import {
  closeDatabases,
  listSessionRunEvents,
  lockRuntime,
} from "../session/mod.ts";
import { createBound, newManager } from "../session/manager.ts";
import { newAgentFactory } from "../agent/factory.ts";
import { newAgentManager } from "../agent/manager.ts";
import { emptyCompaction } from "../agent/agent_testutil.ts";
import { defaultSettings } from "../config/settings.ts";
import { newMockProvider } from "../provider/mock.ts";
import type { Model } from "../provider/types.ts";
import { streamDone, streamTextDelta } from "../provider/mod.ts";
import type { CronJob } from "./cron.ts";
import { normalizeJobSchedule } from "./schedule.ts";
import {
  ErrJobAlreadyRunning,
  newScheduler,
  newSchedulerWithSessionDir,
  Scheduler,
} from "./scheduler.ts";
import { newSQLiteCronStore, type SQLiteCronStore } from "./sqlite_store.ts";

function newStore(): SQLiteCronStore {
  return newSQLiteCronStore(
    Deno.makeTempDirSync({ prefix: "mothx-cron-sched-" }),
  );
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitForStatus(
  store: SQLiteCronStore,
  id: string,
  status: string,
  timeoutMs = 10_000,
): Promise<CronJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = store.get(id);
    if (job.lastStatus === status) return job;
    if (Date.now() > deadline) {
      throw new Error(
        `job ${id} never reached status "${status}": ${JSON.stringify(job)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

// --- Scheduler lifecycle tests ---

Deno.test("SchedulerStartStop", async () => {
  const store = newStore();
  const sched = newScheduler(store, null, 1_000);

  assert(!sched.isRunning(), "expected not running initially");
  sched.start();
  assert(sched.isRunning(), "expected running after start");

  // Double start should be a no-op.
  sched.start();

  await sched.stop();
  assert(!sched.isRunning(), "expected not running after stop");

  // Double stop should be a no-op.
  await sched.stop();
});

Deno.test("SchedulerConcurrentStartStop", async () => {
  const sched = newScheduler(newStore(), null, 1);
  await Promise.all(
    Array.from({ length: 20 }, () => {
      sched.start();
      return sched.stop();
    }),
  );
  await sched.stop();
  assert(
    !sched.isRunning(),
    "scheduler still running after concurrent start/stop",
  );
});

Deno.test("SchedulerDefaultInterval", () => {
  const store = newStore();
  const sched = newScheduler(store, null, 0);
  assertEquals(sched.interval, 30_000);
});

Deno.test("SchedulerCompletionObserver", () => {
  const sched = new Scheduler(dummyStore(), null, 1_000);
  const called = deferred<{
    sessionId: string;
    response: string;
    err: Error | null;
  }>();
  sched.setCompletionObserver((sessionId, response, err) => {
    called.resolve({ sessionId, response, err });
  });
  sched.notifyCompletion("session-1", "result", null);
  return called.promise.then((got) => {
    assertEquals(got.sessionId, "session-1");
    assertEquals(got.response, "result");
    assertEquals(got.err, null);
  });
});

Deno.test("SchedulerUpdateJobPreservesExistingFields", () => {
  const store = newStore();
  store.create({
    id: "j1",
    name: "keep name",
    schedule: "@daily",
    enabled: true,
  });
  const sched = newScheduler(store, null, 1_000);
  sched.updateJob("j1", (job) => {
    job.lastStatus = "running";
  });
  const got = store.get("j1");
  assertEquals(got.name, "keep name");
  assertEquals(got.lastStatus, "running");
});

// --- isDue tests ---

Deno.test("IsDueNeverRun", () => {
  const s = new Scheduler(dummyStore(), null, 1_000);
  assert(
    s.isDue({ enabled: true }, new Date()),
    "expected due for never-run job",
  );
});

Deno.test("IsDueNextRunPassed", () => {
  const s = new Scheduler(dummyStore(), null, 1_000);
  const job: CronJob = {
    enabled: true,
    lastRun: new Date(Date.now() - 2 * 3_600_000),
    nextRun: new Date(Date.now() - 3_600_000),
  };
  assert(s.isDue(job, new Date()), "expected due when NextRun has passed");
});

Deno.test("IsDueRecentRun", () => {
  const s = new Scheduler(dummyStore(), null, 1_000);
  const job: CronJob = {
    enabled: true,
    lastRun: new Date(Date.now() - 5 * 60_000),
    nextRun: new Date(Date.now() + 55 * 60_000),
  };
  assert(!s.isDue(job, new Date()), "expected not due for recent run");
});

Deno.test("IsDuePeriodicFirstRunWaitsForNextRun", () => {
  const s = new Scheduler(dummyStore(), null, 1_000);
  const job: CronJob = {
    enabled: true,
    schedule: "@hourly",
    nextRun: new Date(Date.now() + 3_600_000),
  };
  assert(
    !s.isDue(job, new Date()),
    "periodic job was due before its first NextRun",
  );
});

Deno.test("IsDueOldRun", () => {
  const s = new Scheduler(dummyStore(), null, 1_000);
  const job: CronJob = {
    enabled: true,
    lastRun: new Date(Date.now() - 2 * 3_600_000),
  };
  assert(
    !s.isDue(job, new Date()),
    "expected not due — one-shot already completed",
  );
  const job2: CronJob = {
    enabled: true,
    lastRun: new Date(Date.now() - 2 * 3_600_000),
    nextRun: new Date(Date.now() - 30 * 60_000),
  };
  assert(s.isDue(job2, new Date()), "expected due — NextRun is in the past");
});

Deno.test("IsDueOneShotFirstRun", () => {
  const s = new Scheduler(dummyStore(), null, 1_000);
  const job: CronJob = { enabled: true, oneShot: true, lastRun: null };
  assert(s.isDue(job, new Date()), "expected due — one-shot never run");
});

Deno.test("IsDuePeriodicJob", () => {
  const s = new Scheduler(dummyStore(), null, 1_000);
  const job: CronJob = {
    enabled: true,
    schedule: "@hourly",
    lastRun: new Date(Date.now() - 2 * 3_600_000),
    nextRun: new Date(Date.now() - 5 * 60_000),
  };
  assert(s.isDue(job, new Date()), "expected due — periodic job past NextRun");
});

Deno.test("IsDueDisabled", () => {
  const s = new Scheduler(dummyStore(), null, 1_000);
  const job: CronJob = { enabled: false, lastRun: null };
  assert(s.isDue(job, new Date()), "isDue should ignore the Enabled flag");
});

function dummyStore(): {
  list: () => CronJob[];
  get: (id: string) => CronJob;
  create: (j: CronJob) => CronJob;
  update: (j: CronJob) => void;
  delete: (id: string) => void;
} {
  return {
    list: () => [],
    get: () => ({}),
    create: (j) => j,
    update: () => {},
    delete: () => {},
  };
}

// --- Execution-path tests without an agent manager ---

Deno.test("SchedulerCreateFailureFinalizesOneShot", async () => {
  const store = newStore();
  const job = store.create({ id: "one-shot", enabled: true, oneShot: true });
  const s = newScheduler(store, null, 1_000);
  const claim = s.claimJob(job.id!, new Date());
  assert(claim.claimed, "expected the job to be claimed");
  const claimedJob = store.get(job.id!);
  claimedJob.lastStatus = "running";
  store.update(claimedJob);

  await s.executeJob(claimedJob);
  const got = store.get(job.id!);
  assert(!got.enabled, "one-shot must auto-disable after the run");
  assertEquals(got.runCount, 1);
  assertEquals(got.lastStatus, "failed");
});

Deno.test("SchedulerCheckAndRunSkipsDisabledAndRunning", () => {
  const store = newStore();
  store.create({ id: "disabled", name: "Disabled", enabled: false });
  store.create({
    id: "running",
    name: "Running",
    enabled: true,
    lastStatus: "running",
  });
  const sched = newScheduler(store, null, 1_000);
  sched.checkAndRun();

  assertEquals(store.get("disabled").lastStatus, "");
  assertEquals(store.get("running").lastStatus, "running");
});

Deno.test("SchedulerHandlerUsesCanonicalCronCompletionLifecycle", async () => {
  const store = newStore();
  store.create({
    id: "maintenance",
    name: "maintenance",
    prompt: "ignored",
    schedule: "@hourly",
    mode: "yolo",
    enabled: true,
  });
  const called = deferred<CronJob>();
  const scheduler = newSchedulerWithSessionDir(
    store,
    null,
    3_600_000,
    "",
    (job) => {
      called.resolve(job);
      return { handled: true, response: "maintained", error: null };
    },
  );
  scheduler.runNow("maintenance");
  const got = await called.promise;
  assertEquals(got.id, "maintenance");

  const job = await waitForStatus(store, "maintenance", "success");
  assertEquals(job.runCount, 1);
  assert(job.nextRun !== null, "next run should be scheduled");
});

// --- NormalizeJobSchedule ---

Deno.test("NormalizeJobSchedule", () => {
  let job = normalizeJobSchedule({ name: "n", prompt: "p" });
  assertEquals(job.mode, "yolo");
  assert(job.oneShot === true);
  assertEquals(job.nextRun, null);

  job = normalizeJobSchedule({
    name: "n",
    prompt: "p",
    schedule: "@daily",
    mode: "agent",
  });
  assert(job.oneShot !== true);
  assert(job.nextRun !== null);
  assertEquals(job.mode, "agent");

  job = normalizeJobSchedule({ name: "n", prompt: "p", schedule: "@once" });
  assert(job.oneShot === true);
  assertEquals(job.nextRun, null);

  assertThrows(() =>
    normalizeJobSchedule({ name: "n", prompt: "p", mode: "turbo" })
  );
  assertThrows(() =>
    normalizeJobSchedule({ name: "n", prompt: "p", schedule: "@every soon" })
  );
  assertThrows(() => normalizeJobSchedule(undefined as unknown as CronJob));
});

// --- RunNow tests ---

Deno.test("SchedulerRunNowExecutesAndNotifiesJobObserver", async () => {
  const store = newStore();
  const job = store.create({
    name: "manual",
    prompt: "do it",
    schedule: "",
    mode: "yolo",
    enabled: false, // only the manual trigger may run it
  });
  const scheduler = newScheduler(store, null, 3_600_000);
  const jobEvents = deferred<{ job: CronJob; err: Error | null }>();
  scheduler.setJobCompletionObserver((completed, _response, runErr) => {
    jobEvents.resolve({ job: completed, err: runErr });
  });
  const sessionObserver = deferred<string>();
  scheduler.setCompletionObserver((sessionId) =>
    sessionObserver.resolve(sessionId)
  );

  // RunNow works without start (no scheduler loop involved).
  scheduler.runNow(job.id!);
  const observed = await jobEvents.promise;
  assertEquals(observed.job.id, job.id);
  assertEquals(observed.job.name, "manual");
  assert(observed.err !== null, "nil agent manager must surface a run error");

  // The session observer must not fire for an unbound job.
  const raced = await Promise.race([
    sessionObserver.promise.then(() => "fired"),
    new Promise<string>((r) => setTimeout(() => r("quiet"), 50)),
  ]);
  assertEquals(raced, "quiet");

  const stored = store.get(job.id!);
  assert(stored.lastRun !== null, "RunNow must stamp lastRun");
  assertEquals(stored.lastStatus, "failed");
  assertEquals(stored.runCount, 1);
  assert((stored.lastError ?? "") !== "");
  assert(!stored.enabled, "one-shot job must auto-disable after the run");

  // A second manual run overrides the disabled one-shot.
  const second = deferred<void>();
  scheduler.setJobCompletionObserver(() => second.resolve());
  scheduler.runNow(job.id!);
  await second.promise;
  assertEquals(store.get(job.id!).runCount, 2);
});

Deno.test("SchedulerRunNowErrors", () => {
  const store = newStore();
  const scheduler = newScheduler(store, null, 3_600_000);

  assertThrows(() => scheduler.runNow("missing"), Error);
  assertThrows(() => scheduler.runNow("  "), Error);

  const job = store.create({
    name: "busy",
    prompt: "p",
    enabled: true,
    lastStatus: "running",
    lastRun: new Date(),
  });
  const err = assertThrows(() => scheduler.runNow(job.id!));
  assertInstanceOf(err, ErrJobAlreadyRunning);
});

// --- Maintenance projection tests ---

Deno.test("SchedulerStartProjectsMaintenanceJobOnce", async () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "mothx-cron-maint-" });
  const first = newSchedulerWithSessionDir(
    newSQLiteCronStore(sessionDir),
    null,
    3_600_000,
    sessionDir,
  );
  first.start();
  const second = newSchedulerWithSessionDir(
    newSQLiteCronStore(sessionDir),
    null,
    3_600_000,
    sessionDir,
  );
  second.start();
  try {
    const maintenance = newSQLiteCronStore(sessionDir)
      .list()
      .filter((job) => IsMaintenanceCronJobID(job.id ?? ""));
    assertEquals(maintenance.length, 1);
    const job = maintenance[0];
    assertEquals(job.id, MaintenanceStorageReconcileJobID());
    assertEquals(job.schedule, MaintenanceStorageReconcileSchedule);
    assert(job.enabled === true);
    assert(job.oneShot !== true);
    assertEquals(job.sessionId ?? "", "");
    assert(job.nextRun != null && job.nextRun.getTime() > Date.now());
  } finally {
    await first.stop();
    await second.stop();
    closeDatabases();
  }
});

Deno.test("DisabledMaintenancePolicyRemovesTheProjection", async () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "mothx-cron-maint-" });
  const store = newSQLiteCronStore(sessionDir);
  store.create({
    id: "cron-keep",
    name: "keep me",
    prompt: "digest",
    schedule: "@daily",
    mode: "yolo",
    enabled: true,
  });

  const off = newSchedulerWithSessionDir(store, null, 3_600_000, sessionDir);
  off.setMaintenancePolicy({
    reclaimAttachmentStorage: false,
    storageReconcileSchedule: "",
  });
  off.start();
  assertThrows(() => store.get(MaintenanceStorageReconcileJobID()));
  await off.stop();

  const on = newSchedulerWithSessionDir(store, null, 3_600_000, sessionDir);
  on.setMaintenancePolicy(DefaultMaintenancePolicy());
  on.start();
  store.get(MaintenanceStorageReconcileJobID());
  await on.stop();

  const restarted = newSchedulerWithSessionDir(
    store,
    null,
    3_600_000,
    sessionDir,
  );
  restarted.setMaintenancePolicy({
    reclaimAttachmentStorage: false,
    storageReconcileSchedule: "",
  });
  restarted.start();
  assertThrows(() => store.get(MaintenanceStorageReconcileJobID()));
  store.get("cron-keep");
  await restarted.stop();
  closeDatabases();
});

Deno.test("MaintenanceScheduleOverrideKeepsRunHistory", async () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "mothx-cron-maint-" });
  const store = newSQLiteCronStore(sessionDir);
  const runAt = new Date(Date.now() - 2 * 3_600_000);
  const stored = normalizeJobSchedule({
    id: MaintenanceStorageReconcileJobID(),
    name: MaintenanceStorageReconcileJobName,
    prompt: "Runtime-owned maintenance; never executed as an agent prompt.",
    schedule: "@daily",
    mode: "yolo",
    enabled: true,
    createdAt: runAt,
    lastRun: runAt,
    runCount: 3,
    lastStatus: "success",
  });
  store.create(stored);

  const scheduler = newSchedulerWithSessionDir(
    store,
    null,
    3_600_000,
    sessionDir,
  );
  scheduler.setMaintenancePolicy({
    reclaimAttachmentStorage: true,
    storageReconcileSchedule: "@every 6h",
  });
  scheduler.start();
  try {
    const job = store.get(MaintenanceStorageReconcileJobID());
    assertEquals(job.schedule, "@every 6h");
    assert(job.nextRun !== null);
    assertEquals(job.runCount, 3);
    assertEquals(job.lastStatus, "success");
    assertEquals(job.lastRun!.getTime(), runAt.getTime());
    assertEquals(job.createdAt!.getTime(), runAt.getTime());
  } finally {
    await scheduler.stop();
    closeDatabases();
  }
});

Deno.test("InvalidMaintenanceScheduleFallsBackToDefault", async () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "mothx-cron-maint-" });
  const store = newSQLiteCronStore(sessionDir);
  const scheduler = newSchedulerWithSessionDir(
    store,
    null,
    3_600_000,
    sessionDir,
  );
  scheduler.setMaintenancePolicy({
    reclaimAttachmentStorage: true,
    storageReconcileSchedule: "@every soon",
  });
  scheduler.start();
  try {
    const job = store.get(MaintenanceStorageReconcileJobID());
    assertEquals(job.schedule, MaintenanceStorageReconcileSchedule);
  } finally {
    await scheduler.stop();
    closeDatabases();
  }
});

Deno.test("MaintenanceJobCompletesThroughTheRuntimeNotAnAgent", async () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "mothx-cron-maint-" });
  const aged = writeMaintenanceArtifactDirectory(
    sessionDir,
    "0123456789abcdef",
  );

  const store = newSQLiteCronStore(sessionDir);
  let handlerCalls = 0;
  const scheduler = newSchedulerWithSessionDir(
    store,
    null,
    3_600_000,
    sessionDir,
    () => {
      handlerCalls += 1;
      return { handled: false, response: "", error: null };
    },
  );
  scheduler.start();
  try {
    scheduler.runNow(MaintenanceStorageReconcileJobID());
    const completed = await waitForStatus(
      store,
      MaintenanceStorageReconcileJobID(),
      "success",
    );
    assertEquals(completed.lastError, "");
    assertEquals(completed.runCount, 1);
    assertThrows(() => Deno.statSync(aged), Deno.errors.NotFound);
    assertEquals(handlerCalls, 0);
  } finally {
    await scheduler.stop();
    closeDatabases();
  }
});

Deno.test("UnknownMaintenanceJobCannotRunItsPrompt", async () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "mothx-cron-maint-" });
  const store = newSQLiteCronStore(sessionDir);
  const id = MaintenanceCronJobPrefix + "not-implemented";
  const job = normalizeJobSchedule({
    id,
    name: "not implemented",
    prompt: "summarize my sessions",
    schedule: "@hourly",
    mode: "yolo",
    enabled: true,
  });
  store.create(job);
  const scheduler = newSchedulerWithSessionDir(
    store,
    null,
    3_600_000,
    sessionDir,
  );
  try {
    scheduler.runNow(id);
    const failed = await waitForStatus(store, id, "failed");
    assert(
      (failed.lastError ?? "").includes("unknown maintenance job"),
      "unknown-job refusal must be recorded",
    );
  } finally {
    await scheduler.stop();
    closeDatabases();
  }
});

function writeMaintenanceArtifactDirectory(
  sessionDir: string,
  id: string,
): string {
  const dir = path.join(sessionDir, "artifacts", id);
  Deno.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "content");
  Deno.writeTextFileSync(file, "stale bytes");
  const stamp = new Date(Date.now() - 30 * 24 * 3_600_000);
  Deno.utimeSync(file, stamp, stamp);
  Deno.utimeSync(dir, stamp, stamp);
  return file;
}

// --- Scheduler/SessionRuntime integration (cron_test.go leftovers, ported
// once the SessionRuntime slice landed) ---

function cronTestModel(): Model {
  return {
    id: "mock-model",
    name: "Mock",
    provider: "",
    reasoning: false,
    input: [],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 0,
  };
}

function cronTestFactory(
  sessionDir: string,
  mock: ReturnType<typeof newMockProvider>,
  model: Model,
) {
  const settings = defaultSettings();
  settings.sessionDir = sessionDir;
  return newAgentFactory(
    mock,
    model,
    settings,
    undefined,
    "",
    "",
    undefined,
    emptyCompaction(),
    undefined,
  );
}

Deno.test("SchedulerLocalJobWaitsForSessionRuntimeLock", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "mothx-cron-lock-" });
  const mgr = newManager(tmp, tmp);
  mgr.init();
  const sessionID = mgr.getHeader()!.id;
  const store = newSQLiteCronStore(tmp);
  const job = store.create({
    id: "job-lock",
    sessionId: sessionID,
    prompt: "run once",
    enabled: true,
    oneShot: true,
  });

  const model = cronTestModel();
  const mock = newMockProvider("mock", [model], [
    { type: streamTextDelta, textDelta: "done" },
    { type: streamDone, stopReason: "stop" },
  ]);
  const factory = cronTestFactory(tmp, mock, model);
  const sched = newSchedulerWithSessionDir(
    store,
    newAgentManager(factory),
    1_000,
    tmp,
  );
  let completions = 0;
  sched.setCompletionObserver(() => {
    completions++;
  });

  const release = await lockRuntime(tmp, job.sessionId!);
  try {
    const runPromise = sched.executeJob({ ...job });

    // While the session runtime lock is held the cron job must not run.
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(
      completions,
      0,
      "cron job ran while the runtime lock was held",
    );

    release();

    // Starting a local agent also initializes the session runtime and SQLite
    // stores. Keep the assertion focused on eventual execution after the lock
    // is released rather than imposing a tight limit.
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("cron job did not run after lock release")),
        10_000,
      );
    });
    await Promise.race([runPromise, timeout]);

    assertEquals(mock.getCallCount(), 1);
    const events = listSessionRunEvents(tmp, sessionID);
    assertEquals(events.length, 2);
    assertEquals(events[0].source, "cron");
    assertEquals(events[0].eventType, "started");
    assertEquals(events[1].eventType, "finished");
    const eventData = events[0].data as Record<string, string>;
    assertEquals(eventData["cronJobId"], job.id);
    assertEquals(eventData["cronJobName"], job.name ?? "");
  } finally {
    release();
    closeDatabases();
  }
});

Deno.test("SchedulerBoundChannelJobUsesForcedRuntimePolicy", async () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "mothx-cron-bound-" });
  const workDir = Deno.makeTempDirSync({ prefix: "mothx-cron-work-" });
  const bound = createBound(workDir, sessionDir, "wechat", "cron-policy-user");
  const boundID = bound.getHeader()!.id;
  const store = newSQLiteCronStore(sessionDir);
  const job = store.create({
    id: "job-bound-policy",
    sessionId: boundID,
    workDir,
    prompt: "run once",
    mode: "agent",
    enabled: true,
    oneShot: true,
  });

  const model = cronTestModel();
  const mock = newMockProvider("mock", [model], [
    { type: streamTextDelta, textDelta: "done" },
    { type: streamDone, stopReason: "stop" },
  ]);
  const factory = cronTestFactory(sessionDir, mock, model);
  const scheduler = newSchedulerWithSessionDir(
    store,
    newAgentManager(factory),
    1_000,
    sessionDir,
  );
  try {
    await scheduler.executeJob({ ...job });

    const events = listSessionRunEvents(sessionDir, boundID);
    assertEquals(events.length, 2);
    for (const event of events) {
      assertEquals(event.source, "wechat");
      assertEquals(event.mode, "yolo");
    }
  } finally {
    closeDatabases();
  }
});
