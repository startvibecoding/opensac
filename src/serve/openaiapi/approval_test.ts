// Translated from internal/serve/openaiapi/approval_test.go — the cases whose
// Server-bound halves exist today (resolution, clearing, rule rollback, and
// durable recovery). The CancelSessionRun cases, the runtime-snapshot cases
// (GetSessionRuntime), and the WebSocket runtime projection stay with their
// slices. The question lifecycle coverage mirrors the Go registration path
// exercised by TestSessionQuestionRuntimeLifecycle without its recovery half.
import { assert, assertEquals } from "@std/assert";
import type { Agent } from "../../agent/agent.ts";
import {
  type Event,
  EventQuestionRequest,
  EventToolApprovalRequest,
} from "../../agent/events.ts";
import { type AllowConfig, matchBashCommand } from "../../config/allow.ts";
import type { Settings } from "../../config/settings.ts";
import {
  DecisionApproval,
  DecisionQuestion,
  type DecisionRequest,
  DecisionService,
} from "../../agentruntime/decision.ts";
import { closeAll } from "../../db/mod.ts";
import { listSessionRunEvents } from "../../session/session_events.ts";
import {
  approvalCommand,
  approvalPath,
  approvalToolLabel,
  clearSessionApprovals,
  clearSessionApprovalsForRun,
  matchesRecoveredApproval,
  recordSessionApprovalResolution,
  recoveredApprovalDecision,
  registerSessionApproval,
  registerSessionQuestion,
  resolveSessionApproval,
  resolveSessionQuestion,
  suggestedApprovalCommandPrefix,
} from "./approval.ts";
import { Server } from "./server.ts";
import { APISession, SessionPool } from "./session_mgr.ts";

function tempDir(): string {
  return Deno.makeTempDirSync({ prefix: "mothx-openaiapi-approval-" });
}

function settingsFor(dir: string): Settings {
  return { sessionDir: dir } as unknown as Settings;
}

function newApprovalTestServer(dir: string): Server {
  return new Server({ settings: settingsFor(dir) });
}

function pooledSession(
  server: Server,
  id: string,
  workDir: string,
): APISession {
  const sess = new APISession();
  sess.id = id;
  sess.workDir = workDir;
  server.pool = server.pool ?? new SessionPool(0, 0);
  server.pool.put(sess);
  return sess;
}

/**
 * The Server contract toward the agent is the handleApprovalResponse /
 * handleQuestionResponse dispatch, so the fixtures observe that boundary
 * through a stub instead of constructing a low-level Agent (the architecture
 * guard requires the canonical runtime construction paths for real agents).
 */
interface AgentStubCalls {
  approvals: { id: string; approved: boolean }[];
  questions: { id: string; answer: string }[];
}

function newAgentStub(): { agent: Agent; calls: AgentStubCalls } {
  const calls: AgentStubCalls = { approvals: [], questions: [] };
  const agent = {
    handleApprovalResponse(id: string, approved: boolean) {
      calls.approvals.push({ id, approved });
    },
    handleQuestionResponse(id: string, answer: string) {
      calls.questions.push({ id, answer });
    },
  } as unknown as Agent;
  return { agent, calls };
}

function approvalEvent(
  approvalId: string,
  toolName: string,
  args: Record<string, unknown>,
): Event {
  return {
    type: EventToolApprovalRequest,
    approvalId,
    approvalTool: toolName,
    approvalArgs: args,
  };
}

function questionEvent(questionId: string): Event {
  return {
    type: EventQuestionRequest,
    questionId,
    questionText: "continue?",
    questionOptions: ["yes", "no"],
    questionContext: "context",
  };
}

Deno.test("approval helpers mirror the Go command/path/label projections", () => {
  assertEquals(
    suggestedApprovalCommandPrefix("  deno\ttest  ./..."),
    "deno test ",
  );
  assertEquals(suggestedApprovalCommandPrefix("ls"), "ls");
  assertEquals(suggestedApprovalCommandPrefix("   "), "");
  assertEquals(approvalToolLabel("read_file"), "Read File");
  assertEquals(approvalToolLabel("bash"), "Bash");
  assertEquals(approvalCommand({ command: " go vet ./... " }), "go vet ./...");
  assertEquals(approvalCommand({ cmd: "make build" }), "make build");
  assertEquals(approvalCommand({}), "");
  assertEquals(approvalPath({ path: " /a/b " }), "/a/b");
  assertEquals(approvalPath({}), "");
});

Deno.test("clearSessionApprovalsForRun drops cleared pending questions", () => {
  const dir = tempDir();
  try {
    const server = newApprovalTestServer(dir);
    const sess = pooledSession(server, "question-clear", dir);
    sess.beginRun("run-question-clear");
    sess.pendingQuestions.set("question-1", {
      request: {
        questionId: "question-1",
        sessionId: sess.id,
        runId: "run-question-clear",
        question: "continue?",
      },
    });
    clearSessionApprovalsForRun(
      server,
      sess,
      "run-question-clear",
      "cancelled",
      "run ended",
    );
    assertEquals(sess.pendingQuestions.size, 0);
  } finally {
    closeAll();
  }
});

Deno.test("resolveSessionApproval first response wins", () => {
  const dir = tempDir();
  try {
    const server = newApprovalTestServer(dir);
    const sess = pooledSession(server, "approval-race", dir);
    sess.beginRun("run_race");
    sess.pendingApprovals.set("approval_1", {
      request: {
        approvalId: "approval_1",
        sessionId: sess.id,
        runId: "run_race",
        mode: "agent",
      },
    });

    const first = resolveSessionApproval(server, sess.id, "approval_1", {
      action: "approve_once",
    });
    assertEquals(first.err, null);
    assertEquals(first.resolution?.action, "approve_once");
    // Go races two responses and expects exactly one success; the
    // single-threaded port proves the same by replaying the loser.
    const second = resolveSessionApproval(server, sess.id, "approval_1", {
      action: "deny_once",
    });
    assert(second.err !== null);
    assert(second.err.message.includes("no longer pending"));
  } finally {
    closeAll();
  }
});

Deno.test("resolveSessionApproval rolls back the allow rule when saving fails", () => {
  const dir = tempDir();
  try {
    const server = newApprovalTestServer(dir);
    const allow: AllowConfig = {};
    server.allow = allow;
    server.saveProjectAllow = () => {
      throw new Error("disk full");
    };
    const sess = pooledSession(server, "approval-rollback", dir);
    const request = {
      approvalId: "approval_1",
      sessionId: sess.id,
      runId: "run_rollback",
      tool: { args: { command: "go test ./..." } },
    };
    sess.beginRun(request.runId);
    sess.pendingApprovals.set("approval_1", { request });

    const result = resolveSessionApproval(server, sess.id, "approval_1", {
      action: "remember_command",
    });
    assert(result.err !== null);
    assert(result.err.message.includes("save project allow rule"));
    assertEquals(matchBashCommand(allow, "go test ./..."), false);
    assert(sess.pendingApprovals.has("approval_1"));
  } finally {
    closeAll();
  }
});

Deno.test("clearSessionApprovals resolves and removes pending approvals", () => {
  const dir = tempDir();
  try {
    const server = newApprovalTestServer(dir);
    const sess = pooledSession(server, "approval-cleanup", dir);
    sess.beginRun("run_cleanup");
    sess.decisions = new DecisionService();
    sess.decisions.register({
      id: "approval_1",
      runId: "run_cleanup",
      sessionId: sess.id,
      kind: DecisionApproval,
    });
    sess.pendingApprovals.set("approval_1", {
      request: {
        approvalId: "approval_1",
        sessionId: sess.id,
        runId: "run_cleanup",
      },
    });

    clearSessionApprovals(server, sess, "cancelled", "run cancelled");
    assertEquals(sess.pendingApprovals.size, 0);
    assertEquals(sess.decisions.pending().length, 0);
  } finally {
    closeAll();
  }
});

Deno.test("recoveredApprovalDecision reuses only the matching durable resolution", () => {
  const dir = tempDir();
  try {
    const server = newApprovalTestServer(dir);
    const sess = pooledSession(server, "approval-recovery", dir);
    const request = {
      approvalId: "approval-old",
      toolCallId: "call-1",
      sessionId: sess.id,
      runId: "run-recovery",
      tool: { name: "bash", args: { command: "echo recovered" } },
    };
    const err = recordSessionApprovalResolution(server, sess, request, {
      approvalId: request.approvalId,
      sessionId: sess.id,
      action: "approve_once",
      status: "resolved",
    });
    assertEquals(err, null);

    const hit = recoveredApprovalDecision(
      server,
      sess.id,
      "run-recovery",
      "call-1",
      "bash",
      { command: "echo recovered" },
    );
    assertEquals(hit, { approved: true, found: true });

    assertEquals(
      recoveredApprovalDecision(
        server,
        sess.id,
        "run-recovery",
        "call-2",
        "bash",
        { command: "echo recovered" },
      ).found,
      false,
      "different tool call must not reuse a decision",
    );
    assertEquals(
      recoveredApprovalDecision(
        server,
        sess.id,
        "run-recovery",
        "call-1",
        "bash",
        { command: "echo changed" },
      ).found,
      false,
      "different arguments must not reuse a decision",
    );
  } finally {
    closeAll();
  }
});

Deno.test("matchesRecoveredApproval compares tool identity and canonical args", () => {
  const request = {
    approvalId: "approval-old",
    toolCallId: "call-1",
    sessionId: "s",
    runId: "run",
    tool: { name: "bash", args: { command: "echo hi", extra: ["a", "b"] } },
  };
  // Go marshals the live args with sorted map keys; the recovered JSON uses
  // the same canonical form.
  const argsJSON = '{"command":"echo hi","extra":["a","b"]}';
  assertEquals(
    matchesRecoveredApproval(request, "call-1", "bash", argsJSON),
    true,
  );
  assertEquals(
    matchesRecoveredApproval(request, "call-2", "bash", argsJSON),
    false,
  );
  assertEquals(
    matchesRecoveredApproval(request, "call-1", "read", argsJSON),
    false,
  );
  assertEquals(
    matchesRecoveredApproval(request, "call-1", "bash", "{}"),
    false,
  );
  // A request without stored args only matches an empty argument set.
  assertEquals(
    matchesRecoveredApproval(
      { approvalId: "a", sessionId: "s", runId: "r", tool: { name: "bash" } },
      "call-1",
      "bash",
      "{}",
    ),
    true,
  );
});

Deno.test("registerSessionApproval exposes and resolves a live pending approval", () => {
  const dir = tempDir();
  const server = newApprovalTestServer(dir);
  const pool = new SessionPool(0, 0);
  server.pool = pool;
  try {
    const sess = pooledSession(server, "approval-resume", dir);
    const { agent, calls } = newAgentStub();
    const event = approvalEvent("approval-live", "bash", {
      command: "go test ./...",
    });

    sess.beginRun("run_resume");
    assert(sess.attachRunAgent("run_resume", agent, () => {}));
    const request = registerSessionApproval(server, sess, agent, event);
    assert(request !== null);
    assertEquals(request.approvalId, "approval-live");
    assertEquals(request.summary, "Run bash: go test ./...");
    assertEquals(request.risk, "high");
    assertEquals(request.tool?.["name"], "bash");
    assert(sess.pendingApprovals.has(request.approvalId));
    const pending = sess.decisions?.pending() ?? [];
    assertEquals(pending.length, 1);
    assertEquals(pending[0].kind, DecisionApproval);

    let persisted = listSessionRunEvents(dir, "approval-resume");
    assert(
      persisted.some((e) =>
        e.eventType === "approval_requested" && e.status === "pending"
      ),
    );

    const { resolution, err } = resolveSessionApproval(
      server,
      sess.id,
      request.approvalId,
      { action: "approve_once" },
    );
    assertEquals(err, null);
    assertEquals(resolution?.status, "resolved");
    assertEquals(resolution?.message, "approval accepted");
    // The decision service resumed the blocked agent through its bind
    // callback with the approved verdict.
    assertEquals(calls.approvals, [{ id: "approval-live", approved: true }]);
    assertEquals(sess.pendingApprovals.size, 0);
    persisted = listSessionRunEvents(dir, "approval-resume");
    assert(
      persisted.some((e) =>
        e.eventType === "approval_resolved" && e.status === "resolved"
      ),
    );
  } finally {
    pool.stop();
    closeAll();
  }
});

Deno.test("registerSessionApproval denies and records a late approval after the run ends", () => {
  const dir = tempDir();
  const server = newApprovalTestServer(dir);
  const pool = new SessionPool(0, 0);
  server.pool = pool;
  try {
    const sess = pooledSession(server, "approval-late", dir);
    const { agent, calls } = newAgentStub();
    const event = approvalEvent("approval-late", "bash", {
      command: "go test ./...",
    });

    sess.beginRun("run_late");
    sess.markRunTerminalizing("run_late");
    const request = registerSessionApproval(server, sess, agent, event);
    assertEquals(request, null);
    assertEquals(sess.pendingApprovals.size, 0);

    const persisted = listSessionRunEvents(dir, "approval-late");
    assert(
      persisted.some((e) =>
        e.eventType === "approval_requested" && e.status === "pending"
      ),
    );
    assert(
      persisted.some((e) =>
        e.eventType === "approval_resolved" && e.status === "cancelled"
      ),
    );
    // The blocked agent is unblocked with a denial.
    assertEquals(calls.approvals, [{ id: "approval-late", approved: false }]);
  } finally {
    pool.stop();
    closeAll();
  }
});

Deno.test("registerSessionQuestion registers, persists, and resolves a pending question", () => {
  const dir = tempDir();
  const server = newApprovalTestServer(dir);
  const pool = new SessionPool(0, 0);
  server.pool = pool;
  try {
    const sess = pooledSession(server, "question-live", dir);
    const { agent, calls } = newAgentStub();
    const event = questionEvent("question-live");

    sess.beginRun("run_question");
    const request = registerSessionQuestion(
      server,
      sess,
      agent,
      "run_question",
      event,
    );
    assert(request !== null);
    assertEquals(request.questionId, "question-live");
    assertEquals(request.question, "continue?");
    assertEquals(request.options, ["yes", "no"]);
    assert(sess.pendingQuestions.has(request.questionId));
    const pending: DecisionRequest[] = sess.decisions?.pending() ?? [];
    assertEquals(pending.length, 1);
    assertEquals(pending[0].kind, DecisionQuestion);

    let persisted = listSessionRunEvents(dir, "question-live");
    assert(
      persisted.some((e) =>
        e.eventType === "question_requested" && e.status === "pending"
      ),
    );

    const { resolution, err } = resolveSessionQuestion(
      server,
      sess.id,
      request.questionId,
      { answer: "yes" },
    );
    assertEquals(err, null);
    assertEquals(resolution?.status, "resolved");
    assertEquals(resolution?.answer, "yes");
    // The decision service resumed the blocked agent through its bind
    // callback with the delivered answer.
    assertEquals(calls.questions, [{ id: "question-live", answer: "yes" }]);
    assertEquals(sess.pendingQuestions.size, 0);
    persisted = listSessionRunEvents(dir, "question-live");
    assert(
      persisted.some((e) =>
        e.eventType === "question_resolved" && e.status === "resolved"
      ),
    );
  } finally {
    pool.stop();
    closeAll();
  }
});
