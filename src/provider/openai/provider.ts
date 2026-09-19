// Ported from internal/provider/openai/provider.go
//
// Wire structs keep the Go JSON tag keys (snake_case) as TypeScript property
// names, so serialization is a direct `JSON.stringify`. `Chat(ctx, params)
// <-chan StreamEvent` maps to `chat(params): AsyncIterable<StreamEvent>` and
// `context.Context`/the abort channel map to `params.abort` (AbortSignal).

import { type ResponsesConfig } from "../../config/mod.ts";
import { BaseProvider } from "../base.ts";
import { debugCompleteResponse, debugJSON } from "../debug.ts";
import {
  applyHeaders,
  type HttpClient,
  type HTTPClientOptions,
  newStreamHttpClientWithOptions,
} from "../http_client.ts";
import { newIdleTimeoutStream, streamIdleTimeoutMs } from "../idle_timeout.ts";
import type { Provider as ProviderInterface } from "../provider.ts";
import {
  formatRetryMessage,
  isRetryable,
  type RetryConfig,
  retryDelay,
  retryErrorDetail,
} from "../retry.ts";
import { nextToolCallFallbackId } from "../toolcall_id.ts";
import {
  type ChatParams,
  type ImageContent,
  type Message,
  type Model,
  type ModelPricing,
  type ResponseOptions,
  type ResponseStateFailureClass,
  responseStateFailureExpired,
  responseStateFailurePermission,
  responseStateFailureRequestFailed,
  samplingParamsDisabled,
  streamDone,
  streamError,
  type StreamEvent,
  streamRetry,
  streamStart,
  streamTextDelta,
  streamThinkDelta,
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
import {
  cloneHeaders,
  cloneStringMap,
  limitImageHistory,
  normalizeImageDetail,
  toolArgumentsString,
} from "./wire.ts";
import {
  chatResponses,
  type ResponsesProviderHost,
  type ResponsesWireConfig,
} from "./responses.ts";
import {
  type ResponsesCapabilityReport,
  responsesCapabilityReport,
  responsesConfigHostedTools,
  responsesConfigTextFormat,
  responsesConfigToolChoice,
  responsesHostedPolicies,
  validateResponsesConfig,
} from "./responses_config.ts";
import { ResponsesRunManager } from "./responses_runtime.ts";
import { ThinkSplitter } from "./think_split.ts";

/** Implements the OpenAI Chat Completions API. */
export class Provider extends BaseProvider implements ProviderInterface {
  apiKey: string;
  baseURL: string;
  client: HttpClient;
  headers: Record<string, string> | undefined;
  /** protocol type: "openai-chat" or "openai-responses" */
  apiType: string;
  disableReasoning: boolean;
  thinkingFormat: string;
  useResponsesAPI: boolean;
  responsesConfig: ResponsesWireConfig | undefined;
  maxImagesPerRequest: number;
  retryConfig: RetryConfig | undefined;

  constructor(
    name: string,
    apiKey: string,
    baseURL: string,
    models: Model[],
    client: HttpClient,
  ) {
    super(name, models);
    if (baseURL === "") baseURL = "https://api.openai.com/v1";
    if (apiKey === "") apiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
    this.apiKey = apiKey;
    this.baseURL = baseURL.replace(/\/+$/, "");
    this.client = client;
    this.apiType = "openai-chat";
    this.disableReasoning = false;
    this.thinkingFormat = "";
    this.useResponsesAPI = false;
    this.maxImagesPerRequest = 0;
    this.responsesConfig = { promptCacheEnabled: true, background: false };

    const disableReasoning = Deno.env.get("OPENAI_DISABLE_REASONING") ?? "";
    if (disableReasoning === "1" || disableReasoning === "true") {
      this.disableReasoning = true;
    }
  }

  /** Returns the protocol/API type. */
  api(): string {
    return this.apiType;
  }

  /** Implements ResponseStateModeProvider. */
  responseStateMode(): string {
    if (this.responsesConfig === undefined) return "replay";
    const mode = this.responsesConfig.stateMode ?? "";
    return mode === "" ? "replay" : mode;
  }

  /**
   * Reports errors that invalidate a remote previous_response_id but are
   * recoverable from the local Responses archive.
   */
  responseStateFallbackError(err: unknown): boolean {
    switch (this.responseStateFailureClass(err)) {
      case responseStateFailureExpired:
      case responseStateFailurePermission:
        return true;
      default:
        return false;
    }
  }

  /**
   * Categorizes stateful Responses failures for recovery/audit. Explicit remote
   * state invalidation is replayable from the local archive; ordinary request
   * failures remain visible to the caller.
   */
  responseStateFailureClass(err: unknown): ResponseStateFailureClass {
    if (err === undefined || err === null) {
      return responseStateFailureRequestFailed;
    }
    const message = (err instanceof Error ? err.message : String(err))
      .toLowerCase();
    if (
      message.includes("api error 401") || message.includes("api error 403") ||
      message.includes("unauthorized") || message.includes("forbidden") ||
      message.includes("permission")
    ) {
      return responseStateFailurePermission;
    }
    if (
      message.includes("api error 404") || message.includes("api error 410") ||
      (message.includes("previous_response_id") &&
        (message.includes("expired") || message.includes("not found") ||
          message.includes("invalid")))
    ) {
      return responseStateFailureExpired;
    }
    return responseStateFailureRequestFailed;
  }

  /** Switches the provider to the Responses API. */
  setUseResponsesAPI(enabled: boolean): void {
    this.useResponsesAPI = enabled;
    this.apiType = "openai-responses";
  }

  /** Applies Responses API-specific configuration. */
  setResponsesConfig(cfg: ResponsesConfig): void {
    validateResponsesConfig(cfg);
    this.responsesConfig = {
      reasoningSummary: cfg.reasoningSummary,
      reasoningContext: cfg.reasoningContext,
      reasoningMode: cfg.reasoningMode,
      promptCacheEnabled: cfg.promptCacheEnabled !== false,
      promptCacheKey: cfg.promptCacheKey,
      promptCacheRetention: cfg.promptCacheRetention,
      promptCacheMode: cfg.promptCacheMode,
      promptCacheTTL: cfg.promptCacheTTL,
      safetyIdentifier: cfg.safetyIdentifier,
      metadata: cloneStringMap(cfg.metadata),
      stateMode: cfg.stateMode,
      store: cfg.store,
      conversation: cfg.conversation,
      truncation: cfg.truncation,
      background: cfg.background === true,
      include: cfg.include === undefined ? undefined : [...cfg.include],
      serviceTier: cfg.serviceTier,
      structuredOutput: responsesConfigTextFormat(cfg.structuredOutput ?? {}),
      toolChoice: responsesConfigToolChoice(cfg.toolControl?.choice ?? ""),
      parallelToolCalls: cfg.toolControl?.parallel,
      maxToolCalls: cfg.toolControl?.maxCalls ?? 0,
      hostedTools: responsesConfigHostedTools(cfg.hostedTools ?? {}),
      hostedPolicies: responsesHostedPolicies(cfg.hostedTools ?? {}),
    };
  }

  /**
   * Reports whether this provider must submit Responses requests through the
   * durable background run manager.
   */
  responsesBackgroundEnabled(): boolean {
    return this.responsesConfig !== undefined &&
      this.responsesConfig.background === true;
  }

  responsesHostedTimeout(): number {
    if (this.responsesConfig === undefined) return 0;
    return this.responsesConfig.hostedPolicies?.["code_interpreter"]
      ?.timeoutMs ??
      0;
  }

  /** Disables reasoning_content support for incompatible APIs. */
  disableReasoningSupport(): void {
    this.disableReasoning = true;
  }

  /** Sets the retry configuration for this provider. */
  setRetryConfig(cfg: RetryConfig | undefined): void {
    this.retryConfig = cfg;
  }

  /** Returns a durable background Responses run manager for a session dir. */
  newResponsesRunManager(sessionDir: string): ResponsesRunManager {
    return new ResponsesRunManager(this, sessionDir);
  }

  /** Sets custom HTTP headers applied to every provider request. */
  setHeaders(headers: Record<string, string> | undefined): void {
    this.headers = cloneHeaders(headers);
  }

  /**
   * Configures the client-side image history limit. Positive values keep the
   * newest N images, zero uses the provider default, and negative values disable
   * the limit.
   */
  setMaxImagesPerRequest(max: number): void {
    this.maxImagesPerRequest = max;
  }

  /** Returns whether reasoning support is disabled. */
  isReasoningDisabled(): boolean {
    return this.disableReasoning;
  }

  /**
   * Sets the thinking parameter format: "openai" = reasoning_effort, "deepseek"
   * = thinking + reasoning_effort, "kimi" = reasoning_effort with low/high/max
   * levels, "doubao-seed" = reasoning_effort with minimal/low/medium/high, or
   * "xiaomi" = legacy thinking-only format.
   */
  setThinkingFormat(format: string): void {
    this.thinkingFormat = format;
  }

  /** Returns the resolved capability profile for a model. */
  responsesCapabilityReport(modelID: string): ResponsesCapabilityReport {
    return responsesCapabilityReport(this, modelID);
  }

  /** Sends a chat request and returns a stream of events. */
  chat(params: ChatParams): AsyncIterable<StreamEvent> {
    if (this.useResponsesAPI) {
      return chatResponses(this as unknown as ResponsesProviderHost, params);
    }
    return this.chatCompletions(params);
  }

  private async *chatCompletions(
    params: ChatParams,
  ): AsyncGenerator<StreamEvent> {
    if (this.apiKey === "") {
      yield { type: streamError, error: new Error("OPENAI_API_KEY not set") };
      return;
    }

    let modelID = params.modelId;
    if (modelID === "") {
      const models = this.models();
      if (models.length === 0) {
        yield {
          type: streamError,
          error: new Error(
            `no models available from provider "${this.name()}"`,
          ),
        };
        return;
      }
      modelID = models[0].id;
    }

    const model = this.getModel(modelID);
    const messages = this.convertMessages(
      params,
      this.requiresReasoningContentOnAssistant(model),
    );
    const tools = this.convertTools(params.tools ?? []);

    const reqBody: OpenAIChatRequest = {
      model: modelID,
      messages,
      tools,
      parallel_tool_calls: chatParallelToolCalls(
        model,
        tools,
        params.responseOptions,
      ),
      stream: true,
      stream_options: { include_usage: true },
      temperature: params.temperature,
      top_p: params.topP,
    };
    if (params.maxTokens > 0) {
      if (maxTokensField(model) === "max_completion_tokens") {
        reqBody.max_completion_tokens = params.maxTokens;
      } else {
        reqBody.max_tokens = params.maxTokens;
      }
    }

    if (
      !this.disableReasoning && params.thinkingLevel !== thinkingOff &&
      model !== undefined && model.reasoning
    ) {
      const format = this.thinkingFormatForModel(model);
      switch (format) {
        case "deepseek":
          reqBody.thinking = { type: "enabled" };
          if (supportsReasoningEffort(model)) {
            reqBody.reasoning_effort = deepseekReasoningEffort(
              params.thinkingLevel,
            );
          }
          break;
        case "kimi":
          if (supportsReasoningEffort(model)) {
            reqBody.reasoning_effort = kimiReasoningEffort(
              params.thinkingLevel,
            );
          }
          break;
        case "doubao-seed":
          if (supportsReasoningEffort(model)) {
            reqBody.reasoning_effort = doubaoSeedReasoningEffort(
              params.thinkingLevel,
            );
          }
          break;
        case "xiaomi":
          reqBody.thinking = { type: "enabled" };
          break;
        case "qwen": {
          reqBody.enable_thinking = true;
          const budget = qwenThinkingBudget(params.thinkingLevel);
          if (budget > 0) reqBody.thinking_budget = budget;
          break;
        }
        default:
          if (supportsReasoningEffort(model)) {
            reqBody.reasoning_effort = openAIReasoningEffort(
              params.thinkingLevel,
            );
            // OpenAI reasoning models reject temperature/top_p.
            reqBody.temperature = undefined;
            reqBody.top_p = undefined;
          }
      }
    }

    // Some models reject sampling parameters entirely (compat flag).
    if (samplingParamsDisabled(model)) {
      reqBody.temperature = undefined;
      reqBody.top_p = undefined;
    }

    let body = JSON.stringify(toWireChatRequest(reqBody));
    debugJSON("OpenAI request JSON", body);

    let maxRetries = 0;
    let baseDelayMs = 2000;
    if (this.retryConfig !== undefined && this.retryConfig.enabled) {
      maxRetries = this.retryConfig.maxRetries;
      baseDelayMs = this.retryConfig.baseDelayMs;
    }

    let completionTokenFallbackUsed = false;
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
      headers.set("Authorization", `Bearer ${this.apiKey}`);
      headers.set("Accept", "text/event-stream");
      headers.set("User-Agent", providerUserAgent());
      applyHeaders(headers, this.headers);

      let resp: Response;
      try {
        resp = await this.client.fetch(`${this.baseURL}/chat/completions`, {
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
        debugJSON("OpenAI response JSON", bodyBytes);
        if (
          resp.status === 400 && !completionTokenFallbackUsed &&
          params.maxTokens > 0 &&
          maxTokensField(model) !== "max_completion_tokens" &&
          isMaxTokensUnsupportedResponse(bodyBytes)
        ) {
          reqBody.max_tokens = undefined;
          reqBody.max_completion_tokens = params.maxTokens;
          body = JSON.stringify(toWireChatRequest(reqBody));
          completionTokenFallbackUsed = true;
          attempt--;
          continue;
        }
        const httpErr = new Error(
          `HTTP ${resp.status}: ${bodyBytes}`,
        );
        if (attempt < maxRetries && isRetryable(httpErr, resp.status)) {
          const plan = retryPlan(attempt, maxRetries, baseDelayMs, httpErr);
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

      const streamBody = newIdleTimeoutStream(resp.body, streamIdleTimeoutMs);
      const state = { visibleOutput: false };
      let streamErr: Error | undefined;
      try {
        for await (const event of this.parseSSE(streamBody, params, state)) {
          yield event;
        }
      } catch (err) {
        streamErr = asError(err);
      }
      if (streamErr === undefined) return;
      if (
        attempt < maxRetries && !state.visibleOutput &&
        isRetryable(streamErr, 0)
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

  private async *parseSSE(
    body: ReadableStream<Uint8Array> | null,
    params: ChatParams,
    state: { visibleOutput: boolean },
  ): AsyncGenerator<StreamEvent> {
    let textContent = "";
    let reasoning = "";
    const toolCalls: ToolCallBlock[] = [];
    const toolCallBuffers = new Map<number, string>();
    let stopReason = "";
    let usage: Usage | undefined;

    let splitter: ThinkSplitter | undefined;
    const model = this.getModel(params.modelId);
    if (model?.compat?.parseReasoningInContent === true) {
      splitter = new ThinkSplitter();
    }

    yield { type: streamStart };

    const handleChunk = (chunk: OpenAIResponse): StreamEvent[] => {
      const events: StreamEvent[] = [];
      if (chunk.usage !== undefined && chunk.usage !== null) {
        usage = mergeOpenAIUsage(usage, chunk.usage);
      }
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta ?? {};
        if ((delta.content ?? "") !== "") {
          if (splitter !== undefined) {
            const { text, think } = splitter.push(delta.content as string);
            if (think !== "") {
              state.visibleOutput = true;
              reasoning += think;
              events.push({ type: streamThinkDelta, thinkDelta: think });
            }
            if (text !== "") {
              state.visibleOutput = true;
              textContent += text;
              events.push({ type: streamTextDelta, textDelta: text });
            }
          } else {
            state.visibleOutput = true;
            textContent += delta.content;
            events.push({ type: streamTextDelta, textDelta: delta.content });
          }
        }
        if (
          !this.disableReasoning && delta.reasoning_content !== undefined &&
          delta.reasoning_content !== null && delta.reasoning_content !== ""
        ) {
          state.visibleOutput = true;
          reasoning += delta.reasoning_content;
          events.push({
            type: streamThinkDelta,
            thinkDelta: delta.reasoning_content,
          });
        }
        for (const tc of delta.tool_calls ?? []) {
          state.visibleOutput = true;
          const idx = tc.index ?? 0;
          if (idx < 0) continue;
          if (!toolCallBuffers.has(idx)) {
            toolCallBuffers.set(idx, "");
            while (toolCalls.length <= idx) {
              toolCalls.push({ id: "", name: "", arguments: {} });
            }
            toolCalls[idx].id = tc.id ?? "";
            toolCalls[idx].name = tc.function?.name ?? "";
          }
          if ((tc.id ?? "") !== "") toolCalls[idx].id = tc.id as string;
          if ((tc.function?.name ?? "") !== "") {
            toolCalls[idx].name = tc.function?.name as string;
          }
          const argsText = tc.function?.arguments;
          if (argsText !== undefined && argsText !== null && argsText !== "") {
            const encoded = typeof argsText === "string"
              ? argsText
              : JSON.stringify(argsText);
            toolCallBuffers.set(
              idx,
              (toolCallBuffers.get(idx) ?? "") + encoded,
            );
          }
        }
        if (
          choice.finish_reason !== undefined && choice.finish_reason !== null
        ) {
          stopReason = choice.finish_reason;
        }
      }
      return events;
    };

    const reader = body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawDone = false;
    if (reader !== undefined) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line.startsWith("data: ")) continue;
          const data = line.slice("data: ".length);
          if (data === "[DONE]") {
            sawDone = true;
            break;
          }
          let chunk: OpenAIResponse;
          try {
            chunk = JSON.parse(data) as OpenAIResponse;
          } catch {
            continue;
          }
          for (const event of handleChunk(chunk)) yield event;
        }
        if (sawDone) break;
        if (params.abort?.aborted) {
          yield {
            type: streamError,
            error: new Error("aborted"),
            stopReason: "aborted",
          };
          return;
        }
      }
      if (!sawDone && buffer.length > 0 && buffer.startsWith("data: ")) {
        const data = buffer.slice("data: ".length);
        if (data !== "[DONE]") {
          let chunk: OpenAIResponse | undefined;
          try {
            chunk = JSON.parse(data) as OpenAIResponse;
          } catch {
            chunk = undefined;
          }
          if (chunk !== undefined) {
            for (const event of handleChunk(chunk)) yield event;
          }
        }
      }
    }

    if (splitter !== undefined) {
      const { text, think } = splitter.flush();
      if (think !== "") {
        state.visibleOutput = true;
        reasoning += think;
        yield { type: streamThinkDelta, thinkDelta: think };
      }
      if (text !== "") {
        state.visibleOutput = true;
        textContent += text;
        yield { type: streamTextDelta, textDelta: text };
      }
    }

    for (let i = 0; i < toolCalls.length; i++) {
      const buf = toolCallBuffers.get(i);
      const tc = toolCalls[i];
      if (buf !== undefined) {
        if (tc.id === "") {
          tc.id = nextToolCallFallbackId("openai_toolcall");
        }
        tc.arguments = decodeArgumentsText(buf);
        state.visibleOutput = true;
        yield { type: streamToolCall, toolCall: tc };
      }
    }

    if (usage !== undefined) {
      state.visibleOutput = true;
      yield { type: streamUsage, usage };
    }
    yield { type: streamDone, stopReason };
    debugCompleteResponse({
      provider: "openai",
      api: "chat-completions",
      content: textContent,
      reasoning,
      toolCalls,
      stopReason,
      usage,
    });
  }

  convertMessages(
    params: ChatParams,
    forceAssistantReasoning: boolean,
  ): OpenAIMessage[] {
    const messages: OpenAIMessage[] = [];

    if (params.systemPrompt !== "") {
      messages.push({ role: "system", content: params.systemPrompt });
    }

    let inputMessages = normalizeToolResultSequence(params.messages);
    const maxImages = this.maxImagesPerRequestForRequest(params);
    if (maxImages > 0) {
      inputMessages = limitImageHistory(inputMessages, maxImages);
    }
    let pendingToolImages: OpenAIContentBlock[] = [];
    const flushToolImages = (): void => {
      if (pendingToolImages.length === 0) return;
      messages.push({ role: "user", content: pendingToolImages });
      pendingToolImages = [];
    };
    for (const msg of inputMessages) {
      if (msg.role !== "toolResult") flushToolImages();
      const om: OpenAIMessage = {
        role: msg.role,
        tool_call_id: msg.toolCallId,
        name: msg.toolName,
      };
      if (msg.role === "toolResult") {
        om.role = "tool";
        if ((msg.contents ?? []).length > 0) {
          // Rich tool result: send text as tool message, images as
          // supplementary user message.
          om.content = responseToolOutput(msg);
          messages.push(om);
          const imageBlocks: OpenAIContentBlock[] = [];
          for (const c of msg.contents ?? []) {
            if (c.type === "image" && c.image != null) {
              imageBlocks.push({
                type: "image_url",
                image_url: this.openAIImage(c.image),
              });
            }
          }
          if (imageBlocks.length > 0) pendingToolImages.push(...imageBlocks);
          continue;
        }
        om.content = msg.content ?? "";
      } else if ((msg.contents ?? []).length > 0) {
        const blocks: OpenAIContentBlock[] = [];
        let reasoningContent = "";
        for (const c of msg.contents ?? []) {
          switch (c.type) {
            case "text":
              blocks.push({ type: "text", text: c.text });
              break;
            case "image":
              if (c.image != null) {
                blocks.push({
                  type: "image_url",
                  image_url: this.openAIImage(c.image),
                });
              }
              break;
            case "thinking":
              if (!this.disableReasoning) reasoningContent += c.thinking ?? "";
              break;
            default:
              break;
          }
        }
        if (blocks.length === 1 && blocks[0].type === "text") {
          om.content = blocks[0].text;
        } else if (blocks.length > 0) {
          om.content = blocks;
        }
        if (reasoningContent !== "") om.reasoning_content = reasoningContent;
      } else {
        om.content = msg.content ?? "";
      }
      if (msg.role === "assistant") {
        for (const c of msg.contents ?? []) {
          if (c.type === "toolCall" && c.toolCall != null) {
            om.tool_calls = om.tool_calls ?? [];
            om.tool_calls.push({
              id: c.toolCall.id,
              type: "function",
              function: {
                name: c.toolCall.name,
                arguments: toolArgumentsString(
                  c.toolCall.arguments,
                  c.toolCall.invalidArguments,
                ),
              },
            });
          }
        }
      }
      if (
        msg.role === "assistant" && forceAssistantReasoning &&
        om.reasoning_content === undefined
      ) {
        om.reasoning_content = "";
      }
      messages.push(om);
    }
    flushToolImages();
    return messages;
  }

  /**
   * Resolves the configured image count. A zero value uses URL-based defaults
   * for the known Moark/Gitee gateways; other gateways are left uncapped unless
   * configured explicitly.
   */
  maxImagesPerRequestForRequest(_params?: ChatParams): number {
    if (this.maxImagesPerRequest !== 0) return this.maxImagesPerRequest;
    const baseURL = this.baseURL.toLowerCase();
    if (
      baseURL.includes("api.moark.com") || baseURL.includes("ai.gitee.com")
    ) {
      return 5;
    }
    return 0;
  }

  openAIImage(image: ImageContent | undefined): OpenAIImage | undefined {
    if (image === undefined || image === null) return undefined;
    const result: OpenAIImage = {
      url: `data:${image.mimeType};base64,${image.data}`,
    };
    if (this.supportsImageDetail()) {
      result.detail = normalizeImageDetail(image.detail ?? "");
    }
    return result;
  }

  supportsImageDetail(): boolean {
    try {
      const u = new URL(this.baseURL);
      const host = u.hostname.toLowerCase();
      return host === "api.openai.com" || host === "api.x.ai";
    } catch {
      return false;
    }
  }

  convertTools(tools: ToolDefinition[]): OpenAITool[] {
    const result: OpenAITool[] = [];
    for (const t of tools) {
      if (t.kind === "hosted") continue;
      result.push({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      });
    }
    return result;
  }

  thinkingFormatForModel(model: Model | undefined): string {
    if (this.thinkingFormat !== "") return this.thinkingFormat;
    if (
      model?.compat?.thinkingFormat !== undefined &&
      model.compat.thinkingFormat !== ""
    ) {
      return model.compat.thinkingFormat;
    }
    if (model !== undefined && isQwenModel(model.id)) return "qwen";
    if (model !== undefined && isDoubaoSeedModel(model.id)) {
      return "doubao-seed";
    }
    const lowerBaseURL = this.baseURL.toLowerCase();
    if (lowerBaseURL.includes("deepseek")) return "deepseek";
    if (lowerBaseURL.includes("xiaomimimo")) return "xiaomi";
    return "";
  }

  requiresReasoningContentOnAssistant(model: Model | undefined): boolean {
    if (model?.compat?.requiresReasoningContentOnAssistant === true) {
      return true;
    }
    if (model !== undefined) {
      const modelID = model.id.toLowerCase();
      if (
        modelID.includes("kimi") || modelID === "k3" ||
        modelID.startsWith("k3-")
      ) {
        return true;
      }
    }
    const lowerBaseURL = this.baseURL.toLowerCase();
    return lowerBaseURL.includes("deepseek") ||
      lowerBaseURL.includes("xiaomimimo") ||
      lowerBaseURL.includes("moonshot") || lowerBaseURL.includes("kimi.com");
  }
}

// ─── wire types (JSON tag keys) ──────────────────────────────────────────────

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  parallel_tool_calls?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream: boolean;
  stream_options?: { include_usage: boolean };
  reasoning_effort?: string;
  thinking?: { type: string };
  enable_thinking?: boolean;
  thinking_budget?: number;
}

export interface OpenAIMessage {
  role: string;
  content?: unknown;
  reasoning_content?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIContentBlock {
  type: string;
  text?: string;
  image_url?: OpenAIImage;
}

export interface OpenAIImage {
  url: string;
  detail?: string;
}

export interface OpenAITool {
  type: string;
  function: {
    name: string;
    description: string;
    parameters?: unknown;
  };
}

export interface OpenAIToolCall {
  id?: string;
  index?: number;
  type?: string;
  function?: { name?: string; arguments?: unknown };
}

export interface OpenAIResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: OpenAIChoice[];
  usage?: OpenAIUsageResponse | null;
}

export interface OpenAIChoice {
  index?: number;
  delta?: OpenAIDelta;
  finish_reason?: string | null;
}

export interface OpenAIDelta {
  role?: string;
  content?: string;
  reasoning_content?: string | null;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIUsageResponse {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number } | null;
}

/** Applies omitempty semantics for the chat request wire body. */
export function toWireChatRequest(
  req: OpenAIChatRequest,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model: req.model,
    messages: req.messages.map(toWireMessage),
    stream: req.stream,
  };
  if (req.tools !== undefined && req.tools.length > 0) out["tools"] = req.tools;
  if (req.parallel_tool_calls !== undefined) {
    out["parallel_tool_calls"] = req.parallel_tool_calls;
  }
  if (req.max_tokens !== undefined && req.max_tokens > 0) {
    out["max_tokens"] = req.max_tokens;
  }
  if (
    req.max_completion_tokens !== undefined && req.max_completion_tokens > 0
  ) {
    out["max_completion_tokens"] = req.max_completion_tokens;
  }
  if (req.temperature !== undefined) out["temperature"] = req.temperature;
  if (req.top_p !== undefined) out["top_p"] = req.top_p;
  if (req.stream_options !== undefined) {
    out["stream_options"] = req.stream_options;
  }
  if (req.reasoning_effort !== undefined && req.reasoning_effort !== "") {
    out["reasoning_effort"] = req.reasoning_effort;
  }
  if (req.thinking !== undefined) out["thinking"] = req.thinking;
  if (req.enable_thinking === true) out["enable_thinking"] = true;
  if (req.thinking_budget !== undefined && req.thinking_budget > 0) {
    out["thinking_budget"] = req.thinking_budget;
  }
  return out;
}

function toWireMessage(msg: OpenAIMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: msg.role };
  if (msg.content !== undefined) out["content"] = msg.content;
  if (msg.reasoning_content !== undefined) {
    out["reasoning_content"] = msg.reasoning_content;
  }
  if (msg.tool_calls !== undefined && msg.tool_calls.length > 0) {
    out["tool_calls"] = msg.tool_calls.map((tc) => ({
      id: tc.id,
      type: tc.type ?? "function",
      function: {
        name: tc.function?.name,
        arguments: tc.function?.arguments ?? "",
      },
    }));
  }
  if (msg.tool_call_id !== undefined && msg.tool_call_id !== "") {
    out["tool_call_id"] = msg.tool_call_id;
  }
  if (msg.name !== undefined && msg.name !== "") out["name"] = msg.name;
  return out;
}

export function chatParallelToolCalls(
  model: Model | undefined,
  tools: OpenAITool[],
  opts: ResponseOptions | undefined,
): boolean | undefined {
  if (tools.length === 0) return undefined;
  if (
    model?.compat?.supportsParallelToolCalls !== undefined &&
    model.compat.supportsParallelToolCalls === false
  ) {
    return undefined;
  }
  if (opts?.parallelTools !== undefined) return opts.parallelTools;
  return true;
}

export function mergeOpenAIUsage(
  dst: Usage | undefined,
  src: OpenAIUsageResponse | null | undefined,
): Usage | undefined {
  if (src === undefined || src === null) return dst;
  if (dst === undefined) {
    const usage = blankUsage();
    usage.input = src.prompt_tokens;
    usage.output = src.completion_tokens;
    usage.totalTokens = src.total_tokens;
    if (src.prompt_tokens_details != null) {
      usage.cacheRead = src.prompt_tokens_details.cached_tokens;
    }
    return usage;
  }
  if (src.prompt_tokens > 0 && dst.input === 0) dst.input = src.prompt_tokens;
  if (src.completion_tokens > 0 && dst.output === 0) {
    dst.output = src.completion_tokens;
  }
  if (src.total_tokens > 0 && dst.totalTokens === 0) {
    dst.totalTokens = src.total_tokens;
  }
  if (
    src.prompt_tokens_details != null &&
    src.prompt_tokens_details.cached_tokens > 0 && dst.cacheRead === 0
  ) {
    dst.cacheRead = src.prompt_tokens_details.cached_tokens;
  }
  return dst;
}

function blankUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function openAIReasoningEffort(level: ThinkingLevel): string {
  switch (level) {
    case thinkingMinimal:
    case thinkingLow:
      return "low";
    case thinkingMedium:
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

export function kimiReasoningEffort(level: ThinkingLevel): string {
  switch (level) {
    case thinkingMinimal:
    case thinkingLow:
      return "low";
    case thinkingMedium:
    case thinkingHigh:
      return "high";
    case thinkingXHigh:
    case thinkingMax:
      return "max";
    default:
      return "";
  }
}

export function deepseekReasoningEffort(level: ThinkingLevel): string {
  switch (level) {
    case thinkingXHigh:
    case thinkingMax:
      return "max";
    default:
      return "high";
  }
}

export function doubaoSeedReasoningEffort(level: ThinkingLevel): string {
  switch (level) {
    case thinkingMinimal:
      return "minimal";
    case thinkingLow:
      return "low";
    case thinkingMedium:
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

export function qwenThinkingBudget(level: ThinkingLevel): number {
  switch (level) {
    case thinkingMinimal:
    case thinkingLow:
      return 500;
    case thinkingMedium:
    case thinkingHigh:
      return 4096;
    case thinkingXHigh:
    case thinkingMax:
      return 10240;
    default:
      return 0;
  }
}

export function isQwenModel(modelID: string): boolean {
  const lower = modelID.toLowerCase();
  return lower.includes("qwen3.6") || lower.includes("qwen3.7") ||
    lower.includes("qwen3.8");
}

export function isDoubaoSeedModel(modelID: string): boolean {
  const lower = modelID.toLowerCase();
  return lower.includes("doubao-seed-2.1") ||
    lower.includes("doubao-seed-2-1") ||
    lower.includes("doubao-seed-evolving");
}

export function supportsReasoningEffort(model: Model | undefined): boolean {
  if (model?.compat?.supportsReasoningEffort !== undefined) {
    return model.compat.supportsReasoningEffort;
  }
  return true;
}

export function isMaxTokensUnsupportedResponse(body: string): boolean {
  const message = body.toLowerCase();
  return message.includes("max_tokens") &&
    (message.includes("max_completion_tokens") ||
      message.includes("not supported"));
}

export function maxTokensField(model: Model | undefined): string {
  if (model === undefined) return "";
  if (
    model.compat?.maxTokensField !== undefined &&
    model.compat.maxTokensField !== ""
  ) {
    return model.compat.maxTokensField;
  }
  const id = model.id.trim().toLowerCase();
  if (
    id.includes("gpt-5") || id.startsWith("o1") || id.startsWith("o3") ||
    id.startsWith("o4") || id.includes("/o1") || id.includes("/o3") ||
    id.includes("/o4")
  ) {
    return "max_completion_tokens";
  }
  return "";
}

/**
 * Repairs stale or partially persisted histories before they are sent to
 * OpenAI-compatible APIs. The API contract requires every assistant tool call to
 * be followed immediately by a tool response with the same ID.
 */
export function normalizeToolResultSequence(input: Message[]): Message[] {
  if (input.length === 0) return [];
  let hasAssistantToolCalls = false;
  for (const msg of input) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.contents ?? []) {
      if (
        block.type === "toolCall" && block.toolCall != null &&
        block.toolCall.id !== ""
      ) {
        hasAssistantToolCalls = true;
        break;
      }
    }
    if (hasAssistantToolCalls) break;
  }
  const out: Message[] = [];
  for (let i = 0; i < input.length; i++) {
    const msg = input[i];
    if (msg.role !== "assistant") {
      if (msg.role !== "toolResult" || !hasAssistantToolCalls) out.push(msg);
      continue;
    }
    out.push(msg);
    const calls = new Map<string, string>();
    for (const block of msg.contents ?? []) {
      if (
        block.type === "toolCall" && block.toolCall != null &&
        block.toolCall.id !== ""
      ) {
        calls.set(block.toolCall.id, block.toolCall.name);
      }
    }
    if (calls.size === 0) continue;
    const results = new Map<string, Message>();
    let j = i + 1;
    while (j < input.length && input[j].role === "toolResult") {
      const result = input[j];
      const key = result.toolCallId ?? "";
      if (calls.has(key)) {
        if (!results.has(key)) results.set(key, result);
      }
      j++;
    }
    for (const block of msg.contents ?? []) {
      if (
        block.type !== "toolCall" || block.toolCall == null ||
        block.toolCall.id === ""
      ) {
        continue;
      }
      const id = block.toolCall.id;
      const name = block.toolCall.name;
      const result = results.get(id);
      if (result !== undefined) {
        out.push(result);
      } else {
        out.push({
          role: "toolResult",
          content:
            "[tool result unavailable: the previous tool execution was interrupted]",
          toolCallId: id,
          toolName: name,
          isError: true,
          timestamp: new Date(),
        });
      }
    }
    i = j - 1;
  }
  return out;
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

// ─── constructors ────────────────────────────────────────────────────────────

/** Returns the default OpenAI model list. */
export function defaultModels(): Model[] {
  const pricing = (
    input: number,
    output: number,
    cacheRead: number,
    cacheWrite: number,
  ): ModelPricing => ({ input, output, cacheRead, cacheWrite });
  return [
    {
      id: "gpt-4o",
      name: "GPT-4o",
      provider: "openai",
      reasoning: false,
      input: ["text", "image"],
      cost: pricing(2.5, 10.0, 1.25, 2.5),
      contextWindow: 128000,
      maxTokens: 16384,
    },
    {
      id: "gpt-4o-mini",
      name: "GPT-4o Mini",
      provider: "openai",
      reasoning: false,
      input: ["text", "image"],
      cost: pricing(0.15, 0.6, 0.075, 0.15),
      contextWindow: 128000,
      maxTokens: 16384,
    },
    {
      id: "o1",
      name: "o1",
      provider: "openai",
      reasoning: true,
      input: ["text", "image"],
      cost: pricing(15.0, 60.0, 7.5, 15.0),
      contextWindow: 200000,
      maxTokens: 100000,
    },
    {
      id: "o3-mini",
      name: "o3-mini",
      provider: "openai",
      reasoning: true,
      input: ["text", "image"],
      cost: pricing(1.1, 4.4, 0.55, 1.1),
      contextWindow: 200000,
      maxTokens: 100000,
    },
  ];
}

/** Creates a new OpenAI provider with default models. */
export function newProvider(apiKey: string, baseURL: string): Provider {
  return newProviderWithModels(apiKey, baseURL, defaultModels());
}

/** Creates a new OpenAI provider with custom models. */
export function newProviderWithModels(
  apiKey: string,
  baseURL: string,
  models: Model[],
): Provider {
  try {
    return newProviderWithModelsAndProxy(apiKey, baseURL, "", models);
  } catch {
    const hc = newStreamHttpClientWithOptions({});
    return newProviderWithHTTPClient(apiKey, baseURL, models, hc);
  }
}

export function newProviderWithModelsAndProxy(
  apiKey: string,
  baseURL: string,
  proxyURL: string,
  models: Model[],
): Provider {
  return newProviderWithModelsAndOptions(apiKey, baseURL, models, {
    proxyUrl: proxyURL,
  });
}

export function newProviderWithModelsAndOptions(
  apiKey: string,
  baseURL: string,
  models: Model[],
  opts: HTTPClientOptions,
): Provider {
  const client = newStreamHttpClientWithOptions(opts);
  return newProviderWithHTTPClient(apiKey, baseURL, models, client);
}

export function newProviderWithHTTPClient(
  apiKey: string,
  baseURL: string,
  models: Model[],
  client: HttpClient,
): Provider {
  return new Provider("openai", apiKey, baseURL, models, client);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function decodeArgumentsText(raw: string): unknown {
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

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
