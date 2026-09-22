// Adapted from internal/session/database_recovery_notice_test.go

import { assert, assertEquals, assertFalse } from "@std/assert";
import * as path from "@std/path";
import { closeAll } from "../db/mod.ts";
import { type DatabaseRecovery, takeDatabaseRecoveries } from "./database.ts";
import { handlePeerDatabaseRebuilt } from "./database_recovery_notice.ts";
import { closeDatabases, openRootDB, rootDBPath } from "./root_db.ts";
import {
  runtimeLeaseBusAddresses,
  runtimeLeaseBusVersion,
  validRuntimeLeaseNotification,
} from "./runtime_lease_bus.ts";

Deno.test("database rebuild notice validation", () => {
  const base = {
    version: runtimeLeaseBusVersion,
    messageId: "message-1",
    type: "database_rebuilt",
    originInstanceId: "instance-1",
  };
  assert(
    validRuntimeLeaseNotification({
      ...base,
      path: path.join("/tmp", "sessions", "sessions.db"),
    }),
    "a rebuild notice with a path is valid without a session ID",
  );
  assertFalse(
    validRuntimeLeaseNotification({ ...base }),
    "a rebuild notice without a path is rejected",
  );
  assertFalse(
    validRuntimeLeaseNotification({
      version: runtimeLeaseBusVersion,
      messageId: "message-2",
      type: "state_changed",
      originInstanceId: "instance-1",
    }),
    "a lease notification without a session ID stays invalid",
  );
});

Deno.test("broadcast stays on loopback regardless of scope", () => {
  const previousPort = Deno.env.get("OPENSAC_RUNTIME_BUS_PORT");
  const previousScope = Deno.env.get("OPENSAC_RUNTIME_BUS_SCOPE");
  Deno.env.set("OPENSAC_RUNTIME_BUS_PORT", "49371");
  try {
    for (const scope of ["", "host", "lan", "255.255.255.255"]) {
      Deno.env.set("OPENSAC_RUNTIME_BUS_SCOPE", scope);
      const { listenHost, listenPort, broadcast } = runtimeLeaseBusAddresses();
      assertEquals(broadcast, "127.255.255.255");
      assertEquals(listenHost, "0.0.0.0");
      assertEquals(listenPort, 49371);
    }
  } finally {
    if (previousPort === undefined) Deno.env.delete("OPENSAC_RUNTIME_BUS_PORT");
    else Deno.env.set("OPENSAC_RUNTIME_BUS_PORT", previousPort);
    if (previousScope === undefined) {
      Deno.env.delete("OPENSAC_RUNTIME_BUS_SCOPE");
    } else Deno.env.set("OPENSAC_RUNTIME_BUS_SCOPE", previousScope);
  }
});

Deno.test("peer database rebuild retires the cached connection", () => {
  takeDatabaseRecoveries();
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-peer-" });
  const dbPath = rootDBPath(sessionDir);
  try {
    const cached = openRootDB(sessionDir);

    const notices: DatabaseRecovery[] = [];
    handlePeerDatabaseRebuilt(
      path.join(sessionDir, ".", "sessions.db"),
      (recovery) => notices.push(recovery),
    );

    const reopened = openRootDB(sessionDir);
    assert(reopened !== cached, "cached connection was not retired");

    assertEquals(notices.length, 1);
    assert(notices[0].peer);
    assertEquals(notices[0].path, path.normalize(dbPath));

    const drained = takeDatabaseRecoveries();
    assertEquals(drained.length, 1);
    assert(drained[0].peer);
    assertEquals(takeDatabaseRecoveries().length, 0);
  } finally {
    closeDatabases();
    closeAll();
  }
});

Deno.test("peer database rebuild ignores an empty path", () => {
  takeDatabaseRecoveries();
  handlePeerDatabaseRebuilt("", null);
  assertEquals(takeDatabaseRecoveries().length, 0);
});
