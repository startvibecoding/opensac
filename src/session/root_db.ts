// Root database helpers.
//
// These helpers own the shared sessions.db path rules and the DAO-owned root
// database handle so adapters and DAOs never duplicate the session directory
// layout. They are split out of the Manager so the session-level wrappers over
// the DAO layer can build on them.

import * as path from "@std/path";
import {
  closeAll,
  type DB,
  open,
  openReadOnlyStandalone,
  openStandalone,
} from "../db/mod.ts";
import {
  type Database,
  wrapDatabase,
  wrapStandaloneDatabase,
} from "../dao/mod.ts";
import { sessionDir as platformSessionDir } from "../platform/platform.ts";
import { ensureCurrentSchema } from "./schema.ts";

/**
 * Returns the shared sessions.db path for a session root. Keeping path
 * derivation here prevents adapters and DAOs from duplicating session
 * directory rules.
 */
export function rootDBPath(sessionDir: string): string {
  if (sessionDir === "") {
    sessionDir = platformSessionDir();
  }
  return path.join(sessionDir, "sessions.db");
}

/**
 * Opens the shared sessions.db through the DAO-owned database handle. Callers
 * must not close it; use the src/db lifecycle (`closeAll`) for teardown.
 */
export function openRootDB(sessionDir: string): Database {
  const connection: DB = open(rootDBPath(sessionDir), ensureCurrentSchema);
  const handle = wrapDatabase(connection);
  if (handle === null) throw new Error("root database is not open");
  return handle;
}

/**
 * Parses a persisted session timestamp. Returns an invalid `Date` for a
 * malformed value, mirroring Go's zero `time.Time` result.
 */
export function parseSessionTimestamp(timestamp: string): Date {
  return new Date(timestamp);
}

/** Reports whether the sessions.db file exists in a session root. */
function sessionDBExists(dbPath: string): boolean {
  try {
    Deno.statSync(dbPath);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/**
 * Opens an existing sessions database through the DAO-owned handle. When the
 * file does not exist it returns null rather than creating one, matching the
 * read-only listing surfaces. Callers must not close the returned managed
 * handle.
 */
export function openExistingSessionDB(
  sessionDir: string,
): Database | null {
  if (sessionDir === "") {
    sessionDir = platformSessionDir();
  }
  const dbPath = path.join(sessionDir, "sessions.db");
  if (!sessionDBExists(dbPath)) return null;
  const connection: DB = open(dbPath, ensureCurrentSchema);
  return wrapDatabase(connection);
}

/**
 * Opens an existing sessions database for a safety preflight. Unlike
 * openExistingSessionDB it never runs migrations, integrity repair, or WAL
 * setup, and the caller owns the returned standalone handle.
 */
export function openExistingSessionDBReadOnly(
  sessionDir: string,
): Database | null {
  if (sessionDir === "") {
    sessionDir = platformSessionDir();
  }
  const dbPath = path.join(sessionDir, "sessions.db");
  if (!sessionDBExists(dbPath)) return null;
  const connection: DB = openReadOnlyStandalone(dbPath);
  return wrapStandaloneDatabase(connection);
}

/**
 * Opens a configured standalone DAO connection. It is only intended for
 * offline integrity checks; normal runtime code uses openRootDB.
 */
export function openStandaloneDB(pathValue: string): Database {
  const connection: DB = openStandalone(pathValue, ensureCurrentSchema);
  const handle = wrapStandaloneDatabase(connection);
  if (handle === null) throw new Error("standalone database is not open");
  return handle;
}

/** Checkpoints and closes all process-owned session connections. */
export function closeDatabases(): void {
  closeAll();
}
