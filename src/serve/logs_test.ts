// Ported from internal/serve/logs.go unit behavior and the
// logs_ws_e2e_test.go WebSocket end-to-end case. Go's httptest websocket
// dial maps to a real Deno.serve fixture with the WHATWG WebSocket client.

import { assertEquals, assertStringIncludes } from "@std/assert";

import {
  createLogsWebSocketHandler,
  installLogHub,
  LogHub,
  serveLogWrite,
} from "./logs.ts";
import { buildServeStatus } from "./http.ts";

function waitForEvent(
  ws: WebSocket,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for websocket event")),
      timeoutMs,
    );
    ws.addEventListener(
      "message",
      (ev) => {
        clearTimeout(timer);
        resolve(JSON.parse(ev.data));
      },
      { once: true },
    );
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("websocket error"));
    });
  });
}

Deno.test("logHub publishes to subscribers and replays retained history", async () => {
  const hub = new LogHub();
  hub.publish({ type: "binding_changed", data: { sessionId: "s1" } });

  const sub = hub.subscribe();
  assertEquals(sub.history.length, 1, "history must replay prior events");

  const received = (async () => {
    for await (const ev of sub.events) return ev;
    throw new Error("subscription closed before first event");
  })();
  hub.publish({ type: "session_deleted", data: { sessionId: "s1" } });
  const ev = await received;
  assertEquals(ev.type, "session_deleted");

  sub.unsubscribe();
  // After unsubscribe the closed iterator must terminate; further publishes
  // must not reach the dead subscriber.
  hub.publish({ type: "binding_changed", data: {} });
});

Deno.test("logHub history ring keeps the bounded tail and drops heartbeats", () => {
  const hub = new LogHub(3);
  for (let i = 0; i < 5; i++) {
    hub.publish({ type: "log", message: `line-${i}` });
  }
  hub.publish({ type: "heartbeat" });
  const { history } = hub.subscribe();
  assertEquals(history.length, 3);
  assertEquals(
    history.map((ev) => ev.message),
    ["line-2", "line-3", "line-4"],
  );
});

Deno.test("logHub write splits lines and skips blanks", () => {
  const hub = new LogHub();
  hub.write("first line\n  second line  \n\n");
  const { history } = hub.subscribe();
  assertEquals(
    history.map((ev) => ev.message),
    ["first line", "second line"],
  );
  assertEquals(history.every((ev) => ev.type === "log"), true);
});

Deno.test("logHub subscribe after close yields a closed channel", async () => {
  const hub = new LogHub();
  hub.close();
  const sub = hub.subscribe();
  assertEquals(sub.history.length, 0);
  for await (const _ of sub.events) {
    throw new Error("closed subscription yielded an event");
  }
  hub.publish({ type: "log", message: "ignored after close" });
});

Deno.test("installLogHub mirrors process log lines into the hub and restores", async () => {
  const hub = new LogHub();
  const sub = hub.subscribe();
  const nextLine = (async () => {
    for await (const ev of sub.events) return ev;
    throw new Error("subscription closed");
  })();
  const uninstall = installLogHub(hub);
  serveLogWrite("hello from the process log\n");
  const ev = await nextLine;
  uninstall();
  assertEquals(ev.type, "log");
  assertStringIncludes(ev.message ?? "", "hello from the process log");
  // After uninstall the previous writer is restored: lines no longer reach
  // the closed hub.
  const sub2 = hub.subscribe();
  assertEquals(hub.isClosed, true);
  assertEquals(sub2.history.length, 0);
});

Deno.test("logs WebSocket publishes management events end to end", async () => {
  const hub = new LogHub();
  const statusSnapshot = () => buildServeStatus({});
  const handler = createLogsWebSocketHandler({ logHub: hub, statusSnapshot });
  const server = Deno.serve({ port: 0 }, (request) => handler(request));

  const url = `ws://127.0.0.1:${server.addr.port}/ws/logs`;
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("dial failed")));
  });

  const connected = await waitForEvent(ws);
  assertEquals(connected.type, "connected");

  hub.publish({
    type: "binding_changed",
    data: {
      channelType: "wechat",
      channelId: "user-e2e",
      toSessionId: "session-e2e",
    },
  });
  const event = await waitForEvent(ws);
  assertEquals(event.type, "binding_changed");
  assertEquals(
    (event.data as Record<string, unknown>).toSessionId,
    "session-e2e",
  );

  ws.close();
  hub.publish({
    type: "session_deleted",
    data: { sessionId: "session-e2e" },
  });

  const ws2 = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws2.addEventListener("open", resolve, { once: true });
    ws2.addEventListener("error", () => reject(new Error("dial failed")));
  });
  const reconnect = await waitForEvent(ws2);
  assertEquals(reconnect.type, "connected");

  let foundDelete = false;
  for (let i = 0; i < 3 && !foundDelete; i++) {
    const replay = await waitForEvent(ws2);
    if (replay.type === "session_deleted") foundDelete = true;
  }
  if (!foundDelete) {
    throw new Error("reconnected WebSocket did not replay retained event");
  }
  ws2.close();
  await server.shutdown();
});
