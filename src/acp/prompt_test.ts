// Focused tests for the ACP prompt-run slice of src/acp/server.ts: the prompt
// admission/assembly/durable-claim/event-loop wiring of `handlePrompt`, the
// question and permission reverse requests, and the ESM steering source.
// the prompt assertions of acp_phase1_test.go; the stdio process integration
// test belongs to the CLI slice. Fixtures bind a mock provider catalog so a
// session runtime is fully configured and call the handlers directly.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import * as path from "@std/path";
import {
  AcpServer,
  type AcpServerSink,
  ACPSessionRuntime,
  esmSteeringMessages,
} from "./server.ts";
import { type ACPRPCRequest } from "./mod.ts";
import type { Settings } from "../config/settings.ts";
import type { Model } from "../provider/types.ts";
import {
  streamDone,
  type StreamEvent,
  streamStart,
  streamTextDelta,
} from "../provider/types.ts";
import { createMockProvider } from "../provider/mock.ts";
import type { Provider } from "../provider/provider.ts";
import { ESMStore } from "../esm/mod.ts";
import { testModel } from "../agent/agent_testutil.ts";
import { getActiveDurableRun } from "../agentruntime/run_queries.ts";

class SyncBuffer implements AcpServerSink {
  #buf = "";

  write(data: string): void {
    this.#buf += data;
  }

  toString(): string {
    return this.#buf;
  }

  reset(): void {
    this.#buf = "";
  }
}

function rpc(
  id: number | string,
  method: string,
  params?: unknown,
): ACPRPCRequest {
  return {
    jsonrpc: "2.0",
    idRaw: JSON.stringify(id),
    method,
    params,
  };
}

function parseMessages(output: string): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    messages.push(JSON.parse(trimmed) as Record<string, unknown>);
  }
  return messages;
}

function responseOf(output: string): Record<string, unknown> | undefined {
  return parseMessages(output).find((m) => "result" in m || "error" in m);
}

function notificationsOf(
  output: string,
  method: string,
): Record<string, unknown>[] {
  return parseMessages(output).filter((m) => m.method === method);
}

interface Fixture {
  server: AcpServer;
  sink: SyncBuffer;
  sessionDir: string;
  root: string;
  workDir: string;
}

function createFixture(): Fixture {
  const root = Deno.makeTempDirSync({ prefix: "opensac-acp-prompt-" });
  const sessionDir = path.join(root, "sessions");
  Deno.mkdirSync(sessionDir, { recursive: true });
  const workDir = path.join(root, "work");
  Deno.mkdirSync(workDir, { recursive: true });
  const server = new AcpServer();
  server.settings = { sessionDir } as unknown as Settings;
  const sink = new SyncBuffer();
  server.sink = sink;
  return { server, sink, sessionDir, root, workDir };
}

/** Binds a mock provider catalog so a fixture session runtime is configured. */
function bindMockProvider(
  server: AcpServer,
  responses: StreamEvent[],
): { provider: Provider; model: Model } {
  const model = testModel("mock-model", "Mock", "mock");
  const provider = createMockProvider("mock", [model], responses);
  server.p = provider;
  server.m = model;
  server.providerName = "mock";
  server.providers = { mock: provider };
  server.mode = "yolo";
  return { provider, model };
}

/** Opens one bound session and returns its id. */
async function openSession(
  server: AcpServer,
  sink: SyncBuffer,
  workDir: string,
): Promise<string> {
  await server.handleNewSession(rpc(1, "session/new", { cwd: workDir }));
  const response = responseOf(sink.toString());
  assert(response !== undefined, "session/new produced no response");
  const result = response.result as Record<string, unknown>;
  return result.sessionId as string;
}

/** Waits until the sink holds a response, or fails after the deadline. */
async function waitForResponse(
  sink: SyncBuffer,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = responseOf(sink.toString());
    if (response !== undefined) return response;
    if (Date.now() > deadline) {
      throw new Error(`no prompt response within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Polls until `predicate` holds, or fails after the deadline. */
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Returns the projected `run_status` params in stream order. */
function runStatusParams(output: string): Record<string, unknown>[] {
  const params: Record<string, unknown>[] = [];
  for (const message of parseMessages(output)) {
    if (message.method !== "_opensac/session_event") continue;
    const event = message.params as Record<string, unknown> | undefined;
    if (event?.event === "run_status") params.push(event);
  }
  return params;
}

/**
 * Reports whether a fresh prompt admission succeeds; the probe releases its
 * guard again so the session stays idle afterwards.
 */
async function promptAdmissionReleased(
  server: AcpServer,
  sessionId: string,
): Promise<boolean> {
  try {
    const release = await server.acquirePromptAdmission(
      server.sessionRuntime(sessionId)!,
    );
    release();
    return true;
  } catch {
    return false;
  }
}

Deno.test("esm steering injects a changed objective exactly once", () => {
  const root = Deno.makeTempDirSync({ prefix: "opensac-acp-esm-" });
  const settings = { sessionDir: root } as unknown as Settings;
  const store = new ESMStore(root);
  store.create("sess-esm", "finish the ACP objective");
  const callback = esmSteeringMessages(settings, "sess-esm");
  assert(callback !== undefined, "ACP ESM steering callback is undefined");
  const messages = callback!();
  assertEquals(messages.length, 1);
  assertStrictEquals(messages[0].systemInjected, true);
  assert((messages[0].content ?? "").includes("finish the ACP objective"));
  assertEquals(callback!().length, 0);
  // A paused objective stops steering until it changes again.
  store.pause("sess-esm");
  assertEquals(callback!().length, 0);
});

Deno.test("esm steering absent without settings or session id", () => {
  assertStrictEquals(esmSteeringMessages(null, "sess"), undefined);
  const root = Deno.makeTempDirSync({ prefix: "opensac-acp-esm-" });
  assertStrictEquals(
    esmSteeringMessages({ sessionDir: root } as unknown as Settings, ""),
    undefined,
  );
});

Deno.test("requestQuestion resolves a selected option", async () => {
  const { server, sink } = createFixture();
  const pending = server.requestQuestion(
    undefined,
    "sess-q",
    "Which?",
    ["alpha", "beta"],
    "pick one",
  );
  const notification = notificationsOf(
    sink.toString(),
    "_opensac/request_question",
  )[0];
  assert(notification !== undefined, "no question request emitted");
  const id = notification.id as string;
  server.deliverResponse(JSON.stringify(id), { answer: "beta" }, undefined);
  assertEquals(await pending, "beta");
});

Deno.test("requestQuestion returns empty for a non-option answer", async () => {
  const { server, sink } = createFixture();
  const pending = server.requestQuestion(
    undefined,
    "sess-q",
    "Which?",
    ["alpha"],
    "",
  );
  const notification = notificationsOf(
    sink.toString(),
    "_opensac/request_question",
  )[0];
  server.deliverResponse(
    JSON.stringify(notification.id),
    { answer: "other" },
    undefined,
  );
  assertEquals(await pending, "");
});

Deno.test("$/cancel_request releases a pending question as cancelled", async () => {
  const { server, sink } = createFixture();
  const pending = server.requestQuestion(
    undefined,
    "sess-q",
    "Which?",
    ["alpha"],
    "",
  );
  const notification = notificationsOf(
    sink.toString(),
    "_opensac/request_question",
  )[0];
  server.handleCancelRequest(
    rpc(9, "$/cancel_request", { requestId: notification.id }),
  );
  assertEquals(await pending, "");
});

Deno.test("requestQuestion is cancelled by an aborted run", async () => {
  const { server } = createFixture();
  const controller = new AbortController();
  const pending = server.requestQuestion(
    controller.signal,
    "sess-q",
    "Which?",
    [],
    "",
  );
  controller.abort();
  assertEquals(await pending, "");
});

Deno.test("requestPermission resolves the allow-once option", async () => {
  const { server, sink } = createFixture();
  const pending = server.requestPermissionContext(
    undefined,
    "sess-p",
    "call-1",
    "bash",
    { command: "ls" },
  );
  const notification = notificationsOf(
    sink.toString(),
    "session/request_permission",
  )[0];
  assert(notification !== undefined, "no permission request emitted");
  server.deliverResponse(
    JSON.stringify(notification.id),
    { outcome: { outcome: "selected", optionId: "allow-once" } },
    undefined,
  );
  assertStrictEquals(await pending, true);
});

Deno.test("requestPermission denies a rejection or timeout", async () => {
  const { server, sink } = createFixture();
  const rejected = server.requestPermissionContext(
    undefined,
    "sess-p",
    "call-1",
    "bash",
    {},
  );
  const notification = notificationsOf(
    sink.toString(),
    "session/request_permission",
  )[0];
  server.deliverResponse(
    JSON.stringify(notification.id),
    { outcome: { outcome: "selected", optionId: "reject-once" } },
    undefined,
  );
  assertStrictEquals(await rejected, false);

  server.permissionTimeoutMs = 1;
  assertStrictEquals(
    await server.requestPermissionContext(
      undefined,
      "sess-p",
      "call-2",
      "bash",
      {},
    ),
    false,
  );
});

Deno.test("handlePrompt rejects malformed params and unknown sessions", async () => {
  const { server, sink } = createFixture();
  await server.handlePrompt(rpc(1, "session/prompt", "not-an-object"));
  const invalid = responseOf(sink.toString())!;
  assertEquals((invalid.error as Record<string, unknown>).code, -32602);

  sink.reset();
  await server.handlePrompt(
    rpc(2, "session/prompt", {
      sessionId: "missing",
      prompt: [{ type: "text", text: "hi" }],
    }),
  );
  const unknown = responseOf(sink.toString())!;
  assertEquals((unknown.error as Record<string, unknown>).code, -32000);
  assertEquals(
    (unknown.error as Record<string, unknown>).message,
    "unknown session",
  );
});

Deno.test("handlePrompt rejects an empty prompt", async () => {
  const { server, sink, workDir } = createFixture();
  bindMockProvider(server, [
    { type: streamStart },
    { type: streamDone, stopReason: "stop" },
  ]);
  const sessionId = await openSession(server, sink, workDir);
  sink.reset();
  await server.handlePrompt(
    rpc(2, "session/prompt", { sessionId, prompt: [] }),
  );
  const response = responseOf(sink.toString())!;
  assertEquals((response.error as Record<string, unknown>).code, -32602);
  assertEquals(
    (response.error as Record<string, unknown>).message,
    "empty prompt",
  );
});

Deno.test("handlePrompt streams a completed turn and cleans up", async () => {
  const { server, sink, workDir } = createFixture();
  bindMockProvider(server, [
    { type: streamStart },
    { type: streamTextDelta, textDelta: "hello world" },
    { type: streamDone, stopReason: "stop" },
  ]);
  const sessionId = await openSession(server, sink, workDir);
  sink.reset();
  await server.handlePrompt(
    rpc(2, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    }),
  );
  const response = await waitForResponse(sink);
  assertEquals(response.result, { stopReason: "end_turn" });
  const chunks = notificationsOf(sink.toString(), "session/update");
  // The accepted user content is echoed with the streamed agent text.
  assert(
    chunks.some((message) => {
      const update = message.params as Record<string, unknown>;
      const body = update.update as Record<string, unknown>;
      return body.sessionUpdate === "user_message_chunk";
    }),
  );
  assert(
    chunks.some((message) => {
      const update = message.params as Record<string, unknown>;
      const body = update.update as Record<string, unknown>;
      return body.sessionUpdate === "agent_message_chunk";
    }),
  );
  const rt = server.sessionRuntime(sessionId)!;
  assertEquals(rt.promptID, "");
  assertEquals(rt.runID, "");
  assertStrictEquals(rt.cancel, null);
  assertStrictEquals(rt.agent !== null, true);
});

Deno.test("handlePrompt rejects a second concurrent prompt", async () => {
  const { server, sink, workDir } = createFixture();
  bindMockProvider(server, [
    { type: streamStart },
    { type: streamTextDelta, textDelta: "slow" },
    { type: streamDone, stopReason: "stop" },
  ]);
  const sessionId = await openSession(server, sink, workDir);
  const rt = server.sessionRuntime(sessionId)!;
  // Simulate an already admitted local run.
  rt.cancel = () => {};
  sink.reset();
  await server.handlePrompt(
    rpc(2, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    }),
  );
  const response = responseOf(sink.toString())!;
  assertEquals((response.error as Record<string, unknown>).code, -32000);
  assertEquals(
    (response.error as Record<string, unknown>).message,
    "session already has an active run",
  );
  // The fixture restores the idle state for later tests in this process.
  const idle = new ACPSessionRuntime();
  idle.id = sessionId;
  server.sessions.set(sessionId, idle);
});

Deno.test("handlePrompt projects a missing-terminal stream as failed", async () => {
  const { server, sink, workDir } = createFixture();
  // A provider that closes its stream without any terminal event.
  bindMockProvider(server, [{ type: streamStart }]);
  const sessionId = await openSession(server, sink, workDir);
  sink.reset();
  await server.handlePrompt(
    rpc(2, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    }),
  );
  const response = await waitForResponse(sink);
  const error = response.error as Record<string, unknown>;
  assert(error !== undefined, "expected a failure response");
  assertEquals(error.code, -32000);
});

Deno.test(
  "handlePrompt teardown orders the terminal projection after the response and releases admission",
  async () => {
    const { server, sink, workDir, sessionDir } = createFixture();
    bindMockProvider(server, [
      { type: streamStart },
      { type: streamTextDelta, textDelta: "hello world" },
      { type: streamDone, stopReason: "stop" },
    ]);
    const sessionId = await openSession(server, sink, workDir);
    sink.reset();
    await server.handlePrompt(
      rpc(2, "session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "hi" }],
      }),
    );
    const response = await waitForResponse(sink);
    assertEquals(response.result, { stopReason: "end_turn" });

    // Teardown runs after the response: the admission projection precedes it,
    // the terminal projection follows it.
    await waitUntil(
      () =>
        runStatusParams(sink.toString()).some((p) => p.status === "completed"),
      "terminal run_status projection",
    );
    assertEquals(
      runStatusParams(sink.toString()).map((p) => String(p.status)),
      ["running", "completed"],
    );
    const raw = sink.toString();
    const runningAt = raw.indexOf('"event":"run_status"');
    const responseAt = raw.indexOf('"id":2,"result"');
    const terminalAt = raw.lastIndexOf('"event":"run_status"');
    assert(
      runningAt !== -1 && responseAt !== -1 && terminalAt !== -1,
      "expected admission response and terminal projection markers",
    );
    assert(runningAt < responseAt, "running projection precedes the response");
    assert(
      responseAt < terminalAt,
      "terminal projection follows the response",
    );

    // The durable Run is terminal once the projection was written, and the
    // admission lease was released so the next prompt can be admitted.
    assertEquals(
      getActiveDurableRun(sessionDir, sessionId),
      null,
      "durable run terminal after the projection",
    );
    await waitUntil(
      () => promptAdmissionReleased(server, sessionId),
      "prompt admission release",
    );
    const rt = server.sessionRuntime(sessionId)!;
    assertEquals(rt.promptID, "");
    assertEquals(rt.runID, "");
    assertStrictEquals(rt.cancel, null);
  },
);

Deno.test(
  "handlePrompt failed-run teardown terminalizes the run and releases admission",
  async () => {
    const { server, sink, workDir, sessionDir } = createFixture();
    // A provider that closes its stream without any terminal event.
    bindMockProvider(server, [{ type: streamStart }]);
    const sessionId = await openSession(server, sink, workDir);
    sink.reset();
    await server.handlePrompt(
      rpc(2, "session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "hi" }],
      }),
    );
    const response = await waitForResponse(sink);
    const error = response.error as Record<string, unknown>;
    assert(error !== undefined, "expected a failure response");

    await waitUntil(
      () => runStatusParams(sink.toString()).some((p) => p.status === "failed"),
      "terminal failed projection",
    );
    assertEquals(
      runStatusParams(sink.toString()).map((p) => String(p.status)),
      ["running", "failed"],
    );
    const raw = sink.toString();
    const responseAt = raw.indexOf('"id":2,"error"');
    const terminalAt = raw.lastIndexOf('"event":"run_status"');
    assert(
      responseAt !== -1 && terminalAt !== -1,
      "expected error response and terminal projection markers",
    );
    assert(
      responseAt < terminalAt,
      "terminal projection follows the error response",
    );
    assertEquals(
      getActiveDurableRun(sessionDir, sessionId),
      null,
      "durable run terminal after the failed run",
    );
    await waitUntil(
      () => promptAdmissionReleased(server, sessionId),
      "prompt admission release after the failed run",
    );
    const rt = server.sessionRuntime(sessionId)!;
    assertEquals(rt.promptID, "");
    assertStrictEquals(rt.cancel, null);
  },
);

Deno.test(
  "handlePrompt teardown finalizes the run when the cancellation hook throws",
  async () => {
    const { server, sink, workDir, sessionDir } = createFixture();
    bindMockProvider(server, [
      { type: streamStart },
      { type: streamTextDelta, textDelta: "hello world" },
      { type: streamDone, stopReason: "stop" },
    ]);
    const sessionId = await openSession(server, sink, workDir);
    // handlePrompt reuses a pre-attached execution, so its cancel hook can be
    // poisoned before the run: the teardown must not skip any later step.
    const execution = server.createSessionExecution();
    let cancelCalls = 0;
    execution.cancel = (): boolean => {
      cancelCalls += 1;
      throw new Error("injected cancel failure");
    };
    const rt = server.sessionRuntime(sessionId)!;
    rt.execution = execution;
    sink.reset();
    await server.handlePrompt(
      rpc(2, "session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "hi" }],
      }),
    );
    const response = await waitForResponse(sink);
    assertEquals(response.result, { stopReason: "end_turn" });

    await waitUntil(
      () => getActiveDurableRun(sessionDir, sessionId) === null,
      "durable run terminal despite the cancel failure",
    );
    await waitUntil(
      () =>
        runStatusParams(sink.toString()).some((p) => p.status === "completed"),
      "terminal projection despite the cancel failure",
    );
    await waitUntil(
      () => promptAdmissionReleased(server, sessionId),
      "prompt admission release despite the cancel failure",
    );
    assertEquals(cancelCalls, 1, "the cancel hook ran exactly once");
  },
);

/** A sink that rejects the terminal `run_status` projection write. */
class TerminalRunStatusFailingSink extends SyncBuffer {
  override write(data: string): void {
    if (
      data.includes('"event":"run_status"') &&
      data.includes('"status":"completed"')
    ) {
      throw new Error("injected projection failure");
    }
    super.write(data);
  }
}

Deno.test(
  "handlePrompt teardown releases admission when the terminal projection write fails",
  async () => {
    const { server, workDir, sessionDir } = createFixture();
    const sink = new TerminalRunStatusFailingSink();
    server.sink = sink;
    bindMockProvider(server, [
      { type: streamStart },
      { type: streamTextDelta, textDelta: "hello world" },
      { type: streamDone, stopReason: "stop" },
    ]);
    const sessionId = await openSession(server, sink, workDir);
    sink.reset();
    await server.handlePrompt(
      rpc(2, "session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "hi" }],
      }),
    );
    const response = await waitForResponse(sink);
    assertEquals(response.result, { stopReason: "end_turn" });

    // The durable finish precedes the projection...
    await waitUntil(
      () => getActiveDurableRun(sessionDir, sessionId) === null,
      "durable run terminal despite the projection failure",
    );
    // ...and a rejected projection write must not skip the admission release.
    await waitUntil(
      () => promptAdmissionReleased(server, sessionId),
      "prompt admission release despite the projection failure",
    );
    const rt = server.sessionRuntime(sessionId)!;
    assertEquals(rt.promptID, "");
    assertStrictEquals(rt.cancel, null);
    assertEquals(
      runStatusParams(sink.toString()).map((p) => String(p.status)),
      ["running"],
      "the terminal projection write never landed",
    );
  },
);
