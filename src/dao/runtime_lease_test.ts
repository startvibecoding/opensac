// Ported from internal/dao/runtime_lease_test.go

import { assertEquals } from "@std/assert";
import { RuntimeLeaseDAO, type RuntimeLeaseRecord } from "./mod.ts";
import { closeTestDbs, openTestDb } from "./test_util.ts";

// TestRuntimeLeaseRenewKeepsOwnExpiredRow guards the heartbeat fencing rules:
// an expired row that still carries the owner's identity stays renewable, while
// a displaced owner (epoch bumped by Acquire) can never renew again.
Deno.test("runtime lease renew keeps own expired row", () => {
  const database = openTestDb();
  try {
    const leaseDAO = new RuntimeLeaseDAO(database);
    const now = Math.floor(Date.now() / 1000);
    const past = now - 60;

    const stalled: RuntimeLeaseRecord = {
      sessionId: "session-stalled",
      ownerId: "owner-a",
      ownerPid: 1,
      ownerKind: "process",
      tokenHash: "token-a",
      epoch: 1,
      runId: "",
      purpose: "execution",
      state: "active",
      acquiredAt: past,
      heartbeatAt: past,
      expiresAt: past,
      updatedAt: past,
    };
    leaseDAO.insert(database, stalled);

    const renewed = leaseDAO.renew({
      sessionId: "session-stalled",
      ownerId: "owner-a",
      ownerPid: 0,
      ownerKind: "",
      tokenHash: "token-a",
      epoch: 1,
      runId: "",
      purpose: "",
      state: "",
      acquiredAt: 0,
      heartbeatAt: 0,
      expiresAt: 0,
      updatedAt: 0,
    }, 15);
    assertEquals(
      renewed,
      1,
      "the owner lost its live lease without a takeover",
    );

    const victim: RuntimeLeaseRecord = {
      ...stalled,
      sessionId: "session-takeover",
    };
    leaseDAO.insert(database, victim);
    const taken = leaseDAO.acquire(
      database,
      {
        ...stalled,
        sessionId: "session-takeover",
        ownerId: "owner-b",
        ownerPid: 2,
        ownerKind: "process",
        tokenHash: "token-b",
        epoch: 2,
        purpose: "recovery",
        expiresAt: now + 60,
      },
      1,
      now,
    );
    assertEquals(taken, 1, "Acquire takeover");

    const displaced = leaseDAO.renew({
      sessionId: "session-takeover",
      ownerId: "owner-a",
      ownerPid: 0,
      ownerKind: "",
      tokenHash: "token-a",
      epoch: 1,
      runId: "",
      purpose: "",
      state: "",
      acquiredAt: 0,
      heartbeatAt: 0,
      expiresAt: 0,
      updatedAt: 0,
    }, 15);
    assertEquals(displaced, 0, "fencing must hold");
  } finally {
    closeTestDbs();
  }
});
