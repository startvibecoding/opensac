import { assert, assertEquals } from "@opensac/assert";
import {
  ResponseDAO,
  type ResponseItemRecord,
  type ResponseRunRecord,
  type ResponseSessionStateRecord,
  type ResponseTurnRecord,
  type ToolExecutionRecord,
} from "./mod.ts";
import { closeTestDbs, openTestDb } from "./test_util.ts";

const SESSION = "session-response";

function runRecord(
  overrides: Partial<ResponseRunRecord> = {},
): ResponseRunRecord {
  return {
    id: 7,
    sessionId: SESSION,
    localRunId: "run-1",
    localTurnId: "run-1:turn-1",
    messageId: null,
    responseId: "resp_1",
    provider: "openai",
    api: "openai-responses",
    state: "in_progress",
    pollingUrl: null,
    lastEventSequence: 0,
    cancelRequested: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:10Z",
    ...overrides,
  };
}

function turnRecord(
  overrides: Partial<ResponseTurnRecord> = {},
): ResponseTurnRecord {
  return {
    id: 0,
    sessionId: SESSION,
    localTurnId: "turn-1",
    messageId: null,
    requestId: "req_1",
    responseId: "resp_1",
    previousResponseId: null,
    conversationId: "conv_1",
    provider: "openai",
    api: "openai-responses",
    model: "gpt-4.1",
    stateMode: "replay",
    status: "completed",
    incompleteReason: null,
    requestSummaryJson: null,
    responseSummaryJson: null,
    createdAt: "2026-01-01T00:00:01Z",
    completedAt: "2026-01-01T00:00:05Z",
    ...overrides,
  };
}

function itemRecord(
  overrides: Partial<ResponseItemRecord> = {},
): ResponseItemRecord {
  return {
    id: 0,
    sessionId: SESSION,
    localTurnId: "turn-1",
    responseId: "resp_1",
    itemId: "msg_1",
    outputIndex: 0,
    itemType: "message",
    itemStatus: "completed",
    itemKey: "item-a",
    sanitizedJson: new Uint8Array([1, 2, 3]),
    createdAt: "2026-01-01T00:00:02Z",
    updatedAt: "2026-01-01T00:00:02Z",
    ...overrides,
  };
}

function toolRecord(
  overrides: Partial<ToolExecutionRecord> = {},
): ToolExecutionRecord {
  return {
    id: 0,
    sessionId: SESSION,
    localTurnId: "turn-1",
    executionKey: "exec-1",
    provider: "openai",
    api: "openai-responses",
    responseId: "resp_1",
    providerCallId: "call-1",
    toolKind: "function",
    toolName: "bash",
    argsHash: "hash-1",
    executionState: "running",
    resultSummaryJson: null,
    providerMetadataJson: null,
    sideEffecting: true,
    createdAt: "2026-01-01T00:00:03Z",
    completedAt: null,
    ...overrides,
  };
}

function stateRecord(
  overrides: Partial<ResponseSessionStateRecord> = {},
): ResponseSessionStateRecord {
  return {
    sessionId: SESSION,
    stateMode: "replay",
    previousResponseId: null,
    conversationId: "conv_1",
    provider: "openai",
    api: "openai-responses",
    model: "gpt-4.1",
    version: 1,
    updatedAt: "2026-01-01T00:00:10Z",
    ...overrides,
  };
}

Deno.test("response DAO run insert, upsert, and linked lookup", () => {
  const db = openTestDb();
  try {
    const dao = new ResponseDAO(db);
    dao.insertRun(db, runRecord());
    dao.insertRun(
      db,
      runRecord({
        id: 8,
        localRunId: "run-2",
        localTurnId: "run-2:turn-1",
        createdAt: "2026-01-01T00:01:00Z",
        updatedAt: "2026-01-01T00:01:10Z",
      }),
    );

    const found = dao.findRun(db, 7);
    assert(found, "the explicit primary key must survive the insert");
    assertEquals(found.state, "in_progress");
    assertEquals(dao.getRun(SESSION, "run-1")?.responseId, "resp_1");

    // linkedRun resolves both an exact turn id and an id-prefixed child turn.
    assertEquals(
      dao.linkedRun(db, SESSION, "run-1")?.localRunId,
      "run-1",
      "an exact local turn id resolves",
    );
    assertEquals(
      dao.linkedRun(db, SESSION, "run-2")?.localTurnId,
      "run-2:turn-1",
      "a run id matches its turn-prefixed rows too",
    );
    assertEquals(dao.linkedRun(db, "other-session", "run-1"), undefined);
    assertEquals(dao.linkedRun(db, SESSION, "run-missing"), undefined);

    // upsert reuses the (session, local run) row instead of adding one.
    dao.upsertRun(
      db,
      runRecord({
        id: 0,
        state: "completed",
        updatedAt: "2026-01-01T00:02:00Z",
      }),
    );
    assertEquals(dao.findRun(db, 7)?.state, "completed");
    assertEquals(dao.getRun(SESSION, "run-1")?.state, "completed");

    assertEquals(dao.listRunsForSession(SESSION, 10).length, 2);
    assertEquals(dao.listRunsForSession(SESSION, 1).length, 1);
    assertEquals(dao.listRunsForSession("other-session", 10).length, 0);
  } finally {
    closeTestDbs();
  }
});

Deno.test("response DAO turn upsert, items, and replay ordering", () => {
  const db = openTestDb();
  try {
    const dao = new ResponseDAO(db);
    dao.insertTurn(db, turnRecord());
    dao.insertTurn(
      db,
      turnRecord({
        localTurnId: "turn-2",
        status: "running",
        createdAt: "2026-01-01T00:00:02Z",
      }),
    );
    dao.insertTurn(
      db,
      turnRecord({
        localTurnId: "turn-3",
        status: "incomplete",
        incompleteReason: "aborted",
        createdAt: "2026-01-01T00:00:03Z",
      }),
    );

    // Re-inserting the same (session, turn) upserts instead of failing.
    dao.insertTurn(db, turnRecord({ status: "incomplete" }));
    assertEquals(dao.findTurn(SESSION, "turn-1")?.status, "incomplete");
    assertEquals(dao.findTurn(SESSION, "turn-3")?.incompleteReason, "aborted");
    assertEquals(dao.findTurn(SESSION, "turn-missing"), undefined);

    dao.upsertItem(db, itemRecord());
    dao.upsertItem(
      db,
      itemRecord({
        itemKey: "item-b",
        itemId: "msg_2",
        outputIndex: 1,
        sanitizedJson: new Uint8Array([4, 5]),
      }),
    );
    dao.upsertItem(
      db,
      itemRecord({ itemKey: "item-a", itemStatus: "in_progress" }),
    );
    const items = dao.listItems(SESSION, "turn-1");
    assertEquals(items.length, 2, "the conflicting key must not duplicate");
    assertEquals(items[0].itemKey, "item-a");
    assertEquals(items[0].itemStatus, "in_progress");
    assertEquals(items[1].itemKey, "item-b");

    dao.upsertItem(
      db,
      itemRecord({
        localTurnId: "turn-3",
        itemKey: "item-c",
        outputIndex: 0,
        sanitizedJson: new Uint8Array([7]),
      }),
    );
    assertEquals(dao.listItems(SESSION, "turn-3").length, 1);

    // Replay only reads completed/incomplete turns, oldest turn first.
    const replayTurns = dao.listReplayTurns(SESSION);
    assertEquals(
      replayTurns.map((row) => row.localTurnId),
      ["turn-1", "turn-1", "turn-3"],
      "the running turn must be excluded from replay",
    );
    assertEquals(replayTurns[0].sanitizedJson, new Uint8Array([1, 2, 3]));

    const replayItems = dao.listReplayItems(SESSION, 2);
    assertEquals(replayItems.length, 2, "the limit applies to replay items");
    assertEquals(
      dao.listReplayItems("other-session", 10).length,
      0,
    );
  } finally {
    closeTestDbs();
  }
});

Deno.test("response DAO tool execution claim, update, reclaim, recover", () => {
  const db = openTestDb();
  try {
    const dao = new ResponseDAO(db);

    const first = dao.claimTool(db, toolRecord());
    assert(first, "the first claim creates the record");
    assertEquals(first.created, 1);
    assertEquals(first.stored.executionState, "running");

    const second = dao.claimTool(
      db,
      toolRecord({ toolName: "read", resultSummaryJson: new Uint8Array([9]) }),
    );
    assert(second, "a duplicate claim still resolves the stored row");
    assertEquals(second.created, 0, "the conflict must not insert again");
    assertEquals(second.stored.toolName, "bash", "the original row wins");
    assertEquals(dao.findTool(db, "exec-1")?.resultSummaryJson, null);

    assertEquals(
      dao.updateTool(db, toolRecord({ executionState: "completed" })),
      1,
    );
    assertEquals(dao.findTool(db, "exec-1")?.executionState, "completed");
    assertEquals(
      dao.updateTool(db, toolRecord({ executionState: "completed" })),
      0,
      "only running/retry_requested rows may be updated",
    );

    assertEquals(
      dao.reclaimTool(db, "exec-1", new Uint8Array([1]), "completed"),
      1,
    );
    const reclaimed = dao.findTool(db, "exec-1");
    assertEquals(reclaimed?.executionState, "running");
    assertEquals(reclaimed?.resultSummaryJson, null);

    dao.claimTool(
      db,
      toolRecord({
        executionKey: "exec-2",
        providerCallId: "call-2",
        executionState: "completed",
      }),
    );
    dao.claimTool(
      db,
      toolRecord({ executionKey: "exec-3", executionState: "interrupted" }),
    );
    assertEquals(
      dao.requestToolRecovery(db, SESSION, "turn-1", ["call-1", "call-3"]),
      2,
      "running and interrupted rows both become retry_requested",
    );
    const requested = dao.listRequestedToolRecoveries(
      db,
      SESSION,
      "turn-1",
      ["call-1", "call-3"],
    );
    assertEquals(
      requested.map((row) => row.executionKey),
      ["exec-1", "exec-3"],
    );

    assertEquals(
      dao.abandonTools(
        db,
        SESSION,
        "turn-1",
        new Uint8Array([2]),
        "2026-01-01T00:09:00Z",
      ),
      0,
      "retry_requested rows are not abandoned",
    );

    dao.claimTool(
      db,
      toolRecord({ executionKey: "exec-4", executionState: "interrupted" }),
    );
    assertEquals(
      dao.abandonTools(
        db,
        SESSION,
        "turn-1",
        new Uint8Array([2]),
        "2026-01-01T00:09:00Z",
      ),
      1,
    );
    const abandoned = dao.findTool(db, "exec-4");
    assertEquals(abandoned?.executionState, "abandoned");
    assertEquals(
      abandoned?.completedAt,
      "2026-01-01T00:09:00Z",
    );

    assertEquals(dao.findTool(db, "missing"), undefined);
  } finally {
    closeTestDbs();
  }
});

Deno.test("response DAO session state insert wins and CAS bumps version", () => {
  const db = openTestDb();
  try {
    const dao = new ResponseDAO(db);
    assertEquals(dao.insertSessionState(db, stateRecord()), 1);
    assertEquals(
      dao.insertSessionState(db, stateRecord({ model: "gpt-4o" })),
      0,
      "the first insert owns the row",
    );
    assertEquals(dao.getSessionState(SESSION)?.model, "gpt-4.1");
    assertEquals(dao.getSessionState(SESSION)?.version, 1);

    assertEquals(
      dao.updateSessionStateCAS(db, stateRecord({ model: "gpt-4o" }), 1),
      1,
    );
    assertEquals(dao.getSessionState(SESSION)?.model, "gpt-4o");
    assertEquals(dao.getSessionState(SESSION)?.version, 2);

    assertEquals(
      dao.updateSessionStateCAS(db, stateRecord(), 1),
      0,
      "a stale expected version must not win",
    );
    assertEquals(dao.getSessionState(SESSION)?.version, 2);
    assertEquals(dao.getSessionState("other-session"), undefined);
  } finally {
    closeTestDbs();
  }
});

Deno.test("response DAO requires an open database", () => {
  const dao = new ResponseDAO(null);
  let threw = false;
  try {
    dao.getSessionState(SESSION);
  } catch (error) {
    threw = true;
    assertEquals(
      error instanceof Error ? error.message : "",
      "response database is not open",
    );
  }
  assert(threw, "a null database must throw instead of returning undefined");
});
