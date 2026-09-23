//
// Decision ledger: adapters persist each approval/question transition as a run
// event whose type is `decisionEventType(status)` and whose Data carries the
// canonical envelope produced by `decisionEventFields`. Both directions live
// here so no adapter hand-assembles or hand-parses the envelope.
//
// Deviations: `json.RawMessage` maps to decoded `unknown`, and the
// `context.Context`-carrying `*Context` variants are dropped because the DAO
// layer is synchronous.

import {
  decisionEventType,
  isDecisionEventType,
} from "../session/decision_events.ts";
import type { SessionRunEvent } from "../session/session_events.ts";
import { listSessionRunEvents } from "../session/session_events.ts";
import type { DecisionRequest, DecisionResolution } from "./decision.ts";
import {
  createDecisionRequestRecord,
  createDecisionResolutionRecord,
  type DecisionRecord,
  reviveDecisionRecordDates,
} from "./decision_record.ts";
import { type RunEvent, type RunEventSink } from "./run_event.ts";

/** Decision statuses recorded in the durable ledger. */
export const DECISION_STATUS_PENDING = "pending";
export const DECISION_STATUS_REQUESTED = "requested";
export const DECISION_STATUS_RESOLVED = "resolved";
export const DECISION_STATUS_CANCELLED = "cancelled";
export const DECISION_STATUS_TIMED_OUT = "timed_out";

/**
 * The canonical record-source label adapters project for decision entries
 * (trajectory windows, transcript filters). Owned here so no adapter
 * re-spells the envelope vocabulary.
 */
export const DECISION_RECORD_SOURCE = "decision";

/**
 * The minimal durable decision envelope: the record under the canonical key.
 * Writers that persist only a decision use it directly; `decisionEventFields`
 * adds an adapter payload.
 */
export function decisionEventEnvelope(
  record: DecisionRecord,
): Record<string, unknown> {
  return { decision: record };
}

/**
 * The canonical durable decision envelope. `record` is the Runtime-owned
 * identity and `payload` is the optional adapter protocol body.
 */
export function decisionEventFields(
  record: DecisionRecord,
  payload: unknown,
): Record<string, unknown> {
  const fields = decisionEventEnvelope(record);
  fields.payload = payload;
  return fields;
}

/**
 * The single owner of the request/resolution record shape: a pending status
 * becomes a request record carrying the optional deadline, any other status a
 * resolution record.
 */
export function createDecisionRecord(
  request: DecisionRequest,
  status: string,
  value: string,
  payload: unknown,
  expiresAt?: Date,
): DecisionRecord {
  if (status === DECISION_STATUS_PENDING) {
    return createDecisionRequestRecord(request, payload, expiresAt);
  }
  return createDecisionResolutionRecord(
    request,
    {
      id: request.id,
      kind: request.kind,
      status,
      value,
    } satisfies DecisionResolution,
    payload,
  );
}

/** One durable decision state change. */
export interface DecisionTransition {
  request: DecisionRequest;
  status: string;
  value?: string;
  payload?: unknown;
  expiresAt?: Date;
  source?: string;
  model?: string;
  mode?: string;
}

/** Builds the canonical durable run event for a transition. */
export function buildDecisionEvent(t: DecisionTransition): RunEvent {
  const record = createDecisionRecord(
    t.request,
    t.status,
    t.value ?? "",
    t.payload,
    t.expiresAt,
  );
  const data = decisionEventFields(record, t.payload);
  return {
    sessionId: t.request.sessionId ?? "",
    runId: t.request.runId,
    eventType: decisionEventType(t.status),
    source: t.source ?? "",
    status: t.status,
    model: t.model ?? "",
    mode: t.mode ?? "",
    timestamp: new Date(),
    data,
  };
}

/** Persists a transition through `sink`. A missing sink is a no-op. */
export function recordDecisionEvent(
  sink: RunEventSink | null | undefined,
  t: DecisionTransition,
): string {
  const event = buildDecisionEvent(t);
  if (sink === null || sink === undefined) return "";
  return sink.record(event);
}

/**
 * Decodes a run event that belongs to the decision ledger, defaulting
 * session/run identity from the persisted row. Returns `null` for unrelated
 * events or a malformed envelope.
 */
export function decodeDecisionEvent(
  ev: SessionRunEvent,
): DecisionRecord | null {
  if (!isDecisionEventType(ev.eventType)) return null;
  const envelope = asRecord(ev.data);
  if (envelope === undefined) return null;
  const decision = envelope.decision;
  if (
    decision === null || typeof decision !== "object" || Array.isArray(decision)
  ) {
    return null;
  }
  const record = reviveDecisionRecordDates(decision as Record<string, unknown>);
  if (record.id === "") return null;
  if (record.sessionId === "") record.sessionId = ev.sessionId;
  if (record.runId === "") record.runId = ev.runId;
  return record;
}

/** Returns the decoded decision ledger for a session in durable order. */
export function loadDecisionRecords(
  sessionDir: string,
  sessionId: string,
): DecisionRecord[] {
  const events = listSessionRunEvents(sessionDir, sessionId);
  const records: DecisionRecord[] = [];
  for (const ev of events) {
    const record = decodeDecisionEvent(ev);
    if (record !== null) records.push(record);
  }
  return records;
}

/**
 * Returns the decision ledger for a single run. An empty `runId` returns the
 * whole session ledger.
 */
export function loadRunDecisionRecords(
  sessionDir: string,
  sessionId: string,
  runId: string,
): DecisionRecord[] {
  const records = loadDecisionRecords(sessionDir, sessionId);
  if (runId === "") return records;
  return records.filter((record) => record.runId === runId);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
