//
// Wire structs keep the Go JSON tag keys (camelCase) as TypeScript property
// names. `Chat(ctx, params) <-chan StreamEvent` maps to
// `chat(params): AsyncIterable<StreamEvent>` and `context.Context`/the abort
// channel map to `params.abort` (AbortSignal).
import { runtime } from "../../platform/runtime.ts";
import { wrapError } from "../errors.ts";
import { BaseProvider } from "../base.ts";
import { debugCompleteResponse, debugJSON } from "../debug.ts";
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
  optBoolean,
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
import { nextToolCallFallbackId } from "../toolcall_id.ts";
import {
  type ChatParams,
  type Message,
  type Model,
  type ModelPricing,
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
  thinkingMinimal,
  thinkingOff,
  thinkingXHigh,
  type ToolCallBlock,
  type ToolDefinition,
  type Usage,
} from "../types.ts";
import { providerUserAgent } from "../../ua/ua.ts";

/** APIKind distinguishes the Gemini and Vertex API surfaces. */
export type APIKind = string;

export const apiKindGemini: APIKind = "gemini";
export const apiKindVertex: APIKind = "vertex";

// ─── wire types (JSON tag keys) ──────────────────────────────────────────────

interface GoogleRequest {
  systemInstruction?: GoogleContent;
  contents: GoogleContent[];
  tools?: GoogleTool[];
  generationConfig?: GoogleGenerationConf;
  cachedContent?: string;
}

interface GoogleGenerationConf {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  mediaResolution?: string;
  thinkingConfig?: GoogleThinkingConfig;
}

interface GoogleThinkingConfig {
  thinkingBudget?: number;
  includeThoughts?: boolean;
}

interface GoogleContent {
  role?: string;
  parts: GooglePart[];
}

interface GooglePart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: GoogleInlineData;
  functionCall?: GoogleFunctionCall;
  functionResponse?: GoogleFunctionResponse;
}

interface GoogleInlineData {
  mimeType: string;
  data: string;
}

interface GoogleFunctionCall {
  id?: string;
  name: string;
  args?: unknown;
}

interface GoogleFunctionResponse {
  id?: string;
  name: string;
  response: Record<string, unknown>;
}

interface GoogleTool {
  functionDeclarations?: GoogleFunctionDeclaration[];
}

interface GoogleFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: unknown;
}

interface GoogleResponse {
  candidates?: GoogleCandidate[];
  usageMetadata?: GoogleUsageMetadata;
  error?: GoogleResponseError;
}

interface GoogleCandidate {
  content: GoogleContent;
  finishReason?: string;
}

interface GoogleUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface GoogleResponseError {
  code?: number;
  message?: string;
  status?: string;
}

// ─── SSE decode guard ──────────────────────────────────────────────────────────
// The legacy unchecked JSON.parse cast asserted nothing: shape garbage crossed
// the boundary as typed lies (a candidate without `content` crashed the parts
// loop mid-stream). These decoders read every field the stream loop consumes
// through the src/util/json.ts readers, with Go `json.Unmarshal` semantics:
// required fields zero-fill (`content.parts` degrades to an empty list),
// optional fields read as `undefined`, malformed entries drop, and unknown
// part/candidate fields stay invisible to consumers (forward compatible).

/** Decodes one `data:` payload of the Gemini/Vertex event stream. */
export function decodeGoogleStreamChunk(
  data: string,
): GoogleResponse | undefined {
  const rec = parseJsonRecord(data);
  if (rec === undefined) return undefined;
  const chunk: GoogleResponse = {};
  const error = optRecord(rec, "error");
  if (error !== undefined) {
    const decoded: GoogleResponseError = {};
    const code = optNumber(error, "code");
    if (code !== undefined) decoded.code = code;
    const message = optString(error, "message");
    if (message !== undefined) decoded.message = message;
    const status = optString(error, "status");
    if (status !== undefined) decoded.status = status;
    chunk.error = decoded;
  }
  const usageMetadata = optRecord(rec, "usageMetadata");
  if (usageMetadata !== undefined) {
    chunk.usageMetadata = decodeGoogleUsageMetadata(usageMetadata);
  }
  const candidates = rec["candidates"];
  if (Array.isArray(candidates)) {
    const decoded: GoogleCandidate[] = [];
    for (const raw of candidates) {
      const candidate = asJsonRecord(raw);
      if (candidate === undefined) continue; // malformed entry: skip
      decoded.push(decodeGoogleCandidate(candidate));
    }
    chunk.candidates = decoded;
  }
  return chunk;
}

function decodeGoogleCandidate(rec: Record<string, unknown>): GoogleCandidate {
  const content = optRecord(rec, "content") ?? {};
  const parts: GooglePart[] = [];
  const partsRaw = content["parts"];
  if (Array.isArray(partsRaw)) {
    for (const raw of partsRaw) {
      const part = asJsonRecord(raw);
      if (part === undefined) continue; // malformed entry: skip
      parts.push(decodeGooglePart(part));
    }
  }
  const decodedContent: GoogleContent = { parts };
  const role = optString(content, "role");
  if (role !== undefined) decodedContent.role = role;
  const candidate: GoogleCandidate = { content: decodedContent };
  const finishReason = optString(rec, "finishReason");
  if (finishReason !== undefined) candidate.finishReason = finishReason;
  return candidate;
}

function decodeGooglePart(rec: Record<string, unknown>): GooglePart {
  const part: GooglePart = {};
  const text = optString(rec, "text");
  if (text !== undefined) part.text = text;
  const thought = optBoolean(rec, "thought");
  if (thought !== undefined) part.thought = thought;
  const thoughtSignature = optString(rec, "thoughtSignature");
  if (thoughtSignature !== undefined) part.thoughtSignature = thoughtSignature;
  const functionCall = optRecord(rec, "functionCall");
  if (functionCall !== undefined) {
    const call: GoogleFunctionCall = {
      name: optString(functionCall, "name") ?? "",
    };
    const id = optString(functionCall, "id");
    if (id !== undefined) call.id = id;
    if ("args" in functionCall) call.args = functionCall["args"];
    part.functionCall = call;
  }
  return part;
}

function decodeGoogleUsageMetadata(
  rec: Record<string, unknown>,
): GoogleUsageMetadata {
  const usage: GoogleUsageMetadata = {};
  const promptTokenCount = optNumber(rec, "promptTokenCount");
  if (promptTokenCount !== undefined) usage.promptTokenCount = promptTokenCount;
  const candidatesTokenCount = optNumber(rec, "candidatesTokenCount");
  if (candidatesTokenCount !== undefined) {
    usage.candidatesTokenCount = candidatesTokenCount;
  }
  const totalTokenCount = optNumber(rec, "totalTokenCount");
  if (totalTokenCount !== undefined) usage.totalTokenCount = totalTokenCount;
  const thoughtsTokenCount = optNumber(rec, "thoughtsTokenCount");
  if (thoughtsTokenCount !== undefined) {
    usage.thoughtsTokenCount = thoughtsTokenCount;
  }
  const cachedContentTokenCount = optNumber(rec, "cachedContentTokenCount");
  if (cachedContentTokenCount !== undefined) {
    usage.cachedContentTokenCount = cachedContentTokenCount;
  }
  return usage;
}

// ─── provider ────────────────────────────────────────────────────────────────

/** Provider implements the Google Gemini/Vertex generative APIs. */
export class Provider extends BaseProvider implements ProviderInterface {
  apiKey: string;
  private baseURL: string;
  private apiKind: APIKind;
  /** Exposed for tests, mirroring Go's replaceable `p.client`. */
  client: HttpClient;
  private retryConfig: RetryConfig | undefined;
  private cachedContent = "";
  private headers: Record<string, string> | undefined;

  constructor(
    name: string,
    kind: APIKind,
    apiKey: string,
    baseURL: string,
    defaultBaseURL: string,
    models: Model[],
    client: HttpClient,
  ) {
    super(name, models);
    if (baseURL === "") baseURL = defaultBaseURL;
    if (apiKey === "") {
      if (kind === apiKindGemini) {
        apiKey = runtime.env.get("GOOGLE_API_KEY") ?? "";
      } else if (kind === apiKindVertex) {
        apiKey = runtime.env.get("GOOGLE_CLOUD_API_KEY") ?? "";
        if (apiKey === "") {
          apiKey = runtime.env.get("GOOGLE_VERTEX_ACCESS_TOKEN") ?? "";
        }
      }
    }
    this.apiKey = apiKey;
    this.baseURL = baseURL.replace(/\/+$/, "");
    this.apiKind = kind;
    this.client = client;
  }

  /** Returns the protocol/API type. */
  api(): string {
    return this.apiKind === apiKindVertex ? "google-vertex" : "google-gemini";
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
   * Sets an explicit Google cached content resource to reuse. The value should
   * be a full cached content resource name, for example "cachedContents/abc123".
   * Empty disables explicit cached content reuse.
   */
  setCachedContent(name: string): void {
    this.cachedContent = name.trim();
  }

  /** Sends a chat request and returns a stream of events. */
  async *chat(params: ChatParams): AsyncGenerator<StreamEvent> {
    if (this.apiKey === "") {
      yield {
        type: streamError,
        error: new Error(`${this.name()} API key/token not set`),
      };
      return;
    }

    let modelID = params.modelId;
    if (modelID === "") {
      const models = this.models();
      modelID = models.length > 0 ? models[0].id : "gemini-2.5-flash";
    }

    const reqBody: GoogleRequest = {
      contents: this.convertMessages(params),
      tools: this.convertTools(params.tools ?? []),
      generationConfig: this.generationConfig(params, this.getModel(modelID)),
    };
    if (this.cachedContent !== "") {
      reqBody.cachedContent = this.cachedContent;
    }
    if (params.systemPrompt !== "") {
      reqBody.systemInstruction = {
        parts: [{ text: params.systemPrompt }],
      };
    }

    const body = JSON.stringify(reqBody);
    debugJSON("Google request JSON", body);

    let maxRetries = 0;
    let baseDelayMs = 2000;
    if (this.retryConfig !== undefined && this.retryConfig.enabled) {
      maxRetries = this.retryConfig.maxRetries;
      baseDelayMs = this.retryConfig.baseDelayMs;
    }

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

    const endpoint = this.streamEndpoint(modelID);
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
      this.applyRequestHeaders(headers);

      let resp: Response;
      try {
        resp = await this.client.fetch(endpoint, {
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
        yield { type: streamError, error: wrapError("send request", err) };
        return;
      }

      if (resp.status !== 200) {
        const bodyBytes = await resp.text();
        debugJSON("Google response JSON", bodyBytes);
        const err = new Error(`HTTP ${resp.status}: ${bodyBytes}`);
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
          error: new Error(`API error ${resp.status}: ${bodyBytes}`),
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

  private applyRequestHeaders(headers: Headers): void {
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "text/event-stream");
    headers.set("User-Agent", providerUserAgent());
    if (this.apiKind === apiKindVertex) {
      if (isGoogleOAuthToken(this.apiKey)) {
        headers.set("Authorization", `Bearer ${this.apiKey}`);
      } else {
        headers.set("x-goog-api-key", this.apiKey);
      }
    } else {
      headers.set("x-goog-api-key", this.apiKey);
    }
    applyHeaders(headers, this.headers);
  }

  /** Computes the streaming endpoint for a model. */
  streamEndpoint(modelID: string): string {
    let base = this.baseURL.replace(/\/+$/, "");
    if (this.apiKind === apiKindVertex && !isGoogleOAuthToken(this.apiKey)) {
      base = vertexAPIKeyBaseURL(base);
    }
    let model = modelID.startsWith("models/")
      ? modelID.slice("models/".length)
      : modelID;
    if (model.includes("/")) model = model.replace(/^\/+|\/+$/g, "");
    return `${base}/${model}:streamGenerateContent?alt=sse`;
  }

  private async *parseSSE(
    body: ReadableStream<Uint8Array> | null,
    params: ChatParams,
    state: { visibleOutput: boolean },
  ): AsyncGenerator<StreamEvent> {
    let textContent = "";
    let reasoning = "";
    const toolCalls: ToolCallBlock[] = [];
    const acc: { usage: Usage | undefined } = { usage: undefined };
    let stopReason = "";

    yield { type: streamStart };

    const reader = body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const pending: StreamEvent[] = [];
    let sawDone = false;

    const handleLine = (line: string): boolean => {
      if (!line.startsWith("data: ")) return true;
      const data = line.slice("data: ".length);
      if (data === "[DONE]") {
        sawDone = true;
        return false;
      }
      const chunk = decodeGoogleStreamChunk(data);
      if (chunk === undefined) return true;
      if (chunk.error !== undefined) {
        pending.push({
          type: streamError,
          error: new Error(
            `${chunk.error.status ?? ""}: ${chunk.error.message ?? ""}`,
          ),
          stopReason: "error",
        });
        return false;
      }
      if (chunk.usageMetadata !== undefined) {
        acc.usage = convertUsage(chunk.usageMetadata);
      }
      for (const candidate of chunk.candidates ?? []) {
        if (
          candidate.finishReason !== undefined &&
          candidate.finishReason !== ""
        ) {
          stopReason = candidate.finishReason.toLowerCase();
        }
        for (const part of candidate.content.parts) {
          if (part.text !== undefined && part.text !== "") {
            state.visibleOutput = true;
            if (part.thought === true) {
              reasoning += part.text;
              pending.push({ type: streamThinkDelta, thinkDelta: part.text });
            } else {
              textContent += part.text;
              pending.push({ type: streamTextDelta, textDelta: part.text });
            }
          }
          if (
            part.thoughtSignature !== undefined &&
            part.thoughtSignature !== "" &&
            part.functionCall === undefined
          ) {
            state.visibleOutput = true;
            pending.push({
              type: streamThinkSignature,
              thinkSignature: part.thoughtSignature,
            });
          }
          if (part.functionCall !== undefined) {
            state.visibleOutput = true;
            const args = part.functionCall.args ?? {};
            let callID = part.functionCall.id ?? "";
            if (callID === "") {
              callID = nextToolCallFallbackId("google_toolcall");
            }
            const tc: ToolCallBlock = {
              id: callID,
              name: part.functionCall.name,
              arguments: args,
            };
            if (part.thoughtSignature !== undefined) {
              tc.thoughtSignature = part.thoughtSignature;
            }
            toolCalls.push(tc);
            pending.push({ type: streamToolCall, toolCall: tc });
          }
        }
      }
      return true;
    };

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
            if (!cont) {
              if (sawDone) break;
              return;
            }
          }
          if (sawDone) break;
        }
        if (!sawDone && buffer.length > 0) {
          handleLine(buffer.replace(/\r$/, ""));
          while (pending.length > 0) yield pending.shift()!;
        }
      }

      if (acc.usage !== undefined) {
        state.visibleOutput = true;
        yield { type: streamUsage, usage: acc.usage };
      }
      yield { type: streamDone, stopReason };
    } finally {
      debugCompleteResponse({
        provider: this.name(),
        api: this.apiKind,
        content: textContent,
        reasoning,
        toolCalls,
        stopReason,
        usage: acc.usage,
      });
    }
  }

  private generationConfig(
    params: ChatParams,
    model: Model | undefined,
  ): GoogleGenerationConf {
    const cfg: GoogleGenerationConf = {
      temperature: params.temperature,
      topP: params.topP,
    };
    const mediaResolution = googleMediaResolution(params.messages);
    if (mediaResolution !== "") cfg.mediaResolution = mediaResolution;
    if (samplingParamsDisabled(model)) {
      delete cfg.temperature;
      delete cfg.topP;
    }
    if (params.maxTokens > 0) {
      cfg.maxOutputTokens = params.maxTokens;
    }
    if (params.thinkingLevel !== thinkingOff && model?.reasoning === true) {
      cfg.thinkingConfig = {
        thinkingBudget: googleThinkingBudget(params.thinkingLevel),
        includeThoughts: true,
      };
    }
    return cfg;
  }

  /** Converts provider-neutral messages to Google contents. */
  convertMessages(params: ChatParams): GoogleContent[] {
    const contents: GoogleContent[] = [];
    for (let i = 0; i < params.messages.length; i++) {
      const msg = params.messages[i];
      const content: GoogleContent = { role: googleRole(msg.role), parts: [] };
      if (msg.role === "toolResult") {
        // Google requires all functionResponse parts for the preceding model
        // functionCall parts to be in one user turn.
        const run = this.convertToolResultRun(params.messages, i);
        contents.push(run.content);
        i = run.next - 1;
        continue;
      }

      if (msg.contents === undefined || msg.contents.length === 0) {
        if ((msg.content ?? "") !== "") {
          content.parts.push({ text: msg.content ?? "" });
        }
        if (content.parts.length > 0) contents.push(content);
        continue;
      }

      for (const block of msg.contents) {
        switch (block.type) {
          case "text":
            if ((block.text ?? "") !== "") {
              content.parts.push({ text: block.text ?? "" });
            }
            break;
          case "thinking":
            if (
              (block.thinking ?? "") !== "" ||
              (block.signature ?? "") !== ""
            ) {
              content.parts.push({
                text: block.thinking ?? "",
                thought: true,
                thoughtSignature: block.signature ?? "",
              });
            }
            break;
          case "image":
            if (block.image !== undefined) {
              content.parts.push({
                inlineData: {
                  mimeType: block.image.mimeType,
                  data: block.image.data,
                },
              });
            }
            break;
          case "toolCall":
            if (block.toolCall !== undefined) {
              const part: GooglePart = {
                functionCall: {
                  id: googleWireCallID(block.toolCall.id) || undefined,
                  name: block.toolCall.name,
                },
              };
              if (block.toolCall.arguments !== undefined) {
                part.functionCall!.args = block.toolCall.arguments;
              }
              if ((block.toolCall.thoughtSignature ?? "") !== "") {
                part.thoughtSignature = block.toolCall.thoughtSignature;
              }
              content.parts.push(part);
            }
            break;
        }
      }
      if (content.parts.length > 0) contents.push(content);
    }
    return contents;
  }

  private convertToolResultRun(
    messages: Message[],
    start: number,
  ): { content: GoogleContent; next: number } {
    const content: GoogleContent = {
      role: googleRole("toolResult"),
      parts: [],
    };
    const imageParts: GooglePart[] = [];
    let i = start;
    while (i < messages.length && messages[i].role === "toolResult") {
      const msg = messages[i];
      const response: Record<string, unknown> = {
        content: googleToolResultText(msg),
      };
      if (msg.isError === true) response.error = true;
      const functionResponse: GoogleFunctionResponse = {
        name: msg.toolName ?? "",
        response,
      };
      const wireID = googleWireCallID(msg.toolCallId ?? "");
      if (wireID !== "") functionResponse.id = wireID;
      content.parts.push({ functionResponse });
      for (const block of msg.contents ?? []) {
        if (block.type === "image" && block.image !== undefined) {
          imageParts.push({
            inlineData: {
              mimeType: block.image.mimeType,
              data: block.image.data,
            },
          });
        }
      }
      i++;
    }
    // Keep all function responses first; attach tool images in the same user
    // turn afterward so no later function response is separated from the run.
    content.parts.push(...imageParts);
    return { content, next: i };
  }

  private convertTools(tools: ToolDefinition[]): GoogleTool[] | undefined {
    const declarations: GoogleFunctionDeclaration[] = [];
    for (const t of tools) {
      if (t.kind === "hosted") continue;
      const decl: GoogleFunctionDeclaration = {
        name: t.name,
        description: t.description,
      };
      if (t.parameters !== undefined) decl.parameters = t.parameters;
      declarations.push(decl);
    }
    if (declarations.length === 0) return undefined;
    return [{ functionDeclarations: declarations }];
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

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

export function isGoogleOAuthToken(token: string): boolean {
  const t = token.trim();
  return t.startsWith("ya29.") || t.startsWith("gya29.");
}

export function vertexAPIKeyBaseURL(base: string): string {
  if (base === "" || base.includes("/projects/")) {
    return "https://aiplatform.googleapis.com/v1/publishers/google/models";
  }
  if (base.endsWith("/publishers/google/models")) {
    return base;
  }
  if (base.endsWith("/publishers/google")) {
    return `${base}/models`;
  }
  return base;
}

export function googleMediaResolution(messages: Message[]): string {
  let hasLow = false;
  for (const msg of messages) {
    for (const block of msg.contents ?? []) {
      if (block.type !== "image" || block.image === undefined) continue;
      switch ((block.image.detail ?? "").trim().toLowerCase()) {
        case "detail":
        case "high":
        case "raw":
        case "original":
          return "MEDIA_RESOLUTION_HIGH";
        case "fast":
        case "low":
          hasLow = true;
          break;
      }
    }
  }
  if (hasLow) return "MEDIA_RESOLUTION_LOW";
  return "";
}

export function googleThinkingBudget(level: ThinkingLevel): number {
  switch (level) {
    case thinkingMinimal:
      return 128;
    case thinkingLow:
      return 1024;
    case thinkingHigh:
      return 8192;
    case thinkingXHigh:
    case thinkingMax:
      return 24576;
    default:
      return 4096;
  }
}

/**
 * Returns only a provider-issued ID. Older Gemini/Vertex responses do not
 * include IDs, so locally generated execution IDs must not be sent back as if
 * they were model IDs.
 */
export function googleWireCallID(id: string): string {
  const trimmed = id.trim();
  if (
    trimmed.startsWith("google_toolcall_") ||
    trimmed.startsWith("agent_toolcall_")
  ) {
    return "";
  }
  return trimmed;
}

export function googleRole(role: string): string {
  switch (role) {
    case "assistant":
      return "model";
    case "toolResult":
      return "user";
    default:
      return "user";
  }
}

function googleToolResultText(msg: Message): string {
  if (
    (msg.content ?? "") !== "" ||
    msg.contents === undefined ||
    msg.contents.length === 0
  ) {
    return msg.content ?? "";
  }
  const parts: string[] = [];
  for (const block of msg.contents) {
    if (block.type === "text" && (block.text ?? "") !== "") {
      parts.push(block.text ?? "");
    }
  }
  return parts.join("\n");
}

export function convertUsage(
  u: GoogleUsageMetadata | undefined,
): Usage | undefined {
  if (u === undefined) return undefined;
  return {
    input: u.promptTokenCount ?? 0,
    output: u.candidatesTokenCount ?? 0,
    reasoning: u.thoughtsTokenCount ?? 0,
    cacheRead: u.cachedContentTokenCount ?? 0,
    cacheWrite: 0,
    totalTokens: u.totalTokenCount ?? 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

// ─── constructors ────────────────────────────────────────────────────────────

/** Returns the default Google model list for a provider name. */
export function defaultModels(providerName: string): Model[] {
  const cost: ModelPricing = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  return [
    {
      id: "gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      provider: providerName,
      reasoning: true,
      input: ["text", "image"],
      cost,
      contextWindow: 1000000,
      maxTokens: 65536,
    },
    {
      id: "gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      provider: providerName,
      reasoning: true,
      input: ["text", "image"],
      cost,
      contextWindow: 1000000,
      maxTokens: 65536,
    },
  ];
}

const geminiDefaultBaseURL =
  "https://generativelanguage.googleapis.com/v1beta/models";
const vertexDefaultBaseURL =
  "https://aiplatform.googleapis.com/v1/publishers/google/models";

/**
 * Creates a Google Gemini provider. Without explicit transport options a
 * failed client construction falls back to a plain streaming client; explicit
 * options keep the original failure.
 */
export function createGeminiProvider(
  apiKey: string,
  baseURL: string,
  models: Model[] = defaultModels("google-gemini"),
  opts: HTTPClientOptions | undefined = undefined,
): Provider {
  try {
    return createGoogleProvider(
      "google-gemini",
      apiKindGemini,
      apiKey,
      baseURL,
      geminiDefaultBaseURL,
      models,
      opts ?? {},
    );
  } catch (err) {
    if (opts !== undefined) throw err;
    return createGoogleProviderWithHTTPClient(
      "google-gemini",
      apiKindGemini,
      apiKey,
      baseURL,
      geminiDefaultBaseURL,
      models,
      createStreamHttpClient({}),
    );
  }
}

/**
 * Creates a Google Vertex provider. Without explicit transport options a
 * failed client construction falls back to a plain streaming client; explicit
 * options keep the original failure.
 */
export function createVertexProvider(
  apiKey: string,
  baseURL: string,
  models: Model[] = defaultModels("google-vertex"),
  opts: HTTPClientOptions | undefined = undefined,
): Provider {
  try {
    return createGoogleProvider(
      "google-vertex",
      apiKindVertex,
      apiKey,
      baseURL,
      vertexDefaultBaseURL,
      models,
      opts ?? {},
    );
  } catch (err) {
    if (opts !== undefined) throw err;
    return createGoogleProviderWithHTTPClient(
      "google-vertex",
      apiKindVertex,
      apiKey,
      baseURL,
      vertexDefaultBaseURL,
      models,
      createStreamHttpClient({}),
    );
  }
}

function createGoogleProvider(
  name: string,
  kind: APIKind,
  apiKey: string,
  baseURL: string,
  defaultBaseURL: string,
  models: Model[],
  opts: HTTPClientOptions,
): Provider {
  let client: HttpClient;
  try {
    client = createStreamHttpClient(opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`configure http proxy: ${msg}`);
  }
  return createGoogleProviderWithHTTPClient(
    name,
    kind,
    apiKey,
    baseURL,
    defaultBaseURL,
    models,
    client,
  );
}

/**
 * Creates a provider bound to the given HTTP client. Mirrors the unexported Go
 * helper and serves as the TS test seam.
 */
export function createGoogleProviderWithHTTPClient(
  name: string,
  kind: APIKind,
  apiKey: string,
  baseURL: string,
  defaultBaseURL: string,
  models: Model[],
  client: HttpClient,
): Provider {
  return new Provider(
    name,
    kind,
    apiKey,
    baseURL,
    defaultBaseURL,
    models,
    client,
  );
}
