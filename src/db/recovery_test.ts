import { assert, assertEquals } from "@std/assert";
import {
  closeAll,
  describeMigrationRecovery,
  isSchemaIncompatible,
  migrationRecoveries,
  openStandalone,
  recoverFromMigrationFailure,
  removeDatabaseFiles,
  schemaIncompatible,
  setMigrationRecoveryNotifier,
  takeMigrationRecoveries,
} from "./mod.ts";
import { recordMigrationRecovery } from "./recovery.ts";

Deno.test("describeMigrationRecovery covers peer, fresh, and backup rebuilds", () => {
  assertEquals(
    describeMigrationRecovery({
      path: "/data/sessions.db",
      backupPath: "",
      err: new Error("legacy schema"),
      peer: true,
      at: new Date("2026-01-01T00:00:00Z"),
    }),
    "another OpenSAC process rebuilt the database at /data/sessions.db after a failed migration",
  );
  assertEquals(
    describeMigrationRecovery({
      path: "/data/sessions.db",
      backupPath: "",
      err: new Error("legacy schema"),
      peer: false,
      at: new Date("2026-01-01T00:00:00Z"),
    }),
    "database migration failed for /data/sessions.db (legacy schema); started a new empty database",
  );
  assertEquals(
    describeMigrationRecovery({
      path: "/data/sessions.db",
      backupPath: "/data/sessions.db.migration-failed-20260101T000000Z.bak",
      err: new Error("legacy schema"),
      peer: false,
      at: new Date("2026-01-01T00:00:00Z"),
    }),
    "database migration failed for /data/sessions.db (legacy schema); backed up the previous database to /data/sessions.db.migration-failed-20260101T000000Z.bak and started a new empty database",
  );
  assertEquals(
    describeMigrationRecovery({
      path: "/data/sessions.db",
      backupPath: "",
      err: "string failure",
      peer: false,
      at: new Date("2026-01-01T00:00:00Z"),
    }),
    "database migration failed for /data/sessions.db (string failure); started a new empty database",
  );
});

// TestSchemaIncompatibleSurvivesWrapping pins the errors.As-style marker walk:
// the rebuild decision must still be visible through %w-style wrapping.
Deno.test("isSchemaIncompatible walks the wrapped cause chain", () => {
  assertEquals(isSchemaIncompatible(schemaIncompatible(undefined)), false);
  assertEquals(isSchemaIncompatible(undefined), false);
  assertEquals(isSchemaIncompatible(null), false);
  assertEquals(isSchemaIncompatible(new Error("plain")), false);
  assertEquals(isSchemaIncompatible({ message: "plain" }), false);

  const marker = schemaIncompatible(new Error("legacy schema"));
  assert(isSchemaIncompatible(marker));

  const wrappedOnce = new Error("apply database migration: legacy schema", {
    cause: marker,
  });
  assert(isSchemaIncompatible(wrappedOnce), "one wrap level stays visible");

  const wrappedTwice = new Error("open database", { cause: wrappedOnce });
  assert(isSchemaIncompatible(wrappedTwice), "two wrap levels stay visible");
});

// TestMigrationRecoveryLogDrainsOnce guards the "tell the user exactly once"
// contract: migrationRecoveries observes without draining, take drains.
Deno.test("migration recovery log observes and drains", () => {
  takeMigrationRecoveries();
  const seen: string[] = [];
  setMigrationRecoveryNotifier((recovery) => seen.push(recovery.path));
  try {
    const recovery = {
      path: "/data/sessions.db",
      backupPath: "/data/sessions.db.bak",
      err: new Error("legacy schema"),
      peer: false,
      at: new Date("2026-01-01T00:00:00Z"),
    };
    recordMigrationRecovery(recovery);
    assertEquals(seen, ["/data/sessions.db"]);
    assertEquals(migrationRecoveries().length, 1, "observing keeps the entry");

    const taken = takeMigrationRecoveries();
    assertEquals(taken.length, 1);
    assertEquals(migrationRecoveries(), [], "taking drains the log");
    assertEquals(takeMigrationRecoveries(), []);
  } finally {
    setMigrationRecoveryNotifier(null);
    takeMigrationRecoveries();
  }
});

Deno.test("removeDatabaseFiles removes the database and its sidecars", () => {
  const dir = Deno.makeTempDirSync({ prefix: "opensac-db-remove-test-" });
  const path = `${dir}/sessions.db`;
  try {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      Deno.writeTextFileSync(path + suffix, "x");
    }
    removeDatabaseFiles(path);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        Deno.statSync(path + suffix);
        throw new Error(`expected ${path + suffix} to be removed`);
      } catch (err) {
        assert(
          err instanceof Deno.errors.NotFound,
          `unexpected error for ${path + suffix}: ${err}`,
        );
      }
    }
    // Removing an already-removed database is not an error.
    removeDatabaseFiles(path);
  } finally {
    Deno.removeSync(dir, { recursive: true });
    closeAll();
  }
});

// TestRecoverFromMigrationFailureSnapshotsAndClears exercises the real rebuild
// path: the connection is snapshotted with VACUUM INTO, closed, and the
// unrecoverable file set is deleted so the next open starts clean.
Deno.test("recoverFromMigrationFailure snapshots and clears the database", () => {
  const dir = Deno.makeTempDirSync({ prefix: "opensac-db-recovery-test-" });
  const path = `${dir}/sessions.db`;
  try {
    const connection = openStandalone(
      path,
      (conn) => conn.exec("CREATE TABLE legacy(a INTEGER)"),
    );
    connection.run("INSERT INTO legacy VALUES (1)");

    const recovery = recoverFromMigrationFailure(
      connection,
      path,
      schemaIncompatible(new Error("legacy schema")),
    );
    assertEquals(recovery.path, path);
    assertEquals(recovery.peer, false);
    assertEquals(recovery.err instanceof Error, true);
    assert(
      recovery.backupPath.endsWith(".bak"),
      `unexpected backup path ${recovery.backupPath}`,
    );
    assert(
      Deno.statSync(recovery.backupPath).isFile,
      "the snapshot must exist",
    );
    let closed = false;
    try {
      connection.query("SELECT 1");
    } catch {
      closed = true;
    }
    assert(closed, "the failed connection must be closed");

    try {
      Deno.statSync(path);
      throw new Error("the unrecoverable database must be removed");
    } catch (err) {
      assert(
        err instanceof Deno.errors.NotFound,
        `unexpected error for ${path}: ${err}`,
      );
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
    closeAll();
  }
});
