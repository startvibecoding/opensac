// Ported from internal/agentruntime/decision_events_test.go.

import { assert, assertEquals, assertFalse } from "@std/assert";
import { DecisionApproval, DecisionQuestion } from "./decision.ts";
import {
  buildDecisionEvent,
  DecisionStatusPending,
  DecisionStatusResolved,
  decodeDecisionEvent,
  loadDecisionRecords,
  loadRunDecisionRecords,
  newDecisionRecord,
} from "./decision_events.ts";
import { replayDecisions } from "./decision_replay.ts";
import { SessionRunEventSink } from "./run_event.ts";
import type { SessionRunEvent } from "../session/session_events.ts";

Deno.test("Build and decode decision event round trip", () => {
  const deadline = new Date(Date.now() + 60_000);
  const event = buildDecisionEvent({
    request: {
      id: "approval-1",
      sessionId: "s-1",
      runId: "r-1",
      kind: DecisionApproval,
    },
    status: DecisionStatusPending,
    payload: { tool: "bash" },
    expiresAt: deadline,
    source: "tui",
  });
  assertEquals(event.eventType, "decision_pending");
  assertEquals(event.status, DecisionStatusPending);
  assertEquals(event.source, "tui");

  const record = decodeDecisionEvent({
    id: "",
    sessionId: "s-1",
    runId: "r-1",
    eventType: event.eventType,
    source: "",
    status: "",
    model: "",
    mode: "",
    timestamp: new Date(),
    data: event.data,
  });
  assert(record !== null);
  assertEquals(record.id, "approval-1");
  assertEquals(record.kind, DecisionApproval);
  assertEquals(record.status, DecisionStatusPending);
  assertEquals(record.sessionId, "s-1");
  assertEquals(record.runId, "r-1");
  assertEquals(record.expiresAt?.getTime(), deadline.getTime());
});

Deno.test("DecodeDecisionEvent defaults identity and rejects foreign", () => {
  const data = {
    decision: {
      id: "q-1",
      kind: DecisionQuestion,
      status: DecisionStatusPending,
    },
  };
  const record = decodeDecisionEvent({
    id: "",
    sessionId: "s-2",
    runId: "r-2",
    eventType: "question_requested",
    source: "",
    status: "",
    model: "",
    mode: "",
    timestamp: new Date(),
    data,
  });
  assert(record !== null);
  assertEquals(record.sessionId, "s-2");
  assertEquals(record.runId, "r-2");

  const foreign: Record<string, SessionRunEvent> = {
    "foreign type": {
      id: "",
      sessionId: "",
      runId: "",
      eventType: "started",
      source: "",
      status: "",
      model: "",
      mode: "",
      timestamp: new Date(),
      data,
    },
    "empty decision": {
      id: "",
      sessionId: "",
      runId: "",
      eventType: "decision_pending",
      source: "",
      status: "",
      model: "",
      mode: "",
      timestamp: new Date(),
      data: { decision: {} },
    },
    "malformed json": {
      id: "",
      sessionId: "",
      runId: "",
      eventType: "decision_pending",
      source: "",
      status: "",
      model: "",
      mode: "",
      timestamp: new Date(),
      data: "not json",
    },
    "unrelated prefix": {
      id: "",
      sessionId: "",
      runId: "",
      eventType: "decision_deadline",
      source: "",
      status: "",
      model: "",
      mode: "",
      timestamp: new Date(),
      data,
    },
  };
  for (const [name, event] of Object.entries(foreign)) {
    assertEquals(decodeDecisionEvent(event), null, name);
  }
});

Deno.test("NewDecisionRecord shape by status", () => {
  const request = {
    id: "d-1",
    sessionId: "s-1",
    runId: "r-1",
    kind: DecisionApproval,
  };
  const deadline = new Date(Date.now() + 60_000);
  const pending = newDecisionRecord(
    request,
    DecisionStatusPending,
    "",
    { tool: "bash" },
    deadline,
  );
  assertEquals(pending.status, DecisionStatusPending);
  assertEquals(pending.expiresAt?.getTime(), deadline.getTime());
  const resolved = newDecisionRecord(
    request,
    DecisionStatusResolved,
    "allow",
    null,
    undefined,
  );
  assertEquals(resolved.status, DecisionStatusResolved);
  assertEquals(resolved.value, "allow");
  assertEquals(resolved.expiresAt, undefined);
});

Deno.test("Load decision records by session and run", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-agentruntime-" });
  const sink = new SessionRunEventSink(sessionDir);
  const transitions = [
    {
      request: {
        id: "a",
        sessionId: "s-1",
        runId: "r-1",
        kind: DecisionApproval,
      },
      status: DecisionStatusPending,
    },
    {
      request: {
        id: "a",
        sessionId: "s-1",
        runId: "r-1",
        kind: DecisionApproval,
      },
      status: DecisionStatusResolved,
      value: "allow",
    },
    {
      request: {
        id: "b",
        sessionId: "s-1",
        runId: "r-2",
        kind: DecisionQuestion,
      },
      status: DecisionStatusPending,
    },
  ];
  for (const transition of transitions) {
    sink.record(buildDecisionEvent(transition));
  }
  // A non-decision event must not be surfaced as a record.
  sink.record({
    sessionId: "s-1",
    runId: "r-1",
    eventType: "started",
    source: "tui",
    status: "running",
    model: "",
    mode: "",
  });
  const all = loadDecisionRecords(sessionDir, "s-1");
  assertEquals(all.length, 3);
  const run1 = loadRunDecisionRecords(sessionDir, "s-1", "r-1");
  assertEquals(run1.length, 2);
  assertEquals(replayDecisions(run1).size, 0);
  const pending = replayDecisions(all);
  assertEquals(pending.size, 1);
  assertEquals(pending.get("b")?.runId, "r-2");
  assertFalse(pending.has("a"));
});
