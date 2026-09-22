// Ported from the public Go package `agent` (agent/types.go).
//
// The public SDK boundary lives in `sdk/`; this module must not import from
// `src/`. Implementation wiring (the internal builder and provider bridge)
// lives in `src/bootstrap/`.

import type { HostedItem } from "./provider.ts";

/** AgentID uniquely identifies an agent instance. */
export type AgentID = string;

/** Agent is the interface that all agent implementations must satisfy. */
export interface Agent {
  /** Returns the unique identifier for this agent. */
  id(): AgentID;

  /** Returns the ID of the parent agent, or empty if top-level. */
  parentId(): AgentID;

  /** Processes a user message and streams events back. */
  run(userMsg: string, abort?: AbortSignal): AsyncIterable<Event>;

  /** Processes with explicit message history. */
  runWithMessages(
    messages: Message[],
    abort?: AbortSignal,
  ): AsyncIterable<Event>;

  /** Signals the agent to stop processing. */
  abort(): void;

  /** Returns a copy of the current message history. */
  getMessages(): Message[];

  /** Replaces the message history. */
  setMessages(msgs: Message[]): void;

  /** Returns a copy of the current agent context. */
  getContext(): AgentContext;

  /** Replaces the agent context. */
  setContext(ctx: AgentContext): void;

  /** Returns the current context window usage, or undefined if unavailable. */
  getContextUsage(): ContextUsage | undefined;

  /** Loads historical messages into agent context. */
  loadHistoryMessages(messages: Message[]): void;

  /** Processes the user's approval response for a pending tool call. */
  handleApprovalResponse(approvalId: string, approved: boolean): void;
}

/**
 * QuestionHandler is an optional extension of Agent that supports interactive
 * questions. Only implemented by agents in TUI plan mode.
 */
export interface QuestionHandler extends Agent {
  handleQuestionResponse(questionId: string, answer: string): void;
}

/** AgentConfigView is a read-only view of agent configuration. */
export interface AgentConfigView {
  id: AgentID;
  parentId: AgentID;
  mode: string;
  modelId: string;
}

/** ContextUsage reports how much of the context window is consumed. */
export interface ContextUsage {
  /** Deprecated alias for totalTokens. */
  tokens: number;
  /** Full current input footprint. */
  totalTokens: number;
  /** Non-cache input tokens. */
  input: number;
  /** Input tokens served from cache. */
  cacheRead: number;
  /** Input tokens written to cache. */
  cacheWrite: number;
  contextWindow: number;
  percent?: number;
}

/** AgentContext holds the current agent conversation context. */
export interface AgentContext {
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
}

/** Role identifies who produced a message. */
export type Role = string;

export const roleUser: Role = "user";
export const roleAssistant: Role = "assistant";
export const roleToolResult: Role = "toolResult";
export const roleSystem: Role = "system";

/** Message represents a single message in the conversation. */
export interface Message {
  role: Role;
  content?: string;
  contents?: ContentBlock[];
  attachments?: Attachment[];
  isError?: boolean;
  systemInjected?: boolean;
  toolCallId?: string;
  toolName?: string;
  toolKind?: string;
  usage?: Usage;
}

/** ContentBlock represents a typed block within a message. */
export interface ContentBlock {
  /** "text", "toolCall", "thinking", "image", "file" */
  type: string;
  text?: string;
  toolCall?: ToolCallBlock;
  thinking?: string;
  signature?: string;
  image?: ImageContent;
  file?: FileContent;
  cacheControl?: CacheControl;
}

/** FileContent identifies an existing provider file or an inline base64 file. */
export interface FileContent {
  id?: string;
  url?: string;
  data?: string;
  filename?: string;
  mimeType?: string;
  title?: string;
  description?: string;
  size?: number;
}

/** ToolCallBlock represents a tool call requested by the LLM. */
export interface ToolCallBlock {
  id: string;
  name: string;
  kind?: string;
  input?: string;
  arguments?: Uint8Array;
  invalidArguments?: string;
  thoughtSignature?: string;
}

/** ImageContent represents an image in a content block. */
export interface ImageContent {
  mimeType?: string;
  /** base64-encoded */
  data?: string;
  width?: number;
  height?: number;
  bytes?: number;
  originalWidth?: number;
  originalHeight?: number;
  originalBytes?: number;
  detail?: string;
  scale?: number;
  cropped?: boolean;
  cropX?: number;
  cropY?: number;
  cropWidth?: number;
  cropHeight?: number;
}

/** CacheControl represents cache control metadata on a content block. */
export interface CacheControl {
  /** "ephemeral" */
  type: string;
}

/** ToolDefinition describes a tool available to the LLM. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema */
  parameters?: Uint8Array;
  /** function (default), custom, or hosted */
  kind?: string;
  /** custom tool text/grammar format */
  format?: Uint8Array;
  provider?: string;
  providerType?: string;
  model?: string;
}

/** Usage tracks token consumption for a single LLM response. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: CostBreakdown;
}

/**
 * Returns the full input footprint for the response, including cache reads and
 * cache writes when the provider reports them separately. Use it as the
 * prompt-cache hit-ratio denominator: providers differ in whether cached input
 * is folded into inputTokens or reported apart, and this keeps the SDK, the
 * CLI, and every front-end projection on one measurement basis.
 */
export function totalInputTokens(u: Usage | null | undefined): number {
  if (u == null) {
    return 0;
  }
  if (u.totalTokens > 0) {
    const totalInput = u.totalTokens - u.outputTokens;
    if (totalInput > 0) {
      return totalInput;
    }
  }
  return u.inputTokens + u.cacheRead + u.cacheWrite;
}

/**
 * Returns the portion of input charged at the regular input rate. inputTokens
 * returned by this SDK is normalized to non-cached input, but manually
 * constructed values may still use a full prompt total.
 */
export function billableInputTokens(u: Usage): number {
  let input = u.inputTokens;
  const totalInput = u.totalTokens - u.outputTokens;
  if (totalInput > 0 && totalInput === u.inputTokens) {
    input -= u.cacheRead + u.cacheWrite;
  }
  if (input < 0) {
    return 0;
  }
  return input;
}

/** Computes cost based on model pricing (prices are per 1M tokens). */
export function calculateCost(
  u: Usage,
  inputPrice: number,
  outputPrice: number,
  cacheReadPrice: number,
  cacheWritePrice: number,
): void {
  u.cost.input = (billableInputTokens(u) * inputPrice) / 1_000_000;
  u.cost.output = (u.outputTokens * outputPrice) / 1_000_000;
  u.cost.cacheRead = (u.cacheRead * cacheReadPrice) / 1_000_000;
  u.cost.cacheWrite = (u.cacheWrite * cacheWritePrice) / 1_000_000;
  u.cost.total = u.cost.input + u.cost.output + u.cost.cacheRead +
    u.cost.cacheWrite;
}

/** Attachment is a provider-neutral citation, file, image, or artifact. */
export interface Attachment {
  kind: string;
  name?: string;
  url?: string;
  mediaType?: string;
  metadata?: Record<string, unknown>;
  providerRef?: string;
}

/** CostBreakdown itemizes the cost of an LLM call. */
export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** Returns an empty CostBreakdown. */
export function newCostBreakdown(): CostBreakdown {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

/** EventType identifies the type of agent event. */
export type EventType = number;

// Agent lifecycle events
export const eventAgentStart: EventType = 0;
export const eventAgentEnd: EventType = 1;

// Turn lifecycle events (a turn = one assistant response + tool calls/results)
export const eventTurnStart: EventType = 2;
export const eventTurnEnd: EventType = 3;

// Message lifecycle events
export const eventMessageStart: EventType = 4;
export const eventMessageUpdate: EventType = 5;
export const eventMessageEnd: EventType = 6;

// Streaming events
export const eventTextDelta: EventType = 7;
export const eventThinkDelta: EventType = 8;
export const eventHostedItem: EventType = 9;

// Tool execution events
export const eventToolCall: EventType = 10;
export const eventToolExecutionStart: EventType = 11;
export const eventToolExecutionUpdate: EventType = 12;
export const eventToolExecutionEnd: EventType = 13;
export const eventToolResult: EventType = 14;
export const eventToolApprovalRequest: EventType = 15;
export const eventToolApprovalResponse: EventType = 16;
export const eventQuestionRequest: EventType = 17;
export const eventQuestionResponse: EventType = 18;
export const eventPlanUpdate: EventType = 19;

// Status events
export const eventStatus: EventType = 20;
export const eventDone: EventType = 21;
export const eventError: EventType = 22;
export const eventUsage: EventType = 23;

// Compaction events
export const eventCompactionStart: EventType = 24;
export const eventCompactionEnd: EventType = 25;

// Pressure and retry events
export const eventContextPressure: EventType = 26;
export const eventBudgetPressure: EventType = 27;
export const eventRetry: EventType = 28;

// EventRunFinished is the single canonical terminal event for a run. Exactly one
// is emitted per run before legacy terminal events, carrying the TaskStatus
// outcome.
export const eventRunFinished: EventType = 29;

/**
 * TaskStatus is the canonical terminal outcome of an agent run/task. It is
 * carried by the eventRunFinished event and is the single source of truth that
 * TUI, CLI, and ACP consumers use to classify a finished task.
 */
export type TaskStatus = string;

export const taskSuccess: TaskStatus = "success";
/**
 * The run stopped before achieving its objective (output/context limits, max
 * iterations, stuck detection) without a hard error.
 */
export const taskIncomplete: TaskStatus = "incomplete";
export const taskError: TaskStatus = "error";
/** Deprecated alias for taskError. */
export const taskFailed: TaskStatus = taskError;
export const taskCanceled: TaskStatus = "canceled";

/** Reports whether the TaskStatus represents a finished run outcome. */
export function taskStatusIsTerminal(s: TaskStatus): boolean {
  switch (s) {
    case taskSuccess:
    case taskIncomplete:
    case taskFailed:
    case taskCanceled:
      return true;
  }
  return false;
}

/** Reports whether the outcome is a successful completion. */
export function taskStatusIsSuccessful(s: TaskStatus): boolean {
  return s === taskSuccess;
}

/** Event represents an event from the agent to the consumer. */
export interface Event {
  agentId: AgentID;
  type: EventType;

  // Expert-team metadata is additive and populated on forwarded child-agent
  // events. It is a display snapshot so consumers can render a member without
  // resolving mutable expert-package content during replay.
  memberId?: string;
  expertId?: string;
  memberDisplayName?: string;
  memberEmoji?: string;
  memberRole?: string;

  // Agent lifecycle
  messages?: Message[];

  // Turn lifecycle
  turnMessage?: Message;
  turnToolResults?: Message[];

  // Message lifecycle
  message?: Message;

  // Stream events
  textDelta?: string;
  thinkDelta?: string;
  hostedItem?: HostedItem;

  // Tool events
  toolCall?: ToolCallBlock;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolDiff?: FileDiff;
  toolError?: Error;
  /**
   * Set to interrupted when idempotency recovery refuses to repeat a tool whose
   * prior process may have died mid-execution.
   */
  toolExecutionState?: string;
  /** Image payloads embedded in a completed tool result. */
  toolImages?: ToolImage[];
  partialResult?: unknown;

  // Plan events
  plan?: TaskPlan;

  // Approval events
  approvalId?: string;
  approvalTool?: string;
  approvalArgs?: Record<string, unknown>;
  approvalResult?: boolean;

  // Question events
  questionId?: string;
  questionText?: string;
  questionOptions?: string[];
  questionContext?: string;
  questionAnswer?: string;

  // Status
  statusMessage?: string;
  /** expired, permission, request_failed */
  responseStateFailureClass?: string;
  /**
   * Marks an eventStatus compatibility projection for the following
   * eventRetry. New adapters should consume eventRetry and ignore this marked
   * status to avoid rendering retry progress twice.
   */
  retryStatus?: boolean;

  // Retry information for automatic provider and turn recovery.
  retryAttempt?: number;
  retryMaxAttempts?: number;
  retryAfterMs?: number;
  retryMaxTokens?: number;
  retryReason?: string;
  retryContinue?: boolean;

  // Completion
  done?: boolean;
  stopReason?: string;
  error?: Error;
  /** Canonical terminal outcome, set on eventRunFinished. */
  status?: TaskStatus;

  // Usage
  usage?: Usage;

  /** Attachments emitted by the completed provider turn. */
  attachments?: Attachment[];

  // Context usage
  contextUsage?: ContextUsage;
}

/**
 * ToolImage is one image payload produced by a tool result. data holds the
 * base64-encoded image bytes and mimeType the image format.
 */
export interface ToolImage {
  mimeType: string;
  data: string;
}

/** FileDiff describes a file change produced by a write-like tool. */
export interface FileDiff {
  path: string;
  added: number;
  deleted: number;
  addedLines?: number[];
  deletedLines?: number[];
  unified: string;
  oldText?: string;
  newText: string;
  truncated?: boolean;
}

/** TaskPlan describes a structured task plan emitted by the plan tool. */
export interface TaskPlan {
  title: string;
  steps: PlanStep[];
  note: string;
}

/** PlanStep describes one step in a task plan. */
export interface PlanStep {
  title: string;
  status: string;
}

// --- Helper constructors ---

/** Creates a user message with plain text content. */
export function newUserMessage(content: string): Message {
  return { role: roleUser, content };
}

/** Creates an assistant message with content blocks. */
export function newAssistantMessage(contents: ContentBlock[]): Message {
  return { role: roleAssistant, contents };
}

/** Creates an assistant message with plain text. */
export function newAssistantTextMessage(content: string): Message {
  return { role: roleAssistant, content };
}

/** Creates a tool result message with plain text. */
export function newToolResultMessage(
  toolCallId: string,
  toolName: string,
  content: string,
  isError: boolean,
): Message {
  return {
    role: roleToolResult,
    content,
    toolCallId,
    toolName,
    isError,
  };
}

/** Creates a tool result message with rich content blocks. */
export function newToolResultMessageWithContents(
  toolCallId: string,
  toolName: string,
  text: string,
  contents: ContentBlock[],
  isError: boolean,
): Message {
  return {
    role: roleToolResult,
    content: text,
    contents,
    toolCallId,
    toolName,
    isError,
  };
}

/**
 * Creates a user message marked as system-injected (skipped by cache markers).
 */
export function newSystemInjectedUserMessage(content: string): Message {
  return { role: roleUser, content, systemInjected: true };
}
