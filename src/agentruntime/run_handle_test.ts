import { assertEquals } from "@std/assert";
import { DecisionService } from "./decision.ts";
import { RuntimeRun } from "./run_handle.ts";

Deno.test("RuntimeRun owns shared decision registration and terminalization", () => {
  const decisions = new DecisionService();
  const run = new RuntimeRun({
    decisions,
    runId: "run-1",
    sessionId: "session-1",
    sessionDir: "",
  });
  assertEquals(run.registerDecision("approval-1", "approval"), undefined);
  assertEquals(
    run.registerDecision("approval-1", "approval"),
    "decision already pending: approval-1",
  );
  run.resolveDecision("approval-1", "approval", "true");
  run.clearDecisions("completed");
  assertEquals(
    run.registerDecision("approval-1", "approval")?.includes(
      "already resolved",
    ),
    true,
  );
});
