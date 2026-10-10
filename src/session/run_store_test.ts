//
// Deviation: the Go fixture creates a session through the Manager and
// acquires a runtime lease with `TryLockRuntime`. Foreign-key
// enforcement is off and a session with no lease row skips lease validation, so
// these tests use a literal session ID and reproduce the run lifecycle directly.

import { assert, assertEquals } from "../compat/assert.ts";
import { closeAll } from "../db/mod.ts";
import { createAssistantMessage } from "../provider/types.ts";
import {
  annotateSessionRunError,
  createSessionRun,
  createSessionRunAndEvent,
  getSessionRun,
  listSessionRuns,
  nextSessionRunAttempt,
  runAssistantEntryID,
  runTerminalEventID,
  type SessionRun,
  updateSessionRunStatus,
} from "./mod.ts";
import { finishSessionRunAndConversationTurn } from "./run_store.ts";
import { endConversationTurn } from "./conversation_turn.ts";
import { openRootDB } from "./root_db.ts";
import { type DeliveryPlan } from "./delivery_store.ts";
import { test } from "#testing";

function baseRun(overrides: Partial<SessionRun>): SessionRun {
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
    status: "",
    startedAt: new Date(),
    updatedAt: new Date(),
    finishedAt: null,
    error: "",
    errorInfo: undefined,
    progress: undefined,
    usage: undefined,
    contextUsage: undefined,
    inputResourceIds: [],
    submissionKeyHash: "",
    submissionScope: "",
    submissionFingerprint: "",
    userEntryId: "",
    assistantEntryId: "",
    ...overrides,
  };
}

function count(sessionDir: string, sql: string, params: string[] = []): number {
  const row = openRootDB(sessionDir).db!.get<{ n: number }>(sql, ...params);
  return Number(row?.n ?? 0);
}

function statusOf(sessionDir: string, sql: string, params: string[]): string {
  const row = openRootDB(sessionDir).db!.get<{ status: string }>(
    sql,
    ...params,
  );
  return row?.status ?? "";
}

test("create session run rejects duplicate and status rollback", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-session-" });
  try {
    const started = new Date();
    const run = baseRun({
      id: "run-1",
      sessionId: "session-run-store",
      status: "running",
      startedAt: started,
    });
    createSessionRun(sessionDir, run);
    let duplicateThrew = false;
    try {
      createSessionRun(sessionDir, run);
    } catch {
      duplicateThrew = true;
    }
    assert(duplicateThrew, "duplicate CreateSessionRun should fail");

    updateSessionRunStatus(sessionDir, run.id, "completed", "", started);
    let rollbackThrew = false;
    try {
      updateSessionRunStatus(sessionDir, run.id, "running", "", null);
    } catch {
      rollbackThrew = true;
    }
    assert(rollbackThrew, "terminal-to-running transition should fail");
    updateSessionRunStatus(sessionDir, run.id, "completed", "", started);

    assertEquals(getSessionRun(sessionDir, "missing"), null);
  } finally {
    closeAll();
  }
});

test("update session run status allows waiting resume and cancellation", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-session-" });
  try {
    createSessionRun(
      sessionDir,
      baseRun({
        id: "run-1",
        sessionId: "session-run-state",
        status: "queued",
      }),
    );
    for (
      const status of [
        "running",
        "waiting_for_approval",
        "running",
        "cancelling",
        "cancelled",
      ]
    ) {
      updateSessionRunStatus(sessionDir, "run-1", status, "", null);
    }
    assertEquals(
      statusOf(
        sessionDir,
        "SELECT status FROM session_runs WHERE id = ?",
        ["run-1"],
      ),
      "cancelled",
    );
  } finally {
    closeAll();
  }
});

test("next session run attempt uses highest existing attempt", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-session-" });
  try {
    const started = new Date();
    for (
      const run of [
        baseRun({
          id: "run-a",
          sessionId: "session-run-attempts",
          intentId: "intent-a",
          attempt: 1,
          status: "failed",
          startedAt: started,
          updatedAt: started,
          finishedAt: started,
        }),
        baseRun({
          id: "run-b",
          sessionId: "session-run-attempts",
          intentId: "intent-a",
          retryOf: "run-a",
          attempt: 2,
          status: "failed",
          startedAt: started,
          updatedAt: started,
          finishedAt: started,
        }),
      ]
    ) {
      createSessionRun(sessionDir, run);
    }
    assertEquals(
      nextSessionRunAttempt(sessionDir, "session-run-attempts", "intent-a"),
      3,
    );
  } finally {
    closeAll();
  }
});

test("finish session run and conversation turn commits assistant idempotently", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-session-" });
  try {
    const started = new Date();
    createSessionRunAndEvent(
      sessionDir,
      baseRun({
        id: "run-assistant",
        sessionId: "assistant-terminal",
        intentId: "intent-assistant",
        status: "running",
        startedAt: started,
      }),
      {
        id: "run-start-assistant",
        sessionId: "assistant-terminal",
        runId: "run-assistant",
        eventType: "started",
        source: "",
        status: "running",
        model: "",
        mode: "",
        timestamp: started,
      },
      {
        id: "turn-assistant",
        sessionId: "assistant-terminal",
        intentId: "intent-assistant",
        runId: "run-assistant",
        attempt: 0,
        kind: "",
        status: "",
        startSeq: 0,
        endSeq: null,
        startedAt: started,
        endedAt: null,
      },
    );
    const assistant = createAssistantMessage([{
      type: "text",
      text: "answer",
    }]);
    const planTime = new Date(started.getTime() + 1500);
    const plan: DeliveryPlan = {
      intent: {
        id: "intent-delivery-assistant",
        sessionId: "assistant-terminal",
        runId: "run-assistant",
        platform: "wechat",
        targetId: "chat",
        replyMessageId: "",
        transportContext: undefined,
        status: "pending",
        createdAt: planTime,
        updatedAt: planTime,
      },
      operations: [{
        id: "op-delivery-assistant",
        intentId: "",
        operationKey: "caption",
        artifactId: "",
        operationKind: "send_text",
        sequence: 1,
        dependsOn: "",
        idempotencyKey: "op-delivery-assistant",
        payloadDigest: "sha256:caption",
        status: "pending",
        providerAssetId: "",
        providerMessageId: "",
        providerState: undefined,
        attemptCount: 0,
        nextAttemptAt: null,
        failureCode: "",
        retryWindowStartedAt: null,
        leaseOwner: "",
        leaseEpoch: 0,
        createdAt: planTime,
        updatedAt: planTime,
      }],
    };
    const finished = new Date(started.getTime() + 2000);
    const terminalRun = baseRun({
      id: "run-assistant",
      sessionId: "assistant-terminal",
      status: "completed",
      finishedAt: finished,
      assistantEntryId: runAssistantEntryID("run-assistant"),
      assistantMessage: assistant,
      deliveryPlan: plan,
    });
    const terminalEvent = {
      id: "",
      sessionId: "assistant-terminal",
      runId: "run-assistant",
      eventType: "finished",
      source: "",
      status: "completed",
      model: "",
      mode: "",
      timestamp: finished,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      finishSessionRunAndConversationTurn(
        sessionDir,
        terminalRun,
        terminalEvent,
        "turn-assistant",
        "completed",
        "stop",
      );
    }
    const assistantCount = count(
      sessionDir,
      `SELECT COUNT(*) AS n FROM entries WHERE session_id = ? AND id = ? AND type = 'message'`,
      ["assistant-terminal", runAssistantEntryID("run-assistant")],
    );
    const terminalEventCount = count(
      sessionDir,
      `SELECT COUNT(*) AS n FROM session_run_events WHERE run_id = ? AND id = ?`,
      ["run-assistant", runTerminalEventID("run-assistant", "finished")],
    );
    const turnEndCount = count(
      sessionDir,
      `SELECT COUNT(*) AS n FROM entries WHERE session_id = ? AND type = 'turn_end'`,
      ["assistant-terminal"],
    );
    const intentCount = count(
      sessionDir,
      `SELECT COUNT(*) AS n FROM delivery_intents WHERE id = ?`,
      ["intent-delivery-assistant"],
    );
    const operationCount = count(
      sessionDir,
      `SELECT COUNT(*) AS n FROM delivery_operations WHERE id = ?`,
      ["op-delivery-assistant"],
    );
    assertEquals(assistantCount, 1);
    assertEquals(terminalEventCount, 1);
    assertEquals(turnEndCount, 1);
    assertEquals(intentCount, 1);
    assertEquals(operationCount, 1);

    const conflicting = { ...assistant, content: "different terminal result" };
    const conflictRun = { ...terminalRun, assistantMessage: conflicting };
    let conflictThrew = false;
    try {
      finishSessionRunAndConversationTurn(
        sessionDir,
        conflictRun,
        terminalEvent,
        "turn-assistant",
        "completed",
        "stop",
      );
    } catch {
      conflictThrew = true;
    }
    assert(conflictThrew, "conflicting assistant message should fail");
  } finally {
    closeAll();
  }
});

test("finish session run commits when turn already closed", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-session-" });
  try {
    const started = new Date();
    createSessionRunAndEvent(
      sessionDir,
      baseRun({
        id: "run-closed-turn",
        sessionId: "assistant-closed-turn",
        intentId: "intent-closed-turn",
        status: "running",
        startedAt: started,
      }),
      {
        id: "run-start-closed-turn",
        sessionId: "assistant-closed-turn",
        runId: "run-closed-turn",
        eventType: "started",
        source: "",
        status: "running",
        model: "",
        mode: "",
        timestamp: started,
      },
      {
        id: "turn-closed-turn",
        sessionId: "assistant-closed-turn",
        intentId: "intent-closed-turn",
        runId: "run-closed-turn",
        attempt: 0,
        kind: "",
        status: "",
        startSeq: 0,
        endSeq: null,
        startedAt: started,
        endedAt: null,
      },
    );
    endConversationTurn(
      sessionDir,
      "assistant-closed-turn",
      "turn-closed-turn",
      "completed",
      "stop",
      new Date(started.getTime() + 1000),
    );
    const assistant = createAssistantMessage([
      { type: "text", text: "answer after closed turn" },
    ]);
    const finished = new Date(started.getTime() + 2000);
    finishSessionRunAndConversationTurn(
      sessionDir,
      baseRun({
        id: "run-closed-turn",
        sessionId: "assistant-closed-turn",
        status: "completed",
        finishedAt: finished,
        assistantEntryId: runAssistantEntryID("run-closed-turn"),
        assistantMessage: assistant,
      }),
      {
        id: "",
        sessionId: "",
        runId: "",
        eventType: "finished",
        source: "",
        status: "completed",
        model: "",
        mode: "",
        timestamp: finished,
      },
      "turn-closed-turn",
      "completed",
      "stop",
    );
    assertEquals(
      statusOf(sessionDir, "SELECT status FROM session_runs WHERE id = ?", [
        "run-closed-turn",
      ]),
      "completed",
    );
    assertEquals(
      count(
        sessionDir,
        `SELECT COUNT(*) AS n FROM entries WHERE id = ?`,
        [runAssistantEntryID("run-closed-turn")],
      ),
      1,
    );
    assertEquals(
      count(
        sessionDir,
        `SELECT COUNT(*) AS n FROM session_run_events WHERE id = ?`,
        [runTerminalEventID("run-closed-turn", "finished")],
      ),
      1,
    );
  } finally {
    closeAll();
  }
});

test("finish session run rolls back invalid delivery plan", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-session-" });
  try {
    const started = new Date();
    createSessionRunAndEvent(
      sessionDir,
      baseRun({
        id: "run-rollback",
        sessionId: "assistant-rollback",
        intentId: "intent-rollback",
        status: "running",
        startedAt: started,
      }),
      {
        id: "run-start-rollback",
        sessionId: "assistant-rollback",
        runId: "run-rollback",
        eventType: "started",
        source: "",
        status: "running",
        model: "",
        mode: "",
        timestamp: started,
      },
      {
        id: "turn-rollback",
        sessionId: "assistant-rollback",
        intentId: "intent-rollback",
        runId: "run-rollback",
        attempt: 0,
        kind: "",
        status: "",
        startSeq: 0,
        endSeq: null,
        startedAt: started,
        endedAt: null,
      },
    );
    const assistant = createAssistantMessage([
      { type: "text", text: "must not commit" },
    ]);
    const plan: DeliveryPlan = {
      intent: {
        id: "intent-rollback-delivery",
        sessionId: "assistant-rollback",
        runId: "run-rollback",
        platform: "wechat",
        targetId: "chat",
        replyMessageId: "",
        transportContext: undefined,
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      operations: [{
        id: "op-rollback",
        intentId: "",
        operationKey: "caption",
        artifactId: "missing-artifact",
        operationKind: "send_text",
        sequence: 1,
        dependsOn: "",
        idempotencyKey: "op-rollback",
        payloadDigest: "sha256:rollback",
        status: "pending",
        providerAssetId: "",
        providerMessageId: "",
        providerState: undefined,
        attemptCount: 0,
        nextAttemptAt: null,
        failureCode: "",
        retryWindowStartedAt: null,
        leaseOwner: "",
        leaseEpoch: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
    };
    let threw = false;
    try {
      finishSessionRunAndConversationTurn(
        sessionDir,
        baseRun({
          id: "run-rollback",
          sessionId: "assistant-rollback",
          status: "completed",
          assistantEntryId: runAssistantEntryID("run-rollback"),
          assistantMessage: assistant,
          deliveryPlan: plan,
        }),
        {
          id: "",
          sessionId: "",
          runId: "",
          eventType: "finished",
          source: "",
          status: "completed",
          model: "",
          mode: "",
          timestamp: new Date(started.getTime() + 1000),
        },
        "turn-rollback",
        "completed",
        "stop",
      );
    } catch {
      threw = true;
    }
    assert(threw, "invalid delivery plan should roll back");
    assertEquals(
      statusOf(sessionDir, "SELECT status FROM session_runs WHERE id = ?", [
        "run-rollback",
      ]),
      "running",
    );
    assertEquals(
      statusOf(
        sessionDir,
        "SELECT status FROM conversation_turns WHERE id = ?",
        [
          "turn-rollback",
        ],
      ),
      "open",
    );
    assertEquals(
      count(sessionDir, `SELECT COUNT(*) AS n FROM entries WHERE id = ?`, [
        runAssistantEntryID("run-rollback"),
      ]),
      0,
    );
    assertEquals(
      count(
        sessionDir,
        `SELECT COUNT(*) AS n FROM session_run_events WHERE id = ?`,
        [runTerminalEventID("run-rollback", "finished")],
      ),
      0,
    );
    assertEquals(
      count(
        sessionDir,
        `SELECT COUNT(*) AS n FROM delivery_intents WHERE id = ?`,
        [
          "intent-rollback-delivery",
        ],
      ),
      0,
    );
  } finally {
    closeAll();
  }
});

test("list session runs does not deadlock pool", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-session-" });
  try {
    const sessionId = "session-list-runs-pool";
    createSessionRun(
      sessionDir,
      baseRun({
        id: "run-pool-1",
        sessionId,
        status: "running",
      }),
    );
    openRootDB(sessionDir).db!.run(
      `INSERT INTO input_resources
        (id, session_id, run_id, kind, relative_path, status, created_at)
        VALUES (?, ?, ?, 'text', 'msg.txt', 'attached', ?)`,
      "res-pool-1",
      sessionId,
      "run-pool-1",
      new Date().toISOString(),
    );
    const runs = listSessionRuns(sessionDir, sessionId, 100);
    assertEquals(runs.length, 1);
    assertEquals(runs[0].inputResourceIds, ["res-pool-1"]);
  } finally {
    closeAll();
  }
});

test("annotate session run error only fills empty error", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-session-" });
  try {
    const now = new Date();
    createSessionRun(
      sessionDir,
      baseRun({
        id: "run-annotate",
        sessionId: "run-error-annotation",
        status: "running",
        startedAt: now,
      }),
    );
    updateSessionRunStatus(sessionDir, "run-annotate", "failed", "", now);

    assert(
      annotateSessionRunError(
        sessionDir,
        "run-annotate",
        "abandoned after interrupted tool execution",
      ),
    );
    let run = getSessionRun(sessionDir, "run-annotate")!;
    assertEquals(run.status, "failed");
    assertEquals(run.error, "abandoned after interrupted tool execution");

    assert(
      !annotateSessionRunError(sessionDir, "run-annotate", "later reason"),
    );
    run = getSessionRun(sessionDir, "run-annotate")!;
    assertEquals(run.error, "abandoned after interrupted tool execution");

    assert(!annotateSessionRunError(sessionDir, "missing-run", "reason"));
    assert(!annotateSessionRunError(sessionDir, "run-annotate", "   "));
  } finally {
    closeAll();
  }
});
