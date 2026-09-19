// Ported from internal/session/runtime_lease_status.go
//
// Read-only preflight over the leases a session directory currently records as
// active, used by destructive maintenance to refuse while another process may
// still hold an execution. It never migrates, repairs, or initializes the
// database it inspects.

import { RuntimeLeaseDAO } from "../dao/mod.ts";
import { openExistingSessionDBReadOnly } from "./root_db.ts";

/**
 * One session lease still recorded as active in a session database. It names
 * the process that holds it, so destructive maintenance can refuse while
 * another mothx process may still be executing a run there.
 */
export interface ActiveRuntimeLease {
  sessionId: string;
  ownerId: string;
  ownerPid: number;
  ownerKind: string;
  runId: string;
  purpose: string;
  expiresAt: Date;
}

/** Renders the holder in one line for an operator-facing refusal. */
export function describeActiveRuntimeLease(lease: ActiveRuntimeLease): string {
  let description =
    `session ${lease.sessionId} holds an active ${lease.purpose} lease owned by ${lease.ownerKind} (pid ${lease.ownerPid})`;
  if (lease.runId !== "") {
    description += `, run ${lease.runId}`;
  }
  const remaining = lease.expiresAt.getTime() - Date.now();
  if (remaining > 0) {
    description += `, still renewing (expires in ${
      formatDurationSeconds(remaining / 1000)
    })`;
  }
  return description;
}

function formatDurationSeconds(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return rest === 0 ? `${minutes}m0s` : `${minutes}m${rest}s`;
  const hours = Math.floor(minutes / 60);
  const restMin = minutes % 60;
  return `${hours}h${restMin}m${rest}s`;
}

/**
 * Reports leases still marked active in a session directory's database. A
 * directory with no database holds nothing and is not an error, so this is safe
 * to call before the first run or after a reset.
 *
 * The check is deliberately narrow: a lease exists only while a process is
 * admitted or executing a run, so an idle TUI, serve, or ACP process holding
 * the same directory open is not reported here.
 */
export function activeRuntimeLeases(
  sessionDir: string,
): ActiveRuntimeLease[] {
  const { db, ok } = openExistingSessionDBReadOnly(sessionDir);
  if (!ok || db === null) return [];
  try {
    const executor = db.db;
    if (executor === null) return [];
    const records = new RuntimeLeaseDAO(executor).listHeld(executor);
    return records.map((record) => ({
      sessionId: record.sessionId,
      ownerId: record.ownerId,
      ownerPid: record.ownerPid,
      ownerKind: record.ownerKind,
      runId: record.runId,
      purpose: record.purpose,
      expiresAt: new Date(record.expiresAt * 1000),
    }));
  } finally {
    db.close();
  }
}
