//
// Deviation: `context.Context` is dropped (the DAO layer is synchronous) and
// `time.Time` maps to `Date`.

import { ResponseDAO, RunDAO, RuntimeLeaseDAO, type Tx } from "../dao/mod.ts";
import { openRootDB } from "./root_db.ts";
import { type ResponseRun, responseRunFromRecord } from "./response_store.ts";
import {
  readSessionRunRecoveryTx,
  type SessionRunRecovery,
} from "./run_recovery.ts";
import { nonTerminalSessionRunStatuses } from "./run_status.ts";
import { type SessionRun, sessionRunFromRecord } from "./run_store.ts";
import { runtimeDatabaseIdentityFor } from "./runtime_lock.ts";
import { type RuntimeLeasePurpose } from "./runtime_lock.ts";

/**
 * An immutable database view of one Session lease. `tokenHash` is an internal
 * identity component used only for matching a Runtime-owned binding; callers
 * must never accept it back as authorization.
 */
export interface RuntimeLeaseSnapshot {
  sessionId: string;
  ownerInstanceId: string;
  ownerPid: number;
  ownerKind: string;
  tokenHash: string;
  epoch: number;
  runId: string;
  purpose: RuntimeLeasePurpose;
  state: string;
  acquiredAt: Date;
  heartbeatAt: Date;
  expiresAt: Date;
  updatedAt: Date;
  valid: boolean;
}

/**
 * The durable Run and lease rows observed from one SQLite read transaction and
 * one SQLite clock sample. `activeRuns` normally contains at most one row;
 * retaining the slice lets Runtime surface corrupted or legacy databases with
 * multiple active rows as inconsistent.
 */
export interface SessionExecutionFacts {
  databaseIdentity: string;
  sessionId: string;
  sessionExists: boolean;
  databaseNow: Date;
  activeRuns: SessionRun[];
  lease: RuntimeLeaseSnapshot | null;
  recovery: SessionRunRecovery | null;
  remoteRun: ResponseRun | null;
}

/**
 * Reads the durable execution facts for one Session from a single transaction.
 * It deliberately does not consult process-local runtime state.
 */
export function readSessionExecutionFacts(
  sessionDir: string,
  sessionId: string,
): SessionExecutionFacts {
  const trimmed = sessionId.trim();
  const facts: SessionExecutionFacts = {
    databaseIdentity: runtimeDatabaseIdentityFor(sessionDir),
    sessionId: trimmed,
    sessionExists: false,
    databaseNow: new Date(0),
    activeRuns: [],
    lease: null,
    recovery: null,
    remoteRun: null,
  };
  if (trimmed === "") {
    throw new Error("session ID is required");
  }
  const db = openRootDB(sessionDir);
  return db.runInTx((tx) => {
    const leaseDAO = new RuntimeLeaseDAO(null);
    const now = leaseDAO.now(tx);
    facts.databaseNow = new Date(now * 1000);
    facts.sessionExists = leaseDAO.sessionExists(tx, trimmed);

    const records = new RunDAO(null).orphanedFrom(
      tx,
      nonTerminalSessionRunStatuses(),
    );
    for (const record of records) {
      if (record.sessionId === trimmed) {
        facts.activeRuns.push(sessionRunFromRecord(record));
      }
    }
    if (facts.activeRuns.length === 1) {
      const activeRunId = facts.activeRuns[0].id;
      facts.recovery = readSessionRunRecoveryTx(tx, activeRunId) ?? null;
      facts.remoteRun =
        readLinkedResponseRunTx(tx, trimmed, activeRunId) ?? null;
    }

    const record = leaseDAO.find(tx, trimmed);
    if (record !== undefined) {
      facts.lease = {
        sessionId: record.sessionId,
        ownerInstanceId: record.ownerId,
        ownerPid: record.ownerPid,
        ownerKind: record.ownerKind,
        tokenHash: record.tokenHash,
        epoch: record.epoch,
        runId: record.runId,
        purpose: record.purpose as RuntimeLeasePurpose,
        state: record.state,
        acquiredAt: new Date(record.acquiredAt * 1000),
        heartbeatAt: new Date(record.heartbeatAt * 1000),
        expiresAt: new Date(record.expiresAt * 1000),
        updatedAt: new Date(record.updatedAt * 1000),
        valid: record.state === "active" && record.expiresAt > now,
      };
    }
    return facts;
  });
}

function readLinkedResponseRunTx(
  tx: Tx,
  sessionId: string,
  runId: string,
): ResponseRun | undefined {
  const record = new ResponseDAO(null).linkedRun(tx, sessionId, runId);
  return record === undefined ? undefined : responseRunFromRecord(record);
}
