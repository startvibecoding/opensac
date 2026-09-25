import { assertEquals } from "@std/assert";
import { coreResult } from "./protocol.ts";
import { type CoreEventRequest, CoreEventStream } from "./event_stream.ts";
import type { CoreRuntimeEvent } from "./runtime.ts";

Deno.test("CoreEventStream replays events after a cursor and emits live events", async () => {
  const stream = new CoreEventStream();
  const first: CoreRuntimeEvent = {
    sessionId: "session-1",
    runId: "run-1",
    sequence: 1,
    eventType: "text_delta",
    payload: { text: "a" },
    terminal: false,
  };
  const second: CoreRuntimeEvent = {
    sessionId: "session-1",
    runId: "run-1",
    sequence: 2,
    eventType: "run_finished",
    payload: { status: "completed" },
    terminal: true,
  };
  stream.publish(first);
  stream.publish(second);

  assertEquals(stream.replay("session-1", "run-1", 0), [first, second]);
  assertEquals(stream.replay("session-1", "run-1", 1), [second]);

  const live = stream.subscribe("session-1", "run-1", 2);
  const next = live.next();
  const third: CoreRuntimeEvent = {
    ...second,
    sequence: 3,
    eventType: "status",
    payload: { status: "complete" },
    terminal: false,
  };
  stream.publish(third);
  const result = await next;
  assertEquals(result.done, false);
  if (result.done) throw new Error("expected a live event");
  assertEquals(result.value, third);
  await live.return?.();
  await stream.close();
});

Deno.test("CoreEventStream correlates a reverse request with its response", async () => {
  const stream = new CoreEventStream();
  const requests: CoreEventRequest[] = [];
  stream.onRequest((request) => requests.push(request));

  const response = stream.request("approval-1", "approval.request", {
    sessionId: "session-1",
  });
  assertEquals(requests, [{
    jsonrpc: "2.0",
    id: "approval-1",
    method: "approval.request",
    params: { sessionId: "session-1" },
  }]);

  stream.respond(coreResult("approval-1", { approved: true }));
  assertEquals(await response, {
    jsonrpc: "2.0",
    id: "approval-1",
    result: { approved: true },
  });
  await stream.close();
});
