//
// `Chat(ctx, params) <-chan StreamEvent` maps to
// `chatResponses(p, params): AsyncIterable<StreamEvent>`. Raw JSON documents
// (Go `json.RawMessage`) are carried as strings for streaming buffers and as
// decoded values for replay items.

import type {
  ChatParams,
  ContentBlock,
  Message,
  Model,
  ResponseOptions,
  StructuredOutputOptions,
  ToolChoice,
  ToolDefinition,
  Usage,
} from "../types.ts";
import {
  asJsonRecord,
  optNumber,
  optRecord,
  optString,
} from "../../util/json.ts";
import {
  samplingParamsDisabled,
  streamDone,
  streamError,
  type StreamEvent,
  streamHostedItem,
  streamRetry,
  streamStart,
  streamTextDelta,
  streamThinkDelta,
  streamToolCall,
  streamUsage,
  thinkingHigh,
  type ThinkingLevel,
  thinkingMax,
  thinkingMinimal,
  thinkingOff,
  thinkingXHigh,
} from "../types.ts";
import { debugCompleteResponse, debugJSON } from "../debug.ts";
import { applyHeaders } from "../http_client.ts";
import {
  createIdleTimeoutStream,
  streamIdleTimeoutMs,
} from "../idle_timeout.ts";
import {
  formatRetryMessage,
  isRetryable,
  type RetryConfig,
  retryDelay,
  retryErrorDetail,
} from "../retry.ts";
import { nextToolCallFallbackId } from "../toolcall_id.ts";
import { providerUserAgent } from "../../ua/ua.ts";
import type { ResponsesHostedPolicy } from "./hosted_registry.ts";
import {
  cloneStringMap,
  cloneStringSlice,
  limitImageHistory,
  normalizeImageDetail,
} from "./wire.ts";
import { ResponsesNormalizer, responsesSSEFrames } from "./responses_codec.ts";
import {
  mergeResponsesTools,
  type ResponsesConfigHost,
  responsesHostedItemTypes,
  supportsPromptCacheKey,
  supportsPromptCacheRetention,
  supportsReasoningSummary,
  validateResponsesCapabilitiesForRequest,
} from "./responses_config.ts";

// ─── wire types (JSON tag names) ─────────────────────────────────────────────

export interface ResponsesRequest {
  model: string;
  instructions?: string;
  input: unknown[];
  tools?: ResponsesTool[];
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  store?: boolean;
  previous_response_id?: string;
  conversation?: string;
  truncation?: string;
  stream: boolean;
  background?: boolean;
  include?: string[];
  reasoning?: ResponsesReasoning;
  parallel_tool_calls?: boolean;
  max_tool_calls?: number;
  tool_choice?: unknown;
  text?: ResponsesText;
  prompt_cache_key?: string;
  prompt_cache_retention?: string;
  prompt_cache_options?: ResponsesPromptCacheOptions;
  service_tier?: string;
  metadata?: Record<string, string>;
  safety_identifier?: string;
}

export interface ResponsesReasoning {
  effort?: string;
  summary?: string;
  context?: string;
  mode?: string;
}

export interface ResponsesPromptCacheOptions {
  mode?: string;
  ttl?: string;
}

export interface ResponsesText {
  format?: ResponsesTextFormat;
}

export interface ResponsesTextFormat {
  type: string;
  name?: string;
  description?: string;
  strict?: boolean;
  schema?: unknown;
}

export interface ResponsesContentBlock {
  type: string;
  text?: string;
  image_url?: string;
  detail?: string;
  file_id?: string;
  file_url?: string;
  file_data?: string;
  filename?: string;
}

export interface ResponsesTool {
  type: string;
  name?: string;
  description?: string;
  parameters?: unknown;
  format?: unknown;
  extra?: Record<string, unknown>;
}

/** Internal resolved Responses configuration (mirrors the Go struct). */
export interface ResponsesWireConfig {
  reasoningSummary?: string;
  reasoningContext?: string;
  reasoningMode?: string;
  promptCacheEnabled: boolean;
  promptCacheKey?: string;
  promptCacheRetention?: string;
  promptCacheMode?: string;
  promptCacheTTL?: string;
  safetyIdentifier?: string;
  metadata?: Record<string, string>;
  stateMode?: string;
  store?: boolean;
  conversation?: string;
  truncation?: string;
  background: boolean;
  include?: string[];
  serviceTier?: string;
  structuredOutput?: ResponsesTextFormat;
  toolChoice?: unknown;
  parallelToolCalls?: boolean;
  maxToolCalls?: number;
  hostedTools?: ResponsesTool[];
  hostedPolicies?: Record<string, ResponsesHostedPolicy>;
}

export interface ResponsesSSEEvent {
  type: string;
  delta?: string;
  text?: string;
  refusal?: string;
  arguments?: unknown;
  input?: string;
  item_id?: string;
  call_id?: string;
  output_index?: number;
  item?: ResponsesOutputItem | null;
  response?: ResponsesCompletedObject | null;
  error?: ResponsesError | null;
}

export interface ResponsesOutputItem {
  id?: string;
  type?: string;
  status?: string;
  call_id?: string;
  name?: string;
  arguments?: unknown;
  input?: string;
}

export interface ResponsesCompletedObject {
  id?: string;
  status?: string;
  previous_response_id?: string;
  conversation?: unknown;
  output?: Array<string | Record<string, unknown>>;
  usage?: ResponsesUsage;
  error?: ResponsesError;
  incomplete_details?: { reason?: string };
}

export interface ResponsesError {
  message?: string;
  code?: string;
  type?: string;
}

export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens: number };
  output_tokens_details?: { reasoning_tokens: number };
}

export interface ResponsesInputItem {
  type?: string;
  role?: string;
  content?: unknown;
  call_id?: string;
  name?: string;
  arguments?: string;
  input?: string;
  output?: unknown;
}

// ─── SSE decode guard ──────────────────────────────────────────────────────────
// The legacy unchecked JSON.parse cast asserted nothing: shape garbage
// crossed the boundary as typed lies (a non-object payload threw a TypeError
// on the `type` fill-in). These decoders read every field the stream parser
// and the codec normalizer consume through the src/util/json.ts readers, with
// Go `json.Unmarshal` semantics: required fields zero-fill, optional fields
// read as `undefined`, malformed entries drop, `null`-able fields keep their
// `null`, and unknown event types keep passing through the normalizer's
// unknown-event bookkeeping (forward compatible with new Responses events).

/**
 * Decodes one parsed payload of the Responses event stream. `type` may come
 * back empty: the caller fills it from the SSE `event:` frame name, which
 * some gateways rely on instead of an in-payload `type`.
 */
export function decodeResponsesEvent(
  value: unknown,
): ResponsesSSEEvent | undefined {
  const rec = asJsonRecord(value);
  if (rec === undefined) return undefined;
  const event: ResponsesSSEEvent = { type: optString(rec, "type") ?? "" };
  const delta = optString(rec, "delta");
  if (delta !== undefined) event.delta = delta;
  const text = optString(rec, "text");
  if (text !== undefined) event.text = text;
  const refusal = optString(rec, "refusal");
  if (refusal !== undefined) event.refusal = refusal;
  if ("arguments" in rec) event.arguments = rec["arguments"];
  const input = optString(rec, "input");
  if (input !== undefined) event.input = input;
  const itemID = optString(rec, "item_id");
  if (itemID !== undefined) event.item_id = itemID;
  const callID = optString(rec, "call_id");
  if (callID !== undefined) event.call_id = callID;
  const outputIndex = optNumber(rec, "output_index");
  if (outputIndex !== undefined) event.output_index = outputIndex;
  const itemValue = rec["item"];
  if (itemValue === null) event.item = null;
  else {
    const item = optRecord(rec, "item");
    if (item !== undefined) event.item = decodeResponsesEventItem(item);
  }
  const responseValue = rec["response"];
  if (responseValue === null) event.response = null;
  else {
    const response = decodeResponsesCompletedObject(responseValue);
    if (response !== undefined) event.response = response;
  }
  const errorValue = rec["error"];
  if (errorValue === null) event.error = null;
  else {
    const error = decodeResponsesError(errorValue);
    if (error !== undefined) event.error = error;
  }
  return event;
}

/** Decodes the `response.*` completion envelope and background-run results. */
export function decodeResponsesCompletedObject(
  value: unknown,
): ResponsesCompletedObject | undefined {
  const rec = asJsonRecord(value);
  if (rec === undefined) return undefined;
  const response: ResponsesCompletedObject = {};
  const id = optString(rec, "id");
  if (id !== undefined) response.id = id;
  const status = optString(rec, "status");
  if (status !== undefined) response.status = status;
  const previousResponseID = optString(rec, "previous_response_id");
  if (previousResponseID !== undefined) {
    response.previous_response_id = previousResponseID;
  }
  if ("conversation" in rec) response.conversation = rec["conversation"];
  const output = rec["output"];
  if (Array.isArray(output)) {
    const items: Array<string | Record<string, unknown>> = [];
    for (const raw of output) {
      if (typeof raw === "string") items.push(raw);
      else {
        const obj = asJsonRecord(raw);
        if (obj !== undefined) items.push(obj);
      }
    }
    response.output = items;
  }
  const usage = decodeResponsesUsage(rec["usage"]);
  if (usage !== undefined) response.usage = usage;
  const error = decodeResponsesError(rec["error"]);
  if (error !== undefined) response.error = error;
  const details = optRecord(rec, "incomplete_details");
  if (details !== undefined) {
    const incomplete: { reason?: string } = {};
    const reason = optString(details, "reason");
    if (reason !== undefined) incomplete.reason = reason;
    response.incomplete_details = incomplete;
  }
  return response;
}

function decodeResponsesEventItem(
  rec: Record<string, unknown>,
): ResponsesOutputItem {
  const item: ResponsesOutputItem = {};
  const id = optString(rec, "id");
  if (id !== undefined) item.id = id;
  const type = optString(rec, "type");
  if (type !== undefined) item.type = type;
  const status = optString(rec, "status");
  if (status !== undefined) item.status = status;
  const callID = optString(rec, "call_id");
  if (callID !== undefined) item.call_id = callID;
  const name = optString(rec, "name");
  if (name !== undefined) item.name = name;
  if ("arguments" in rec) item.arguments = rec["arguments"];
  const input = optString(rec, "input");
  if (input !== undefined) item.input = input;
  return item;
}

function decodeResponsesUsage(value: unknown): ResponsesUsage | undefined {
  const rec = asJsonRecord(value);
  if (rec === undefined) return undefined;
  const usage: ResponsesUsage = {
    input_tokens: optNumber(rec, "input_tokens") ?? 0,
    output_tokens: optNumber(rec, "output_tokens") ?? 0,
    total_tokens: optNumber(rec, "total_tokens") ?? 0,
  };
  const inputDetails = optRecord(rec, "input_tokens_details");
  if (inputDetails !== undefined) {
    usage.input_tokens_details = {
      cached_tokens: optNumber(inputDetails, "cached_tokens") ?? 0,
    };
  }
  const outputDetails = optRecord(rec, "output_tokens_details");
  if (outputDetails !== undefined) {
    usage.output_tokens_details = {
      reasoning_tokens: optNumber(outputDetails, "reasoning_tokens") ?? 0,
    };
  }
  return usage;
}

function decodeResponsesError(value: unknown): ResponsesError | undefined {
  const rec = asJsonRecord(value);
  if (rec === undefined) return undefined;
  const error: ResponsesError = {};
  const message = optString(rec, "message");
  if (message !== undefined) error.message = message;
  const code = optString(rec, "code");
  if (code !== undefined) error.code = code;
  const type = optString(rec, "type");
  if (type !== undefined) error.type = type;
  return error;
}

/** Structural view of the openai Provider used by the Responses codec. */
export interface ResponsesProviderHost extends ResponsesConfigHost {
  apiKey: string;
  baseURL: string;
  client: { fetch(input: string | URL, init?: RequestInit): Promise<Response> };
  headers?: Record<string, string>;
  disableReasoning: boolean;
  retryConfig?: RetryConfig;
  models(): Model[];
  getModel(id: string): Model | undefined;
  maxImagesPerRequestForRequest(params?: ChatParams): number;
  supportsImageDetail(): boolean;
}

/** Sends a streaming Responses API request. */
export async function* chatResponses(
  p: ResponsesProviderHost,
  params: ChatParams,
): AsyncGenerator<StreamEvent> {
  if (p.apiKey === "") {
    yield { type: streamError, error: new Error("OPENAI_API_KEY not set") };
    return;
  }

  let modelID = params.modelId;
  if (modelID === "") {
    const models = p.models();
    if (models.length > 0) modelID = models[0].id;
    else {
      yield {
        type: streamError,
        error: new Error(`no models available from provider "${p.name()}"`),
      };
      return;
    }
  }

  const model = p.getModel(modelID);
  try {
    validateResponsesCapabilitiesForRequest(p, model, params, false);
  } catch (err) {
    yield { type: streamError, error: asError(err), stopReason: "error" };
    return;
  }

  let reqBody: ResponsesRequest;
  try {
    reqBody = buildResponsesRequest(p, params, modelID, model, true, false);
  } catch (err) {
    yield { type: streamError, error: asError(err), stopReason: "error" };
    return;
  }
  const diagnostics = responsesRequestDiagnostics(params, reqBody);

  let body: string;
  try {
    body = JSON.stringify(toWireRequest(reqBody));
  } catch (err) {
    yield { type: streamError, error: wrapError("marshal request", err) };
    return;
  }
  debugJSON("OpenAI Responses request JSON", body);

  let maxRetries = 0;
  let baseDelayMs = 2000;
  if (p.retryConfig !== undefined && p.retryConfig.enabled) {
    maxRetries = p.retryConfig.maxRetries;
    baseDelayMs = p.retryConfig.baseDelayMs;
  }

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
    headers.set("Authorization", `Bearer ${p.apiKey}`);
    headers.set("Accept", "text/event-stream");
    headers.set("User-Agent", providerUserAgent());
    applyHeaders(headers, p.headers);

    let resp: Response;
    try {
      resp = await p.client.fetch(`${p.baseURL}/responses`, {
        method: "POST",
        body,
        headers,
        signal: params.abort,
      });
    } catch (err) {
      if (attempt < maxRetries && isRetryable(err, 0)) {
        const plan = retryPlan(attempt, maxRetries, baseDelayMs, err);
        yield plan.event;
        if (!await waitOrAbort(params.abort, plan.delay)) {
          yield {
            type: streamError,
            error: new Error("aborted"),
            stopReason: "aborted",
          };
          return;
        }
        continue;
      }
      yield { type: streamError, error: wrapError("send request", err) };
      return;
    }

    if (resp.status !== 200) {
      const bodyBytes = await resp.text();
      debugJSON("OpenAI Responses response JSON", bodyBytes);
      const err = new Error(`HTTP ${resp.status}: ${bodyBytes}`);
      if (attempt < maxRetries && isRetryable(err, resp.status)) {
        const plan = retryPlan(attempt, maxRetries, baseDelayMs, err);
        yield plan.event;
        if (!await waitOrAbort(params.abort, plan.delay)) {
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
        error: new Error(`API error ${resp.status}: ${bodyBytes}`),
      };
      return;
    }

    const streamBody = createIdleTimeoutStream(resp.body, streamIdleTimeoutMs);
    const state = { visibleOutput: false };
    let streamErr: Error | undefined;
    let sawError = false;
    try {
      for await (
        const event of parseResponsesSSE(
          p,
          streamBody,
          params,
          diagnostics,
          state,
        )
      ) {
        yield event;
        if (event.type === streamError) sawError = true;
      }
    } catch (err) {
      streamErr = asError(err);
    }
    if (streamErr === undefined) return;
    if (sawError) {
      // A terminal provider error already surfaced; do not retry.
      return;
    }
    if (
      attempt < maxRetries && !state.visibleOutput && isRetryable(streamErr, 0)
    ) {
      const plan = retryPlan(attempt, maxRetries, baseDelayMs, streamErr);
      yield plan.event;
      if (!await waitOrAbort(params.abort, plan.delay)) {
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

/** Materializes the JSON wire request, applying omitempty semantics. */
function toWireRequest(req: ResponsesRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model: req.model,
    instructions: req.instructions === "" ? undefined : req.instructions,
    input: req.input,
    stream: req.stream,
  };
  if (req.tools !== undefined && req.tools.length > 0) {
    out["tools"] = req.tools.map(toWireTool);
  }
  if (req.max_output_tokens !== undefined && req.max_output_tokens > 0) {
    out["max_output_tokens"] = req.max_output_tokens;
  }
  if (req.temperature !== undefined) out["temperature"] = req.temperature;
  if (req.top_p !== undefined) out["top_p"] = req.top_p;
  if (req.store !== undefined) out["store"] = req.store;
  if (
    req.previous_response_id !== undefined && req.previous_response_id !== ""
  ) {
    out["previous_response_id"] = req.previous_response_id;
  }
  if (req.conversation !== undefined && req.conversation !== "") {
    out["conversation"] = req.conversation;
  }
  if (req.truncation !== undefined && req.truncation !== "") {
    out["truncation"] = req.truncation;
  }
  if (req.background === true) out["background"] = true;
  if (req.include !== undefined && req.include.length > 0) {
    out["include"] = req.include;
  }
  if (req.reasoning !== undefined) {
    out["reasoning"] = toWireReasoning(req.reasoning);
  }
  if (req.parallel_tool_calls !== undefined) {
    out["parallel_tool_calls"] = req.parallel_tool_calls;
  }
  if (req.max_tool_calls !== undefined && req.max_tool_calls > 0) {
    out["max_tool_calls"] = req.max_tool_calls;
  }
  if (req.tool_choice !== undefined) out["tool_choice"] = req.tool_choice;
  if (req.text !== undefined) out["text"] = req.text;
  if (req.prompt_cache_key !== undefined && req.prompt_cache_key !== "") {
    out["prompt_cache_key"] = req.prompt_cache_key;
  }
  if (
    req.prompt_cache_retention !== undefined &&
    req.prompt_cache_retention !== ""
  ) {
    out["prompt_cache_retention"] = req.prompt_cache_retention;
  }
  if (req.prompt_cache_options !== undefined) {
    const options: Record<string, unknown> = {};
    if ((req.prompt_cache_options.mode ?? "") !== "") {
      options["mode"] = req.prompt_cache_options.mode;
    }
    if ((req.prompt_cache_options.ttl ?? "") !== "") {
      options["ttl"] = req.prompt_cache_options.ttl;
    }
    if (Object.keys(options).length > 0) out["prompt_cache_options"] = options;
  }
  if (req.service_tier !== undefined && req.service_tier !== "") {
    out["service_tier"] = req.service_tier;
  }
  if (req.metadata !== undefined && Object.keys(req.metadata).length > 0) {
    out["metadata"] = req.metadata;
  }
  if (req.safety_identifier !== undefined && req.safety_identifier !== "") {
    out["safety_identifier"] = req.safety_identifier;
  }
  return out;
}

function toWireReasoning(r: ResponsesReasoning): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if ((r.effort ?? "") !== "") out["effort"] = r.effort;
  if ((r.summary ?? "") !== "") out["summary"] = r.summary;
  if ((r.context ?? "") !== "") out["context"] = r.context;
  if ((r.mode ?? "") !== "") out["mode"] = r.mode;
  return out;
}

function toWireTool(tool: ResponsesTool): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    type: tool.type,
    name: tool.name === "" ? undefined : tool.name,
    description: tool.description === "" ? undefined : tool.description,
    parameters: tool.parameters,
    format: tool.format,
  };
  for (const [key, value] of Object.entries(tool.extra ?? {})) {
    if (
      key === "type" || key === "name" || key === "description" ||
      key === "parameters"
    ) {
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

export function responsesRequestHasCodeInterpreter(
  req: ResponsesRequest,
): boolean {
  for (const tool of req.tools ?? []) {
    if (tool.type === "code_interpreter") return true;
  }
  return false;
}

export function buildResponsesRequest(
  p: ResponsesProviderHost,
  params: ChatParams,
  modelID: string,
  model: Model | undefined,
  stream: boolean,
  background: boolean,
): ResponsesRequest {
  let input: unknown[] = convertResponsesInput(p, params);
  const replayItems = params.responseOptions?.replayItems;
  if (replayItems !== undefined && replayItems.length > 0) {
    input = nativeResponsesReplayInput(replayItems);
  }
  const reqBody: ResponsesRequest = {
    model: modelID,
    instructions: params.systemPrompt,
    input,
    tools: mergeResponsesTools(p, convertResponsesTools(params.tools ?? [])),
    temperature: params.temperature,
    top_p: params.topP,
    stream,
    background,
  };
  applyResponsesConfig(reqBody, p.responsesConfig, params.responseOptions);
  applyResponsesOptions(reqBody, params.responseOptions);
  const previous = params.responseOptions?.previousResponseId?.trim() ?? "";
  if (previous !== "") {
    reqBody.previous_response_id = previous;
    reqBody.conversation = "";
  }
  if (params.maxTokens > 0) {
    reqBody.max_output_tokens = params.maxTokens;
  }

  if (
    p.responsesConfig !== undefined && p.responsesConfig.promptCacheEnabled &&
    supportsPromptCacheKey(model)
  ) {
    reqBody.prompt_cache_key = responsesPromptCacheKey(p, modelID);
    if (supportsPromptCacheRetention(model)) {
      reqBody.prompt_cache_retention = p.responsesConfig.promptCacheRetention;
    }
    if (
      (p.responsesConfig.promptCacheMode ?? "") !== "" ||
      (p.responsesConfig.promptCacheTTL ?? "") !== ""
    ) {
      reqBody.prompt_cache_options = {
        mode: p.responsesConfig.promptCacheMode,
        ttl: p.responsesConfig.promptCacheTTL,
      };
    }
  }

  if (
    !p.disableReasoning && params.thinkingLevel !== thinkingOff &&
    model !== undefined && model.reasoning
  ) {
    reqBody.reasoning = {
      effort: responsesReasoningEffort(params.thinkingLevel),
      summary: responsesReasoningSummary(p, model),
    };
  }
  if (
    p.responsesConfig !== undefined &&
    ((p.responsesConfig.reasoningContext ?? "") !== "" ||
      (p.responsesConfig.reasoningMode ?? "") !== "")
  ) {
    reqBody.reasoning = reqBody.reasoning ?? {};
    reqBody.reasoning.context = p.responsesConfig.reasoningContext;
    reqBody.reasoning.mode = p.responsesConfig.reasoningMode;
  }

  // Responses-API reasoning models reject temperature/top_p, and some models
  // reject sampling parameters entirely (compat flag).
  if (reqBody.reasoning !== undefined || samplingParamsDisabled(model)) {
    reqBody.temperature = undefined;
    reqBody.top_p = undefined;
  }
  return reqBody;
}

/**
 * Describes intentional local field omissions. Emitted on STREAM_START so
 * callers can audit compatibility decisions without changing the request
 * contract or persisting sensitive request data.
 */
export function responsesRequestDiagnostics(
  params: ChatParams,
  req: ResponsesRequest,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  if (
    (params.temperature !== undefined || params.topP !== undefined) &&
    req.temperature === undefined && req.top_p === undefined
  ) {
    const reason = req.reasoning !== undefined
      ? "reasoning_incompatible"
      : "model_compat";
    result.push({ field: "temperature/top_p", action: "omitted", reason });
  }
  if (
    params.responseOptions?.suppressConversation === true &&
    (req.conversation ?? "") === ""
  ) {
    result.push({
      field: "conversation",
      action: "omitted",
      reason: "remote_state_replay_fallback",
    });
  }
  return result;
}

export function nativeResponsesReplayInput(items: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    let serialized: string;
    try {
      serialized = JSON.stringify(item);
    } catch {
      throw new Error(`Responses replay item ${index} is not valid JSON`);
    }
    if (serialized === undefined || serialized.length === 0) {
      throw new Error(`Responses replay item ${index} is not valid JSON`);
    }
    if (new TextEncoder().encode(serialized).length > 128 * 1024) {
      throw new Error(
        `Responses replay item ${index} exceeds ${128 * 1024} bytes`,
      );
    }
    result.push(item);
  }
  return result;
}

export function applyResponsesConfig(
  req: ResponsesRequest,
  config: ResponsesWireConfig | undefined,
  opts: ResponseOptions | undefined,
): void {
  if (config === undefined) return;
  req.store = config.store;
  req.truncation = config.truncation;
  req.include = cloneStringSlice(config.include);
  req.service_tier = config.serviceTier;
  req.metadata = cloneStringMap(config.metadata);
  req.safety_identifier = config.safetyIdentifier;
  req.text = responsesTextOptionFromFormat(config.structuredOutput);
  req.tool_choice = config.toolChoice;
  req.parallel_tool_calls = config.parallelToolCalls;
  req.max_tool_calls = config.maxToolCalls;
  if (
    config.stateMode === "conversation" && (config.conversation ?? "") !== "" &&
    (opts === undefined || opts.suppressConversation !== true)
  ) {
    req.conversation = config.conversation;
  }
}

export function applyResponsesOptions(
  req: ResponsesRequest,
  opts: ResponseOptions | undefined,
): void {
  if (opts === undefined) return;
  if (opts.parallelTools !== undefined) {
    req.parallel_tool_calls = opts.parallelTools;
  }
  if (opts.maxToolCalls !== undefined && opts.maxToolCalls > 0) {
    req.max_tool_calls = opts.maxToolCalls;
  }
  if ((opts.previousResponseId ?? "") !== "") {
    req.previous_response_id = opts.previousResponseId?.trim();
  }
  if (opts.toolChoice !== undefined) {
    req.tool_choice = responsesToolChoice(opts.toolChoice);
  }
  if (opts.structuredOutput !== undefined) {
    req.text = responsesTextOption(opts.structuredOutput);
  }
}

export function responsesToolChoice(choice: ToolChoice | undefined): unknown {
  if (choice === undefined || (choice.type ?? "") === "") return undefined;
  switch (choice.type) {
    case "function":
    case "custom":
      if ((choice.name ?? "") === "") return undefined;
      return { type: choice.type, name: choice.name };
    default:
      return choice.type;
  }
}

export function responsesTextOption(
  opts: StructuredOutputOptions | undefined,
): ResponsesText | undefined {
  if (opts === undefined) return undefined;
  let formatType = opts.format ?? "";
  if (formatType === "") {
    formatType = opts.schema !== undefined ? "json_schema" : "text";
  }
  const format: ResponsesTextFormat = {
    type: formatType,
    name: opts.name === "" ? undefined : opts.name,
    description: opts.description === "" ? undefined : opts.description,
    schema: opts.schema,
  };
  if (opts.strict === true) format.strict = true;
  return { format };
}

export function responsesTextOptionFromFormat(
  format: ResponsesTextFormat | undefined,
): ResponsesText | undefined {
  if (format === undefined) return undefined;
  return {
    format: {
      type: format.type,
      name: format.name,
      description: format.description,
      strict: format.strict,
      schema: format.schema,
    },
  };
}

export function convertResponsesInput(
  p: ResponsesProviderHost,
  params: ChatParams,
): ResponsesInputItem[] {
  let messages = params.messages;
  const maxImages = p.maxImagesPerRequestForRequest(params);
  if (maxImages > 0) {
    messages = limitImageHistory(messages, maxImages);
  }
  const items: ResponsesInputItem[] = [];
  let pendingImages: ResponsesContentBlock[] = [];
  const flushImages = (): void => {
    if (pendingImages.length === 0) return;
    items.push({ type: "message", role: "user", content: pendingImages });
    pendingImages = [];
  };
  for (const msg of messages) {
    if (msg.role !== "toolResult") flushImages();
    switch (msg.role) {
      case "toolResult": {
        let itemType = "function_call_output";
        let output: unknown = responseToolOutput(msg);
        if (msg.toolKind === "custom") {
          itemType = "custom_tool_call_output";
          output = responseCustomToolOutput(msg);
        }
        items.push({
          type: itemType,
          call_id: msg.toolCallId,
          output,
        });
        // Responses API function_call_output is text-only. Preserve images as a
        // following user message, but only after the complete run of function
        // outputs (handled by the normal input ordering).
        if (msg.toolKind !== "custom") {
          for (const c of msg.contents ?? []) {
            if (c.type === "image" && c.image != null) {
              pendingImages.push({
                type: "input_image",
                image_url: `data:${c.image.mimeType};base64,${c.image.data}`,
              });
            }
          }
        }
        break;
      }
      case "assistant": {
        const content = responsesMessageContent(p, msg, "output_text");
        if (content !== undefined) {
          items.push({ type: "message", role: "assistant", content });
        }
        for (const c of msg.contents ?? []) {
          if (c.type === "toolCall" && c.toolCall != null) {
            if (c.toolCall.kind === "custom") {
              items.push({
                type: "custom_tool_call",
                call_id: c.toolCall.id,
                name: c.toolCall.name,
                input: c.toolCall.input,
              });
            } else {
              items.push({
                type: "function_call",
                call_id: c.toolCall.id,
                name: c.toolCall.name,
                arguments: rawArguments(c.toolCall),
              });
            }
          }
        }
        break;
      }
      default: {
        const role = msg.role === "" ? "user" : msg.role;
        const content = responsesMessageContent(p, msg, "input_text");
        items.push({ type: "message", role, content });
      }
    }
  }
  flushImages();
  return items;
}

function rawArguments(
  toolCall: NonNullable<ContentBlock["toolCall"]>,
): string {
  if (
    toolCall.invalidArguments !== undefined && toolCall.invalidArguments !== ""
  ) {
    return toolCall.invalidArguments;
  }
  const args = toolCall.arguments;
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}

export function responsesMessageContent(
  p: ResponsesProviderHost,
  msg: Message,
  textType: string,
): unknown {
  if ((msg.contents ?? []).length === 0) {
    return [{ type: textType, text: msg.content }];
  }
  const blocks: ResponsesContentBlock[] = [];
  for (const c of msg.contents ?? []) {
    switch (c.type) {
      case "text":
        blocks.push({ type: textType, text: c.text });
        break;
      case "image":
        if (c.image != null) {
          const block: ResponsesContentBlock = {
            type: "input_image",
            image_url: `data:${c.image.mimeType};base64,${c.image.data}`,
          };
          if (p.supportsImageDetail()) {
            block.detail = normalizeImageDetail(c.image.detail ?? "");
          }
          blocks.push(block);
        }
        break;
      case "file":
        if (c.file != null) {
          blocks.push({
            type: "input_file",
            file_id: c.file.id,
            file_url: c.file.url,
            file_data: c.file.data,
            filename: c.file.filename,
          });
        }
        break;
      default:
        break;
    }
  }
  if (blocks.length === 0 && (msg.content ?? "") !== "") {
    blocks.push({ type: textType, text: msg.content });
  }
  return blocks;
}

export function responseToolOutput(msg: Message): string {
  if ((msg.content ?? "") !== "" || (msg.contents ?? []).length === 0) {
    return msg.content ?? "";
  }
  const parts: string[] = [];
  for (const c of msg.contents ?? []) {
    if (c.type === "text" && (c.text ?? "") !== "") {
      parts.push(c.text as string);
    }
  }
  return parts.join("\n");
}

/**
 * Preserves the Responses custom tool content-list contract. Function outputs
 * retain their historical text-only encoding for compatibility with
 * OpenAI-compatible gateways.
 */
export function responseCustomToolOutput(msg: Message): unknown {
  if ((msg.contents ?? []).length === 0) return msg.content ?? "";
  let content: ResponsesContentBlock[] = [];
  for (const block of msg.contents ?? []) {
    switch (block.type) {
      case "text":
        if ((block.text ?? "") !== "") {
          content.push({ type: "input_text", text: block.text });
        }
        break;
      case "image":
        if (block.image != null && block.image.data !== "") {
          content.push({
            type: "input_image",
            image_url:
              `data:${block.image.mimeType};base64,${block.image.data}`,
            detail: normalizeImageDetail(block.image.detail ?? ""),
          });
        }
        break;
      case "file":
        if (
          block.file != null &&
          ((block.file.id ?? "") !== "" || (block.file.url ?? "") !== "" ||
            (block.file.data ?? "") !== "")
        ) {
          content.push({
            type: "input_file",
            file_id: block.file.id,
            file_url: block.file.url,
            file_data: block.file.data,
            filename: block.file.filename,
          });
        }
        break;
      default:
        break;
    }
  }
  if (content.length === 0) return msg.content ?? "";
  if (
    (msg.content ?? "") !== "" && content.length === 1 &&
    content[0].type !== "input_text"
  ) {
    content = [{ type: "input_text", text: msg.content }, ...content];
  }
  return content;
}

export function convertResponsesTools(
  tools: ToolDefinition[],
): ResponsesTool[] {
  const result: ResponsesTool[] = [];
  const seenHosted = new Set<string>();
  for (const t of tools) {
    if (t.kind === "hosted") {
      // Resolved via the shared hosted-tool registry in the caller; unknown
      // hosted tools are skipped so gateways never receive guesses.
      const toolType = t.providerType === "responses" ||
          t.providerType === "openai-responses"
        ? (t.name === "web_search" || t.name === "openai_responses_web_search"
          ? "web_search"
          : t.name)
        : "";
      if (toolType === "") continue;
      if (seenHosted.has(toolType)) continue;
      seenHosted.add(toolType);
      result.push({ type: toolType });
      continue;
    }
    if (t.kind === "custom") {
      result.push({
        type: "custom",
        name: t.name,
        description: t.description,
        format: t.format,
      });
      continue;
    }
    result.push({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    });
  }
  return result;
}

/**
 * Extracts the most specific error detail from a response.failed / error SSE
 * event. Some OpenAI-compatible servers (e.g. Kimi) nest the failure reason
 * inside the response object rather than the top-level error field, so both
 * locations are checked.
 */
export function responsesEventError(
  event: ResponsesSSEEvent,
): Error | undefined {
  let err = event.error ?? undefined;
  if ((err === undefined || err === null) && event.response != null) {
    err = event.response.error;
  }
  if (err === undefined || err === null) return undefined;
  let detail = (err.message ?? "").trim();
  if (detail === "") detail = (err.code ?? "").trim();
  if (detail === "") detail = (err.type ?? "").trim();
  if (detail === "") return undefined;
  return new Error(`responses error: ${detail}`);
}

export async function* parseResponsesSSE(
  p: ResponsesProviderHost,
  body: ReadableStream<Uint8Array> | null,
  params: ChatParams,
  diagnostics: Array<Record<string, unknown>>,
  state: { visibleOutput: boolean },
): AsyncGenerator<StreamEvent> {
  let textContent = "";
  let reasoning = "";
  let stopReason = "";
  let completed = false;
  const normalizer = new ResponsesNormalizer();
  if (p.responsesConfig !== undefined) {
    normalizer.hostedPolicies = p.responsesConfig.hostedPolicies;
  }

  const start: StreamEvent = { type: streamStart };
  if (diagnostics.length > 0) {
    start.metadata = { responsesRequestDiagnostics: diagnostics };
  }
  yield start;

  let decodeErr: Error | undefined;
  let usage: Usage | undefined;
  const frames = responsesSSEFrames(body);
  try {
    for await (const frame of frames) {
      if (params.abort?.aborted) {
        yield {
          type: streamError,
          error: new Error("aborted"),
          stopReason: "aborted",
        };
        archiveResponsesTurn(p, params, normalizer);
        return;
      }
      const data = frame.data.trim();
      if (data === "[DONE]") break;

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch (err) {
        decodeErr = new Error(
          `responses event ${frame.sequence} (${
            frame.event || "unknown"
          }): invalid JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        break;
      }
      const event = decodeResponsesEvent(parsed);
      if (event === undefined) {
        decodeErr = new Error(
          `responses event ${frame.sequence}: invalid event shape`,
        );
        break;
      }
      if ((event.type ?? "") === "") event.type = frame.event;
      if ((event.type ?? "") === "") {
        decodeErr = new Error(
          `responses event ${frame.sequence}: missing event type`,
        );
        break;
      }
      const applyErr = normalizer.apply(event, data);
      if (applyErr !== undefined) {
        decodeErr = new Error(
          `responses event ${frame.sequence} (${event.type}): ${applyErr.message}`,
        );
        break;
      }
      if (
        (event.type === "response.output_item.added" ||
          event.type === "response.output_item.done") &&
        event.item != null &&
        isHostedResponsesItemType(event.item.type ?? "")
      ) {
        yield {
          type: streamHostedItem,
          providerEventType: event.type,
          itemId: event.item.id,
          hostedItem: {
            id: event.item.id,
            type: event.item.type,
            status: event.item.status,
            outputIndex: event.output_index ?? 0,
          },
        };
      }

      const base = (eventType: string): StreamEvent => ({
        type: streamStart,
        providerEventType: eventType,
        itemId: event.item_id,
        callId: event.call_id,
      });

      const unsupported = normalizer.unsupportedError();
      if (unsupported !== undefined) {
        const ev = base(event.type);
        ev.type = streamError;
        ev.error = unsupported;
        ev.stopReason = "error";
        yield ev;
        archiveResponsesTurn(p, params, normalizer);
        return;
      }
      const policyErr = normalizer.hostedPolicyError();
      if (policyErr !== undefined) {
        const ev = base(event.type);
        ev.type = streamError;
        ev.error = policyErr;
        ev.stopReason = "error";
        yield ev;
        archiveResponsesTurn(p, params, normalizer);
        return;
      }

      switch (event.type) {
        case "response.output_text.delta":
          if ((event.delta ?? "") !== "") {
            state.visibleOutput = true;
            textContent += event.delta;
            const ev = base(event.type);
            ev.type = streamTextDelta;
            ev.textDelta = event.delta;
            yield ev;
          }
          break;
        case "response.output_text.done":
          // Some gateways omit deltas and only send the terminal text. When
          // deltas were already received, the done payload is a duplicate.
          if ((event.text ?? "") !== "" && textContent.length === 0) {
            state.visibleOutput = true;
            textContent += event.text;
            const ev = base(event.type);
            ev.type = streamTextDelta;
            ev.textDelta = event.text;
            yield ev;
          }
          break;
        case "response.reasoning_text.delta":
        case "response.reasoning_summary_text.delta":
          if (!p.disableReasoning && (event.delta ?? "") !== "") {
            state.visibleOutput = true;
            reasoning += event.delta;
            const ev = base(event.type);
            ev.type = streamThinkDelta;
            ev.thinkDelta = event.delta;
            yield ev;
          }
          break;
        case "response.reasoning_text.done":
        case "response.reasoning_summary_text.done":
          if (
            !p.disableReasoning && (event.text ?? "") !== "" &&
            reasoning.length === 0
          ) {
            state.visibleOutput = true;
            reasoning += event.text;
            const ev = base(event.type);
            ev.type = streamThinkDelta;
            ev.thinkDelta = event.text;
            yield ev;
          }
          break;
        case "response.refusal.delta":
          if ((event.delta ?? "") !== "") {
            state.visibleOutput = true;
            const ev = base(event.type);
            ev.type = streamTextDelta;
            ev.textDelta = event.delta;
            ev.metadata = { refusal: true };
            yield ev;
          }
          break;
        case "response.refusal.done": {
          let refusal = event.text ?? "";
          if (refusal === "") refusal = event.refusal ?? "";
          if (refusal !== "" && textContent.length === 0) {
            state.visibleOutput = true;
            const ev = base(event.type);
            ev.type = streamTextDelta;
            ev.textDelta = refusal;
            ev.metadata = { refusal: true };
            yield ev;
          }
          break;
        }
        case "response.function_call_arguments.delta":
        case "response.function_call_arguments.done":
          state.visibleOutput = true;
          break;
        case "response.output_item.done":
          if (event.item != null && event.item.type === "function_call") {
            state.visibleOutput = true;
          }
          break;
        case "response.completed":
          completed = true;
          if (event.response != null) {
            usage = convertResponsesUsage(event.response.usage);
            stopReason = responseStopReason(event.response.status ?? "");
          }
          {
            const evErr = responsesEventError(event);
            if (evErr !== undefined) {
              decodeErr = evErr;
            }
          }
          // response.completed is terminal. Do not wait for EOF or [DONE].
          break;
        case "response.incomplete":
          completed = true;
          if (event.response != null) {
            usage = convertResponsesUsage(event.response.usage);
            stopReason = responseStopReason(event.response.status ?? "");
            if (stopReason === "") stopReason = "incomplete";
          } else {
            stopReason = "incomplete";
          }
          break;
        case "response.failed":
        case "error": {
          let err = responsesEventError(event);
          if (err === undefined) err = new Error("responses stream failed");
          decodeErr = err;
          break;
        }
        default:
          break;
      }
      if (
        decodeErr !== undefined || event.type === "response.completed" ||
        event.type === "response.incomplete" ||
        event.type === "response.failed" ||
        event.type === "error"
      ) {
        break;
      }
    }
  } catch (err) {
    decodeErr = asError(err);
  }

  if (decodeErr !== undefined && !isTerminalResponsesEventError(decodeErr)) {
    archiveResponsesTurn(p, params, normalizer);
    throw decodeErr;
  }

  const toolCalls = normalizer.toolCalls();
  for (const call of toolCalls) {
    let id = call.id;
    if (id === "") id = call.itemID;
    if (id === "") id = nextToolCallFallbackId("openai_toolcall");
    const tc = {
      id,
      name: call.name,
      kind: call.kind,
      input: call.input,
      arguments: decodeArguments(call.arguments),
    };
    state.visibleOutput = true;
    yield {
      type: streamToolCall,
      providerEventType: "response.output_item.done",
      itemId: call.itemID,
      callId: call.id,
      toolCall: tc,
    };
  }
  if (usage !== undefined) {
    state.visibleOutput = true;
    yield { type: streamUsage, usage };
  }
  const attachments = normalizer.attachments();
  if (stopReason === "" && toolCalls.length > 0) stopReason = "tool_calls";
  if (completed && stopReason === "") stopReason = "stop";
  debugCompleteResponse({
    provider: "openai",
    api: "responses",
    content: textContent,
    reasoning,
    toolCalls: toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      kind: call.kind,
      input: call.input,
      arguments: decodeArguments(call.arguments),
    })),
    stopReason,
    usage,
  });
  archiveResponsesTurn(p, params, normalizer);
  yield {
    type: streamDone,
    stopReason,
    metadata: normalizer.metadata(),
    attachments,
  };
}

/** Distinguishes terminal provider errors from transport/JSON failures. */
function isTerminalResponsesEventError(err: Error): boolean {
  return err.message.startsWith("responses error:") ||
    err.message === "responses stream failed";
}

function decodeArguments(raw: string | undefined): unknown {
  if (raw === undefined || raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function isHostedResponsesItemType(itemType: string): boolean {
  return responsesHostedItemTypes.includes(itemType);
}

export function archiveResponsesTurn(
  p: ResponsesProviderHost,
  params: ChatParams,
  normalizer: ResponsesNormalizer,
): void {
  const archiveSink = params.responseOptions?.responseArchive;
  if (archiveSink === undefined || normalizer === undefined) return;
  const response = normalizer.response;
  if (response.id === "" && response.items.length === 0) return;
  const items = response.items
    .filter((item) => item.type !== "")
    .map((item) => ({
      id: item.id,
      type: item.type,
      status: item.status,
      outputIndex: item.outputIndex,
      canonical: parseCanonical(item.canonical),
    }));
  archiveSink({
    responseId: response.id,
    status: response.status,
    previousResponseId: response.previousResponseID,
    conversationId: response.conversationID,
    incompleteReason: response.incompleteReason,
    stateMode: responseStateMode(p),
    usage: convertResponsesUsage(response.usage),
    items,
    attachments: normalizer.attachments(),
    unknownEventTypes: [...response.unknownEventTypes],
  });
}

function parseCanonical(raw: string | undefined): unknown {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function responseStateMode(p: ResponsesProviderHost): string {
  if (
    p.responsesConfig === undefined ||
    (p.responsesConfig.stateMode ?? "") === ""
  ) {
    return "replay";
  }
  return p.responsesConfig.stateMode ?? "replay";
}

export function convertResponsesUsage(
  u: ResponsesUsage | undefined,
): Usage | undefined {
  if (u === undefined) return undefined;
  const usage: Usage = {
    input: u.input_tokens,
    output: u.output_tokens,
    totalTokens: u.total_tokens,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  if (u.input_tokens_details !== undefined) {
    usage.cacheRead = u.input_tokens_details.cached_tokens;
  }
  if (u.output_tokens_details !== undefined) {
    usage.reasoning = u.output_tokens_details.reasoning_tokens;
  }
  return usage;
}

export function responsesReasoningEffort(level: ThinkingLevel): string {
  switch (level) {
    case thinkingOff:
      return "";
    case thinkingMinimal:
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case thinkingHigh:
    case thinkingXHigh:
      return "high";
    case thinkingMax:
      return "max";
    default:
      return "";
  }
}

export function responsesReasoningSummary(
  p: ResponsesProviderHost,
  model: Model | undefined,
): string {
  if (!supportsReasoningSummary(model)) return "";
  if (p.responsesConfig === undefined) return "auto";
  const summary = p.responsesConfig.reasoningSummary ?? "";
  if (summary === "none" || summary === "off") return "";
  if (summary !== "") return summary;
  return "auto";
}

export function responsesPromptCacheKey(
  p: ResponsesProviderHost,
  modelID: string,
): string {
  if (p.responsesConfig === undefined) return "";
  if ((p.responsesConfig.promptCacheKey ?? "") !== "") {
    return p.responsesConfig.promptCacheKey as string;
  }
  if (modelID === "") return "";
  const base = p.baseURL.replace(/^https:\/\//, "").replace(/^http:\/\//, "");
  return `vibecoding:${base}:${modelID}`;
}

export function responseStopReason(status: string): string {
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
      return "error";
    default:
      return status;
  }
}

// ─── retry helpers ───────────────────────────────────────────────────────────

function retryPlan(
  attempt: number,
  maxRetries: number,
  baseDelayMs: number,
  err: unknown,
): { event: StreamEvent; delay: number } {
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
}

async function waitOrAbort(
  signal: AbortSignal | undefined,
  delay: number,
): Promise<boolean> {
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
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function wrapError(context: string, err: unknown): Error {
  return new Error(
    `${context}: ${err instanceof Error ? err.message : String(err)}`,
  );
}
