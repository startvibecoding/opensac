// Ported from internal/provider/types.go
//
// JSON compatibility notes:
// - Go struct tags map to camelCase fields; `omitempty` maps to optional (`?`)
//   fields that are omitted when `undefined`.
// - `json.RawMessage` maps to `unknown` holding the decoded JSON value. Go
//   injects the raw bytes verbatim when marshaling, while `JSON.stringify` of a
//   decoded value produces the equivalent JSON document. The one gap (bytes
//   that are not valid JSON) is carried in `invalidArguments`, mirroring the
//   Go agent's normalization.
// - `time.Time` maps to `Date`.

/** CacheControl represents cache control hints for prompt caching. */
export interface CacheControl {
  /** "ephemeral" for breakpoint markers */
  type: string;
}

/** ContentBlock represents a block of content in a message. */
export interface ContentBlock {
  /** "text", "image", "file", "thinking", "toolCall" */
  type: string;
  text?: string;
  thinking?: string;
  /** required for thinking block replay */
  signature?: string;
  image?: ImageContent;
  file?: FileContent;
  toolCall?: ToolCallBlock;
  /** cache breakpoint marker */
  cache_control?: CacheControl;
}

/**
 * FileContent identifies an existing provider file or carries an inline file
 * payload for APIs that support file content blocks.
 */
export interface FileContent {
  id?: string;
  url?: string;
  /** base64 encoded */
  data?: string;
  filename?: string;
  mimeType?: string;
  title?: string;
  description?: string;
  size?: number;
}

/** ImageContent represents an image in a message. */
export interface ImageContent {
  /** base64 encoded */
  data: string;
  /** e.g. "image/png" */
  mimeType: string;
  width?: number;
  height?: number;
  bytes?: number;
  originalWidth?: number;
  originalHeight?: number;
  originalBytes?: number;
  /** "auto", "fast", "detail", "raw" */
  detail?: string;
  scale?: number;
  cropped?: boolean;
  cropX?: number;
  cropY?: number;
  cropWidth?: number;
  cropHeight?: number;
}

/** ToolCallBlock represents a tool call in an assistant message. */
export interface ToolCallBlock {
  id: string;
  name: string;
  /** function or custom */
  kind?: string;
  input?: string;
  /** Raw tool arguments (Go `json.RawMessage`). */
  arguments?: unknown;
  invalidArguments?: string;
  thoughtSignature?: string;
}

/** Message represents a conversation message. */
export interface Message {
  /** "user", "assistant", "toolResult" */
  role: string;
  /** simple text content */
  content?: string;
  /** rich content blocks */
  contents?: ContentBlock[];
  /** provider-neutral output artifacts */
  attachments?: Attachment[];
  /** for toolResult */
  toolCallId?: string;
  /** for toolResult */
  toolName?: string;
  /** function or custom */
  toolKind?: string;
  /** for toolResult */
  isError?: boolean;
  timestamp: Date;
  /** token usage from API response */
  usage?: Usage;
  /**
   * true for injected messages (session context, compression instructions) -
   * skipped by cache markers
   */
  systemInjected?: boolean;
}

/** Creates a simple user text message. */
export function newUserMessage(text: string): Message {
  return { role: "user", content: text, timestamp: new Date() };
}

/**
 * Creates a system-injected user message (skipped by cache markers).
 */
export function newSystemInjectedUserMessage(text: string): Message {
  return {
    role: "user",
    content: text,
    timestamp: new Date(),
    systemInjected: true,
  };
}

/** Creates an assistant message with content blocks. */
export function newAssistantMessage(contents: ContentBlock[]): Message {
  return { role: "assistant", contents, timestamp: new Date() };
}

/** Creates a tool result message. */
export function newToolResultMessage(
  toolCallId: string,
  toolName: string,
  content: string,
  isError: boolean,
): Message {
  return {
    role: "toolResult",
    content,
    toolCallId,
    toolName,
    isError,
    timestamp: new Date(),
  };
}

/**
 * Creates a tool result message with rich content blocks.
 * If contents is nil or empty, it falls back to using the text parameter.
 */
export function newToolResultMessageWithContents(
  toolCallId: string,
  toolName: string,
  text: string,
  contents: ContentBlock[] | null,
  isError: boolean,
): Message {
  const msg: Message = {
    role: "toolResult",
    toolCallId,
    toolName,
    isError,
    timestamp: new Date(),
  };
  if (contents !== null && contents.length > 0) {
    msg.contents = contents;
    // Also set Content for backward compatibility (display/logging)
    msg.content = text;
  } else {
    msg.content = text;
  }
  return msg;
}

/** Usage represents token usage and cost information. */
export interface Usage {
  input: number;
  output: number;
  reasoning?: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: Cost;
}

/**
 * Returns the provider-reported prompt token count for the turn.
 * For OpenAI-compatible APIs this is the full prompt footprint. For Anthropic,
 * Input is normalized to the non-cached prompt portion, so callers that need
 * the full prompt footprint should use totalInputTokens instead.
 */
export function promptTokens(u: Usage | null | undefined): number {
  if (u == null) return 0;
  if (u.totalTokens > 0) {
    const prompt = u.totalTokens - u.output;
    if (prompt > 0) return prompt;
  }
  return u.input;
}

/**
 * Returns the full input footprint for the turn, including cache reads and
 * cache writes when those are reported separately.
 */
export function totalInputTokens(u: Usage | null | undefined): number {
  if (u == null) return 0;
  if (u.totalTokens > 0) {
    const totalInput = u.totalTokens - u.output;
    if (totalInput > 0) return totalInput;
  }
  return u.input + u.cacheRead + u.cacheWrite;
}

/**
 * Returns a short display string for cache activity (e.g. "Cache: 75%"), or an
 * empty string when there is no cache data to show.
 *
 * Cache percentage uses the full prompt footprint as the denominator so the
 * value means "what portion of this turn's prompt came from cache".
 */
export function cacheInfo(u: Usage | null | undefined): string {
  if (u == null) return "";
  const total = totalInputTokens(u);
  if (total > 0 && u.cacheRead > 0) {
    let pct = (u.cacheRead / total) * 100;
    if (pct > 100) pct = 100;
    return `Cache: ${roundGof(pct)}%`;
  }
  if (u.cacheWrite > 0 && u.cacheRead === 0) {
    return `CacheWrite: ${u.cacheWrite}`;
  }
  if (total > 0 && u.cacheRead === 0 && u.cacheWrite === 0) {
    return "Cache: 0%";
  }
  return "";
}

/** Rounds like Go's `%.0f` (round half to even). */
function roundGof(value: number): string {
  const rounded = goRoundHalfEven(value);
  return String(rounded);
}

/**
 * Rounds to the nearest integer using round-half-to-even, matching Go's
 * strconv float formatting used by `%.0f`.
 */
function goRoundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Describes whether a completed stream turn produced a meaningful response. */
export type TurnClassification = number;

/**
 * TurnMeaningful means the turn produced content (text/thinking/toolCall) or
 * the model explicitly signalled a normal stop.
 */
export const turnMeaningful: TurnClassification = 0;
/**
 * TurnEmpty means the turn produced no content AND usage looks like a
 * placeholder/error sentinel with no explicit stop reason.
 */
export const turnEmpty: TurnClassification = 1;

/**
 * Inspects the accumulated turn output and reports whether it is a meaningful
 * response or an effectively empty one.
 */
export function classifyTurn(
  text: string,
  think: string,
  toolCalls: ToolCallBlock[] | null,
  usage: Usage | null | undefined,
  stopReason: string,
): TurnClassification {
  if (
    text !== "" || think !== "" || (toolCalls != null && toolCalls.length > 0)
  ) {
    return turnMeaningful;
  }
  if (isStubUsage(usage) && !isDefiniteStopReason(stopReason)) {
    return turnEmpty;
  }
  return turnMeaningful;
}

/**
 * Reports whether a Usage looks like a placeholder/error sentinel. Nil usage or
 * implausibly small values (total<=2, or input<=1) cannot occur on a real
 * response because the prompt alone is always >= the context tokens, so this is
 * safe across all vendors/protocols.
 */
export function isStubUsage(u: Usage | null | undefined): boolean {
  if (u == null) return true;
  // A real response's input always carries at least the prompt tokens
  // (thousands+), so Input<=1 is impossible outside a placeholder/error body.
  // TotalTokens<=2 catches the same case when a gateway reports only the
  // aggregate. Output is intentionally not used as a signal: a model may
  // legitimately emit very few output tokens.
  return u.input <= 1 || u.totalTokens <= 2;
}

/** Renders a Usage for inclusion in error/status messages. */
export function formatUsage(u: Usage | null | undefined): string {
  if (u == null) return "nil";
  return `{input:${u.input} output:${u.output} total:${u.totalTokens}}`;
}

/**
 * Reports whether stopReason is an explicit, provider-reported normal-stop
 * signal.
 */
function isDefiniteStopReason(reason: string): boolean {
  switch (reason.trim().toLowerCase()) {
    case "stop":
    case "end_turn":
    case "finish":
    case "complete":
    case "completed":
    case "ended":
      return true;
    default:
      return false;
  }
}

/** Cost represents the monetary cost of a request. */
export interface Cost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** Returns a zero-valued Cost. */
export function newCost(): Cost {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

/**
 * Returns input tokens to charge at the regular input rate. Anthropic reports
 * Input separately from cache reads and writes, while OpenAI-compatible and
 * Google APIs include cache reads in Input. TotalTokens lets us distinguish
 * those wire formats without leaking provider types into shared accounting.
 */
export function uncachedInputTokens(u: Usage): number {
  let input = u.input;
  // Google can report reasoning tokens separately while including them in
  // total_token_count, whereas OpenAI includes reasoning in output tokens.
  // Account for either representation when comparing aggregate input.
  let totalInput = u.totalTokens - u.output;
  if (totalInput !== u.input && (u.reasoning ?? 0) > 0) {
    totalInput -= u.reasoning ?? 0;
  }
  if (totalInput > 0 && totalInput === u.input) {
    input -= u.cacheRead + u.cacheWrite;
  }
  if (input < 0) return 0;
  return input;
}

/** Computes the cost based on the model's pricing. */
export function calculateCost(u: Usage, model: Model | null | undefined): void {
  if (model == null) return;
  const c: Cost = {
    input: (uncachedInputTokens(u) / 1_000_000) * model.cost.input,
    output: (u.output / 1_000_000) * model.cost.output,
    cacheRead: (u.cacheRead / 1_000_000) * model.cost.cacheRead,
    cacheWrite: (u.cacheWrite / 1_000_000) * model.cost.cacheWrite,
    total: 0,
  };
  c.total = c.input + c.output + c.cacheRead + c.cacheWrite;
  u.cost = c;
}

/** ModelPricing represents the cost per million tokens for a model. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Model represents a model available from a provider. */
export interface Model {
  id: string;
  name: string;
  provider: string;
  /** supports extended thinking */
  reasoning: boolean;
  /** "text", "image" */
  input: string[];
  cost: ModelPricing;
  /** max context tokens */
  contextWindow: number;
  /** max output tokens */
  maxTokens: number;
  /** true when maxTokens came from user/runtime config (never serialized) */
  maxTokensSet?: boolean;
  /** nil = use API default */
  temperature?: number;
  /** nil = use API default */
  topP?: number;
  compat?: ModelCompat;
}

/** ModelCompat captures vendor-specific behavior flags for otherwise compatible APIs. */
export interface ModelCompat {
  thinkingFormat?: string;
  requiresReasoningContentOnAssistant?: boolean;
  forceAdaptiveThinking?: boolean;
  /**
   * extracts <think>...</think> wrapped reasoning from the content stream for
   * models that inline thinking in the body
   */
  parseReasoningInContent?: boolean;

  supportsDeveloperRole?: boolean;
  supportsStore?: boolean;
  supportsResponses?: boolean;
  supportsPreviousResponseId?: boolean;
  supportsConversation?: boolean;
  supportsBackground?: boolean;
  supportsStructuredOutput?: boolean;
  supportsServiceTier?: boolean;
  supportsParallelToolCalls?: boolean;
  supportsToolChoice?: boolean;
  supportsHostedTools?: Record<string, boolean>;
  supportedInclude?: string[];
  supportsReasoningEffort?: boolean;
  supportsStrictMode?: boolean;
  maxTokensField?: string;
  /**
   * omits temperature/top_p from requests. Defaults to true (undefined):
   * sampling parameters are only sent when explicitly set to false.
   */
  disableSamplingParams?: boolean;

  supportsCacheControlOnTools?: boolean;
  supportsLongCacheRetention?: boolean;
  supportsPromptCacheKey?: boolean;
  supportsReasoningSummary?: boolean;
  sendSessionAffinityHeaders?: boolean;

  supportsEagerToolInputStreaming?: boolean;
}

/**
 * Reports whether sampling parameters (temperature/top_p) should be omitted
 * from requests for the model. It defaults to true: params are only sent when
 * the model's compat explicitly sets DisableSamplingParams to false.
 */
export function samplingParamsDisabled(m: Model | null | undefined): boolean {
  if (m == null || m.compat == null || m.compat.disableSamplingParams == null) {
    return true;
  }
  return m.compat.disableSamplingParams;
}

/** ThinkingLevel represents the depth of reasoning. */
export type ThinkingLevel = string;

export const thinkingOff: ThinkingLevel = "off";
export const thinkingMinimal: ThinkingLevel = "minimal";
export const thinkingLow: ThinkingLevel = "low";
export const thinkingMedium: ThinkingLevel = "medium";
export const thinkingHigh: ThinkingLevel = "high";
export const thinkingXHigh: ThinkingLevel = "xhigh";
export const thinkingMax: ThinkingLevel = "max";

/**
 * Ensures a valid thinking level is returned.
 * Empty or invalid values fall back to ThinkingMedium for reasoning models.
 */
export function normalizeThinkingLevel(level: ThinkingLevel): ThinkingLevel {
  switch (level) {
    case thinkingOff:
    case thinkingMinimal:
    case thinkingLow:
    case thinkingMedium:
    case thinkingHigh:
    case thinkingXHigh:
    case thinkingMax:
      return level;
    case "":
      // Empty string falls back to medium (reasonable default for reasoning models)
      return thinkingMedium;
    default:
      // Invalid value falls back to medium
      return thinkingMedium;
  }
}

/** ToolDefinition describes a tool available to the model. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema */
  parameters?: unknown;
  /** function (default), custom, or hosted */
  kind?: string;
  /** custom tool text/grammar format */
  format?: unknown;
  provider?: string;
  providerType?: string;
  model?: string;
}

/**
 * Attachment carries protocol-neutral generated files, citations, artifacts,
 * and hosted tool outputs alongside a stream event.
 */
export interface Attachment {
  /** citation, file, image, artifact, tool_result */
  kind: string;
  name?: string;
  url?: string;
  mediaType?: string;
  metadata?: Record<string, unknown>;
  providerRef?: string;
}

/** StreamEventType identifies the type of a streaming event. */
export type StreamEventType = number;

export const streamStart: StreamEventType = 0; // Stream started
export const streamTextDelta: StreamEventType = 1; // Text content delta
export const streamThinkDelta: StreamEventType = 2; // Thinking content delta
export const streamThinkSignature: StreamEventType = 3; // Thinking block signature
export const streamToolCall: StreamEventType = 4; // Tool call event
export const streamUsage: StreamEventType = 5; // Usage statistics
export const streamDone: StreamEventType = 6; // Stream completed
export const streamError: StreamEventType = 7; // Error occurred
export const streamHostedItem: StreamEventType = 8; // Hosted Responses item lifecycle
export const streamRetry: StreamEventType = 9; // Retry attempt in progress

/** StreamEvent represents a single event from a streaming response. */
export interface StreamEvent {
  type: StreamEventType;
  /** for StreamTextDelta */
  textDelta?: string;
  /** for StreamThinkDelta */
  thinkDelta?: string;
  /** for StreamThinkSignature */
  thinkSignature?: string;
  /** for StreamToolCall */
  toolCall?: ToolCallBlock;
  /** for StreamHostedItem */
  hostedItem?: HostedItem;
  /** for StreamUsage */
  usage?: Usage;
  /** for StreamError */
  error?: Error;
  /** for StreamDone: "stop", "length", "toolUse", "error", "aborted" */
  stopReason?: string;
  /** for StreamRetry: current retry attempt number */
  retryAttempt?: number;
  /** Deprecated: use RetryMaxAttempts. */
  retryMax?: number;
  /** for StreamRetry: maximum retry attempts */
  retryMaxAttempts?: number;
  /** for StreamRetry: delay before the next attempt, in milliseconds */
  retryAfterMs?: number;
  /**
   * for StreamRetry: sanitized single-line provider diagnostic for optional UI
   * display; never affects retry behavior
   */
  retryDetail?: string;
  /** provider-native event type, sanitized */
  providerEventType?: string;
  /** protocol item id, when provider-neutral */
  itemId?: string;
  /** protocol tool/function call id, when provider-neutral */
  callId?: string;
  /** sanitized, size-limited provider-neutral metadata */
  metadata?: Record<string, unknown>;
  /** sanitized generated files, citations, artifacts, tool results */
  attachments?: Attachment[];
}

/**
 * HostedItem is a provider-neutral lifecycle projection for native hosted
 * tools.
 */
export interface HostedItem {
  id?: string;
  type?: string;
  status?: string;
  outputIndex?: number;
  metadata?: Record<string, unknown>;
}

/** StructuredOutputOptions describes cross-provider structured text output. */
export interface StructuredOutputOptions {
  name?: string;
  description?: string;
  strict?: boolean;
  schema?: unknown;
  /** text, json_object, json_schema */
  format?: string;
}

/** ToolChoice describes cross-provider tool choice controls. */
export interface ToolChoice {
  /** auto, none, required, function */
  type?: string;
  /** function/custom tool name for explicit choices */
  name?: string;
}

/**
 * ResponseOptions carries protocol features that have provider-neutral
 * semantics. Provider-specific runtime state remains in provider config.
 */
export interface ResponseOptions {
  structuredOutput?: StructuredOutputOptions;
  toolChoice?: ToolChoice;
  parallelTools?: boolean;
  maxToolCalls?: number;
  /** used by providers that support remote response lineage */
  previousResponseId?: string;
  /**
   * a complete, ordered Responses input history. When set, providers that
   * support native item replay use it instead of rebuilding the same history
   * from role messages (runtime-only, never serialized).
   */
  replayItems?: unknown[];
  /**
   * requests a local replay without the configured remote conversation, used
   * only after a provider reports that the remote conversation is unavailable
   * (runtime-only, never serialized).
   */
  suppressConversation?: boolean;
  /**
   * receives a provider-neutral, sanitized representation of a completed
   * Responses turn (runtime-only, never serialized).
   */
  responseArchive?: (archive: ResponseArchive) => void;
}

/**
 * ResponseArchive is a protocol-neutral durable representation of a Responses
 * turn.
 */
export interface ResponseArchive {
  responseId: string;
  status: string;
  previousResponseId: string;
  conversationId: string;
  incompleteReason: string;
  stateMode: string;
  usage?: Usage;
  items: ResponseArchiveItem[];
  attachments: Attachment[];
  unknownEventTypes: string[];
}

export interface ResponseArchiveItem {
  id: string;
  type: string;
  status: string;
  outputIndex: number;
  canonical?: unknown;
}

/**
 * ResponseStateModeProvider exposes the selected remote state behavior to the
 * agent loop without leaking a provider's configuration implementation.
 */
export interface ResponseStateModeProvider {
  responseStateMode(): string;
}

/**
 * ResponseStateFallbackProvider identifies remote lineage errors for which the
 * agent may safely retry the current turn from its local replay archive.
 */
export interface ResponseStateFallbackProvider {
  responseStateFallbackError(err: unknown): boolean;
}

/** Describes a failed remote lineage request. */
export type ResponseStateFailureClass = string;

export const responseStateFailureExpired: ResponseStateFailureClass = "expired";
export const responseStateFailurePermission: ResponseStateFailureClass =
  "permission";
export const responseStateFailureRequestFailed: ResponseStateFailureClass =
  "request_failed";

/**
 * Reports a stable classification suitable for recovery/audit decisions.
 */
export interface ResponseStateFailureClassifier {
  responseStateFailureClass(err: unknown): ResponseStateFailureClass;
}

/** ChatParams contains all parameters for a chat request. */
export interface ChatParams {
  messages: Message[];
  tools?: ToolDefinition[];
  systemPrompt: string;
  thinkingLevel: ThinkingLevel;
  maxTokens: number;
  /** nil = use API default */
  temperature?: number;
  /** nil = use API default */
  topP?: number;
  /** which model to use */
  modelId: string;
  /** aborted to abort the request */
  abort?: AbortSignal;
  responseOptions?: ResponseOptions;
}
