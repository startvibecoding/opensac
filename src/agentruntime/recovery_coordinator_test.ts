//
// The Go case drives a live external owner row with raw SQL; that fixture
// belongs to the runtime-lease/DAO tests and is omitted here. This covers the
// coordinator's startup scan, wake-driven convergence, idempotent start, and
// coordinated stop over the shared recovery path.

import { assert, assertEquals } from "@opensac/assert";
import { closeDatabases } from "../session/root_db.ts";
import { createManager } from "../session/manager.ts";
import { getSessionRun, getSessionRunRecovery } from "../session/mod.ts";
import { acquireExecutionAdmission } from "../session/runtime_lock.ts";
import { type DurableRun, RecoveryCoordinator, RunStore } from "./mod.ts";

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

function initSession(sessionDir: string, id: string): void {
  createManager(Deno.makeTempDirSync(), sessionDir).initWithID(id);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  deadlineMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(10);
  }
  return predicate();
}

Deno.test("RecoveryCoordinatorStartupScanConvergesThenWakeReconverges", async () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-coordinator-" });
  const store = new RunStore(sessionDir);
  const coordinator = new RecoveryCoordinator(sessionDir, {
    scanIntervalMs: 60_000,
  });
  try {
    initSession(sessionDir, "coordinator-session");
    store.create(durableRun({
      id: "coordinator-run",
      sessionId: "coordinator-session",
      source: "tui",
    }));
    await coordinator.start();
    assertEquals(
      getSessionRun(sessionDir, "coordinator-run")!.status,
      "failed",
    );
    assertEquals(
      getSessionRunRecovery(sessionDir, "coordinator-run")!.state,
      "completed",
    );

    // A second orphan admitted after startup converges only after a wake.
    const guard = acquireExecutionAdmission(sessionDir, "coordinator-session");
    store.create(durableRun({
      id: "coordinator-run-2",
      sessionId: "coordinator-session",
      source: "tui",
    }));
    guard.release();
    coordinator.wake();
    const converged = await waitFor(() =>
      getSessionRun(sessionDir, "coordinator-run-2")!.status === "failed"
    );
    assert(converged, "wake did not converge the newly admitted orphan");

    // A second start is a no-op; stop is coordinated and idempotent.
    await coordinator.start();
    await coordinator.stop();
    await coordinator.stop();
  } finally {
    await coordinator.stop();
    closeDatabases();
  }
});
