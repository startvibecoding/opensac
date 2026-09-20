// Translated from internal/agent tests covering the background Responses
// request builders and the background tool-call entry points:
// agent_test.go (TestBuildBackgroundParamsDoNotLeakResponsesOptionsToOther
// Protocols) and tool_launch_test.go
// (TestExecuteBackgroundToolCallOrderedReleasesQueuedCalls).

import { assert, assertEquals } from "@std/assert";
import { type MockProvider, newMockProvider } from "../provider/mock.ts";
import { newUserMessage, type ToolCallBlock } from "../provider/types.ts";
import { newManager } from "../session/manager.ts";
import { newNoneSandbox } from "../sandbox/none.ts";
import {
  newRegistry,
  newTextToolResult,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "../tools/mod.ts";
import { EventToolExecutionEnd, EventToolExecutionStart } from "./events.ts";
import { newAgent, newAgentWithLoopConfig } from "./agent.ts";
import { newToolLaunchOrder } from "./tool_launch.ts";
import { testModel } from "./agent_testutil.ts";

Deno.test(
  "buildBackgroundChatParams does not leak Responses options to other protocols",
  () => {
    for (const api of ["openai-chat", "anthropic-messages", "google-gemini"]) {
      const workDir = Deno.makeTempDirSync();
      const sess = newManager(workDir, workDir);
      sess.init();
      const p: MockProvider = newMockProvider(
        "other-vendor",
        [testModel("model-1", "Model 1")],
        [],
      );
      p.setAPI(api);
      const a = newAgent(
        { provider: p, model: p.models()[0], session: sess, mode: "agent" },
        newRegistry(workDir, newNoneSandbox()),
      );
      const params = a.buildBackgroundChatParams(
        "turn-1",
        newUserMessage("hello"),
      );
      assertEquals(
        params.responseOptions,
        undefined,
        `ResponseOptions leaked into ${api} request`,
      );
    }
  },
);

Deno.test(
  "buildBackgroundReplayParams drops remote lineage and replays local archive",
  () => {
    const workDir = Deno.makeTempDirSync();
    const sess = newManager(workDir, workDir);
    sess.init();
    const p: MockProvider = newMockProvider(
      "openai",
      [testModel("model-1", "Model 1")],
      [],
    );
    p.setAPI("openai-responses");
    const a = newAgent(
      { provider: p, model: p.models()[0], session: sess, mode: "agent" },
      newRegistry(workDir, newNoneSandbox()),
    );
    a.loadHistoryMessages([newUserMessage("hello")]);
    const params = a.buildBackgroundReplayParams("turn-1");
    assert(params.responseOptions !== undefined);
    assertEquals(params.responseOptions.previousResponseId, "");
    assertEquals(params.responseOptions.suppressConversation, true);
    assertEquals(params.messages.length, 2);
  },
);

Deno.test("responsesStateFallbackError is false without a supporting provider", () => {
  const p: MockProvider = newMockProvider(
    "mock",
    [testModel("model-1", "Model 1")],
    [],
  );
  const a = newAgent({ provider: p, model: p.models()[0] }, undefined);
  assertEquals(a.responsesStateFallbackError(new Error("boom")), false);
});

function probeCall(index: number, padding: number): ToolCallBlock {
  return {
    id: `call-${index}`,
    name: "ordered_probe",
    arguments: JSON.stringify({ index, padding: "a".repeat(padding) }),
  };
}

/** Records each parallel entry so a test can prove the queued call started. */
class OrderedProbeTool implements Tool {
  readonly entered: number[] = [];
  readonly calls: number;

  constructor(calls: number) {
    this.calls = calls;
  }

  name(): string {
    return "ordered_probe";
  }
  description(): string {
    return "records parallel tool entry order";
  }
  promptSnippet(): string {
    return "ordered probe";
  }
  promptGuidelines(): string[] {
    return [];
  }
  parameters(): unknown {
    return { type: "object" };
  }
  execute(
    _ctx: ToolContext,
    params: Record<string, unknown>,
  ): ToolResult {
    this.entered.push(Number(params["index"]));
    return newTextToolResult(`probe ${Number(params["index"])}`);
  }
}

async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
): Promise<T | "timeout"> {
  return await Promise.race([
    p,
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), ms)
    ),
  ]);
}

Deno.test(
  "executeBackgroundToolCallOrdered releases the queued call after a parse failure",
  async () => {
    const tool = new OrderedProbeTool(1);
    const registry = newRegistry(Deno.makeTempDirSync(), newNoneSandbox());
    registry.register(tool);
    const mock: MockProvider = newMockProvider(
      "mock",
      [{
        ...testModel("model1", "Model 1"),
        contextWindow: 50000,
        maxTokens: 512,
      }],
      [],
    );
    const a = newAgentWithLoopConfig({
      provider: mock,
      model: mock.models()[0],
      mode: "yolo",
      maxTokens: 512,
      toolExecutionMode: "parallel",
      maxToolConcurrency: 2,
      maxIterations: 1,
    }, registry);

    const order = newToolLaunchOrder(2)!;
    const failed: ToolCallBlock = {
      id: "call-0",
      name: "ordered_probe",
      arguments: '{"index":',
    };
    const queued = probeCall(1, 0);
    const first = a.executeBackgroundToolCallOrdered(
      undefined,
      failed,
      "",
      false,
      order.handle(0),
    );
    const second = a.executeBackgroundToolCallOrdered(
      undefined,
      queued,
      "",
      false,
      order.handle(1),
    );

    let failedResult = "";
    let queuedStarted = false;
    const drained = (async () => {
      for await (const ev of first) {
        if (ev.type === EventToolExecutionEnd) {
          failedResult = ev.toolResult ?? "";
        }
      }
      for await (const ev of second) {
        if (
          ev.type === EventToolExecutionStart && ev.toolCallId === queued.id
        ) {
          queuedStarted = true;
        }
      }
    })();

    const outcome = await withTimeout(drained, 20_000);
    assert(
      outcome !== "timeout",
      "background batch stalled: the queued call never started",
    );
    assert(
      failedResult.includes("parse tool arguments"),
      `first call result = ${
        JSON.stringify(failedResult)
      }, want a parse failure`,
    );
    assertEquals(queuedStarted, true);
    assertEquals(tool.entered, [1]);
  },
);
