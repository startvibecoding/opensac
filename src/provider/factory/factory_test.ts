// Ported from internal/provider/factory/factory_test.go

import { assert, assertEquals } from "@std/assert";
import { defaultSettings, type Settings } from "../../config/mod.ts";
import { MockProvider } from "../mock.ts";
import type { Model } from "../types.ts";
import {
  convertModelConfigs,
  create,
  parseQualifiedModel,
  resolvedModels,
  resolveModel,
  sortProviderIDs,
} from "./factory.ts";

function model(id: string, provider = "openai"): Model {
  return {
    id,
    name: id,
    provider,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  };
}

Deno.test("ParseQualifiedModel", () => {
  const parsed = parseQualifiedModel("openai/gpt-5/coding");
  assert(parsed !== undefined);
  assertEquals(parsed!.providerName, "openai");
  assertEquals(parsed!.modelID, "gpt-5/coding");
  assertEquals(parseQualifiedModel("gpt-5"), undefined);
});

Deno.test("ResolveModelRejectsInvalidAndForeignModels", () => {
  const p = new MockProvider("openai", [model("valid", "openai")], []);
  let error: Error | undefined;
  try {
    resolveModel(p, "openai", "missing");
  } catch (err) {
    error = err as Error;
  }
  assert(error !== undefined);

  error = undefined;
  try {
    resolveModel(p, "openai", "anthropic/valid");
  } catch (err) {
    error = err as Error;
  }
  assert(error !== undefined);

  const resolved = resolveModel(p, "openai", "openai/valid");
  assertEquals(resolved.id, "valid");
});

Deno.test("ConvertModelConfigsPreservesCompat", () => {
  const models = convertModelConfigs("test", [{
    id: "m1",
    name: "M1",
    reasoning: true,
    compat: {
      thinkingFormat: "deepseek",
      supportsReasoningEffort: false,
      maxTokensField: "max_completion_tokens",
    },
  }]);
  assertEquals(models.length, 1);
  const compat = models[0].compat;
  assert(compat !== undefined);
  assertEquals(compat!.thinkingFormat, "deepseek");
  assertEquals(compat!.supportsReasoningEffort, false);
  assertEquals(compat!.maxTokensField, "max_completion_tokens");
});

Deno.test("CreateOpenAIResponsesProvider", () => {
  const settings: Settings = {
    providers: {
      "openai-responses-test": {
        apiKey: "fake-key",
        baseUrl: "https://api.openai.com/v1",
        api: "openai-responses",
        responses: {
          reasoningSummary: "concise",
          promptCacheKey: "custom-cache-key",
          promptCacheRetention: "24h",
        },
        models: [{ id: "gpt-test", name: "GPT Test" }],
      },
    },
  };
  const result = create(settings, "openai-responses-test", "gpt-test");
  assertEquals(result.model.id, "gpt-test");
});

Deno.test("CreateFallbackToFirstModel", () => {
  const settings: Settings = {
    providers: {
      "custom-provider": {
        apiKey: "fake-key",
        baseUrl: "https://api.openai.com/v1",
        api: "openai",
        models: [
          { id: "model-one", name: "Model One" },
          { id: "model-two", name: "Model Two" },
        ],
      },
    },
    defaultProvider: "custom-provider",
    defaultModel: "model-two",
  };
  assertEquals(create(settings, "custom-provider", "").model.id, "model-one");

  const p2 = create(settings, "openai", "").provider;
  const available = p2.models();
  assert(available.length > 0);
});

Deno.test("CreatePreservesUnknownModelID", () => {
  const settings: Settings = {
    providers: {
      "custom-provider": {
        apiKey: "fake-key",
        baseUrl: "https://api.openai.com/v1",
        api: "openai-chat",
        models: [{ id: "model-one", name: "Model One" }],
      },
    },
  };
  assertEquals(
    create(settings, "custom-provider", "missing-model").model.id,
    "missing-model",
  );
});

Deno.test("CreateRejectsUnknownProvider", () => {
  const settings = defaultSettings();
  let error: Error | undefined;
  try {
    create(settings, "definitely-not-a-provider", "");
  } catch (err) {
    error = err as Error;
  }
  assert(error !== undefined);
  assert(error!.message.includes("unknown provider"));
});

Deno.test("ResolvedModelsMatchesFactoryProviderList", () => {
  const settings = defaultSettings();
  settings.providers = {
    anthropic: { apiKey: "fake-key", models: [] },
    custom: {
      baseUrl: "https://example.com/v1",
      apiKey: "fake-key",
      api: "openai-chat",
      models: [{ id: "m1", name: "M1" }],
    },
  };
  const builtin = resolvedModels(settings, "anthropic");
  assert(builtin.length > 0);
  for (const m of builtin) assertEquals(m.provider, "anthropic");

  const p = create(settings, "custom", "m1").provider;
  const resolved = resolvedModels(settings, "custom");
  const exposed = p.models();
  assertEquals(resolved.length, exposed.length);
  assertEquals(resolved[0].id, exposed[0].id);
  assertEquals(resolved[0].input, ["text"]);

  assertEquals(resolvedModels(settings, ""), []);
  assertEquals(resolvedModels(undefined, "anthropic"), []);
  assertEquals(resolvedModels(settings, "unknown-no-preset"), []);
});

Deno.test("SortProviderIDsUsesSharedPriority", () => {
  const ids = ["zz-custom", "openai", "moark", "anthropic", "aa-custom"];
  sortProviderIDs(ids);
  assertEquals(ids, ["moark", "openai", "anthropic", "aa-custom", "zz-custom"]);
});
