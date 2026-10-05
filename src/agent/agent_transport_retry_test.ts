// End-to-end guard for the transport-failure recovery the user asked for:
// `Error: send request: fetch failed` must report what happened and retry the
// turn, not terminalize a live run.
//
// This drives the real Agent loop with a scripted provider that fails once with
// the exact error shape Deno produces (the socket reason lives only on `cause`,
// wrapped by the shared provider `wrapError`), then succeeds.

import { assert, assertEquals } from "@std/assert";
import type { Provider } from "../provider/provider.ts";
import {
  type ChatParams,
  type Model,
  streamDone,
  streamError,
  type StreamEvent,
  streamStart,
  streamTextDelta,
} from "../provider/types.ts";
import { wrapError } from "../provider/errors.ts";
import { createRegistry } from "../tools/tool.ts";
import { type Agent, createAgentWithLoopConfig } from "./agent.ts";
import {
  type Event,
  EVENT_ERROR,
  EVENT_RETRY,
  EVENT_RUN_FINISHED,
  EVENT_STATUS,
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

/** Replays one event batch per chat call, then repeats the last batch. */
class ScriptedProvider implements Provider {
  #model: Model;
  #batches: StreamEvent[][];
  calls = 0;

  constructor(batches: StreamEvent[][]) {
    this.#model = scriptedModel();
    this.#batches = batches;
  }

  async *chat(_params: ChatParams): AsyncGenerator<StreamEvent> {
    let idx = this.calls;
    if (idx >= this.#batches.length) idx = this.#batches.length - 1;
    this.calls++;
    for (const event of this.#batches[idx]) {
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

/** The transport error a provider reports when the socket dies mid-request. */
function fetchFailedError(): Error {
  const raw = new TypeError("fetch failed", {
    cause: new Error(
      "error sending request for url (https://api.example.invalid/v1/chat/completions): client error (Connect): tcp connect error: Connection refused (os error 111)",
    ),
  });
  return wrapError("send request", raw);
}

async function collect(
  events: AsyncIterable<Event>,
): Promise<{
  status: TaskStatus | undefined;
  retries: Event[];
  statusMessages: string[];
  sawError: boolean;
}> {
  const retries: Event[] = [];
  const statusMessages: string[] = [];
  let status: TaskStatus | undefined;
  let sawError = false;
  for await (const event of events) {
    if (event.type === EVENT_ERROR) sawError = true;
    if (event.type === EVENT_RETRY) retries.push(event);
    if (event.type === EVENT_STATUS) {
      statusMessages.push(event.statusMessage ?? "");
    }
    if (event.type === EVENT_RUN_FINISHED) status = event.status;
  }
  return { status, retries, statusMessages, sawError };
}

Deno.test("a send request: fetch failed reports the reason and retries the turn", async () => {
  const provider = new ScriptedProvider([
    [{ type: streamStart }, { type: streamError, error: fetchFailedError() }],
    [
      { type: streamStart },
      { type: streamTextDelta, textDelta: "recovered answer" },
      { type: streamDone, stopReason: "stop" },
    ],
  ]);
  const agent: Agent = createAgentWithLoopConfig({
    id: "transport-retry",
    provider,
    model: provider.models()[0],
    mode: "yolo",
  }, createRegistry(Deno.makeTempDirSync(), undefined));

  const { status, retries, statusMessages, sawError } = await collect(
    agent.run("hello"),
  );

  assertEquals(status, TASK_SUCCESS, "the run must recover, not fail");
  assertEquals(sawError, false, "a recovered transport blip is not a failure");
  assertEquals(provider.calls, 2, "the failed turn is retried once");
  assert(retries.length >= 1, "one retry event is reported");
  // The user is told the actual reason, not the opaque "fetch failed".
  assert(
    statusMessages.concat(retries.map((e) => e.statusMessage ?? "")).join("\n")
      .includes("connection refused"),
    `expected an actionable retry reason, got ${
      JSON.stringify(statusMessages)
    }`,
  );
});
