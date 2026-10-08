//
// Deviation: the Go fixture creates a session through the Manager and
// acquires a runtime lease with `TryLockRuntime`. Foreign-key
// enforcement is off and a session with no lease row skips lease validation, so
// these tests use a literal session ID and exercise the store directly.

import { assert, assertEquals } from "@opensac/assert";
import { closeAll } from "../db/mod.ts";
import {
  abandonInterruptedToolExecutionRecords,
  archiveJSON,
  claimToolExecutionRecord,
  compareAndSwapResponseSessionState,
  getResponseRun,
  getResponseSessionState,
  getResponseTurn,
  listResponseItems,
  listResponseReplayItems,
  listResponseReplayTurns,
  reclaimInterruptedToolExecution,
  requestToolExecutionRecovery,
  saveResponseItem,
  saveResponseRun,
  saveResponseTurn,
  type ToolExecutionRecord,
  updateToolExecutionRecord,
} from "./mod.ts";

const sessionID = "session-response-store";

function tempDir(): string {
  return Deno.makeTempDirSync({ prefix: "opensac-session-" });
}

function decode(value: Uint8Array | null): string {
  return value === null ? "" : new TextDecoder().decode(value);
}

function tryRun(fn: () => void): Error | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err as Error;
  }
}

Deno.test("response runtime store persists summaries items runs and deduplication", () => {
  const sessionDir = tempDir();
  try {
    const now = new Date();

    saveResponseTurn(sessionDir, {
      id: 0,
      sessionId: sessionID,
      localTurnId: "turn-1",
      messageId: null,
      requestId: "",
      responseId: "",
      previousResponseId: "",
      conversationId: "",
      provider: "openai",
      api: "openai-responses",
      model: "gpt-test",
      stateMode: "replay",
      status: "completed",
      incompleteReason: "",
      requestSummary: { model: "gpt-test", api_key: "hidden" },
      responseSummary: { status: "completed", items: 1 },
      createdAt: now,
      completedAt: null,
    });
    const turn = getResponseTurn(sessionDir, sessionID, "turn-1");
    assert(turn !== null, "expected turn");
    const requestJSON = JSON.stringify(turn!.requestSummary);
    assert(requestJSON !== "", "request summary should be populated");
    assert(
      !requestJSON.includes("hidden"),
      "request summary should be sanitized",
    );

    saveResponseItem(sessionDir, {
      id: 0,
      sessionId: sessionID,
      localTurnId: "turn-1",
      responseId: "resp-1",
      itemId: "item-1",
      outputIndex: 0,
      itemType: "future_item",
      itemStatus: "completed",
      itemKey: "",
      sanitizedJson: { type: "future_item", token: "hidden" },
      createdAt: new Date(),
    });
    let items = listResponseItems(sessionDir, sessionID, "turn-1");
    assertEquals(items.length, 1);
    assert(
      !JSON.stringify(items[0].sanitizedJson).includes("hidden"),
      "item should be sanitized",
    );

    saveResponseItem(sessionDir, {
      id: 0,
      sessionId: sessionID,
      localTurnId: "turn-1",
      responseId: "resp-1",
      itemId: "item-1",
      outputIndex: 0,
      itemType: "future_item",
      itemStatus: "completed",
      itemKey: "",
      sanitizedJson: { type: "future_item", status: "completed" },
      createdAt: new Date(),
    });
    items = listResponseItems(sessionDir, sessionID, "turn-1");
    assertEquals(items.length, 1);
    assertEquals(items[0].itemStatus, "completed");

    const replay = listResponseReplayItems(sessionDir, sessionID, 10);
    assertEquals(replay.length, 1);
    assert(JSON.stringify(replay[0]).includes('"status":"completed"'));

    const record: ToolExecutionRecord = {
      id: 0,
      sessionId: sessionID,
      localTurnId: "turn-1",
      executionKey: "exec-1",
      provider: "openai",
      api: "openai-responses",
      responseId: "",
      providerCallId: "call-1",
      toolKind: "function",
      toolName: "bash",
      argsHash: "hash-1",
      executionState: "running",
      resultSummary: undefined,
      providerMetadata: undefined,
      sideEffecting: true,
      createdAt: now,
      completedAt: null,
    };
    const first = claimToolExecutionRecord(sessionDir, record);
    assert(first.created);
    assertEquals(first.record.executionKey, "exec-1");

    const second = claimToolExecutionRecord(sessionDir, record);
    assert(!second.created);
    assertEquals(second.record.id, first.record.id);

    const collision = { ...record, argsHash: "different-hash" };
    const collisionErr = tryRun(() =>
      claimToolExecutionRecord(sessionDir, collision)
    );
    assert(collisionErr !== null);
    assert(collisionErr!.message.includes("execution key collision"));

    assertEquals(
      requestToolExecutionRecovery(sessionDir, sessionID, "turn-1", ["call-1"]),
      1,
    );

    const reclaimed = reclaimInterruptedToolExecution(sessionDir, "exec-1");
    assert(reclaimed);

    const reclaimedRecord = claimToolExecutionRecord(sessionDir, record);
    assert(!reclaimedRecord.created);
    assertEquals(reclaimedRecord.record.executionState, "running");
    const metadata = reclaimedRecord.record.providerMetadata as Record<
      string,
      unknown
    >;
    assertEquals(metadata["recoveryReason"], "user_confirmed");

    const finished = new Date(now.getTime() + 1000);
    const completed: ToolExecutionRecord = {
      ...record,
      executionState: "completed",
      resultSummary: { output: "ok" },
      completedAt: finished,
    };
    updateToolExecutionRecord(sessionDir, completed);

    const abandon: ToolExecutionRecord = {
      ...record,
      executionKey: "exec-abandon",
      executionState: "running",
      resultSummary: undefined,
      completedAt: null,
    };
    const abandonClaim = claimToolExecutionRecord(sessionDir, abandon);
    assert(abandonClaim.created);
    assertEquals(
      abandonInterruptedToolExecutionRecords(sessionDir, sessionID, "turn-1"),
      1,
    );
    const stored = claimToolExecutionRecord(sessionDir, abandon);
    assert(!stored.created);
    assertEquals(stored.record.executionState, "abandoned");
    assert(
      JSON.stringify(stored.record.resultSummary).includes("manual_abandon"),
    );

    const stale: ToolExecutionRecord = {
      ...abandon,
      executionState: "completed",
      resultSummary: { output: "stale" },
    };
    const staleErr = tryRun(() => updateToolExecutionRecord(sessionDir, stale));
    assert(staleErr !== null);
    assert(staleErr!.message.includes("no longer writable"));

    saveResponseRun(sessionDir, {
      id: 0,
      sessionId: sessionID,
      localRunId: "run-1",
      localTurnId: "",
      messageId: null,
      responseId: "resp-1",
      provider: "openai",
      api: "openai-responses",
      state: "queued",
      pollingUrl: "https://api.test/responses/resp-1",
      lastEventSequence: 4,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
    });
    const run = getResponseRun(sessionDir, sessionID, "run-1");
    assert(run !== null);
    assertEquals(run!.state, "queued");
    assertEquals(run!.lastEventSequence, 4);
  } finally {
    closeAll();
  }
});

Deno.test("list response replay turns deduplicates historical function items", () => {
  const sessionDir = tempDir();
  try {
    saveResponseTurn(sessionDir, {
      id: 0,
      sessionId: sessionID,
      localTurnId: "turn-1",
      messageId: null,
      requestId: "",
      responseId: "",
      previousResponseId: "",
      conversationId: "",
      provider: "openai",
      api: "openai-responses",
      model: "gpt-test",
      stateMode: "replay",
      status: "completed",
      incompleteReason: "",
      requestSummary: undefined,
      responseSummary: undefined,
      createdAt: new Date(),
      completedAt: null,
    });
    const items = [
      {
        itemId: "item-1",
        outputIndex: 1,
        sanitizedJson: {
          type: "function_call",
          id: "item-1",
          call_id: "call-1",
          name: "read",
          arguments: "{}",
        },
      },
      {
        itemId: "",
        outputIndex: 1,
        sanitizedJson: {
          type: "function_call",
          call_id: "call-1",
          name: "read",
          arguments: "{}",
        },
      },
    ];
    for (const item of items) {
      saveResponseItem(sessionDir, {
        id: 0,
        sessionId: sessionID,
        localTurnId: "turn-1",
        responseId: "",
        itemId: item.itemId,
        outputIndex: item.outputIndex,
        itemType: "function_call",
        itemStatus: "",
        itemKey: "",
        sanitizedJson: item.sanitizedJson,
        createdAt: new Date(),
      });
    }
    const turns = listResponseReplayTurns(sessionDir, sessionID, 10);
    assertEquals(turns.length, 1);
    assertEquals(turns[0].items.length, 1);
  } finally {
    closeAll();
  }
});

Deno.test("archive JSON preserves numeric usage counters", () => {
  const raw = archiveJSON({
    usage: { totalTokens: 18, cached_tokens: 4, access_token: "secret" },
  });
  const value = JSON.parse(decode(raw)) as {
    usage: {
      totalTokens: number;
      cached_tokens: number;
      access_token: string;
    };
  };
  assertEquals(value.usage.totalTokens, 18);
  assertEquals(value.usage.cached_tokens, 4);
  assertEquals(value.usage.access_token, "[REDACTED]");
});

Deno.test("response session state compare and swap", () => {
  const sessionDir = tempDir();
  try {
    const state = {
      sessionId: sessionID,
      stateMode: "previous_response_id",
      previousResponseId: "resp-1",
      conversationId: "",
      provider: "openai",
      api: "openai-responses",
      model: "gpt-test",
      version: 0,
      updatedAt: new Date(),
    };
    const created = compareAndSwapResponseSessionState(sessionDir, state, 0);
    assert(created);

    const stored = getResponseSessionState(sessionDir, sessionID);
    assert(stored !== null);
    assertEquals(stored!.version, 1);
    assertEquals(stored!.previousResponseId, "resp-1");

    state.previousResponseId = "resp-2";
    const updated = compareAndSwapResponseSessionState(
      sessionDir,
      state,
      stored!.version,
    );
    assert(updated);

    const stale = compareAndSwapResponseSessionState(
      sessionDir,
      state,
      stored!.version,
    );
    assert(!stale);
  } finally {
    closeAll();
  }
});
