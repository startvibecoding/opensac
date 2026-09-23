//
// Moves the shared sessions database aside and creates a fresh, migrated one in
// its place. The previous database and its sidecars are renamed (never deleted)
// next to the new file, so the old sessions remain recoverable.

import * as path from "@std/path";
import { closeAll } from "../db/mod.ts";
import { sessionDir as platformSessionDir } from "../platform/platform.ts";
import { closeDatabases, openRootDB, rootDBPath } from "./root_db.ts";

/**
 * Lists the SQLite sidecar files that belong to a sessions.db. They are moved
 * together with the database so a freshly created file can never inherit a
 * stale write-ahead log or shared-memory index.
 */
export const databaseSidecarSuffixes: string[] = ["-wal", "-shm", "-journal"];

/** Describes what one sessions database reset did, and what it did not do. */
export interface ResetReport {
  /** The renamed sessions.db; empty when no database file existed. */
  databaseBackup: string;
  /** Every file the reset moved aside, database first then each sidecar. */
  archived: ArchivedFile[];
  /** Session-directory entries a reset does not archive. */
  leftBehind: LeftBehindEntry[];
}

/** One sessions.db file a reset renamed. */
export interface ArchivedFile {
  from: string;
  to: string;
}

/** One session-directory entry that outlives a reset. */
export interface LeftBehindEntry {
  name: string;
  directory: boolean;
  bytes: number;
}

/**
 * Moves the shared sessions database aside and creates a fresh, migrated one in
 * its place. The previous database and its sidecars are renamed (never deleted)
 * next to the new file, so the old sessions remain recoverable.
 *
 * Callers must ensure no other process is running against the session
 * directory: a database moved while another process still holds it open keeps
 * being written there, and this process cannot detect that.
 */
export function resetDatabase(sessionDir?: string): ResetReport {
  const dir = sessionDir === undefined || sessionDir === ""
    ? platformSessionDir()
    : sessionDir;
  const report: ResetReport = {
    databaseBackup: "",
    archived: [],
    leftBehind: [],
  };
  const dbPath = rootDBPath(dir);

  // Retire the connection this process may hold so the file is not renamed
  // while open. CloseAll folds committed WAL frames into the main file first.
  try {
    closeAll();
  } catch (err) {
    throw new Error(`close session databases: ${err}`);
  }

  const sources = existingDatabaseFiles(dbPath);
  if (sources.length > 0) {
    const backup = resetBackupPath(dbPath);
    const archived = moveDatabaseFiles(dbPath, sources, backup);
    report.archived = archived;
    if (sources[0] === dbPath) {
      report.databaseBackup = backup;
    }
  }

  try {
    openRootDB(dir);
  } catch (err) {
    throw new Error(`create fresh sessions database: ${err}`);
  }
  try {
    closeDatabases();
  } catch (err) {
    throw new Error(`close fresh sessions database: ${err}`);
  }
  report.leftBehind = leftBehindEntries(dir, dbPath);
  return report;
}

/**
 * Returns the sessions database and every sidecar currently present, ordered so
 * the main file comes first. Absent files are skipped; any other stat outcome
 * is fatal, because guessing here would mean moving a database this process
 * cannot see.
 */
export function existingDatabaseFiles(dbPath: string): string[] {
  const found: string[] = [];
  if (fileExists(dbPath)) found.push(dbPath);
  for (const suffix of databaseSidecarSuffixes) {
    const sidecar = dbPath + suffix;
    if (fileExists(sidecar)) found.push(sidecar);
  }
  return found;
}

/**
 * Renames every existing sessions.db file to the backup name. `sources` starts
 * with the main file, so the database is never separated from its WAL even
 * momentarily. A file that cannot move rolls the whole move back.
 */
export function moveDatabaseFiles(
  dbPath: string,
  sources: string[],
  backupPath: string,
): ArchivedFile[] {
  const moved: ArchivedFile[] = [];
  for (const source of sources) {
    const destination = backupPath + source.slice(dbPath.length);
    try {
      Deno.renameSync(source, destination);
    } catch (err) {
      rollbackDatabaseMove(
        dbPath,
        sources,
        moved,
        new Error(`move ${source}: ${err}`),
      );
    }
    moved.push({ from: source, to: destination });
  }
  return moved;
}

/** Thrown when a database move had to be rolled back; carries the restores. */
export class DatabaseMoveError extends AggregateError {
  readonly restored: ArchivedFile[];
  constructor(errs: unknown[], restored: ArchivedFile[]) {
    super(errs, errs.map((err) => String(err)).join("\n"));
    this.name = "DatabaseMoveError";
    this.restored = restored;
  }
}

/**
 * Restores an interrupted move, pairing each archived file with the source it
 * came from. The main database goes back before any sidecar: a stale -wal or
 * -journal beside a missing sessions.db is precisely the orphan state a reset
 * exists to clear. Throws after attempting every restore.
 */
function rollbackDatabaseMove(
  dbPath: string,
  sources: string[],
  moved: ArchivedFile[],
  cause: Error,
): never {
  const errs: unknown[] = [cause];
  const restored: ArchivedFile[] = [];
  const restore = (index: number) => {
    const source = sources[index];
    const archived = moved[index].to;
    try {
      Deno.renameSync(archived, source);
      restored.push({ from: archived, to: source });
    } catch (err) {
      errs.push(new Error(`restore ${source}: ${err}`));
    }
  };
  let start = 0;
  if (moved.length > 0 && sources[0] === dbPath) {
    restore(0);
    start = 1;
  }
  for (let index = moved.length - 1; index >= start; index--) {
    restore(index);
  }
  throw new DatabaseMoveError(errs, restored);
}

/**
 * Lists what stays in the session directory after a reset. Everything named
 * like sessions.db (the fresh file, its sidecars, and the archives just
 * created) belongs to the reset itself and is not reported.
 */
function leftBehindEntries(
  sessionDir: string,
  dbPath: string,
): LeftBehindEntry[] {
  const prefix = path.basename(dbPath);
  const leftBehind: LeftBehindEntry[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(sessionDir)];
  } catch (err) {
    throw new Error(`inspect session directory: ${err}`);
  }
  for (const entry of entries) {
    if (entry.name.startsWith(prefix)) continue;
    const full = path.join(sessionDir, entry.name);
    leftBehind.push({
      name: entry.name,
      directory: entry.isDirectory,
      bytes: entryBytes(full, entry),
    });
  }
  return leftBehind;
}

/**
 * Measures one entry without following symbolic links, so reporting what a
 * reset left behind can never be turned into an unbounded walk.
 */
function entryBytes(fullPath: string, entry: Deno.DirEntry): number {
  if (!entry.isDirectory) {
    try {
      return Deno.statSync(fullPath).size;
    } catch (err) {
      throw new Error(`inspect ${fullPath}: ${err}`);
    }
  }
  let total = 0;
  const walk = (dir: string) => {
    let children: Deno.DirEntry[];
    try {
      children = [...Deno.readDirSync(dir)];
    } catch (err) {
      throw new Error(`measure ${dir}: ${err}`);
    }
    for (const child of children) {
      const childPath = path.join(dir, child.name);
      if (child.isDirectory) {
        walk(childPath);
        continue;
      }
      try {
        total += Deno.statSync(childPath).size;
      } catch (err) {
        throw new Error(`measure ${childPath}: ${err}`);
      }
    }
  };
  walk(fullPath);
  return total;
}

/**
 * Returns an unused backup name next to the database so the moved file stays in
 * the same directory as the data it preserves. The sidecar archives are derived
 * from the same name, so they are checked too.
 */
export function resetBackupPath(dbPath: string): string {
  const stamp = utcStamp();
  for (let attempt = 0;; attempt++) {
    const candidate = attempt === 0
      ? `${dbPath}.pure-${stamp}.bak`
      : `${dbPath}.pure-${stamp}-${attempt}.bak`;
    if (backupPathAvailable(candidate)) return candidate;
    if (attempt >= 1000) {
      throw new Error(`no free backup path for ${dbPath}`);
    }
  }
}

/**
 * Reports whether neither the candidate name nor any of its sidecar
 * derivatives exists yet.
 */
export function backupPathAvailable(candidate: string): boolean {
  const names = [candidate];
  for (const suffix of databaseSidecarSuffixes) names.push(candidate + suffix);
  for (const name of names) {
    if (pathExists(name)) return false;
  }
  return true;
}

function utcStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${
    pad(now.getUTCDate())
  }T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${
    pad(now.getUTCSeconds())
  }Z`;
}

function fileExists(p: string): boolean {
  try {
    const stat = Deno.statSync(p);
    return stat.isFile || stat.isSymlink;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw new Error(`inspect ${p}: ${err}`);
  }
}

function pathExists(p: string): boolean {
  try {
    Deno.lstatSync(p);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw new Error(`check ${p}: ${err}`);
  }
}
