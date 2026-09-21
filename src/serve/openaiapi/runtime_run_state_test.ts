// Focused tests for the WebUI status → canonical RunState mapping ported from
// internal/serve/openaiapi/runtime_run_state.go.
import { assertEquals } from "@std/assert";
import {
  RunStateCancelled,
  RunStateCancelling,
  RunStateCompleted,
  RunStateCreated,
  RunStateFailed,
  RunStateIncomplete,
  RunStateRunning,
  RunStateTimedOut,
  RunStateWaitingApproval,
  RunStateWaitingQuestion,
} from "../../agentruntime/run_state.ts";
import { webUIActiveRunState, webUIRunState } from "./runtime_run_state.ts";

Deno.test("webUIActiveRunState table", () => {
  assertEquals(webUIActiveRunState("created"), RunStateCreated);
  assertEquals(webUIActiveRunState("queued"), RunStateCreated);
  assertEquals(
    webUIActiveRunState("waiting_for_approval"),
    RunStateWaitingApproval,
  );
  assertEquals(
    webUIActiveRunState("waiting_for_question"),
    RunStateWaitingQuestion,
  );
  assertEquals(webUIActiveRunState("cancelling"), RunStateCancelling);
  assertEquals(webUIActiveRunState(" Running "), RunStateRunning);
  assertEquals(webUIActiveRunState(""), RunStateRunning);
});

Deno.test("webUIRunState terminal table", () => {
  assertEquals(webUIRunState("completed", ""), RunStateCompleted);
  assertEquals(webUIRunState("incomplete", ""), RunStateIncomplete);
  assertEquals(webUIRunState("cancelled", "user requested"), RunStateCancelled);
  assertEquals(webUIRunState("canceled", "user requested"), RunStateCancelled);
  assertEquals(
    webUIRunState("cancelled", "deadline exceeded"),
    RunStateTimedOut,
  );
  assertEquals(
    webUIRunState("cancelled", "context timed out"),
    RunStateTimedOut,
  );
  assertEquals(
    webUIRunState("cancelled", "provider TIMEOUT hit"),
    RunStateTimedOut,
  );
  assertEquals(webUIRunState("failed", "boom"), RunStateFailed);
  assertEquals(webUIRunState("", ""), RunStateFailed);
});
