//
// Submission-key reconciliation against canonical started events. Go's
// `context.Context` is dropped because the DAO layer is synchronous;
// `crypto/sha256` maps to `node:crypto` SHA-256.

import { createHash } from "node:crypto";
import {
  getRuntimeSubmission,
  RuntimeSubmissionConflictError,
} from "../session/runtime_submission.ts";
import { listSessionRunEvents } from "../session/session_events.ts";
import { type SessionRun } from "../session/run_store.ts";
import { getDurableRun } from "./run_queries.ts";

/**
 * Means a submission key was reused for a different request or admission
 * scope. Callers must not silently start another Run.
 */
export class IdempotencyKeyConflictError extends RuntimeSubmissionConflictError {
  override name = "IdempotencyKeyConflictError";
}

/**
 * Means a durable started event matched a submission key but its canonical Run
 * row is unavailable for reconciliation.
 */
export class IdempotencyRunMissingError extends Error {
  override name = "IdempotencyRunMissingError";
  constructor() {
    super("idempotency started event has no durable run");
  }
}

/**
 * Keeps a client/platform key out of durable event data while retaining a
 * stable equality token for reconciliation.
 */
export function idempotencyKeyFingerprint(key: string): string {
  const trimmed = key.trim();
  if (trimmed === "") return "";
  const digest = createHash("sha256").update(trimmed).digest("hex");
  return `sha256:${digest}`;
}

/**
 * Reconciles a submission key against canonical started events. It is
 * intentionally a read-only compatibility bridge until the Runtime-owned
 * submission table is migrated; callers must invoke it again after acquiring
 * their session/runtime admission locks.
 */
export function findIdempotentRun(
  sessionDir: string,
  sessionId: string,
  key: string,
  fingerprint: string,
  scope: string,
): SessionRun | null {
  const trimmedKey = key.trim();
  if (sessionDir === "" || sessionId === "" || trimmedKey === "") return null;
  if (scope === "") scope = "submit";
  const keyFingerprint = idempotencyKeyFingerprint(trimmedKey);
  const submission = getRuntimeSubmission(
    sessionDir,
    sessionId,
    scope,
    keyFingerprint,
  );
  if (submission !== null) {
    if (
      submission.requestFingerprint !== "" &&
      fingerprint !== "" &&
      submission.requestFingerprint !== fingerprint
    ) {
      throw new IdempotencyKeyConflictError();
    }
    const run = getDurableRun(sessionDir, submission.runId);
    if (run === null) throw new IdempotencyRunMissingError();
    return run;
  }
  // Named legacy bridge for Runs admitted before runtime_submissions. Remove
  // this event scan after all supported databases have crossed schema 33.
  const events = listSessionRunEvents(sessionDir, sessionId);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.eventType !== "started") continue;
    const data = asObject(event.data);
    if (data === undefined) continue;
    const idempotencyKey = str(data.idempotencyKey);
    const idempotencyKeyHash = str(data.idempotencyKeyHash);
    const idempotencyScope = str(data.idempotencyScope);
    const requestFingerprint = str(data.requestFingerprint);
    if (idempotencyKeyHash !== "") {
      if (idempotencyKeyHash !== keyFingerprint) continue;
    } else if (idempotencyKey !== trimmedKey) {
      continue;
    }
    if (idempotencyScope !== "" && idempotencyScope !== scope) {
      throw new IdempotencyKeyConflictError();
    }
    if (idempotencyScope === "" && scope !== "submit") {
      throw new IdempotencyKeyConflictError();
    }
    if (
      requestFingerprint !== "" &&
      fingerprint !== "" &&
      requestFingerprint !== fingerprint
    ) {
      throw new IdempotencyKeyConflictError();
    }
    const run = getDurableRun(sessionDir, event.runId);
    if (run === null) throw new IdempotencyRunMissingError();
    return run;
  }
  return null;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
