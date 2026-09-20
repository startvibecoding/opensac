// Ported from internal/agent/bridge.go.
//
// This module maps the front-end-neutral internal agent/provider value types to
// the public `sdk/agent` types (and back). The Go source keeps a parallel set
// of converters in the top-level `bootstrap` package; this port preserves that
// split because `src/agent` may not depend on `src/bootstrap`.
//
// `AgentAdapter` wraps the internal `Agent` so it satisfies the public
// `sdk/agent.Agent`/`QuestionHandler` interface; Go's `<-chan agentpkg.Event`
// maps to wrapping the internal `AsyncIterable<Event>` with `eventToPublic`.

import {
  type Agent as PublicAgent,
  type AgentContext as PublicAgentContext,
  type AgentID as PublicAgentID,
  type Attachment as PublicAttachment,
  type ChatParams as PublicChatParams,
  type ContentBlock as PublicContentBlock,
  type ContextUsage as PublicContextUsage,
  type Event as PublicEvent,
  eventAgentEnd as publicEventAgentEnd,
  eventAgentStart as publicEventAgentStart,
  eventBudgetPressure as publicEventBudgetPressure,
  eventCompactionEnd as publicEventCompactionEnd,
  eventCompactionStart as publicEventCompactionStart,
  eventContextPressure as publicEventContextPressure,
  eventDone as publicEventDone,
  eventError as publicEventError,
  eventHostedItem as publicEventHostedItem,
  eventMessageEnd as publicEventMessageEnd,
  eventMessageStart as publicEventMessageStart,
  eventMessageUpdate as publicEventMessageUpdate,
  eventPlanUpdate as publicEventPlanUpdate,
  eventQuestionRequest as publicEventQuestionRequest,
  eventQuestionResponse as publicEventQuestionResponse,
  eventRetry as publicEventRetry,
  eventRunFinished as publicEventRunFinished,
  eventStatus as publicEventStatus,
  eventTextDelta as publicEventTextDelta,
  eventThinkDelta as publicEventThinkDelta,
  eventToolApprovalRequest as publicEventToolApprovalRequest,
  eventToolApprovalResponse as publicEventToolApprovalResponse,
  eventToolCall as publicEventToolCall,
  eventToolExecutionEnd as publicEventToolExecutionEnd,
  eventToolExecutionStart as publicEventToolExecutionStart,
  eventToolExecutionUpdate as publicEventToolExecutionUpdate,
  eventToolResult as publicEventToolResult,
  eventTurnEnd as publicEventTurnEnd,
  eventTurnStart as publicEventTurnStart,
  type EventType as PublicEventType,
  eventUsage as publicEventUsage,
  type FileDiff as PublicFileDiff,
  type HostedItem as PublicHostedItem,
  type Message as PublicMessage,
  type ModelCompat as PublicModelCompat,
  type ModelInfo as PublicModelInfo,
  newCostBreakdown,
  type PlanStep as PublicPlanStep,
  type Provider as PublicProvider,
  type QuestionHandler as PublicQuestionHandler,
  streamDone as publicStreamDone,
  streamError as publicStreamError,
  type StreamEvent as PublicStreamEvent,
  type StreamEventType as PublicStreamEventType,
  streamHostedItem as publicStreamHostedItem,
  streamRetry as publicStreamRetry,
  streamStart as publicStreamStart,
  streamTextDelta as publicStreamTextDelta,
  streamThinkDelta as publicStreamThinkDelta,
  streamToolCall as publicStreamToolCall,
  streamUsage as publicStreamUsage,
  type TaskPlan as PublicTaskPlan,
  type TaskStatus as PublicTaskStatus,
  type ToolCallBlock as PublicToolCallBlock,
  type ToolDefinition as PublicToolDefinition,
  type Usage as PublicUsage,
} from "../../sdk/agent/mod.ts";
import type { ContextUsage } from "../context/mod.ts";
import {
  BaseProvider,
  type ChatParams as InternalChatParams,
  type ContentBlock as InternalContentBlock,
  type HostedItem as InternalHostedItem,
  type Message as InternalMessage,
  type Model as InternalModel,
  type ModelCompat as InternalModelCompat,
  type Provider as InternalProvider,
  streamDone as internalStreamDone,
  streamError as internalStreamError,
  type StreamEvent as InternalStreamEvent,
  type StreamEventType as InternalStreamEventType,
  streamHostedItem as internalStreamHostedItem,
  streamRetry as internalStreamRetry,
  streamStart as internalStreamStart,
  streamTextDelta as internalStreamTextDelta,
  streamThinkDelta as internalStreamThinkDelta,
  streamToolCall as internalStreamToolCall,
  streamUsage as internalStreamUsage,
  type ToolCallBlock as InternalToolCallBlock,
  type ToolDefinition as InternalToolDefinition,
  type Usage as InternalUsage,
} from "../provider/mod.ts";
import type { FileDiff, TaskPlan } from "../tools/mod.ts";
import type { Agent } from "./agent.ts";
import {
  type Event,
  EventAgentEnd,
  EventAgentStart,
  EventBudgetPressure,
  EventCompactionEnd,
  EventCompactionStart,
  EventContextPressure,
  EventDone,
  EventError,
  EventHostedItem,
  EventMessageEnd,
  EventMessageStart,
  EventMessageUpdate,
  EventPlanUpdate,
  EventQuestionRequest,
  EventQuestionResponse,
  EventRetry,
  EventRunFinished,
  EventStatus,
  EventTextDelta,
  EventThinkDelta,
  EventToolApprovalRequest,
  EventToolApprovalResponse,
  EventToolCall,
  EventToolExecutionEnd,
  EventToolExecutionStart,
  EventToolExecutionUpdate,
  EventToolResult,
  EventTurnEnd,
  EventTurnStart,
  type EventType,
  EventUsage,
  type ToolImage,
} from "./events.ts";

// --- Type conversion helpers ---

/** Converts an internal provider.Message to a public agent.Message. */
export function messageToPublic(m: InternalMessage): PublicMessage {
  const msg: PublicMessage = {
    role: m.role,
    content: m.content,
    isError: m.isError,
    systemInjected: m.systemInjected,
    toolCallId: m.toolCallId,
    toolName: m.toolName,
    toolKind: m.toolKind,
    attachments: attachmentsToPublic(m.attachments),
  };
  if (m.usage !== undefined) {
    msg.usage = usageToPublic(m.usage);
  }
  if (m.contents !== undefined) {
    msg.contents = m.contents.map(contentBlockToPublic);
  }
  return msg;
}

/** Converts a public agent.Message to an internal provider.Message. */
export function messageFromPublic(m: PublicMessage): InternalMessage {
  const msg: InternalMessage = {
    role: m.role,
    content: m.content,
    isError: m.isError,
    systemInjected: m.systemInjected,
    toolCallId: m.toolCallId,
    toolName: m.toolName,
    toolKind: m.toolKind,
    attachments: attachmentsFromPublic(m.attachments),
    timestamp: new Date(),
  };
  if (m.usage !== undefined) {
    msg.usage = {
      input: m.usage.inputTokens,
      output: m.usage.outputTokens,
      cacheRead: m.usage.cacheRead,
      cacheWrite: m.usage.cacheWrite,
      totalTokens: m.usage.totalTokens,
      cost: { ...m.usage.cost },
    };
  }
  if (m.contents !== undefined) {
    msg.contents = m.contents.map(contentBlockFromPublic);
  }
  return msg;
}

/** Converts an internal provider.ContentBlock to a public agent.ContentBlock. */
export function contentBlockToPublic(
  cb: InternalContentBlock,
): PublicContentBlock {
  const pub: PublicContentBlock = {
    type: cb.type,
    text: cb.text,
    thinking: cb.thinking,
    signature: cb.signature,
  };
  if (cb.toolCall !== undefined) {
    pub.toolCall = toolCallBlockToPublic(cb.toolCall);
  }
  if (cb.image !== undefined) {
    pub.image = {
      mimeType: cb.image.mimeType,
      data: cb.image.data,
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
    pub.file = {
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
  if (cb.cache_control !== undefined) {
    pub.cacheControl = { type: cb.cache_control.type };
  }
  return pub;
}

/** Converts a public agent.ContentBlock to an internal provider.ContentBlock. */
export function contentBlockFromPublic(
  cb: PublicContentBlock,
): InternalContentBlock {
  const internal: InternalContentBlock = {
    type: cb.type,
    text: cb.text,
    thinking: cb.thinking,
    signature: cb.signature,
  };
  if (cb.toolCall !== undefined) {
    internal.toolCall = {
      id: cb.toolCall.id,
      name: cb.toolCall.name,
      kind: cb.toolCall.kind,
      input: cb.toolCall.input,
      arguments: decodeArguments(cb.toolCall.arguments),
      invalidArguments: cb.toolCall.invalidArguments,
      thoughtSignature: cb.toolCall.thoughtSignature,
    };
  }
  if (cb.image !== undefined) {
    internal.image = {
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
    internal.file = {
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
  if (cb.cacheControl !== undefined) {
    internal.cache_control = { type: cb.cacheControl.type };
  }
  return internal;
}

/** Converts a slice of internal messages to public messages. */
export function messagesToPublic(
  msgs: InternalMessage[] | undefined,
): PublicMessage[] | undefined {
  if (msgs === undefined) {
    return undefined;
  }
  return msgs.map(messageToPublic);
}

/** Converts a slice of public messages to internal messages. */
export function messagesFromPublic(
  msgs: PublicMessage[] | undefined,
): InternalMessage[] | undefined {
  if (msgs === undefined) {
    return undefined;
  }
  return msgs.map(messageFromPublic);
}

/** Converts an internal context-usage snapshot to the public shape. */
export function contextUsageToPublic(
  u: ContextUsage | undefined,
): PublicContextUsage | undefined {
  if (u === undefined) {
    return undefined;
  }
  return {
    tokens: u.tokens,
    totalTokens: u.totalTokens,
    input: u.input,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    contextWindow: u.contextWindow,
    percent: u.percent,
  };
}

/** Converts an internal Event to a public agent.Event. */
export function eventToPublic(e: Event): PublicEvent {
  const out: PublicEvent = {
    agentId: e.agentId ?? "",
    type: eventTypeToPublic(e.type),
    memberId: e.memberId,
    expertId: e.expertId,
    memberDisplayName: e.memberDisplayName,
    memberEmoji: e.memberEmoji,
    memberRole: e.memberRole,
    messages: messagesToPublic(e.messages),
    textDelta: e.textDelta,
    thinkDelta: e.thinkDelta,
    hostedItem: hostedItemToPublic(e.hostedItem),
    toolCall: e.toolCall === undefined
      ? undefined
      : toolCallBlockToPublic(e.toolCall),
    toolCallId: e.toolCallId,
    toolName: e.toolName,
    toolArgs: e.toolArgs,
    toolResult: e.toolResult,
    toolDiff: fileDiffToPublic(e.toolDiff),
    toolError: e.toolError,
    toolExecutionState: e.toolExecutionState,
    toolImages: toolImagesToPublic(e.toolImages),
    partialResult: e.partialResult,
    plan: taskPlanToPublic(e.plan),
    statusMessage: e.statusMessage,
    responseStateFailureClass: e.responseStateFailureClass,
    retryStatus: e.retryStatus,
    retryAttempt: e.retryAttempt,
    retryMaxAttempts: e.retryMaxAttempts,
    retryAfterMs: e.retryAfterMs,
    retryMaxTokens: e.retryMaxTokens,
    retryReason: e.retryReason,
    retryContinue: e.retryContinue,
    done: e.done,
    stopReason: e.stopReason,
    error: e.error,
    status: e.status as PublicTaskStatus | undefined,
    approvalId: e.approvalId,
    approvalTool: e.approvalTool,
    approvalArgs: e.approvalArgs,
    approvalResult: e.approvalResult,
    questionId: e.questionId,
    questionText: e.questionText,
    questionOptions: e.questionOptions,
    questionContext: e.questionContext,
    questionAnswer: e.questionAnswer,
    usage: usageToPublic(e.usage),
    attachments: attachmentsToPublic(e.attachments),
    contextUsage: contextUsageToPublic(e.contextUsage),
  };
  if (e.turnMessage !== undefined) {
    out.turnMessage = messageToPublic(e.turnMessage);
  }
  if (e.turnToolResults !== undefined) {
    out.turnToolResults = e.turnToolResults.map(messageToPublic);
  }
  if (e.message !== undefined) {
    out.message = messageToPublic(e.message);
  }
  return out;
}

/**
 * Converts internal tool result images to the public SDK type. The base64
 * payload is passed through unchanged.
 */
export function toolImagesToPublic(
  images: ToolImage[] | undefined,
): PublicEvent["toolImages"] {
  if (images === undefined || images.length === 0) {
    return undefined;
  }
  return images.map((image) => ({
    mimeType: image.mimeType,
    data: image.data,
  }));
}

/**
 * Converts the internal event enum to the public enum. The enums intentionally
 * retain their historical ordering, so this must not be a numeric cast:
 * EventRetry was added in different positions. The Go source omits an explicit
 * `StreamThinkSignature` case and therefore falls through to the `EventStatus`
 * default; that behavior is preserved here for 1:1 fidelity.
 */
export function eventTypeToPublic(t: EventType): PublicEventType {
  switch (t) {
    case EventAgentStart:
      return publicEventAgentStart;
    case EventAgentEnd:
      return publicEventAgentEnd;
    case EventTurnStart:
      return publicEventTurnStart;
    case EventTurnEnd:
      return publicEventTurnEnd;
    case EventMessageStart:
      return publicEventMessageStart;
    case EventMessageUpdate:
      return publicEventMessageUpdate;
    case EventMessageEnd:
      return publicEventMessageEnd;
    case EventTextDelta:
      return publicEventTextDelta;
    case EventThinkDelta:
      return publicEventThinkDelta;
    case EventHostedItem:
      return publicEventHostedItem;
    case EventToolCall:
      return publicEventToolCall;
    case EventToolExecutionStart:
      return publicEventToolExecutionStart;
    case EventToolExecutionUpdate:
      return publicEventToolExecutionUpdate;
    case EventToolExecutionEnd:
      return publicEventToolExecutionEnd;
    case EventToolResult:
      return publicEventToolResult;
    case EventToolApprovalRequest:
      return publicEventToolApprovalRequest;
    case EventToolApprovalResponse:
      return publicEventToolApprovalResponse;
    case EventQuestionRequest:
      return publicEventQuestionRequest;
    case EventQuestionResponse:
      return publicEventQuestionResponse;
    case EventPlanUpdate:
      return publicEventPlanUpdate;
    case EventStatus:
      return publicEventStatus;
    case EventDone:
      return publicEventDone;
    case EventError:
      return publicEventError;
    case EventUsage:
      return publicEventUsage;
    case EventRetry:
      return publicEventRetry;
    case EventCompactionStart:
      return publicEventCompactionStart;
    case EventCompactionEnd:
      return publicEventCompactionEnd;
    case EventContextPressure:
      return publicEventContextPressure;
    case EventBudgetPressure:
      return publicEventBudgetPressure;
    case EventRunFinished:
      return publicEventRunFinished;
    default:
      return publicEventStatus;
  }
}

function hostedItemToPublic(
  item: InternalHostedItem | undefined,
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
  if (item.metadata !== undefined) {
    out.metadata = item.metadata;
  }
  return out;
}

/** Converts internal attachments to the public SDK type. */
export function attachmentsToPublic(
  items: InternalMessage["attachments"],
): PublicAttachment[] | undefined {
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

/** Converts public attachments to the internal provider type. */
export function attachmentsFromPublic(
  items: PublicAttachment[] | undefined,
): InternalMessage["attachments"] {
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

/** Converts an internal provider.ToolCallBlock to the public type. */
export function toolCallBlockToPublic(
  tc: InternalToolCallBlock,
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

/** Converts an internal tools.FileDiff to the public agent.FileDiff. */
export function fileDiffToPublic(
  d: FileDiff | undefined,
): PublicFileDiff | undefined {
  if (d === undefined) {
    return undefined;
  }
  return {
    path: d.path,
    added: d.added,
    deleted: d.deleted,
    addedLines: d.addedLines,
    deletedLines: d.deletedLines,
    unified: d.unified,
    oldText: d.oldText ?? undefined,
    newText: d.newText,
    truncated: d.truncated,
  };
}

/** Converts an internal tools.TaskPlan to the public agent.TaskPlan. */
export function taskPlanToPublic(
  p: TaskPlan | undefined,
): PublicTaskPlan | undefined {
  if (p === undefined) {
    return undefined;
  }
  const steps: PublicPlanStep[] = p.steps.map((s) => ({
    title: s.title,
    status: s.status,
  }));
  return { title: p.title, steps, note: p.note };
}

/** Converts an internal provider.Usage to the public agent.Usage. */
export function usageToPublic(
  u: InternalUsage | undefined,
): PublicUsage | undefined {
  if (u === undefined) {
    return undefined;
  }
  return {
    inputTokens: u.input,
    outputTokens: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    totalTokens: u.totalTokens,
    cost: newCostBreakdown(),
  };
}

/** Converts public ChatParams to internal ChatParams. */
export function chatParamsFromPublic(p: PublicChatParams): InternalChatParams {
  return {
    messages: p.messages.map(messageFromPublic),
    tools: p.tools?.map((t) => toolDefinitionFromPublic(t)),
    systemPrompt: p.systemPrompt,
    thinkingLevel: p.thinkingLevel,
    maxTokens: p.maxTokens,
    modelId: p.modelId,
    abort: p.abort,
  };
}

/** Converts an internal StreamEvent to the public type. */
export function streamEventToPublic(e: InternalStreamEvent): PublicStreamEvent {
  const ev: PublicStreamEvent = {
    type: streamEventTypeToPublic(e.type),
    textDelta: e.textDelta,
    thinkDelta: e.thinkDelta,
    stopReason: e.stopReason,
    error: e.error,
    retryAttempt: e.retryAttempt,
    retryMaxAttempts: streamRetryMaxAttempts(e),
    retryAfterMs: e.retryAfterMs,
    attachments: attachmentsToPublic(e.attachments),
  };
  if (e.hostedItem !== undefined) {
    ev.hostedItem = hostedItemToPublic(e.hostedItem);
  }
  if (e.toolCall !== undefined) {
    ev.toolCall = toolCallBlockToPublic(e.toolCall);
  }
  if (e.usage !== undefined) {
    ev.usage = usageToPublic(e.usage);
  }
  return ev;
}

/** Returns the effective retry max-attempts for an internal stream event. */
export function streamRetryMaxAttempts(e: InternalStreamEvent): number {
  if ((e.retryMaxAttempts ?? 0) > 0) {
    return e.retryMaxAttempts!;
  }
  return e.retryMax ?? 0;
}

/** Converts an internal *provider.Model to a public agent.ModelInfo. */
export function modelToPublic(m: InternalModel | undefined): PublicModelInfo {
  if (m === undefined) {
    return {
      id: "",
      name: "",
      provider: "",
      reasoning: false,
      input: [],
      contextWindow: 0,
      maxTokens: 0,
    };
  }
  const info: PublicModelInfo = {
    id: m.id,
    name: m.name,
    provider: m.provider,
    reasoning: m.reasoning,
    input: [...m.input],
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  };
  if (m.compat !== undefined) {
    info.compat = modelCompatToPublic(m.compat);
  }
  return info;
}

function modelCompatToPublic(c: InternalModelCompat): PublicModelCompat {
  return {
    thinkingFormat: c.thinkingFormat,
    requiresReasoningContentOnAssistant: c.requiresReasoningContentOnAssistant,
    forceAdaptiveThinking: c.forceAdaptiveThinking,
    supportsDeveloperRole: c.supportsDeveloperRole,
    supportsStore: c.supportsStore,
    supportsReasoningEffort: c.supportsReasoningEffort,
    supportsStrictMode: c.supportsStrictMode,
    maxTokensField: c.maxTokensField,
    disableSamplingParams: c.disableSamplingParams,
    supportsCacheControlOnTools: c.supportsCacheControlOnTools,
    supportsLongCacheRetention: c.supportsLongCacheRetention,
    sendSessionAffinityHeaders: c.sendSessionAffinityHeaders,
    supportsEagerToolInputStreaming: c.supportsEagerToolInputStreaming,
  };
}

/**
 * Wraps an internal `Agent` to satisfy the public `sdk/agent.Provider`
 * interface. This enables the public Builder to supply an external Provider
 * implementation through the shared runtime.
 */
export class PublicProviderAdapter implements PublicProvider {
  constructor(private readonly inner: InternalProvider) {}

  name(): string {
    return this.inner.name();
  }

  models(): PublicModelInfo[] {
    return this.inner.models().map((m) => modelToPublic(m));
  }

  getModel(id: string): PublicModelInfo | undefined {
    const m = this.inner.getModel(id);
    return m === undefined ? undefined : modelToPublic(m);
  }

  async *chat(params: PublicChatParams): AsyncIterable<PublicStreamEvent> {
    const internalParams = chatParamsFromPublic(params);
    for await (const e of this.inner.chat(internalParams)) {
      yield streamEventToPublic(e);
    }
  }
}

/** Converts a public provider.StreamEventType to the internal enum. */
export function streamEventTypeFromPublic(
  t: PublicStreamEventType,
): InternalStreamEventType {
  switch (t) {
    case publicStreamStart:
      return internalStreamStart;
    case publicStreamTextDelta:
      return internalStreamTextDelta;
    case publicStreamThinkDelta:
      return internalStreamThinkDelta;
    case publicStreamToolCall:
      return internalStreamToolCall;
    case publicStreamHostedItem:
      return internalStreamHostedItem;
    case publicStreamUsage:
      return internalStreamUsage;
    case publicStreamDone:
      return internalStreamDone;
    case publicStreamError:
      return internalStreamError;
    case publicStreamRetry:
      return internalStreamRetry;
    default:
      return internalStreamStart;
  }
}

/** Converts an internal provider.StreamEventType to the public enum. */
export function streamEventTypeToPublic(
  t: InternalStreamEventType,
): PublicStreamEventType {
  switch (t) {
    case internalStreamStart:
      return publicStreamStart;
    case internalStreamTextDelta:
      return publicStreamTextDelta;
    case internalStreamThinkDelta:
      return publicStreamThinkDelta;
    case internalStreamToolCall:
      return publicStreamToolCall;
    case internalStreamHostedItem:
      return publicStreamHostedItem;
    case internalStreamUsage:
      return publicStreamUsage;
    case internalStreamDone:
      return publicStreamDone;
    case internalStreamError:
      return publicStreamError;
    case internalStreamRetry:
      return publicStreamRetry;
    default:
      // Faithful to bridge.go: an unmapped type (notably the internal
      // think-signature event) falls through to StreamStart.
      return publicStreamStart;
  }
}

/**
 * Wraps an internal event sequence into a public event sequence.
 */
export async function* wrapEventChan(
  source: AsyncIterable<Event>,
): AsyncIterable<PublicEvent> {
  for await (const e of source) {
    yield eventToPublic(e);
  }
}

// --- ProviderAdapter wraps a public agent.Provider to satisfy internal provider.Provider ---

/**
 * Wraps a public `sdk/agent.Provider` so it can be used by the internal agent
 * loop. The public provider interface does not expose an API type, so the
 * adapter defaults to the de-facto standard `openai-chat` protocol.
 */
export class ProviderAdapter extends BaseProvider implements InternalProvider {
  private readonly pub: PublicProvider;

  constructor(pub: PublicProvider) {
    super(pub.name(), pub.models().map((m) => modelInfoToInternal(m)));
    this.pub = pub;
  }

  /** Returns the protocol/API type. */
  api(): string {
    return "openai-chat";
  }

  async *chat(params: InternalChatParams): AsyncIterable<InternalStreamEvent> {
    const pubParams = chatParamsToPublic(params);
    for await (const e of this.pub.chat(pubParams)) {
      yield streamEventFromPublic(e);
    }
  }
}

/** Converts a public ModelInfo to an internal provider.Model. */
export function modelInfoToInternal(m: PublicModelInfo): InternalModel {
  const model: InternalModel = {
    id: m.id,
    name: m.name,
    provider: m.provider,
    reasoning: m.reasoning,
    input: [...m.input],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  };
  if (m.compat !== undefined) {
    model.compat = {
      thinkingFormat: m.compat.thinkingFormat,
      requiresReasoningContentOnAssistant:
        m.compat.requiresReasoningContentOnAssistant,
      forceAdaptiveThinking: m.compat.forceAdaptiveThinking,
      supportsDeveloperRole: m.compat.supportsDeveloperRole,
      supportsStore: m.compat.supportsStore,
      supportsReasoningEffort: m.compat.supportsReasoningEffort,
      supportsStrictMode: m.compat.supportsStrictMode,
      maxTokensField: m.compat.maxTokensField,
      disableSamplingParams: m.compat.disableSamplingParams,
      supportsCacheControlOnTools: m.compat.supportsCacheControlOnTools,
      supportsLongCacheRetention: m.compat.supportsLongCacheRetention,
      sendSessionAffinityHeaders: m.compat.sendSessionAffinityHeaders,
      supportsEagerToolInputStreaming: m.compat.supportsEagerToolInputStreaming,
    };
  }
  return model;
}

/** Converts internal ChatParams to public ChatParams. */
export function chatParamsToPublic(p: InternalChatParams): PublicChatParams {
  return {
    messages: p.messages.map(messageToPublic),
    tools: p.tools?.map((t) => toolDefinitionToPublic(t)),
    systemPrompt: p.systemPrompt,
    thinkingLevel: p.thinkingLevel,
    maxTokens: p.maxTokens,
    modelId: p.modelId,
    abort: p.abort,
  };
}

/** Converts a public StreamEvent to an internal StreamEvent. */
export function streamEventFromPublic(
  e: PublicStreamEvent,
): InternalStreamEvent {
  const ev: InternalStreamEvent = {
    type: streamEventTypeFromPublic(e.type),
    textDelta: e.textDelta,
    thinkDelta: e.thinkDelta,
    stopReason: e.stopReason,
    error: e.error,
    retryAttempt: e.retryAttempt,
    retryMax: e.retryMaxAttempts,
    retryMaxAttempts: e.retryMaxAttempts,
    retryAfterMs: e.retryAfterMs,
    attachments: attachmentsFromPublic(e.attachments),
  };
  if (e.hostedItem !== undefined) {
    ev.hostedItem = {
      id: e.hostedItem.id,
      type: e.hostedItem.type,
      status: e.hostedItem.status,
      outputIndex: e.hostedItem.outputIndex,
      metadata: e.hostedItem.metadata,
    };
  }
  if (e.toolCall !== undefined) {
    ev.toolCall = {
      id: e.toolCall.id,
      name: e.toolCall.name,
      kind: e.toolCall.kind,
      input: e.toolCall.input,
      arguments: decodeArguments(e.toolCall.arguments),
      invalidArguments: e.toolCall.invalidArguments,
      thoughtSignature: e.toolCall.thoughtSignature,
    };
  }
  if (e.usage !== undefined) {
    ev.usage = {
      input: e.usage.inputTokens,
      output: e.usage.outputTokens,
      cacheRead: e.usage.cacheRead,
      cacheWrite: e.usage.cacheWrite,
      totalTokens: e.usage.totalTokens,
      cost: { ...e.usage.cost },
    };
  }
  return ev;
}

function toolDefinitionFromPublic(
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

function toolDefinitionToPublic(
  t: InternalToolDefinition,
): PublicToolDefinition {
  return {
    name: t.name,
    description: t.description,
    parameters: encodeArguments(t.parameters),
    kind: t.kind,
    format: encodeArguments(t.format),
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

// --- AgentAdapter wraps the internal Agent to satisfy the public interface ---

/**
 * AgentAdapter wraps an internal `Agent` and satisfies the public
 * `sdk/agent.Agent` (and optional `QuestionHandler`) interface. Go's
 * `WrapEventChan` projection maps to lazily converting each internal event to
 * the public event type as it is yielded.
 */
export class AgentAdapter implements PublicAgent, PublicQuestionHandler {
  readonly inner: Agent;

  constructor(inner: Agent) {
    this.inner = inner;
  }

  id(): PublicAgentID {
    return this.inner.id();
  }

  parentId(): PublicAgentID {
    return this.inner.parentId();
  }

  abort(): void {
    this.inner.abort();
  }

  handleApprovalResponse(approvalId: string, approved: boolean): void {
    this.inner.handleApprovalResponse(approvalId, approved);
  }

  handleQuestionResponse(questionId: string, answer: string): void {
    this.inner.handleQuestionResponse(questionId, answer);
  }

  /**
   * Exposes the atomic answer delivery to callers that answer on another
   * agent's behalf; intentionally not part of the public `QuestionHandler`
   * interface so existing implementers keep compiling.
   */
  deliverQuestionAnswer(questionId: string, answer: string): boolean {
    return this.inner.deliverQuestionAnswer(questionId, answer);
  }

  run(userMsg: string, abort?: AbortSignal): AsyncIterable<PublicEvent> {
    return wrapEventIterable(this.inner.run(userMsg, abort));
  }

  runWithMessages(
    messages: PublicMessage[],
    abort?: AbortSignal,
  ): AsyncIterable<PublicEvent> {
    return wrapEventIterable(
      this.inner.runWithMessages(messagesFromPublic(messages) ?? [], abort),
    );
  }

  getMessages(): PublicMessage[] {
    return messagesToPublic(this.inner.getMessages()) ?? [];
  }

  setMessages(msgs: PublicMessage[]): void {
    this.inner.setMessages(messagesFromPublic(msgs) ?? []);
  }

  getContextUsage(): PublicContextUsage | undefined {
    return contextUsageToPublic(this.inner.getContextUsage());
  }

  loadHistoryMessages(messages: PublicMessage[]): void {
    this.inner.loadHistoryMessages(messagesFromPublic(messages) ?? []);
  }

  getContext(): PublicAgentContext {
    const x = this.inner.getContext();
    if (x === null) {
      return { systemPrompt: "", messages: [], tools: [] };
    }
    return {
      systemPrompt: x.systemPrompt,
      messages: messagesToPublic(x.messages) ?? [],
      tools: [],
    };
  }

  setContext(ctx: PublicAgentContext): void {
    this.inner.setContext({
      systemPrompt: ctx.systemPrompt,
      messages: messagesFromPublic(ctx.messages) ?? [],
      tools: [],
    });
  }
}

/** Creates an adapter that wraps an internal Agent. */
export function newAgentAdapter(a: Agent): AgentAdapter {
  return new AgentAdapter(a);
}

/** Projects the internal event stream onto the public event vocabulary. */
async function* wrapEventIterable(
  events: AsyncIterable<Event>,
): AsyncIterable<PublicEvent> {
  for await (const e of events) {
    yield eventToPublic(e);
  }
}
