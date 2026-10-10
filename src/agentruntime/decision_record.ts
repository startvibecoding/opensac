//
// `DecisionRecord` is the protocol-neutral durable projection of a pending or
// resolved Approval/Question. Adapters may persist their legacy payload beside
// this record while migrating; the record itself must not contain
// agent/runtime pointers or protocol-specific response channels. Go's
// `json.RawMessage` payload maps to decoded `unknown`; `time.Time` maps to
// `Date`.

import {
  type DecisionKind,
  type DecisionRequest,
  type DecisionResolution,
} from "./decision.ts";

export interface DecisionRecord {
  id: string;
  sessionId: string;
  runId: string;
  kind: DecisionKind;
  status: string;
  value?: string;
  payload?: unknown;
  createdAt?: Date;
  expiresAt?: Date;
}

export function createDecisionRequestRecord(
  request: DecisionRequest,
  payload: unknown,
  expiresAt?: Date,
): DecisionRecord {
  return {
    id: request.id,
    sessionId: request.sessionId ?? "",
    runId: request.runId,
    kind: request.kind,
    status: "pending",
    payload,
    createdAt: new Date(),
    expiresAt,
  };
}

export function createDecisionResolutionRecord(
  request: DecisionRequest,
  resolution: DecisionResolution,
  payload: unknown,
): DecisionRecord {
  return {
    id: request.id,
    sessionId: request.sessionId ?? "",
    runId: request.runId,
    kind: request.kind,
    status: resolution.status,
    value: resolution.value,
    payload,
    createdAt: new Date(),
  };
}

/**
 * Revives the `createdAt`/`expiresAt` string fields produced by JSON parsing
 * back into `Date` values. Go's `encoding/json` unmarshals time.Time directly;
 * the Node port revives explicitly because session event data is pre-decoded.
 */
export function reviveDecisionRecordDates(
  raw: Record<string, unknown>,
): DecisionRecord {
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
    runId: typeof raw.runId === "string" ? raw.runId : "",
    kind: typeof raw.kind === "string" ? raw.kind : "",
    status: typeof raw.status === "string" ? raw.status : "",
    value: typeof raw.value === "string" ? raw.value : undefined,
    payload: raw.payload,
    createdAt: reviveDate(raw.createdAt),
    expiresAt: reviveDate(raw.expiresAt),
  };
}

function reviveDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value === "string" && value !== "") {
    const parsed = new Date(value);
    return isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}
