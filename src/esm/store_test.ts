import { assert, assertEquals } from "../compat/assert.ts";
import { closeAll } from "../db/mod.ts";
import {
  EsmInvalidTransitionError,
  EsmObjectiveExistsError,
  type Store,
} from "./store.ts";
import {
  canAutoRun,
  phaseAudit,
  phaseWorker,
  statusActive,
  statusBlocked,
  statusComplete,
  statusCompleteCandidate,
} from "./state.ts";
import { Store as ESMStore } from "./store.ts";
import { workerTaskPrompt } from "./prompt.ts";
import { test } from "#testing";

function createTestStore(): { store: Store; sessionID: string } {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-esm-store-" });
  return { store: new ESMStore(sessionDir), sessionID: "esm-session" };
}

function assertSentinel(fn: () => unknown, expected: new () => Error): void {
  let err: unknown = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert(
    err instanceof expected,
    `expected ${expected.name}; got ${String(err)}`,
  );
}

test("Store create and usage accounting", () => {
  const { store, sessionID } = createTestStore();
  try {
    let obj = store.create(sessionID, "ship esm");
    assertEquals(obj.status, statusActive);
    assertEquals(obj.objective, "ship esm");

    assertSentinel(
      () => store.create(sessionID, "replace"),
      EsmObjectiveExistsError,
    );

    obj = store.accountUsage(sessionID, 60, 1000);
    assertEquals(obj.status, statusActive);
    assertEquals(obj.tokensUsed, 60);

    // Usage is observability only: accumulating tokens never changes status.
    obj = store.accountUsage(sessionID, 40, 500);
    assertEquals(obj.status, statusActive);
    assertEquals(obj.tokensUsed, 100);
    assertEquals(obj.timeUsedMs, 1500);

    store.pause(sessionID);
    obj = store.resume(sessionID);
    assertEquals(obj.status, statusActive);
  } finally {
    closeAll();
  }
});

test("Store blocked audit and complete", () => {
  const { store, sessionID } = createTestStore();
  try {
    store.create(sessionID, "finish migration");
    let obj;
    for (const [i, runID] of ["run-1", "run-2"].entries()) {
      obj = store.updateFromModelForRun(
        sessionID,
        statusBlocked,
        "missing API token",
        runID,
      );
      assertEquals(obj.status, statusActive);
      assertEquals(obj.blockedCount, i + 1);
    }
    obj = store.updateFromModelForRun(
      sessionID,
      statusBlocked,
      "missing API token",
      "run-3",
    );
    assertEquals(obj.status, statusBlocked);
    assertEquals(obj.blockedCount, 3);

    obj = store.resume(sessionID);
    assertEquals(obj.blockedCount, 0);
    assertEquals(obj.blockedReason, "");
    assertEquals(obj.status, statusActive);

    obj = store.updateFromModel(sessionID, statusComplete, "all checks pass");
    assertEquals(obj.status, statusCompleteCandidate);
    assertEquals(obj.completionReason, "all checks pass");

    obj = store.markCompleteFromAudit(
      sessionID,
      "auditor verified every requirement",
    );
    assertEquals(obj.status, statusComplete);
  } finally {
    closeAll();
  }
});

test("Store blocked audit requires consecutive runs", () => {
  const { store, sessionID } = createTestStore();
  try {
    store.create(sessionID, "finish migration");
    let obj = store.updateFromModelForRun(
      sessionID,
      statusBlocked,
      "missing API token",
      "run-1",
    );
    assertEquals(obj.blockedCount, 1);
    assertEquals(obj.blockedRunId, "run-1");
    assertEquals(obj.status, statusActive);

    obj = store.updateFromModelForRun(
      sessionID,
      statusBlocked,
      "missing API token",
      "run-1",
    );
    assertEquals(obj.blockedCount, 1);

    obj = store.finishRun(sessionID, "run-2");
    assertEquals(obj.blockedCount, 0);
    assertEquals(obj.blockedReason, "");
    assertEquals(obj.blockedRunId, "");

    for (const [i, runID] of ["run-3", "run-4"].entries()) {
      obj = store.updateFromModelForRun(
        sessionID,
        statusBlocked,
        "missing API token",
        runID,
      );
      assertEquals(obj.blockedCount, i + 1);
      assertEquals(obj.status, statusActive);
    }
    obj = store.updateFromModelForRun(
      sessionID,
      statusBlocked,
      "missing API token",
      "run-5",
    );
    assertEquals(obj.blockedCount, 3);
    assertEquals(obj.status, statusBlocked);
  } finally {
    closeAll();
  }
});

test("Store complete requires evidence", () => {
  const { store, sessionID } = createTestStore();
  try {
    store.create(sessionID, "finish migration");
    let threw = false;
    try {
      store.updateFromModel(sessionID, statusComplete, "");
    } catch {
      threw = true;
    }
    assert(threw, "complete without evidence should fail");
  } finally {
    closeAll();
  }
});

test("Store reject completion candidate returns active", () => {
  const { store, sessionID } = createTestStore();
  try {
    store.create(sessionID, "finish migration");
    let obj = store.updateFromModelForRun(
      sessionID,
      statusComplete,
      "worker evidence",
      "run-1",
    );
    assertEquals(obj.status, statusCompleteCandidate);
    assertEquals(obj.completionRunId, "run-1");

    obj = store.rejectCompletionCandidate(sessionID, "missing requirement");
    assertEquals(obj.status, statusActive);
    assertEquals(obj.completionReview, "missing requirement");
    assertEquals(obj.rejectionCount, 1);
  } finally {
    closeAll();
  }
});

test("Store persists worker progress", () => {
  const { store, sessionID } = createTestStore();
  try {
    store.create(sessionID, "finish migration");
    let obj = store.recordWorkerProgress(sessionID, "implemented parser", [
      "add tests",
      "update docs",
    ]);
    assertEquals(obj.phase, phaseWorker);
    assertEquals(obj.progressSummary, "implemented parser");
    assertEquals(obj.remainingWork, ["add tests", "update docs"]);

    store.updateFromModelForRun(
      sessionID,
      statusComplete,
      "worker evidence",
      "run-1",
    );
    obj = store.setPhase(sessionID, phaseAudit);
    assertEquals(obj.phase, phaseAudit);
    assertEquals(obj.remainingWork, ["add tests", "update docs"]);
  } finally {
    closeAll();
  }
});

test("Store repeated recovery resets worker progress", () => {
  const { store, sessionID } = createTestStore();
  try {
    store.create(sessionID, "finish migration");
    for (let i = 1; i <= 4; i++) {
      const obj = store.recordRecovery(
        sessionID,
        "worker timed out",
        "observer found resumable work",
        ["finish tests"],
      );
      assertEquals(obj.status, statusActive);
      assertEquals(obj.recoveryCount, i);
      assertEquals(obj.recoveryReason, "worker timed out");
    }

    const obj = store.recordWorkerProgress(sessionID, "implemented tests", [
      "run verification",
    ]);
    assertEquals(obj.recoveryCount, 0);
    assertEquals(obj.recoveryReason, "");
  } finally {
    closeAll();
  }
});

test("Store repeated completion rejections remain active", () => {
  const { store, sessionID } = createTestStore();
  try {
    store.create(sessionID, "finish migration");
    for (let i = 1; i <= 4; i++) {
      const runID = `run-${i}`;
      store.updateFromModelForRun(
        sessionID,
        statusComplete,
        "worker evidence",
        runID,
      );
      const obj = store.rejectCompletionCandidateForRun(
        sessionID,
        runID,
        "missing requirement",
        ["add tests"],
      );
      assertEquals(obj.status, statusActive);
      assertEquals(obj.rejectionCount, i);
      assertEquals(obj.rejectionRunId, runID);
      assert(canAutoRun(obj));
      assertEquals(obj.remainingWork, ["add tests"]);

      const duplicate = store.rejectCompletionCandidateForRun(
        sessionID,
        runID,
        "duplicate",
        ["add tests"],
      );
      assertEquals(duplicate.rejectionCount, i);
    }

    let obj = store.get(sessionID);
    assert(canAutoRun(obj), "rejected objective must continue automatically");
    obj = store.finishRun(sessionID, "run-after-rejection");
    assertEquals(obj.status, statusActive);
    assertEquals(obj.rejectionCount, 0);
    assertEquals(obj.rejectionRunId, "");
    assertEquals(obj.completionReview, "missing requirement");
    assert(workerTaskPrompt(obj).includes("missing requirement"));
  } finally {
    closeAll();
  }
});

test("Store non-rejected run resets completion rejection streak", () => {
  const { store, sessionID } = createTestStore();
  try {
    store.create(sessionID, "finish migration");
    store.updateFromModelForRun(
      sessionID,
      statusComplete,
      "worker evidence",
      "run-1",
    );
    store.rejectCompletionCandidateForRun(sessionID, "run-1", "missing test", [
      "add test",
    ]);
    const obj = store.finishRun(sessionID, "run-2");
    assertEquals(obj.rejectionCount, 0);
    assertEquals(obj.rejectionRunId, "");
  } finally {
    closeAll();
  }
});

test("Store worker precheck rejection keeps objective active", () => {
  const { store, sessionID } = createTestStore();
  try {
    store.create(sessionID, "finish migration");
    let obj;
    for (let i = 1; i <= 4; i++) {
      obj = store.rejectWorkerReport(
        sessionID,
        `run-${i}`,
        "remaining work",
        ["finish implementation"],
      );
    }
    assertEquals(obj!.status, statusActive);
    assertEquals(obj!.rejectionCount, 4);
    assert(canAutoRun(obj!));
  } finally {
    closeAll();
  }
});

test("Store record completion review while active", () => {
  const { store, sessionID } = createTestStore();
  try {
    store.create(sessionID, "finish migration");
    const obj = store.recordCompletionReview(
      sessionID,
      "worker completion lacked tool-backed evidence",
    );
    assertEquals(obj.status, statusActive);
    assertEquals(
      obj.completionReview,
      "worker completion lacked tool-backed evidence",
    );
  } finally {
    closeAll();
  }
});

test("Store invalid transition sentinel", () => {
  const { store, sessionID } = createTestStore();
  try {
    store.create(sessionID, "finish migration");
    // Audit completion on an active (not candidate) objective is invalid.
    assertSentinel(
      () => store.markCompleteFromAudit(sessionID, "review"),
      EsmInvalidTransitionError,
    );
  } finally {
    closeAll();
  }
});
