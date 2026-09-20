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
import { closeDatabases } from "../session/mod.ts";
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
