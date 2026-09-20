// Ported from internal/cron/cron.go and session_store.go.
//
// Package cron implements scheduled task management. Cron jobs are persisted in
// sessions.db and executed by spawning agents. This module ports the domain
// model, the persistence interface, and the session-scoping adapter; the
// scheduler itself (which binds to the durable Runtime) lands with backlog #26's
// `ExecutionRuntime`.

/** A persisted running claim may outlive the process that created it. */
export const runningLeaseTimeoutMs = 24 * 60 * 60 * 1000;

/** Represents a scheduled task. */
export interface CronJob {
  id?: string;
  sessionId?: string;
  name?: string; // Short description
  prompt?: string; // Task prompt for sub-agent
  schedule?: string; // @daily, @every 30m, 5-field cron, or empty for one-shot
  oneShot?: boolean; // If true, auto-disable after first run
  mode?: string; // "agent" or "yolo"
  workDir?: string;
  a2aTarget?: string; // A2A server URL (if set, send task via A2A protocol)
  a2aToken?: string; // Bearer token for A2A server
  enabled?: boolean;
  createdAt?: Date | null;
  lastRun?: Date | null;
  nextRun?: Date | null;
  runCount?: number;
  lastStatus?: string; // "success", "failed", "running"
  lastError?: string;
}

/** The interface for cron job persistence. */
export interface CronStore {
  list(): CronJob[];
  get(id: string): CronJob;
  create(job: CronJob): CronJob;
  update(job: CronJob): void;
  delete(id: string): void;
}

/** A store that can atomically claim a due job for execution. */
export interface DueJobClaimer {
  claimDue(id: string, now: Date): boolean;
}

let fallbackCronCounter = 0;

/** Generates a random cron job ID, falling back to a timestamped counter. */
export function newCronID(): string {
  const bytes = new Uint8Array(16);
  try {
    crypto.getRandomValues(bytes);
    return "cron-" + hex(bytes);
  } catch {
    fallbackCronCounter += 1;
    return `cron-${Date.now() * 1_000_000}-${fallbackCronCounter}`;
  }
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Reports whether a store can atomically claim a due job. */
export function asDueJobClaimer(store: CronStore): DueJobClaimer | null {
  const candidate = store as unknown as Partial<DueJobClaimer>;
  return typeof candidate.claimDue === "function"
    ? (store as unknown as DueJobClaimer)
    : null;
}
