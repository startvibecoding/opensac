//
// Deviation: the Go fixture drives transcript writes through the (not yet
// ported) Manager; these tests append entries/turns directly through the shared
// turn helpers and persist sessions/run rows through the DAO. The final
// atomic-admission fixture is preserved with literal IDs and direct row counts.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { closeAll } from "../db/mod.ts";
import { SessionDAO } from "../dao/mod.ts";
import {
  createAssistantMessage,
  createUserMessage,
} from "../provider/types.ts";
import {
  appendTurnEntryTx,
  createExecutionIntentAndSessionRunEvent,
  createSessionRun,
  currentLeafTx,
  endConversationTurn,
  entryMessage,
  ForkNoCompletedTurnError,
  forkSession,
  ForkSessionActiveError,
  generateID,
  type MessageEntry,
  openRootDB,
  saveSessionRunEvent,
  startConversationTurn,
  tryLockRuntime,
  updateSessionRunStatus,
} from "./mod.ts";
import { finishSessionRunAndConversationTurn } from "./run_store.ts";

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

function appendMessage(
  sessionDir: string,
  sessionId: string,
  message: ReturnType<typeof createUserMessage>,
): string {
  const db = openRootDB(sessionDir);
  let id = "";
  db.runInTx((tx) => {
    const parentId = currentLeafTx(tx, sessionId);
    id = generateID();
    const entry: MessageEntry = {
      type: entryMessage,
      id,
      parentId: parentId === "" ? null : parentId,
      timestamp: new Date(),
      message,
    };
    appendTurnEntryTx(tx, sessionId, entry, parentId);
  });
  return id;
}

function messageSeq(
  sessionDir: string,
  sessionId: string,
  entryId: string,
): number {
  const row = openRootDB(sessionDir).db!.get<{ seq: number }>(
    "SELECT seq FROM entries WHERE session_id = ? AND id = ?",
    sessionId,
    entryId,
  );
  if (row === undefined) throw new Error("message entry not found");
  return Number(row.seq);
}

function countMessages(sessionDir: string, sessionId: string): number {
  const row = openRootDB(sessionDir).db!.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM entries WHERE session_id = ? AND type = ?",
    sessionId,
    entryMessage,
  );
  return Number(row?.n ?? 0);
}

function startTurn(
  sessionDir: string,
  sessionId: string,
  turnId: string,
): void {
  startConversationTurn(sessionDir, {
    id: turnId,
    sessionId,
    intentId: "intent-1",
    runId: "run-1",
    attempt: 0,
    kind: "conversation",
    status: "",
    startSeq: 0,
    endSeq: null,
    startedAt: new Date(),
    endedAt: null,
  });
}

Deno.test("fork session and message boundary", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-fork-" });
  try {
    makeSession(sessionDir, "source");
    startTurn(sessionDir, "source", "turn-1");
    appendMessage(sessionDir, "source", createUserMessage("hello"));
    const assistantId = appendMessage(
      sessionDir,
      "source",
      createAssistantMessage([{ type: "text", text: "world" }]),
    );
    endConversationTurn(
      sessionDir,
      "source",
      "turn-1",
      "completed",
      "stop",
      new Date(),
    );

    const rowFork = forkSession(sessionDir, {
      sourceSessionId: "source",
      requestId: "row-key",
      titleMode: "",
    });
    assertEquals(rowFork.forkKind, "session");
    assertEquals(rowFork.parentSessionId, "source");
    assertEquals(countMessages(sessionDir, rowFork.sessionId), 2);

    const seq = messageSeq(sessionDir, "source", assistantId);
    const messageFork = forkSession(sessionDir, {
      sourceSessionId: "source",
      atSeq: seq,
      requestId: "message-key",
      titleMode: "",
    });
    assertEquals(messageFork.forkKind, "message");
    const retried = forkSession(sessionDir, {
      sourceSessionId: "source",
      atSeq: seq,
      requestId: "message-key",
      titleMode: "",
    });
    assertEquals(retried.sessionId, messageFork.sessionId);
    assertEquals(countMessages(sessionDir, messageFork.sessionId), 2);
  } finally {
    closeAll();
  }
});

Deno.test("fork rejects an open turn and independent sessions stay concurrent", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-fork-" });
  try {
    makeSession(sessionDir, "a");
    makeSession(sessionDir, "b");
    startTurn(sessionDir, "a", "open");
    assertThrows(
      () =>
        forkSession(sessionDir, {
          sourceSessionId: "a",
          requestId: "open-key",
          titleMode: "",
        }),
      ForkSessionActiveError,
    );

    const releaseA = tryLockRuntime(sessionDir, "a");
    assert(releaseA !== null, "session a should acquire the runtime lease");
    const releaseA2 = tryLockRuntime(sessionDir, "a");
    assert(releaseA2 === null, "active lease must block runtime acquisition");
    const releaseB = tryLockRuntime(sessionDir, "b");
    assert(releaseB !== null, "session b should acquire independently");
    releaseB();
    releaseA();
  } finally {
    closeAll();
  }
});

Deno.test("fork rejects an orphaned pending decision", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-fork-" });
  try {
    makeSession(sessionDir, "pending-decision");
    saveSessionRunEvent(sessionDir, {
      id: "",
      sessionId: "pending-decision",
      runId: "old-run",
      eventType: "decision_pending",
      source: "",
      status: "pending",
      model: "",
      mode: "",
      timestamp: new Date(),
      data: {
        decision: { id: "approval-1", status: "pending" },
      },
    });
    assertThrows(
      () =>
        forkSession(sessionDir, {
          sourceSessionId: "pending-decision",
          requestId: "pending-key",
          titleMode: "",
        }),
      ForkSessionActiveError,
    );
  } finally {
    closeAll();
  }
});

Deno.test("fork allows an orphaned cancelled decision", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-fork-" });
  try {
    makeSession(sessionDir, "cancelled-decision");
    saveSessionRunEvent(sessionDir, {
      id: "",
      sessionId: "cancelled-decision",
      runId: "old-run",
      eventType: "decision_pending",
      source: "",
      status: "pending",
      model: "",
      mode: "",
      timestamp: new Date(),
      data: { decision: { id: "approval-1", status: "pending" } },
    });
    saveSessionRunEvent(sessionDir, {
      id: "",
      sessionId: "cancelled-decision",
      runId: "old-run",
      eventType: "decision_cancelled",
      source: "",
      status: "cancelled",
      model: "",
      mode: "",
      timestamp: new Date(),
      data: { decision: { id: "approval-1", status: "cancelled" } },
    });
    // The cancelled decision is no longer pending; the fork must not be blocked
    // the way an orphaned pending decision is (it fails later for lack of a
    // completed turn instead).
    let blocked = false;
    try {
      forkSession(sessionDir, {
        sourceSessionId: "cancelled-decision",
        requestId: "cancelled-key",
        titleMode: "",
      });
    } catch (err) {
      blocked = err instanceof ForkSessionActiveError;
      assert(
        err instanceof ForkNoCompletedTurnError || !blocked,
        `unexpected fork error: ${err}`,
      );
    }
    assert(!blocked, "cancelled decision still blocked the fork");
  } finally {
    closeAll();
  }
});

Deno.test("fork uses a legacy completed run boundary", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-fork-" });
  try {
    makeSession(sessionDir, "legacy-fork");
    const started = new Date(Date.now() - 1000);
    createSessionRun(sessionDir, {
      id: "legacy-run",
      sessionId: "legacy-fork",
      intentId: "",
      retryOf: "",
      attempt: 1,
      workDir: "",
      source: "",
      model: "",
      mode: "",
      status: "running",
      startedAt: started,
      updatedAt: started,
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
    });
    appendMessage(
      sessionDir,
      "legacy-fork",
      createUserMessage("legacy question"),
    );
    const assistantId = appendMessage(
      sessionDir,
      "legacy-fork",
      createAssistantMessage([{ type: "text", text: "legacy answer" }]),
    );
    const finished = new Date(Date.now() + 1000);
    updateSessionRunStatus(
      sessionDir,
      "legacy-run",
      "completed",
      "",
      finished,
    );

    const result = forkSession(sessionDir, {
      sourceSessionId: "legacy-fork",
      requestId: "legacy-row",
      titleMode: "",
    });
    assertEquals(result.forkKind, "session");
    assert(result.boundarySeq > 0, "legacy row fork boundary must be positive");

    const seq = messageSeq(sessionDir, "legacy-fork", assistantId);
    const messageResult = forkSession(sessionDir, {
      sourceSessionId: "legacy-fork",
      atSeq: seq,
      requestId: "legacy-message",
      titleMode: "",
    });
    assertEquals(messageResult.forkKind, "message");
  } finally {
    closeAll();
  }
});

Deno.test("execution admission atomically starts a conversation turn", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-fork-" });
  try {
    makeSession(sessionDir, "atomic-turn");
    const release = tryLockRuntime(sessionDir, "atomic-turn");
    assert(release !== null, "acquire runtime lease");
    try {
      const started = new Date();
      createExecutionIntentAndSessionRunEvent(
        sessionDir,
        {
          id: "intent-atomic",
          sessionId: "atomic-turn",
          source: "",
          model: "",
          mode: "",
          workDir: "",
          requestFingerprint: "",
          request: undefined,
          policy: undefined,
          createdAt: started,
        },
        {
          id: "run-atomic",
          sessionId: "atomic-turn",
          intentId: "intent-atomic",
          retryOf: "",
          attempt: 1,
          workDir: "",
          source: "",
          model: "",
          mode: "",
          status: "running",
          startedAt: started,
          updatedAt: started,
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
        },
        {
          id: "event-atomic",
          sessionId: "atomic-turn",
          runId: "run-atomic",
          eventType: "started",
          source: "",
          status: "running",
          model: "",
          mode: "",
          timestamp: started,
          data: undefined,
        },
        {
          id: "turn-atomic",
          sessionId: "atomic-turn",
          intentId: "intent-atomic",
          runId: "run-atomic",
          attempt: 1,
          kind: "conversation",
          status: "",
          startSeq: 0,
          endSeq: null,
          startedAt: started,
          endedAt: null,
        },
      );
      const conn = openRootDB(sessionDir).db!;
      const scalar = (sql: string): number =>
        Number(conn.get<{ n: number }>(sql)?.n ?? 0);
      assertEquals(
        scalar(
          "SELECT COUNT(*) AS n FROM session_runs WHERE id = 'run-atomic'",
        ),
        1,
      );
      assertEquals(
        scalar(
          "SELECT COUNT(*) AS n FROM session_run_events WHERE run_id = 'run-atomic'",
        ),
        1,
      );
      assertEquals(
        scalar(
          "SELECT COUNT(*) AS n FROM conversation_turns WHERE id = 'turn-atomic' AND status = 'open'",
        ),
        1,
      );
      assertEquals(
        scalar(
          "SELECT COUNT(*) AS n FROM entries WHERE session_id = 'atomic-turn' AND type = 'turn_start'",
        ),
        1,
      );

      finishSessionRunAndConversationTurn(
        sessionDir,
        {
          id: "run-atomic",
          sessionId: "atomic-turn",
          intentId: "intent-atomic",
          retryOf: "",
          attempt: 1,
          workDir: "",
          source: "",
          model: "",
          mode: "",
          status: "completed",
          startedAt: started,
          updatedAt: started,
          finishedAt: new Date(),
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
        },
        {
          id: "",
          sessionId: "atomic-turn",
          runId: "run-atomic",
          eventType: "finished",
          source: "",
          status: "completed",
          model: "",
          mode: "",
          timestamp: new Date(),
          data: undefined,
        },
        "turn-atomic",
        "completed",
        "stop",
      );
      assertEquals(
        conn.get<{ status: string }>(
          "SELECT status FROM session_runs WHERE id = 'run-atomic'",
        )?.status,
        "completed",
      );
      assertEquals(
        conn.get<{ status: string }>(
          "SELECT status FROM conversation_turns WHERE id = 'turn-atomic'",
        )?.status,
        "completed",
      );
      assertEquals(
        scalar(
          "SELECT COUNT(*) AS n FROM session_run_events WHERE run_id = 'run-atomic'",
        ),
        2,
      );
      assertEquals(
        scalar(
          "SELECT COUNT(*) AS n FROM entries WHERE session_id = 'atomic-turn' AND type = 'turn_end'",
        ),
        1,
      );
    } finally {
      release();
    }
  } finally {
    closeAll();
  }
});
