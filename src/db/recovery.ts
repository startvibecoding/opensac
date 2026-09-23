import type { DB } from "./db.ts";

/**
 * Records a schema migration failure that src/db recovered from by snapshotting
 * the unrecoverable database and starting a new empty one in its place.
 */
export interface MigrationRecovery {
  /** The canonical database path that was replaced. */
  path: string;
  /** The snapshot of the pre-recovery database ("" when nothing to preserve). */
  backupPath: string;
  /** The migration failure that triggered the recovery. */
  err: unknown;
  /** Reports that another process performed the recovery. */
  peer: boolean;
  /** When the recovery happened. */
  at: Date;
}

/** Returns the one-line operator-facing summary of a recovery. */
export function describeMigrationRecovery(r: MigrationRecovery): string {
  if (r.peer) {
    return `another OpenSAC process rebuilt the database at ${r.path} after a failed migration`;
  }
  if (r.backupPath === "") {
    return `database migration failed for ${r.path} (${
      message(r.err)
    }); started a new empty database`;
  }
  return `database migration failed for ${r.path} (${
    message(r.err)
  }); backed up the previous database to ${r.backupPath} and started a new empty database`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Marks a migration failure that cannot be repaired in place. */
class SchemaIncompatibleError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super(message(cause));
    this.name = "SchemaIncompatibleError";
    this.cause = cause;
  }
}

/**
 * Marks a migration failure caused by a schema this build cannot upgrade in
 * place. src/db reacts by backing up and rebuilding the database; any other
 * migration error is reported to the caller unchanged.
 */
export function schemaIncompatible(err: unknown): unknown {
  if (err == null) return err;
  return new SchemaIncompatibleError(err);
}

/**
 * Reports whether `err` was marked by `schemaIncompatible`. Walks the wrapped
 * cause chain so a marker survives `apply database migration: %w`-style
 * wrapping, matching Go's errors.As behavior.
 */
export function isSchemaIncompatible(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 16 && current != null; depth++) {
    if (current instanceof SchemaIncompatibleError) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const recoveryLog: MigrationRecovery[] = [];

type RecoveryNotifier = (recovery: MigrationRecovery) => void;
let migrationRecoveryNotifier: RecoveryNotifier | null = null;

/**
 * Registers a hook invoked for every completed recovery, after the recovery has
 * been recorded and logged. Passing null clears it.
 */
export function setMigrationRecoveryNotifier(
  fn: RecoveryNotifier | null,
): void {
  migrationRecoveryNotifier = fn;
}

export function recordMigrationRecovery(recovery: MigrationRecovery): void {
  recoveryLog.push(recovery);
  console.error(`[db] ${describeMigrationRecovery(recovery)}`);
  if (migrationRecoveryNotifier) migrationRecoveryNotifier(recovery);
}

/** Returns the recoveries recorded in this process without clearing them. */
export function migrationRecoveries(): MigrationRecovery[] {
  return recoveryLog.slice();
}

/**
 * Returns the recoveries recorded since the last call and clears them, so a
 * front-end can tell the user exactly once.
 */
export function takeMigrationRecoveries(): MigrationRecovery[] {
  const entries = recoveryLog.slice();
  recoveryLog.length = 0;
  return entries;
}

/**
 * Snapshots the unrecoverable database, closes its connection, and removes the
 * file set so the next open starts from empty.
 */
export function recoverFromMigrationFailure(
  connection: DB,
  pathValue: string,
  cause: unknown,
): MigrationRecovery {
  const recovery = snapshotUnrebuildableDatabase(connection, pathValue, cause);
  connection.close();
  removeDatabaseFiles(pathValue);
  return recovery;
}

/**
 * Writes a self-contained backup of a database whose schema cannot be migrated.
 * The original file stays untouched here; only the backup is new, so a failed
 * backup never costs data.
 */
function snapshotUnrebuildableDatabase(
  connection: DB,
  pathValue: string,
  cause: unknown,
): MigrationRecovery {
  try {
    Deno.statSync(pathValue);
  } catch (err) {
    throw new Error(`inspect database before rebuild: ${message(err)}`);
  }
  const backupPath = backupPathFor(pathValue);
  snapshotDatabase(connection, pathValue, backupPath);
  return {
    path: pathValue,
    backupPath,
    err: cause,
    peer: false,
    at: new Date(),
  };
}

/** Returns an unused backup file name next to the database. */
function backupPathFor(pathValue: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(
    /\.\d+Z$/,
    "Z",
  );
  for (let attempt = 0;; attempt++) {
    const candidate = attempt > 0
      ? `${pathValue}.migration-failed-${stamp}-${attempt}.bak`
      : `${pathValue}.migration-failed-${stamp}.bak`;
    let exists = true;
    try {
      Deno.statSync(candidate);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        exists = false;
      } else {
        throw new Error(`check backup path ${candidate}: ${message(err)}`);
      }
    }
    if (!exists) return candidate;
    if (attempt >= 1000) {
      throw new Error(`no free backup path for ${pathValue}`);
    }
  }
}

/**
 * Writes a consistent copy of the database to `backupPath`. It prefers SQLite's
 * own VACUUM INTO and falls back to a checkpoint plus raw file copies.
 */
function snapshotDatabase(
  connection: DB,
  pathValue: string,
  backupPath: string,
): void {
  try {
    vacuumInto(connection, backupPath);
    return;
  } catch (vacuumErr) {
    try {
      connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // best effort
    }
    const errs: unknown[] = [
      new Error(`vacuum database: ${message(vacuumErr)}`),
    ];
    try {
      copyFile(pathValue, backupPath);
    } catch (err) {
      errs.push(err);
    }
    for (const suffix of databaseFileSuffixes()) {
      try {
        copyFileIfExists(pathValue + suffix, backupPath + suffix);
      } catch (err) {
        errs.push(err);
      }
    }
    throw new AggregateError(errs, "snapshot database");
  }
}

function vacuumInto(connection: DB, backupPath: string): void {
  const escaped = backupPath.replaceAll("'", "''");
  connection.exec(`VACUUM INTO '${escaped}'`);
}

/**
 * Deletes one database file together with its sidecars so a recreated database
 * cannot inherit a stale WAL or shared-memory index.
 */
export function removeDatabaseFiles(pathValue: string): void {
  const targets = [pathValue];
  for (const suffix of databaseFileSuffixes()) targets.push(pathValue + suffix);
  const errs: unknown[] = [];
  for (const target of targets) {
    try {
      Deno.removeSync(target);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        errs.push(new Error(`remove ${target}: ${message(err)}`));
      }
    }
  }
  if (errs.length > 0) throw new AggregateError(errs, "remove database files");
}

function databaseFileSuffixes(): string[] {
  return ["-wal", "-shm", "-journal"];
}

function copyFileIfExists(source: string, destination: string): void {
  try {
    Deno.statSync(source);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw new Error(`inspect ${source}: ${message(err)}`);
  }
  copyFile(source, destination);
}

function copyFile(source: string, destination: string): void {
  try {
    Deno.copyFileSync(source, destination);
  } catch (err) {
    throw new Error(`copy ${source} to ${destination}: ${message(err)}`);
  }
}
