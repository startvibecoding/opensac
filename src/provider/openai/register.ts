// Ported from internal/provider/openai/register.go

import type {
  ModelCompat as ConfigModelCompat,
  ProviderConfig,
} from "../../config/mod.ts";
import { modelMaxTokensWasSet } from "../../config/mod.ts";
import { register } from "../registry.ts";
import type { Model, ModelCompat, ModelPricing } from "../types.ts";
import {
  defaultModels,
  newProvider,
  newProviderWithModelsAndProxy,
  type Provider,
} from "./provider.ts";

export function resolveOpenAIModels(
  cfg: ProviderConfig | null | undefined,
): Model[] {
  if (cfg != null && cfg.models.length > 0) {
    const models: Model[] = [];
    for (const m of cfg.models) {
      let input = m.input;
      if (input === undefined || input.length === 0) input = ["text", "image"];
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
        provider: "openai",
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

export function convertCompat(
  c: ConfigModelCompat | undefined,
): ModelCompat | undefined {
  if (c === undefined) return undefined;
  return {
    thinkingFormat: c.thinkingFormat,
    requiresReasoningContentOnAssistant:
      c.requiresReasoningContentOnAssistant === true ||
      c.requiresReasoningContentOnAssistantMessages === true,
    forceAdaptiveThinking: c.forceAdaptiveThinking,
    parseReasoningInContent: c.parseReasoningInContent,
    supportsDeveloperRole: cloneBool(c.supportsDeveloperRole),
    supportsStore: cloneBool(c.supportsStore),
    supportsResponses: cloneBool(c.supportsResponses),
    supportsPreviousResponseId: cloneBool(c.supportsPreviousResponseId),
    supportsConversation: cloneBool(c.supportsConversation),
    supportsBackground: cloneBool(c.supportsBackground),
    supportsStructuredOutput: cloneBool(c.supportsStructuredOutput),
    supportsServiceTier: cloneBool(c.supportsServiceTier),
    supportsParallelToolCalls: cloneBool(c.supportsParallelToolCalls),
    supportsToolChoice: cloneBool(c.supportsToolChoice),
    supportsHostedTools: cloneBoolMap(c.supportsHostedTools),
    supportedInclude: c.supportedInclude === undefined
      ? undefined
      : [...c.supportedInclude],
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
}

function cloneBoolMap(
  src: Record<string, boolean> | undefined,
): Record<string, boolean> | undefined {
  if (src === undefined || Object.keys(src).length === 0) return undefined;
  return { ...src };
}

function cloneBool(v: boolean | undefined): boolean | undefined {
  return v === undefined ? undefined : v;
}

/** Builds an OpenAI provider from a provider config. */
export function createOpenAIProvider(
  cfg: ProviderConfig | null | undefined,
): Provider {
  if (cfg == null) return newProvider("", "");
  const p = newProviderWithModelsAndProxy(
    cfg.apiKey ?? "",
    cfg.baseUrl ?? "",
    cfg.httpProxy ?? "",
    resolveOpenAIModels(cfg),
  );
  p.setMaxImagesPerRequest(cfg.maxImagesPerRequest ?? 0);
  if (cfg.api === "openai-responses" || cfg.api === "responses") {
    p.setUseResponsesAPI(true);
    p.setResponsesConfig(cfg.responses ?? {});
  }
  return p;
}

// Mirrors the Go init(): register the generic OpenAI-compatible provider
// factory in the global registry so Builder/WithProviderByName can construct
// OpenAI-style providers by name.
register("openai", (cfg) => createOpenAIProvider(cfg));
register("openai-chat", (cfg) => createOpenAIProvider(cfg));
register("openai-responses", (cfg) => createOpenAIProvider(cfg));
register("responses", (cfg) => createOpenAIProvider(cfg));
