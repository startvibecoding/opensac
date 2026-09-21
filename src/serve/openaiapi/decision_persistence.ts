// Ported from internal/serve/openaiapi/decision_persistence.go. The helpers
// are Server methods in Go; the Deno projection passes the Server as the
// first argument.
import type { Server } from "./server.ts";
import type { APISession } from "./session_mgr.ts";
import type {
  DecisionRequest,
  DecisionResolution,
} from "../../agentruntime/decision.ts";
import {
  DecisionApproval,
  DecisionQuestion,
} from "../../agentruntime/decision.ts";
import { decisionEventFields } from "../../agentruntime/decision_events.ts";
import {
  newDecisionRequestRecordWithDeadline,
  newDecisionResolutionRecord,
} from "../../agentruntime/decision_record.ts";
import { recordSessionRunEvent } from "./events.ts";

/**
 * decisionDeadline maps the serve request timeout to a decision expiry. Go
 * returns the zero time; the port returns undefined (no deadline).
 */
export function decisionDeadline(server: Server): Date | undefined {
  const secs = server.cfg?.requestTimeoutSecs ?? 0;
  if (!server.cfg || secs <= 0) return undefined;
  return new Date(Date.now() + secs * 1000);
}

/**
 * recordDecisionEvent persists the protocol-neutral DecisionRecord alongside
 * the legacy payload. The legacy fields remain the compatibility contract for
 * existing replay clients; the neutral record is the migration source for
 * future cross-entry recovery.
 */
export function recordDecisionEvent(
  server: Server,
  sess: APISession | null | undefined,
  request: DecisionRequest,
  resolution: DecisionResolution | null,
  eventType: string,
  status: string,
  source: string,
  mode: string,
  payload: unknown,
): Error | null {
  return recordDecisionEventWithDeadline(
    server,
    sess,
    request,
    resolution,
    eventType,
    status,
    source,
    mode,
    payload,
    undefined,
  );
}

export function recordDecisionEventWithDeadline(
  server: Server,
  sess: APISession | null | undefined,
  request: DecisionRequest,
  resolution: DecisionResolution | null,
  eventType: string,
  status: string,
  source: string,
  mode: string,
  payload: unknown,
  expiresAt?: Date,
): Error | null {
  if (sess === null || sess === undefined) return null;
  const record = resolution === null || resolution === undefined
    ? newDecisionRequestRecordWithDeadline(request, payload, expiresAt)
    : newDecisionResolutionRecord(request, resolution, payload);
  const data = decisionEventFields(record, payload);
  // Preserve the legacy event shape used by existing recovery/replay code.
  // New consumers can use decision/payload; old consumers continue to find
  // approval/question and resolution at the top level.
  if (request.kind === DecisionApproval) {
    if (eventType === "approval_requested") {
      data["approval"] = payload;
    } else {
      mergeDecisionPayload(data, payload);
    }
  } else if (request.kind === DecisionQuestion) {
    if (eventType === "question_requested") {
      data["question"] = payload;
    } else {
      mergeDecisionPayload(data, payload);
    }
  }
  return recordSessionRunEvent(
    server,
    sess,
    request.runId,
    eventType,
    status,
    source,
    "",
    mode,
    data,
  );
}

/** mergeDecisionPayload flattens an object payload into the legacy fields. */
export function mergeDecisionPayload(
  data: Record<string, unknown>,
  payload: unknown,
): void {
  // Go round-trips the payload through encoding/json into a map, so only
  // JSON-object payloads contribute fields (arrays and scalars are skipped)
  // and undefined fields become absent.
  if (payload === null || typeof payload !== "object") return;
  let values: unknown;
  try {
    values = JSON.parse(JSON.stringify(payload));
  } catch {
    return;
  }
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    return;
  }
  for (const [field, value] of Object.entries(values)) {
    data[field] = value;
  }
}
