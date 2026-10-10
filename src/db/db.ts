//
// Package db owns the process-wide SQLite connection lifecycle.
//
// Database access outside schema migrations goes through this package and a
// DAO. Only this package may open, configure, cache, or close the underlying
// SQLite connection; table operations belong to src/dao.

import { runtime } from "../platform/runtime.ts";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import * as path from "../compat/path.ts";
import {
  isSQLiteBusy,
  isSQLiteReadOnly,
  recordBeginWait,
  recordBusyRetryHit,
  recordBusyRetryWait,
  sleepSync,
} from "./busy.ts";
import { recordIndexRepair } from "./repair.ts";
import {
  isSchemaIncompatible,
  type MigrationRecovery,
  recordMigrationRecovery,
  recoverFromMigrationFailure,
} from "./recovery.ts";
import { isAbortError } from "../util/errors.ts";

/**
 * Initializes or validates a database. It is intentionally kept compatible with
 * the existing session migration implementation; migrations are the one place
 * where schema SQL is required.
 */
export type Migrator = (db: DB) => void | Promise<void>;

/**
 * Configures per-database SQLite connection behavior.
 *
 * `foreignKeys` enables SQLite foreign key enforcement for one database file.
 * The canonical session database must keep it disabled: project policy enforces
 * referential integrity in the repository layer, not in the database engine. A
 * private, rebuildable derived store may opt in. Options must be consistent for
 * a given file path because connections are cached per path.
 */
export interface Options {
  foreignKeys?: boolean;
}

/** The process-wide SQLite busy_timeout applied to every managed connection. */
export const BUSY_TIMEOUT_MS = 10_000;

/** SQLite `synchronous` mode for new connections. */
function synchronousMode(): string {
  const env = (runtime.env.get("OPENSAC_SQLITE_SYNCHRONOUS") ?? "").trim();
  return env.toUpperCase() === "FULL" ? "FULL" : "NORMAL";
}

/** A thin, process-owned wrapper around a synchronous SQLite connection. */
export class DB {
  readonly path: string;
  #raw: DatabaseSync;
  #closed = false;

  constructor(pathValue: string, raw: DatabaseSync) {
    this.path = pathValue;
    this.#raw = raw;
  }

  /** The underlying driver handle. Only src/db, src/dao, and migrations use it. */
  get raw(): DatabaseSync {
    return this.#raw;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Executes one or more SQL statements with no result. */
  exec(sql: string): void {
    this.#raw.exec(sql);
  }

  /** Runs a query and returns all rows. */
  query<T = Record<string, unknown>>(
    sql: string,
    ...params: SQLInputValue[]
  ): T[] {
    return this.#raw.prepare(sql).all(...params) as T[];
  }

  /** Runs a query and returns the first row, or undefined. */
  get<T = Record<string, unknown>>(
    sql: string,
    ...params: SQLInputValue[]
  ): T | undefined {
    return this.#raw.prepare(sql).get(...params) as T | undefined;
  }

  /** Runs a statement and returns the change metadata. */
  run(
    sql: string,
    ...params: SQLInputValue[]
  ): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.#raw.prepare(sql).run(...params);
  }

  [Symbol.dispose](): void {
    this.close();
  }

  /** Closes the underlying connection. Callers should normally use CloseAll. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#raw.close();
  }
}

/**
 * Returns the absolute, cleaned database path used as the cache key. Keeping
 * this in one place prevents duplicate connections to the same SQLite file
 * through differently spelled paths.
 */
export function canonicalPath(pathValue: string): string {
  return path.resolve(path.normalize(pathValue));
}

const state: { dbs: Map<string, DB> } = { dbs: new Map() };

/**
 * Returns the process-wide connection for `pathValue` with foreign key
 * enforcement disabled (the canonical session database policy). Callers must
 * not close it; CloseAll owns the lifecycle.
 */
export function open(pathValue: string, migrate?: Migrator): DB {
  return openWithOptions(pathValue, migrate, {});
}

/**
 * Returns the process-wide connection for `pathValue`, applying per-database
 * options. The connection is cached by canonical path, so the options for a
 * given file must be stable across callers.
 */
export function openWithOptions(
  pathValue: string,
  migrate: Migrator | undefined,
  opts: Options,
): DB {
  const canonical = canonicalPath(pathValue);
  const existing = state.dbs.get(canonical);
  if (existing) return existing;
  const connection = openRecovering(canonical, migrate, opts);
  state.dbs.set(canonical, connection);
  return connection;
}

/**
 * Opens an uncached connection for callers that explicitly own its lifecycle,
 * such as offline integrity checks. Foreign key enforcement stays disabled.
 */
export function openStandalone(pathValue: string, migrate?: Migrator): DB {
  const canonical = canonicalPath(pathValue);
  return openRecovering(canonical, migrate, {});
}

/**
 * Opens an uncached, read-only connection without running integrity repair, WAL
 * setup, or migrations. It is for safety preflights that must inspect an
 * existing database without changing it. The caller owns the connection.
 */
export function openReadOnlyStandalone(pathValue: string): DB {
  const canonical = canonicalPath(pathValue);
  const raw = new DatabaseSync(canonical, { readOnly: true });
  try {
    raw.exec(`PRAGMA busy_timeout(${BUSY_TIMEOUT_MS})`);
  } catch (err) {
    raw.close();
    throw new Error(`initialize read-only sqlite connection: ${err}`);
  }
  return new DB(canonical, raw);
}

/** Runs a read operation through the process-wide connection. */
export function query<T>(
  pathValue: string,
  migrate: Migrator | undefined,
  fn: (db: DB) => T,
): T {
  return fn(open(pathValue, migrate));
}

/**
 * Runs a write operation in one transaction.
 *
 * The Go original took a `context.Context`; Node is single-threaded, so the
 * callback runs synchronously and the transaction is committed on success.
 */
export function write<T>(
  pathValue: string,
  migrate: Migrator | undefined,
  fn: (db: DB) => T,
): T {
  const connection = open(pathValue, migrate);
  return runInTx(connection, fn);
}

/** Begins a transaction, retrying transient writer contention. */
export function runInTx<T>(connection: DB, fn: (db: DB) => T): T {
  beginImmediate(connection);
  let done = false;
  try {
    const result = fn(connection);
    done = true;
    connection.exec("COMMIT");
    return result;
  } finally {
    if (!done) {
      try {
        connection.exec("ROLLBACK");
      } catch {
        // ignore rollback failure
      }
    }
  }
}

/**
 * Takes the writer lock up front, matching the Go DSN's `_txlock=immediate`.
 * Every attempt is reported to `recordBeginWait` and every transient busy
 * retry to the busy counters, so the published contention metrics stay live
 * (Go `retryBusy`).
 */
function beginImmediate(connection: DB): void {
  const deadline = Date.now() + 90_000;
  let delay = 200;
  for (;;) {
    const attemptStart = performance.now();
    try {
      connection.exec("BEGIN IMMEDIATE");
      recordBeginWait(performance.now() - attemptStart);
      return;
    } catch (err) {
      recordBeginWait(performance.now() - attemptStart);
      if (!isSQLiteBusy(err)) throw err;
      recordBusyRetryHit();
      if (Date.now() + delay >= deadline) throw err;
      sleepSync(delay);
      recordBusyRetryWait(delay);
      delay = Math.min(delay * 2, 2_000);
    }
  }
}

/** Checkpoints and closes all process-owned connections. */
export function closeAll(): void {
  const errs: unknown[] = [];
  for (const [key, connection] of state.dbs) {
    try {
      connection.run("PRAGMA wal_checkpoint(PASSIVE)");
    } catch (err) {
      errs.push(new Error(`checkpoint ${key}: ${err}`));
    }
    try {
      connection.close();
    } catch (err) {
      errs.push(new Error(`close ${key}: ${err}`));
    }
    state.dbs.delete(key);
  }
  if (errs.length > 0) {
    throw new AggregateError(errs, "close all databases");
  }
}

/**
 * Releases one process-owned connection. It is used by resource stores that own
 * a whole database file and need to remove that exact file after their data has
 * been deleted.
 */
export function close(pathValue: string): void {
  const canonical = canonicalPath(pathValue);
  const connection = state.dbs.get(canonical);
  if (!connection) return;
  state.dbs.delete(canonical);
  const errs: unknown[] = [];
  try {
    connection.run("PRAGMA wal_checkpoint(PASSIVE)");
  } catch (err) {
    errs.push(new Error(`checkpoint ${canonical}: ${err}`));
  }
  try {
    connection.close();
  } catch (err) {
    errs.push(new Error(`close ${canonical}: ${err}`));
  }
  if (errs.length > 0) {
    throw new AggregateError(errs, `close ${canonical}`);
  }
}

/** Bound on how long opening a database keeps retrying a lost index repair. */
const indexRepairBudget = BUSY_TIMEOUT_MS;

/**
 * Opens one database file and recovers from a schema migration failure that
 * cannot be repaired in place (see `SchemaIncompatible`): the unrecoverable
 * database is snapshotted next to the original and a fresh database is
 * initialized in its place.
 */
function openRecovering(
  pathValue: string,
  migrate: Migrator | undefined,
  opts: Options,
): DB {
  let connection: DB;
  try {
    connection = openOnce(pathValue, migrate, opts);
    return connection;
  } catch (err) {
    if (!(err instanceof MigrationFailedError)) throw err;
    const failed = err;
    if (!isSchemaIncompatible(failed.cause)) {
      failed.db.close();
      throw failed.cause;
    }
    const reason = unrebuildableReason(failed.cause);
    if (reason !== "") {
      failed.db.close();
      throw new Error(
        `${describe(
          failed.cause,
        )} (${reason}; the database was left untouched)`,
      );
    }
    let recovery: MigrationRecovery;
    try {
      recovery = recoverFromMigrationFailure(
        failed.db,
        pathValue,
        failed.cause,
      );
    } catch (recoveryErr) {
      throw new AggregateError(
        [failed.cause, recoveryErr],
        "rebuild database after migration failure",
      );
    }
    let rebuilt: DB;
    try {
      rebuilt = openOnce(pathValue, migrate, opts);
    } catch (rebuildErr) {
      if (rebuildErr instanceof MigrationFailedError) rebuildErr.db.close();
      throw new AggregateError(
        [failed.cause, rebuildErr],
        `open database rebuilt from ${recovery.backupPath}`,
      );
    }
    recordMigrationRecovery(recovery);
    return rebuilt;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reports why a migration failure must not trigger a schema rebuild, or "" when
 * a rebuild is allowed.
 */
function unrebuildableReason(err: unknown): string {
  if (err == null) return "";
  if (isAbortError(err)) return "the migration was cancelled";
  if (isSQLiteBusy(err)) return "another process holds the SQLite writer lock";
  if (isSQLiteReadOnly(err)) return "the database file is read-only";
  return "";
}

/** Marks a migration failure that must be snapshotted through its connection. */
export class MigrationFailedError extends Error {
  readonly db: DB;
  override readonly cause: unknown;
  constructor(db: DB, cause: unknown) {
    super(describe(cause));
    this.name = "MigrationFailedError";
    this.db = db;
    this.cause = cause;
  }
}

/**
 * Opens, checks, and initializes one database file without any recovery. A
 * migration failure is returned as a `MigrationFailedError` so the caller can
 * snapshot the database through the connection that produced it; that
 * connection stays open on that one error path and is closed by the caller.
 */
function openOnce(
  pathValue: string,
  migrate: Migrator | undefined,
  opts: Options,
): DB {
  runtime.mkdirSync(path.dirname(pathValue), { recursive: true, mode: 0o700 });
  const raw = new DatabaseSync(pathValue);
  const connection = new DB(pathValue, raw);
  try {
    applyPragmas(connection, opts);
    // Note: the Go original runs the integrity check before enabling WAL. The
    // node:sqlite driver leaves the quick_check statement open, which makes a
    // later `wal_checkpoint` fail with SQLITE_LOCKED when the journal mode is
    // switched afterwards, so WAL is enabled first here. The two operations are
    // independent and this ordering is behaviorally equivalent.
    enableWAL(connection);
    checkIntegrity(connection, pathValue);
    if (migrate) {
      try {
        migrate(connection);
      } catch (err) {
        const wrapped = new Error(
          `apply database migration: ${describe(err)}`,
          { cause: err },
        );
        throw new MigrationFailedError(connection, wrapped);
      }
    }
  } catch (err) {
    if (!(err instanceof MigrationFailedError)) {
      connection.close();
    }
    throw err;
  }
  return connection;
}

function applyPragmas(connection: DB, opts: Options): void {
  connection.exec(`PRAGMA busy_timeout(${BUSY_TIMEOUT_MS})`);
  connection.exec(`PRAGMA synchronous(${synchronousMode()})`);
  // node:sqlite enables foreign key enforcement by default, but the canonical
  // session database keeps it disabled (project policy enforces referential
  // integrity in the repository layer). Only a private derived store may opt in.
  connection.exec(`PRAGMA foreign_keys(${opts.foreignKeys ? 1 : 0})`);
}

/**
 * Validates the database before it is used. SQLite can report a stale
 * secondary-index entry after an interrupted write even when every table page
 * remains intact. Rebuilding indexes is lossless, so repair that precise case
 * and verify it before continuing.
 */
function checkIntegrity(connection: DB, pathValue: string): void {
  const integrity = quickCheck(connection);
  if (integrity === "ok") return;
  if (!isStaleIndexReport(integrity)) {
    throw new Error(`sqlite integrity check failed: ${integrity}`);
  }
  const cause = integrity;

  try {
    attemptWhileBusy(indexRepairBudget, () => connection.exec("REINDEX"));
  } catch (err) {
    if (isSQLiteBusy(err)) {
      throw new Error(
        `sqlite reported a stale index (${cause}) but the writer lock was unavailable for ${indexRepairBudget}ms, so it was not repaired: another process still holds the SQLite writer lock on ${pathValue}; stop it and retry: ${describe(
          err,
        )}`,
      );
    }
    if (isSQLiteReadOnly(err)) {
      throw new Error(
        `sqlite reported a stale index (${cause}) but ${pathValue} is read-only, so it could not be repaired: ${describe(
          err,
        )}`,
      );
    }
    throw new Error(
      `repair SQLite indexes after integrity check ${JSON.stringify(cause)}: ${describe(
        err,
      )}`,
    );
  }
  const after = quickCheck(connection);
  if (after !== "ok") {
    throw new Error(
      `sqlite integrity check failed after index repair: ${after}`,
    );
  }
  recordIndexRepair({ path: pathValue, cause, at: new Date() });
}

/**
 * Reports whether a quick_check line describes only a secondary index
 * disagreeing with the table rows it derives from.
 */
function isStaleIndexReport(integrity: string): boolean {
  return integrity.toLowerCase().includes("wrong # of entries in index");
}

function quickCheck(connection: DB): string {
  const row = connection.get<Record<string, unknown>>("PRAGMA quick_check");
  if (!row) return "";
  return String(Object.values(row)[0] ?? "");
}

/** Pause between retries of a startup statement that hit writer contention. */
const sqliteRetryDelay = 25;

/**
 * Runs one SQLite statement, retrying only while the driver reports writer
 * contention (SQLITE_BUSY/SQLITE_LOCKED) and the budget lasts.
 */
export function attemptWhileBusy(
  budgetMs: number,
  statement: () => void,
): void {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      statement();
      return;
    } catch (err) {
      if (!isSQLiteBusy(err) || Date.now() + sqliteRetryDelay >= deadline) {
        throw err;
      }
      sleepSync(sqliteRetryDelay);
    }
  }
}

function enableWAL(connection: DB): void {
  let mode = "";
  attemptWhileBusy(BUSY_TIMEOUT_MS, () => {
    const row = connection.get<Record<string, unknown>>(
      "PRAGMA journal_mode=WAL",
    );
    mode = row ? String(Object.values(row)[0] ?? "") : "";
  });
  if (mode.toLowerCase() !== "wal") {
    throw new Error(`sqlite journal mode is ${JSON.stringify(mode)}, want WAL`);
  }
}

// Re-exported for schema/migration owners and platform integration tests.
export { type IndexRepair } from "./repair.ts";
export {
  isSchemaIncompatible,
  type MigrationRecovery,
  schemaIncompatible,
} from "./recovery.ts";
