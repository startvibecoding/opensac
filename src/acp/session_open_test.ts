// Focused tests for the ACP session-establishing slice of src/acp/server.ts
// (translated from the session/new, session/load, session/resume, session/fork,
// session/set_config_option, session/set_mode, opensac/session/draft-config-
// options, available-commands and MCP-notification paths of
// internal/acp/acp.go). Fixtures create real persisted sessions in a temp
// session directory and call the handlers directly; because the fixture never
// constructs a provider catalog, `configureSessionBindings` deliberately leaves
// those runtimes unbound (the documented unit-fixture behavior).

import { runtime as nodeRuntime } from "../platform/runtime.ts";
import { assert, assertEquals } from "../compat/assert.ts";
import * as path from "../compat/path.ts";
import { AcpServer, type AcpServerSink, ACPSessionRuntime } from "./server.ts";
import { type ACPRPCRequest } from "./mod.ts";
import { type Settings } from "../config/settings.ts";
import type { Manager as SkillsManager } from "../skills/mod.ts";
import { createSession } from "../agentruntime/session_lifecycle.ts";
import {
  createAssistantMessage,
  createUserMessage,
  type Model,
} from "../provider/types.ts";
import { type Provider } from "../provider/provider.ts";
import { test } from "#testing";

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

function responseOf(output: string): Record<string, unknown> {
  const response = parseMessages(output).find(
    (m) => "result" in m || "error" in m,
  );
  assert(response !== undefined, `no response in ${output}`);
  return response;
}

function errorOf(message: Record<string, unknown>): Record<string, unknown> {
  const err = message.error as Record<string, unknown> | undefined;
  assert(err !== undefined, `response = ${JSON.stringify(message)}`);
  return err;
}

interface Fixture {
  server: AcpServer;
  sink: SyncBuffer;
  sessionDir: string;
  root: string;
  workDir: string;
}

function createFixture(): Fixture {
  const root = nodeRuntime.makeTempDirSync({ prefix: "opensac-acp-open-" });
  const sessionDir = path.join(root, "sessions");
  nodeRuntime.mkdirSync(sessionDir, { recursive: true });
  const workDir = path.join(root, "work");
  nodeRuntime.mkdirSync(workDir, { recursive: true });
  const server = new AcpServer();
  server.settings = { sessionDir } as unknown as Settings;
  const sink = new SyncBuffer();
  server.sink = sink;
  return { server, sink, sessionDir, root, workDir };
}

function makeSession(sessionDir: string, workDir: string, id: string): string {
  nodeRuntime.mkdirSync(workDir, { recursive: true });
  const mgr = createSession({ workDir, sessionDir, id });
  return mgr.getHeader()!.id;
}

/** Seeds one completed conversation turn so the session is forkable. */
function completeTurn(sessionDir: string, workDir: string, id: string): void {
  const mgr = createSession({ workDir, sessionDir, id });
  mgr.startConversationTurn("turn-1", "intent-1", "run-1");
  mgr.appendMessage(createUserMessage("hello"));
  mgr.appendMessage(createAssistantMessage([{ type: "text", text: "world" }]));
  mgr.endConversationTurn("turn-1", "completed", "stop");
}

/** A minimal in-memory provider so a fixture session can be bound. */
function fakeProvider(): { provider: Provider; model: Model } {
  const model = {
    id: "fake-model",
    name: "Fake",
    reasoning: false,
    contextWindow: 8192,
    maxTokens: 1024,
  } as unknown as Model;
  const provider = {
    chat: () =>
      (async function* () {
        // no events
      })(),
    name: () => "fake",
    api: () => "openai-chat",
    models: () => [model],
    getModel: (id: string) => (id === "fake-model" ? model : undefined),
  } as unknown as Provider;
  return { provider, model };
}

test("session/new creates a runtime and projects modes", async () => {
  const { server, sink, workDir } = createFixture();
  await server.handleNewSession(rpc(1, "session/new", { cwd: workDir }));
  const result = responseOf(sink.toString()).result as Record<string, unknown>;
  const sessionId = result.sessionId as string;
  assert(typeof sessionId === "string" && sessionId !== "");
  const modes = result.modes as {
    currentModeId: string;
    availableModes: { id: string; name: string }[];
  };
  assertEquals(modes.availableModes.length, 4);
  assertEquals(
    modes.availableModes.map((m) => m.id),
    ["agent", "plan", "yolo", "os"],
  );
  assert(server.sessionRuntime(sessionId) !== null);
});

test("session/new requires a cwd", async () => {
  const { server, sink } = createFixture();
  await server.handleNewSession(rpc(1, "session/new", {}));
  const err = errorOf(responseOf(sink.toString()));
  assertEquals(err.code, -32602);
  assertEquals(err.message, "cwd is required");
});

test("session/new rejects a relative cwd", async () => {
  const { server, sink } = createFixture();
  await server.handleNewSession(
    rpc(1, "session/new", { cwd: "relative/path" }),
  );
  const err = errorOf(responseOf(sink.toString()));
  assertEquals(err.code, -32602);
  assert((err.message as string).includes("absolute"));
});

test("session/new requires initialized settings", async () => {
  const { server, sink } = createFixture();
  server.settings = null;
  await server.handleNewSession(rpc(1, "session/new", { cwd: "/tmp" }));
  const err = errorOf(responseOf(sink.toString()));
  assertEquals(err.code, -32000);
});

test("session/load opens a persisted session and omits empty history", async () => {
  const { server, sink, sessionDir, workDir } = createFixture();
  const id = makeSession(sessionDir, workDir, "sess-load");
  await server.handleLoadSession(
    rpc(1, "session/load", { sessionId: id, cwd: workDir }),
  );
  const result = responseOf(sink.toString()).result as Record<string, unknown>;
  assertEquals(result.sessionId, id);
  assertEquals("history" in result, false);
  assert(server.sessionRuntime(id) !== null);
});

test("session/load rejects an open session with a foreign cwd", async () => {
  const { server, sink, workDir, root } = createFixture();
  await server.handleNewSession(rpc(1, "session/new", { cwd: workDir }));
  const opened = responseOf(sink.toString()).result as Record<string, unknown>;
  const id = opened.sessionId as string;
  const other = path.join(root, "other");
  nodeRuntime.mkdirSync(other, { recursive: true });
  sink.reset();
  await server.handleLoadSession(
    rpc(2, "session/load", { sessionId: id, cwd: other }),
  );
  const err = errorOf(responseOf(sink.toString()));
  assertEquals(err.code, -32000);
  assert((err.message as string).includes("not available for cwd"));
});

test("session/load rejects a missing sessionId", async () => {
  const { server, sink, workDir } = createFixture();
  await server.handleLoadSession(rpc(1, "session/load", { cwd: workDir }));
  const err = errorOf(responseOf(sink.toString()));
  assertEquals(err.code, -32000);
});

test("session/resume returns the retained parent binding", async () => {
  const { server, sink, sessionDir, workDir } = createFixture();
  const id = makeSession(sessionDir, workDir, "sess-resume");
  await server.handleResumeSession(
    rpc(1, "session/resume", { sessionId: id, cwd: workDir }),
  );
  const result = responseOf(sink.toString()).result as Record<string, unknown>;
  assertEquals(result.sessionId, id);
  assertEquals("history" in result, false);
});

test("session/fork persists a child and reports the parent", async () => {
  const { server, sink, sessionDir, workDir } = createFixture();
  completeTurn(sessionDir, workDir, "sess-parent");
  await server.handleForkSession(
    rpc("fork-1", "session/fork", {
      sessionId: "sess-parent",
      cwd: workDir,
    }),
  );
  const result = responseOf(sink.toString()).result as Record<string, unknown>;
  const child = result.sessionId as string;
  assert(child !== "sess-parent");
  assertEquals(result.parentSessionId, "sess-parent");
  assert(server.sessionRuntime(child) !== null);
});

test("session/fork requires a sessionId", async () => {
  const { server, sink } = createFixture();
  await server.handleForkSession(rpc(1, "session/fork", {}));
  const err = errorOf(responseOf(sink.toString()));
  assertEquals(err.code, -32602);
  assert((err.message as string).includes("sessionId is required"));
});

test("session/fork rejects a cwd that differs from the parent", async () => {
  const { server, sink, sessionDir, workDir, root } = createFixture();
  const parent = makeSession(sessionDir, workDir, "sess-parent2");
  const other = path.join(root, "other2");
  nodeRuntime.mkdirSync(other, { recursive: true });
  await server.handleForkSession(
    rpc(1, "session/fork", { sessionId: parent, cwd: other }),
  );
  const err = errorOf(responseOf(sink.toString()));
  assertEquals(err.code, -32602);
  assert((err.message as string).includes("must match the parent session cwd"));
});

test("session/set_mode validates its arguments and session", async () => {
  const { server, sink } = createFixture();
  await server.handleSetMode(rpc(1, "session/set_mode", {}));
  assertEquals(errorOf(responseOf(sink.toString())).code, -32602);
  sink.reset();
  await server.handleSetMode(rpc(2, "session/set_mode", { sessionId: "x" }));
  assertEquals(errorOf(responseOf(sink.toString())).code, -32602);
  sink.reset();
  await server.handleSetMode(
    rpc(3, "session/set_mode", { sessionId: "missing", modeId: "plan" }),
  );
  assertEquals(errorOf(responseOf(sink.toString())).code, -32000);
});

test("session/set_mode updates an open session", async () => {
  const { server, sink, workDir } = createFixture();
  await server.handleNewSession(rpc(1, "session/new", { cwd: workDir }));
  const opened = responseOf(sink.toString()).result as Record<string, unknown>;
  const id = opened.sessionId as string;
  const rt = server.sessionRuntime(id)!;
  const { provider, model } = fakeProvider();
  rt.runtime!.configureSession(provider, "fake", model, "agent", "medium");
  sink.reset();
  await server.handleSetMode(
    rpc(2, "session/set_mode", { sessionId: id, modeId: "plan" }),
  );
  const result = responseOf(sink.toString()).result as Record<string, unknown>;
  assertEquals(result, {});
  const updates = parseMessages(sink.toString()).filter(
    (m) => m.method === "session/update",
  );
  assert(
    updates.some((m) => {
      const params = m.params as { update?: { sessionUpdate?: string } };
      return params.update?.sessionUpdate === "current_mode_update";
    }),
  );
  assertEquals(rt.runtime!.configSnapshot().mode, "plan");
});

test("session/set_config_option requires fields and a known session", async () => {
  const { server, sink } = createFixture();
  await server.handleSetConfigOption(rpc(1, "session/set_config_option", {}));
  assertEquals(errorOf(responseOf(sink.toString())).code, -32602);
  sink.reset();
  await server.handleSetConfigOption(
    rpc(2, "session/set_config_option", {
      sessionId: "missing",
      configId: "mode",
      value: "plan",
    }),
  );
  assertEquals(errorOf(responseOf(sink.toString())).code, -32000);
});

test("session/set_config_option rejects a non-boolean capability value", async () => {
  const { server, sink, workDir } = createFixture();
  await server.handleNewSession(rpc(1, "session/new", { cwd: workDir }));
  const opened = responseOf(sink.toString()).result as Record<string, unknown>;
  const id = opened.sessionId as string;
  sink.reset();
  await server.handleSetConfigOption(
    rpc(2, "session/set_config_option", {
      sessionId: id,
      configId: "browser",
      value: "yes",
    }),
  );
  const err = errorOf(responseOf(sink.toString()));
  assertEquals(err.code, -32602);
  assert((err.message as string).includes("boolean config value"));
});

test("session/set_config_option accepts a boolean capability value", async () => {
  const { server, sink, workDir } = createFixture();
  await server.handleNewSession(rpc(1, "session/new", { cwd: workDir }));
  const opened = responseOf(sink.toString()).result as Record<string, unknown>;
  const id = opened.sessionId as string;
  sink.reset();
  await server.handleSetConfigOption(
    rpc(2, "session/set_config_option", {
      sessionId: id,
      configId: "browser",
      value: true,
    }),
  );
  const result = responseOf(sink.toString()).result as Record<string, unknown>;
  assert("configOptions" in result);
  assertEquals(
    server.sessionRuntime(id)!.runtime!.capabilitySnapshot().browserEnabled,
    true,
  );
});

test("opensac/session/draft-config-options returns empty without a provider", () => {
  const { server, sink, workDir } = createFixture();
  server.handleDraftConfigOptions(
    rpc(1, "opensac/session/draft-config-options", { cwd: workDir }),
  );
  const result = responseOf(sink.toString()).result as Record<string, unknown>;
  assertEquals(result.configOptions, []);
});

test("opensac/session/draft-config-options requires a cwd", () => {
  const { server, sink } = createFixture();
  server.handleDraftConfigOptions(
    rpc(1, "opensac/session/draft-config-options", {}),
  );
  assertEquals(errorOf(responseOf(sink.toString())).code, -32602);
});

test("available commands include /systeminit and every skill", () => {
  const { server } = createFixture();
  const manager = {
    list: () => [
      { name: "alpha", description: "first" },
      { name: "", description: "ignored" },
    ],
  } as unknown as SkillsManager;
  const commands = server.availableCommandsFor(manager);
  assertEquals(commands.length, 2);
  assertEquals(commands[0].name, "/systeminit");
  assertEquals(commands[1].name, "/alpha");
  assertEquals(commands[1].description, "first");
});

test("notifyAvailableCommandsFor emits a session/update", () => {
  const { server, sink } = createFixture();
  const manager = {
    list: () => [{ name: "alpha", description: "first" }],
  } as unknown as SkillsManager;
  server.notifyAvailableCommandsFor("sess-1", manager);
  const updates = parseMessages(sink.toString()).filter(
    (m) => m.method === "session/update",
  );
  assertEquals(updates.length, 1);
  const params = updates[0].params as {
    sessionId: string;
    update: { sessionUpdate: string; availableCommands: unknown[] };
  };
  assertEquals(params.sessionId, "sess-1");
  assertEquals(params.update.sessionUpdate, "available_commands_update");
  assertEquals(params.update.availableCommands.length, 2);
});

test("notifyAvailableCommandsFor is silent without a skills manager", () => {
  const { server, sink } = createFixture();
  server.notifyAvailableCommandsFor("sess-1", null);
  assertEquals(sink.toString(), "");
});

test("activateSkillPrompt ignores a missing runtime or unknown skill", async () => {
  const { server } = createFixture();
  const empty = server.sessionRuntime("missing");
  if (empty !== null) {
    assertEquals(await server.activateSkillPrompt(empty, "/skill:x"), false);
  }
  assertEquals(
    // A runtime without an attached Runtime must never activate a skill.
    await server.activateSkillPrompt(new ACPSessionRuntime(), "/systeminit"),
    false,
  );
});

test("MCP notifications project an additive tool-call update", () => {
  const { server, sink } = createFixture();
  server.handleMCPNotification(
    "sess-1",
    "demo server",
    "notifications/progress",
    {
      progress: 1,
    },
  );
  const updates = parseMessages(sink.toString()).filter(
    (m) => m.method === "session/update",
  );
  assertEquals(updates.length, 2);
  const first = (updates[0].params as { update: Record<string, unknown> })
    .update;
  assertEquals(first.sessionUpdate, "tool_call");
  assertEquals(first.status, "pending");
  const second = (updates[1].params as { update: Record<string, unknown> })
    .update;
  assertEquals(second.sessionUpdate, "tool_call_update");
  assertEquals(second.status, "in_progress");
  const raw = second.rawOutput as Record<string, unknown>;
  assertEquals(raw.method, "notifications/progress");
  assertEquals(raw.params, { progress: 1 });
});

test("MCP notifications are deduplicated per server", () => {
  const { server, sink } = createFixture();
  server.handleMCPNotification("sess-1", "demo", "notifications/message", {});
  sink.reset();
  server.handleMCPNotification("sess-1", "demo", "notifications/message", {});
  const updates = parseMessages(sink.toString()).filter(
    (m) => m.method === "session/update",
  );
  assertEquals(updates.length, 1);
  assertEquals(
    (updates[0].params as { update: { sessionUpdate: string } }).update
      .sessionUpdate,
    "tool_call_update",
  );
});

test("MCP sampling rejects an unknown session", async () => {
  const { server } = createFixture();
  const outcome = await server.handleMCPSamplingCreateMessage(
    new AbortController().signal,
    "missing",
    "demo",
    { messages: [{ role: "user", content: "hi" }] },
  );
  assert(outcome.error !== undefined);
  assertEquals(outcome.error!.code, -32000);
});
