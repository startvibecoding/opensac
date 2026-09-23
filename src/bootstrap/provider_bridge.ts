// (bootstrap/provider_bridge.go).
//
// `providerAdapter` exposes an internal provider through the public
// `sdk/agent` Provider interface. It lives here (not in the public SDK) so the
// public SDK stays free of internal imports; external modules enable it by
// importing this package.

import {
  type Attachment as PublicAttachment,
  type ChatParams as PublicChatParams,
  type ContentBlock as PublicContentBlock,
  type HostedItem as PublicHostedItem,
  type Message as PublicMessage,
  type ModelInfo as PublicModelInfo,
  type Provider as PublicProvider,
  setResolveProviderFunc,
  streamDone,
  streamError,
  type StreamEvent as PublicStreamEvent,
  streamHostedItem,
  streamRetry,
  streamStart,
  streamTextDelta,
  streamThinkDelta,
  streamToolCall,
  streamUsage,
  type ToolCallBlock as PublicToolCallBlock,
  type ToolDefinition as PublicToolDefinition,
  type Usage as PublicUsage,
} from "../../sdk/agent/mod.ts";
import type { ProviderConfig } from "../config/mod.ts";
import {
  type Attachment as InternalAttachment,
  type ChatParams as InternalChatParams,
  type ContentBlock as InternalContentBlock,
  type Message as InternalMessage,
  type Model as InternalModel,
  type Provider as InternalProvider,
  resolveProvider,
  streamDone as internalStreamDone,
  streamError as internalStreamError,
  type StreamEvent as InternalStreamEvent,
  streamHostedItem as internalStreamHostedItem,
  streamRetry as internalStreamRetry,
  streamStart as internalStreamStart,
  streamTextDelta as internalStreamTextDelta,
  streamThinkDelta as internalStreamThinkDelta,
  streamThinkSignature as internalStreamThinkSignature,
  streamToolCall as internalStreamToolCall,
  streamUsage as internalStreamUsage,
  type ToolDefinition as InternalToolDefinition,
  uncachedInputTokens,
  type Usage as InternalUsage,
} from "../provider/mod.ts";

/**
 * Exposes an internal provider through the public `sdk/agent.Provider`
 * interface.
 */
export class ProviderAdapter implements PublicProvider {
  constructor(private readonly inner: InternalProvider) {}

  async *chat(params: PublicChatParams): AsyncIterable<PublicStreamEvent> {
    const internalParams: InternalChatParams = {
      messages: params.messages.map(messageToInternal),
      tools: params.tools?.map(toolDefinitionToInternal),
      systemPrompt: params.systemPrompt,
      thinkingLevel: params.thinkingLevel,
      maxTokens: params.maxTokens,
      modelId: params.modelId,
      abort: params.abort,
    };
    for await (const ev of this.inner.chat(internalParams)) {
      yield streamEventToPublic(ev);
    }
  }

  name(): string {
    return this.inner.name();
  }

  models(): PublicModelInfo[] {
    return this.inner.models().map(modelToPublic);
  }

  getModel(id: string): PublicModelInfo | undefined {
    const model = this.inner.getModel(id);
    return model === undefined ? undefined : modelToPublic(model);
  }
}

/** Maps an internal stream-event type to its public equivalent. */
export function streamEventTypeToPublic(t: number): number {
  switch (t) {
    case internalStreamStart:
      return streamStart;
    case internalStreamTextDelta:
      return streamTextDelta;
    case internalStreamThinkDelta:
    case internalStreamThinkSignature:
      return streamThinkDelta;
    case internalStreamToolCall:
      return streamToolCall;
    case internalStreamHostedItem:
      return streamHostedItem;
    case internalStreamUsage:
      return streamUsage;
    case internalStreamDone:
      return streamDone;
    case internalStreamError:
      return streamError;
    case internalStreamRetry:
      return streamRetry;
    default:
      return streamError;
  }
}

/** Returns the effective retry max-attempts for an internal stream event. */
export function streamRetryMaxAttempts(event: InternalStreamEvent): number {
  if ((event.retryMaxAttempts ?? 0) > 0) {
    return event.retryMaxAttempts!;
  }
  return event.retryMax ?? 0;
}

function streamEventToPublic(ev: InternalStreamEvent): PublicStreamEvent {
  const out: PublicStreamEvent = {
    type: streamEventTypeToPublic(ev.type),
  };
  if (ev.textDelta !== undefined) out.textDelta = ev.textDelta;
  if (ev.thinkDelta !== undefined) out.thinkDelta = ev.thinkDelta;
  if (ev.toolCall !== undefined) out.toolCall = toolCallToPublic(ev.toolCall);
  if (ev.hostedItem !== undefined) {
    out.hostedItem = hostedItemToPublic(ev.hostedItem);
  }
  if (ev.usage !== undefined) out.usage = usageToPublic(ev.usage);
  if (ev.stopReason !== undefined) out.stopReason = ev.stopReason;
  if (ev.error !== undefined) out.error = ev.error;
  if (ev.retryAttempt !== undefined) out.retryAttempt = ev.retryAttempt;
  out.retryMaxAttempts = streamRetryMaxAttempts(ev);
  if (ev.retryAfterMs !== undefined) out.retryAfterMs = ev.retryAfterMs;
  if (ev.attachments !== undefined) {
    out.attachments = ev.attachments.map(attachmentToPublic);
  }
  return out;
}

function hostedItemToPublic(
  item: InternalStreamEvent["hostedItem"],
): PublicHostedItem | undefined {
  if (item === undefined) {
    return undefined;
  }
  const out: PublicHostedItem = {
    id: item.id ?? "",
    type: item.type ?? "",
    status: item.status ?? "",
    outputIndex: item.outputIndex ?? 0,
  };
  if (item.metadata !== undefined) out.metadata = item.metadata;
  return out;
}

function modelToPublic(model: InternalModel): PublicModelInfo {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    reasoning: model.reasoning,
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function toolCallToPublic(
  tc: NonNullable<InternalStreamEvent["toolCall"]>,
): PublicToolCallBlock {
  return {
    id: tc.id,
    name: tc.name,
    kind: tc.kind,
    input: tc.input,
    arguments: encodeArguments(tc.arguments),
    invalidArguments: tc.invalidArguments,
    thoughtSignature: tc.thoughtSignature,
  };
}

function usageToPublic(u: InternalUsage): PublicUsage {
  return {
    inputTokens: uncachedInputTokens(u),
    outputTokens: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    totalTokens: u.totalTokens,
    cost: {
      input: u.cost.input,
      output: u.cost.output,
      cacheRead: u.cost.cacheRead,
      cacheWrite: u.cost.cacheWrite,
      total: u.cost.total,
    },
  };
}

function attachmentToPublic(item: InternalAttachment): PublicAttachment {
  return {
    kind: item.kind,
    name: item.name,
    url: item.url,
    mediaType: item.mediaType,
    metadata: item.metadata,
    providerRef: item.providerRef,
  };
}

function attachmentsFromPublic(
  items: PublicAttachment[] | undefined,
): InternalAttachment[] | undefined {
  if (items === undefined || items.length === 0) {
    return undefined;
  }
  return items.map((item) => ({
    kind: item.kind,
    name: item.name,
    url: item.url,
    mediaType: item.mediaType,
    metadata: item.metadata,
    providerRef: item.providerRef,
  }));
}

function messageToInternal(m: PublicMessage): InternalMessage {
  const out: InternalMessage = {
    role: m.role,
    timestamp: new Date(),
  };
  if (m.content !== undefined) out.content = m.content;
  if (m.contents !== undefined) {
    out.contents = m.contents.map(contentBlockToInternal);
  }
  if (m.attachments !== undefined) {
    out.attachments = attachmentsFromPublic(m.attachments);
  }
  if (m.isError !== undefined) out.isError = m.isError;
  if (m.systemInjected !== undefined) out.systemInjected = m.systemInjected;
  if (m.toolCallId !== undefined) out.toolCallId = m.toolCallId;
  if (m.toolName !== undefined) out.toolName = m.toolName;
  if (m.toolKind !== undefined) out.toolKind = m.toolKind;
  return out;
}

function contentBlockToInternal(cb: PublicContentBlock): InternalContentBlock {
  const out: InternalContentBlock = { type: cb.type };
  if (cb.text !== undefined) out.text = cb.text;
  if (cb.thinking !== undefined) out.thinking = cb.thinking;
  if (cb.signature !== undefined) out.signature = cb.signature;
  if (cb.image !== undefined) {
    out.image = {
      data: cb.image.data ?? "",
      mimeType: cb.image.mimeType ?? "",
      width: cb.image.width,
      height: cb.image.height,
      bytes: cb.image.bytes,
      originalWidth: cb.image.originalWidth,
      originalHeight: cb.image.originalHeight,
      originalBytes: cb.image.originalBytes,
      detail: cb.image.detail,
      scale: cb.image.scale,
      cropped: cb.image.cropped,
      cropX: cb.image.cropX,
      cropY: cb.image.cropY,
      cropWidth: cb.image.cropWidth,
      cropHeight: cb.image.cropHeight,
    };
  }
  if (cb.file !== undefined) {
    out.file = {
      id: cb.file.id,
      url: cb.file.url,
      data: cb.file.data,
      filename: cb.file.filename,
      mimeType: cb.file.mimeType,
      title: cb.file.title,
      description: cb.file.description,
      size: cb.file.size,
    };
  }
  if (cb.toolCall !== undefined) {
    out.toolCall = {
      id: cb.toolCall.id,
      name: cb.toolCall.name,
      kind: cb.toolCall.kind,
      input: cb.toolCall.input,
      arguments: decodeArguments(cb.toolCall.arguments),
      invalidArguments: cb.toolCall.invalidArguments,
      thoughtSignature: cb.toolCall.thoughtSignature,
    };
  }
  if (cb.cacheControl !== undefined) {
    out.cache_control = { type: cb.cacheControl.type };
  }
  return out;
}

function toolDefinitionToInternal(
  t: PublicToolDefinition,
): InternalToolDefinition {
  return {
    name: t.name,
    description: t.description,
    parameters: decodeArguments(t.parameters),
    kind: t.kind,
    format: decodeArguments(t.format),
    provider: t.provider,
    providerType: t.providerType,
    model: t.model,
  };
}

/** Decodes raw JSON bytes into a decoded value, mirroring json.RawMessage. */
function decodeArguments(bytes: Uint8Array | undefined): unknown {
  if (bytes === undefined || bytes.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/** Encodes a decoded JSON value back to UTF-8 bytes. */
function encodeArguments(value: unknown): Uint8Array | undefined {
  if (value === undefined) {
    return undefined;
  }
  return new TextEncoder().encode(JSON.stringify(value));
}

/**
 * Registers the provider resolution hook with the public SDK builder. Called
 * from the bootstrap module so `Builder.withProviderByName` resolves
 * openai/anthropic/google providers without importing internal packages from
 * user code.
 */
export function registerProviderBridge(): void {
  setResolveProviderFunc(
    (vendor, baseURL, api, apiKey) => {
      const cfg: ProviderConfig = {
        vendor,
        baseUrl: baseURL,
        api,
        apiKey,
        models: [],
      };
      const provider = resolveProvider(cfg);
      return new ProviderAdapter(provider);
    },
  );
}

// Mirror the Go init() in provider_bridge.go.
registerProviderBridge();
