// (agent/image_coordinates_test.go)
// plus focused coverage for the pure helpers added by agent/types.go,
// agent/provider.go, and agent/builder.go.

import { assert, assertEquals, assertThrows } from "@opensac/assert";
import {
  type Agent,
  boolPtr,
  Builder,
  calculateCost,
  type ImageContent,
  mapNormalizedPointToOriginal,
  mapNormalizedRectToOriginal,
  mapPointToOriginal,
  mapRectToOriginal,
  newBuilder,
  newUserMessage,
  type Provider,
  roleUser,
  setBuilderFunc,
  taskError,
  taskStatusIsSuccessful,
  taskStatusIsTerminal,
  taskSuccess,
  totalInputTokens,
  type Usage,
  vendorFromBaseURL,
} from "./mod.ts";

function usage(partial: Partial<Usage>): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...partial,
  };
}

Deno.test("MapPointToOriginalWithCrop", () => {
  const img: ImageContent = {
    width: 100,
    height: 50,
    originalWidth: 400,
    originalHeight: 300,
    cropped: true,
    cropX: 40,
    cropY: 30,
    cropWidth: 200,
    cropHeight: 100,
  };
  const [x, y, ok] = mapPointToOriginal(img, 50, 25);
  assert(ok, "mapPointToOriginal() ok = false");
  assertEquals([x, y], [140, 80]);
});

Deno.test("MapNormalizedRectToOriginal", () => {
  const img: ImageContent = {
    width: 100,
    height: 50,
    originalWidth: 200,
    originalHeight: 100,
  };
  const [x, y, w, h, ok] = mapNormalizedRectToOriginal(
    img,
    100,
    200,
    300,
    400,
    1000,
  );
  assert(ok, "mapNormalizedRectToOriginal() ok = false");
  assertEquals([x, y, w, h], [20, 20, 60, 40]);
});

Deno.test("MapPointToOriginal rejects missing geometry", () => {
  const [x, y, ok] = mapPointToOriginal({}, 1, 1);
  assertEquals([x, y, ok], [0, 0, false]);
});

Deno.test("MapRectToOriginal scales rectangle", () => {
  const img: ImageContent = {
    width: 100,
    height: 100,
    originalWidth: 200,
    originalHeight: 200,
  };
  const [x, y, w, h, ok] = mapRectToOriginal(img, 10, 20, 30, 40);
  assert(ok);
  assertEquals([x, y, w, h], [20, 40, 60, 80]);
});

Deno.test("MapNormalizedPointToOriginal scales point", () => {
  const img: ImageContent = {
    width: 100,
    height: 50,
    originalWidth: 100,
    originalHeight: 50,
  };
  const [x, y, ok] = mapNormalizedPointToOriginal(img, 500, 250, 1000);
  assert(ok);
  assertEquals([x, y], [50, 12.5]);
});

Deno.test("UsageTotalInputTokens", () => {
  // totalTokens present: total input = total - output.
  assertEquals(
    totalInputTokens(usage({ totalTokens: 100, outputTokens: 40 })),
    60,
  );
  // no total: input + cacheRead + cacheWrite.
  assertEquals(
    totalInputTokens(usage({ inputTokens: 10, cacheRead: 20, cacheWrite: 30 })),
    60,
  );
  assertEquals(totalInputTokens(null), 0);
});

Deno.test("UsageCalculateCost", () => {
  const u = usage({
    inputTokens: 1_000_000,
    outputTokens: 2_000_000,
    cacheRead: 1_000_000,
    cacheWrite: 1_000_000,
  });
  calculateCost(u, 1, 2, 0.5, 0.75);
  assertEquals(u.cost.input, 1);
  assertEquals(u.cost.output, 4);
  assertEquals(u.cost.cacheRead, 0.5);
  assertEquals(u.cost.cacheWrite, 0.75);
  assertEquals(u.cost.total, 6.25);
});

Deno.test("TaskStatusClassification", () => {
  assert(taskStatusIsTerminal(taskSuccess));
  assert(taskStatusIsTerminal(taskError));
  assert(taskStatusIsSuccessful(taskSuccess));
  assert(!taskStatusIsSuccessful(taskError));
  assert(!taskStatusIsTerminal("running"));
});

Deno.test("BuilderDefaults", () => {
  const cfg = newBuilder().config();
  assertEquals(cfg.mode, "yolo");
  assertEquals(cfg.thinkingLevel, "medium");
  assertEquals(cfg.maxTokens, 16384);
  assertEquals(cfg.maxIterations, 200);
  assertEquals(cfg.toolExecutionMode, "parallel");
  assertEquals(cfg.maxToolConcurrency, 10);
  assert(cfg.compactionEnabled);
  assertEquals(cfg.compactionReserve, 16384);
  assert(cfg.maxTokensUserSet);
});

Deno.test("BuilderFluentConfig", () => {
  const cfg = new Builder()
    .withMode("plan")
    .withModel("gpt-4")
    .withMaxToolConcurrency(3)
    .withoutBuiltinTools()
    .config();
  assertEquals(cfg.mode, "plan");
  assertEquals(cfg.modelID, "gpt-4");
  assertEquals(cfg.maxToolConcurrency, 3);
  assert(cfg.disableBuiltinTools);
});

Deno.test("BuilderBuildRequiresProvider", () => {
  assertThrows(() => newBuilder().build(), Error, "provider is required");
});

Deno.test("BuilderBuildUsesRegisteredBuilder", () => {
  const fake = { id: () => "x" } as unknown as Agent;
  let captured: string | undefined;
  setBuilderFunc((b) => {
    captured = b.config().modelID;
    return fake;
  });
  try {
    const provider: Provider = {
      chat: async function* () {},
      name: () => "test",
      models: () => [{
        id: "m1",
        name: "m1",
        provider: "test",
        reasoning: false,
        input: ["text"],
        contextWindow: 1000,
        maxTokens: 100,
      }],
      getModel: () => undefined,
    };
    const a = newBuilder().withProvider(provider).withWorkDir("/tmp").build();
    assertEquals(a, fake);
    // Model id defaults to the first provider model.
    assertEquals(captured, "m1");
  } finally {
    setBuilderFunc(undefined);
  }
});

Deno.test("VendorFromBaseURL", () => {
  assertEquals(vendorFromBaseURL("https://api.deepseek.com/v1"), "deepseek");
  assertEquals(
    vendorFromBaseURL("https://token-plan-ams.xiaomimimo.com"),
    "xiaomi-token-plan-ams",
  );
  assertEquals(vendorFromBaseURL("https://api.openai.com/v1"), "openai");
  assertEquals(vendorFromBaseURL("https://example.com"), "");
});

Deno.test("BoolPtr", () => {
  assertEquals(boolPtr(true), true);
  assertEquals(boolPtr(false), false);
});

Deno.test("NewUserMessage", () => {
  assertEquals(newUserMessage("hi"), { role: roleUser, content: "hi" });
});
