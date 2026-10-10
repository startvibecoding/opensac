import { assert, assertEquals } from "../compat/assert.ts";
import { coreResult } from "./protocol.ts";
import { type CoreEventRequest, CoreEventStream } from "./event_stream.ts";
import { type CoreRuntimeEvent } from "./runtime.ts";
import { test } from "#testing";

test("CoreEventStream replays events after a cursor and emits live events", async () => {
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

test("CoreEventStream correlates a reverse request with its response", async () => {
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

test("CoreEventStream keeps an RPC-channel attribution until its release", async () => {
  const stream = new CoreEventStream();
  try {
    // A plain /rpc call must never leave a ghost row: the conditional mark
    // drops the moment the client owns no subscription.
    stream.registerRpcClient("rpc-1");
    assertEquals(
      stream.listClients().find((client) => client.clientId === "rpc-1"),
      undefined,
      "an empty rpc-only row is not listed",
    );

    stream.attributeSubscription("session-1", "run-1", "rpc-1");
    const listed = stream.listClients().find((c) => c.clientId === "rpc-1");
    assertEquals(listed?.subscriptions, [{
      sessionId: "session-1",
      runId: "run-1",
    }]);

    // Attribution rows receive no events: the client's live socket iterator
    // is the only delivery path, so publish must not enqueue into them.
    stream.publish({
      sessionId: "session-1",
      runId: "run-1",
      sequence: 1,
      eventType: "text_delta",
      payload: {},
      terminal: false,
    });

    // Releasing the attribution drops the conditional row again.
    assertEquals(stream.releaseAttribution("rpc-1"), true);
    assertEquals(
      stream.listClients().find((client) => client.clientId === "rpc-1"),
      undefined,
      "the row must not outlive its last subscription",
    );
    assertEquals(stream.releaseAttribution("rpc-1"), false);
  } finally {
    await stream.close();
  }
});

test("CoreEventStream keeps a socket-owned row after its attributions release", async () => {
  const stream = new CoreEventStream();
  try {
    // The /events upgrade registers the identity unconditionally.
    stream.registerClient("sock-1");
    stream.attributeSubscription("session-1", "run-1", "sock-1");
    assertEquals(
      stream.listClients().find((c) => c.clientId === "sock-1")?.subscriptions,
      [{ sessionId: "session-1", runId: "run-1" }],
    );
    // The socket also holds its own live subscription for the same run pair.
    const live = stream.subscribe("session-1", "run-1", 0, {
      clientId: "sock-1",
    });
    assertEquals(
      stream.listClients().find((c) => c.clientId === "sock-1")?.subscriptions,
      [
        { sessionId: "session-1", runId: "run-1" },
        { sessionId: "session-1", runId: "run-1" },
      ],
    );
    await stream.releaseAttribution("sock-1");
    // The socket row survives: its own close path owns removal.
    assert(
      stream.listClients().some((client) => client.clientId === "sock-1"),
      "a socket-owned row must survive attribution release",
    );
    // Releasing the live iterator drops nothing else on its own either.
    await live.return!();
    assert(
      stream.listClients().some((client) => client.clientId === "sock-1"),
      "the socket row stays until unregisterClient",
    );
    stream.unregisterClient("sock-1");
    assertEquals(stream.listClients().length, 0);
  } finally {
    await stream.close();
  }
});
