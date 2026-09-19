// Ported from internal/provider/factory/factory.go

import {
  defaultProviderConfig,
  type ModelCompat as ConfigModelCompat,
  type ModelConfig,
  normalizeSamplingPtr,
  type ProviderConfig,
  resolveKey,
  resolveProviderConfig,
  resolveProviderHeaders,
  type Settings,
} from "../../config/mod.ts";
import { newProviderWithModelsAndOptions as newAnthropicProvider } from "../anthropic/provider.ts";
import {
  newGeminiProviderWithModelsAndOptions,
  newVertexProviderWithModelsAndOptions,
} from "../google/provider.ts";
import { newProviderWithModelsAndOptions as newOpenAIProvider } from "../openai/provider.ts";
import type { Provider } from "../provider.ts";
import type { HTTPClientOptions } from "../http_client.ts";
import type { RetryConfig } from "../retry.ts";
import { resolveAdapterConfig } from "../vendor.ts";
import type { Model, ModelCompat, ModelPricing } from "../types.ts";

export type { RetryConfig };

/** Compatibility behavior outside the settings schema. */
export interface Options {
  builtinAnthropicCacheControl?: boolean;
  /**
   * Requires an explicitly requested model to be advertised by the provider.
   * Legacy callers retain the historical synthetic-model behavior when false.
   */
  requireModel?: boolean;
}

export interface CreateResult {
  provider: Provider;
  model: Model;
}

/** Creates a provider and model from settings without changing the schema. */
export function create(
  settings: Settings,
  providerName: string,
  modelID: string,
): CreateResult {
  return createWithOptions(settings, providerName, modelID, {});
}

/** Creates a provider and model from settings with runtime-only options. */
export function createWithOptions(
  settings: Settings,
  providerName: string,
  modelID: string,
  opts: Options,
): CreateResult {
  if (providerName === "") {
    providerName = settings.defaultProvider ?? "";
    if (modelID === "") modelID = settings.defaultModel ?? "";
  }

  // A provider is usable when it is configured in settings or has a built-in
  // preset; anything else has no base URL or parameters to fall back to.
  if (
    getProviderConfig(settings, providerName) === undefined &&
    defaultProviderConfig(providerName) === undefined
  ) {
    throw new Error(
      `unknown provider: ${providerName} (add it to settings.json providers section)`,
    );
  }

  const pc = resolveProviderConfig(providerName, settings);
  const apiKey = resolveKey(settings, providerName);
  const models = convertModelConfigs(providerName, pc.models);
  const resolved = resolveAdapterConfig(pc);
  const httpOpts: HTTPClientOptions = {
    proxyUrl: pc.httpProxy,
    forceHTTP11: pc.forceHTTP11,
  };

  let p: Provider;
  switch (resolved.api) {
    case "anthropic-messages": {
      const ap = newAnthropicProvider(
        apiKey,
        resolved.baseUrl,
        models,
        httpOpts,
      );
      if (resolved.thinkingFormat !== "") {
        ap.setThinkingFormat(resolved.thinkingFormat);
      }
      let cacheControl = resolved.cacheControl;
      if (cacheControl === undefined) {
        cacheControl = opts.builtinAnthropicCacheControl;
      }
      if (cacheControl !== undefined) ap.setCacheControlEnabled(cacheControl);
      configureRetry(ap, settings);
      p = ap;
      break;
    }
    case "openai-chat":
    case "openai":
    case "openai-responses":
    case "responses": {
      const op = newOpenAIProvider(apiKey, resolved.baseUrl, models, httpOpts);
      op.setMaxImagesPerRequest(pc.maxImagesPerRequest ?? 0);
      if (resolved.thinkingFormat !== "") {
        op.setThinkingFormat(resolved.thinkingFormat);
      }
      if (resolved.api === "openai-responses" || resolved.api === "responses") {
        op.setUseResponsesAPI(true);
        try {
          op.setResponsesConfig(pc.responses ?? {});
        } catch (err) {
          throw new Error(
            `invalid Responses API configuration: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      configureRetry(op, settings);
      p = op;
      break;
    }
    case "google-gemini": {
      const gp = newGeminiProviderWithModelsAndOptions(
        apiKey,
        resolved.baseUrl,
        models,
        httpOpts,
      );
      configureRetry(gp, settings);
      p = gp;
      break;
    }
    case "google-vertex": {
      const gp = newVertexProviderWithModelsAndOptions(
        apiKey,
        resolved.baseUrl,
        models,
        httpOpts,
      );
      configureRetry(gp, settings);
      p = gp;
      break;
    }
    default:
      throw new Error(
        `unsupported API type: ${resolved.api} (use 'openai-chat', 'openai-responses', 'anthropic-messages', 'google-gemini', or 'google-vertex')`,
      );
  }

  configureHeaders(p, settings, providerName);
  let model: Model | undefined;
  if (modelID === "") {
    const availableModels = p.models();
    if (availableModels.length > 0) model = availableModels[0];
  } else {
    model = p.getModel(modelID);
  }
  if (model === undefined) {
    if (modelID === "") {
      throw new Error(`no models available for provider ${providerName}`);
    }
    if (opts.requireModel === true) {
      throw new Error(
        `model "${modelID}" is not available for provider ${providerName}`,
      );
    }
    return {
      provider: p,
      model: {
        id: modelID,
        name: modelID,
        provider: providerName,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 0,
        maxTokens: 0,
      },
    };
  }
  return { provider: p, model: applyModelOverrides(model, settings) };
}

/**
 * Returns the model list a factory-created provider would expose for
 * providerName. It applies the same settings resolution as
 * createWithOptions, so every surface that lists models shares one canonical
 * catalog logic.
 */
export function resolvedModels(
  settings: Settings | undefined,
  providerName: string,
): Model[] {
  if (settings === undefined) return [];
  providerName = providerName.trim();
  if (providerName === "") return [];
  const pc = resolveProviderConfig(providerName, settings);
  return convertModelConfigs(providerName, pc.models);
}

/**
 * Ranks well-known providers before custom ones so the TUI dialogs and the
 * WebUI provider list share one ordering.
 */
export function providerSortPriority(id: string): number {
  const name = id.toLowerCase();
  if (name.includes("moark")) return 10;
  if (name.includes("deepseek")) return 20;
  if (name.includes("xiaomi") || name.includes("mimo")) return 30;
  if (
    name.includes("doubao") || name.includes("volc") || name.includes("ark")
  ) {
    return 40;
  }
  if (name.includes("openai")) return 50;
  if (name.includes("anthropic") || name.includes("claude")) return 60;
  if (
    name.includes("google") || name.includes("gemini") ||
    name.includes("vertex")
  ) {
    return 70;
  }
  return 100;
}

/**
 * Sorts provider IDs by providerSortPriority, then alphabetically, in place.
 */
export function sortProviderIDs(ids: string[]): void {
  ids.sort((a, b) => {
    const pa = providerSortPriority(a);
    const pb = providerSortPriority(b);
    if (pa !== pb) return pa - pb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * Parses the ACP/HARBOR provider/model spelling. The model portion is allowed
 * to contain additional slashes because provider model identifiers are opaque
 * to the factory.
 */
export function parseQualifiedModel(
  raw: string,
): { providerName: string; modelID: string } | undefined {
  raw = raw.trim();
  if (raw === "") return undefined;
  const slash = raw.indexOf("/");
  if (slash < 0) return undefined;
  const providerName = raw.slice(0, slash).trim();
  const modelID = raw.slice(slash + 1).trim();
  if (providerName === "" || modelID === "") return undefined;
  return { providerName, modelID };
}

/**
 * Resolves a session model against an already-created provider. A qualified
 * value must refer to the provider owned by that process; model switches never
 * replace the provider or its credentials.
 */
export function resolveModel(
  p: Provider,
  providerName: string,
  requested: string,
): Model {
  if (p === undefined || p === null) throw new Error("provider is required");
  requested = requested.trim();
  if (requested === "") throw new Error("model is required");
  let modelID = requested;
  if (requested.includes("/")) {
    const parsed = parseQualifiedModel(requested);
    if (parsed === undefined) {
      throw new Error(
        `requested model "${requested}" must use provider/model format`,
      );
    }
    if (providerName === "") providerName = p.name();
    if (
      parsed.providerName.toLowerCase() !== providerName.toLowerCase() &&
      parsed.providerName.toLowerCase() !== p.name().toLowerCase()
    ) {
      throw new Error(
        `model "${requested}" belongs to provider "${parsed.providerName}", current provider is "${providerName}"`,
      );
    }
    modelID = parsed.modelID;
  }
  const model = p.getModel(modelID);
  if (model === undefined) {
    throw new Error(
      `model "${modelID}" is not available for provider "${providerName}"`,
    );
  }
  return model;
}

/** Returns the canonical ACP model option value. */
export function qualifiedModel(providerName: string, model: Model): string {
  if (model === undefined || model === null) return "";
  if (providerName === "") providerName = model.provider;
  if (providerName === "") return model.id;
  return `${providerName}/${model.id}`;
}

function applyModelOverrides(model: Model, settings: Settings): Model {
  if (model === undefined || model === null) return model;
  const overridden: Model = { ...model, input: [...model.input] };
  if (model.compat !== undefined) overridden.compat = { ...model.compat };
  if (settings !== undefined && (settings.maxContextTokens ?? 0) > 0) {
    overridden.contextWindow = settings.maxContextTokens as number;
  }
  return overridden;
}

interface RetryConfigurable {
  setRetryConfig(cfg: RetryConfig | undefined): void;
}

interface HeadersConfigurable {
  setHeaders(headers: Record<string, string> | undefined): void;
}

/** Sets retry config on a provider if it supports it. */
export function configureRetry(p: Provider, settings: Settings): void {
  const rc = p as unknown as Partial<RetryConfigurable>;
  if (typeof rc.setRetryConfig === "function") {
    rc.setRetryConfig({
      enabled: settings.retry?.enabled ?? false,
      maxRetries: settings.retry?.maxRetries ?? 0,
      baseDelayMs: settings.retry?.baseDelayMs ?? 0,
    });
  }
}

/** Sets custom provider headers if the provider supports it. */
export function configureHeaders(
  p: Provider,
  settings: Settings,
  providerName: string,
): void {
  const hc = p as unknown as Partial<HeadersConfigurable>;
  if (typeof hc.setHeaders === "function") {
    hc.setHeaders(resolveProviderHeaders(settings, providerName));
  }
}

/** Converts config.ModelConfig to provider.Model. */
export function convertModelConfigs(
  providerName: string,
  models: ModelConfig[],
): Model[] {
  const result: Model[] = [];
  for (const m of models) {
    let input = m.input;
    if (input === undefined || input.length === 0) input = ["text"];
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
    result.push({
      id: m.id,
      name: m.name,
      provider: providerName,
      reasoning: m.reasoning === true,
      input,
      cost,
      contextWindow: m.contextWindow ?? 0,
      maxTokens: m.maxTokens ?? 0,
      maxTokensSet: (m.fieldSet?.["maxTokens"] ?? false) === true,
      temperature: normalizeSamplingPtr(m.temperature),
      topP: normalizeSamplingPtr(m.top_p),
      compat: convertCompat(m.compat),
    });
  }
  return result;
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

function cloneBool(v: boolean | undefined): boolean | undefined {
  return v === undefined ? undefined : v;
}

function cloneBoolMap(
  src: Record<string, boolean> | undefined,
): Record<string, boolean> | undefined {
  if (src === undefined || Object.keys(src).length === 0) return undefined;
  return { ...src };
}

function getProviderConfig(
  s: Settings,
  name: string,
): ProviderConfig | undefined {
  return s.providers?.[name];
}
