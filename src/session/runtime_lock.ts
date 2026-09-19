// Ported from internal/session/runtime_lock.go
//
// The Session-wide runtime lease: a fenced, heartbeat-renewed SQLite row that
// gives one process authority over a Session's execution path. Ownership is
// decided only by the fenced `session_runtime_leases` owner/epoch/token CAS, so
// a transient renewal failure (a busy or unreachable database) is an
// availability problem to retry, never ownership loss.
//
// Deviations from Go, matching the synchronous DAO layer in this port:
// - `context.Context` is dropped; every DAO call is synchronous.
// - `<-chan struct{}` loss signals map to `AbortSignal`.
// - the per-lease goroutine + `time.Ticker` heartbeat maps to one
//   `setInterval` scheduler per session directory, unref'd so it never keeps
//   the process alive on its own.

import * as path from "@std/path";
import {
  isNoRows,
  RuntimeLeaseDAO,
  type RuntimeLeaseRecord,
} from "../dao/mod.ts";
import { BUSY_TIMEOUT_MS } from "../db/mod.ts";
import { CountedMutex, newLockRegistry } from "./lock_registry.ts";
import { openRootDB, rootDBPath } from "./root_db.ts";
import { nonTerminalSessionRunStatuses } from "./run_status.ts";
import { runtimeOwnerID } from "./runtime_identity.ts";
import { publishRuntimeLeaseNotification } from "./runtime_lease_bus.ts";

const runtimeLeaseTTL = 15; // seconds
const runtimeHeartbeatEveryMs = 3_000;
// Bounds how long one heartbeat tick keeps retrying a failed renewal before
// yielding to the next tick. Exhausting it is NOT ownership loss: a database
// timeout is retried on the following tick, and a lease is only ever marked
// lost when a renewal actually executes and the fenced CAS no longer matches.
const runtimeHeartbeatRetryMs = BUSY_TIMEOUT_MS + 2 * runtimeHeartbeatEveryMs;

/**
 * Heartbeat timing, exposed so tests can shorten the retry budget without
 * changing the production contract.
 */
export const runtimeHeartbeatTiming = {
  everyMs: runtimeHeartbeatEveryMs,
  retryBudgetMs: runtimeHeartbeatRetryMs,
};

/** Raised when a Session lease is already held by another process. */
export class RuntimeLeaseBusyError extends Error {
  override name = "RuntimeLeaseBusyError";
}
/** Raised when the fenced owner/epoch/token no longer matches this process. */
export class RuntimeLeaseLostError extends Error {
  override name = "RuntimeLeaseLostError";
}
/** Raised when explicit acquisition targets a Session that does not exist. */
export class RuntimeSessionNotFoundError extends Error {
  override name = "RuntimeSessionNotFoundError";
}
/** Raised when a Session already has an active durable Run. */
export class SessionRunActiveError extends Error {
  override name = "SessionRunActiveError";
}
/** Raised when a Session has an active durable Run requiring reconciliation. */
export class SessionRecoveryRequiredError extends Error {
  override name = "SessionRecoveryRequiredError";
}
/** Raised when recovery is requested for a Session with no active durable Run. */
export class SessionRecoveryNotNeededError extends Error {
  override name = "SessionRecoveryNotNeededError";
}
/** Raised when the lease's bound Run does not match the expected Run. */
export class RuntimeLeaseRunMismatchError extends Error {
  override name = "RuntimeLeaseRunMismatchError";
}
/** Raised when the lease purpose does not allow the requested operation. */
export class RuntimeLeasePurposeError extends Error {
  override name = "RuntimeLeasePurposeError";
}

/** Describes why a process owns the Session-wide lease. */
export type RuntimeLeasePurpose =
  | "run"
  | "admission"
  | "execution"
  | "recovery"
  | "mutation"
  | "fork";

const runtimeLeasePurposeLegacyRun = "run";
const runtimeLeasePurposeAdmission = "admission";
const runtimeLeasePurposeExecution = "execution";
const runtimeLeasePurposeRecovery = "recovery";
const runtimeLeasePurposeMutation = "mutation";
const runtimeLeasePurposeFork = "fork";

const runtimeLocks = newLockRegistry();
const sessionDataLocks = newLockRegistry();

const activeRuntimeLeases = new Map<string, RuntimeLease>();

function runtimeLockKey(sessionDir: string, sessionId: string): string {
  const clean = path.resolve(sessionDir);
  return `${clean}\x00${sessionId}`;
}

class RuntimeLease {
  sessionDir: string;
  sessionId: string;
  ownerID: string;
  purpose: string;
  runId: string;
  tokenHash: string;
  epoch: number;
  refs = 1;
  released = false;
  readonly stop = new AbortController();
  readonly lost = new AbortController();

  constructor(fields: {
    sessionDir: string;
    sessionId: string;
    ownerID: string;
    purpose: string;
    runId: string;
    tokenHash: string;
    epoch: number;
  }) {
    this.sessionDir = fields.sessionDir;
    this.sessionId = fields.sessionId;
    this.ownerID = fields.ownerID;
    this.purpose = fields.purpose;
    this.runId = fields.runId;
    this.tokenHash = fields.tokenHash;
    this.epoch = fields.epoch;
  }

  /** Drops one reference, releasing the durable lease when the last drops. */
  release(): void {
    if (this.released) return;
    if (this.refs > 1) {
      this.refs--;
      return;
    }
    this.refs = 0;
    this.released = true;
    this.stop.abort();
    forgetRuntimeLease(this);
    // A voluntary release ends this process's authority just as decisively as
    // heartbeat loss.
    this.lost.abort();
    const db = safeOpenRootDB(this.sessionDir);
    if (db === null) return;
    // Keep a released tombstone so a delayed write from an old owner is
    // distinguishable from a legacy cold write after the new owner released.
    const count = new RuntimeLeaseDAO(db.db).release({
      sessionId: this.sessionId,
      ownerId: this.ownerID,
      epoch: this.epoch,
      tokenHash: this.tokenHash,
      ownerPid: 0,
      ownerKind: "",
      runId: "",
      purpose: "",
      state: "",
      acquiredAt: 0,
      heartbeatAt: 0,
      expiresAt: 0,
      updatedAt: 0,
    });
    if (count === 1) {
      publishRuntimeLeaseNotification({
        type: "released",
        sessionId: this.sessionId,
        origin: this.purpose,
        ownerInstanceId: this.ownerID,
        epoch: this.epoch,
      });
    }
  }
}

function safeOpenRootDB(sessionDir: string) {
  try {
    return openRootDB(sessionDir);
  } catch {
    return null;
  }
}

function rememberRuntimeLease(lease: RuntimeLease): void {
  activeRuntimeLeases.set(
    runtimeLockKey(lease.sessionDir, lease.sessionId),
    lease,
  );
  ensureLeaseHeartbeatScheduler(leaseDirKey(lease.sessionDir));
}

function forgetRuntimeLease(lease: RuntimeLease): void {
  const key = runtimeLockKey(lease.sessionDir, lease.sessionId);
  if (activeRuntimeLeases.get(key) === lease) activeRuntimeLeases.delete(key);
}

/**
 * Returns the loss signal for the current process lease. It is intentionally
 * read-only; callers use it to cancel work while every durable write still
 * performs its own epoch/token fence check.
 */
export function runtimeLeaseLost(
  sessionDir: string,
  sessionId: string,
): AbortSignal | undefined {
  const lease = activeRuntimeLeases.get(runtimeLockKey(sessionDir, sessionId));
  return lease?.lost.signal;
}

function newLeaseTokenHash(): string {
  // Go stores sha256(token); the token itself is never reused, so the fenced
  // identity only needs an opaque, unpredictable-per-acquisition value.
  try {
    const token = new Uint8Array(32);
    crypto.getRandomValues(token);
    return toHex(token);
  } catch {
    return `fallback-${Date.now()}`;
  }
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function sqliteNow(tx: Parameters<RuntimeLeaseDAO["now"]>[0]): number {
  return new RuntimeLeaseDAO(null).now(tx);
}

type AcquireMode = "legacy" | "noActiveRun" | "recovery";

interface RuntimeLeaseAcquireOptions {
  purpose: RuntimeLeasePurpose;
  runId?: string;
  mode?: AcquireMode;
  allowMissingSession?: boolean;
}

function acquireRuntimeLeaseWithOptions(
  sessionDir: string,
  sessionId: string,
  options: RuntimeLeaseAcquireOptions,
): RuntimeLease | null {
  if (sessionId === "") throw new RuntimeLeaseBusyError("empty session id");
  if (sessionDir === "") {
    // Test and embedded in-memory adapters may intentionally omit a session
    // root. Production adapters resolve Settings.GetSessionDir first.
    if (options.allowMissingSession) return null;
    throw new Error("session runtime directory is required");
  }
  const db = openRootDB(sessionDir);
  const mode = options.mode ?? "legacy";
  const runId = options.runId ?? "";
  const acquired = db.runInTx((tx) => {
    const now = sqliteNow(tx);
    const dao = new RuntimeLeaseDAO(null);
    const sessionExists = dao.sessionExists(tx, sessionId);
    if (!sessionExists) {
      if (options.allowMissingSession) return null;
      throw new RuntimeSessionNotFoundError(sessionId);
    }
    const expires = now + runtimeLeaseTTL;
    const ownerID = runtimeOwnerID();
    const tokenHash = newLeaseTokenHash();
    const purpose = options.purpose;
    let epoch = 1;

    let current: RuntimeLeaseRecord | null = null;
    try {
      current = dao.find(tx, sessionId);
    } catch (err) {
      if (!isNoRows(err)) throw err;
    }
    if (
      current !== null && current.state === "active" && current.expiresAt > now
    ) {
      throw new RuntimeLeaseBusyError(sessionId);
    }
    if (mode !== "legacy") {
      const activeRunIDs = dao.activeRunIds(
        tx,
        sessionId,
        nonTerminalSessionRunStatuses(),
      );
      if (mode === "noActiveRun") {
        if (activeRunIDs.length !== 0) {
          if (purpose === runtimeLeasePurposeAdmission) {
            throw new SessionRecoveryRequiredError(sessionId);
          }
          throw new SessionRunActiveError(sessionId);
        }
      } else if (mode === "recovery") {
        if (activeRunIDs.length === 0) {
          throw new SessionRecoveryNotNeededError(sessionId);
        }
        if (activeRunIDs.length !== 1 || activeRunIDs[0] !== runId) {
          throw new RuntimeLeaseRunMismatchError(sessionId);
        }
      }
    }

    const lease = new RuntimeLease({
      sessionDir,
      sessionId,
      ownerID,
      purpose,
      runId,
      tokenHash,
      epoch: 1,
    });

    if (current === null) {
      dao.insert(tx, {
        sessionId,
        ownerId: ownerID,
        ownerPid: Deno.pid,
        ownerKind: "process",
        tokenHash,
        epoch,
        runId,
        purpose,
        state: "active",
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: expires,
        updatedAt: now,
      });
    } else {
      epoch = current.epoch + 1;
      lease.epoch = epoch;
      const count = dao.acquire(
        tx,
        {
          sessionId,
          ownerId: ownerID,
          ownerPid: Deno.pid,
          ownerKind: "process",
          tokenHash,
          epoch,
          runId,
          purpose,
          state: "active",
          acquiredAt: now,
          heartbeatAt: now,
          expiresAt: expires,
          updatedAt: now,
        },
        current.epoch,
        now,
      );
      if (count !== 1) throw new RuntimeLeaseBusyError(sessionId);
    }
    return { lease: lease, expires };
  });
  if (acquired === null) return null;
  const { lease, expires } = acquired;
  rememberRuntimeLease(lease);
  publishRuntimeLeaseNotification({
    type: "acquired",
    sessionId: lease.sessionId,
    origin: lease.purpose,
    ownerInstanceId: lease.ownerID,
    epoch: lease.epoch,
    expiresAt: expires,
  });
  return lease;
}

function activeSessionRunIdsTx(
  tx: Parameters<RuntimeLeaseDAO["activeRunIds"]>[0],
  sessionId: string,
): string[] {
  return new RuntimeLeaseDAO(null).activeRunIds(
    tx,
    sessionId,
    nonTerminalSessionRunStatuses(),
  );
}

/**
 * Normalizes a session directory the same way runtimeLockKey does so every
 * spelling of one directory shares a single heartbeat scheduler.
 */
export function leaseDirKey(sessionDir: string): string {
  return path.resolve(sessionDir);
}

/** One heartbeat loop per canonical session directory. */
export class LeaseHeartbeatScheduler {
  dirKey: string;
  stopped = false;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(dirKey: string) {
    this.dirKey = dirKey;
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      const leases = snapshotRuntimeLeasesForDir(this.dirKey);
      if (leases.length === 0) {
        if (this.retire()) return;
        return;
      }
      void this.renew(leases);
    }, runtimeHeartbeatTiming.everyMs);
    Deno.unrefTimer(this.#timer);
  }

  /**
   * Unregisters the scheduler once no lease remains for its directory and
   * reports whether this scheduler was retired and must stop.
   */
  retire(): boolean {
    if (leaseHeartbeatSchedulers.get(this.dirKey) !== this) return true;
    if (snapshotRuntimeLeasesForDir(this.dirKey).length !== 0) return false;
    leaseHeartbeatSchedulers.delete(this.dirKey);
    this.stop();
    return true;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Batch-renews one snapshot of leases. A transient SQLite failure is retried
   * within the retry budget and, if still failing, left for the next tick.
   * Only a renewal that executes and reports zero affected rows is loss.
   */
  async renew(leases: RuntimeLease[]): Promise<void> {
    const deadline = Date.now() + runtimeHeartbeatTiming.retryBudgetMs;
    let current = leases;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      let results: Map<string, number> | null = null;
      try {
        results = renewLeaseBatchOnce(this.dirKey, current);
      } catch {
        results = null;
      }
      if (results !== null) {
        for (const lease of current) {
          if (results.get(lease.sessionId) !== 1) {
            markRuntimeLeaseLost(lease, "renewal fenced out by another owner");
          }
        }
        return;
      }
      await delay(200);
      if (this.stopped) return;
      const refreshed = snapshotRuntimeLeasesForDir(this.dirKey);
      if (refreshed.length === 0) return;
      current = refreshed;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Registry of live heartbeat schedulers, keyed by canonical session dir. */
export const leaseHeartbeatSchedulers = new Map<
  string,
  LeaseHeartbeatScheduler
>();

function ensureLeaseHeartbeatScheduler(dirKey: string): void {
  if (leaseHeartbeatSchedulers.get(dirKey) !== undefined) return;
  const scheduler = new LeaseHeartbeatScheduler(dirKey);
  leaseHeartbeatSchedulers.set(dirKey, scheduler);
  scheduler.start();
}

/** Returns a stable, session-id ordered snapshot of leases for a directory. */
export function snapshotRuntimeLeasesForDir(dirKey: string): RuntimeLease[] {
  const leases: RuntimeLease[] = [];
  for (const lease of activeRuntimeLeases.values()) {
    if (leaseDirKey(lease.sessionDir) === dirKey) leases.push(lease);
  }
  leases.sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));
  return leases;
}

function renewLeaseBatchOnce(
  sessionDir: string,
  leases: RuntimeLease[],
): Map<string, number> {
  const db = openRootDB(sessionDir);
  return db.runInTx((tx) => {
    const records: RuntimeLeaseRecord[] = leases.map((lease) => ({
      sessionId: lease.sessionId,
      ownerId: lease.ownerID,
      epoch: lease.epoch,
      tokenHash: lease.tokenHash,
      ownerPid: 0,
      ownerKind: "",
      runId: "",
      purpose: "",
      state: "",
      acquiredAt: 0,
      heartbeatAt: 0,
      expiresAt: 0,
      updatedAt: 0,
    }));
    return new RuntimeLeaseDAO(null).renewBatch(tx, records, runtimeLeaseTTL);
  });
}

function markRuntimeLeaseLost(lease: RuntimeLease, reason: string): void {
  if (lease.released) return;
  lease.released = true;
  lease.refs = 0;
  const { purpose, ownerID, epoch, sessionId } = lease;
  console.error(
    `[session] runtime lease lost for ${sessionId} (owner=${ownerID} epoch=${epoch}): ${reason}`,
  );
  forgetRuntimeLease(lease);
  lease.lost.abort();
  publishRuntimeLeaseNotification({
    type: "lost",
    sessionId,
    origin: purpose,
    ownerInstanceId: ownerID,
    epoch,
  });
}

/**
 * Transitions the caller's admission/legacy lease to an execution lease in the
 * same transaction that creates the durable Run. A missing lease row remains a
 * temporary compatibility path for embedded stores; once a row exists, exact
 * owner/token/epoch fencing is mandatory.
 */
export function bindRuntimeLeaseToRunTx(
  tx: Parameters<RuntimeLeaseDAO["bind"]>[0],
  sessionDir: string,
  sessionId: string,
  runId: string,
): RuntimeLease | null {
  if (tx === undefined || sessionId === "" || runId === "") {
    throw new Error(
      "runtime lease binding requires transaction, session ID, and run ID",
    );
  }
  const lease = activeRuntimeLeases.get(runtimeLockKey(sessionDir, sessionId));
  if (lease === undefined) {
    const exists = new RuntimeLeaseDAO(null).exists(tx, sessionId);
    if (!exists) return null;
    throw new RuntimeLeaseLostError(sessionId);
  }
  if (
    ![
      runtimeLeasePurposeAdmission,
      runtimeLeasePurposeLegacyRun,
      runtimeLeasePurposeExecution,
      runtimeLeasePurposeRecovery,
    ].includes(lease.purpose)
  ) {
    throw new RuntimeLeasePurposeError(lease.purpose);
  }
  if (lease.runId !== "" && lease.runId !== runId) {
    throw new RuntimeLeaseRunMismatchError(runId);
  }
  const count = new RuntimeLeaseDAO(null).bind(
    tx,
    sessionId,
    lease.ownerID,
    lease.epoch,
    lease.tokenHash,
    runId,
    [
      runtimeLeasePurposeAdmission,
      runtimeLeasePurposeLegacyRun,
      runtimeLeasePurposeExecution,
      runtimeLeasePurposeRecovery,
    ],
  );
  if (count !== 1) throw new RuntimeLeaseLostError(sessionId);
  return lease;
}

/** Transitions a process-local lease handle in memory after a committed bind. */
export function markRuntimeLeaseBound(
  lease: RuntimeLease | null,
  runId: string,
): void {
  if (lease === null) return;
  lease.runId = runId;
  lease.purpose = runtimeLeasePurposeExecution;
}

/**
 * Promotes a recovery/legacy lease to execution only while the expected Run is
 * still the Session's sole non-terminal Run.
 */
export function bindRuntimeLeaseToExistingRun(
  sessionDir: string,
  sessionId: string,
  runId: string,
): RuntimeLeaseBinding {
  if (sessionId.trim() === "" || runId.trim() === "") {
    throw new RuntimeLeaseRunMismatchError(runId);
  }
  const db = openRootDB(sessionDir);
  db.runInTx((tx) => {
    validateRuntimeLeaseTx(tx, sessionDir, sessionId);
    const activeRunIDs = activeSessionRunIdsTx(tx, sessionId);
    if (activeRunIDs.length !== 1 || activeRunIDs[0] !== runId) {
      throw new RuntimeLeaseRunMismatchError(runId);
    }
    const lease = bindRuntimeLeaseToRunTx(tx, sessionDir, sessionId, runId);
    if (lease === null) return;
    markRuntimeLeaseBound(lease, runId);
  });
  const binding = currentRuntimeLeaseBinding(sessionDir, sessionId);
  if (binding === null) throw new RuntimeLeaseLostError(sessionId);
  return binding;
}

/**
 * Fences transcript writes from a stale process. A session with no lease is a
 * cold/manual mutation; once a lease row exists, only the current owner and
 * epoch may append entries.
 *
 * Coverage policy: execution-path writes run this fence inside their
 * transaction. Short administrative writes intentionally skip it.
 */
export function validateRuntimeLeaseTx(
  tx: Parameters<RuntimeLeaseDAO["find"]>[0],
  sessionDir: string,
  sessionId: string,
): void {
  const dao = new RuntimeLeaseDAO(null);
  let record: RuntimeLeaseRecord;
  try {
    record = dao.find(tx, sessionId);
  } catch (err) {
    if (isNoRows(err)) return;
    throw err;
  }
  const lease = activeRuntimeLeases.get(runtimeLockKey(sessionDir, sessionId));
  // Ownership is proven by the fenced identity (state/owner/epoch/token), not
  // by wall-clock freshness.
  if (
    record.state !== "active" ||
    lease === undefined ||
    lease.ownerID !== record.ownerId ||
    lease.tokenHash !== record.tokenHash ||
    lease.epoch !== record.epoch
  ) {
    throw new RuntimeLeaseLostError(sessionId);
  }
}

/**
 * Verifies that the current process owns the exact purpose/run binding
 * required by a control operation.
 */
export function validateRuntimeLeaseBindingTx(
  tx: Parameters<RuntimeLeaseDAO["binding"]>[0],
  sessionDir: string,
  sessionId: string,
  runId: string,
  purpose: RuntimeLeasePurpose,
): RuntimeLeaseBinding {
  validateRuntimeLeaseTx(tx, sessionDir, sessionId);
  const binding = currentRuntimeLeaseBinding(sessionDir, sessionId);
  if (binding === null) throw new RuntimeLeaseLostError(sessionId);
  let record: RuntimeLeaseRecord;
  try {
    record = new RuntimeLeaseDAO(null).binding(
      tx,
      sessionId,
      binding.ownerInstanceId,
      binding.epoch,
      binding.tokenHash,
    );
  } catch (err) {
    if (isNoRows(err)) throw new RuntimeLeaseLostError(sessionId);
    throw err;
  }
  if (
    (record.purpose as RuntimeLeasePurpose) !== purpose ||
    binding.purpose !== purpose
  ) {
    throw new RuntimeLeasePurposeError(purpose);
  }
  if (record.runId !== runId || binding.runId !== runId) {
    throw new RuntimeLeaseRunMismatchError(runId);
  }
  return binding;
}

/**
 * Rechecks the process-owned lease binding in a fresh SQLite transaction. It is
 * the final Runtime fence before a side effect.
 */
export function validateRuntimeLease(
  sessionDir: string,
  sessionId: string,
  runId: string,
  purpose: RuntimeLeasePurpose,
): void {
  if (sessionDir.trim() === "") throw new RuntimeLeaseLostError(sessionId);
  const db = openRootDB(sessionDir);
  db.runInTx((tx) => {
    validateRuntimeLeaseBindingTx(tx, sessionDir, sessionId, runId, purpose);
    const dao = new RuntimeLeaseDAO(null);
    let status: string;
    try {
      status = dao.runStatus(tx, runId, sessionId);
    } catch (err) {
      if (isNoRows(err)) throw new RuntimeLeaseRunMismatchError(runId);
      throw err;
    }
    if (isTerminalSessionRunStatus(status)) {
      throw new RuntimeLeaseLostError(sessionId);
    }
  });
}

function isTerminalSessionRunStatus(status: string): boolean {
  return terminalStatusSet.has(status.toLowerCase().trim());
}

const terminalStatusSet = new Set([
  "completed",
  "incomplete",
  "expired",
  "failed",
  "cancelled",
  "canceled",
  "timed_out",
]);

/** The Runtime-owned identity of an acquired Session lease. */
export interface RuntimeLeaseBinding {
  databaseIdentity: string;
  sessionId: string;
  runId: string;
  ownerInstanceId: string;
  tokenHash: string;
  epoch: number;
  purpose: RuntimeLeasePurpose;
}

/**
 * Returns the lease identity held by this process for registration and
 * diagnostics only; durable control operations must still revalidate the row.
 */
export function currentRuntimeLeaseBinding(
  sessionDir: string,
  sessionId: string,
): RuntimeLeaseBinding | null {
  const lease = activeRuntimeLeases.get(runtimeLockKey(sessionDir, sessionId));
  if (lease === undefined) return null;
  return {
    databaseIdentity: runtimeDatabaseIdentity(lease.sessionDir),
    sessionId: lease.sessionId,
    runId: lease.runId,
    ownerInstanceId: lease.ownerID,
    tokenHash: lease.tokenHash,
    epoch: lease.epoch,
    purpose: lease.purpose as RuntimeLeasePurpose,
  };
}

/**
 * Adds a Runtime-owned reference to the current execution lease. The
 * caller-owned guard may be released independently; the durable lease remains
 * active until the returned release function is called.
 */
export function retainRuntimeLease(
  sessionDir: string,
  sessionId: string,
  runId: string,
): {
  binding: RuntimeLeaseBinding | null;
  release: (() => void) | null;
  retained: boolean;
} {
  if (sessionDir.trim() === "") {
    return { binding: null, release: null, retained: false };
  }
  const lease = activeRuntimeLeases.get(runtimeLockKey(sessionDir, sessionId));
  if (lease === undefined) {
    return { binding: null, release: null, retained: false };
  }
  if (lease.released) throw new RuntimeLeaseLostError(sessionId);
  if (lease.purpose !== runtimeLeasePurposeExecution) {
    throw new RuntimeLeasePurposeError(lease.purpose);
  }
  if (lease.runId !== runId) throw new RuntimeLeaseRunMismatchError(runId);
  lease.refs++;
  const binding: RuntimeLeaseBinding = {
    databaseIdentity: runtimeDatabaseIdentity(lease.sessionDir),
    sessionId: lease.sessionId,
    runId: lease.runId,
    ownerInstanceId: lease.ownerID,
    tokenHash: lease.tokenHash,
    epoch: lease.epoch,
    purpose: lease.purpose as RuntimeLeasePurpose,
  };
  let released = false;
  return {
    binding,
    release: () => {
      if (released) return;
      released = true;
      lease.release();
    },
    retained: true,
  };
}

/** Owns both the process-local mutex and the durable SQLite lease. */
export class RuntimeLeaseGuard {
  #lease: RuntimeLease | null;
  #unlock: (() => void) | null;
  #released = false;

  constructor(lease: RuntimeLease | null, unlock: (() => void) | null) {
    this.#lease = lease;
    this.#unlock = unlock;
  }

  /** Relinquishes the durable lease and then the process-local mutex. */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#lease?.release();
    this.#unlock?.();
  }

  /** Returns when the durable lease can no longer be renewed. */
  lost(): AbortSignal | undefined {
    return this.#lease?.lost.signal;
  }

  /** Returns the exact identity acquired by this process. */
  binding(): RuntimeLeaseBinding {
    const lease = this.#lease;
    if (lease === null) return emptyBinding();
    return {
      databaseIdentity: runtimeDatabaseIdentity(lease.sessionDir),
      sessionId: lease.sessionId,
      runId: lease.runId,
      ownerInstanceId: lease.ownerID,
      tokenHash: lease.tokenHash,
      epoch: lease.epoch,
      purpose: lease.purpose as RuntimeLeasePurpose,
    };
  }
}

function emptyBinding(): RuntimeLeaseBinding {
  return {
    databaseIdentity: "",
    sessionId: "",
    runId: "",
    ownerInstanceId: "",
    tokenHash: "",
    epoch: 0,
    purpose: runtimeLeasePurposeLegacyRun,
  };
}

/** Owns an ordered set of Session leases acquired for one mutation. */
export class RuntimeLeaseGroup {
  #guards: RuntimeLeaseGuard[];
  #released = false;

  constructor(guards: RuntimeLeaseGuard[]) {
    this.#guards = guards;
  }

  /** Returns the mutation guard this group holds for sessionId. */
  guard(sessionId: string): RuntimeLeaseGuard | null {
    for (const guard of this.#guards) {
      if (guard !== null && guard.binding().sessionId === sessionId) {
        return guard;
      }
    }
    return null;
  }

  /** Relinquishes grouped leases in reverse acquisition order. */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    for (let i = this.#guards.length - 1; i >= 0; i--) {
      this.#guards[i].release();
    }
  }
}

function runtimeDatabaseIdentity(sessionDir: string): string {
  return path.resolve(path.normalize(rootDBPath(sessionDir)));
}

/** Returns the normalized SQLite identity used to scope process registries. */
export function runtimeDatabaseIdentityFor(sessionDir: string): string {
  return runtimeDatabaseIdentity(sessionDir);
}

function acquireRuntimeLeaseGuard(
  sessionDir: string,
  sessionId: string,
  options: RuntimeLeaseAcquireOptions,
): RuntimeLeaseGuard {
  if (sessionId.trim() === "") throw new RuntimeLeaseBusyError("empty");
  const key = runtimeLockKey(sessionDir, sessionId);
  const lock: CountedMutex = runtimeLocks.acquire(key);
  if (!lock.tryLock()) {
    runtimeLocks.drop(key, lock);
    throw new RuntimeLeaseBusyError(sessionId);
  }
  let lease: RuntimeLease | null;
  try {
    lease = acquireRuntimeLeaseWithOptions(sessionDir, sessionId, options);
  } catch (err) {
    lock.unlock();
    runtimeLocks.drop(key, lock);
    throw err;
  }
  return new RuntimeLeaseGuard(lease, () => {
    lock.unlock();
    runtimeLocks.drop(key, lock);
  });
}

/**
 * Reserves an existing idle Session for a new Run. The durable admission
 * transaction must subsequently bind the new run ID and transition this lease
 * to purpose=execution.
 */
export function acquireExecutionAdmission(
  sessionDir: string,
  sessionId: string,
): RuntimeLeaseGuard {
  return acquireRuntimeLeaseGuard(sessionDir, sessionId, {
    purpose: runtimeLeasePurposeAdmission,
    mode: "noActiveRun",
    allowMissingSession: sessionDir.trim() === "",
  });
}

/** Reserves an idle Session for a short non-execution change. */
export function acquireMutation(
  sessionDir: string,
  sessionId: string,
): RuntimeLeaseGuard {
  return acquireRuntimeLeaseGuard(sessionDir, sessionId, {
    purpose: runtimeLeasePurposeMutation,
    mode: "noActiveRun",
    allowMissingSession: sessionDir.trim() === "",
  });
}

/**
 * Reserves multiple idle Sessions in stable order so a cross-Session mutation
 * cannot deadlock another caller taking the same set.
 */
export function acquireMutations(
  sessionDir: string,
  sessionIDs: string[],
): RuntimeLeaseGroup {
  const ids = [...sessionIDs].sort();
  const ordered: string[] = [];
  for (const id of ids) {
    if (
      id === "" || (ordered.length > 0 && ordered[ordered.length - 1] === id)
    ) {
      continue;
    }
    ordered.push(id);
  }
  const guards: RuntimeLeaseGuard[] = [];
  for (const id of ordered) {
    try {
      guards.push(acquireMutation(sessionDir, id));
    } catch (err) {
      new RuntimeLeaseGroup(guards).release();
      throw err;
    }
  }
  return new RuntimeLeaseGroup(guards);
}

/** Reserves an idle source Session while a child snapshot is made. */
export function acquireFork(
  sessionDir: string,
  sessionId: string,
): RuntimeLeaseGuard {
  return acquireRuntimeLeaseGuard(sessionDir, sessionId, {
    purpose: runtimeLeasePurposeFork,
    mode: "noActiveRun",
  });
}

/** Claims an unowned or expired active Run for fenced recovery. */
export function acquireRecovery(
  sessionDir: string,
  sessionId: string,
  expectedRunID: string,
): RuntimeLeaseGuard {
  if (expectedRunID.trim() === "") {
    throw new RuntimeLeaseRunMismatchError(expectedRunID);
  }
  return acquireRuntimeLeaseGuard(sessionDir, sessionId, {
    purpose: runtimeLeasePurposeRecovery,
    runId: expectedRunID,
    mode: "recovery",
  });
}

/**
 * Serializes one session across all processes. The process-local mutex remains
 * a fast path, while the SQLite lease is the authority.
 */
export function tryLockRuntime(
  sessionDir: string,
  sessionId: string,
): [release: () => void, ok: boolean] {
  return tryLockRuntimePurpose(
    sessionDir,
    sessionId,
    runtimeLeasePurposeLegacyRun,
  );
}

function tryLockRuntimePurpose(
  sessionDir: string,
  sessionId: string,
  purpose: string,
): [release: () => void, ok: boolean] {
  let guard: RuntimeLeaseGuard;
  try {
    guard = acquireRuntimeLeaseGuard(sessionDir, sessionId, {
      purpose: purpose as RuntimeLeasePurpose,
      mode: "legacy",
      allowMissingSession: true,
    });
  } catch {
    return [() => {}, false];
  }
  return [() => guard.release(), true];
}

/**
 * Waits for the single-session lease. It retries tryLockRuntime so no database
 * transaction remains open while an execution is running.
 */
export async function lockRuntime(
  sessionDir: string,
  sessionId: string,
): Promise<() => void> {
  for (;;) {
    const [release, ok] = tryLockRuntime(sessionDir, sessionId);
    if (ok) return release;
    await delay(50);
  }
}

/** Serializes short persistence mutations inside one process. */
export async function lockSessionData(
  sessionDir: string,
  sessionId: string,
): Promise<() => void> {
  if (sessionId === "") return () => {};
  const key = runtimeLockKey(sessionDir, sessionId);
  const lock = sessionDataLocks.acquire(key);
  await lock.lock();
  return () => {
    lock.unlock();
    sessionDataLocks.drop(key, lock);
  };
}

/**
 * Acquires multiple session leases in sorted order. Different sessions remain
 * independently concurrent; ordering only applies to an operation that
 * explicitly spans more than one session.
 */
export function tryLockRuntimes(
  sessionDir: string,
  sessionIDs: string[],
): [release: () => void, ok: boolean] {
  const ids = [...sessionIDs].sort();
  const ordered: string[] = [];
  for (const id of ids) {
    if (
      id === "" || (ordered.length > 0 && ordered[ordered.length - 1] === id)
    ) {
      continue;
    }
    ordered.push(id);
  }
  const releases: Array<() => void> = [];
  for (const id of ordered) {
    const [release, ok] = tryLockRuntime(sessionDir, id);
    if (!ok) {
      for (let i = releases.length - 1; i >= 0; i--) releases[i]();
      return [() => {}, false];
    }
    releases.push(release);
  }
  return [
    () => {
      for (let i = releases.length - 1; i >= 0; i--) releases[i]();
    },
    true,
  ];
}
