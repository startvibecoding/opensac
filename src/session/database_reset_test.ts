// Adapted from internal/session/database_reset_test.go
//
// The Go tests build a session through the Manager; here the
// canonical session row is written directly through the DAO, which is the same
// durable state the Manager persists.

import { runtime } from "../platform/runtime.ts";
import { assert, assertEquals } from "../compat/assert.ts";
import * as path from "../compat/path.ts";
import { SessionDAO } from "../dao/mod.ts";
import { closeAll } from "../db/mod.ts";
import {
  DatabaseMoveError,
  databaseSidecarSuffixes,
  type LeftBehindEntry,
  moveDatabaseFiles,
  resetBackupPath,
  resetDatabase,
  type ResetReport,
} from "./database_reset.ts";
import { openBunDatabase, rootDatabasePath } from "./database.ts";
import { closeDatabases, openRootDB } from "./root_db.ts";
import { test } from "#testing";

function seedSession(dir: string, id: string): void {
  const db = openRootDB(dir);
  new SessionDAO(db.db).insertSession(
    db.db!,
    "sessions",
    id,
    "/work",
    new Date().toISOString(),
    "",
    1,
    "",
    "",
    0,
    0,
    "",
    "",
  );
}

function listSessionIds(dir: string): string[] {
  const db = openRootDB(dir);
  return new SessionDAO(db.db).list({}).map((record) => record.id);
}

function backupSessionIds(backupPath: string): string[] {
  const db = openBunDatabase(backupPath);
  return new SessionDAO(db.db).list({}).map((record) => record.id);
}

test("reset database creates a fresh database when absent", () => {
  const dir = runtime.makeTempDirSync({ prefix: "opensac-reset-" });
  try {
    const report = resetDatabase(dir);
    assertEquals(report.databaseBackup, "");
    assertEquals(report.archived.length, 0);
    assert(runtime.statSync(rootDatabasePath(dir)).isFile);
    assertEquals(listSessionIds(dir).length, 0);
  } finally {
    closeAll();
  }
});

test("reset database moves database and preserves previous sessions", () => {
  const dir = runtime.makeTempDirSync({ prefix: "opensac-reset-" });
  try {
    seedSession(dir, "previous-session");
    closeDatabases();

    const dbPath = rootDatabasePath(dir);
    // A leftover sidecar must travel with the database.
    runtime.writeTextFileSync(dbPath + "-wal", "stale");

    const report = resetDatabase(dir);
    assert(report.databaseBackup !== "");
    assertEquals(path.dirname(report.databaseBackup), dir);
    assert(runtime.statSync(report.databaseBackup).isFile);
    assert(runtime.statSync(report.databaseBackup + "-wal").isFile);
    // The stale sidecar must not be left next to the fresh database.
    const freshWal = dbPath + "-wal";
    if (fileExists(freshWal)) {
      assert(
        runtime.readTextFileSync(freshWal) !== "stale",
        "stale sidecar inherited by the fresh database",
      );
    }
    assertEquals(report.archived.length, 2);
    assertEquals(report.archived[0].to, report.databaseBackup);

    // The fresh database is empty...
    assertEquals(listSessionIds(dir).length, 0);
    // ...while the backup still holds the previous session.
    assertEquals(backupSessionIds(report.databaseBackup), ["previous-session"]);
  } finally {
    closeAll();
  }
});

test("reset database archives orphaned sidecars", () => {
  const dir = runtime.makeTempDirSync({ prefix: "opensac-reset-" });
  try {
    const dbPath = rootDatabasePath(dir);
    for (const suffix of databaseSidecarSuffixes) {
      runtime.writeTextFileSync(dbPath + suffix, "leftover");
    }

    const report = resetDatabase(dir);
    assertEquals(report.databaseBackup, "");
    assertEquals(report.archived.length, databaseSidecarSuffixes.length);
    const archivedBySource = new Map<string, string>();
    for (const archived of report.archived) {
      archivedBySource.set(archived.from, archived.to);
    }
    for (const suffix of databaseSidecarSuffixes) {
      assert(!fileExists(dbPath + suffix), `${dbPath}${suffix} survived`);
      const destination = archivedBySource.get(dbPath + suffix);
      assert(destination !== undefined, `${dbPath}${suffix} not archived`);
      assert(runtime.statSync(destination!).isFile);
    }
    assert(runtime.statSync(dbPath).isFile);
  } finally {
    closeAll();
  }
});

test("move database files rolls back with the main file first", () => {
  const dir = runtime.makeTempDirSync({ prefix: "opensac-reset-" });
  try {
    const dbPath = rootDatabasePath(dir);
    const sources = [dbPath, dbPath + "-wal", dbPath + "-shm"];
    for (const source of sources) {
      runtime.writeTextFileSync(source, path.basename(source));
    }
    const backupPath = path.join(dir, "sessions.db.pure-test.bak");
    // The -shm destination is an existing directory, so its rename fails while
    // the first two moves already succeeded.
    runtime.mkdirSync(backupPath + "-shm");

    let caught: unknown;
    try {
      moveDatabaseFiles(dbPath, sources, backupPath);
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof DatabaseMoveError, "expected a move failure");
    const moveError = caught as DatabaseMoveError;
    assert(String(moveError.message).includes(dbPath + "-shm"));
    for (const source of [dbPath, dbPath + "-wal"]) {
      assert(runtime.statSync(source).isFile, `${source} not restored`);
    }
    assertEquals(moveError.restored.length, 2);
    assertEquals(moveError.restored[0].to, dbPath);
    assert(!fileExists(backupPath));
    assert(!fileExists(backupPath + "-wal"));
  } finally {
    closeAll();
  }
});

test("reset backup path avoids occupied names", () => {
  const dir = runtime.makeTempDirSync({ prefix: "opensac-reset-" });
  try {
    const dbPath = rootDatabasePath(dir);
    const stamp = utcStamp();
    const occupied = `${dbPath}.pure-${stamp}.bak`;
    runtime.writeTextFileSync(occupied, "x");
    runtime.writeTextFileSync(occupied + "-wal", "x");

    const candidate = resetBackupPath(dbPath);
    assert(candidate !== occupied);
    assert(!fileExists(candidate));
    assert(
      path.basename(candidate).startsWith(path.basename(dbPath) + ".pure-"),
    );
    assert(candidate.endsWith(".bak"));
  } finally {
    closeAll();
  }
});

test("reset database reports what it left behind", () => {
  const dir = runtime.makeTempDirSync({ prefix: "opensac-reset-" });
  try {
    runtime.mkdirSync(path.join(dir, "artifacts", "attachment-1"), {
      recursive: true,
    });
    runtime.writeFileSync(
      path.join(dir, "artifacts", "attachment-1", "content"),
      new Uint8Array(4096),
    );
    runtime.writeTextFileSync(path.join(dir, "notes.txt"), "keep me");

    const report: ResetReport = resetDatabase(dir);
    const byName = new Map<string, LeftBehindEntry>();
    for (const entry of report.leftBehind) byName.set(entry.name, entry);
    assertEquals(byName.size, 2);
    const artifacts = byName.get("artifacts");
    assert(artifacts !== undefined && artifacts.directory);
    assertEquals(artifacts!.bytes, 4096);
    const notes = byName.get("notes.txt");
    assert(notes !== undefined && !notes.directory);
    assertEquals(notes!.bytes, "keep me".length);
    for (const entry of report.leftBehind) {
      assert(
        !entry.name.startsWith(path.basename(rootDatabasePath(dir))),
        "reset reported its own database files as left behind",
      );
    }
  } finally {
    closeAll();
  }
});

function fileExists(p: string): boolean {
  try {
    runtime.statSync(p);
    return true;
  } catch (err) {
    if (err instanceof runtime.errors.NotFound) return false;
    throw err;
  }
}

function utcStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(
    now.getUTCDate(),
  )}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(
    now.getUTCSeconds(),
  )}Z`;
}
