import { assert, assertEquals } from "@opensac/assert";
import { presetModelConfig } from "./model_preset.ts";
import { defaultProviderConfigsAll } from "./settings.ts";

// TestPresetModelConfigExactMatchInCurrentProvider pins step 1 of the
// resolution order: the current provider's own catalog wins.
Deno.test("preset model config prefers the current provider catalog", () => {
  const preset = presetModelConfig("anthropic", "claude-3-5-haiku-20241022");
  assertEquals(preset.id, "claude-3-5-haiku-20241022");
  assertEquals(preset.name, "Claude Haiku 3.5");
  assertEquals(preset.contextWindow, 200000);
  assert(preset.input?.includes("image"));
});

Deno.test("preset model config returns a copy the caller may mutate", () => {
  const catalog = defaultProviderConfigsAll();
  const builtin = catalog["anthropic"].models.find((m) =>
    m.id === "claude-3-5-haiku-20241022"
  );
  assert(builtin);

  const preset = presetModelConfig("anthropic", "claude-3-5-haiku-20241022");
  preset.name = "mutated";
  preset.contextWindow = 1;

  assertEquals(builtin.name, "Claude Haiku 3.5");
  assertEquals(builtin.contextWindow, 200000);
});

Deno.test("preset model config falls back to any other built-in provider", () => {
  const catalog = defaultProviderConfigsAll();
  const providerIDs = Object.keys(catalog).filter((pid) => pid !== "anthropic");
  assert(providerIDs.length > 0);
  const donor = providerIDs.find((pid) =>
    catalog[pid].models.some((m) => m.id === "gpt-4")
  );
  assert(donor !== undefined, "expected gpt-4 in a non-anthropic provider");

  const preset = presetModelConfig("anthropic", "gpt-4");
  assertEquals(preset.id, "gpt-4");
  const expected = catalog[donor].models.find((m) => m.id === "gpt-4");
  assert(expected);
  assertEquals(preset.name, expected.name);
  assertEquals(preset.contextWindow, expected.contextWindow);
});

Deno.test("preset model config matches case-insensitively before giving up", () => {
  const preset = presetModelConfig("anthropic", "CLAUDE-3-5-HAIKU-20241022");
  assertEquals(preset.id, "CLAUDE-3-5-HAIKU-20241022");
  assertEquals(preset.contextWindow, 200000);
});

Deno.test("preset model config unknown ids get generic defaults", () => {
  const preset = presetModelConfig("anthropic", "totally-unknown-model-xyz");
  assertEquals(preset, {
    id: "totally-unknown-model-xyz",
    name: "totally-unknown-model-xyz",
    reasoning: true,
    contextWindow: 256_000,
    input: ["text"],
  });

  const empty = presetModelConfig("", "");
  assertEquals(empty, {
    id: "",
    name: "",
    reasoning: true,
    contextWindow: 256_000,
    input: ["text"],
  });

  const unknownProvider = presetModelConfig("no-such-provider", "gpt-4");
  assertEquals(unknownProvider.id, "gpt-4");
  assertEquals(unknownProvider.name, "GPT-4");
});
