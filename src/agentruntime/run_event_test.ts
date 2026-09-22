// Ported from internal/agentruntime/run_event_test.go and
// run_event_replay_test.go.

import { assertEquals } from "@std/assert";
import {
  type RunEvent,
  type RunEventSink,
  SessionRunEventSink,
} from "./run_event.ts";
import { listSessionRunEvents } from "../session/session_events.ts";

class RecordingRunEventSink implements RunEventSink {
  events: RunEvent[] = [];

  record(ev: RunEvent): string {
    this.events.push(ev);
    return "event-1";
  }
}

Deno.test("SessionRunEventSink RecordJSON", () => {
  const sink = new SessionRunEventSink(
    Deno.makeTempDirSync({ prefix: "opensac-agentruntime-" }),
  );
  sink.recordJSON(
    "session-1",
    "run-1",
    "started",
    "tui",
    "running",
    "model",
    "agent",
    { key: "value" },
  );
});

Deno.test("RunEvent carries protocol-neutral data", () => {
  const data = { decision: "approval-1" };
  const sink = new RecordingRunEventSink();
  sink.record({
    sessionId: "session-1",
    runId: "run-1",
    eventType: "decision_pending",
    source: "",
    status: "",
    model: "",
    mode: "",
    data,
  });
  assertEquals(sink.events.length, 1);
  assertEquals(sink.events[0].data, data);
});

Deno.test("SessionRunEventSink preserves insertion order", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-agentruntime-" });
  const sink = new SessionRunEventSink(sessionDir);
  for (
    const event of [
      {
        sessionId: "session-1",
        runId: "run-1",
        eventType: "started",
        source: "runtime",
        status: "running",
        model: "",
        mode: "",
      },
      {
        sessionId: "session-1",
        runId: "run-1",
        eventType: "decision_pending",
        source: "runtime",
        status: "pending",
        model: "",
        mode: "",
      },
      {
        sessionId: "session-1",
        runId: "run-1",
        eventType: "finished",
        source: "runtime",
        status: "completed",
        model: "",
        mode: "",
      },
    ]
  ) {
    sink.record(event);
  }
  const events = listSessionRunEvents(sessionDir, "session-1");
  assertEquals(events.length, 3);
  const want = ["started", "decision_pending", "finished"];
  for (let i = 0; i < want.length; i++) {
    assertEquals(events[i].eventType, want[i]);
    assertEquals(events[i].runId, "run-1");
  }
});
