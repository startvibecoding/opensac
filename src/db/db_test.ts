import { runtime } from "../platform/runtime.ts";
import { assert, assertEquals, assertThrows } from "../compat/assert.ts";
import {
  close,
  closeAll,
  type DB,
  open,
  openReadOnlyStandalone,
  runInTx,
  schemaIncompatible,
  takeMigrationRecoveries,
} from "./mod.ts";
import { test } from "#testing";

function tempDbPath(name: string): string {
  const dir = runtime.makeTempDirSync({ prefix: "opensac-db-test-" });
  return `${dir}/${name}`;
}

test("open caches connections by canonical path", () => {
  const p = tempDbPath("a.db");
  const a = open(p);
  const b = open(p);
  assert(a === b, "second open must return the cached connection");
  closeAll();
});

test("open enables WAL and runs the migrator once", () => {
  const p = tempDbPath("b.db");
  let runs = 0;
  const db = open(p, (conn) => {
    runs++;
    conn.exec("CREATE TABLE t(a INTEGER, b TEXT)");
  });
  assertEquals(runs, 1);
  const row = db.get<Record<string, unknown>>("PRAGMA journal_mode");
  assertEquals(String(Object.values(row!)[0]).toLowerCase(), "wal");
  db.run("INSERT INTO t VALUES (?, ?)", 1, "x");
  assertEquals(db.query("SELECT * FROM t"), [{ a: 1, b: "x" }]);
  closeAll();
});

test("write runs a transaction and commits", () => {
  const p = tempDbPath("c.db");
  const db = open(p, (conn) => conn.exec("CREATE TABLE t(a INTEGER)"));
  const result = runInTx(db, (conn) => {
    conn.run("INSERT INTO t VALUES (1)");
    conn.run("INSERT INTO t VALUES (2)");
    return 42;
  });
  assertEquals(result, 42);
  assertEquals(
    db.query<{ a: number }>("SELECT a FROM t").map((r) => r.a),
    [1, 2],
  );
  closeAll();
});

test("write rolls back on error", () => {
  const p = tempDbPath("d.db");
  const db = open(p, (conn) => conn.exec("CREATE TABLE t(a INTEGER)"));
  assertThrows(() =>
    runInTx(db, (conn) => {
      conn.run("INSERT INTO t VALUES (1)");
      throw new Error("boom");
    }),
  );
  assertEquals(db.query("SELECT a FROM t"), []);
  closeAll();
});

test("schema-incompatible migration is backed up and rebuilt", () => {
  const p = tempDbPath("e.db");
  // The migrator creates the schema, but refuses a legacy database the way a
  // real migration would: on the rebuilt (empty) database it succeeds.
  const migrator = (conn: DB) => {
    const hasLegacy =
      conn.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='legacy'",
      ).length > 0;
    if (hasLegacy) throw schemaIncompatible(new Error("legacy schema"));
    conn.exec("CREATE TABLE legacy(a INTEGER)");
  };

  // First open: a healthy database with the legacy table.
  const first = open(p, migrator);
  first.run("INSERT INTO legacy VALUES (1)");
  close(p);

  takeMigrationRecoveries();
  const rebuilt = open(p, migrator);
  const recoveries = takeMigrationRecoveries();
  assertEquals(recoveries.length, 1);
  assert(recoveries[0].backupPath.endsWith(".bak"));
  assert(runtime.statSync(recoveries[0].backupPath).isFile);
  // The rebuilt database is fresh: the legacy row is gone, the schema is new.
  assertEquals(rebuilt.query("SELECT a FROM legacy"), []);
  rebuilt.run("INSERT INTO legacy VALUES (7)");
  assertEquals(rebuilt.query("SELECT a FROM legacy"), [{ a: 7 }]);
  closeAll();
});

test("non-incompatible migration error is reported unchanged", () => {
  const p = tempDbPath("f.db");
  assertThrows(
    () =>
      open(p, () => {
        throw new Error("plain failure");
      }),
    Error,
    "apply database migration: plain failure",
  );
  assertEquals(takeMigrationRecoveries().length, 0);
  closeAll();
});

test("read-only standalone opens an existing database", () => {
  const p = tempDbPath("g.db");
  const db = open(p, (conn) => conn.exec("CREATE TABLE t(a INTEGER)"));
  db.run("INSERT INTO t VALUES (1)");
  close(p);

  const ro = openReadOnlyStandalone(p);
  assertEquals(ro.query("SELECT a FROM t"), [{ a: 1 }]);
  assertThrows(() => ro.run("INSERT INTO t VALUES (2)"));
  ro.close();
  closeAll();
});
