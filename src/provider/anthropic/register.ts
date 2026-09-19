// Ported from internal/provider/anthropic/register.go

import {
  type ModelCompat as ConfigModelCompat,
  modelMaxTokensWasSet,
  type ProviderConfig,
} from "../../config/mod.ts";
import { register } from "../registry.ts";
import type { Model, ModelCompat, ModelPricing } from "../types.ts";
import {
  defaultModels,
  newProvider,
  newProviderWithModelsAndProxy,
} from "./provider.ts";

/** Resolves the model list for an Anthropic-compatible provider config. */
export function resolveAnthropicModels(
  cfg: ProviderConfig | null | undefined,
): Model[] {
  if (cfg != null && cfg.models.length > 0) {
    const models: Model[] = [];
    for (const m of cfg.models) {
      let input = m.input;
      if (input === undefined || input.length === 0) {
        input = ["text", "image"];
      }
      let cost: ModelPricing = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
      if (m.cost !== undefined) {
        cost = {
          input: m.cost.input,
          output: m.cost.output,
          cacheRead: m.cost.cacheRead ?? 0,
          cacheWrite: m.cost.cacheWrite ?? 0,
        };
      }
      models.push({
        id: m.id,
        name: m.name,
        provider: "anthropic",
        reasoning: m.reasoning === true,
        input,
        cost,
        contextWindow: m.contextWindow ?? 0,
        maxTokens: m.maxTokens ?? 0,
        maxTokensSet: modelMaxTokensWasSet(m),
        temperature: m.temperature,
        topP: m.top_p,
        compat: convertCompat(m.compat),
      });
    }
    return models;
  }
  return defaultModels();
}

/** Converts config compatibility flags into provider compatibility flags. */
export function convertCompat(
  c: ConfigModelCompat | undefined,
): ModelCompat | undefined {
  if (c === undefined) return undefined;
  const compat: ModelCompat = {
    thinkingFormat: c.thinkingFormat,
    requiresReasoningContentOnAssistant:
      c.requiresReasoningContentOnAssistant === true ||
      c.requiresReasoningContentOnAssistantMessages === true,
    forceAdaptiveThinking: c.forceAdaptiveThinking,
    parseReasoningInContent: c.parseReasoningInContent,
    supportsDeveloperRole: cloneBool(c.supportsDeveloperRole),
    supportsStore: cloneBool(c.supportsStore),
    supportsReasoningEffort: cloneBool(c.supportsReasoningEffort),
    supportsStrictMode: cloneBool(c.supportsStrictMode),
    maxTokensField: c.maxTokensField,
    disableSamplingParams: cloneBool(c.disableSamplingParams),
    supportsCacheControlOnTools: cloneBool(c.supportsCacheControlOnTools),
    supportsLongCacheRetention: cloneBool(c.supportsLongCacheRetention),
    supportsPromptCacheKey: cloneBool(c.supportsPromptCacheKey),
    supportsReasoningSummary: cloneBool(c.supportsReasoningSummary),
    sendSessionAffinityHeaders: c.sendSessionAffinityHeaders,
    supportsEagerToolInputStreaming: cloneBool(
      c.supportsEagerToolInputStreaming,
    ),
  };
  return compat;
}

function cloneBool(v: boolean | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  return v;
}

/** Builds an Anthropic provider from a provider config. */
function createAnthropicProvider(cfg: ProviderConfig): ReturnType<
  typeof newProvider
> {
  return newProviderWithModelsAndProxy(
    cfg.apiKey ?? "",
    cfg.baseUrl ?? "",
    cfg.httpProxy ?? "",
    resolveAnthropicModels(cfg),
  );
}

// Mirrors the Go init(): register the generic Anthropic-compatible provider
// factory so builder/model resolution through the global registry can construct
// Anthropic-style providers.
register(
  "anthropic",
  (cfg) => cfg == null ? newProvider("", "") : createAnthropicProvider(cfg),
);
register(
  "anthropic-messages",
  (cfg) => cfg == null ? newProvider("", "") : createAnthropicProvider(cfg),
);
