import { assertEquals } from "@std/assert";
import { coreResult } from "../core/protocol.ts";
import type { CoreRuntimeEvent } from "../core/runtime.ts";
import type { ACPRPCRequest } from "./wire.ts";
import {
  type ACPBridgeContext,
  mapACPRequestToCore,
  mapCoreEventToACP,
  mapCoreResponseToACP,
  mapCoreReverseRequestToACP,
} from "./bridge_protocol.ts";

const context: ACPBridgeContext = {
  source: "acp",
  workDir: "/tmp/project",
};

Deno.test("mapACPRequestToCore preserves session/new and raw request id", () => {
  const request: ACPRPCRequest = {
    jsonrpc: "2.0",
    idRaw: '"request-1"',
    method: "session/new",
    params: { cwd: "/tmp/project" },
  };
  const mapped = mapACPRequestToCore(request, context);
  assertEquals(mapped.method, "session.create");
  assertEquals(mapped.id, "request-1");
  // The entry declares its RuntimeSource so run policy resolves from the
  // front-end identity instead of the shared Core's fallback.
  assertEquals(mapped.params, {
    workDir: "/tmp/project",
    source: "acp",
  });
});

Deno.test("mapCoreResponseToACP uses the original raw ACP id", () => {
  const request: ACPRPCRequest = {
    jsonrpc: "2.0",
    idRaw: "null",
    method: "session/prompt",
  };
  const response = mapCoreResponseToACP(
    coreResult("core-1", { runId: "run-1" }),
    request,
  );
  assertEquals(response.idRaw, "null");
  assertEquals(response.result, { runId: "run-1" });
});

Deno.test("mapCoreEventToACP preserves canonical IDs and terminal state", () => {
  const event: CoreRuntimeEvent = {
    sessionId: "session-1",
    runId: "run-1",
    sequence: 7,
    eventType: "text_delta",
    payload: {
      text: "hello",
      messageId: "message-1",
      runId: "run-1",
    },
    terminal: false,
  };
  const notification = mapCoreEventToACP(event);
  assertEquals(notification.method, "session/update");
  assertEquals(notification.params, {
    sessionId: "session-1",
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: "message-1",
      content: { type: "text", text: "hello" },
      runId: "run-1",
    },
  });

  const terminal = mapCoreEventToACP({
    ...event,
    sequence: 8,
    eventType: "run_finished",
    payload: { status: "completed" },
    terminal: true,
  });
  assertEquals(terminal.params, {
    sessionId: "session-1",
    update: {
      sessionUpdate: "run_finished",
      status: "completed",
      runId: "run-1",
    },
  });
});

Deno.test("mapCoreReverseRequestToACP maps approval and question requests", () => {
  const approval = mapCoreReverseRequestToACP({
    jsonrpc: "2.0",
    id: "core-approval",
    method: "approval.request",
    params: { sessionId: "session-1", toolCallId: "tool-1" },
  });
  assertEquals(approval.method, "session/requestPermission");
  assertEquals(approval.idRaw, '"core-approval"');

  const question = mapCoreReverseRequestToACP({
    jsonrpc: "2.0",
    id: 42,
    method: "question.request",
    params: { sessionId: "session-1", prompt: "Continue?" },
  });
  assertEquals(question.method, "session/requestQuestion");
  assertEquals(question.idRaw, "42");
});
