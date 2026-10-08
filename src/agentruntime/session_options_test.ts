// Focused tests for the ported internal/agentruntime/session_options.go.
// The Go package had no dedicated test file; these pin the observable catalog
// contract that ACP serializes.

import { assertEquals, assertThrows } from "@opensac/assert";
import type { Model } from "../provider/types.ts";
import {
  thinkingHigh,
  thinkingMax,
  thinkingMedium,
  thinkingOff,
} from "../provider/types.ts";
import type { Provider } from "../provider/provider.ts";
import { MODE_YOLO } from "./source.ts";
import {
  CONFIG_OPTION_MODE,
  CONFIG_OPTION_PROVIDER,
  CONFIG_OPTION_THINKING_LEVEL,
  providerDisplayName,
  sessionConfigOptionsWithProviders,
  validateThinkingLevel,
} from "./session_options.ts";

function model(id: string, name: string, reasoning = false): Model {
  return {
    id,
    name,
    provider: "test",
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
}

Deno.test("SessionConfigOptionsWithProvidersBuildsSortedCatalog", () => {
  const providers = {
    openai: {} as Provider,
    "test-api": {} as Provider,
  };
  const options = sessionConfigOptionsWithProviders(
    "test",
    providers,
    [model("z", "Zed"), model("a", "Alpha"), model("a", "Alpha")],
    model("a", "Alpha", true),
    MODE_YOLO,
    thinkingHigh,
  );

  const provider = options.find((o) => o.id === CONFIG_OPTION_PROVIDER)!;
  assertEquals(provider.options!.map((c) => c.value), ["openai", "test-api"]);
  assertEquals(provider.options!.map((c) => c.name), ["OpenAI", "Test API"]);

  const modelOption = options.find((o) => o.id === "model")!;
  assertEquals(modelOption.options!.map((c) => c.value), [
    "test/a",
    "test/z",
  ]);

  const mode = options.find((o) => o.id === CONFIG_OPTION_MODE)!;
  assertEquals(mode.currentValue, MODE_YOLO);

  // Thinking level appears only for a reasoning model.
  const thinking = options.find((o) => o.id === CONFIG_OPTION_THINKING_LEVEL)!;
  assertEquals(thinking.currentValue, thinkingHigh);
  assertEquals(thinking.options!.map((c) => c.value), [
    thinkingOff,
    "minimal",
    "low",
    thinkingMedium,
    thinkingHigh,
    "xhigh",
    thinkingMax,
  ]);
});

Deno.test("SessionConfigOptionsOmitsThinkingForNonReasoningModel", () => {
  const options = sessionConfigOptionsWithProviders(
    "test",
    {},
    [model("a", "Alpha")],
    model("a", "Alpha"),
    MODE_YOLO,
    thinkingHigh,
  );
  assertEquals(
    options.some((o) => o.id === CONFIG_OPTION_THINKING_LEVEL),
    false,
  );
});

Deno.test("ValidateThinkingLevelAcceptsKnownAndRejectsUnknown", () => {
  assertEquals(validateThinkingLevel(""), thinkingMedium);
  assertEquals(validateThinkingLevel("high"), thinkingHigh);
  assertThrows(() => validateThinkingLevel("bogus"), Error);
});

Deno.test("ProviderDisplayNameCapitalizesAndPreservesAcronyms", () => {
  assertEquals(providerDisplayName("openai"), "OpenAI");
  assertEquals(providerDisplayName("test-api"), "Test API");
  assertEquals(providerDisplayName("agentplan"), "AgentPlan");
});
