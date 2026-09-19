// Translated from internal/esm/runtime_core_test.go

import { assert, assertEquals } from "@std/assert";
import {
  ErrDeadlineExceeded,
  longTaskMaxIterations,
  newRoleIncompleteError,
  recoveryObserverTimeout,
  roleAudit,
  roleContext,
  roleCritic,
  roleRecovery,
  roleWorker,
  Supervisor,
} from "./runtime_core.ts";
import {
  canAutoRun,
  statusActive,
  statusBlocked,
  statusComplete,
  statusPaused,
} from "./state.ts";
import {
  cleanup,
  makeStore,
  RuntimeTestAdapter,
  RuntimeTestEvents,
} from "./test_helpers.ts";

const continueResponse =
  '{"status":"continue","summary":"progress","evidence":["inspection"],"remaining_work":["finish"],"blockers":[]}';
const completeWorkerResponse =
  '{"status":"complete_candidate","summary":"done","evidence":["tests pass"],"remaining_work":[],"blockers":[]}';
const passReview = (review: string) =>
  `{"verdict":"pass","review":"${review}","requirements_checked":["objective -> covered"],"missing_work":[],"evidence":["read source"]}`;

Deno.test("RoleContext leaves long-running roles without a deadline", () => {
  const scope = roleContext(undefined, roleWorker);
  assertEquals(scope.timeoutMs, 0);
  assert(!scope.signal.aborted);
});

Deno.test("RoleContext bounds the recovery observer", () => {
  const scope = roleContext(undefined, roleRecovery);
  assertEquals(scope.timeoutMs, recoveryObserverTimeout);
  scope.cancel();
});

Deno.test("Supervisor worker continue stops at active", async () => {
  const { store, sessionID } = makeStore("mothx-esm-rt-");
  try {
    store.create(sessionID, "finish the objective");
    const adapter = new RuntimeTestAdapter({ [roleWorker]: continueResponse });
    const { objective: obj, error } = await new Supervisor({ store, adapter })
      .run(sessionID, "run-1", Deno.makeTempDirSync(), "agent");
    assertEquals(error, null);
    assertEquals(obj!.status, statusActive);
    assertEquals(adapter.roles, [roleWorker]);
  } finally {
    cleanup();
  }
});

Deno.test("Supervisor completion uses critic then audit", async () => {
  const { store, sessionID } = makeStore("mothx-esm-rt-");
  try {
    store.create(sessionID, "finish the objective");
    const adapter = new RuntimeTestAdapter({
      [roleWorker]: completeWorkerResponse,
      [roleCritic]: passReview("critic verified"),
      [roleAudit]: passReview("audit verified"),
    });
    const { objective: obj } = await new Supervisor({ store, adapter }).run(
      sessionID,
      "run-1",
      Deno.makeTempDirSync(),
      "agent",
    );
    assertEquals(obj!.status, statusComplete);
    assertEquals(adapter.roles, [roleWorker, roleCritic, roleAudit]);
  } finally {
    cleanup();
  }
});

Deno.test("Supervisor publishes lifecycle events", async () => {
  const { store, sessionID } = makeStore("mothx-esm-rt-");
  try {
    store.create(sessionID, "finish the objective");
    const adapter = new RuntimeTestAdapter({ [roleWorker]: continueResponse });
    const events = new RuntimeTestEvents();
    await new Supervisor({ store, adapter, events }).run(
      sessionID,
      "run-events",
      Deno.makeTempDirSync(),
      "agent",
    );
    assertEquals(events.events.length, 2);
    assertEquals(events.events[0].type, "role_started");
    assertEquals(events.events[1].type, "role_finished");
  } finally {
    cleanup();
  }
});

Deno.test("Supervisor repeated recovery stays active and uses observer", async () => {
  const { store, sessionID } = makeStore("mothx-esm-rt-");
  try {
    store.create(sessionID, "finish the objective");
    for (let i = 0; i < 5; i++) {
      store.recordRecovery(sessionID, "previous interruption", "retry", [
        "finish",
      ]);
    }
    const adapter = new RuntimeTestAdapter();
    adapter.roleErr = ErrDeadlineExceeded;
    const { objective: obj, error } = await new Supervisor({ store, adapter })
      .run(sessionID, "run-limit", Deno.makeTempDirSync(), "agent");
    assertEquals(error, null);
    assertEquals(obj!.status, statusActive);
    assertEquals(obj!.recoveryCount, 6);
    assertEquals(adapter.observers, 1);
  } finally {
    cleanup();
  }
});

Deno.test("Supervisor incomplete role recovers and keeps objective active", async () => {
  const { store, sessionID } = makeStore("mothx-esm-rt-");
  try {
    store.create(sessionID, "finish the objective");
    const adapter = new RuntimeTestAdapter();
    adapter.roleErr = newRoleIncompleteError(roleWorker, "max_iterations");
    const { objective: obj, error } = await new Supervisor({ store, adapter })
      .run(sessionID, "run-incomplete", Deno.makeTempDirSync(), "yolo");
    assertEquals(error, null);
    assertEquals(obj!.status, statusActive);
    assertEquals(obj!.recoveryCount, 1);
    assert(canAutoRun(obj!));
  } finally {
    cleanup();
  }
});

Deno.test("Supervisor roles use unbounded long-task iterations", async () => {
  const { store, sessionID } = makeStore("mothx-esm-rt-");
  try {
    store.create(sessionID, "finish the objective");
    const adapter = new RuntimeTestAdapter({
      [roleWorker]: completeWorkerResponse,
      [roleCritic]: passReview("critic verified"),
      [roleAudit]: passReview("audit verified"),
    });
    await new Supervisor({ store, adapter }).run(
      sessionID,
      "run-unbounded",
      Deno.makeTempDirSync(),
      "yolo",
    );
    for (const role of [roleWorker, roleCritic, roleAudit]) {
      assertEquals(
        adapter.requests.get(role)!.maxIterations,
        longTaskMaxIterations,
      );
    }
  } finally {
    cleanup();
  }
});

Deno.test("Supervisor non-retryable failure pauses until explicit resume", async () => {
  const { store, sessionID } = makeStore("mothx-esm-rt-");
  try {
    store.create(sessionID, "finish the objective");
    const wantErr = new Error("provider rejected the request");
    const adapter = new RuntimeTestAdapter();
    adapter.roleErr = wantErr;
    const { objective: obj, error } = await new Supervisor({ store, adapter })
      .run(sessionID, "run-failed", Deno.makeTempDirSync(), "yolo");
    assert(error === wantErr, "Run error should be the original failure");
    assertEquals(obj!.status, statusPaused);
    assert(!canAutoRun(obj!));
    assertEquals(store.get(sessionID).status, statusPaused);
  } finally {
    cleanup();
  }
});

Deno.test("Supervisor shared store persists across runtime instances", async () => {
  const { store, sessionID } = makeStore("mothx-esm-rt-");
  try {
    store.create(sessionID, "finish the objective");
    const first = new RuntimeTestAdapter({ [roleWorker]: continueResponse });
    const second = new RuntimeTestAdapter({ [roleWorker]: continueResponse });
    await new Supervisor({ store, adapter: first }).run(
      sessionID,
      "tui-run",
      Deno.makeTempDirSync(),
      "agent",
    );
    await new Supervisor({ store, adapter: second }).run(
      sessionID,
      "webui-run",
      Deno.makeTempDirSync(),
      "agent",
    );
    const obj = store.get(sessionID);
    assertEquals(obj.progressSummary, "progress");
    assertEquals(first.roles.length, 1);
    assertEquals(second.roles.length, 1);
  } finally {
    cleanup();
  }
});

Deno.test("Supervisor rejected completions continue across continuations", async () => {
  const { store, sessionID } = makeStore("mothx-esm-rt-");
  try {
    store.create(sessionID, "finish the objective");
    const adapter = new RuntimeTestAdapter({
      [roleWorker]: completeWorkerResponse,
      [roleCritic]:
        '{"verdict":"fail","review":"missing regression tests","requirements_checked":["objective -> gap"],"missing_work":["add regression tests"],"evidence":["read source"]}',
    });
    for (let i = 1; i <= 4; i++) {
      const { objective: obj, error } = await new Supervisor({ store, adapter })
        .run(sessionID, `run-${i}`, Deno.makeTempDirSync(), "yolo");
      assertEquals(error, null);
      assertEquals(obj!.status, statusActive);
      assertEquals(obj!.rejectionCount, i);
      assert(canAutoRun(obj!));
    }
    assert(canAutoRun(store.get(sessionID)));
  } finally {
    cleanup();
  }
});

Deno.test("Supervisor blocked audit accumulates across continuations", async () => {
  const { store, sessionID } = makeStore("mothx-esm-rt-");
  try {
    store.create(sessionID, "finish the objective");
    const blocked = new RuntimeTestAdapter({
      [roleWorker]:
        '{"status":"blocked_candidate","summary":"cannot proceed","evidence":["attempted provisioning"],"remaining_work":[],"blockers":["missing API token"]}',
    });
    const continuing = new RuntimeTestAdapter({
      [roleWorker]: continueResponse,
    });

    let res = await new Supervisor({ store, adapter: blocked }).run(
      sessionID,
      "run-1",
      Deno.makeTempDirSync(),
      "yolo",
    );
    assertEquals(res.objective!.status, statusActive);
    assertEquals(res.objective!.blockedCount, 1);

    // A continuation that finishes without the blocker clears the streak.
    res = await new Supervisor({ store, adapter: continuing }).run(
      sessionID,
      "run-2",
      Deno.makeTempDirSync(),
      "yolo",
    );
    assertEquals(res.objective!.blockedCount, 0);

    let obj = res.objective!;
    for (let i = 3; i <= 5; i++) {
      const r = await new Supervisor({ store, adapter: blocked }).run(
        sessionID,
        `run-${i}`,
        Deno.makeTempDirSync(),
        "yolo",
      );
      obj = r.objective!;
    }
    assertEquals(obj.status, statusBlocked);
  } finally {
    cleanup();
  }
});
