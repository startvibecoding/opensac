// Translated from the agent-event projection cases of
// internal/acp/acp_mcp_test.go and internal/acp/acp_phase1_test.go plus the
// terminal/usage assertions of the ACP server. Fixtures construct an
// `AcpServer`, bind an in-memory sink, and call `handleAgentEvent` directly,
// mirroring the Go fixture server.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  AcpServer,
  type AcpServerSink,
  ACPSessionRuntime,
  persistedSessionUsage,
} from "./server.ts";
import {
  type Event as AgentEvent,
  EventDone,
  EventError,
  EventHostedItem,
  EventPlanUpdate,
  EventRetry,
  EventRunFinished,
  EventStatus,
  EventTextDelta,
  EventToolCall,
  EventToolExecutionEnd,
  EventTurnStart,
  EventUsage,
  TaskCanceled,
  TaskIncomplete,
  TaskSuccess,
} from "../agent/events.ts";
import {
  type Message,
  type Model,
  newAssistantMessage,
  type Usage,
} from "../provider/types.ts";
import type { FileDiff } from "../tools/mod.ts";
import { createSession } from "../agentruntime/session_lifecycle.ts";

/** A synchronous in-memory sink, the port of the Go `syncedBuffer` fixture. */
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

function newFixtureServer(sink: SyncBuffer): AcpServer {
  const server = new AcpServer();
  server.sink = sink;
  return server;
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

function lastUpdate(output: string): Record<string, unknown> {
  const messages = parseMessages(output);
  const last = messages[messages.length - 1];
  const params = last.params as Record<string, unknown>;
  return params.update as Record<string, unknown>;
}

function sessionEventParams(
  messages: Record<string, unknown>[],
  event: string,
): Record<string, unknown>[] {
  const matches: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.method !== "_opensac/session_event") continue;
    const params = message.params as Record<string, unknown> | undefined;
    if (params?.event === event) matches.push(params);
  }
  return matches;
}

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "test-model",
    name: "Test",
    provider: "test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
    ...overrides,
  };
}

function zeroCost(): Usage["cost"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function makeUsage(init: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite?: number;
  totalTokens: number;
  costTotal?: number;
}): Usage {
  return {
    input: init.input,
    output: init.output,
    cacheRead: init.cacheRead,
    cacheWrite: init.cacheWrite ?? 0,
    totalTokens: init.totalTokens,
    cost: { ...zeroCost(), total: init.costTotal ?? 0 },
  };
}

/** Builds a complete `FileDiff` for the ACP tool-call projection. */
function makeDiff(
  path: string,
  oldText: string | null,
  newText: string,
): FileDiff {
  return {
    path,
    added: 1,
    deleted: 0,
    addedLines: [],
    deletedLines: [],
    unified: "",
    oldText,
    newText,
    truncated: false,
  };
}

Deno.test("handleAgentEvent projects tool-result images", () => {
  const output = new SyncBuffer();
  const server = newFixtureServer(output);
  const payload = btoa("screenshot-bytes");
  server.handleAgentEvent(
    "session-1",
    {
      type: EventToolExecutionEnd,
      toolCallId: "call-read",
      toolName: "read",
      toolResult: "image attached",
      toolImages: [{ mimeType: "image/png", data: payload }],
    } satisfies AgentEvent,
  );
  const messages = parseMessages(output.toString());
  assertEquals(messages.length, 1);
  assertEquals(messages[0].method, "session/update");
  const params = messages[0].params as Record<string, unknown>;
  const update = params.update as Record<string, unknown>;
  assertEquals(update.sessionUpdate, "tool_call_update");
  assertEquals(update.status, "completed");
  const contents = update.content as Record<string, unknown>[];
  assertEquals(contents.length, 2);
  const imageContent = contents[1];
  const block = imageContent.content as Record<string, unknown>;
  assertEquals(imageContent.type, "content");
  assertEquals(block.type, "image");
  assertEquals(block.mimeType, "image/png");
  assertEquals(block.data, payload);
  const rawOutput = update.rawOutput as Record<string, unknown>;
  assertEquals(rawOutput.content, "image attached");
});

Deno.test("tool boundary starts a new assistant message", () => {
  const output = new SyncBuffer();
  const server = newFixtureServer(output);
  const rt = new ACPSessionRuntime();
  rt.id = "session-1";
  rt.promptID = "prompt-1";
  rt.messageID = "acp_session-1_prompt-1_message_0";
  rt.thoughtMessageID = "acp_session-1_prompt-1_thought_0";
  server.sessions.set("session-1", rt);

  server.handleAgentEvent("session-1", {
    type: EventTextDelta,
    textDelta: "before tool",
  });
  server.handleAgentEvent("session-1", {
    type: EventToolCall,
    toolCall: { id: "call-1", name: "read" },
  });
  server.handleAgentEvent("session-1", {
    type: EventToolExecutionEnd,
    toolCallId: "call-1",
    toolName: "read",
    toolResult: "done",
  });
  server.handleAgentEvent("session-1", { type: EventTurnStart });
  server.handleAgentEvent("session-1", {
    type: EventTextDelta,
    textDelta: "final answer",
  });

  const updates: Record<string, unknown>[] = [];
  for (const message of parseMessages(output.toString())) {
    if (message.method !== "session/update") continue;
    updates.push(
      (message.params as Record<string, unknown>).update as Record<
        string,
        unknown
      >,
    );
  }
  assertEquals(updates.length, 4);
  assertEquals(updates[0].sessionUpdate, "agent_message_chunk");
  assertEquals(updates[1].sessionUpdate, "tool_call");
  assertEquals(updates[2].sessionUpdate, "tool_call_update");
  assertEquals(updates[3].sessionUpdate, "agent_message_chunk");
  assert(updates[0].messageId !== updates[3].messageId);
});

Deno.test("plan update uses the standard plan variant", () => {
  const output = new SyncBuffer();
  const server = newFixtureServer(output);
  server.handleAgentEvent("session-1", {
    type: EventPlanUpdate,
    plan: {
      title: "Implementation",
      steps: [{ title: "Inspect", status: "running" }],
      note: "",
    },
  });
  const update = lastUpdate(output.toString());
  assertEquals(update.sessionUpdate, "plan");
  const entry = (update.entries as Record<string, unknown>[])[0];
  assertEquals(entry.content, "Inspect");
  assertEquals(entry.priority, "medium");
  assertEquals(entry.status, "in_progress");
});

Deno.test("opensac status uses an extension notification", () => {
  const output = new SyncBuffer();
  const server = newFixtureServer(output);
  server.handleAgentEvent("session-1", {
    type: EventStatus,
    statusMessage: "working",
  });
  const message = parseMessages(output.toString())[0];
  assertEquals(message.method, "_opensac/session_event");
});

Deno.test("opensac retry uses a structured extension notification", () => {
  const output = new SyncBuffer();
  const server = newFixtureServer(output);
  server.handleAgentEvent("session-1", {
    type: EventRetry,
    retryAttempt: 2,
    retryMaxAttempts: 4,
    retryAfterMs: 1500,
    retryReason: "provider diagnostic that must not be rendered",
  });
  const params = parseMessages(output.toString())[0].params as Record<
    string,
    unknown
  >;
  assertEquals(params.event, "retrying");
  assertEquals(params.attempt, 2);
  assertEquals(params.maxAttempts, 4);
  assertEquals(params.retryAfterMs, 1500);
  const message = params.message as string;
  assert(message.includes("Retrying (attempt 2/4); waiting 1.5s..."));
  assert(!message.includes("provider diagnostic"));
});

Deno.test("hosted item uses a non-executable tool update", () => {
  const output = new SyncBuffer();
  const server = newFixtureServer(output);
  server.handleAgentEvent("session-1", {
    type: EventHostedItem,
    hostedItem: {
      id: "search-1",
      type: "web_search_call",
      status: "completed",
    },
  });
  const update = lastUpdate(output.toString());
  assertEquals(update.sessionUpdate, "tool_call_update");
  assertEquals(update.toolCallId, "search-1");
  assertEquals(update.kind, "other");
  assertEquals(update.status, "completed");
});

Deno.test("tool diff uses ACP structured content and locations", () => {
  const output = new SyncBuffer();
  const server = newFixtureServer(output);
  const oldText = "before\n";
  const path = "/tmp/acp-diff.txt";
  server.handleAgentEvent("session-1", {
    type: EventToolExecutionEnd,
    toolCallId: "write-1",
    toolName: "write_file",
    toolDiff: makeDiff(path, oldText, "after\n"),
  });
  const update = lastUpdate(output.toString());
  const contents = update.content as Record<string, unknown>[];
  assertEquals(contents.length, 1);
  const diff = contents[0];
  assertEquals(diff.type, "diff");
  assertEquals(diff.path, path);
  assertEquals(diff.oldText, oldText);
  assertEquals(diff.newText, "after\n");
  const locations = update.locations as Record<string, unknown>[];
  assertEquals(locations.length, 1);
  assertEquals(locations[0].path, path);
});

Deno.test("tool diff includes null oldText for a created file", () => {
  const output = new SyncBuffer();
  const server = newFixtureServer(output);
  server.handleAgentEvent("session-1", {
    type: EventToolExecutionEnd,
    toolCallId: "write-1",
    toolName: "write_file",
    toolDiff: makeDiff("/tmp/new.txt", null, "new"),
  });
  const update = lastUpdate(output.toString());
  const diff = (update.content as Record<string, unknown>[])[0];
  assert("oldText" in diff);
  assertStrictEquals(diff.oldText, null);
});

Deno.test("streamed content chunks share a message ID", () => {
  const output = new SyncBuffer();
  const server = newFixtureServer(output);
  server.handleAgentEvent("session-1", {
    type: EventTextDelta,
    textDelta: "hello",
  });
  server.handleAgentEvent("session-1", {
    type: EventTextDelta,
    textDelta: " world",
  });
  const messages = parseMessages(output.toString());
  assertEquals(messages.length, 2);
  const first = (messages[0].params as Record<string, unknown>)
    .update as Record<string, unknown>;
  const second = (messages[1].params as Record<string, unknown>)
    .update as Record<string, unknown>;
  assert(typeof first.messageId === "string" && first.messageId !== "");
  assertEquals(first.messageId, second.messageId);
});

Deno.test("usage event emits a cumulative usage update", () => {
  const output = new SyncBuffer();
  const server = newFixtureServer(output);
  server.m = makeModel({
    contextWindow: 100,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  });
  server.sessions.set("session-1", new ACPSessionRuntime());

  // A turn that finishes before any usage event keeps the standard ACP
  // payload: the additive cache extension is omitted, never zero-filled.
  server.handleAgentEvent("session-1", { type: EventDone });
  assertEquals(lastUpdate(output.toString())._meta, undefined);

  server.handleAgentEvent("session-1", {
    type: EventUsage,
    usage: makeUsage({
      input: 10,
      output: 5,
      cacheRead: 40,
      cacheWrite: 8,
      totalTokens: 63,
    }),
    contextUsage: {
      tokens: 20,
      totalTokens: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      contextWindow: 100,
    },
  });

  let update = lastUpdate(output.toString());
  assertEquals(update.used, 20);
  assertEquals(update.size, 100);
  const cost = update.cost as Record<string, unknown>;
  assertEquals(cost.currency, "USD");
  assertEquals(cost.amount, 0.00002);
  let meta = (update._meta as Record<string, Record<string, number>>)[
    "opensac.dev"
  ];
  assertEquals(meta.cacheRead, 40);
  assertEquals(meta.cacheWrite, 8);
  assertEquals(meta.totalInputTokens, 58);

  server.handleAgentEvent("session-1", {
    type: EventUsage,
    usage: makeUsage({
      input: 4,
      output: 2,
      cacheRead: 60,
      totalTokens: 66,
    }),
    contextUsage: {
      tokens: 24,
      totalTokens: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      contextWindow: 100,
    },
  });
  update = lastUpdate(output.toString());
  meta =
    (update._meta as Record<string, Record<string, number>>)["opensac.dev"];
  assertEquals(meta.cacheRead, 100);
  assertEquals(meta.cacheWrite, 8);
  assertEquals(meta.totalInputTokens, 122);
});

Deno.test("persisted session usage shares the usage-update baseline", () => {
  const root = Deno.makeTempDirSync({ prefix: "opensac-acp-usage-" });
  const sessionDir = `${root}/sessions`;
  Deno.mkdirSync(sessionDir, { recursive: true });
  const mgr = createSession({
    workDir: root,
    sessionDir,
    id: "seeded-session",
  });
  const history: Usage[] = [
    makeUsage({
      input: 10,
      output: 5,
      cacheRead: 40,
      cacheWrite: 8,
      totalTokens: 63,
      costTotal: 0.25,
    }),
    makeUsage({
      input: 4,
      output: 2,
      cacheRead: 60,
      totalTokens: 66,
      costTotal: 0.5,
    }),
  ];
  for (const usage of history) {
    const msg: Message = newAssistantMessage([{ type: "text", text: "done" }]);
    msg.usage = usage;
    mgr.appendMessage(msg);
  }

  const seeded = persistedSessionUsage(mgr, null);
  assertEquals(seeded.usageCache.inputTotal, 122);
  assertEquals(seeded.usageCache.cacheRead, 100);
  assertEquals(seeded.usageCache.cacheWrite, 8);

  const output = new SyncBuffer();
  const server = newFixtureServer(output);
  server.m = makeModel({ contextWindow: 100 });
  const rt = new ACPSessionRuntime();
  rt.cost = seeded.cost;
  rt.usageCache = seeded.usageCache;
  server.sessions.set("session-1", rt);

  server.handleAgentEvent("session-1", {
    type: EventUsage,
    usage: makeUsage({
      input: 6,
      output: 4,
      cacheRead: 0,
      totalTokens: 10,
    }),
    contextUsage: {
      tokens: 30,
      totalTokens: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      contextWindow: 100,
    },
  });
  const reloaded = lastUpdate(output.toString());
  const meta = (reloaded._meta as Record<string, Record<string, number>>)[
    "opensac.dev"
  ];
  assertEquals(meta.totalInputTokens, 128);
  assertEquals(meta.cacheRead, 100);
  assertEquals(meta.cacheWrite, 8);
  const cost = reloaded.cost as Record<string, unknown>;
  assertEquals(cost.amount, 0.75);
  Deno.removeSync(root, { recursive: true });
});

Deno.test("terminal run events project the structured status", () => {
  const cases: Array<{
    event: AgentEvent;
    status: string;
    code?: string;
  }> = [
    {
      event: { type: EventRunFinished, status: TaskSuccess },
      status: "completed",
    },
    {
      event: { type: EventRunFinished, status: TaskCanceled },
      status: "cancelled",
      code: "run_cancelled",
    },
    {
      event: { type: EventRunFinished, status: TaskIncomplete },
      status: "incomplete",
      code: "run_incomplete",
    },
    {
      event: { type: EventError, error: new Error("boom") },
      status: "failed",
    },
  ];
  for (const testCase of cases) {
    const output = new SyncBuffer();
    const server = newFixtureServer(output);
    server.sessions.set("session-1", new ACPSessionRuntime());
    server.handleAgentEvent("session-1", testCase.event);
    const params = sessionEventParams(
      parseMessages(output.toString()),
      "terminal",
    );
    assertEquals(params.length, 1);
    assertEquals(params[0].status, testCase.status);
    if (testCase.status === "completed") {
      assert(!("errorInfo" in params[0]));
    } else {
      const info = params[0].errorInfo as Record<string, unknown>;
      assert(typeof params[0].error === "string");
      if (testCase.code !== undefined) assertEquals(info.code, testCase.code);
    }
    // The single-terminal contract: a second terminal event is dropped.
    output.reset();
    server.handleAgentEvent("session-1", testCase.event);
    assertEquals(output.toString(), "");
  }
});

Deno.test("child terminal events never project a parent terminal", () => {
  const output = new SyncBuffer();
  const server = newFixtureServer(output);
  server.sessions.set("session-1", new ACPSessionRuntime());
  server.handleAgentEvent("session-1", {
    type: EventRunFinished,
    status: TaskSuccess,
    agentId: "child-1",
  });
  assertEquals(
    sessionEventParams(parseMessages(output.toString()), "terminal"),
    [],
  );
});
