/* eslint-disable @typescript-eslint/require-await */ // async fake methods model Promise-returning seams
import { assertEquals } from "../compat/assert.ts";
import { coreResult } from "../core/protocol.ts";
import { CoreClient, type CoreEventConnection } from "../core/client.ts";
import { ACPBridgeClient } from "./bridge_client.ts";
import { test } from "#testing";

class FakeCoreClient {
  readonly calls: { method: string; params?: unknown }[] = [];
  readonly eventConnection = new FakeEventConnection();
  closed = 0;
  async health() {
    return { healthy: true, version: "test", protocolVersion: 1 };
  }
  async call<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    return coreResult(1, {}) as T;
  }
  async connectEvents(): Promise<CoreEventConnection> {
    return this.eventConnection;
  }
  async close(): Promise<void> {
    this.closed++;
  }
}

class FakeEventConnection implements CoreEventConnection {
  readonly subscriptions: {
    sessionId: string;
    runId: string;
    cursor: number;
  }[] = [];
  readonly responses: unknown[] = [];
  notificationListener:
    | ((
        notification: import("../core/protocol.ts").CoreRpcNotification,
      ) => void)
    | undefined;
  requestListener:
    | ((request: import("../core/protocol.ts").CoreRpcRequest) => void)
    | undefined;
  connected = true;
  async subscribe(sessionId: string, runId: string, cursor = 0) {
    this.subscriptions.push({ sessionId, runId, cursor });
  }
  async replay() {
    return [];
  }
  onNotification(
    listener: (
      notification: import("../core/protocol.ts").CoreRpcNotification,
    ) => void,
  ) {
    this.notificationListener = listener;
    return () => (this.notificationListener = undefined);
  }
  onRequest(
    listener: (request: import("../core/protocol.ts").CoreRpcRequest) => void,
  ) {
    this.requestListener = listener;
    return () => (this.requestListener = undefined);
  }
  onClose(_listener: () => void) {
    return () => {};
  }
  respond(response: import("../core/protocol.ts").CoreRpcResponse) {
    this.responses.push(response);
  }
  async close() {
    this.connected = false;
  }
  async reconnect() {
    this.connected = true;
  }
}

test("ACPBridgeClient connects, subscribes, replays, and closes only the client", async () => {
  const core = new FakeCoreClient();
  const bridge = new ACPBridgeClient({ core: core as unknown as CoreClient });
  await bridge.connect();
  await bridge.callCore({
    jsonrpc: "2.0",
    id: 1,
    method: "session.create",
    params: { workDir: "/tmp" },
  });
  await bridge.subscribe("session-1", "run-1", 4);
  await bridge.replay("session-1", "run-1", 4);
  await bridge.close();

  assertEquals(core.calls, [
    {
      method: "session.create",
      params: { workDir: "/tmp" },
    },
  ]);
  assertEquals(core.eventConnection.subscriptions, [
    {
      sessionId: "session-1",
      runId: "run-1",
      cursor: 4,
    },
  ]);
  assertEquals(core.closed, 1);
});

test("ACPBridgeClient correlates and responds to Core reverse requests", async () => {
  const core = new FakeCoreClient();
  const bridge = new ACPBridgeClient({ core: core as unknown as CoreClient });
  await bridge.connect();
  const seen: unknown[] = [];
  bridge.onReverseRequest((request) => seen.push(request));
  core.eventConnection.requestListener?.({
    jsonrpc: "2.0",
    id: "core-1",
    method: "approval.request",
    params: { sessionId: "session-1" },
  });
  bridge.respondToReverseRequest(coreResult("core-1", { approved: true }));
  assertEquals(seen.length, 1);
  assertEquals(core.eventConnection.responses, [
    coreResult("core-1", { approved: true }),
  ]);
});
