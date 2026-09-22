// Translated from internal/serve/openaiapi/approval_test.go
// (TestResolveOrphanedQuestions, TestRecoveredPendingQuestions,
// TestRuntimeSnapshotIncludesPendingApproval) and decision_recovery_test.go
// (TestResolveOrphanedDecisionsCancelsApprovalAndQuestion) — the cases whose
// Server-bound halves live in session_runtime_snapshot.ts. The WebSocket
// runtime projection stays with the websocket slice.
import { assert, assertEquals } from "@std/assert";
import type { Settings } from "../../config/settings.ts";
import {
  DecisionApproval,
  DecisionService,
} from "../../agentruntime/decision.ts";
import { createSession } from "../../agentruntime/session_lifecycle.ts";
import { closeAll } from "../../db/mod.ts";
import {
  acquireExecutionAdmission,
  listSessionRunEvents,
  type SessionRun,
} from "../../session/mod.ts";
import { type DurableRun, RunStore } from "../../agentruntime/run_store.ts";
import {
  recordSessionApprovalRequest,
  recordSessionQuestionRequest,
} from "./approval.ts";
import { Server } from "./server.ts";
import { APISession, SessionPool } from "./session_mgr.ts";
import {
  getSessionRuntime,
  recoveredPendingQuestions,
  resolveOrphanedDecisions,
  resolveOrphanedQuestions,
} from "./session_runtime_snapshot.ts";

function tempDir(): string {
  return Deno.makeTempDirSync({ prefix: "opensac-openaiapi-snapshot-" });
}

function settingsFor(dir: string): Settings {
  return { sessionDir: dir } as unknown as Settings;
}

/** Builds the canonical durable Run input for the admission path. */
function makeDurableRun(
  sessionId: string,
  workDir: string,
  id: string,
): DurableRun {
  return durableRunFields(sessionId, workDir, id);
}

function durableRunFields(
  sessionId: string,
  workDir: string,
  id: string,
): DurableRun {
  const now = new Date();
  return {
    id,
    sessionId,
    intentId: "",
    retryOf: "",
    attempt: 0,
    workDir,
    source: "webui",
    model: "test",
    mode: "agent",
    status: "running",
    startedAt: now,
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
  };
}

/** Builds the persisted-run shape the orphan-recovery helpers consume. */
function makeSessionRun(
  sessionId: string,
  workDir: string,
  id: string,
): SessionRun {
  return {
    ...durableRunFields(sessionId, workDir, id),
    updatedAt: new Date(),
  } as unknown as SessionRun;
}

function newTestServer(_workDir: string, sessionDir: string): Server {
  return new Server({
    settings: settingsFor(sessionDir),
  });
}

function activeSession(
  server: Server,
  workDir: string,
  sessionDir: string,
  id: string,
): APISession {
  const mgr = createSession({ workDir, sessionDir, id });
  const sess = new APISession();
  sess.id = id;
  sess.workDir = workDir;
  sess.manager = mgr;
  server.pool = server.pool ?? new SessionPool(0, 0);
  server.pool.put(sess);
  return sess;
}

Deno.test("resolveOrphanedQuestions cancels the durable pending question", () => {
  const workDir = tempDir();
  const sessionDir = tempDir();
  try {
    const server = newTestServer(workDir, sessionDir);
    const sess = activeSession(server, workDir, sessionDir, "question-orphan");
    const run = makeSessionRun(sess.id, sess.workDir, "run-orphan");
    const request = {
      questionId: "question-orphan",
      sessionId: sess.id,
      runId: run.id,
      question: "continue?",
      options: ["yes"],
    };
    assertEquals(recordSessionQuestionRequest(server, sess, request), null);
    assertEquals(resolveOrphanedQuestions(server, run), null);
    assertEquals(recoveredPendingQuestions(server, sess.id, run.id), []);
  } finally {
    closeAll();
  }
});

Deno.test("recoveredPendingQuestions re-projects only unresolved questions", () => {
  const workDir = tempDir();
  const sessionDir = tempDir();
  try {
    const server = newTestServer(workDir, sessionDir);
    const sess = activeSession(
      server,
      workDir,
      sessionDir,
      "question-recovery",
    );
    const request = {
      questionId: "question-recover",
      sessionId: sess.id,
      runId: "run-recover",
      question: "continue?",
      options: ["yes", "no"],
    };
    assertEquals(recordSessionQuestionRequest(server, sess, request), null);
    const pending = recoveredPendingQuestions(server, sess.id, request.runId);
    assertEquals(pending.length, 1);
    assertEquals(pending[0].questionId, request.questionId);

    // Resolve the question through the durable ledger (no live run needed).
    const resolutionErr = resolveOrphanedQuestions(
      server,
      makeSessionRun(sess.id, sess.workDir, request.runId),
    );
    assertEquals(resolutionErr, null);
    assertEquals(
      recoveredPendingQuestions(server, sess.id, request.runId).length,
      0,
      "resolved question still recovered",
    );
  } finally {
    closeAll();
  }
});

Deno.test("resolveOrphanedDecisions cancels both pending approval and question", () => {
  const workDir = tempDir();
  const sessionDir = tempDir();
  try {
    const server = newTestServer(workDir, sessionDir);
    const sess = activeSession(
      server,
      workDir,
      sessionDir,
      "orphan-decisions",
    );
    const run = makeSessionRun(
      sess.id,
      sess.workDir,
      "run-orphan-decisions",
    );
    const approval = {
      approvalId: "approval-1",
      sessionId: sess.id,
      runId: run.id,
      mode: "agent",
    };
    const question = {
      questionId: "question-1",
      sessionId: sess.id,
      runId: run.id,
      question: "continue?",
    };
    assertEquals(recordSessionApprovalRequest(server, sess, approval), null);
    assertEquals(recordSessionQuestionRequest(server, sess, question), null);

    assertEquals(resolveOrphanedDecisions(server, run), null);

    const events = listSessionRunEvents(sessionDir, sess.id);
    const statuses: Record<string, string> = {};
    for (const ev of events) {
      const envelope = (ev.data ?? {}) as {
        decision?: { id?: string; status?: string };
      };
      if (envelope.decision?.id) {
        statuses[envelope.decision.id] = envelope.decision.status ?? "";
      }
    }
    assertEquals(statuses["approval-1"], "cancelled");
    assertEquals(statuses["question-1"], "cancelled");
  } finally {
    closeAll();
  }
});

Deno.test("getSessionRuntime includes the active run and pending approval", () => {
  const workDir = tempDir();
  const sessionDir = tempDir();
  try {
    const server = newTestServer(workDir, sessionDir);
    const sess = activeSession(server, workDir, sessionDir, "approval-runtime");
    // Canonical durable run admission (RunStore) creates the active run row
    // that the execution snapshot projects (the test-hygiene guard bars raw
    // saveSessionRun calls in adapter tests).
    const guard = acquireExecutionAdmission(sessionDir, sess.id);
    const execution = sess.ensureExecution();
    execution.setRunStore(new RunStore(sessionDir));
    execution.beginDurable(
      undefined,
      makeDurableRun(sess.id, sess.workDir, "run_1"),
      {
        sessionId: sess.id,
        runId: "run_1",
        eventType: "started",
        source: "webui",
        status: "",
        model: "test",
        mode: "agent",
      },
    );
    sess.beginRun("run_1");
    try {
      sess.decisions = new DecisionService();
      sess.decisions.register({
        id: "approval_1",
        runId: "run_1",
        sessionId: sess.id,
        kind: DecisionApproval,
      });
      sess.pendingApprovals.set("approval_1", {
        request: {
          approvalId: "approval_1",
          sessionId: sess.id,
          runId: "run_1",
          summary: "Run bash",
        },
      });

      const { snapshot, err } = getSessionRuntime(server, sess.id);
      assertEquals(err, null);
      assert(snapshot !== null);
      assertEquals(snapshot!.activeRun?.runId, "run_1");
      assertEquals(snapshot!.pendingApprovals.length, 1);
      assertEquals(snapshot!.pendingApprovals[0].approvalId, "approval_1");
    } finally {
      if (execution.active().active) {
        try {
          execution.finishDurable("run_1", "cancelled", "test cleanup", {
            sessionId: sess.id,
            runId: "run_1",
            eventType: "finished",
            source: "webui",
            status: "",
            model: "test",
            mode: "agent",
          });
        } catch {
          // best-effort cleanup
        }
      }
      guard.release();
    }
  } finally {
    closeAll();
  }
});
