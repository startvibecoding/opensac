//
// The durable conversation-turn boundary index used by Session fork
// resolution. It is intentionally separate from SessionRun because a Run may
// execute tools or maintenance work without producing a conversation turn.
//
// Deviations from Go: `context.Context` is dropped (the DAO layer is
// synchronous), and `tx.Rollback` maps to `Database.runInTx`.

import type { Tx } from "../dao/mod.ts";
import { ConversationTurnDAO, isNoRows } from "../dao/mod.ts";
import { entrySession, entryTurnEnd, entryTurnStart } from "./entry.ts";
import type { TurnEndEntry, TurnStartEntry } from "./entry.ts";
import { generateID } from "./entry.ts";
import { openRootDB, parseSessionTimestamp } from "./root_db.ts";
import { getEntryMetadata } from "./replay.ts";
import { validateRuntimeLeaseTx } from "./runtime_lock.ts";

/** Raised when a turn cannot be closed because it is not open. */
export class ConversationTurnNotOpenError extends Error {
  override name = "ConversationTurnNotOpenError";
  constructor(turnId: string) {
    super(`conversation turn is not open: ${turnId}`);
  }
}

/** The durable boundary index for one logical conversation turn. */
export interface ConversationTurn {
  id: string;
  sessionId: string;
  intentId: string;
  runId: string;
  attempt: number;
  kind: string;
  status: string;
  startSeq: number;
  endSeq: number | null;
  startedAt: Date;
  endedAt: Date | null;
}

export function normalizeTurnStatus(status: string): string {
  return status === "" ? "open" : status;
}

export function stringPtr(value: string): string | null {
  return value === "" ? null : value;
}

/**
 * Serializes one turn entry and appends it. Returns the new `entries.seq`
 * cursor.
 */
export function appendTurnEntryTx(
  tx: Tx,
  sessionId: string,
  entry: unknown,
  parentId: string,
): number {
  const meta = getEntryMetadata(entry);
  if (meta.id === "" || meta.type === "") {
    throw new Error("turn entry identity is required");
  }
  const data = JSON.stringify(entry);
  const parentPtr = parentId === "" ? null : parentId;
  return new ConversationTurnDAO(null).appendEntry(tx, {
    seq: 0,
    sessionId,
    id: meta.id,
    type: meta.type,
    parentId: parentPtr,
    timestamp: meta.timestamp.toISOString(),
    data,
  });
}

/** Returns the current branch leaf, excluding the session header entry. */
export function currentLeafTx(tx: Tx, sessionId: string): string {
  return new ConversationTurnDAO(null).currentLeaf(
    tx,
    sessionId,
    entrySession,
  );
}

/** Atomically writes turn/start and its boundary row. */
export function startConversationTurn(
  sessionDir: string,
  turn: ConversationTurn,
): void {
  if (turn.sessionId === "" || turn.id === "") {
    throw new Error("conversation turn ID and session ID are required");
  }
  const db = openRootDB(sessionDir);
  db.runInTx((tx) => {
    validateRuntimeLeaseTx(tx, sessionDir, turn.sessionId);
    startConversationTurnTx(tx, turn);
  });
}

/**
 * Shared transaction primitive used by standalone turn admission and atomic
 * durable Run admission. The caller owns lease validation and commit.
 */
export function startConversationTurnTx(
  tx: Tx,
  turn: ConversationTurn,
): void {
  if (turn.sessionId === "" || turn.id === "") {
    throw new Error("conversation turn ID and session ID are required");
  }
  if (!(turn.startedAt instanceof Date) || isNaN(turn.startedAt.getTime())) {
    turn = { ...turn, startedAt: new Date() };
  }
  const kind = turn.kind === "" ? "conversation" : turn.kind;
  turn = { ...turn, kind, status: "open" };

  const dao = new ConversationTurnDAO(null);
  let existing = true;
  let state: { intentId: string; status: string; runId: string };
  try {
    state = dao.state(tx, turn.sessionId, turn.id);
  } catch (err) {
    if (!isNoRows(err)) throw err;
    existing = false;
    state = { intentId: "", status: "", runId: "" };
  }
  if (existing) {
    if (
      state.intentId !== "" && turn.intentId !== "" &&
      state.intentId !== turn.intentId
    ) {
      throw new Error(
        `conversation turn ${turn.id} belongs to another intent`,
      );
    }
    if (state.status === "open") {
      if (state.runId === turn.runId && turn.runId !== "") return;
      throw new Error(
        `conversation turn already open for session ${turn.sessionId}`,
      );
    }
  }
  const openCount = dao.openCount(tx, turn.sessionId);
  if (openCount !== 0) {
    throw new Error(
      `conversation turn already open for session ${turn.sessionId}`,
    );
  }
  const parentId = currentLeafTx(tx, turn.sessionId);
  const entry: TurnStartEntry = {
    type: entryTurnStart,
    id: generateID(),
    parentId: parentId === "" ? null : parentId,
    timestamp: turn.startedAt,
    turnId: turn.id,
    ...(turn.intentId !== "" ? { intentId: turn.intentId } : {}),
    ...(turn.runId !== "" ? { runId: turn.runId } : {}),
    ...(turn.attempt !== 0 ? { attempt: turn.attempt } : {}),
  };
  const startSeq = appendTurnEntryTx(tx, turn.sessionId, entry, parentId);
  if (existing) {
    dao.reopen(tx, {
      id: turn.id,
      sessionId: turn.sessionId,
      intentId: turn.intentId,
      kind: "",
      status: "",
      startSeq: 0,
      endSeq: null,
      startedAt: turn.startedAt.toISOString(),
      endedAt: null,
    });
  } else {
    dao.insert(tx, {
      id: turn.id,
      sessionId: turn.sessionId,
      intentId: turn.intentId,
      kind,
      status: "open",
      startSeq,
      endSeq: null,
      startedAt: turn.startedAt.toISOString(),
      endedAt: null,
    });
  }
}

/** Atomically writes turn/end and closes its boundary row. */
export function endConversationTurn(
  sessionDir: string,
  sessionId: string,
  turnId: string,
  status: string,
  stopReason: string,
  endedAt: Date,
): void {
  if (sessionId === "" || turnId === "") {
    throw new Error("conversation turn and session ID are required");
  }
  if (!(endedAt instanceof Date) || isNaN(endedAt.getTime())) {
    endedAt = new Date();
  }
  const normalized = normalizeTurnStatus(status);
  const db = openRootDB(sessionDir);
  db.runInTx((tx) => {
    validateRuntimeLeaseTx(tx, sessionDir, sessionId);
    const dao = new ConversationTurnDAO(null);
    let state: { intentId: string; status: string; runId: string };
    try {
      state = dao.state(tx, sessionId, turnId);
    } catch (err) {
      if (isNoRows(err)) throw new ConversationTurnNotOpenError(turnId);
      throw err;
    }
    if (state.status !== "open") {
      // Closing an already-closed turn is idempotent; no new turn/end entry.
      return;
    }
    const parentId = currentLeafTx(tx, sessionId);
    const entry: TurnEndEntry = {
      type: entryTurnEnd,
      id: generateID(),
      parentId: parentId === "" ? null : parentId,
      timestamp: endedAt,
      turnId,
      status: normalized,
      ...(state.intentId !== "" ? { intentId: state.intentId } : {}),
      ...(state.runId !== "" ? { runId: state.runId } : {}),
      ...(stopReason !== "" ? { stopReason } : {}),
    };
    const endSeq = appendTurnEntryTx(tx, sessionId, entry, parentId);
    dao.close(tx, sessionId, turnId, normalized, endSeq, endedAt.toISOString());
  });
}

/** Returns boundary rows in transcript order. */
export function listConversationTurns(
  sessionDir: string,
  sessionId: string,
): ConversationTurn[] {
  const db = openRootDB(sessionDir);
  const records = new ConversationTurnDAO(db.db).list(sessionId);
  return records.map(scanConversationTurnRecord);
}

export function scanConversationTurnRecord(
  record: {
    id: string;
    sessionId: string;
    intentId: string;
    kind: string;
    status: string;
    startSeq: number;
    endSeq: number | null;
    startedAt: string;
    endedAt: string | null;
  },
): ConversationTurn {
  return {
    id: record.id,
    sessionId: record.sessionId,
    intentId: record.intentId,
    runId: "",
    attempt: 0,
    kind: record.kind,
    status: record.status,
    startSeq: record.startSeq,
    endSeq: record.endSeq,
    startedAt: parseSessionTimestamp(record.startedAt),
    endedAt: record.endedAt === null
      ? null
      : parseSessionTimestamp(record.endedAt),
  };
}
