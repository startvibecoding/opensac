import { assert, assertEquals } from "@std/assert";
import { formatTime } from "./store.ts";
import { roleWorker, Supervisor } from "./runtime_core.ts";
import { cleanup, makeStore, RuntimeTestAdapter } from "./test_helpers.ts";

Deno.test("Store addGuidance stamps objective version", () => {
  const { store, sessionID } = makeStore("opensac-esm-guidance-");
  try {
    const obj = store.create(sessionID, "finish the objective");
    store.addGuidance(sessionID, "focus on failing tests");
    const pending = store.pendingGuidance(sessionID);
    assertEquals(pending.length, 1);
    assertEquals(pending[0].guidance, "focus on failing tests");
    assertEquals(pending[0].status, "pending");
    assertEquals(pending[0].objectiveVersion, formatTime(obj.updatedAt));

    let threw = false;
    try {
      store.addGuidance(sessionID, "   ");
    } catch {
      threw = true;
    }
    assert(threw, "empty guidance should fail");

    threw = false;
    try {
      store.addGuidance("missing-session", "text");
    } catch {
      threw = true;
    }
    assert(threw, "guidance without an objective should fail");
  } finally {
    cleanup();
  }
});

Deno.test("Supervisor injects and consumes guidance for worker", async () => {
  const { store, sessionID } = makeStore("opensac-esm-guidance-");
  try {
    store.create(sessionID, "finish the objective");
    store.addGuidance(sessionID, "prioritize the failing tests");

    const adapter = new RuntimeTestAdapter({
      [roleWorker]:
        '{"status":"continue","summary":"progress","evidence":["inspection"],"remaining_work":["finish"],"blockers":[]}',
    });
    const supervisor = new Supervisor({ store, adapter });
    const { objective: obj, error } = await supervisor.run(
      sessionID,
      "run-guidance",
      Deno.makeTempDirSync(),
      "yolo",
    );
    assertEquals(error, null);
    assertEquals(obj!.status, "active");

    const prompt = adapter.prompts.get(roleWorker) ?? "";
    assert(prompt.includes("User guidance queued for this objective"));
    assert(prompt.includes("prioritize the failing tests"));
    assertEquals(store.pendingGuidance(sessionID).length, 0);
  } finally {
    cleanup();
  }
});

Deno.test("Supervisor keeps guidance when role fails", async () => {
  const { store, sessionID } = makeStore("opensac-esm-guidance-");
  try {
    store.create(sessionID, "finish the objective");
    store.addGuidance(sessionID, "prioritize the failing tests");

    const adapter = new RuntimeTestAdapter();
    adapter.roleErr = new DOMException("canceled", "AbortError");
    const supervisor = new Supervisor({ store, adapter });
    const { error } = await supervisor.run(
      sessionID,
      "run-fail",
      Deno.makeTempDirSync(),
      "yolo",
    );
    assert(error !== null, "Run should surface the role failure");
    assertEquals(store.pendingGuidance(sessionID).length, 1);
  } finally {
    cleanup();
  }
});
