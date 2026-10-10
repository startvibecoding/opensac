// request builders and the background tool-call entry points:
// agent_test.go (TestBuildBackgroundParamsDoNotLeakResponsesOptionsToOther
// Protocols) and tool_launch_test.go
// (TestExecuteBackgroundToolCallOrderedReleasesQueuedCalls).

import { assert, assertEquals } from "../compat/assert.ts";
import { createMockProvider, type MockProvider } from "../provider/mock.ts";
import { createUserMessage, type ToolCallBlock } from "../provider/types.ts";
import { createManager } from "../session/manager.ts";
import { createNoneSandbox } from "../sandbox/none.ts";
import {
  createRegistry,
  createTextToolResult,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "../tools/mod.ts";
import {
  EVENT_TOOL_EXECUTION_END,
  EVENT_TOOL_EXECUTION_START,
} from "./events.ts";
import { createAgent, createAgentWithLoopConfig } from "./agent.ts";
import { createToolLaunchOrder } from "./tool_launch.ts";
import { testModel } from "./agent_testutil.ts";
import { test } from "#testing";

test(
  "buildBackgroundChatParams does not leak Responses options to other protocols",
  () => {
    for (const api of ["openai-chat", "anthropic-messages", "google-gemini"]) {
      const workDir = Deno.makeTempDirSync();
      const sess = createManager(workDir, workDir);
      sess.init();
      const p: MockProvider = createMockProvider(
        "other-vendor",
        [testModel("model-1", "Model 1")],
        [],
      );
      p.setAPI(api);
      const a = createAgent(
        { provider: p, model: p.models()[0], session: sess, mode: "agent" },
        createRegistry(workDir, createNoneSandbox()),
      );
      const params = a.buildBackgroundChatParams(
        "turn-1",
        createUserMessage("hello"),
      );
      assertEquals(
        params.responseOptions,
        undefined,
        `ResponseOptions leaked into ${api} request`,
      );
    }
  },
);

test(
  "buildBackgroundReplayParams drops remote lineage and replays local archive",
  () => {
    const workDir = Deno.makeTempDirSync();
    const sess = createManager(workDir, workDir);
    sess.init();
    const p: MockProvider = createMockProvider(
      "openai",
      [testModel("model-1", "Model 1")],
      [],
    );
    p.setAPI("openai-responses");
    const a = createAgent(
      { provider: p, model: p.models()[0], session: sess, mode: "agent" },
      createRegistry(workDir, createNoneSandbox()),
    );
    a.loadHistoryMessages([createUserMessage("hello")]);
    const params = a.buildBackgroundReplayParams("turn-1");
    assert(params.responseOptions !== undefined);
    assertEquals(params.responseOptions.previousResponseId, "");
    assertEquals(params.responseOptions.suppressConversation, true);
    assertEquals(params.messages.length, 2);
  },
);

test("responsesStateFallbackError is false without a supporting provider", () => {
  const p: MockProvider = createMockProvider(
    "mock",
    [testModel("model-1", "Model 1")],
    [],
  );
  const a = createAgent({ provider: p, model: p.models()[0] }, undefined);
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
    return createTextToolResult(`probe ${Number(params["index"])}`);
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

test(
  "executeBackgroundToolCallOrdered releases the queued call after a parse failure",
  async () => {
    const tool = new OrderedProbeTool(1);
    const registry = createRegistry(
      Deno.makeTempDirSync(),
      createNoneSandbox(),
    );
    registry.register(tool);
    const mock: MockProvider = createMockProvider(
      "mock",
      [{
        ...testModel("model1", "Model 1"),
        contextWindow: 50000,
        maxTokens: 512,
      }],
      [],
    );
    const a = createAgentWithLoopConfig({
      provider: mock,
      model: mock.models()[0],
      mode: "yolo",
      maxTokens: 512,
      toolExecutionMode: "parallel",
      maxToolConcurrency: 2,
      maxIterations: 1,
    }, registry);

    const order = createToolLaunchOrder(2)!;
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
        if (ev.type === EVENT_TOOL_EXECUTION_END) {
          failedResult = ev.toolResult ?? "";
        }
      }
      for await (const ev of second) {
        if (
          ev.type === EVENT_TOOL_EXECUTION_START && ev.toolCallId === queued.id
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
