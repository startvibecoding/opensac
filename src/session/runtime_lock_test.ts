// Ported from internal/session/runtime_lock_test.go
//
// The Go tests drive admission through the session Manager; the not-yet-ported
// Manager is replaced with direct DAO session/Run persistence so the portable
// lease surface can be exercised on its own.

import { assert, assertEquals, assertThrows } from "@std/assert";
import * as path from "@std/path";
import { closeAll } from "../db/mod.ts";
import { RunDAO, RuntimeLeaseDAO, SessionDAO } from "../dao/mod.ts";
import {
  acquireExecutionAdmission,
  acquireFork,
  acquireMutation,
  acquireMutations,
  acquireRecovery,
  currentRuntimeLeaseBinding,
  leaseDirKey,
  LeaseHeartbeatScheduler,
  leaseHeartbeatSchedulers,
  runtimeHeartbeatTiming,
  RuntimeLeaseLostError,
  RuntimeLeaseRunMismatchError,
  RuntimeSessionNotFoundError,
  SessionRecoveryNotNeededError,
  SessionRecoveryRequiredError,
  SessionRunActiveError,
  snapshotRuntimeLeasesForDir,
  tryLockRuntime,
  validateRuntimeLeaseTx,
} from "./mod.ts";
import { openRootDB } from "./root_db.ts";

function makeSession(sessionDir: string, id: string): void {
  const db = openRootDB(sessionDir);
  new SessionDAO(db.db).insertSession(
    db.db!,
    "sessions",
    id,
    `/tmp/${id}`,
    new Date().toISOString(),
    "",
    3,
    "local",
    "",
    0,
    0,
    "",
    "",
  );
}

function makeRun(
  sessionDir: string,
  sessionId: string,
  runId: string,
  status: string,
): void {
  const db = openRootDB(sessionDir);
  const now = new Date().toISOString();
  new RunDAO(db.db).insertRun(db.db!, {
    id: runId,
    sessionId,
    intentId: "",
    retryOf: "",
    attempt: 1,
    workDir: "",
    source: "",
    model: "",
    mode: "",
    status,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    error: "",
    errorInfoJson: "{}",
    progressJson: "{}",
    usageJson: "{}",
    contextUsageJson: "{}",
  });
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

Deno.test("released lease leaves a fencing tombstone", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-lease-" });
  try {
    makeSession(sessionDir, "lease-tombstone");
    const [releaseOld, okOld] = tryLockRuntime(sessionDir, "lease-tombstone");
    assert(okOld, "first lease must acquire");
    releaseOld();
    const [releaseNew, okNew] = tryLockRuntime(sessionDir, "lease-tombstone");
    assert(okNew, "second lease must acquire after release");
    releaseNew();

    const db = openRootDB(sessionDir);
    // A delayed write from the released owner is fenced.
    assertThrows(
      () => validateRuntimeLeaseTx(db.db!, sessionDir, "lease-tombstone"),
      RuntimeLeaseLostError,
    );
  } finally {
    closeAll();
  }
});

Deno.test("admission requires an existing idle session", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-lease-" });
  try {
    makeSession(sessionDir, "admission-idle");
    const guard = acquireExecutionAdmission(sessionDir, "admission-idle");
    const binding = guard.binding();
    assertEquals(binding.purpose, "admission");
    assertEquals(binding.runId, "");
    assertEquals(binding.sessionId, "admission-idle");
    guard.release();
    guard.release(); // idempotent

    assertThrows(
      () => acquireExecutionAdmission(sessionDir, "missing-session"),
      RuntimeSessionNotFoundError,
    );
  } finally {
    closeAll();
  }
});

Deno.test("admission requires recovery for an active run", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-lease-" });
  try {
    makeSession(sessionDir, "admission-active");
    makeRun(sessionDir, "admission-active", "run-active", "running");

    assertThrows(
      () => acquireExecutionAdmission(sessionDir, "admission-active"),
      SessionRecoveryRequiredError,
    );
    assertThrows(
      () => acquireMutation(sessionDir, "admission-active"),
      SessionRunActiveError,
    );
    assertThrows(
      () => acquireFork(sessionDir, "admission-active"),
      SessionRunActiveError,
    );
  } finally {
    closeAll();
  }
});

Deno.test("recovery binds the expected active run", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-lease-" });
  try {
    makeSession(sessionDir, "recovery-bind");
    makeRun(sessionDir, "recovery-bind", "run-recovery", "running");

    assertThrows(
      () => acquireRecovery(sessionDir, "recovery-bind", "other-run"),
      RuntimeLeaseRunMismatchError,
    );
    const guard = acquireRecovery(sessionDir, "recovery-bind", "run-recovery");
    try {
      const binding = guard.binding();
      assertEquals(binding.purpose, "recovery");
      assertEquals(binding.runId, "run-recovery");
      assertEquals(binding.epoch, 1);
    } finally {
      guard.release();
    }
  } finally {
    closeAll();
  }
});

Deno.test("recovery requires an active run", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-lease-" });
  try {
    makeSession(sessionDir, "recovery-idle");
    assertThrows(
      () => acquireRecovery(sessionDir, "recovery-idle", "run-missing"),
      SessionRecoveryNotNeededError,
    );
  } finally {
    closeAll();
  }
});

Deno.test("multi-mutation releases earlier sessions on conflict", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-lease-" });
  try {
    makeSession(sessionDir, "mutation-a");
    makeSession(sessionDir, "mutation-b");
    makeRun(sessionDir, "mutation-b", "run-b", "running");

    assertThrows(
      () => acquireMutations(sessionDir, ["mutation-b", "mutation-a"]),
      SessionRunActiveError,
    );
    // The earlier acquisition (mutation-a, sorted first) must have been
    // released when mutation-b conflicted.
    const guard = acquireMutation(sessionDir, "mutation-a");
    guard.release();
  } finally {
    closeAll();
  }
});

Deno.test("an unexpired lease blocks a competing process", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-lease-" });
  try {
    makeSession(sessionDir, "lease-busy");
    const db = openRootDB(sessionDir);
    const now = nowSeconds();
    new RuntimeLeaseDAO(db.db).insert(db.db!, {
      sessionId: "lease-busy",
      ownerId: "other-process",
      ownerPid: 999999,
      ownerKind: "process",
      tokenHash: "deadbeef",
      epoch: 1,
      runId: "",
      purpose: "run",
      state: "active",
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: now + 3600,
      updatedAt: now,
    });
    const [, ok] = tryLockRuntime(sessionDir, "lease-busy");
    assertEquals(ok, false);
  } finally {
    closeAll();
  }
});

Deno.test("an expired lease is reclaimed with a fencing epoch bump", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-lease-" });
  try {
    makeSession(sessionDir, "lease-expired");
    const db = openRootDB(sessionDir);
    const now = nowSeconds();
    new RuntimeLeaseDAO(db.db).insert(db.db!, {
      sessionId: "lease-expired",
      ownerId: "dead-process",
      ownerPid: 999999,
      ownerKind: "process",
      tokenHash: "deadbeef",
      epoch: 1,
      runId: "",
      purpose: "run",
      state: "active",
      acquiredAt: now - 100,
      heartbeatAt: now - 100,
      expiresAt: now - 1,
      updatedAt: now - 100,
    });

    const [release, ok] = tryLockRuntime(sessionDir, "lease-expired");
    assert(ok, "expired lease must be reclaimable");
    const binding = currentRuntimeLeaseBinding(sessionDir, "lease-expired");
    assert(
      binding !== null && binding.epoch >= 2,
      "fencing epoch must advance",
    );
    release();

    const record = new RuntimeLeaseDAO(db.db).find(db.db!, "lease-expired");
    assertEquals(record.state, "released");
  } finally {
    closeAll();
  }
});

Deno.test("heartbeat batch renews survivors and marks displaced leases lost", async () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-lease-" });
  try {
    makeSession(sessionDir, "hb-batch-1");
    makeSession(sessionDir, "hb-batch-2");
    const guardA = acquireExecutionAdmission(sessionDir, "hb-batch-1");
    const guardB = acquireExecutionAdmission(sessionDir, "hb-batch-2");
    try {
      const dirKey = leaseDirKey(sessionDir);
      const scheduler = leaseHeartbeatSchedulers.get(dirKey);
      assert(scheduler !== undefined, "a scheduler must be started");
      // Detach the live tick so this test drives renewal deterministically.
      scheduler!.stop();

      const db = openRootDB(sessionDir);
      const beforeA = new RuntimeLeaseDAO(db.db).find(db.db!, "hb-batch-1")
        .heartbeatAt;
      // Bump B's epoch to simulate another process taking over.
      db.db!.run(
        "UPDATE session_runtime_leases SET epoch = epoch + 1 WHERE session_id = ?",
        "hb-batch-2",
      );

      await scheduler!.renew(snapshotRuntimeLeasesForDir(dirKey));

      assert(guardB.lost()?.aborted, "displaced lease B must be marked lost");
      const afterA = new RuntimeLeaseDAO(db.db).find(db.db!, "hb-batch-1")
        .heartbeatAt;
      assert(afterA >= beforeA, "surviving lease A must stay renewable");
    } finally {
      guardA.release();
      guardB.release();
    }
  } finally {
    closeAll();
  }
});

Deno.test("retire keeps a live lease and stops only for an empty directory", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-lease-" });
  try {
    makeSession(sessionDir, "retire-race");
    const dirKey = leaseDirKey(sessionDir);
    // Install a deterministic scheduler without starting its loop.
    const scheduler = new LeaseHeartbeatScheduler(dirKey);
    const previous = leaseHeartbeatSchedulers.get(dirKey);
    leaseHeartbeatSchedulers.set(dirKey, scheduler);

    const guard = acquireExecutionAdmission(sessionDir, "retire-race");
    try {
      assertEquals(scheduler.retire(), false);
      assertEquals(leaseHeartbeatSchedulers.get(dirKey), scheduler);
      assertEquals(scheduler.stopped, false);
    } finally {
      guard.release();
    }
    assertEquals(scheduler.retire(), true);
    assertEquals(leaseHeartbeatSchedulers.has(dirKey), false);
    assertEquals(scheduler.stopped, true);

    if (previous === undefined) leaseHeartbeatSchedulers.delete(dirKey);
    else leaseHeartbeatSchedulers.set(dirKey, previous);
  } finally {
    closeAll();
  }
});

Deno.test("a transient renewal error never marks the lease lost", async () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-lease-" });
  const originalBudget = runtimeHeartbeatTiming.retryBudgetMs;
  try {
    makeSession(sessionDir, "renew-stall");
    const guard = acquireExecutionAdmission(sessionDir, "renew-stall");
    try {
      const dirKey = leaseDirKey(sessionDir);
      leaseHeartbeatSchedulers.get(dirKey)?.stop();

      const db = openRootDB(sessionDir);
      // Force the row to look expired, then point renewal at an unreachable
      // database path.
      db.db!.run(
        "UPDATE session_runtime_leases SET expires_at = CAST(strftime('%s','now') AS INTEGER) - 1 WHERE session_id = ?",
        "renew-stall",
      );
      const blocked = path.join(sessionDir, "blocked-dir");
      Deno.writeTextFileSync(blocked, "not a directory");
      runtimeHeartbeatTiming.retryBudgetMs = 600;

      const scheduler = new LeaseHeartbeatScheduler(blocked);
      await scheduler.renew(snapshotRuntimeLeasesForDir(dirKey));

      assert(!guard.lost()?.aborted, "a renewal error must not lose the lease");
      // The expired-but-owned lease must still accept execution-path writes.
      validateRuntimeLeaseTx(db.db!, sessionDir, "renew-stall");
    } finally {
      guard.release();
    }
  } finally {
    runtimeHeartbeatTiming.retryBudgetMs = originalBudget;
    closeAll();
  }
});

Deno.test("renewal recovers after repeated timeout ticks", async () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-lease-" });
  const originalBudget = runtimeHeartbeatTiming.retryBudgetMs;
  try {
    makeSession(sessionDir, "renew-recover");
    const guard = acquireExecutionAdmission(sessionDir, "renew-recover");
    try {
      const realKey = leaseDirKey(sessionDir);
      leaseHeartbeatSchedulers.get(realKey)?.stop();
      const db = openRootDB(sessionDir);
      db.db!.run(
        "UPDATE session_runtime_leases SET expires_at = CAST(strftime('%s','now') AS INTEGER) - 1 WHERE session_id = ?",
        "renew-recover",
      );
      const blocked = path.join(sessionDir, "blocked-dir");
      Deno.writeTextFileSync(blocked, "not a directory");
      runtimeHeartbeatTiming.retryBudgetMs = 400;

      const timedOut = new LeaseHeartbeatScheduler(blocked);
      for (let i = 0; i < 3; i++) {
        await timedOut.renew(snapshotRuntimeLeasesForDir(realKey));
      }
      assert(
        !guard.lost()?.aborted,
        "repeated timeouts must not lose the lease",
      );

      const recovered = new LeaseHeartbeatScheduler(sessionDir);
      await recovered.renew(snapshotRuntimeLeasesForDir(realKey));
      const record = new RuntimeLeaseDAO(db.db).find(db.db!, "renew-recover");
      assert(
        record.expiresAt > nowSeconds(),
        "the lease must be renewed once the database recovers",
      );
    } finally {
      guard.release();
    }
  } finally {
    runtimeHeartbeatTiming.retryBudgetMs = originalBudget;
    closeAll();
  }
});
