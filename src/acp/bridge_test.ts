/* eslint-disable @typescript-eslint/require-await */ // async fake methods model Promise-returning seams
import { assertEquals } from "../compat/assert.ts";
import { coreResult } from "../core/protocol.ts";
import { type CoreRuntimeEvent } from "../core/runtime.ts";
import { type ACPRPCRequest } from "./wire.ts";
import { ACPBridge } from "./bridge.ts";
import { type BridgeCoreClient } from "./bridge_client.ts";
import { test } from "#testing";

class FakeBridgeClient implements BridgeCoreClient {
  readonly calls: { method: string; params?: unknown }[] = [];
  readonly responses: unknown[] = [];
  closed = 0;
  eventListener: ((event: CoreRuntimeEvent) => void) | undefined;
  reverseListener:
    | ((request: import("./bridge_protocol.ts").CoreServerRequest) => void)
    | undefined;

  async connect(): Promise<void> {}
  async callCore(request: import("../core/protocol.ts").CoreRpcRequest) {
    this.calls.push({ method: request.method, params: request.params });
    if (request.method === "session.create") {
      return coreResult(request.id, { sessionId: "session-1" });
    }
    if (request.method === "session.prompt") {
      return coreResult(request.id, { sessionId: "session-1", runId: "run-1" });
    }
    return coreResult(request.id, {});
  }
  async subscribe(): Promise<void> {}
  async replay(): Promise<unknown> {
    return [];
  }
  onEvent(listener: (event: CoreRuntimeEvent) => void): () => void {
    this.eventListener = listener;
    return () => (this.eventListener = undefined);
  }
  onReverseRequest(
    listener: (
      request: import("./bridge_protocol.ts").CoreServerRequest,
    ) => void,
  ): () => void {
    this.reverseListener = listener;
    return () => (this.reverseListener = undefined);
  }
  respondToReverseRequest(
    response: import("../core/protocol.ts").CoreRpcResponse,
  ): void {
    this.responses.push(response);
  }
  async close(): Promise<void> {
    this.closed++;
  }
  async reconnect(): Promise<void> {}
}

function request(
  method: string,
  idRaw: string,
  params?: unknown,
): ACPRPCRequest {
  return { jsonrpc: "2.0", idRaw, method, params };
}

test("ACPBridge maps session/prompt to Core and forwards Core events", async () => {
  const client = new FakeBridgeClient();
  const output: string[] = [];
  const bridge = new ACPBridge({
    client,
    context: { source: "acp", workDir: "/tmp" },
    initialized: true,
    write: (line) => {
      output.push(line);
    },
  });

  await bridge.handle(request("session/new", '"1"', { cwd: "/tmp" }));
  await bridge.handle(
    request("session/prompt", '"2"', {
      sessionId: "session-1",
      prompt: [{ type: "text", text: "hello" }],
    }),
  );
  client.eventListener?.({
    sessionId: "session-1",
    runId: "run-1",
    sequence: 1,
    eventType: "text_delta",
    payload: { text: "hello", messageId: "message-1" },
    terminal: false,
  });

  await Promise.resolve();
  assertEquals(
    client.calls.map((call) => call.method),
    ["session.create", "session.prompt"],
  );
  assertEquals(JSON.parse(output[1]).id, "2");
  assertEquals(JSON.parse(output[2]).method, "session/update");
  assertEquals(
    JSON.parse(output[2]).params.update.sessionUpdate,
    "agent_message_chunk",
  );
  await bridge.close();
  assertEquals(client.closed, 1);
});

test("ACPBridge maps session updates to Core replay and cancel to run.cancel", async () => {
  const client = new FakeBridgeClient();
  const output: string[] = [];
  const bridge = new ACPBridge({
    client,
    context: { source: "acp", workDir: "/tmp" },
    initialized: true,
    write: (line) => {
      output.push(line);
    },
  });

  await bridge.handle(
    request("session/updates", '"3"', {
      sessionId: "session-1",
      runId: "run-1",
      cursor: 2,
    }),
  );
  await bridge.handle(
    request("session/cancel", '"4"', {
      sessionId: "session-1",
      runId: "run-1",
    }),
  );

  assertEquals(
    client.calls.map((call) => call.method),
    ["run.events.replay", "run.cancel"],
  );
  await bridge.close();
});
test("ACPBridge gates pre-initialize methods and correlates reverse responses", async () => {
  const client = new FakeBridgeClient();
  const output: string[] = [];
  const bridge = new ACPBridge({
    client,
    context: { source: "acp", workDir: "/tmp" },
    write: (line) => {
      output.push(line);
    },
  });

  await bridge.handle(request("session/new", '"1"', { cwd: "/tmp" }));
  assertEquals(JSON.parse(output[0]).error.code, -32600);

  await bridge.handle(request("initialize", '"2"'));
  client.reverseListener?.({
    jsonrpc: "2.0",
    id: "core-approval",
    method: "approval.request",
    params: { sessionId: "session-1" },
  });
  await Promise.resolve();
  const reverse = JSON.parse(output.at(-1)!);
  assertEquals(reverse.method, "session/requestPermission");
  assertEquals(reverse.id, "core-approval");

  await bridge.handle({
    jsonrpc: "2.0",
    idRaw: '"core-approval"',
    method: "",
    result: { approved: true },
  });
  assertEquals(client.responses, [
    coreResult("core-approval", { approved: true }),
  ]);
});
