import { assertEquals } from "@std/assert";
import type { SessionRunEvent } from "../session/session_events.ts";
import { replayRunEvents, replayRunEventsJSON } from "./run_replay.ts";
import { RUN_STATE_COMPLETED, RUN_STATE_RUNNING } from "./run_state.ts";

function event(overrides: Partial<SessionRunEvent>): SessionRunEvent {
  return {
    id: "",
    sessionId: "",
    runId: "",
    eventType: "",
    source: "",
    status: "",
    model: "",
    mode: "",
    timestamp: new Date(),
    ...overrides,
  };
}

Deno.test("ReplayRunEvents reconstructs terminal state", () => {
  const now = Date.now();
  const events = [
    event({
      sessionId: "session-1",
      runId: "run-1",
      eventType: "started",
      status: "running",
      timestamp: new Date(now),
    }),
    event({
      sessionId: "session-1",
      runId: "run-1",
      eventType: "decision_pending",
      status: "pending",
      timestamp: new Date(now + 1),
    }),
    event({
      sessionId: "session-1",
      runId: "run-1",
      eventType: "finished",
      status: "completed",
      timestamp: new Date(now + 2),
    }),
    event({
      sessionId: "session-1",
      runId: "run-2",
      eventType: "failed",
      status: "failed",
      timestamp: new Date(now + 3),
    }),
  ];
  const replay = replayRunEvents(events, "run-1");
  assertEquals(replay.sessionId, "session-1");
  assertEquals(replay.runId, "run-1");
  assertEquals(replay.events.length, 3);
  assertEquals(replay.status, RUN_STATE_COMPLETED);
  assertEquals(replay.terminal, true);
});

Deno.test("ReplayRunEvents keeps pending run non-terminal", () => {
  const replay = replayRunEvents([
    event({
      sessionId: "session-1",
      runId: "run-1",
      eventType: "started",
      status: "running",
    }),
  ], "run-1");
  assertEquals(replay.status, RUN_STATE_RUNNING);
  assertEquals(replay.terminal, false);
});

Deno.test("ReplayRunEventsJSON sorts by timestamp", () => {
  const now = Date.now();
  const events = [
    event({
      sessionId: "s",
      runId: "run-1",
      eventType: "finished",
      status: "completed",
      timestamp: new Date(now + 5),
    }),
    event({
      sessionId: "s",
      runId: "run-1",
      eventType: "started",
      status: "running",
      timestamp: new Date(now),
    }),
  ];
  const decoded = JSON.parse(replayRunEventsJSON(events, "run-1")) as {
    events: Array<{ eventType: string }>;
  };
  assertEquals(decoded.events[0].eventType, "started");
  assertEquals(decoded.events[1].eventType, "finished");
});
