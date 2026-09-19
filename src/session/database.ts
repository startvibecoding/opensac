// Ported from internal/session/database.go
//
// The DAO-owned root database entry points plus the database recovery/index
// repair projections a front-end drains exactly once.

import {
  type DB,
  type IndexRepair,
  type MigrationRecovery,
  open,
  takeIndexRepairs,
  takeMigrationRecoveries,
} from "../db/mod.ts";
import { type Database, type Tx, wrapDatabase } from "../dao/mod.ts";
import { takePeerDatabaseRebuilds } from "./database_recovery_notice.ts";
import { ensureCurrentSchema } from "./schema.ts";
import { openRootDB, rootDBPath } from "./root_db.ts";

/**
 * Returns the process-wide DAO connection for `path`. New data access code
 * should use this entry point and put queries in a DAO.
 */
export function openBunDatabase(path: string): Database {
  const connection: DB = open(path, ensureCurrentSchema);
  const handle = wrapDatabase(connection);
  if (handle === null) throw new Error("database handle is nil");
  return handle;
}

/** Returns the shared sessions.db path for a session root. */
export function rootDatabasePath(sessionDir: string): string {
  return rootDBPath(sessionDir);
}

/**
 * Reports a sessions database that failed schema migration and was therefore
 * backed up and rebuilt by src/db. The previous data stays in the backup path.
 */
export type DatabaseRecovery = MigrationRecovery;

/**
 * Reports a stale secondary index src/db rebuilt while opening a database.
 * Nothing is lost — index contents are derived from the table rows — but the
 * file has already survived a failed write, which a front-end should surface
 * once.
 */
export type DatabaseIndexRepair = IndexRepair;

/**
 * Returns and clears the index repairs recorded since the last call. Only this
 * process's own repairs are reported: a repair replaces no file, so peers never
 * announce them.
 */
export function takeDatabaseIndexRepairs(): DatabaseIndexRepair[] {
  return takeIndexRepairs();
}

/**
 * Returns the database recoveries recorded since the last call and clears them,
 * so a front-end can tell the user exactly once what was backed up and why.
 *
 * Rebuilds other mothx processes announced over the advisory runtime lease bus
 * are appended so a front-end drains local and peer notices through one API.
 */
export function takeDatabaseRecoveries(): DatabaseRecovery[] {
  return [...takeMigrationRecoveries(), ...takePeerDatabaseRebuilds()];
}

/**
 * Runs a read operation against a session root's DAO-owned database. The
 * callback must not retain the handle after it returns.
 */
export function queryRootDatabase(
  sessionDir: string,
  fn: (db: Database) => void,
): void {
  fn(openRootDB(sessionDir));
}

/**
 * Runs a write transaction against a session root's DAO-owned database. The
 * callback receives the transaction wrapper.
 */
export function writeRootDatabase(
  sessionDir: string,
  fn: (tx: Tx) => void,
): void {
  openRootDB(sessionDir).runInTx(fn);
}
