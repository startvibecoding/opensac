//
// Runtime-owned ESM guidance rows. Execution-path writes run the fenced
// runtime-lease check inside their transaction so a stale process cannot append
// guidance after losing its lease.

import { ESMGuidanceDAO, type ESMGuidanceRecord } from "../dao/mod.ts";
import { writeRootDatabase } from "./database.ts";
import { openRootDB, parseSessionTimestamp } from "./root_db.ts";
import { validateRuntimeLeaseTx } from "./runtime_lock.ts";

/** One Runtime-owned ESM guidance record. */
export interface ESMGuidance {
  id: string;
  sessionId: string;
  objectiveVersion?: string;
  guidance: string;
  status: string;
  createdAt: Date;
  consumedAt?: Date | null;
}

/** Persists one guidance row, defaulting its status to `pending`. */
export function saveESMGuidance(
  sessionDir: string,
  guidance: ESMGuidance,
): void {
  const value = guidance.guidance.trim();
  if (value === "" || guidance.id === "" || guidance.sessionId === "") {
    throw new Error("ESM guidance ID, session ID, and guidance are required");
  }
  const status = guidance.status === "" ? "pending" : guidance.status;
  const createdAt = isZeroDate(guidance.createdAt)
    ? new Date()
    : guidance.createdAt;
  writeRootDatabase(sessionDir, (tx) => {
    validateRuntimeLeaseTx(tx, sessionDir, guidance.sessionId);
    new ESMGuidanceDAO(null).insert(tx, {
      id: guidance.id,
      sessionId: guidance.sessionId,
      objectiveVersion: guidance.objectiveVersion ?? "",
      guidance: value,
      status,
      createdAt: createdAt.toISOString(),
      consumedAt:
        guidance.consumedAt == null ? null : guidance.consumedAt.toISOString(),
    });
  });
}

/** Returns guidance rows in durable creation order. */
export function listESMGuidance(
  sessionDir: string,
  sessionId: string,
  status: string,
  limit: number,
): ESMGuidance[] {
  if (limit <= 0 || limit > 500) limit = 100;
  const db = openRootDB(sessionDir);
  const records = new ESMGuidanceDAO(db.db).list(sessionId, status, limit);
  return records.map(esmGuidanceFromRecord);
}

/** Marks the given guidance IDs consumed, leaving other rows untouched. */
export function consumeESMGuidance(
  sessionDir: string,
  sessionId: string,
  ids: string[],
): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  writeRootDatabase(sessionDir, (tx) => {
    validateRuntimeLeaseTx(tx, sessionDir, sessionId);
    const dao = new ESMGuidanceDAO(null);
    for (const id of ids) {
      if (id.trim() === "") continue;
      dao.consume(tx, sessionId, id, now);
    }
  });
}

function esmGuidanceFromRecord(record: ESMGuidanceRecord): ESMGuidance {
  const guidance: ESMGuidance = {
    id: record.id,
    sessionId: record.sessionId,
    objectiveVersion: record.objectiveVersion,
    guidance: record.guidance,
    status: record.status,
    createdAt: parseSessionTimestamp(record.createdAt),
  };
  if (record.consumedAt !== null) {
    guidance.consumedAt = parseSessionTimestamp(record.consumedAt);
  }
  return guidance;
}

function isZeroDate(value: Date | undefined): boolean {
  return (
    value === undefined ||
    Number.isNaN(value.getTime()) ||
    value.getTime() === 0
  );
}
