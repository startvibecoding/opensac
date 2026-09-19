// Ported from internal/session/runtime_lease_status_test.go
//
// The Manager-based holder setup is replaced with a direct lease row so the
// preflight itself is exercised without the not-yet-ported session Manager.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { closeAll, openStandalone } from "../db/mod.ts";
import { RuntimeLeaseDAO, type RuntimeLeaseRecord } from "../dao/mod.ts";
import { openRootDB, rootDBPath } from "./root_db.ts";
import {
  activeRuntimeLeases,
  describeActiveRuntimeLease,
} from "./runtime_lease_status.ts";

Deno.test("active runtime leases reports held holders", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "mothx-session-" });
  try {
    // No database yet: nothing is held, and a read-only preflight must not
    // initialize the file it is only inspecting.
    assertEquals(activeRuntimeLeases(sessionDir), []);
    assertThrows(() => Deno.statSync(rootDBPath(sessionDir)));

    const db = openRootDB(sessionDir);
    const executor = db.db!;
    const now = Math.floor(Date.now() / 1000);
    const record: RuntimeLeaseRecord = {
      sessionId: "lease-holder",
      ownerId: "owner-live",
      ownerPid: Deno.pid,
      ownerKind: "process",
      tokenHash: "token-live",
      epoch: 1,
      runId: "run-1",
      purpose: "run",
      state: "active",
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: now + 60,
      updatedAt: now,
    };
    new RuntimeLeaseDAO(executor).insert(executor, record);
    // A lapsed row without a takeover still belongs to its original owner.
    const past = now - 60;
    new RuntimeLeaseDAO(executor).insert(executor, {
      ...record,
      sessionId: "lease-expired",
      ownerId: "owner-gone",
      tokenHash: "token-gone",
      runId: "run-gone",
      acquiredAt: past,
      heartbeatAt: past,
      expiresAt: past,
      updatedAt: past,
    });

    const leases = activeRuntimeLeases(sessionDir);
    assertEquals(leases.length, 2);
    const holder = leases.find((lease) => lease.sessionId === "lease-holder");
    assert(holder !== undefined);
    assertEquals(holder.ownerPid, Deno.pid);
    assertEquals(holder.purpose, "run");
    const description = describeActiveRuntimeLease(holder);
    assert(description.includes("lease-holder"));
    assert(description.includes("run"));
  } finally {
    closeAll();
  }
});

Deno.test("active runtime leases never migrates the preflight database", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "mothx-session-" });
  try {
    const pathValue = rootDBPath(sessionDir);
    const standalone = openStandalone(pathValue, (db) => {
      db.exec(`CREATE TABLE session_runtime_leases (
        session_id TEXT PRIMARY KEY,
        owner_instance_id TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        owner_kind TEXT NOT NULL,
        lease_token_hash TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        run_id TEXT NOT NULL,
        purpose TEXT NOT NULL,
        state TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    });
    standalone.close();
    const before = Deno.readFileSync(pathValue);

    assertEquals(activeRuntimeLeases(sessionDir), []);

    const after = Deno.readFileSync(pathValue);
    assertEquals(
      before.length,
      after.length,
      "the lease preflight modified the database it inspected",
    );
    for (let i = 0; i < before.length; i++) {
      assertEquals(before[i], after[i], `byte ${i} differs`);
    }
  } finally {
    closeAll();
  }
});
