// Translated from internal/agent/terminal_contract_test.go.
//
// Guards the canonical terminal contract: exactly one EventRunFinished per run,
// emitted before the legacy terminal events and followed by EventAgentEnd; the
// terminal status distinguishes success/failed/incomplete/canceled.

import { assert, assertEquals } from "@std/assert";
import type { Model, StreamEvent, Usage } from "../provider/types.ts";
import {
  streamDone,
  streamError,
  streamRetry,
  streamStart,
  streamTextDelta,
  streamToolCall,
  streamUsage,
} from "../provider/types.ts";
import { MockProvider } from "../provider/mock.ts";
import { newNoneSandbox } from "../sandbox/none.ts";
import { newRegistry } from "../tools/tool.ts";
import type { Tool, ToolContext, ToolResult } from "../tools/tool.ts";
import {
  type Agent,
  type AgentLoopConfig,
  newAgentWithLoopConfig,
} from "./agent.ts";
import {
  type Event,
  EventAgentEnd,
  EventDone,
  EventError,
  EventRetry,
  EventRunFinished,
  EventStatus,
  EventToolExecutionStart,
  TaskCanceled,
  TaskFailed,
  TaskIncomplete,
  type TaskStatus,
  taskStatusIsSuccessful,
  taskStatusIsTerminal,
  TaskSuccess,
} from "./events.ts";
import { eventToPublic, eventTypeToPublic } from "./bridge.ts";
import { eventRunFinished as publicEventRunFinished } from "../../sdk/agent/types.ts";

function terminalModel(): Model {
  return {
    id: "model1",
    name: "Model 1",
    provider: "mock",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 50000,
    maxTokens: 512,
  };
}

function newTerminalContractAgent(
  responses: StreamEvent[],
  maxIterations: number,
): Agent {
  const provider = new MockProvider("mock", [terminalModel()], responses);
  const cfg: AgentLoopConfig = {
    provider,
    model: provider.models()[0],
    mode: "agent",
    maxTokens: 512,
    toolExecutionMode: "sequential",
    maxIterations,
  };
  return newAgentWithLoopConfig(
    cfg,
    newRegistry(Deno.makeTempDirSync(), newNoneSandbox()),
  );
}

async function collectRunEvents(
  events: AsyncIterable<Event>,
): Promise<Event[]> {
  const out: Event[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

function requireSingleRunFinished(events: Event[]): Event {
  const finished = events.filter((e) => e.type === EventRunFinished);
  assertEquals(finished.length, 1, "EventRunFinished count");
  const finishedIdx = events.findIndex((e) => e.type === EventRunFinished);
  for (const ev of events.slice(finishedIdx + 1)) {
    if (
      ev.type !== EventDone && ev.type !== EventError &&
      ev.type !== EventAgentEnd
    ) {
      throw new Error(`non-terminal event ${ev.type} after EventRunFinished`);
    }
  }
  for (let i = 0; i < finishedIdx; i++) {
    if (events[i].type === EventDone || events[i].type === EventError) {
      throw new Error("legacy terminal event emitted before EventRunFinished");
    }
  }
  assertEquals(events[events.length - 1].type, EventAgentEnd);
  return finished[0];
}

Deno.test("run finished success on normal completion", async () => {
  const agent = newTerminalContractAgent([
    { type: streamStart },
    { type: streamTextDelta, textDelta: "hello" },
    { type: streamUsage, usage: { input: 5, output: 2 } as Usage },
    { type: streamDone, stopReason: "stop" },
  ], 3);
  const events = await collectRunEvents(agent.run("hi"));
  const finished = requireSingleRunFinished(events);
  assertEquals(finished.status, TaskSuccess);
  assert(finished.error === undefined);
  assertEquals(finished.stopReason, "stop");
  assert(taskStatusIsTerminal(finished.status!));
  assert(taskStatusIsSuccessful(finished.status!));
});

Deno.test("run finished failed on stream error", async () => {
  const agent = newTerminalContractAgent([
    { type: streamStart },
    {
      type: streamError,
      error: new Error("provider returned a permanent failure"),
      stopReason: "error",
    },
  ], 3);
  const events = await collectRunEvents(agent.run("hi"));
  const finished = requireSingleRunFinished(events);
  assertEquals(finished.status, TaskFailed);
  assert(finished.error !== undefined);
});

Deno.test("run projects provider retry metadata", async () => {
  const agent = newTerminalContractAgent([
    { type: streamStart },
    {
      type: streamRetry,
      retryAttempt: 2,
      retryMaxAttempts: 4,
      retryAfterMs: 1250,
      error: new Error("Retrying (2/4): service unavailable"),
      retryDetail: "service unavailable (HTTP 503)",
    },
    { type: streamTextDelta, textDelta: "recovered" },
    { type: streamDone, stopReason: "stop" },
  ], 3);
  const events = await collectRunEvents(agent.run("hi"));
  let statusIndex = -1;
  let retryIndex = -1;
  let status: Event | undefined;
  let retry: Event | undefined;
  events.forEach((event, i) => {
    if (event.type === EventStatus && event.retryStatus === true) {
      statusIndex = i;
      status = event;
    } else if (event.type === EventRetry) {
      retryIndex = i;
      retry = event;
    }
  });
  assert(
    statusIndex >= 0,
    "provider retry must preserve the compatibility EventStatus",
  );
  assert(retryIndex >= 0, "provider retry must emit EventRetry");
  assert(
    statusIndex < retryIndex,
    "compatibility status must precede retry event",
  );
  assertEquals(
    status!.statusMessage,
    "Retrying (attempt 2/4); waiting 1.25s...",
  );
  assertEquals(retry!.statusMessage, "service unavailable (HTTP 503)");
  assertEquals(retry!.retryAttempt, 2);
  assertEquals(retry!.retryMaxAttempts, 4);
  assertEquals(retry!.retryAfterMs, 1250);
  assertEquals(retry!.retryReason, "provider");
});

Deno.test("run finished incomplete on max iterations", async () => {
  const agent = newTerminalContractAgent([
    { type: streamStart },
    {
      type: streamToolCall,
      toolCall: { id: "call_1", name: "unknown_tool", arguments: {} },
    },
    { type: streamUsage, usage: { input: 10, output: 3 } as Usage },
    { type: streamDone, stopReason: "tool_use" },
  ], 1);
  const events = await collectRunEvents(agent.run("loop forever"));
  const finished = requireSingleRunFinished(events);
  assertEquals(finished.status, TaskIncomplete);
  assertEquals(finished.stopReason, "max_iterations");
});

class BlockingTool implements Tool {
  name(): string {
    return "workflow_run";
  }
  description(): string {
    return "blocking";
  }
  promptSnippet(): string {
    return "";
  }
  promptGuidelines(): string[] {
    return [];
  }
  parameters(): unknown {
    return { type: "object" };
  }
  execute(
    ctx: ToolContext,
    _params: Record<string, unknown>,
  ): Promise<ToolResult> {
    return new Promise<ToolResult>((_resolve, reject) => {
      const signal = ctx.signal;
      const onAbort = () => reject(new Error("aborted"));
      if (signal !== undefined) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}

Deno.test("run finished canceled on abort", async () => {
  const provider = new MockProvider("mock", [terminalModel()], [
    { type: streamStart },
    {
      type: streamToolCall,
      toolCall: { id: "call_1", name: "workflow_run", arguments: {} },
    },
    { type: streamDone, stopReason: "tool_use" },
  ]);
  const registry = newRegistry(Deno.makeTempDirSync(), newNoneSandbox());
  registry.register(new BlockingTool());
  const agent = newAgentWithLoopConfig({
    provider,
    model: provider.models()[0],
    mode: "yolo",
    toolExecutionMode: "sequential",
    maxIterations: 10,
  }, registry);

  const events: Event[] = [];
  const iterator = agent.run("test")[Symbol.asyncIterator]();
  let started = false;
  while (!started) {
    const next = await iterator.next();
    assert(!next.done, "event stream closed before tool execution started");
    events.push(next.value);
    if (next.value.type === EventToolExecutionStart) started = true;
  }
  agent.abort();
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    events.push(next.value);
  }
  const finished = requireSingleRunFinished(events);
  assertEquals(finished.status, TaskCanceled);
});

Deno.test("run finished bridge preserves terminal contract", () => {
  assertEquals(eventTypeToPublic(EventRunFinished), publicEventRunFinished);
  const pub = eventToPublic({
    type: EventRunFinished,
    status: TaskCanceled,
    stopReason: "aborted",
    done: true,
  });
  assertEquals(pub.type, publicEventRunFinished);
  assertEquals(pub.status, "canceled");
  assert(taskStatusIsTerminal(pub.status!));
  assert(!taskStatusIsSuccessful(pub.status!));
});

Deno.test("task status helpers", () => {
  const terminal: Record<string, boolean> = {
    [TaskSuccess]: true,
    [TaskIncomplete]: true,
    [TaskFailed]: true,
    [TaskCanceled]: true,
    "": false,
    running: false,
  };
  for (const [status, want] of Object.entries(terminal)) {
    assertEquals(taskStatusIsTerminal(status as TaskStatus), want);
  }
  assert(taskStatusIsSuccessful(TaskSuccess));
  for (const status of [TaskIncomplete, TaskFailed, TaskCanceled]) {
    assert(!taskStatusIsSuccessful(status as TaskStatus));
  }
});
