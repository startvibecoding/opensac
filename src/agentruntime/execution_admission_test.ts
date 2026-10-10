//
// The Go tests drive a real session database and assert the lease-first
// admission contract: a stale durable orphan Run is reconciled before the guard
// is returned, a live owner is never displaced, and a verified remote Run is
// retained as a detached remote execution. `context.Context` maps to
// `AbortSignal`, so `context.DeadlineExceeded` maps to a `TimeoutError` reason.

import { assert, assertEquals, assertRejects } from "../compat/assert.ts";
import { createManager } from "../session/manager.ts";
import {
  acquireExecutionAdmission as sessionAcquireExecutionAdmission,
  getSessionRun,
  type ResponseRun,
  RuntimeLeaseBusyError,
  saveResponseRun,
} from "../session/mod.ts";
import { closeDatabases } from "../session/root_db.ts";
import {
  acquireExecutionAdmission,
  DetachedRemoteExecutionError,
  type DurableRun,
  RunStore,
} from "./mod.ts";
import { test } from "#testing";

function initRecoveryTestSession(sessionDir: string, id: string): void {
  const manager = createManager(Deno.makeTempDirSync(), sessionDir);
  manager.initWithID(id);
}

function makeRun(overrides: Partial<DurableRun>): DurableRun {
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

test(
  "acquireExecutionAdmissionRecoversOrphanBeforeReturningGuard",
  async () => {
    const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-admission-" });
    try {
      initRecoveryTestSession(sessionDir, "admission-recovery");
      new RunStore(sessionDir).create(
        makeRun({
          id: "stale",
          sessionId: "admission-recovery",
          source: "tui",
          status: "running",
          startedAt: new Date(),
        }),
      );
      const guard = await acquireExecutionAdmission(
        undefined,
        sessionDir,
        "admission-recovery",
        {},
      );
      try {
        const binding = guard.binding();
        assertEquals(binding.purpose, "admission");
        assertEquals(binding.runId, "");
        const stale = getSessionRun(sessionDir, "stale");
        assert(stale !== undefined, "stale run missing");
        assertEquals(stale!.status, "failed");
      } finally {
        guard.release();
      }
    } finally {
      closeDatabases();
    }
  },
);

test("acquireExecutionAdmissionDoesNotDisplaceLiveOwner", async () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-admission-" });
  try {
    initRecoveryTestSession(sessionDir, "admission-owned");
    const owner = sessionAcquireExecutionAdmission(
      sessionDir,
      "admission-owned",
    );
    try {
      new RunStore(sessionDir).create(
        makeRun({
          id: "owned",
          sessionId: "admission-owned",
          source: "acp",
          status: "running",
          startedAt: new Date(),
        }),
      );
      await assertRejects(
        () =>
          acquireExecutionAdmission(undefined, sessionDir, "admission-owned"),
        RuntimeLeaseBusyError,
      );
      let thrown: unknown;
      try {
        await acquireExecutionAdmission(
          AbortSignal.timeout(30),
          sessionDir,
          "admission-owned",
          { wait: true, pollIntervalMs: 1 },
        );
      } catch (err) {
        thrown = err;
      }
      assert(thrown !== undefined, "waiting admission should have thrown");
      assert(
        thrown instanceof DOMException && thrown.name === "TimeoutError",
        `waiting admission error = ${String(thrown)}, want TimeoutError`,
      );
    } finally {
      owner.release();
    }
  } finally {
    closeDatabases();
  }
});

test("acquireExecutionAdmissionRetainsVerifiedRemoteRun", async () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-admission-" });
  try {
    initRecoveryTestSession(sessionDir, "admission-remote");
    const now = new Date();
    new RunStore(sessionDir).create(
      makeRun({
        id: "remote-parent",
        sessionId: "admission-remote",
        source: "responses_background",
        status: "running",
        startedAt: now,
      }),
    );
    const remote: ResponseRun = {
      id: 0,
      sessionId: "admission-remote",
      localRunId: "remote",
      localTurnId: "remote-parent",
      messageId: null,
      responseId: "resp",
      provider: "openai",
      api: "openai-responses",
      state: "queued",
      pollingUrl: "",
      lastEventSequence: null,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
    };
    saveResponseRun(sessionDir, remote);

    await assertRejects(
      () =>
        acquireExecutionAdmission(undefined, sessionDir, "admission-remote"),
      DetachedRemoteExecutionError,
    );
  } finally {
    closeDatabases();
  }
});
