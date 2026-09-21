// Example: run the public agent SDK with a custom in-process Provider.
//
// This example implements the public `Provider` interface directly (no HTTP,
// no API key needed) so you can see the full SDK surface end to end:
//
//   deno run -A examples/custom_provider.ts
//
// It imports the repository's `bootstrap.ts` facade, which registers the
// internal agent builder behind `newBuilder().build()`. External programs
// import the same facade from the published package instead of any `src/`
// path.

import {
  type ChatParams,
  eventAgentEnd,
  eventTextDelta,
  type ModelInfo,
  newBuilder,
  type Provider,
  roleUser,
  streamDone,
  type StreamEvent,
  streamStart,
  streamTextDelta,
  streamUsage,
} from "../sdk/agent/mod.ts";
import "../bootstrap.ts";

/** A scripted provider that echoes the last user message back. */
class EchoProvider implements Provider {
  #model: ModelInfo = {
    id: "echo-1",
    name: "Echo 1",
    provider: "echo",
    reasoning: false,
    input: ["text"],
    contextWindow: 8192,
    maxTokens: 1024,
  };

  name(): string {
    return "echo";
  }

  models(): ModelInfo[] {
    return [this.#model];
  }

  getModel(id: string): ModelInfo | undefined {
    return id === this.#model.id ? this.#model : undefined;
  }

  async *chat(params: ChatParams): AsyncIterable<StreamEvent> {
    yield { type: streamStart };
    const lastUser = [...params.messages].reverse().find((m) =>
      m.role === roleUser
    );
    yield {
      type: streamTextDelta,
      textDelta: `You said: ${lastUser?.content ?? "(nothing)"}`,
    };
    yield {
      type: streamUsage,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    yield { type: streamDone };
  }
}

const agent = newBuilder()
  .withProvider(new EchoProvider())
  .withModel("echo-1")
  .withMode("yolo")
  .withWorkDir(Deno.cwd())
  .build();

for await (const event of agent.run("hello from the SDK")) {
  if (event.type === eventTextDelta) {
    Deno.stdout.writeSync(new TextEncoder().encode(event.textDelta ?? ""));
  } else if (event.type === eventAgentEnd) {
    console.log("\n[agent finished]");
  }
}
