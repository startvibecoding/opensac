//
// These tests exercise the ported Agent Core loop through its public Run
// entry points with a scripted provider, guarding the canonical terminal
// semantics (truncated/unrecovered turns are incomplete, a recovered turn is a
// success, and a run cancelled during the member wait terminalizes as
// canceled).

import { assert, assertEquals } from "@std/assert";
import type { Provider } from "../provider/provider.ts";
import {
  type ChatParams,
  type Model,
  newSystemInjectedUserMessage,
  streamDone,
  streamError,
  type StreamEvent,
  streamStart,
  streamTextDelta,
} from "../provider/types.ts";
import { newRegistry } from "../tools/tool.ts";
import { type Agent, newAgentWithLoopConfig } from "./agent.ts";
import { composeFollowUps } from "./followup.ts";
import { newMemberMailbox } from "./mailbox.ts";
import {
  type Event,
  EVENT_ERROR,
  EVENT_RUN_FINISHED,
  TASK_CANCELED,
  TASK_INCOMPLETE,
  TASK_SUCCESS,
  type TaskStatus,
} from "./events.ts";

function scriptedModel(): Model {
  return {
    id: "scripted-model",
    name: "Scripted",
    provider: "scripted",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

/** Replays one event batch per chat call. */
class ScriptedProvider implements Provider {
  #model: Model;
  #batches: StreamEvent[][];
  calls = 0;

  constructor(batches: StreamEvent[][]) {
    this.#model = scriptedModel();
    this.#batches = batches;
  }

  async *chat(params: ChatParams): AsyncGenerator<StreamEvent> {
    let idx = this.calls;
    if (idx >= this.#batches.length) idx = this.#batches.length - 1;
    this.calls++;
    for (const event of this.#batches[idx]) {
      if (params.abort?.aborted) {
        yield { type: streamError, error: new Error("aborted") };
        return;
      }
      yield event;
    }
  }

  name(): string {
    return "scripted";
  }

  api(): string {
    return "mock";
  }

  models(): Model[] {
    return [this.#model];
  }

  getModel(id: string): Model | undefined {
    return id === this.#model.id ? this.#model : undefined;
  }
}

async function collectTerminal(
  events: AsyncIterable<Event>,
): Promise<
  { status: TaskStatus | undefined; reason: string; errorEvent: boolean }
> {
  let status: TaskStatus | undefined;
  let reason = "";
  let errorEvent = false;
  for await (const event of events) {
    if (event.type === EVENT_RUN_FINISHED) {
      status = event.status;
      reason = event.stopReason ?? "";
    } else if (event.type === EVENT_ERROR) {
      errorEvent = true;
    }
  }
  return { status, reason, errorEvent };
}

Deno.test("loop reports truncated output as incomplete", async () => {
  const provider = new ScriptedProvider([[
    { type: streamStart },
    { type: streamTextDelta, textDelta: "partial answer that was cut off" },
    { type: streamDone, stopReason: "length" },
  ]]);
  const agent: Agent = newAgentWithLoopConfig({
    id: "truncated",
    provider,
    model: provider.models()[0],
    mode: "yolo",
    maxTokensUserSet: true,
  }, newRegistry(Deno.makeTempDirSync(), undefined));

  const { status, reason } = await collectTerminal(
    agent.run("write a very long answer"),
  );
  assertEquals(status, TASK_INCOMPLETE);
  assertEquals(reason, "output_limit");
  assertEquals(provider.calls, 1);
});

Deno.test("loop marks a recovered turn a success", async () => {
  const provider = new ScriptedProvider([
    [
      { type: streamStart },
      { type: streamTextDelta, textDelta: "cut off" },
      { type: streamDone, stopReason: "length" },
    ],
    [
      { type: streamStart },
      { type: streamTextDelta, textDelta: "complete answer" },
      { type: streamDone, stopReason: "stop" },
    ],
  ]);
  let drains = 0;
  const agent = newAgentWithLoopConfig({
    id: "lead",
    provider,
    model: provider.models()[0],
    mode: "yolo",
    maxTokensUserSet: true,
    getFollowUpMessages: () => {
      drains++;
      if (drains === 1) {
        return [newSystemInjectedUserMessage("[MEMBER_COMPLETION] finished")];
      }
      return [];
    },
  }, newRegistry(Deno.makeTempDirSync(), undefined));

  const { status, reason, errorEvent } = await collectTerminal(
    agent.run("start"),
  );
  assertEquals(status, TASK_SUCCESS);
  assertEquals(errorEvent, false);
  assertEquals(provider.calls, 2);
  assert(reason === "stop");
});

Deno.test("run cancelled during member wait terminalizes as canceled", async () => {
  const provider = new ScriptedProvider([[
    { type: streamStart },
    { type: streamTextDelta, textDelta: "lead turn" },
    { type: streamDone, stopReason: "stop" },
  ]]);
  const mailbox = newMemberMailbox();
  mailbox.setRunningPredicate(() => true);
  const followUps = composeFollowUps(mailbox, undefined);
  const controller = new AbortController();
  const agent = newAgentWithLoopConfig({
    id: "lead",
    provider,
    model: provider.models()[0],
    mode: "yolo",
    getFollowUpMessages: (ctx) => followUps?.(ctx.signal) ?? null,
  }, newRegistry(Deno.makeTempDirSync(), undefined));

  setTimeout(() => controller.abort(), 200);
  const { status, reason } = await collectTerminal(
    agent.run("start", controller.signal),
  );
  assertEquals(status, TASK_CANCELED);
  assertEquals(reason, "aborted");
});
