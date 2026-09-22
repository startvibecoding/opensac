// Translated from internal/agentruntime/run_recovery_test.go plus focused
// RunStore coverage.
//
// Deviations: Go's goroutine worker pool maps to an async bounded pool, so the
// parallelism/timing cases await instead of sleeping synchronously;
// `InspectSessionExecution`-based assertions and the raw-SQL trigger case are
// deferred to the execution-snapshot slice, and `context.DeadlineExceeded`
// maps to a `TimeoutError` reason.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { closeDatabases } from "../session/root_db.ts";
import { newManager } from "../session/manager.ts";
import {
  acquireExecutionAdmission,
  getSessionRun,
  getSessionRunRecovery,
  saveResponseRun,
  type SessionRun,
} from "../session/mod.ts";
import {
  defaultRunRecoveryPolicy,
  type DurableRun,
  recoverOrphanedRuns,
  recoverOrphanedRunsWithTrigger,
  recoverOrphanedSessionRun,
  RecoveryFailLocal,
  RecoveryKeepRemote,
  recoveryWorkerLimit,
  RunStore,
} from "./mod.ts";

function durableRun(overrides: Partial<DurableRun>): DurableRun {
  return {
    id: "",
    sessionId: "",
    intentId: "",
    retryOf: "",
    attempt: 0,
    workDir: "",
    source: "",
    model: "",
    mode: "",
    status: "running",
    startedAt: new Date(),
    finishedAt: null,
    error: "",
    errorInfo: {},
    progress: {},
    usage: undefined,
    contextUsage: undefined,
    inputResourceIds: [],
    submissionKeyHash: "",
    submissionScope: "",
    submissionFingerprint: "",
    userEntryId: "",
    assistantEntryId: "",
    conversationTurnId: "",
    conversationTurn: false,
    ...overrides,
  };
}

function initRecoveryTestSession(sessionDir: string, id: string): void {
  const manager = newManager(Deno.makeTempDirSync(), sessionDir);
  manager.initWithID(id);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.test("RecoverOrphanedRunsFailsLocalAndKeepsRemote", async () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-recovery-" });
  try {
    const store = new RunStore(sessionDir);
    const now = new Date();
    initRecoveryTestSession(sessionDir, "session-1");
    initRecoveryTestSession(sessionDir, "session-2");
    store.create(durableRun({
      id: "local",
      sessionId: "session-1",
      source: "acp",
      startedAt: now,
    }));
    store.create(durableRun({
      id: "remote",
      sessionId: "session-2",
      source: "responses_background",
      startedAt: now,
    }));

    const cleaned: string[] = [];
    const result = await recoverOrphanedRuns(
      sessionDir,
      (run) => run.id === "remote" ? RecoveryKeepRemote : RecoveryFailLocal,
      (run) => {
        cleaned.push(run.id);
      },
    );
    assertEquals(result.failed.map((r) => r.id), ["local"]);
    assertEquals(result.kept.map((r) => r.id), ["remote"]);
    assertEquals(cleaned, ["local"]);
    assertEquals(getSessionRun(sessionDir, "local")!.status, "failed");
    assertEquals(getSessionRun(sessionDir, "remote")!.status, "running");
  } finally {
    closeDatabases();
  }
});

Deno.test("RecoverOrphanedRunsParallelizesAndPreservesScanOrder", async () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-recovery-" });
  try {
    const store = new RunStore(sessionDir);
    for (let i = 0; i < 10; i++) {
      const id = `parallel-${String(i).padStart(2, "0")}`;
      initRecoveryTestSession(sessionDir, id);
      store.create(durableRun({
        id: `run-${id}`,
        sessionId: id,
        startedAt: new Date((100 + i) * 1000),
      }));
    }
    let active = 0;
    let maxActive = 0;
    let arrived = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const result = await recoverOrphanedRuns(sessionDir, null, async () => {
      active++;
      if (active > maxActive) maxActive = active;
      arrived++;
      if (arrived === 2) releaseBarrier();
      await Promise.race([barrier, delay(30_000)]);
      active--;
    });
    assert(
      maxActive >= 2,
      `maximum recovery concurrency = ${maxActive}, want parallel workers`,
    );
    assertEquals(result.failed.length, 10);
    result.failed.forEach((run, i) => {
      assertEquals(run.id, `run-parallel-${String(i).padStart(2, "0")}`);
    });
  } finally {
    closeDatabases();
  }
});

Deno.test("RecoverOrphanedRunsSlowAttemptDoesNotBlockOtherSessions", async () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-recovery-" });
  try {
    const store = new RunStore(sessionDir);
    initRecoveryTestSession(sessionDir, "slow-session");
    initRecoveryTestSession(sessionDir, "fast-session");
    store.create(durableRun({
      id: "slow-run",
      sessionId: "slow-session",
      source: "tui",
    }));
    store.create(durableRun({
      id: "fast-run",
      sessionId: "fast-session",
      source: "tui",
    }));

    let fastAttemptStarted = false;
    const resultCh = recoverOrphanedRunsWithSlowPolicy(
      sessionDir,
      () => {
        fastAttemptStarted = true;
      },
    );
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !fastAttemptStarted) {
      await delay(10);
    }
    assert(fastAttemptStarted, "fast recovery attempt never started");
    let fastDone = false;
    while (Date.now() < deadline) {
      const run = getSessionRun(sessionDir, "fast-run");
      if (run !== null && run.status === "failed") {
        fastDone = true;
        break;
      }
      await delay(10);
    }
    assert(fastDone, "fast run remained blocked by slow attempt");
    const err = await resultCh;
    assert(err instanceof Error);
    assertEquals((err as Error).name, "TimeoutError");
  } finally {
    closeDatabases();
  }
});

async function recoverOrphanedRunsWithSlowPolicy(
  sessionDir: string,
  onFast: () => void,
): Promise<unknown> {
  try {
    await recoverOrphanedRunsWithTrigger(
      undefined,
      sessionDir,
      "periodic",
      1_000,
      null,
      async (run) => {
        if (run.id === "slow-run") {
          // Simulate an adapter callback that ignores cancellation. The other
          // worker must still make progress for its own Session.
          await delay(4_000);
        } else if (run.id === "fast-run") {
          onFast();
        }
      },
    );
    return undefined;
  } catch (err) {
    return err;
  }
}

Deno.test("RecoverOrphanedSessionRunForAdmissionFailsOnlyLocalRun", async () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-recovery-" });
  try {
    const store = new RunStore(sessionDir);
    initRecoveryTestSession(sessionDir, "session-local");
    initRecoveryTestSession(sessionDir, "session-remote");
    store.create(durableRun({
      id: "stale-local",
      sessionId: "session-local",
      source: "wechat",
    }));
    store.create(durableRun({
      id: "remote",
      sessionId: "session-remote",
      source: "responses_background",
    }));

    const local = await recoverOrphanedSessionRun(
      sessionDir,
      "session-local",
      null,
      null,
    );
    assertEquals(local.failed.map((r) => r.id), ["stale-local"]);
    assertEquals(local.kept.length, 0);
    assertEquals(getSessionRun(sessionDir, "stale-local")!.status, "failed");

    const remote = await recoverOrphanedSessionRun(
      sessionDir,
      "session-remote",
      () => RecoveryKeepRemote,
      null,
    );
    assertEquals(remote.kept.map((r) => r.id), ["remote"]);
    assertEquals(remote.failed.length, 0);
    assertEquals(getSessionRun(sessionDir, "remote")!.status, "running");
  } finally {
    closeDatabases();
  }
});

Deno.test("RecoverOrphanedRunsSkipsValidExecutionLease", async () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-recovery-" });
  try {
    initRecoveryTestSession(sessionDir, "session-owned");
    const guard = acquireExecutionAdmission(sessionDir, "session-owned");
    const store = new RunStore(sessionDir);
    try {
      store.create(durableRun({
        id: "owned",
        sessionId: "session-owned",
        source: "acp",
      }));
      let result = await recoverOrphanedRuns(sessionDir, null, null);
      assertEquals(result.skipped.map((r) => r.id), ["owned"]);
      assertEquals(result.failed.length, 0);
      assertEquals(getSessionRun(sessionDir, "owned")!.status, "running");
      guard.release();
      result = await recoverOrphanedRuns(sessionDir, null, null);
      assertEquals(result.failed.map((r) => r.id), ["owned"]);
    } finally {
      guard.release();
    }
  } finally {
    closeDatabases();
  }
});

Deno.test("DefaultRunRecoveryPolicyDoesNotTrustSourceAlone", () => {
  assertEquals(
    defaultRunRecoveryPolicy(
      { source: "responses_background" } as SessionRun,
    ),
    RecoveryFailLocal,
  );
});

Deno.test("RecoverOrphanedRunsKeepsVerifiedRemoteRecord", async () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-recovery-" });
  try {
    initRecoveryTestSession(sessionDir, "session-remote-record");
    const now = new Date();
    new RunStore(sessionDir).create(durableRun({
      id: "remote-parent",
      sessionId: "session-remote-record",
      source: "responses_background",
      startedAt: now,
    }));
    saveResponseRun(sessionDir, {
      id: 0,
      sessionId: "session-remote-record",
      localRunId: "remote-provider-run",
      localTurnId: "remote-parent",
      messageId: null,
      responseId: "resp-remote",
      provider: "openai",
      api: "openai-responses",
      state: "queued",
      pollingUrl: "",
      lastEventSequence: null,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
    });
    const result = await recoverOrphanedRuns(sessionDir, null, null);
    assertEquals(result.kept.map((r) => r.id), ["remote-parent"]);
    assertEquals(result.failed.length, 0);
    const recovery = getSessionRunRecovery(sessionDir, "remote-parent");
    assertEquals(recovery!.state, "detached_remote");
  } finally {
    closeDatabases();
  }
});

Deno.test("RecoveryFailureIsDurableAndRetryable", async () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-recovery-" });
  try {
    initRecoveryTestSession(sessionDir, "session-retry");
    new RunStore(sessionDir).create(durableRun({
      id: "retry",
      sessionId: "session-retry",
      source: "tui",
    }));
    const wantErr = new Error("decision cleanup unavailable");
    await assertRejects(
      () =>
        recoverOrphanedRuns(sessionDir, null, () => {
          throw wantErr;
        }),
      Error,
      "decision cleanup unavailable",
    );
    const recovery = getSessionRunRecovery(sessionDir, "retry")!;
    assertEquals(recovery.state, "failed");
    assertEquals(recovery.attempt, 1);
    assertEquals(recovery.lastError, wantErr.message);
    assert(recovery.nextRetryAt !== null);

    const result = await recoverOrphanedSessionRun(
      sessionDir,
      "session-retry",
      null,
      null,
    );
    assertEquals(result.failed.length, 1);
    const completed = getSessionRunRecovery(sessionDir, "retry")!;
    assertEquals(completed.state, "completed");
    assertEquals(completed.attempt, 2);
    assert(completed.completedAt !== null);
  } finally {
    closeDatabases();
  }
});

Deno.test("RecoveryWorkerLimitIsPositive", () => {
  assert(recoveryWorkerLimit > 0);
});
