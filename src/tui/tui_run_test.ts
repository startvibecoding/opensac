// Focused tests for the TuiRun adapter: decision registration (duplicate
// errors), the RunHandle contract over DecisionService, terminal decision
// status mapping, and resolve persistence commits.

import { assertEquals, assertThrows } from "@std/assert";
import { decisionTerminalStatus, TuiRun } from "./tui_run.ts";
import { DecisionService } from "../agentruntime/decision.ts";

Deno.test("decisionTerminalStatus maps only cancellation to cancelled", () => {
  assertEquals(decisionTerminalStatus("cancelled"), "cancelled");
  assertEquals(decisionTerminalStatus("cancelling"), "cancelled");
  assertEquals(decisionTerminalStatus("completed"), "timed_out");
  assertEquals(decisionTerminalStatus("failed"), "timed_out");
  assertEquals(decisionTerminalStatus("incomplete"), "timed_out");
  assertEquals(decisionTerminalStatus("timed_out"), "timed_out");
});

Deno.test("TuiRun registers decisions through the DecisionService", () => {
  const decisions = new DecisionService();
  const run = new TuiRun({
    decisions,
    runId: "run-1",
    sessionId: "s1",
    sessionDir: "/tmp/no-sink",
  });
  assertEquals(run.registerDecision("ap-1", "approval"), undefined);
  assertEquals(
    run.registerDecision("ap-1", "approval"),
    "decision already pending: ap-1",
  );
  // resolve consumes the id; a resolved id can never re-register
  run.resolveDecision("ap-1", "approval", "true");
  assertEquals(
    run.registerDecision("ap-1", "approval"),
    "decision was already resolved: ap-1 (resolved)",
  );
  assertEquals(run.registerDecision("ap-2", "approval"), undefined);
});

Deno.test("TuiRun validates kind and required ids through the service", () => {
  const run = new TuiRun({
    decisions: new DecisionService(),
    runId: "run-1",
    sessionId: "s1",
  });
  assertThrows(
    () =>
      run.decisions!.register({
        id: "x",
        runId: "",
        sessionId: "s1",
        kind: "approval",
      }),
    Error,
    "run ID are required",
  );
  assertEquals(run.registerDecision("q-1", "question"), undefined);
});

Deno.test("clearDecisions terminalizes pending decisions per state", () => {
  const run = new TuiRun({
    decisions: new DecisionService(),
    runId: "run-1",
    sessionId: "s1",
  });
  // No sink: persist is a no-op; verify through the service's pending set.
  run.registerDecision("ap-1", "approval");
  run.registerDecision("q-1", "question");
  run.clearDecisions("completed");
  // Cleared ids were consumed; re-registration surfaces the resolved error
  // (the internal status label belongs to the service, not the TUI event —
  // the event status comes from decisionTerminalStatus via persistDecision).
  const err = run.registerDecision("ap-1", "approval") ?? "";
  assertEquals(err.includes("already resolved"), true);
});

Deno.test("TuiRun satisfies the RunHandle contract without a runtime", () => {
  const run = new TuiRun({ runId: "run-1" });
  // No decisions service: registration is a no-op success
  assertEquals(run.registerDecision("ap-1", "approval"), undefined);
  run.bindDecision("ap-1", () => {});
  run.finish("completed");
  run.cancel();
  run.resume();
  run.waitForApproval();
  run.waitForQuestion();
});
