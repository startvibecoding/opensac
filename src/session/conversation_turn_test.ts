// (conversation turn boundaries).
//
// Go drives turn admission through the session Manager; the not-yet-ported
// Manager is replaced with direct function calls against a temp session
// database.

import { assert, assertEquals, assertThrows } from "../compat/assert.ts";
import { closeAll } from "../db/mod.ts";
import {
  ConversationTurnNotOpenError,
  endConversationTurn,
  listConversationTurns,
  startConversationTurn,
} from "./mod.ts";
import { test } from "#testing";

function tempDir(): string {
  return Deno.makeTempDirSync({ prefix: "opensac-session-" });
}

test("startConversationTurn opens a durable boundary row", () => {
  const sessionDir = tempDir();
  try {
    startConversationTurn(sessionDir, {
      id: "turn-1",
      sessionId: "s-1",
      intentId: "i-1",
      runId: "r-1",
      attempt: 0,
      kind: "",
      status: "",
      startSeq: 0,
      endSeq: null,
      startedAt: new Date("2026-01-01T00:00:00Z"),
      endedAt: null,
    });
    const turns = listConversationTurns(sessionDir, "s-1");
    assertEquals(turns.length, 1);
    assertEquals(turns[0].id, "turn-1");
    assertEquals(turns[0].status, "open");
    assertEquals(turns[0].kind, "conversation");
    assertEquals(turns[0].intentId, "i-1");
    assert(turns[0].startSeq > 0);
    assertEquals(turns[0].endSeq, null);
  } finally {
    closeAll();
  }
});

test("opening the same open turn with the same run is idempotent", () => {
  const sessionDir = tempDir();
  try {
    const turn = {
      id: "turn-1",
      sessionId: "s-1",
      intentId: "i-1",
      runId: "r-1",
      attempt: 0,
      kind: "",
      status: "",
      startSeq: 0,
      endSeq: null,
      startedAt: new Date(),
      endedAt: null,
    };
    startConversationTurn(sessionDir, turn);
    startConversationTurn(sessionDir, turn);
    assertEquals(listConversationTurns(sessionDir, "s-1").length, 1);
  } finally {
    closeAll();
  }
});

test("a second concurrent turn is rejected", () => {
  const sessionDir = tempDir();
  try {
    startConversationTurn(sessionDir, {
      id: "turn-1",
      sessionId: "s-1",
      intentId: "",
      runId: "",
      attempt: 0,
      kind: "",
      status: "",
      startSeq: 0,
      endSeq: null,
      startedAt: new Date(),
      endedAt: null,
    });
    assertThrows(
      () =>
        startConversationTurn(sessionDir, {
          id: "turn-2",
          sessionId: "s-1",
          intentId: "",
          runId: "",
          attempt: 0,
          kind: "",
          status: "",
          startSeq: 0,
          endSeq: null,
          startedAt: new Date(),
          endedAt: null,
        }),
      Error,
      "already open",
    );
  } finally {
    closeAll();
  }
});

test("endConversationTurn closes the boundary and is idempotent", () => {
  const sessionDir = tempDir();
  try {
    startConversationTurn(sessionDir, {
      id: "turn-1",
      sessionId: "s-1",
      intentId: "i-1",
      runId: "r-1",
      attempt: 0,
      kind: "",
      status: "",
      startSeq: 0,
      endSeq: null,
      startedAt: new Date("2026-01-01T00:00:00Z"),
      endedAt: null,
    });
    endConversationTurn(
      sessionDir,
      "s-1",
      "turn-1",
      "completed",
      "stop",
      new Date("2026-01-01T00:00:05Z"),
    );
    const [closed] = listConversationTurns(sessionDir, "s-1");
    assertEquals(closed.status, "completed");
    assert(closed.endSeq !== null);
    assert(closed.endedAt !== null);

    // Closing again is an idempotent success and does not move the boundary.
    endConversationTurn(
      sessionDir,
      "s-1",
      "turn-1",
      "failed",
      "retry",
      new Date("2026-01-01T00:00:10Z"),
    );
    const [again] = listConversationTurns(sessionDir, "s-1");
    assertEquals(again.status, "completed");
    assertEquals(again.endSeq, closed.endSeq);
  } finally {
    closeAll();
  }
});

test("ending an unknown turn reports not-open", () => {
  const sessionDir = tempDir();
  try {
    assertThrows(
      () =>
        endConversationTurn(
          sessionDir,
          "s-1",
          "missing",
          "completed",
          "",
          new Date(),
        ),
      ConversationTurnNotOpenError,
    );
  } finally {
    closeAll();
  }
});

test("a closed turn can be reopened for a new attempt", () => {
  const sessionDir = tempDir();
  try {
    const base = {
      id: "turn-1",
      sessionId: "s-1",
      intentId: "i-1",
      runId: "r-1",
      attempt: 0,
      kind: "",
      status: "",
      startSeq: 0,
      endSeq: null,
      startedAt: new Date("2026-01-01T00:00:00Z"),
      endedAt: null,
    };
    startConversationTurn(sessionDir, base);
    endConversationTurn(
      sessionDir,
      "s-1",
      "turn-1",
      "failed",
      "retry",
      new Date(),
    );
    startConversationTurn(sessionDir, {
      ...base,
      runId: "r-2",
      startedAt: new Date("2026-01-01T01:00:00Z"),
    });
    const [turn] = listConversationTurns(sessionDir, "s-1");
    assertEquals(turn.status, "open");
    assertEquals(turn.endSeq, null);
    assertEquals(turn.endedAt, null);
  } finally {
    closeAll();
  }
});
