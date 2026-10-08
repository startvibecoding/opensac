import {
  assert,
  assertEquals,
  assertMatch,
  assertThrows,
} from "@opensac/assert";
import {
  CORE_METHODS,
  coreError,
  coreNotification,
  coreResult,
  parseCoreRpcMessage,
} from "./protocol.ts";

Deno.test("parses Core JSON-RPC requests", () => {
  const message = parseCoreRpcMessage({
    jsonrpc: "2.0",
    id: 1,
    method: CORE_METHODS.health,
    params: { probe: true },
  });

  assertEquals(message?.method, "core.health");
  assertEquals(message?.id, 1);
  assertEquals(message?.params, { probe: true });
});

Deno.test("parses Core JSON-RPC notifications without ids", () => {
  const message = parseCoreRpcMessage({
    jsonrpc: "2.0",
    method: "run.text_delta",
    params: { sequence: 1, text: "hello" },
  });

  assert(message !== undefined);
  assertEquals(message.method, "run.text_delta");
  assert(!("id" in message));
  assertEquals(message.params, { sequence: 1, text: "hello" });
});

Deno.test("parses successful and failed Core JSON-RPC responses", () => {
  const result = parseCoreRpcMessage({
    jsonrpc: "2.0",
    id: "request-1",
    result: { healthy: true },
  });
  assertEquals(result?.id, "request-1");
  assertEquals(result?.result, { healthy: true });
  assertEquals(result?.error, undefined);

  const failure = parseCoreRpcMessage({
    jsonrpc: "2.0",
    id: 2,
    error: { code: -32603, message: "boom", data: { retry: false } },
  });
  assertEquals(failure?.id, 2);
  assertEquals(failure?.error?.code, -32603);
  assertEquals(failure?.error?.message, "boom");
  assertEquals(failure?.error?.data, { retry: false });
});

Deno.test("requires the JSON-RPC version and rejects malformed envelopes", () => {
  const invalidMessages: unknown[] = [
    { jsonrpc: "1.0", id: 1, method: "core.health" },
    { id: 1, result: {} },
    { jsonrpc: "2.0", id: 1, method: "core.health", result: {} },
    {
      jsonrpc: "2.0",
      id: 1,
      method: "core.health",
      error: {
        code: -32603,
        message: "boom",
      },
    },
    {
      jsonrpc: "2.0",
      id: 1,
      result: {},
      error: {
        code: -32603,
        message: "boom",
      },
    },
    { jsonrpc: "2.0", id: 1 },
    { jsonrpc: "2.0", method: 42 },
    { jsonrpc: "2.0", id: 1, method: "core.health", params: "invalid" },
    { jsonrpc: "2.0", method: "core.health", params: "invalid" },
    { jsonrpc: "2.0", method: "core.health", params: 42 },
    { jsonrpc: "2.0", method: "core.health", params: true },
    { jsonrpc: "2.0", method: "core.health", params: null },
    { jsonrpc: "2.0", method: "core.health", id: undefined },
    { jsonrpc: "2.0", id: 1, error: { code: "-32603", message: "boom" } },
    { jsonrpc: "2.0", id: 1, error: { code: -32603, message: 42 } },
    "not JSON",
    42,
    true,
    null,
    [{ jsonrpc: "2.0", id: 1, method: "core.health" }],
  ];

  for (const input of invalidMessages) {
    assertEquals(parseCoreRpcMessage(input), undefined);
  }
});

Deno.test("preserves string and numeric request identity", () => {
  const numeric = parseCoreRpcMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "core.health",
  });
  const string = parseCoreRpcMessage({
    jsonrpc: "2.0",
    id: "1",
    method: "core.health",
  });

  assertEquals(numeric?.id, 1);
  assertEquals(string?.id, "1");
  assertEquals(typeof numeric?.id, "number");
  assertEquals(typeof string?.id, "string");
});

Deno.test("encodes Core JSON-RPC response and notification envelopes", () => {
  assertEquals(coreResult("1", { healthy: true }), {
    jsonrpc: "2.0",
    id: "1",
    result: { healthy: true },
  });
  assertEquals(coreResult(1, null), {
    jsonrpc: "2.0",
    id: 1,
    result: null,
  });

  const error = coreError("error-1", -32601, "method not found", {
    method: "missing",
  });
  assertEquals(error, {
    jsonrpc: "2.0",
    id: "error-1",
    error: {
      code: -32601,
      message: "method not found",
      data: { method: "missing" },
    },
  });

  assertEquals(coreNotification("run.text_delta", { sequence: 7 }), {
    jsonrpc: "2.0",
    method: "run.text_delta",
    params: { sequence: 7 },
  });
  assertEquals(coreNotification("ready", {}), {
    jsonrpc: "2.0",
    method: "ready",
    params: {},
  });
});

Deno.test("keeps encoder output valid for optional and structured values", () => {
  assertThrows(() => coreResult(1, undefined));
  assertEquals(coreNotification("ready", undefined), {
    jsonrpc: "2.0",
    method: "ready",
  });
  for (const params of ["invalid", 42, true, null]) {
    assertThrows(() => coreNotification("bad.params", params));
  }
  assertEquals(coreNotification("list.params", [1, 2]), {
    jsonrpc: "2.0",
    method: "list.params",
    params: [1, 2],
  });
});

Deno.test("uses the initial Core method constants", () => {
  assertEquals(CORE_METHODS, {
    health: "core.health",
    info: "core.info",
    shutdown: "core.shutdown",
    clientsList: "core.clients.list",
  });
  assertMatch(CORE_METHODS.health, /^core\./);
  assertMatch(CORE_METHODS.shutdown, /^core\./);
});
