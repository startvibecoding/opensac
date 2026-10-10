//
// Wire structs keep the Go JSON tag keys (snake_case) as TypeScript property
// names, mirroring the existing convention that a TS field name equals its
// `json:"..."` tag. Domain types (Model, ChatParams, StreamEvent, ...) remain
// camelCase as ported in ../types.ts.
//
// Deviation: `Chat(ctx, params) <-chan StreamEvent` maps to
// `chat(params): AsyncIterable<StreamEvent>`; the abort channel maps to
// `params.abort` (an AbortSignal) and is threaded into `fetch`.
import { runtime as nodeRuntime } from "../../platform/runtime.ts";
import { wrapError } from "../errors.ts";
import { BaseProvider } from "../base.ts";
import { debugCompleteResponse, debugJSON } from "../debug.ts";
import { hostedToolType } from "../hosted_tools.ts";
import {
  applyHeaders,
  createStreamHttpClient,
  type HttpClient,
  type HTTPClientOptions,
} from "../http_client.ts";
import {
  createIdleTimeoutStream,
  streamIdleTimeoutMs,
} from "../idle_timeout.ts";
import { type Provider as ProviderInterface } from "../provider.ts";
import {
  asJsonRecord,
  optNumber,
  optRecord,
  optString,
  parseJsonRecord,
} from "../../util/json.ts";
import {
  formatRetryMessage,
  isRetryable,
  type RetryConfig,
  retryDelay,
  retryErrorDetail,
} from "../retry.ts";
import {
  type ChatParams,
  type ContentBlock,
  type Message,
  type Model,
  type ModelPricing,
  type ResponseOptions,
  samplingParamsDisabled,
  streamDone,
  streamError,
  type StreamEvent,
  streamRetry,
  streamStart,
  streamTextDelta,
  streamThinkDelta,
  streamThinkSignature,
  streamToolCall,
  streamUsage,
  thinkingHigh,
  type ThinkingLevel,
  thinkingLow,
  thinkingMax,
  thinkingMedium,
  thinkingMinimal,
  thinkingOff,
  thinkingXHigh,
  type ToolCallBlock,
  type ToolDefinition,
  type Usage,
} from "../types.ts";
import { providerUserAgent } from "../../ua/ua.ts";

// ─── wire types (JSON tag keys) ──────────────────────────────────────────────

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream: boolean;
  thinking?: AnthropicThinking;
  output_config?: AnthropicOutputConfig;
}

// anthropicToolChoice keeps parallel tool use enabled explicitly. Anthropic
// defaults to allowing parallel tool calls, but sending the option prevents a
// compatible gateway from silently changing that default.
interface AnthropicToolChoice {
  type: string;
  disable_parallel_tool_use?: boolean;
}

interface AnthropicThinking {
  type: string;
  budget_tokens?: number;
  display?: string;
}

interface AnthropicOutputConfig {
  effort: string;
}

interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

interface AnthropicCacheControl {
  type: string;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  source?: AnthropicImage;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  cache_control?: AnthropicCacheControl;
}

interface AnthropicImage {
  type: string;
  media_type: string;
  data: string;
}

interface AnthropicTool {
  type?: string;
  name?: string;
  description?: string;
  input_schema?: unknown;
}

interface AnthropicResponse {
  type: string;
  index?: number;
  delta?: AnthropicDelta;
  content_block?: AnthropicContentBlock;
  message?: AnthropicMsg;
  usage?: AnthropicUsage;
  error?: AnthropicStreamError;
}

interface AnthropicStreamError {
  type: string;
  message: string;
}

interface AnthropicDelta {
  type?: string;
  text?: string;
  thinking?: string;
  signature?: string;
  stop_reason?: string;
  partial_json?: string;
}

interface AnthropicMsg {
  id: string;
  content?: unknown;
  stop_reason?: string;
  usage?: AnthropicUsage;
}

// Usage payloads are partial on the wire (proxies and `message_delta` carry
// only the fields they update), so the fields stay optional and read as
// `undefined` when absent — exactly the legacy cast behavior.
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// ─── SSE decode guard ──────────────────────────────────────────────────────────
// The legacy unchecked JSON.parse cast asserted nothing: shape garbage
// (missing or mistyped fields) crossed the boundary as typed lies and surfaced
// as runtime errors mid-stream. These decoders read every field the stream
// loop consumes through the src/util/json.ts readers, with Go `json.Unmarshal`
// semantics: required fields zero-fill, optional fields read as `undefined`,
// malformed entries drop, and unknown event types keep passing through the
// switch default untouched (forward compatible with new Anthropic events).

/** Decodes one `data:` payload of the Anthropic Messages event stream. */
export function decodeAnthropicStreamEvent(
  data: string,
): AnthropicResponse | undefined {
  const rec = parseJsonRecord(data);
  if (rec === undefined) return undefined;
  const type = optString(rec, "type");
  // Without a string discriminant the switch cannot dispatch, so skip the
  // payload exactly like an unhandled event type.
  if (type === undefined) return undefined;
  const event: AnthropicResponse = { type };
  const index = optNumber(rec, "index");
  if (index !== undefined) event.index = index;
  const delta = optRecord(rec, "delta");
  if (delta !== undefined) event.delta = decodeAnthropicDelta(delta);
  const contentBlock = optRecord(rec, "content_block");
  if (contentBlock !== undefined) {
    event.content_block = decodeAnthropicContentBlock(contentBlock);
  }
  const message = optRecord(rec, "message");
  if (message !== undefined) event.message = decodeAnthropicMsg(message);
  const usage = decodeAnthropicUsage(rec["usage"]);
  if (usage !== undefined) event.usage = usage;
  const error = optRecord(rec, "error");
  if (error !== undefined) event.error = decodeAnthropicStreamError(error);
  return event;
}

function decodeAnthropicDelta(rec: Record<string, unknown>): AnthropicDelta {
  const delta: AnthropicDelta = {};
  const type = optString(rec, "type");
  if (type !== undefined) delta.type = type;
  const text = optString(rec, "text");
  if (text !== undefined) delta.text = text;
  const thinking = optString(rec, "thinking");
  if (thinking !== undefined) delta.thinking = thinking;
  const signature = optString(rec, "signature");
  if (signature !== undefined) delta.signature = signature;
  const stopReason = optString(rec, "stop_reason");
  if (stopReason !== undefined) delta.stop_reason = stopReason;
  const partialJson = optString(rec, "partial_json");
  if (partialJson !== undefined) delta.partial_json = partialJson;
  return delta;
}

function decodeAnthropicContentBlock(
  rec: Record<string, unknown>,
): AnthropicContentBlock {
  const block: AnthropicContentBlock = { type: optString(rec, "type") ?? "" };
  const id = optString(rec, "id");
  if (id !== undefined) block.id = id;
  const name = optString(rec, "name");
  if (name !== undefined) block.name = name;
  const input = asJsonRecord(rec["input"]);
  if (input !== undefined) block.input = input;
  return block;
}

function decodeAnthropicMsg(rec: Record<string, unknown>): AnthropicMsg {
  const msg: AnthropicMsg = { id: optString(rec, "id") ?? "" };
  if ("content" in rec) msg.content = rec["content"];
  const stopReason = optString(rec, "stop_reason");
  if (stopReason !== undefined) msg.stop_reason = stopReason;
  const usage = decodeAnthropicUsage(rec["usage"]);
  if (usage !== undefined) msg.usage = usage;
  return msg;
}

function decodeAnthropicUsage(value: unknown): AnthropicUsage | undefined {
  const rec = asJsonRecord(value);
  if (rec === undefined) return undefined;
  const usage: AnthropicUsage = {};
  const inputTokens = optNumber(rec, "input_tokens");
  if (inputTokens !== undefined) usage.input_tokens = inputTokens;
  const outputTokens = optNumber(rec, "output_tokens");
  if (outputTokens !== undefined) usage.output_tokens = outputTokens;
  const cacheCreation = optNumber(rec, "cache_creation_input_tokens");
  if (cacheCreation !== undefined) {
    usage.cache_creation_input_tokens = cacheCreation;
  }
  const cacheRead = optNumber(rec, "cache_read_input_tokens");
  if (cacheRead !== undefined) usage.cache_read_input_tokens = cacheRead;
  return usage;
}

function decodeAnthropicStreamError(
  rec: Record<string, unknown>,
): AnthropicStreamError {
  return {
    type: optString(rec, "type") ?? "",
    message: optString(rec, "message") ?? "",
  };
}

// ─── provider ────────────────────────────────────────────────────────────────

/** Provider implements the Anthropic Messages API. */
export class Provider extends BaseProvider implements ProviderInterface {
  apiKey: string;
  private baseURL: string;
  /** Exposed for tests, mirroring Go's replaceable `p.client`. */
  client: HttpClient;
  private headers: Record<string, string> | undefined;

  /** "", "anthropic", "deepseek", "xiaomi" */
  private thinkingFormat = "";
  /** undefined = off (must be explicitly enabled), true = on, false = off */
  private cacheControlEnabled: boolean | undefined = undefined;

  private retryConfig: RetryConfig | undefined;

  constructor(
    apiKey: string,
    baseURL: string,
    models: Model[],
    client: HttpClient,
  ) {
    super("anthropic", models);
    if (baseURL === "") baseURL = "https://api.anthropic.com";
    if (apiKey === "") apiKey = nodeRuntime.env.get("ANTHROPIC_API_KEY") ?? "";
    this.apiKey = apiKey;
    this.baseURL = baseURL.replace(/\/+$/, "");
    this.client = client;
  }

  /** Returns the protocol/API type. */
  api(): string {
    return "anthropic-messages";
  }

  /**
   * Sets the thinking parameter format.
   * "anthropic" = thinking with budget_tokens, "deepseek" = thinking with
   * output_config, "xiaomi" = legacy thinking-only format.
   */
  setThinkingFormat(format: string): void {
    this.thinkingFormat = format;
  }

  /** Sets the retry configuration for this provider. */
  setRetryConfig(cfg: RetryConfig | undefined): void {
    this.retryConfig = cfg;
  }

  /** Sets custom HTTP headers applied to every provider request. */
  setHeaders(headers: Record<string, string> | undefined): void {
    this.headers = cloneHeaders(headers);
  }

  /**
   * Sets whether to use cache_control markers.
   * undefined = off (default), true = on, false = off.
   */
  setCacheControlEnabled(enabled: boolean | undefined): void {
    this.cacheControlEnabled = enabled;
  }

  /**
   * Returns whether cache_control markers should be used. Must be explicitly
   * enabled via setCacheControlEnabled or provider config "cacheControl": true.
   * Defaults to false when not configured.
   */
  isCacheControlEnabled(): boolean {
    if (this.cacheControlEnabled !== undefined) {
      return this.cacheControlEnabled;
    }
    return false;
  }

  /** Sends a chat request and returns a stream of events. */
  async *chat(params: ChatParams): AsyncGenerator<StreamEvent> {
    if (this.apiKey === "") {
      yield {
        type: streamError,
        error: new Error("ANTHROPIC_API_KEY not set"),
      };
      return;
    }

    let modelID = params.modelId;
    if (modelID === "") {
      const models = this.models();
      modelID = models.length > 0 ? models[0].id : "claude-sonnet-4-20250514";
    }
    const model = this.getModel(modelID);

    let maxTokens = params.maxTokens;
    if (maxTokens <= 0) {
      // The Anthropic Messages API requires max_tokens and rejects values above
      // the model's output limit, so an explicit zero ("no output limit") cannot
      // be honored by omission or by the context window size; fall back to the
      // default.
      maxTokens = 16384;
    }

    const reqBody: AnthropicRequest = {
      model: modelID,
      messages: this.convertMessages(params),
      tools: this.convertTools(params.tools ?? []),
      temperature: params.temperature,
      top_p: params.topP,
      stream: true,
      max_tokens: maxTokens,
    };
    const toolChoice = anthropicToolChoiceFor(
      model,
      reqBody.tools ?? [],
      params.responseOptions,
    );
    if (toolChoice !== undefined) reqBody.tool_choice = toolChoice;

    if (params.systemPrompt !== "") {
      if (this.isCacheControlEnabled()) {
        // Send system prompt as content block array with cache_control for
        // prompt caching.
        reqBody.system = [
          {
            type: "text",
            text: params.systemPrompt,
            cache_control: { type: "ephemeral" },
          },
        ];
      } else {
        // Send system prompt as simple string (for proxies that don't support
        // array format).
        reqBody.system = params.systemPrompt;
      }
    }

    if (
      params.thinkingLevel !== thinkingOff &&
      model !== undefined &&
      model.reasoning
    ) {
      // Determine thinking format: explicit config > URL auto-detect > default.
      const format = this.thinkingFormatForModel(model);
      switch (format) {
        case "deepseek":
          reqBody.thinking = { type: "enabled" };
          reqBody.output_config = {
            effort: deepseekReasoningEffort(params.thinkingLevel),
          };
          break;
        case "xiaomi":
          reqBody.thinking = { type: "enabled" };
          break;
        case "adaptive":
          reqBody.thinking = { type: "adaptive", display: "summarized" };
          reqBody.output_config = {
            effort: anthropicAdaptiveEffort(params.thinkingLevel),
          };
          break;
        default: // "anthropic" or ""
          if (useAdaptiveThinking(model, modelID)) {
            reqBody.thinking = { type: "adaptive", display: "summarized" };
            reqBody.output_config = {
              effort: anthropicAdaptiveEffort(params.thinkingLevel),
            };
          } else {
            reqBody.thinking = {
              type: "enabled",
              budget_tokens: thinkingBudget(params.thinkingLevel),
            };
          }
      }
    }

    // The Anthropic API rejects temperature/top_p when thinking is enabled, and
    // some models reject sampling parameters entirely (compat flag).
    if (reqBody.thinking !== undefined || samplingParamsDisabled(model)) {
      delete reqBody.temperature;
      delete reqBody.top_p;
    }

    // Build the request body once (reused across retries).
    const body = JSON.stringify(reqBody);

    debugJSON("Anthropic request JSON", body);

    // Retry loop: retries only the initial HTTP connection, not the SSE stream.
    let maxRetries = 0;
    let baseDelayMs = 2000;
    if (this.retryConfig !== undefined && this.retryConfig.enabled) {
      maxRetries = this.retryConfig.maxRetries;
      baseDelayMs = this.retryConfig.baseDelayMs;
    }

    // Builds the StreamRetry event and its backoff delay for an attempt.
    const retryPlan = (
      attempt: number,
      err: unknown,
    ): { event: StreamEvent; delay: number } => {
      const delay = retryDelay(attempt, baseDelayMs);
      const event: StreamEvent = {
        type: streamRetry,
        retryAttempt: attempt + 1,
        retryMax: maxRetries,
        retryMaxAttempts: maxRetries,
        retryAfterMs: delay,
        error: new Error(formatRetryMessage(attempt, maxRetries, delay, err)),
        retryDetail: retryErrorDetail(err),
      };
      return { event, delay };
    };

    const waitOrAbort = async (delay: number): Promise<boolean> => {
      const signal = params.abort;
      if (signal?.aborted) return false;
      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          cleanup();
          resolve(true);
        }, delay);
        const onAbort = () => {
          cleanup();
          resolve(false);
        };
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (params.abort?.aborted) {
        yield {
          type: streamError,
          error: new Error("aborted"),
          stopReason: "aborted",
        };
        return;
      }

      const headers = new Headers();
      headers.set("Content-Type", "application/json");
      headers.set("x-api-key", this.apiKey);
      headers.set("anthropic-version", "2023-06-01");
      headers.set("Accept", "text/event-stream");
      headers.set("User-Agent", providerUserAgent());
      applyHeaders(headers, this.headers);

      let resp: Response;
      try {
        resp = await this.client.fetch(`${this.baseURL}/v1/messages`, {
          method: "POST",
          body,
          headers,
          signal: params.abort,
        });
      } catch (err) {
        if (attempt < maxRetries && isRetryable(err, 0)) {
          const plan = retryPlan(attempt, err);
          yield plan.event;
          if (!(await waitOrAbort(plan.delay))) {
            yield {
              type: streamError,
              error: new Error("aborted"),
              stopReason: "aborted",
            };
            return;
          }
          continue;
        }
        yield { type: streamError, error: wrapError("send", err) };
        return;
      }

      if (resp.status !== 200) {
        const b = await resp.text();
        debugJSON("Anthropic response JSON", b);
        const err = new Error(`HTTP ${resp.status}: ${b}`);
        if (attempt < maxRetries && isRetryable(err, resp.status)) {
          const plan = retryPlan(attempt, err);
          yield plan.event;
          if (!(await waitOrAbort(plan.delay))) {
            yield {
              type: streamError,
              error: new Error("aborted"),
              stopReason: "aborted",
            };
            return;
          }
          continue;
        }
        yield {
          type: streamError,
          error: new Error(`API error ${resp.status}: ${b}`),
        };
        return;
      }

      const streamBody = createIdleTimeoutStream(
        resp.body,
        streamIdleTimeoutMs,
      );
      const state = { visibleOutput: false };
      let streamErr: unknown = undefined;
      try {
        for await (const event of this.parseSSE(streamBody, params, state)) {
          yield event;
        }
      } catch (err) {
        streamErr = err;
      }
      if (streamErr === undefined) {
        return;
      }
      if (
        attempt < maxRetries &&
        !state.visibleOutput &&
        isRetryable(streamErr, 0)
      ) {
        const plan = retryPlan(attempt, streamErr);
        yield plan.event;
        if (!(await waitOrAbort(plan.delay))) {
          yield {
            type: streamError,
            error: new Error("aborted"),
            stopReason: "aborted",
          };
          return;
        }
        continue;
      }
      yield {
        type: streamError,
        error: wrapError("stream read error", streamErr),
        stopReason: "error",
      };
      return;
    }

    yield {
      type: streamError,
      error: new Error(`all ${maxRetries} retry attempts exhausted`),
    };
  }

  private async *parseSSE(
    body: ReadableStream<Uint8Array> | null,
    params: ChatParams,
    state: { visibleOutput: boolean },
  ): AsyncGenerator<StreamEvent> {
    let textContent = "";
    let reasonContent = "";
    let thinkSignature = "";
    const toolCalls: ToolCallBlock[] = [];
    const toolCallBuffers = new Map<number, string>();
    const toolCallInitial = new Map<number, string>();
    let stopReason = "";
    const acc: { usage: Usage | undefined } = { usage: undefined };
    let currentBlockType = "";
    let toolCallIndex = -1;

    yield { type: streamStart };

    const reader = body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const handleLine = (line: string): boolean => {
      if (!line.startsWith("data: ")) return true;
      const data = line.slice("data: ".length);
      const event = decodeAnthropicStreamEvent(data);
      if (event === undefined) return true;

      switch (event.type) {
        case "message_start":
          if (event.message?.usage !== undefined) {
            const u = event.message.usage;
            acc.usage = {
              input: u.input_tokens ?? 0,
              output: u.output_tokens ?? 0,
              cacheRead: u.cache_read_input_tokens ?? 0,
              cacheWrite: u.cache_creation_input_tokens ?? 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            };
          }
          break;
        case "content_block_start":
          if (event.content_block !== undefined) {
            currentBlockType = event.content_block.type;
            if (event.content_block.type === "tool_use") {
              state.visibleOutput = true;
              toolCallIndex = toolCalls.length;
              toolCalls.push({
                id: event.content_block.id ?? "",
                name: event.content_block.name ?? "",
              });
              toolCallBuffers.set(toolCallIndex, "");
              const input = event.content_block.input;
              if (input !== undefined && input !== null) {
                toolCallInitial.set(toolCallIndex, JSON.stringify(input));
              }
            }
          }
          break;
        case "content_block_delta":
          if (event.delta === undefined) break;
          switch (event.delta.type) {
            case "text_delta": {
              state.visibleOutput = true;
              const delta = event.delta.text ?? "";
              textContent += delta;
              pending.push({ type: streamTextDelta, textDelta: delta });
              break;
            }
            case "thinking_delta": {
              state.visibleOutput = true;
              const delta = event.delta.thinking ?? "";
              reasonContent += delta;
              pending.push({ type: streamThinkDelta, thinkDelta: delta });
              break;
            }
            case "signature_delta":
              state.visibleOutput = true;
              thinkSignature += event.delta.signature ?? "";
              break;
            case "input_json_delta":
              if (toolCallIndex >= 0) {
                state.visibleOutput = true;
                toolCallBuffers.set(
                  toolCallIndex,
                  (toolCallBuffers.get(toolCallIndex) ?? "") +
                    (event.delta.partial_json ?? ""),
                );
              }
              break;
          }
          break;
        case "content_block_stop":
          if (currentBlockType === "thinking" && thinkSignature !== "") {
            state.visibleOutput = true;
            pending.push({
              type: streamThinkSignature,
              thinkSignature,
            });
            thinkSignature = "";
          }
          if (
            currentBlockType === "tool_use" &&
            toolCallIndex >= 0 &&
            toolCallIndex < toolCalls.length
          ) {
            const raw = mergeToolCallInput(
              toolCallInitial.get(toolCallIndex) ?? "",
              toolCallBuffers.get(toolCallIndex) ?? "",
            );
            const decoded = decodeToolArguments(raw);
            const call = toolCalls[toolCallIndex];
            call.arguments = decoded.arguments;
            if (decoded.invalidArguments !== undefined) {
              call.invalidArguments = decoded.invalidArguments;
            }
            state.visibleOutput = true;
            pending.push({ type: streamToolCall, toolCall: call });
          }
          toolCallIndex = -1;
          break;
        case "message_delta":
          if (
            event.delta !== undefined &&
            event.delta.stop_reason !== undefined &&
            event.delta.stop_reason !== ""
          ) {
            stopReason = event.delta.stop_reason;
          }
          if (event.usage !== undefined) {
            if (acc.usage === undefined) {
              acc.usage = {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              };
            }
            // Some proxies send all usage data in message_delta instead of
            // message_start. Only update values if they haven't been set yet (to
            // avoid overwriting with partial values).
            const u = event.usage;
            if ((u.output_tokens ?? 0) > 0 && acc.usage.output === 0) {
              acc.usage.output = u.output_tokens ?? 0;
            }
            if ((u.input_tokens ?? 0) > 0 && acc.usage.input === 0) {
              acc.usage.input = u.input_tokens ?? 0;
            }
            if (
              (u.cache_read_input_tokens ?? 0) > 0 &&
              acc.usage.cacheRead === 0
            ) {
              acc.usage.cacheRead = u.cache_read_input_tokens ?? 0;
            }
            if (
              (u.cache_creation_input_tokens ?? 0) > 0 &&
              acc.usage.cacheWrite === 0
            ) {
              acc.usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
            }
          }
          break;
        case "error": {
          let errMsg = "stream error";
          if (event.error !== undefined) {
            errMsg = event.error.message;
            if (event.error.type !== "") {
              errMsg = `${event.error.type}: ${errMsg}`;
            }
          }
          pending.push({
            type: streamError,
            error: new Error(errMsg),
            stopReason: "error",
          });
          return false;
        }
      }
      return true;
    };

    // `pending` lets handleLine queue events without being a generator itself.
    const pending: StreamEvent[] = [];

    try {
      if (reader !== undefined) {
        while (true) {
          if (params.abort?.aborted) {
            yield {
              type: streamError,
              error: new Error("aborted"),
              stopReason: "aborted",
            };
            return;
          }
          let result: ReadableStreamReadResult<Uint8Array>;
          try {
            result = await reader.read();
          } catch (err) {
            if (params.abort?.aborted) {
              yield {
                type: streamError,
                error: new Error("aborted"),
                stopReason: "aborted",
              };
              return;
            }
            throw err;
          }
          if (result.done) break;
          buffer += decoder.decode(result.value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            const cont = handleLine(line.replace(/\r$/, ""));
            while (pending.length > 0) yield pending.shift()!;
            if (!cont) return;
          }
        }
        buffer += decoder.decode();
        if (buffer.length > 0) {
          handleLine(buffer.replace(/\r$/, ""));
          while (pending.length > 0) yield pending.shift()!;
        }
      }

      if (acc.usage !== undefined) {
        const finalUsage = acc.usage;
        finalUsage.totalTokens =
          finalUsage.input +
          finalUsage.cacheRead +
          finalUsage.cacheWrite +
          finalUsage.output;
        state.visibleOutput = true;
        yield { type: streamUsage, usage: finalUsage };
      }
      yield { type: streamDone, stopReason };
    } finally {
      debugCompleteResponse({
        provider: "anthropic",
        api: "messages",
        content: textContent,
        reasoning: reasonContent,
        toolCalls,
        stopReason,
        usage: acc.usage,
      });
    }
  }

  convertMessages(params: ChatParams): AnthropicMessage[] {
    const cacheEnabled = this.isCacheControlEnabled();
    const messages: AnthropicMessage[] = [];
    for (let i = 0; i < params.messages.length; i++) {
      const msg = params.messages[i];
      const am: AnthropicMessage = { role: msg.role, content: "" };
      if (msg.role === "toolResult") {
        // Anthropic requires all tool_result blocks for the preceding assistant
        // tool_use blocks to be in the next user message, before any other
        // content. Group consecutive tool results to preserve that shape.
        const run = this.convertToolResultRun(params.messages, i, cacheEnabled);
        messages.push({ role: "user", content: run.blocks });
        i = run.next - 1;
        continue;
      } else if (msg.contents !== undefined && msg.contents.length > 0) {
        const blocks: AnthropicContentBlock[] = [];
        for (const c of msg.contents) {
          let block: AnthropicContentBlock | undefined;
          switch (c.type) {
            case "text":
              block = { type: "text", text: c.text ?? "" };
              break;
            case "image":
              if (c.image !== undefined) {
                block = {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: c.image.mimeType,
                    data: c.image.data,
                  },
                };
              }
              break;
            case "thinking":
              block = {
                type: "thinking",
                thinking: c.thinking ?? "",
                signature: c.signature ?? "",
              };
              break;
            case "toolCall":
              if (c.toolCall !== undefined) {
                let input: Record<string, unknown> = {};
                const args = c.toolCall.arguments;
                if (
                  args !== undefined &&
                  args !== null &&
                  typeof args === "object" &&
                  !Array.isArray(args)
                ) {
                  input = args as Record<string, unknown>;
                }
                block = {
                  type: "tool_use",
                  id: c.toolCall.id,
                  name: c.toolCall.name,
                  input,
                };
              }
              break;
          }
          if (block === undefined) {
            block = { type: c.type };
          }
          // Pass through cache_control from provider content blocks (only if
          // enabled).
          if (c.cache_control !== undefined && cacheEnabled) {
            block.cache_control = { type: c.cache_control.type };
          }
          blocks.push(block);
        }
        if (
          blocks.length === 1 &&
          blocks[0].type === "text" &&
          blocks[0].cache_control === undefined
        ) {
          am.content = blocks[0].text ?? "";
        } else {
          am.content = blocks;
        }
      } else {
        am.content = msg.content ?? "";
      }
      messages.push(am);
    }
    return messages;
  }

  private convertToolResultRun(
    messages: Message[],
    start: number,
    cacheEnabled: boolean,
  ): { blocks: AnthropicContentBlock[]; next: number } {
    const resultBlocks: AnthropicContentBlock[] = [];
    const imageBlocks: AnthropicContentBlock[] = [];
    let i = start;
    while (i < messages.length && messages[i].role === "toolResult") {
      const converted = this.convertToolResultMessage(
        messages[i],
        cacheEnabled,
      );
      resultBlocks.push(converted.block);
      imageBlocks.push(...converted.images);
      i++;
    }
    return { blocks: [...resultBlocks, ...imageBlocks], next: i };
  }

  private convertToolResultMessage(
    msg: Message,
    cacheEnabled: boolean,
  ): { block: AnthropicContentBlock; images: AnthropicContentBlock[] } {
    let textContent = msg.content ?? "";
    const imageBlocks: AnthropicContentBlock[] = [];
    let hasCacheControl = false;

    if (msg.contents !== undefined && msg.contents.length > 0) {
      const textParts: string[] = [];
      for (const c of msg.contents) {
        switch (c.type) {
          case "text":
            if ((c.text ?? "") !== "") textParts.push(c.text ?? "");
            if (c.cache_control !== undefined) hasCacheControl = true;
            break;
          case "image":
            if (c.image !== undefined) {
              imageBlocks.push({
                type: "image",
                source: {
                  type: "base64",
                  media_type: c.image.mimeType,
                  data: c.image.data,
                },
              });
            }
            break;
        }
      }
      if (textParts.length > 0) {
        textContent = textParts.join("\n");
      }
    }

    if (textContent.trim() === "") {
      textContent = "Tool completed with no output.";
    }

    const block: AnthropicContentBlock = {
      type: "tool_result",
      tool_use_id: msg.toolCallId ?? "",
      content: textContent,
    };
    if (msg.isError === true) block.is_error = true;
    if (hasCacheControl && cacheEnabled) {
      block.cache_control = { type: "ephemeral" };
    }
    return { block, images: imageBlocks };
  }

  private convertTools(tools: ToolDefinition[]): AnthropicTool[] {
    const result: AnthropicTool[] = [];
    for (const t of tools) {
      if (t.kind === "hosted") {
        const toolType = hostedToolType(t.providerType ?? "", t.name);
        if (toolType === "") continue;
        result.push({ type: toolType });
        continue;
      }
      const tool: AnthropicTool = {
        name: t.name,
        description: t.description,
      };
      if (t.parameters !== undefined) tool.input_schema = t.parameters;
      result.push(tool);
    }
    return result;
  }

  private thinkingFormatForModel(model: Model): string {
    if (this.thinkingFormat !== "") {
      return this.thinkingFormat;
    }
    if (
      model.compat?.thinkingFormat !== undefined &&
      model.compat.thinkingFormat !== ""
    ) {
      return model.compat.thinkingFormat;
    }
    const lowerBaseURL = this.baseURL.toLowerCase();
    if (lowerBaseURL.includes("deepseek")) {
      return "deepseek";
    }
    if (lowerBaseURL.includes("xiaomimimo")) {
      return "xiaomi";
    }
    return "";
  }
}

function cloneHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const keys = Object.keys(headers);
  if (keys.length === 0) return undefined;
  const cloned: Record<string, string> = {};
  for (const name of keys) cloned[name] = headers[name];
  return cloned;
}

function tryParseObject(raw: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Merges the tool-call input supplied in content_block_start with the input
 * fragment streamed afterwards, returning a JSON document.
 */
export function mergeToolCallInput(initial: string, streamed: string): string {
  let init = initial.trim();
  let str = streamed.trim();
  if (init === "null") init = "";
  if (str === "null") str = "";
  if (init === "") {
    if (str === "") return "{}";
    return str;
  }
  if (str === "") return init;

  // A few gateways include an initial object and then stream a second object.
  // Merge those objects instead of concatenating two invalid JSON documents.
  const initialObject = tryParseObject(init);
  const streamedObject = tryParseObject(str);
  if (initialObject !== undefined && streamedObject !== undefined) {
    for (const [key, value] of Object.entries(streamedObject)) {
      initialObject[key] = value;
    }
    const merged = JSON.stringify(initialObject);
    if (merged !== undefined) return merged;
  }
  // Keep the initial object when a gateway terminates the streamed fragment as
  // invalid JSON. Returning the fragment alone would discard valid input already
  // supplied in content_block_start and create an unusable call.
  const preserved = tryParseObject(init);
  if (preserved !== undefined) {
    const s = JSON.stringify(preserved);
    if (s !== undefined) return s;
  }
  return str;
}

/** Decodes merged tool-call arguments into the provider-neutral block shape. */
export function decodeToolArguments(raw: string): {
  arguments?: unknown;
  invalidArguments?: string;
} {
  if (raw === "") return { arguments: {} };
  try {
    return { arguments: JSON.parse(raw) };
  } catch {
    return { invalidArguments: raw };
  }
}

export function modelSupportsParallelToolCalls(model: Model): boolean {
  const v = model.compat?.supportsParallelToolCalls;
  return v === undefined ? true : v;
}

export function modelSupportsToolChoice(model: Model): boolean {
  const v = model.compat?.supportsToolChoice;
  return v === undefined ? true : v;
}

export function anthropicToolChoiceFor(
  model: Model | undefined,
  tools: AnthropicTool[],
  opts: ResponseOptions | undefined,
): AnthropicToolChoice | undefined {
  if (
    tools.length === 0 ||
    model === undefined ||
    !modelSupportsParallelToolCalls(model) ||
    !modelSupportsToolChoice(model)
  ) {
    // When compatibility metadata says explicit parallel controls or
    // tool-choice controls are unsupported, omit the entire tool_choice object.
    // Some Anthropic-compatible gateways reject tool_choice even when its
    // parallel flag is disabled.
    return undefined;
  }
  let disableParallel = false;
  if (opts?.parallelTools !== undefined) {
    disableParallel = !opts.parallelTools;
  }
  return { type: "auto", disable_parallel_tool_use: disableParallel };
}

function deepseekReasoningEffort(level: ThinkingLevel): string {
  switch (level) {
    case thinkingXHigh:
      return "max";
    default:
      return "high";
  }
}

function isAnthropicAdaptiveModel(modelID: string): boolean {
  return (
    modelID.startsWith("claude-opus-4-7") ||
    modelID.startsWith("claude-opus-4-6") ||
    modelID.startsWith("claude-sonnet-4-6")
  );
}

export function useAdaptiveThinking(model: Model, modelID: string): boolean {
  if (model.compat?.forceAdaptiveThinking === true) {
    return true;
  }
  return isAnthropicAdaptiveModel(modelID);
}

export function anthropicAdaptiveEffort(level: ThinkingLevel): string {
  switch (level) {
    case thinkingMinimal:
    case thinkingLow:
      return "low";
    case thinkingMedium:
      return "medium";
    case thinkingHigh:
      return "high";
    case thinkingXHigh:
      return "xhigh";
    case thinkingMax:
      return "max";
    default:
      return "high";
  }
}

export function thinkingBudget(level: ThinkingLevel): number {
  switch (level) {
    case thinkingMinimal:
      return 1024;
    case thinkingLow:
      return 4096;
    case thinkingMedium:
      return 10240;
    case thinkingHigh:
      return 32768;
    case thinkingXHigh:
    case thinkingMax:
      return 65536;
    default:
      return 10240;
  }
}

// ─── constructors ────────────────────────────────────────────────────────────

/** Returns the default Anthropic model list. */
export function defaultModels(): Model[] {
  return [
    {
      id: "claude-sonnet-4-20250514",
      name: "Claude 4 Sonnet",
      provider: "anthropic",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 200000,
      maxTokens: 16384,
    },
    {
      id: "claude-3-5-sonnet-20241022",
      name: "Claude 3.5 Sonnet",
      provider: "anthropic",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 200000,
      maxTokens: 8192,
    },
    {
      id: "claude-3-5-haiku-20241022",
      name: "Claude 3.5 Haiku",
      provider: "anthropic",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
      contextWindow: 200000,
      maxTokens: 8192,
    },
    {
      id: "claude-3-opus-20240229",
      name: "Claude 3 Opus",
      provider: "anthropic",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
      contextWindow: 200000,
      maxTokens: 4096,
    },
  ];
}

/** Creates a new Anthropic provider with default models. */
/**
 * Creates an Anthropic provider. Without explicit transport options a failed
 * client construction falls back to a bare streaming client (Go parity);
 * explicit options keep the wrapped failure.
 */
export function createAnthropicProvider(
  apiKey: string,
  baseURL: string,
  models: Model[] = defaultModels(),
  opts: HTTPClientOptions | undefined = undefined,
): Provider {
  try {
    let client: HttpClient;
    try {
      client = createStreamHttpClient(opts ?? {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`configure http proxy: ${msg}`);
    }
    return createAnthropicProviderWithHTTPClient(
      apiKey,
      baseURL,
      models,
      client,
    );
  } catch (err) {
    if (opts !== undefined) throw err;
    // Mirror the Go fallback: fall back to a bare client when the default
    // stream client cannot be constructed.
    return createAnthropicProviderWithHTTPClient(
      apiKey,
      baseURL,
      models,
      createStreamHttpClient({}),
    );
  }
}

/**
 * Creates a provider bound to the given HTTP client. Mirrors the unexported Go
 * helper and serves as the TS test seam.
 */
export function createAnthropicProviderWithHTTPClient(
  apiKey: string,
  baseURL: string,
  models: Model[],
  client: HttpClient,
): Provider {
  return new Provider(apiKey, baseURL, models, client);
}

// Keep ContentBlock referenced for the port's type surface.
export type { ContentBlock, ModelPricing };
