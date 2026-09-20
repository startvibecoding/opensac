// Ported from internal/session/input_resources.go
//
// Runtime-owned input resource lifecycle events. Transport references are
// intentionally absent; the events are the canonical lifecycle projection.

import { InputResourceDAO, isNoRows, type Tx } from "../dao/mod.ts";
import { writeRootDatabase } from "./database.ts";
import { openRootDB, parseSessionTimestamp } from "./root_db.ts";

// Go persists this timestamp with `time.RFC3339Nano`, and ListEvents orders by
// `timestamp ASC, id ASC`. A `Date` only carries millisecond precision, so two
// lifecycle events created in the same millisecond would tie on `timestamp` and
// fall back to the id tiebreak, losing creation order. Emit a nanosecond
// fraction (monotonic within a millisecond) so durable order matches Go while
// the parsed instant stays on the same millisecond.
let lastTimestampMs = Number.NEGATIVE_INFINITY;
let lastTimestampSubMs = 0;

function formatInputResourceTimestamp(timestamp: Date): string {
  const ms = timestamp.getTime();
  if (!Number.isFinite(ms)) return timestamp.toISOString();
  let subMs = 0;
  if (ms === lastTimestampMs) {
    subMs = lastTimestampSubMs + 1;
    if (subMs > 999_999) subMs = 999_999;
  }
  lastTimestampMs = ms;
  lastTimestampSubMs = subMs;
  // Drop the trailing `Z`, keep the millisecond fraction, then append the
  // sub-millisecond nanosecond digits (nine fractional digits total).
  const base = new Date(ms).toISOString().slice(0, -1);
  return `${base}${String(subMs).padStart(6, "0")}Z`;
}

/** The canonical lifecycle projection for one Runtime materialized resource. */
export interface InputResourceEvent {
  id: string;
  sessionId: string;
  resourceId: string;
  runId: string;
  eventType: string;
  status: string;
  timestamp: Date;
  data?: unknown;
}

/**
 * Records a resource lifecycle event in the caller's transaction.
 * Deterministic event IDs make retries safe after an unknown commit result.
 */
export function appendInputResourceEventTx(
  tx: Tx,
  event: InputResourceEvent,
): void {
  if (tx === null) throw new Error("input resource event transaction is nil");
  if (
    event.id === "" || event.sessionId === "" || event.resourceId === "" ||
    event.eventType === ""
  ) {
    throw new Error("input resource event identity and type are required");
  }
  const timestamp = event.timestamp ?? new Date();
  const data = event.data === undefined
    ? "{}"
    : typeof event.data === "string"
    ? event.data
    : JSON.stringify(event.data);
  new InputResourceDAO(null).appendEvent(tx, {
    id: event.id,
    sessionId: event.sessionId,
    resourceId: event.resourceId,
    runId: event.runId,
    eventType: event.eventType,
    status: event.status,
    timestamp: formatInputResourceTimestamp(timestamp),
    data,
  });
}

/**
 * Appends a resource lifecycle event outside a larger transaction. Runtime
 * admission paths should use `appendInputResourceEventTx`.
 */
export function saveInputResourceEvent(
  sessionDir: string,
  event: InputResourceEvent,
): void {
  writeRootDatabase(sessionDir, (tx) => {
    appendInputResourceEventTx(tx, event);
  });
}

/** Returns resource lifecycle events in durable order. */
export function listInputResourceEvents(
  sessionDir: string,
  sessionId: string,
): InputResourceEvent[] {
  if (sessionId === "") return [];
  const db = openRootDB(sessionDir);
  const records = new InputResourceDAO(db.db).listEvents(sessionId);
  return records.map((record) => ({
    id: record.id,
    sessionId: record.sessionId,
    resourceId: record.resourceId,
    runId: record.runId,
    eventType: record.eventType,
    status: record.status,
    timestamp: parseSessionTimestamp(record.timestamp),
    data: record.data === "" ? undefined : JSON.parse(record.data),
  }));
}

/**
 * Attaches Runtime-prepared input resources while the intent, Run row, and
 * start event are being admitted. A resource already attached to another
 * attempt of the same immutable intent is reusable for a retry; ownership from
 * a different intent is rejected.
 */
export function bindInputResourcesToRunTx(
  tx: Tx,
  sessionId: string,
  runId: string,
  intentId: string,
  resourceIds: string[],
): void {
  if (resourceIds.length === 0) return;
  if (sessionId === "" || runId === "") {
    throw new Error("input resource binding requires session and Run IDs");
  }
  const dao = new InputResourceDAO(null);
  const seen = new Set<string>();
  for (const resourceId of resourceIds) {
    if (resourceId === "" || seen.has(resourceId)) continue;
    seen.add(resourceId);

    let ownerRunId: string;
    let status: string;
    try {
      ({ runId: ownerRunId, status } = dao.ownerRun(tx, resourceId, sessionId));
    } catch (err) {
      if (isNoRows(err)) {
        throw new Error(
          `input resource ${resourceId} does not belong to session`,
        );
      }
      throw err;
    }
    if (status === "missing" || status === "deleted") {
      throw new Error(
        `input resource ${resourceId} is not attachable (status ${status})`,
      );
    }
    if (ownerRunId === "" || ownerRunId === runId) {
      dao.updateAttachment(tx, sessionId, resourceId, runId);
      appendInputResourceEventTx(tx, {
        id: `input-resource-${resourceId}-attached-${runId}`,
        sessionId,
        resourceId,
        runId,
        eventType: "input_resource_attached",
        status: "attached",
        timestamp: new Date(),
        data: { runId },
      });
      continue;
    }

    // Retries reuse the original immutable input resource. There is no need to
    // overwrite its canonical owner just to represent another attempt.
    let ownerIntentId: string;
    try {
      ownerIntentId = dao.ownerIntent(tx, ownerRunId, sessionId);
    } catch (err) {
      if (isNoRows(err)) ownerIntentId = "";
      else throw err;
    }
    if (intentId === "" || ownerIntentId !== intentId) {
      throw new Error(
        `input resource ${resourceId} is already attached to another Run`,
      );
    }
  }
}
