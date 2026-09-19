// Ported from internal/session/decision_events_test.go

import { assert, assertFalse } from "@std/assert";
import { decisionEventType, isDecisionEventType } from "./decision_events.ts";

Deno.test("is decision event type", () => {
  for (
    const eventType of [
      "decision_pending",
      "decision_requested",
      "decision_resolved",
      "decision_cancelled",
      "decision_timed_out",
      "approval_requested",
      "question_requested",
      "approval_resolved",
      "question_resolved",
    ]
  ) {
    assert(
      isDecisionEventType(eventType),
      `${eventType} should be a decision event`,
    );
  }
  for (
    const eventType of [
      "",
      "started",
      "finished",
      "decision_deadline",
      "decision",
    ]
  ) {
    assertFalse(
      isDecisionEventType(eventType),
      `${eventType} should not be a decision event`,
    );
  }
});

Deno.test("decision event type derives canonical name", () => {
  assert(decisionEventType("pending") === "decision_pending");
  assert(decisionEventType("timed_out") === "decision_timed_out");
});
