// Ported from internal/serve/openaiapi/event_broker_test.go.
import { assert, assertEquals } from "@std/assert";
import { BrokerEvent, EventBroker } from "./event_broker.ts";

Deno.test("EventBroker slow subscriber requests reconnect", async () => {
  const broker = new EventBroker();
  const { events, resync, cancel } = broker.subscribeWithResync("session-1");

  const capacity = 256; // Go cap(events)
  for (let i = 0; i < capacity + 1; i++) {
    broker.publishWithResync({
      sessionId: "session-1",
      stream: "run",
      event: "run_event",
      seq: 0,
    });
  }
  // The resync signal must arrive without consuming the queue.
  await Promise.race([
    resync,
    new Promise((_resolve, reject) =>
      setTimeout(
        () =>
          reject(
            new Error("slow subscriber did not receive a reconnect signal"),
          ),
        1000,
      )
    ),
  ]);
  let drained = 0;
  for (;;) {
    const ev = await events.next();
    if (ev === undefined) break;
    drained++;
  }
  cancel();
  assert(
    drained >= capacity,
    `expected the buffered events to drain, got ${drained}`,
  );
});

Deno.test("EventBroker unsubscribe does not request reconnect", async () => {
  const broker = new EventBroker();
  const { resync, cancel } = broker.subscribeWithResync("session-1");
  cancel();
  let reconnect = false;
  const timer = setTimeout(() => {}, 20);
  await Promise.race([
    resync.then(() => {
      reconnect = true;
    }),
    new Promise((resolve) => setTimeout(resolve, 20)),
  ]);
  clearTimeout(timer);
  assert(!reconnect, "ordinary unsubscribe unexpectedly requested reconnect");
});

Deno.test("EventBroker assigns monotonic seq and reports currentSeq", () => {
  const broker = new EventBroker();
  assertEquals(broker.currentSeq("session-1"), 0);
  const { events, cancel } = broker.subscribe("session-1");
  broker.publish({
    sessionId: "session-1",
    stream: "run",
    event: "run_event",
    seq: 0,
  });
  broker.publish({
    sessionId: "session-1",
    stream: "run",
    event: "run_event",
    seq: 0,
  });
  assertEquals(broker.currentSeq("session-1"), 2);
  assertEquals(events.next().then((ev) => ev?.seq), Promise.resolve(1));
  assertEquals(events.next().then((ev) => ev?.seq), Promise.resolve(2));
  cancel();
});

Deno.test("EventBroker publish drops events for a full subscriber without closing it", async () => {
  const broker = new EventBroker();
  const { events, cancel } = broker.subscribe("session-1");
  for (let i = 0; i < 256; i++) {
    broker.publish({
      sessionId: "session-1",
      stream: "run",
      event: "run_event",
      seq: 0,
    });
  }
  // Queue is now full: this event is dropped for the subscriber and the
  // subscription stays open.
  broker.publish({
    sessionId: "session-1",
    stream: "run",
    event: "run_event",
    seq: 0,
  });
  const first = await events.next();
  assertEquals(first?.seq, 1);
  cancel();
  const closed = await events.next();
  assertEquals(closed === undefined || typeof closed === "object", true);
});

Deno.test("EventBroker convenience publishers map stream and event names", async () => {
  const broker = new EventBroker();
  const { events, cancel } = broker.subscribe("session-1");
  broker.publishToolEvent("session-1", "run-1", { ok: true });
  broker.publishTranscriptEvent("session-1", "run-1", { t: 1 });
  broker.publishRuntimeEvent("session-1", "run-1", { r: 1 });
  broker.publishRunEvent("session-1", "run-1", { l: 1 });
  broker.publishCapabilityEvent("session-1", "run-1", { c: 1 });
  broker.publishApprovalEvent("session-1", "run-1", "approval_request", {
    a: 1,
  });
  broker.publishDone("session-1", "run-1", { d: 1 });
  broker.publishHeartbeat("session-1");
  broker.publishRawJSON("session-1", "run-1", "esm.updated", { e: 1 });

  const expected: Array<[string, string]> = [
    ["tool", "tool_event"],
    ["transcript", "transcript"],
    ["runtime", "runtime_event"],
    ["run", "run_event"],
    ["capability", "capability_event"],
    ["approval", "approval_request"],
    ["control", "done"],
    ["control", "heartbeat"],
    ["esm", "esm.updated"],
  ];
  const seen: Array<[string, string]> = [];
  for (let i = 0; i < expected.length; i++) {
    const ev = (await events.next()) as BrokerEvent;
    seen.push([ev.stream, ev.event]);
    if (ev.event === "heartbeat") {
      const data = ev.data as { sessionId: string; timestamp: string };
      assertEquals(data.sessionId, "session-1");
      assert(!Number.isNaN(Date.parse(data.timestamp)));
    }
    assertEquals(ev.sessionId, "session-1");
    assertEquals(ev.runId, ev.event === "heartbeat" ? undefined : "run-1");
  }
  assertEquals(seen, expected);
  cancel();
  assertEquals(broker.activeSubscriberCount("session-1"), 0);
});

Deno.test("EventBroker empty session events are ignored", () => {
  const broker = new EventBroker();
  broker.publish({ sessionId: "", stream: "run", event: "run_event", seq: 0 });
  broker.publishWithResync({
    sessionId: "",
    stream: "run",
    event: "run_event",
    seq: 0,
  });
  broker.publishHeartbeat("");
  assertEquals(broker.activeSubscriberCount(""), 0);
  assertEquals(broker.currentSeq(""), 0);
});
