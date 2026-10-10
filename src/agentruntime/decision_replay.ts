//
// Reconstructs the latest pending decision set from durable request/resolution
// records. It is intentionally protocol-neutral; adapters remain responsible
// for decoding their payload fields.

import { type DecisionRecord } from "./decision_record.ts";

/** Reconstructs the latest pending decision set at the current clock instant. */
export function replayDecisions(
  records: DecisionRecord[],
): Map<string, DecisionRecord> {
  return replayDecisionsAt(records, new Date());
}

/**
 * Reconstructs pending decisions at a stable clock instant. Expired records
 * are omitted so callers can terminalize them durably.
 */
export function replayDecisionsAt(
  records: DecisionRecord[],
  now: Date,
): Map<string, DecisionRecord> {
  const pending = new Map<string, DecisionRecord>();
  for (const record of records) {
    if (record.id === "") continue;
    switch (record.status) {
      case "pending":
      case "requested": {
        const expires = expiresMillis(record);
        if (expires !== undefined && now.getTime() >= expires) {
          pending.delete(record.id);
          continue;
        }
        pending.set(record.id, record);
        break;
      }
      default:
        pending.delete(record.id);
    }
  }
  return pending;
}

export function expiredDecisions(
  records: DecisionRecord[],
  now: Date,
): DecisionRecord[] {
  const latest = new Map<string, DecisionRecord>();
  for (const record of records) {
    if (record.id === "") continue;
    switch (record.status) {
      case "pending":
      case "requested":
        latest.set(record.id, record);
        break;
      default:
        latest.delete(record.id);
    }
  }
  const result: DecisionRecord[] = [];
  for (const record of latest.values()) {
    const expires = expiresMillis(record);
    if (expires !== undefined && now.getTime() >= expires) {
      result.push(record);
    }
  }
  return result;
}

function expiresMillis(record: DecisionRecord): number | undefined {
  const value: unknown = record.expiresAt;
  if (value instanceof Date) {
    const ms = value.getTime();
    return isNaN(ms) ? undefined : ms;
  }
  if (typeof value === "string" && value !== "") {
    const ms = new Date(value).getTime();
    return isNaN(ms) ? undefined : ms;
  }
  return undefined;
}
