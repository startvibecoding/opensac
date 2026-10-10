import { runtime } from "../platform/runtime.ts";
import { assert, assertEquals, assertFalse } from "../compat/assert.ts";
import { DECISION_APPROVAL, DECISION_QUESTION } from "./decision.ts";
import {
  buildDecisionEvent,
  createDecisionRecord,
  DECISION_STATUS_PENDING,
  DECISION_STATUS_RESOLVED,
  decodeDecisionEvent,
  loadDecisionRecords,
  loadRunDecisionRecords,
} from "./decision_events.ts";
import { replayDecisions } from "./decision_replay.ts";
import { SessionRunEventSink } from "./run_event.ts";
import { type SessionRunEvent } from "../session/session_events.ts";
import { test } from "#testing";

test("Build and decode decision event round trip", () => {
  const deadline = new Date(Date.now() + 60_000);
  const event = buildDecisionEvent({
    request: {
      id: "approval-1",
      sessionId: "s-1",
      runId: "r-1",
      kind: DECISION_APPROVAL,
    },
    status: DECISION_STATUS_PENDING,
    payload: { tool: "bash" },
    expiresAt: deadline,
    source: "tui",
  });
  assertEquals(event.eventType, "decision_pending");
  assertEquals(event.status, DECISION_STATUS_PENDING);
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
  assertEquals(record.kind, DECISION_APPROVAL);
  assertEquals(record.status, DECISION_STATUS_PENDING);
  assertEquals(record.sessionId, "s-1");
  assertEquals(record.runId, "r-1");
  assertEquals(record.expiresAt?.getTime(), deadline.getTime());
});

test("DecodeDecisionEvent defaults identity and rejects foreign", () => {
  const data = {
    decision: {
      id: "q-1",
      kind: DECISION_QUESTION,
      status: DECISION_STATUS_PENDING,
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

test("NewDecisionRecord shape by status", () => {
  const request = {
    id: "d-1",
    sessionId: "s-1",
    runId: "r-1",
    kind: DECISION_APPROVAL,
  };
  const deadline = new Date(Date.now() + 60_000);
  const pending = createDecisionRecord(
    request,
    DECISION_STATUS_PENDING,
    "",
    { tool: "bash" },
    deadline,
  );
  assertEquals(pending.status, DECISION_STATUS_PENDING);
  assertEquals(pending.expiresAt?.getTime(), deadline.getTime());
  const resolved = createDecisionRecord(
    request,
    DECISION_STATUS_RESOLVED,
    "allow",
    null,
    undefined,
  );
  assertEquals(resolved.status, DECISION_STATUS_RESOLVED);
  assertEquals(resolved.value, "allow");
  assertEquals(resolved.expiresAt, undefined);
});

test("Load decision records by session and run", () => {
  const sessionDir = runtime.makeTempDirSync({
    prefix: "opensac-agentruntime-",
  });
  const sink = new SessionRunEventSink(sessionDir);
  const transitions = [
    {
      request: {
        id: "a",
        sessionId: "s-1",
        runId: "r-1",
        kind: DECISION_APPROVAL,
      },
      status: DECISION_STATUS_PENDING,
    },
    {
      request: {
        id: "a",
        sessionId: "s-1",
        runId: "r-1",
        kind: DECISION_APPROVAL,
      },
      status: DECISION_STATUS_RESOLVED,
      value: "allow",
    },
    {
      request: {
        id: "b",
        sessionId: "s-1",
        runId: "r-2",
        kind: DECISION_QUESTION,
      },
      status: DECISION_STATUS_PENDING,
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
