//
// Path derivation, private-database open, and transaction wrappers for the
// per-knowledge-base graph/FTS store. Each knowledge base gets one private
// SQLite file beside sessions.db; it is never attached to the canonical
// session database.

import * as path from "@opensac/path";
import { close, type DB, openWithOptions } from "../db/mod.ts";
import { type Database, type Tx, wrapDatabase } from "../dao/mod.ts";
import { rootDBPath } from "./root_db.ts";
import { ensureKnowledgeBaseSchema } from "./migrations.ts";

const knowledgeBaseDatabaseDirectoryName = "knowledge-bases";

/** Thrown when a knowledge base (or its database) does not exist. */
export class KnowledgeBaseNotFoundError extends Error {
  override name = "KnowledgeBaseNotFoundError";
  constructor() {
    super("knowledge base not found");
  }
}

/**
 * Derives the private SQLite file for exactly one knowledge base. The file
 * lives beside sessions.db but is never attached to or queried through the
 * session database.
 */
export function knowledgeBaseDatabasePath(
  sessionDir: string,
  knowledgeBaseID: string,
): string {
  const id = normalizeKnowledgeBaseDatabaseID(knowledgeBaseID);
  return path.join(
    path.dirname(rootDBPath(sessionDir)),
    knowledgeBaseDatabaseDirectoryName,
    `${id}.db`,
  );
}

function normalizeKnowledgeBaseDatabaseID(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new KnowledgeBaseNotFoundError();
  for (const ch of trimmed) {
    if (
      !(ch >= "a" && ch <= "z" || ch >= "A" && ch <= "Z" ||
        ch >= "0" && ch <= "9" || ch === "_" || ch === "-")
    ) {
      throw new Error("invalid knowledge base database identity");
    }
  }
  return trimmed;
}

/**
 * Opens one knowledge-base database with foreign key enforcement enabled (the
 * private derived store relies on ON DELETE CASCADE, unlike the canonical
 * session database).
 */
function openKnowledgeBaseDatabase(
  sessionDir: string,
  knowledgeBaseID: string,
  create: boolean,
): { db: Database; path: string } {
  const dbPath = knowledgeBaseDatabasePath(sessionDir, knowledgeBaseID);
  if (!create) {
    let info: Deno.FileInfo;
    try {
      info = Deno.lstatSync(dbPath);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        throw new KnowledgeBaseNotFoundError();
      }
      throw new Error(`stat knowledge base database: ${err}`);
    }
    if (!info.isFile) {
      throw new Error("knowledge base database is not a regular file");
    }
  }
  const connection: DB = openWithOptions(dbPath, ensureKnowledgeBaseSchema, {
    foreignKeys: true,
  });
  const handle = wrapDatabase(connection);
  if (handle === null) throw new Error("knowledge database is not open");
  return { db: handle, path: dbPath };
}

/** Runs a read callback against one knowledge-base database handle. */
export function queryKnowledgeBaseDatabase(
  sessionDir: string,
  knowledgeBaseID: string,
  fn: (db: Database) => void,
): void {
  const { db } = openKnowledgeBaseDatabase(sessionDir, knowledgeBaseID, false);
  fn(db);
}

/**
 * Keeps a multi-query graph projection on one SQLite transaction. Snapshot
 * publication prunes old rows atomically, so callers that need a coherent
 * projection must not release the connection between reading
 * active_snapshot_id and its graph rows.
 */
export function readKnowledgeBaseDatabase(
  sessionDir: string,
  knowledgeBaseID: string,
  fn: (tx: Tx) => void,
): void {
  const { db } = openKnowledgeBaseDatabase(sessionDir, knowledgeBaseID, false);
  db.runInTx(fn);
}

/** Runs a write callback inside one transaction on a knowledge-base database. */
export function writeKnowledgeBaseDatabase(
  sessionDir: string,
  knowledgeBaseID: string,
  create: boolean,
  fn: (tx: Tx) => void,
): void {
  const { db } = openKnowledgeBaseDatabase(
    sessionDir,
    knowledgeBaseID,
    create,
  );
  db.runInTx(fn);
}

/** Lists every valid knowledge-base database identity in a session root. */
export function listKnowledgeBaseDatabaseIDs(sessionDir: string): string[] {
  const dir = path.join(
    path.dirname(rootDBPath(sessionDir)),
    knowledgeBaseDatabaseDirectoryName,
  );
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw new Error(`list knowledge base databases: ${err}`);
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (
      entry.isSymlink || entry.isDirectory || !entry.name.endsWith(".db")
    ) {
      continue;
    }
    const id = entry.name.slice(0, -".db".length);
    try {
      normalizeKnowledgeBaseDatabaseID(id);
    } catch {
      continue;
    }
    let info: Deno.FileInfo;
    try {
      info = Deno.lstatSync(path.join(dir, entry.name));
    } catch {
      continue;
    }
    if (!info.isFile) continue;
    ids.push(id);
  }
  ids.sort();
  return ids;
}

/** Removes one knowledge-base database file and its SQLite sidecars. */
export function deleteKnowledgeBaseDatabase(
  sessionDir: string,
  knowledgeBaseID: string,
): void {
  const dbPath = knowledgeBaseDatabasePath(sessionDir, knowledgeBaseID);
  close(dbPath);
  for (const target of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      Deno.removeSync(target);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) continue;
      throw new Error(`remove knowledge base database: ${err}`);
    }
  }
}
