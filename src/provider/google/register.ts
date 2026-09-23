import {
  type ModelCompat as ConfigModelCompat,
  type ModelConfig,
  modelMaxTokensWasSet,
  type ProviderConfig,
} from "../../config/mod.ts";
import { register } from "../registry.ts";
import type { Model, ModelCompat, ModelPricing } from "../types.ts";
import {
  defaultModels,
  newGeminiProvider,
  newGeminiProviderWithModelsAndProxy,
  newVertexProvider,
  newVertexProviderWithModelsAndProxy,
} from "./provider.ts";

/** Resolves `${VAR}`/`!shell` API key references in a provider config. */
export function resolveAPIKey(
  cfg: ProviderConfig | null | undefined,
): string {
  if (cfg == null) return "";
  const key = cfg.apiKey ?? "";
  if (key.startsWith("!")) {
    if (Deno.env.get("VIBECODING_ALLOW_SHELL_CONFIG") !== "1") {
      return key;
    }
    return resolveProviderShellCommand(key.slice(1));
  }
  if (key.startsWith("${") && key.endsWith("}")) {
    return Deno.env.get(key.slice(2, -1)) ?? "";
  }
  return key;
}

function resolveProviderShellCommand(cmd: string): string {
  if (cmd === "") return "";
  try {
    const [program, args] = Deno.build.os === "windows"
      ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd]]
      : ["sh", ["-c", cmd]];
    const result = new Deno.Command(program, {
      args,
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (result.code !== 0) return "";
    return new TextDecoder().decode(result.stdout).trim();
  } catch {
    return "";
  }
}

/** Converts config model entries into provider models. */
export function convertModels(
  providerName: string,
  models: ModelConfig[],
): Model[] {
  if (models.length === 0) {
    return defaultModels(providerName);
  }
  const cost: ModelPricing = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  return models.map((m) => {
    let input = m.input;
    if (input === undefined || input.length === 0) {
      input = ["text", "image"];
    }
    return {
      id: m.id,
      name: m.name,
      provider: providerName,
      reasoning: m.reasoning === true,
      input,
      cost,
      contextWindow: m.contextWindow ?? 0,
      maxTokens: m.maxTokens ?? 0,
      maxTokensSet: modelMaxTokensWasSet(m),
      temperature: m.temperature,
      topP: m.top_p,
      compat: toCompat(m.compat),
    };
  });
}

/** Converts config compatibility flags into provider compatibility flags. */
export function toCompat(
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
  if (v === undefined) return undefined;
  return v;
}

// Mirrors the Go init(): register the Gemini and Vertex provider factories.
register(
  "google-gemini",
  (cfg) =>
    cfg == null
      ? newGeminiProvider("", "")
      : newGeminiProviderWithModelsAndProxy(
        resolveAPIKey(cfg),
        cfg.baseUrl ?? "",
        cfg.httpProxy ?? "",
        convertModels("google-gemini", cfg.models),
      ),
);
register(
  "google-vertex",
  (cfg) =>
    cfg == null
      ? newVertexProvider("", "")
      : newVertexProviderWithModelsAndProxy(
        resolveAPIKey(cfg),
        cfg.baseUrl ?? "",
        cfg.httpProxy ?? "",
        convertModels("google-vertex", cfg.models),
      ),
);
