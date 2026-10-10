// (agent/provider.go).
//
// The public SDK boundary lives in `sdk/`; this module must not import from
// `src/`.

import {
  type Attachment,
  type Message,
  type ToolCallBlock,
  type ToolDefinition,
  type Usage,
} from "./types.ts";

/**
 * Provider is the interface that all LLM provider implementations must
 * satisfy. External developers implement this to integrate custom LLM
 * backends.
 */
export interface Provider {
  /** Sends a chat request and returns a stream of events. */
  chat(params: ChatParams): AsyncIterable<StreamEvent>;

  /** Returns the provider's name (e.g. "openai", "anthropic"). */
  name(): string;

  /** Returns the list of available models. */
  models(): ModelInfo[];

  /** Returns a model by ID, or undefined if not found. */
  getModel(id: string): ModelInfo | undefined;
}

/** ChatParams holds parameters for a chat request. */
export interface ChatParams {
  messages: Message[];
  tools?: ToolDefinition[];
  systemPrompt: string;
  thinkingLevel: ThinkingLevel;
  maxTokens: number;
  modelId: string;
  /** Aborted to cancel the request. */
  abort?: AbortSignal;
}

/** ThinkingLevel represents the thinking/reasoning level. */
export type ThinkingLevel = string;

export const thinkingOff: ThinkingLevel = "off";
export const thinkingMinimal: ThinkingLevel = "minimal";
export const thinkingLow: ThinkingLevel = "low";
export const thinkingMedium: ThinkingLevel = "medium";
export const thinkingHigh: ThinkingLevel = "high";
export const thinkingXHigh: ThinkingLevel = "xhigh";
export const thinkingMax: ThinkingLevel = "max";

/** StreamEventType identifies the type of stream event. */
export type StreamEventType = number;

export const streamStart: StreamEventType = 0;
export const streamTextDelta: StreamEventType = 1;
export const streamThinkDelta: StreamEventType = 2;
export const streamToolCall: StreamEventType = 3;
export const streamUsage: StreamEventType = 4;
export const streamDone: StreamEventType = 5;
export const streamError: StreamEventType = 6;
export const streamHostedItem: StreamEventType = 7;
export const streamRetry: StreamEventType = 8;

/** StreamEvent represents an event from the LLM stream. */
export interface StreamEvent {
  type: StreamEventType;
  textDelta?: string;
  thinkDelta?: string;
  toolCall?: ToolCallBlock;
  hostedItem?: HostedItem;
  usage?: Usage;
  stopReason?: string;
  error?: Error;
  retryAttempt?: number;
  retryMaxAttempts?: number;
  retryAfterMs?: number;
  attachments?: Attachment[];
}

/**
 * HostedItem is the provider-neutral lifecycle projection for a native hosted
 * tool item. The full canonical payload remains in the provider archive.
 */
export interface HostedItem {
  id: string;
  type: string;
  status: string;
  outputIndex: number;
  metadata?: Record<string, unknown>;
}

/** ModelInfo describes a model available from a provider. */
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  compat?: ModelCompat;
}

/**
 * ModelCompat defines per-model compatibility flags. These flags control how
 * the provider adjusts requests/responses for vendor-specific differences.
 */
export interface ModelCompat {
  // Thinking/reasoning
  thinkingFormat?: string; // "deepseek"|"openai"|"anthropic"|"together"|"zai"|"qwen"
  requiresReasoningContentOnAssistant?: boolean;
  forceAdaptiveThinking?: boolean;

  // API parameter compatibility
  /** undefined = true */
  supportsDeveloperRole?: boolean;
  /** undefined = true */
  supportsStore?: boolean;
  /** undefined = true */
  supportsReasoningEffort?: boolean;
  /** undefined = true */
  supportsStrictMode?: boolean;
  maxTokensField?: string; // "max_tokens"|"max_completion_tokens"
  /**
   * Omits temperature/top_p from requests. Defaults to true (undefined):
   * sampling parameters are only sent when explicitly set to false.
   */
  disableSamplingParams?: boolean;

  // Cache
  /** undefined = true */
  supportsCacheControlOnTools?: boolean;
  /** undefined = true */
  supportsLongCacheRetention?: boolean;
  sendSessionAffinityHeaders?: boolean;

  // Streaming
  /** undefined = true */
  supportsEagerToolInputStreaming?: boolean;
}

/** Returns a boolean value usable where an optional bool is expected. */
export function boolPtr(v: boolean): boolean {
  return v;
}

/**
 * BaseProvider provides common functionality for provider implementations.
 * Extend it in your custom Provider to get models/getModel for free.
 */
export class BaseProvider {
  private readonly providerName: string;
  private readonly providerModels: ModelInfo[];

  constructor(name: string, models: ModelInfo[]) {
    this.providerName = name;
    this.providerModels = models;
  }

  /** Returns the provider's name. */
  name(): string {
    return this.providerName;
  }

  /** Returns the list of available models. */
  models(): ModelInfo[] {
    return this.providerModels;
  }

  /** Returns a model by ID, or undefined if not found. */
  getModel(id: string): ModelInfo | undefined {
    return this.providerModels.find((m) => m.id === id);
  }
}

/**
 * Attempts to identify the vendor from a base URL. Returns empty string if no
 * match. Order matters: more specific domains must come before less specific
 * ones to avoid false positives from substring matching.
 */
export function vendorFromBaseURL(baseURL: string): string {
  const vendorEntries: [string, string][] = [
    // xiaomi token plans (longer domains first to avoid matching xiaomimimo.com)
    ["token-plan-ams.xiaomimimo.com", "xiaomi-token-plan-ams"],
    ["token-plan-cn.xiaomimimo.com", "xiaomi-token-plan-cn"],
    ["token-plan-sgp.xiaomimimo.com", "xiaomi-token-plan-sgp"],
    ["api.xiaomimimo.com", "xiaomi"],
    ["api.xiaomi.com", "xiaomi"],
    // deepseek
    ["api.deepseek.com", "deepseek"],
    // kimi / moonshot
    ["api.moonshot.cn", "kimi"],
    ["api.kimi.com", "kimi"],
    ["api.moonshot.ai", "moonshotai"],
    // zai
    ["api.z.ai", "zai"],
    ["open.bigmodel.cn", "zai"],
    // other vendors
    ["api.minimaxi.com", "minimax"],
    ["ark.cn-beijing.volces.com", "volcengine"],
    ["aip.baidubce.com", "qianfan"],
    ["dashscope.aliyuncs.com", "bailian"],
    ["ai.gitee.com", "gitee"],
    ["api.moark.com", "gitee"],
    ["openrouter.ai", "openrouter"],
    ["api.together.xyz", "together"],
    ["api.groq.com", "groq"],
    ["api.fireworks.ai", "fireworks"],
    // newly added to match vendor adapters
    ["apihub.agnes-ai.com", "agnes"],
    ["api.agnes-ai.cn", "agnes"],
    ["api.anthropic.com", "anthropic"],
    ["api.ant-ling.com", "ant-ling"],
    ["api.cerebras.ai", "cerebras"],
    ["generativelanguage.googleapis.com", "google-gemini"],
    ["aiplatform.googleapis.com", "google-vertex"],
    ["router.huggingface.co", "huggingface"],
    ["integrate.api.nvidia.com", "nvidia"],
    ["api.openai.com", "openai"],
    ["opencode.ai", "opencode"],
    ["ai-gateway.vercel.sh", "vercel-ai-gateway"],
    ["api.x.ai", "xai"],
  ];
  for (const [domain, vendor] of vendorEntries) {
    if (contains(baseURL, domain)) {
      return vendor;
    }
  }
  return "";
}

function contains(s: string, substr: string): boolean {
  return substr.length <= s.length && s.includes(substr);
}
