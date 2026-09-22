// Translated from internal/serve/openaiapi/approval_test.go — the
// CancelSessionRun cases (TestCancelSessionRunAbortsPendingApproval,
// TestCancelSessionRunBeforeApprovalRegistrationAbortsAgent,
// TestCancelSessionRunDoesNotAffectOtherSessionApproval) whose Server-bound
// half lives in session_stop.ts. The blocked-agent integration is asserted at
// the handleApprovalResponse dispatch boundary with agent stubs because the
// test-hygiene guard bars low-level agent construction in adapter tests (the
// blocked RequestApproval behavior itself is covered by the src/agent tests).
import { assert, assertEquals } from "@std/assert";
import type { Agent } from "../../agent/agent.ts";
import { EventToolApprovalRequest } from "../../agent/events.ts";
import { type DurableRun, RunStore } from "../../agentruntime/run_store.ts";
import {
  acquireExecutionAdmission,
  type RuntimeLeaseGuard,
} from "../../session/mod.ts";
import { createSession } from "../../agentruntime/session_lifecycle.ts";
import { closeAll } from "../../db/mod.ts";
import { listSessionRunEvents } from "../../session/mod.ts";
import { registerSessionApproval } from "./approval.ts";
import { Server } from "./server.ts";
import { APISession, SessionPool } from "./session_mgr.ts";
import { getSessionRuntime } from "./session_runtime_snapshot.ts";
import { cancelSessionRun } from "./session_stop.ts";

function tempDir(prefix: string): string {
  return Deno.makeTempDirSync({ prefix });
}

function makeDurableRun(partial: Partial<DurableRun>): DurableRun {
  const now = new Date();
  return {
    id: "",
    sessionId: "",
    intentId: "",
    retryOf: "",
    attempt: 0,
    workDir: "",
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
    ...partial,
  };
}

interface AgentStubCalls {
  approvals: { id: string; approved: boolean }[];
}

function newAgentStub(): { agent: Agent; calls: AgentStubCalls } {
  const calls: AgentStubCalls = { approvals: [] };
  const agent = {
    abort() {},
    handleApprovalResponse(id: string, approved: boolean) {
      calls.approvals.push({ id, approved });
    },
  } as unknown as Agent;
  return { agent, calls };
}

function approvalEvent(
  approvalId: string,
  toolName: string,
  args: Record<string, unknown>,
) {
  return {
    type: EventToolApprovalRequest,
    approvalId,
    approvalTool: toolName,
    approvalArgs: args,
  };
}

interface StopFixture {
  server: Server;
  workDir: string;
  sessionDir: string;
  sess: APISession;
  agent: Agent;
  calls: AgentStubCalls;
  execution: ReturnType<APISession["ensureExecution"]>;
  guard: RuntimeLeaseGuard;
  cleanup: () => void;
}

/**
 * beginDurableApprovalTestRun mirrors Go's helper: admission guard, RunStore,
 * durable BeginDurable with the start event, and the adapter run bookkeeping.
 */
function beginDurableTestRun(
  workDir: string,
  sessionDir: string,
  sessionId: string,
  runId: string,
): StopFixture {
  const server = new Server({ settings: { sessionDir } as never });
  const mgr = createSession({ workDir, sessionDir, id: sessionId });
  const sess = new APISession();
  sess.id = sessionId;
  sess.workDir = workDir;
  sess.manager = mgr;
  server.pool = server.pool ?? new SessionPool(0, 0);
  server.pool.put(sess);

  const guard = acquireExecutionAdmission(sessionDir, sessionId);
  const execution = sess.ensureExecution();
  execution.setRunStore(new RunStore(sessionDir));
  const startedAt = new Date();
  execution.beginDurable(
    undefined,
    makeDurableRun({
      id: runId,
      sessionId,
      workDir,
    }),
    {
      sessionId,
      runId,
      eventType: "started",
      source: "webui",
      status: "",
      model: "test",
      mode: "agent",
      timestamp: startedAt,
    },
  );
  const { agent, calls } = newAgentStub();
  execution.setAgent(agent);
  sess.beginRun(runId);
  assert(sess.attachRunAgent(runId, agent, () => {}));
  return {
    server,
    workDir,
    sessionDir,
    sess,
    agent,
    calls,
    execution,
    guard,
    cleanup() {
      if (execution.active().active) {
        try {
          execution.finishDurable(runId, "cancelled", "test cleanup", {
            sessionId,
            runId,
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
    },
  };
}

Deno.test("cancelSessionRun aborts a pending approval", async () => {
  const workDir = tempDir("opensac-stop-workdir-");
  const sessionDir = tempDir("opensac-stop-sessions-");
  const fx = beginDurableTestRun(
    workDir,
    sessionDir,
    "approval-cancel",
    "run_cancel",
  );
  try {
    const request = registerSessionApproval(
      fx.server,
      fx.sess,
      fx.agent,
      approvalEvent("approval_cancel", "bash", { command: "go test ./..." }),
    );
    assert(request !== null);

    assertEquals(await cancelSessionRun(fx.server, fx.sess.id), null);
    // The clear path dispatches the decision bind (Go's ClearRunWithValue
    // ""-value callback); the blocked agent resolves false because the real
    // requestApproval races its decision against the cancelled run context,
    // which the src/agent tests cover. Here we assert the dispatch happened.
    assertEquals(fx.calls.approvals.length, 1);
    assertEquals(fx.calls.approvals[0].id, "approval_cancel");
    assertEquals(fx.sess.pendingApprovals.size, 0);

    const stored = listSessionRunEvents(sessionDir, fx.sess.id);
    let requested = false;
    let cancelled = false;
    for (const item of stored) {
      if (item.runId !== "run_cancel") continue;
      requested = requested ||
        (item.eventType === "approval_requested" && item.status === "pending");
      cancelled = cancelled ||
        (item.eventType === "approval_resolved" && item.status === "cancelled");
    }
    assert(requested, "approval_requested missing");
    assert(cancelled, "approval_resolved/cancelled missing");
  } finally {
    fx.cleanup();
    closeAll();
  }
});

Deno.test("cancelSessionRun before registration denies the late approval", async () => {
  const workDir = tempDir("opensac-stop-workdir-");
  const sessionDir = tempDir("opensac-stop-sessions-");
  const fx = beginDurableTestRun(
    workDir,
    sessionDir,
    "approval-cancel-before-register",
    "run_before_register",
  );
  try {
    assertEquals(await cancelSessionRun(fx.server, fx.sess.id), null);
    assertEquals(
      fx.calls.approvals.length,
      0,
      "no approval was registered before the stop",
    );

    const request = registerSessionApproval(
      fx.server,
      fx.sess,
      fx.agent,
      approvalEvent("approval_before_register", "bash", {
        command: "go test ./...",
      }),
    );
    assertEquals(request, null, "late approval became pending");

    const { snapshot, err } = getSessionRuntime(fx.server, fx.sess.id);
    assertEquals(err, null);
    assert(snapshot !== null);
    assertEquals(snapshot!.pendingApprovals.length, 0);
    assertEquals(snapshot!.activeRun?.status, "cancelling");

    const stored = listSessionRunEvents(sessionDir, fx.sess.id);
    assertEquals(stored.length, 3);
    assertEquals(stored[0].eventType, "started");
    assertEquals(stored[1].eventType, "approval_requested");
    assertEquals(stored[1].status, "pending");
    assertEquals(stored[2].eventType, "approval_resolved");
    assertEquals(stored[2].status, "cancelled");
    assertEquals(stored[2].runId, "run_before_register");
  } finally {
    fx.cleanup();
    closeAll();
  }
});

Deno.test("cancelSessionRun does not affect another session's approval", async () => {
  const workDir = tempDir("opensac-stop-workdir-");
  const sessionDir = tempDir("opensac-stop-sessions-");
  const fxA = beginDurableTestRun(
    workDir,
    sessionDir,
    "approval-isolation-a",
    "run_a",
  );
  const fxB = beginDurableTestRun(
    workDir,
    sessionDir,
    "approval-isolation-b",
    "run_b",
  );
  try {
    const requestA = registerSessionApproval(
      fxA.server,
      fxA.sess,
      fxA.agent,
      approvalEvent("approval_a", "bash", { command: "approval-isolation-a" }),
    );
    assert(requestA !== null);
    const requestB = registerSessionApproval(
      fxB.server,
      fxB.sess,
      fxB.agent,
      approvalEvent("approval_b", "bash", { command: "approval-isolation-b" }),
    );
    assert(requestB !== null);

    assertEquals(await cancelSessionRun(fxA.server, fxA.sess.id), null);
    assertEquals(fxA.calls.approvals.length, 1);
    assertEquals(fxB.calls.approvals, [], "session B approval was affected");

    const { snapshot } = getSessionRuntime(fxB.server, fxB.sess.id);
    assert(snapshot !== null);
    assertEquals(snapshot!.activeRun?.runId, "run_b");
    assertEquals(snapshot!.pendingApprovals.length, 1);
  } finally {
    fxA.cleanup();
    fxB.cleanup();
    closeAll();
  }
});

Deno.test("cancelSessionRun without an active run is rejected", async () => {
  const sessionDir = tempDir("opensac-stop-sessions-");
  try {
    const server = new Server({ settings: { sessionDir } as never });
    // A session that does not resolve at all surfaces the same rejection the
    // Go compatibility wrapper produces for an unknown execution state.
    const err = await cancelSessionRun(server, "missing-session");
    assert(err !== null);
    assertEquals(
      err.message,
      "session stop rejected: session_execution_state_unavailable",
    );
  } finally {
    closeAll();
  }
});
