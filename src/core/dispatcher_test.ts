// deno-lint-ignore-file require-await -- async fake host models the Promise-based Runtime seam
import { assertEquals } from "@std/assert";
import { CoreRuntimeDispatcher } from "./dispatcher.ts";
import { CoreEventStream } from "./event_stream.ts";
import type { CoreRuntimeHost } from "./runtime.ts";

function testHost(
  extension?: CoreRuntimeHost["extension"],
): CoreRuntimeHost {
  return {
    async createSession(input) {
      return {
        sessionId: "session-1",
        workDir: input.workDir,
        source: "acp",
        providerName: input.providerName ?? "test-provider",
        modelID: input.modelID ?? "test-model",
        mode: input.mode ?? "yolo",
        thinkingLevel: input.thinkingLevel ?? "",
        capabilities: input.capabilities ?? {},
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
    },
    async openSession() {
      throw new Error("not used");
    },
    async closeSession() {},
    async history() {
      return [];
    },
    async prompt(input) {
      return { sessionId: input.sessionId, runId: "run-1", status: "running" };
    },
    async cancelRun(input) {
      return {
        sessionId: input.sessionId,
        runId: input.runId,
        status: "cancelled",
        sequence: 2,
        startedAt: new Date(0),
        updatedAt: new Date(1),
      };
    },
    async getRun() {
      return undefined;
    },
    async listSessions() {
      return [];
    },
    async setSessionConfig(input) {
      return {
        sessionId: input.sessionId,
        workDir: "/tmp",
        source: "acp",
        providerName: input.providerName ?? "test-provider",
        modelID: input.modelID ?? "test-model",
        mode: input.mode ?? "yolo",
        thinkingLevel: input.thinkingLevel ?? "",
        capabilities: input.capabilities ?? {},
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
    },
    subscribeRunEvents() {
      return (async function* () {})();
    },
    async close() {},
    extension,
  };
}

Deno.test("CoreRuntimeDispatcher dispatches session.create and preserves request id", async () => {
  const dispatcher = new CoreRuntimeDispatcher({
    host: testHost(),
    events: new CoreEventStream(),
  });
  const response = await dispatcher.dispatch({
    jsonrpc: "2.0",
    id: 1,
    method: "session.create",
    params: { workDir: "/tmp/project" },
  }, new AbortController().signal);

  assertEquals(response?.id, 1);
  assertEquals(
    response?.result && (response.result as { sessionId: string }).sessionId,
    "session-1",
  );
});

Deno.test("CoreRuntimeDispatcher sends extension methods to the Core extension handler", async () => {
  const calls: string[] = [];
  const dispatcher = new CoreRuntimeDispatcher({
    host: testHost(async (method) => {
      calls.push(method);
      return { ok: true };
    }),
    events: new CoreEventStream(),
  });
  const response = await dispatcher.dispatch({
    jsonrpc: "2.0",
    id: "extension",
    method: "project.list",
    params: {},
  }, new AbortController().signal);
  assertEquals(response?.id, "extension");
  assertEquals(response?.result, { ok: true });
  assertEquals(calls, ["project.list"]);
});
Deno.test("CoreRuntimeDispatcher returns stable errors and no response for notifications", async () => {
  const dispatcher = new CoreRuntimeDispatcher({
    host: testHost(),
    events: new CoreEventStream(),
  });
  const unknown = await dispatcher.dispatch({
    jsonrpc: "2.0",
    id: "unknown",
    method: "does.not.exist",
  }, new AbortController().signal);
  assertEquals(unknown?.error?.code, -32601);

  const invalid = await dispatcher.dispatch({
    jsonrpc: "2.0",
    id: "invalid",
    method: "session.create",
    params: { workDir: 42 },
  }, new AbortController().signal);
  assertEquals(invalid?.error?.code, -32602);

  const notification = await dispatcher.dispatch({
    jsonrpc: "2.0",
    method: "session.close",
    params: { sessionId: "session-1" },
  }, new AbortController().signal);
  assertEquals(notification, undefined);
});
