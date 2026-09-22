// Ported from internal/agent/agent.go (the `Agent` instance model) and the
// Agent-bound accessors of internal/agent/agent_context.go.
//
// This module ports the Agent type, its constructors, the frozen-prompt build,
// the run-scoped context helpers, the history/context accessors, the
// abort/lifecycle plumbing, the Agent Core image-admission gate, and the
// request-assembly / compaction-decision helpers of agent_context.go
// (buildSessionContextMessage, requestTokenBudget, buildRequestMessages,
// replaceLargestToolResultForContext, maxTokensForRequest,
// previousCompactionSummary, canCompact, shouldAutoCompact, shouldCompact).
//
// Deviations from Go:
//   - `context.Context` maps to the `RunContext` context (`run_context.ts`)
//     carrying an `AbortSignal` plus explicit typed run fields.
//   - `chan<- Event` maps to an `EventSink` (`(ev: Event) => boolean`).
//     `sendEvent`/`emit` and the Agent-bound approval/question coordination
//     (`needsApproval`/`requestToolApproval`/`requestQuestion` and their
//     handlers) are ported; their Go blocking channel selects become promises
//     raced against the agent abort signal and the run-context signal. The
//     `Run*` entry points, `loop`, `emitRunFinished`, and the tool-execution /
//     compaction / response-state paths remain deferred (see
//     docs/proposal/go-to-deno-migration.md backlog #19).
//   - `sync.RWMutex`/`sync/atomic` are dropped (Deno is single-threaded);
//     `atomic.Int64`/`Int32` map to plain number fields.
//   - `time.Now().UnixNano()` agent IDs map to a millisecond clock plus a
//     monotonic counter so generated IDs stay unique within a process.

import {
  type Attachment,
  calculateCost,
  type ChatParams,
  type ContentBlock,
  type Message,
  type Model,
  newSystemInjectedUserMessage,
  type ThinkingLevel,
  type ToolCallBlock,
  type ToolDefinition,
  type Usage,
} from "../provider/types.ts";
import type { Provider } from "../provider/provider.ts";
import {
  defaultToolExecutionMaxConcurrency,
  getProviderConfig,
  type Settings,
  toolExecutionEffectiveMaxConcurrency,
  toolExecutionEffectiveMode,
} from "../config/settings.ts";
import type { AllowConfig } from "../config/allow.ts";
import {
  type CompactionSettings,
  hasCompactableMessages,
  normalizeCompactionSettings,
} from "../context/compaction.ts";
import { shouldCompactPercent } from "../context/context.ts";
import {
  type ContextUsage,
  contextUsageFromMessages,
} from "../context/context.ts";
import { resolveTokenEstimator } from "../context/tokenizer.ts";
import type { Hint } from "../imageproc/mod.ts";
import { type Registry, type ToolContext } from "../tools/tool.ts";
import type { Sandbox } from "../sandbox/sandbox.ts";
import type { Manager as SessionManager } from "../session/manager.ts";
import { runUserEntryID } from "../session/run_user_message.ts";
import { type IterationBudgetPolicy } from "./iteration_budget.ts";
import { needsApproval } from "./agent_approval.ts";
import {
  type AgentContext,
  cloneAgentContext,
  cloneMessages,
  configuredWebSearchToolDefinition,
  openAIResponsesWebSearchToolDefinition,
} from "./agent_support.ts";
import {
  buildSystemPromptWithOptions,
  type SystemPromptOptions,
} from "./system_prompt.ts";
import {
  applyCacheMarkers,
  clampMaxTokensToContext,
  completeProviderUsage,
  containsImageContent,
  contextGuardToolResult,
  defaultAutoCompactionThreshold,
  encodedImagePayloadBytes,
  estimateChatRequestTokens,
  estimateGuardRequestTokens,
  estimateProviderUsage,
  isContextGuardToolResult,
  providerImageRequestBudget,
  repairDanglingToolCalls,
  selectCacheMarkers,
  toolResultImages,
  unsupportedImageToolResultMessage,
} from "./agent_context.ts";
import { createHash } from "node:crypto";
import {
  type Event,
  EventAgentEnd,
  EventQuestionRequest,
  EventToolApprovalRequest,
} from "./events.ts";
import type { AgentID } from "../../sdk/agent/types.ts";
import {
  contextWithSignal,
  type EventSink,
  newRunContext,
  type RunContext,
} from "./run_context.ts";
import {
  classifyTurn,
  formatUsage,
  newAssistantMessage,
  newToolResultMessage,
  newToolResultMessageWithContents,
  newUserMessage,
  normalizeThinkingLevel,
  type ResponseArchive,
  type ResponseStateFailureClass,
  responseStateFailureRequestFailed,
  streamDone,
  streamError,
  streamHostedItem,
  streamRetry,
  streamTextDelta,
  streamThinkDelta,
  streamThinkSignature,
  streamToolCall,
  streamUsage,
  turnEmpty,
} from "../provider/types.ts";
import {
  isContentRejectionError,
  isContextOverflowError,
  isRetryable,
  isStreamTimeoutError,
  retryErrorDetail,
} from "../provider/mod.ts";
import {
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
  EventPlanUpdate,
  EventRetry,
  EventRunFinished,
  EventStatus,
  EventTextDelta,
  EventThinkDelta,
  EventToolCall,
  EventToolExecutionEnd,
  EventToolExecutionStart,
  EventToolResult,
  EventTurnEnd,
  EventTurnStart,
  EventUsage,
  TaskCanceled,
  TaskFailed,
  TaskIncomplete,
  type TaskStatus,
  TaskSuccess,
} from "./events.ts";
import { compactWithOptions } from "../context/compaction.ts";
import { generateID } from "../session/entry.ts";
import { runAssistantEntryID } from "../session/run_user_message.ts";
import {
  claimToolExecutionRecord,
  compareAndSwapResponseSessionState,
  getResponseSessionState,
  listResponseReplayTurns,
  reclaimInterruptedToolExecution,
  saveResponseItem,
  saveResponseTurn,
  type ToolExecutionRecord,
  updateToolExecutionRecord,
} from "../session/response_store.ts";
import {
  contextWithOperationID,
  contextWithQuestionAsker,
  newRegistry,
  type Tool,
} from "../tools/tool.ts";
import type { FileDiff, QuestionAsker, TaskPlan } from "../tools/mod.ts";
import { newNoneSandbox } from "../sandbox/none.ts";
import { contextWithGitAccess, gitAccessRequired } from "../sandbox/git.ts";
import { Level } from "../sandbox/sandbox.ts";
import { bashCommandArg } from "./agent_approval.ts";
import {
  buildOutputRecoveryMessage,
  buildStreamRecoveryMessage,
  cloneContentBlock,
  cloneMessagesWithoutUsage,
  goDurationString,
  isOutputTruncationReason,
  isReadOnlyToolName,
  isSideEffectingToolName,
  nextToolCallFallbackID,
  normalizeMessage,
  normalizeToolCallArguments,
  parseToolExecutionResultSummary,
  replayTextContent,
  retryCompatibilityStatus,
  toolExecutionContext,
  toolExecutionResultSummary,
  usageStatsProviderName,
} from "./agent_support.ts";
import {
  lastUserTurnIndex,
  maxContentRejectionStages,
  streamRecoveryRetryDelay,
  stripImagesFromMessage,
  waitForStreamRecoveryRetry,
} from "./agent_context.ts";
import {
  contextWithIterationBudget,
  type IterationBudget,
  iterationBudgetFromContext,
  iterationBudgetPolicyEnabled,
  IterationBudgetToolName,
  newIterationBudget,
  normalizeIterationBudgetPolicy,
} from "./iteration_budget.ts";
import { boundedParallel } from "./parallel.ts";
import { newToolLaunchOrder, type ToolLaunchHandle } from "./tool_launch.ts";
import { EventChannel } from "./event_channel.ts";

// --- Run-scoped context helpers -------------------------------------------

export type { EventSink };

/** Returns a copy of ctx carrying the agent ID. */
export function contextWithAgentID(
  ctx: RunContext | undefined,
  id: AgentID,
): RunContext {
  return { ...(ctx ?? {}), agentID: id };
}

/** Extracts the agent ID, or `[undefined, false]`. */
export function agentIDFromContext(
  ctx: RunContext | undefined,
): [AgentID | undefined, boolean] {
  const id = ctx?.agentID;
  return [id, id !== undefined];
}

/** Returns a copy of ctx carrying the event channel push function. */
export function contextWithEventChan(
  ctx: RunContext | undefined,
  ch: (ev: Event) => boolean,
): RunContext {
  return { ...(ctx ?? {}), eventSink: ch };
}

/** Extracts the event-channel push function, or `[undefined, false]`. */
export function eventChanFromContext(
  ctx: RunContext | undefined,
): [((ev: Event) => boolean) | undefined, boolean] {
  const ch = ctx?.eventSink;
  return [ch, ch !== undefined];
}

/** Returns a copy of ctx carrying the parent agent run context. */
export function contextWithParentRunContext(
  ctx: RunContext | undefined,
  parent: RunContext,
): RunContext {
  return { ...(ctx ?? {}), parentRunContext: parent };
}

/** Extracts the parent agent run context, or `[undefined, false]`. */
export function parentRunContextFromContext(
  ctx: RunContext | undefined,
): [RunContext | undefined, boolean] {
  const parent = ctx?.parentRunContext;
  return [parent, parent !== undefined];
}

/** Returns a copy of ctx carrying the parent agent's execution mode. */
export function contextWithParentMode(
  ctx: RunContext | undefined,
  mode: string,
): RunContext {
  return { ...(ctx ?? {}), parentMode: mode };
}

/** Extracts the parent agent's execution mode, or `[undefined, false]`. */
export function parentModeFromContext(
  ctx: RunContext | undefined,
): [string | undefined, boolean] {
  const mode = ctx?.parentMode;
  return [mode, mode !== undefined];
}

// --- Loop support types ----------------------------------------------------

/** The empty compaction settings used when none are configured. */
const emptyCompactionSettings: CompactionSettings = {
  enabled: false,
  reserveTokens: 0,
  keepRecentTokens: 0,
};

/** Mutable recovery counters owned by one run's loop. */
export interface LoopRecoveryState {
  contextOverflowRetried: boolean;
  contentRejectionStage: number;
  streamTimeoutRetries: number;
  streamFailureRetries: number;
  recoveryAssistantContents: ContentBlock[];
  toolArgumentNotices: string[];
}

/** One stripped message and the persisted entry it replaces. */
interface ContentOverride {
  entryId: string;
  message: Message;
}

/** A snapshot of the remote Responses state for one turn. */
interface ResponsesStateSnapshot {
  previousResponseId: string;
  replayItems: unknown[];
  suppressConversation: boolean;
  remoteStateActive: boolean;
  version: number;
}

/**
 * Tool-context accessors carrying the parent agent run identity into a tool
 * body. Each extracts one explicit `ToolContext` field the loop fills in before
 * executing a tool, or `[undefined, false]` when absent.
 */
export function agentIDFromToolContext(
  ctx: ToolContext | undefined,
): [AgentID | undefined, boolean] {
  const id = ctx?.agentID;
  return [id, id !== undefined];
}

export function eventSinkFromToolContext(
  ctx: ToolContext | undefined,
): [EventSink | undefined, boolean] {
  const sink = ctx?.eventSink;
  return [sink, sink !== undefined];
}

export function parentRunContextFromToolContext(
  ctx: ToolContext | undefined,
): [RunContext | undefined, boolean] {
  const parent = ctx?.parentRunContext;
  return [parent, parent !== undefined];
}

export function parentModeFromToolContext(
  ctx: ToolContext | undefined,
): [string | undefined, boolean] {
  const mode = ctx?.parentMode;
  return [mode, mode !== undefined];
}

/** The provider Responses state-mode surface, when implemented. */
interface ResponseStateModeProviderLike {
  responseStateMode(): string;
}

/** The provider Responses fallback surface, when implemented. */
interface ResponseStateFallbackProviderLike {
  responseStateFallbackError(err: unknown): boolean;
}

/** The provider Responses failure-classifier surface, when implemented. */
interface ResponseStateFailureClassifierLike {
  responseStateFailureClass(err: unknown): ResponseStateFailureClass;
}

// --- Configuration ---------------------------------------------------------

/** Config holds the agent configuration. */
export interface Config {
  id?: AgentID;
  parentId?: AgentID;
  provider?: Provider;
  /** User-configured provider/vendor name (e.g. "longcat", "openai"). */
  vendor?: string;
  model?: Model;
  /** "plan", "agent", "yolo", "os". */
  mode?: string;
  thinkingLevel?: ThinkingLevel;
  maxTokens?: number;
  maxTokensUserSet?: boolean;
  sandboxMgr?: Sandbox;
  settings?: Settings;
  /** Auto-approval (allow.json): autoEdit, editPaths, bash rules. */
  allow?: AllowConfig;
  session?: SessionManager;
  /** Extra context from files and skills. */
  extraContext?: string;
  /** Content of .opensac/rule.md (project rules). */
  ruleContent?: string;
  expertIdentity?: string;
  expertRoster?: string;
  compactionSettings?: CompactionSettings;
  /**
   * Resolves a tool approval. A protocol adapter whose approval round trip is
   * asynchronous may return a promise; Agent Core awaits it, matching Go's
   * blocking handler executed on the run's goroutine.
   */
  approvalHandler?: (
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => boolean | Promise<boolean>;
  approvalDecisionLookup?: (
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => [boolean, boolean];
  multiAgent?: boolean;
  delegateMode?: boolean;
  workflows?: boolean;
  conversationTurnId?: string;
  intentId?: string;
  runId?: string;
  conversationTurn?: boolean;
  runtimeOwnsTurnEnd?: boolean;
  runtimeOwnsUserEntry?: boolean;
  userEntryId?: string;
}

/** AgentLoopConfig extends Config with loop-specific settings. */
export interface AgentLoopConfig extends Config {
  /**
   * ForcedMode is an already-resolved Runtime invariant inherited by managed
   * children. Agent Core does not interpret its source.
   */
  forcedMode?: string;
  /** "sequential" or "parallel" (default). */
  toolExecutionMode?: string;
  /** Bounds local tool calls in flight per batch. Non-positive uses config. */
  maxToolConcurrency?: number;
  /**
   * Safety limit for loop iterations. Zero uses the default limit; a negative
   * value intentionally leaves the loop unbounded.
   */
  maxIterations?: number;
  getSteeringMessages?: () => Message[];
  getFollowUpMessages?: (
    ctx: RunContext,
  ) => Message[] | null | Promise<Message[] | null>;
  shouldStopAfterTurn?: (ctx: ShouldStopAfterTurnContext) => boolean;
  prepareNextTurn?: (ctx: PrepareNextTurnContext) => TurnUpdate | undefined;
  beforeToolCall?: (
    ctx: BeforeToolCallContext,
  ) => ToolCallBlockResult | undefined;
  beforeToolExecute?: (
    ctx: BeforeToolExecuteContext,
  ) => ToolCallBlockResult | undefined;
  afterToolCall?: (ctx: AfterToolCallContext) => ToolCallResult | undefined;
  /** Context usage percentage (0-1) that triggers EventContextPressure. */
  contextPressureThreshold?: number;
  /** Remaining iteration ratio (0-1) that triggers EventBudgetPressure. */
  budgetPressureThreshold?: number;
  /** Governs model-requested iteration renewals. */
  iterationBudget?: IterationBudgetPolicy;
  /** Max tool-only turns before a stuck-detection warning. 0 = default (95). */
  maxConsecutiveNoText?: number;
}

/** Passed to ShouldStopAfterTurn. */
export interface ShouldStopAfterTurnContext {
  message: Message;
  toolResults: Message[];
  context: AgentContext | null;
  newMessages: Message[];
}

/** Passed to PrepareNextTurn. */
export interface PrepareNextTurnContext extends ShouldStopAfterTurnContext {}

/** Returned from PrepareNextTurn. */
export interface TurnUpdate {
  context?: AgentContext | null;
  model?: Model;
  thinkingLevel?: ThinkingLevel;
}

/** Passed to BeforeToolCall. */
export interface BeforeToolCallContext {
  assistantMessage: Message;
  toolCall: ToolCallBlock;
  args: unknown;
  context: AgentContext | null;
}

/** Passed to BeforeToolExecute after approval and durable idempotency claim. */
export interface BeforeToolExecuteContext {
  toolCall: ToolCallBlock;
  args: unknown;
  context: AgentContext | null;
  executionContext: ToolContext;
  runId: string;
  executionKey: string;
  sideEffecting: boolean;
}

/** Returned from BeforeToolCall / BeforeToolExecute. */
export interface ToolCallBlockResult {
  block: boolean;
  reason: string;
}

/** Passed to AfterToolCall. */
export interface AfterToolCallContext {
  assistantMessage: Message;
  toolCall: ToolCallBlock;
  args: unknown;
  result: ToolCallResult;
  isError: boolean;
  context: AgentContext | null;
}

/** Represents the result of a tool call. */
export interface ToolCallResult {
  content: string;
  isError: boolean;
  terminate: boolean;
}

// --- Core constants --------------------------------------------------------

/** The default output token ceiling applied before any escalation. */
export const defaultOutputMaxTokens = 8192;
/** The ceiling an output-truncated turn may escalate to. */
export const escalatedOutputMaxTokens = 65536;
/** Maximum output-limit recovery attempts per turn. */
export const maxOutputRecoveryAttempts = 3;

// --- Agent -----------------------------------------------------------------

/** Formats the current local date as YYYY-MM-DD (matching Go's time layout). */
function localISODate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

let generatedAgentCounter = 0;

/** The Go `provider.Message{}` zero value: empty role/content with a zero time. */
function emptyMessage(): Message {
  return { role: "", timestamp: new Date(0) };
}

function generateAgentID(): AgentID {
  generatedAgentCounter += 1;
  // Go uses time.Now().UnixNano(); a millisecond clock plus a per-process
  // counter keeps generated IDs unique without losing integer precision.
  return `agent-${Date.now()}${generatedAgentCounter}`;
}

/**
 * Agent is the core agent loop instance. The loop itself (`loop`) and the
 * event-producing Run* entry points are deferred to the core-loop port; this
 * type owns the frozen prompt, message history, context, abort state, and the
 * Agent Core request-admission gate.
 */
/** Extracts a cancellation Error from an aborted signal. */
function abortErrorFrom(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

/** Returns the provider Responses state-mode surface, when implemented. */
function responseStateModeOf(
  p: Provider | undefined,
): ResponseStateModeProviderLike | undefined {
  if (p === undefined) return undefined;
  const candidate = p as unknown as Partial<ResponseStateModeProviderLike>;
  return typeof candidate.responseStateMode === "function"
    ? candidate as ResponseStateModeProviderLike
    : undefined;
}

/** Returns the provider Responses fallback surface, when implemented. */
function responseStateFallbackOf(
  p: Provider | undefined,
): ResponseStateFallbackProviderLike | undefined {
  if (p === undefined) return undefined;
  const candidate = p as unknown as Partial<ResponseStateFallbackProviderLike>;
  return typeof candidate.responseStateFallbackError === "function"
    ? candidate as ResponseStateFallbackProviderLike
    : undefined;
}

/** Returns the provider Responses failure classifier, when implemented. */
function responseStateFailureOf(
  p: Provider | undefined,
): ResponseStateFailureClassifierLike | undefined {
  if (p === undefined) return undefined;
  const candidate = p as unknown as Partial<
    ResponseStateFailureClassifierLike
  >;
  return typeof candidate.responseStateFailureClass === "function"
    ? candidate as ResponseStateFailureClassifierLike
    : undefined;
}

/** Returns the work directory backing the agent's tool registry, if any. */
export function workDirForAgent(a: Agent | undefined): string {
  return a?.registry()?.getWorkDir() ?? "";
}

export class Agent {
  #id: AgentID;
  #parentId: AgentID;
  config: AgentLoopConfig;
  #registry: Registry | undefined;
  #context: AgentContext;
  #messages: Message[] = [];
  #messageIds: string[] = [];
  #isStreaming = false;
  #conversationTurnId = "";
  #conversationTurnOpen = false;
  #lastAssistantEntryId = "";
  #lastAssistantMessage: Message = emptyMessage();
  #frozenSystemPrompt = "";
  #frozenToolDefs: ToolDefinition[] = [];
  #frozenToolNames: string[] = [];
  #abortController = new AbortController();
  #forceCompact = false;
  /** Pending tool-approval decision resolvers keyed by approval ID. */
  #pendingApprovals = new Map<string, (approved: boolean) => void>();
  #approvalCounter = 0;
  /** Pending question-answer resolvers keyed by question ID. */
  #pendingQuestions = new Map<string, (answer: string) => void>();
  #questionCounter = 0;
  /**
   * The context of the run currently producing events. Stored without a lock so
   * event sends can stop as soon as a run is cancelled.
   */
  runCtx: RunContext | undefined;
  /** Counts events skipped because the run context finished. */
  droppedEvents = 0;

  /**
   * Prefer `newAgent`/`newAgentWithLoopConfig`, which build the frozen prompt.
   * The public constructor is retained for subclasses/tests and mirrors the Go
   * struct literal.
   */
  constructor(
    id: AgentID,
    parentId: AgentID,
    config: AgentLoopConfig,
    registry: Registry | undefined,
  ) {
    this.#id = id;
    this.#parentId = parentId;
    this.config = config;
    this.#registry = registry;
    this.#context = { systemPrompt: "", messages: [], tools: [] };
  }

  /** The agent's unique identifier. */
  id(): AgentID {
    return this.#id;
  }

  /** The parent agent's ID, or empty if top-level. */
  parentId(): AgentID {
    return this.#parentId;
  }

  /** The registry backing this agent, when one was supplied. */
  registry(): Registry | undefined {
    return this.#registry;
  }

  /** The abort signal exposed to provider requests. */
  abortSignal(): AbortSignal {
    return this.#abortController.signal;
  }

  /**
   * SetConversationTurn binds a reusable Agent instance to the durable Run it
   * is about to execute. TUI keeps one Agent across prompts, while other
   * adapters usually provide these values at construction time.
   */
  setConversationTurn(turnId: string, intentId: string, runId: string): void {
    this.config.conversationTurnId = turnId;
    this.config.intentId = intentId;
    this.config.runId = runId;
    this.config.runtimeOwnsTurnEnd = true;
    this.config.runtimeOwnsUserEntry = true;
    this.config.userEntryId = runUserEntryID(runId);
    this.#conversationTurnId = "";
    this.#conversationTurnOpen = false;
    this.#lastAssistantEntryId = "";
    this.#lastAssistantMessage = emptyMessage();
  }

  /**
   * buildFrozenPrompt builds the system prompt and tools once at construction
   * time, frozen for the session lifetime to maximize prompt cache hits (R2.1
   * of LLM_Agent_Cache.md).
   */
  buildFrozenPrompt(): void {
    const registry = this.#registry;
    if (registry === undefined) {
      this.#frozenSystemPrompt = "";
      this.#frozenToolDefs = [];
      this.#frozenToolNames = [];
      return;
    }
    let toolDefs = registry.modeTools(this.config.mode ?? "");
    const [webSearch, hasWebSearch] = configuredWebSearchToolDefinition(
      this.config.settings,
    );
    if (hasWebSearch) toolDefs = [...toolDefs, webSearch];
    const [responsesSearch, hasResponsesSearch] =
      openAIResponsesWebSearchToolDefinition(this.config.provider);
    if (hasResponsesSearch) toolDefs = [...toolDefs, responsesSearch];

    const toolNames: string[] = [];
    for (const t of toolDefs) {
      if (t.kind === "hosted") continue;
      toolNames.push(t.name);
    }
    const toolSnippets = registry.toolSnippets(toolNames);
    const toolGuidelines = registry.toolGuidelines(toolNames);
    const options: SystemPromptOptions = {
      toolExecutionMode: this.config.toolExecutionMode,
      maxToolConcurrency: this.config.maxToolConcurrency,
      authored: this.config.settings?.authored === true,
      expertIdentity: this.config.expertIdentity,
      expertRoster: this.config.expertRoster,
    };
    this.#frozenSystemPrompt = buildSystemPromptWithOptions(
      this.config.mode ?? "",
      toolNames,
      registry.getWorkDir(),
      this.config.ruleContent ?? "",
      this.config.extraContext ?? "",
      toolSnippets,
      toolGuidelines,
      this.config.multiAgent === true,
      this.config.delegateMode === true,
      this.config.workflows === true,
      options,
    );
    this.#frozenToolDefs = toolDefs;
    this.#frozenToolNames = toolNames;
  }

  /**
   * isToolRegisteredForRun is the execution-side half of tool registration. The
   * frozen list is derived from Registry.modeTools when the Agent is built. A
   * provider response is untrusted input: hiding a tool from its advertised
   * schema is not sufficient authorization to execute a hallucinated tool call.
   */
  isToolRegisteredForRun(name: string): boolean {
    if (name === "") return false;
    for (const registered of this.#frozenToolNames) {
      if (registered === name) return true;
    }
    return false;
  }

  /** The normalized per-batch local tool limit. */
  maxToolConcurrency(): number {
    const configured = this.config.maxToolConcurrency ?? 0;
    if (configured <= 0) return defaultToolExecutionMaxConcurrency;
    return configured;
  }

  /** The frozen system prompt built at construction time. */
  frozenSystemPrompt(): string {
    return this.#frozenSystemPrompt;
  }

  /** The frozen tool definitions built at construction time. */
  frozenToolDefinitions(): ToolDefinition[] {
    return [...this.#frozenToolDefs];
  }

  // --- History / context ---------------------------------------------------

  /** Loads historical messages into the agent context. */
  loadHistoryMessages(messages: Message[]): void {
    this.#loadHistoryStateLocked(messages, undefined);
  }

  /** Loads historical messages plus their session entry IDs. */
  loadHistoryState(messages: Message[], entryIds: string[]): void {
    this.#loadHistoryStateLocked(messages, entryIds);
  }

  #loadHistoryStateLocked(messages: Message[], entryIds?: string[]): void {
    this.#messages = [...this.#messages, ...messages];
    this.#context.messages = [...this.#context.messages, ...messages];
    if (entryIds !== undefined && entryIds.length === messages.length) {
      this.#messageIds = [...this.#messageIds, ...entryIds];
      return;
    }
    this.#messageIds = [...this.#messageIds, ...messages.map(() => "")];
  }

  /** Returns a copy of the current message history. */
  getMessages(): Message[] {
    return [...this.#messages];
  }

  /** Returns a copy of message history plus aligned session entry IDs. */
  getHistoryState(): [Message[], string[]] {
    return [[...this.#messages], [...this.#messageIds]];
  }

  /** Replaces the message history. */
  setMessages(msgs: Message[]): void {
    this.#messages = msgs;
    this.#messageIds = msgs.map(() => "");
    this.#context.messages = msgs;
  }

  /** Returns a copy of the current agent context. */
  getContext(): AgentContext | null {
    if (this.#context === null) return null;
    return {
      systemPrompt: this.#context.systemPrompt,
      messages: [...this.#context.messages],
      tools: [...this.#context.tools],
    };
  }

  /** Replaces the agent context. */
  setContext(ctx: AgentContext | null): void {
    this.#context = ctx ?? { systemPrompt: "", messages: [], tools: [] };
  }

  /** Sets one session entry ID at `index`, when in range. */
  setMessageId(index: number, id: string): void {
    if (index >= 0 && index < this.#messageIds.length) {
      this.#messageIds[index] = id;
    }
  }

  /**
   * GetContextUsage calculates the current context usage. Returns undefined
   * when no model or context window is available.
   */
  getContextUsage(): ContextUsage | undefined {
    const model = this.config.model;
    if (model === undefined) return undefined;
    const contextWindow = model.contextWindow;
    if (contextWindow <= 0) return undefined;
    const estimator = resolveTokenEstimator(
      this.config.compactionSettings ??
        { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
      model,
    );
    const usage = contextUsageFromMessages(this.#messages, estimator);
    usage.contextWindow = contextWindow;
    usage.percent = (usage.totalTokens / contextWindow) * 100;
    return usage;
  }

  /** Marks the agent for forced compaction on the next turn. */
  setForceCompact(): void {
    this.#forceCompact = true;
  }

  /** Reports whether forced compaction is pending and consumable. */
  canForceCompact(): boolean {
    return this.config.model !== undefined && this.#messages.length > 0;
  }

  /**
   * ShouldCompact checks if compaction should trigger. Returns true if forced
   * via setForceCompact and compaction is possible, otherwise falls back to the
   * automatic threshold check.
   */
  shouldCompact(): boolean {
    if (this.#forceCompact) {
      this.#forceCompact = false;
      return this.canForceCompact();
    }
    return this.shouldAutoCompact();
  }

  // --- Request assembly / compaction --------------------------------------

  /**
   * buildSessionContextMessage builds the [session context] message with
   * dynamic information (R2.3): dynamic info goes into a separate message
   * marked SystemInjected so cache markers skip it.
   */
  buildSessionContextMessage(): Message {
    let modelID = "unknown";
    let modelName = "unknown";
    const model = this.config.model;
    if (model !== undefined) {
      modelID = model.id;
      modelName = model.name;
    }
    const context = `[session context]
- Current date: ${localISODate()}
- Model: ${modelName} (${modelID})
- Working directory: ${this.#registry?.getWorkDir() ?? ""}
- Mode: ${this.config.mode ?? ""}
`;
    return newSystemInjectedUserMessage(context);
  }

  /** Returns the output-token reserve used by the request token budget. */
  outputReserveTokens(): number {
    let reserve = this.config.maxTokens ?? 0;
    if (reserve <= 0) {
      reserve = 16384;
    }
    const model = this.config.model;
    if (
      model !== undefined && model.contextWindow > 0 &&
      reserve >= model.contextWindow
    ) {
      return Math.floor(model.contextWindow / 2);
    }
    return reserve;
  }

  /**
   * requestTokenBudget returns `[budget, reserve, contextWindow, ok]` for the
   * input-token budget derived from the model context window.
   */
  requestTokenBudget(): [number, number, number, boolean] {
    const model = this.config.model;
    if (model === undefined || model.contextWindow <= 0) {
      return [0, 0, 0, false];
    }
    const contextWindow = model.contextWindow;
    const reserve = this.outputReserveTokens();
    let budget = contextWindow - reserve;
    if (budget <= 0) {
      budget = Math.floor(contextWindow / 2);
    }
    return [budget, reserve, contextWindow, true];
  }

  /** Builds the provider request messages including the session context. */
  buildRequestMessages(sessionContextMsg: Message): Message[] {
    const allMessages: Message[] = [sessionContextMsg, ...this.#messages];
    return repairDanglingToolCalls(allMessages);
  }

  /**
   * replaceLargestToolResultForContext replaces the largest compactable tool
   * result with a context-guard placeholder. Returns `[toolName, replaced]`.
   */
  replaceLargestToolResultForContext(
    estimatedTokens: number,
    budgetTokens: number,
    contextWindow: number,
    reserveTokens: number,
  ): [string, boolean] {
    const estimator = resolveTokenEstimator(
      this.config.compactionSettings ??
        { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
      this.config.model ?? null,
    );
    let bestIndex = -1;
    let bestTokens = 0;
    for (let i = 0; i < this.#messages.length; i++) {
      const msg = this.#messages[i];
      if (msg.role !== "toolResult" || isContextGuardToolResult(msg)) continue;
      const tokens = estimator.estimateTokens(msg);
      if (tokens > bestTokens) {
        bestIndex = i;
        bestTokens = tokens;
      }
    }
    if (bestIndex < 0) return ["", false];

    const original = this.#messages[bestIndex];
    this.#messages[bestIndex] = contextGuardToolResult(
      original,
      estimatedTokens,
      budgetTokens,
      contextWindow,
      reserveTokens,
    );
    if (this.#context.messages.length === this.#messages.length) {
      this.#context.messages[bestIndex] = this.#messages[bestIndex];
    } else {
      this.#context.messages = this.#messages;
    }
    return [original.toolName ?? "", true];
  }

  /**
   * maxTokensForRequest clamps the configured output limit so input + output +
   * the safety margin fits the model context window.
   */
  maxTokensForRequest(messages: Message[]): number {
    const maxTokens = this.config.maxTokens ?? 0;
    const model = this.config.model;
    if (model === undefined || model.contextWindow <= 0 || maxTokens <= 0) {
      return maxTokens;
    }
    const estimator = resolveTokenEstimator(
      this.config.compactionSettings ??
        { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
      model,
    );
    const estimatedTokens = estimateChatRequestTokens(
      this.#frozenSystemPrompt,
      messages,
      this.#frozenToolDefs,
      estimator,
    );
    return clampMaxTokensToContext(
      maxTokens,
      model.contextWindow,
      estimatedTokens,
    );
  }

  /**
   * previousCompactionSummary returns the persisted compaction summary, or the
   * newest `## Goal` system-injected message when none was persisted.
   */
  previousCompactionSummary(messages: Message[]): string {
    if (this.config.session !== undefined) {
      const compaction = this.config.session.getLatestCompaction();
      if (compaction !== null) return compaction.summary;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      if (
        messages[i].systemInjected === true && messages[i].role === "user" &&
        (messages[i].content ?? "").startsWith("## Goal")
      ) {
        return messages[i].content ?? "";
      }
    }
    return "";
  }

  /**
   * CanCompact reports whether the current conversation has older messages that
   * can be summarized while preserving the configured recent context.
   */
  canCompact(): boolean {
    const model = this.config.model;
    if (model === undefined) return false;
    const messages = [...this.#messages];
    return hasCompactableMessages(
      messages,
      model,
      this.config.compactionSettings ??
        { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
      this.previousCompactionSummary(messages),
    );
  }

  /** shouldAutoCompact reports whether the automatic threshold is exceeded. */
  shouldAutoCompact(): boolean {
    const settings = this.config.compactionSettings;
    const model = this.config.model;
    if (settings === undefined || !settings.enabled) return false;
    if (model === undefined || model.contextWindow <= 0) return false;
    const messages = this.buildRequestMessages(
      this.buildSessionContextMessage(),
    );
    const estimator = resolveTokenEstimator(settings, model);
    const tokens = estimateChatRequestTokens(
      this.#frozenSystemPrompt,
      messages,
      this.#frozenToolDefs,
      estimator,
    );
    if (
      !shouldCompactPercent(
        tokens,
        model.contextWindow,
        defaultAutoCompactionThreshold,
      )
    ) {
      return false;
    }
    return this.canCompact();
  }

  /** Appends a system-injected message to the run context only. */
  injectTransientMessage(msg: Message): void {
    this.#messages = [...this.#messages, msg];
    this.#messageIds = [...this.#messageIds, ""];
    this.#context.messages = [...this.#context.messages, msg];
  }

  // --- Abort / lifecycle ---------------------------------------------------

  /**
   * Abort signals the agent to stop processing. Satisfies both the internal and
   * public agent.Agent interface.
   */
  abort(): void {
    this.#abortController.abort();
  }

  /**
   * Aborted reports whether Abort has been called. Abort is one-shot and
   * permanent: once aborted the instance can never start another run.
   */
  aborted(): boolean {
    return this.#abortController.signal.aborted;
  }

  /** Returns a snapshot of the message history and a cloned context. */
  callbackSnapshot(): [Message[], AgentContext | null] {
    return [cloneMessages(this.#messages), cloneAgentContext(this.#context)];
  }

  /** Builds the canonical EventAgentEnd event carrying the message history. */
  agentEndEvent(): Event {
    return { type: EventAgentEnd, messages: [...this.#messages] };
  }

  /**
   * Stores the run context. A null context clears it and resets the
   * dropped-event counter.
   */
  setRunContext(ctx: RunContext | undefined): void {
    if (ctx === undefined) {
      this.runCtx = undefined;
      return;
    }
    this.droppedEvents = 0;
    this.runCtx = ctx;
  }

  /**
   * Reports dropped events. The Go implementation logs to stderr once a run
   * ends; a consumer that stopped reading must not silently swallow the fact
   * that events were abandoned.
   */
  logDroppedEvents(): void {
    if (this.droppedEvents > 0) {
      console.error(
        `[agent] run ${this.#id} dropped ${this.droppedEvents} event(s): the consumer stopped reading before the run ended`,
      );
    }
  }

  // --- Event pipeline ------------------------------------------------------

  /** Emits an event through this agent's sink, stamping the agent ID on it. */
  emit(ch: EventSink | undefined, event: Event): void {
    event.agentId = this.#id;
    this.sendEvent(ch, event);
  }

  /**
   * sendEvent delivers ev unless the run context is done. A consumer may stop
   * reading when a run is aborted, so a bare send would park the loop forever
   * and the run could never finish its terminal bookkeeping. Terminal events
   * are sent unconditionally by their callers; this method reports the drop
   * instead of blocking and counts it for logDroppedEvents.
   */
  sendEvent(ch: EventSink | undefined, ev: Event): boolean {
    if (ch === undefined) return false;
    const ctx = this.runCtx;
    if (ctx !== undefined && ctx.signal !== undefined && ctx.signal.aborted) {
      this.droppedEvents += 1;
      return false;
    }
    return ch(ev);
  }

  // --- Approval / question coordination ------------------------------------

  /**
   * NeedsApproval reports whether a tool call needs user approval under the
   * agent's current mode, allow rules, and settings.
   */
  needsApproval(toolName: string, args: Record<string, unknown>): boolean {
    return needsApproval(
      {
        mode: this.config.mode ?? "",
        allow: this.config.allow,
        settings: this.config.settings,
      },
      toolName,
      args,
    );
  }

  /**
   * RequestApproval sends an approval request and waits for the user's
   * response. It has no run-context cancellation and is kept for callers that
   * only have an event sink.
   */
  requestApproval(
    ch: EventSink | undefined,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    return this.requestToolApproval(undefined, ch, "", toolName, args);
  }

  /**
   * RequestToolApproval sends an approval request that retains the provider
   * call identity, allowing a durable server runtime to match a decision after
   * recovery. It resolves when the user responds, the agent aborts, or the run
   * context cancels.
   *
   * The approval ID embeds the agent ID so decision registries keyed by ID
   * (TUI/CLI/ACP durable decision records) stay unique when several agents of
   * one run raise their own first approval.
   */
  async requestToolApproval(
    ctx: RunContext | undefined,
    ch: EventSink | undefined,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    this.#approvalCounter += 1;
    const approvalId = `approval-${this.#id}-${this.#approvalCounter}`;
    const decision = new Promise<boolean>((resolve) => {
      this.#pendingApprovals.set(approvalId, resolve);
    });

    // The request event goes through the context-aware send so a cancelled run
    // stops here instead of parking on a sink whose consumer already stopped
    // reading.
    this.sendEvent(ch, {
      type: EventToolApprovalRequest,
      toolCallId,
      approvalId,
      approvalTool: toolName,
      approvalArgs: args,
    });

    const approved = await this.#raceCancellation(
      decision,
      false,
      ctx?.signal,
    );
    this.#pendingApprovals.delete(approvalId);
    return approved;
  }

  /** Processes the user's approval response. */
  handleApprovalResponse(approvalId: string, approved: boolean): void {
    const resolve = this.#pendingApprovals.get(approvalId);
    if (resolve !== undefined) {
      this.#pendingApprovals.delete(approvalId);
      resolve(approved);
    }
  }

  /**
   * RequestQuestion sends a question request and waits for the user's answer.
   * It resolves to an empty string when the agent is aborted or the context is
   * canceled, so unattended runtimes (e.g. channel sessions) never block a run
   * forever on an answer that cannot arrive.
   */
  async requestQuestion(
    ctx: RunContext | undefined,
    ch: EventSink | undefined,
    question: string,
    options: string[],
    context: string,
  ): Promise<string> {
    this.#questionCounter += 1;
    // The question ID embeds the agent ID for the same reason as approval IDs.
    const questionId = `question-${this.#id}-${this.#questionCounter}`;
    const decision = new Promise<string>((resolve) => {
      this.#pendingQuestions.set(questionId, resolve);
    });

    this.sendEvent(ch, {
      type: EventQuestionRequest,
      questionId,
      questionText: question,
      questionOptions: options,
      questionContext: context,
    });

    const answer = await this.#raceCancellation(decision, "", ctx?.signal);
    this.#pendingQuestions.delete(questionId);
    return answer;
  }

  /**
   * HandleQuestionResponse processes the user's answer to a question. It keeps
   * the silent contract for protocol adapters (an unknown or already resolved
   * ID is ignored); callers that answer on another agent's behalf must use
   * deliverQuestionAnswer so they never report a false success.
   */
  handleQuestionResponse(questionId: string, answer: string): void {
    this.deliverQuestionAnswer(questionId, answer);
  }

  /**
   * DeliverQuestionAnswer resolves a pending question and reports whether the
   * answer was actually delivered. Callers that answer on someone else's behalf
   * use the result to distinguish a delivered answer from a question that was
   * already resolved, expired, or never existed.
   */
  deliverQuestionAnswer(questionId: string, answer: string): boolean {
    if (questionId === "") return false;
    const resolve = this.#pendingQuestions.get(questionId);
    if (resolve === undefined) return false;
    this.#pendingQuestions.delete(questionId);
    resolve(answer);
    return true;
  }

  /**
   * AskQuestion implements the tools.QuestionAsker interface. It gets the event
   * channel from the run context and delegates to requestQuestion.
   */
  async askQuestion(
    ctx: RunContext | undefined,
    question: string,
    options: string[],
    explanation: string,
  ): Promise<string> {
    const [ch] = eventChanFromContext(ctx);
    if (ch === undefined) return "";
    return await this.requestQuestion(ctx, ch, question, options, explanation);
  }

  /**
   * Races a pending decision against agent abort and run-context cancellation,
   * resolving to `cancelled` when either fires. This is the TS projection of
   * Go's `select { case <-responseCh: ... case <-a.abort: ... case
   * <-ctx.Done(): }` in the request methods.
   */
  #raceCancellation<T>(
    decision: Promise<T>,
    cancelled: T,
    runSignal: AbortSignal | undefined,
  ): Promise<T> {
    const signals: AbortSignal[] = [this.#abortController.signal];
    if (runSignal !== undefined) signals.push(runSignal);
    for (const signal of signals) {
      if (signal.aborted) return Promise.resolve(cancelled);
    }
    let removeAbortListeners: (() => void) | undefined;
    const cancellation = new Promise<T>((resolve) => {
      const onAbort = () => resolve(cancelled);
      for (const signal of signals) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      removeAbortListeners = () => {
        for (const signal of signals) {
          signal.removeEventListener("abort", onAbort);
        }
      };
    });
    return Promise.race([decision, cancellation]).finally(() => {
      removeAbortListeners?.();
    });
  }

  // --- Output escalation ---------------------------------------------------

  /**
   * escalatedMaxTokens returns the escalated output ceiling, never exceeding a
   * known model's native output or context limit. Returns 0 when `current` is
   * already at/above the ceiling.
   */
  escalatedMaxTokens(current: number): number {
    let limit = escalatedOutputMaxTokens;
    const model = this.config.model;
    if (model !== undefined && model.maxTokens > 0) {
      limit = model.maxTokens;
    }
    if (
      model !== undefined && model.contextWindow > 0 &&
      limit > model.contextWindow
    ) {
      limit = model.contextWindow;
    }
    if (current >= limit) return 0;
    return limit;
  }

  // --- Image admission -----------------------------------------------------

  /** Reports whether the selected model supports image input. */
  supportsImages(): boolean {
    const model = this.config.model;
    if (model === undefined) return false;
    for (const input of model.input) {
      if (input === "image") return true;
    }
    return false;
  }

  /**
   * gateToolResultImages converts an image-bearing tool result into an explicit
   * tool error when the selected model cannot accept image input. This gate is
   * applied at the Agent Core boundary before persistence/provider conversion.
   */
  gateToolResultImages(
    content: string,
    contents: ContentBlock[],
    isError: boolean,
  ): [string, ContentBlock[] | undefined, boolean, Error | undefined] {
    if (this.supportsImages() || !containsImageContent(contents)) {
      return [content, contents, isError, undefined];
    }
    return [
      unsupportedImageToolResultMessage,
      undefined,
      true,
      new Error(unsupportedImageToolResultMessage),
    ];
  }

  /**
   * validateImageRequestBudget checks the final canonical messages before they
   * cross the provider boundary.
   */
  validateImageRequestBudget(messages: Message[]): Error | undefined {
    const budget = providerImageRequestBudget(
      this.config.provider ?? null,
      this.config.vendor ?? "",
    );
    if (budget.maxSingleBytes <= 0) return undefined;
    let imageCount = 0;
    let totalBytes = 0;
    for (const message of messages) {
      for (const block of message.contents ?? []) {
        if (block.type !== "image" || block.image === undefined) continue;
        imageCount += 1;
        const payloadBytes = encodedImagePayloadBytes(block.image);
        if (payloadBytes > budget.maxSingleBytes) {
          return new Error(
            `image request exceeds ${budget.maxSingleBytes}-byte provider limit: image ${imageCount} is ${payloadBytes} bytes (detail=${block.image.detail})`,
          );
        }
        totalBytes += payloadBytes;
      }
    }
    if (imageCount === 0) return undefined;
    if (budget.maxImages > 0 && imageCount > budget.maxImages) {
      return new Error(
        `image request contains ${imageCount} images, but provider limit is ${budget.maxImages}`,
      );
    }
    if (budget.maxTotalBytes > 0 && totalBytes > budget.maxTotalBytes) {
      return new Error(
        `image request payload exceeds ${budget.maxTotalBytes}-byte provider limit: ${totalBytes} bytes`,
      );
    }
    return undefined;
  }

  // --- Run entry points ----------------------------------------------------

  /** Processes a user message and streams events back. */
  run(userMsg: string, abort?: AbortSignal): AsyncIterable<Event> {
    return this.runWithUserMessage(newUserMessage(userMsg), abort);
  }

  /** Processes an already-built user message and streams events back. */
  runWithUserMessage(
    msg: Message,
    abort?: AbortSignal,
  ): AsyncIterable<Event> {
    const channel = new EventChannel();
    const ctx = newRunContext(abort);
    void this.#runUserMessageTask(ctx, msg, channel);
    return channel;
  }

  /** Processes with explicit message history. */
  runWithMessages(
    messages: Message[],
    abort?: AbortSignal,
  ): AsyncIterable<Event> {
    const channel = new EventChannel();
    const ctx = newRunContext(abort);
    void this.#runMessagesTask(ctx, messages, channel);
    return channel;
  }

  /**
   * Continues an Agent after the shared Runtime has loaded a persisted session
   * history. It deliberately does not append another user message.
   */
  runWithLoadedHistory(abort?: AbortSignal): AsyncIterable<Event> {
    const channel = new EventChannel();
    const ctx = newRunContext(abort);
    void this.#runLoadedHistoryTask(ctx, channel);
    return channel;
  }

  async #runUserMessageTask(
    ctx: RunContext,
    msg: Message,
    channel: EventChannel,
  ): Promise<void> {
    const sink: EventSink = (ev) => channel.push(ev);
    try {
      this.setRunContext(ctx);
      try {
        this.#lastAssistantEntryId = "";
        this.#lastAssistantMessage = emptyMessage();
        if (
          this.config.runtimeOwnsUserEntry === true &&
          this.config.session !== undefined
        ) {
          try {
            this.config.session.reload();
          } catch (err) {
            const cause = err instanceof Error ? err : new Error(String(err));
            this.#emitRunFinished(
              sink,
              TaskFailed,
              "session_reload",
              cause,
              undefined,
              undefined,
            );
            sink({
              type: EventError,
              error: new Error(
                `reload runtime-owned user entry: ${cause.message}`,
              ),
            });
            sink(this.agentEndEvent());
            return;
          }
        }
        if (!this.#beginConversationTurn(msg)) {
          this.#emitRunFinished(
            sink,
            TaskFailed,
            "turn_start",
            new Error("failed to start conversation turn"),
            undefined,
            undefined,
          );
          sink(this.agentEndEvent());
          return;
        }
        if (msg.role === "") msg.role = "user";
        if (msg.timestamp === undefined || msg.timestamp.getTime() === 0) {
          msg.timestamp = new Date();
        }
        const [normalized] = normalizeMessage(msg);
        let msgIndex = this.#messages.length;
        const userEntryLoaded = this.config.runtimeOwnsUserEntry === true &&
          (this.config.userEntryId ?? "") !== "" &&
          msgIndex > 0 && this.#messageIds.length === msgIndex &&
          this.#messageIds[msgIndex - 1] === this.config.userEntryId;
        if (userEntryLoaded) {
          msgIndex--;
        } else {
          this.#messages = [...this.#messages, normalized];
          const entryId = this.config.runtimeOwnsUserEntry === true
            ? (this.config.userEntryId ?? "")
            : "";
          this.#messageIds = [...this.#messageIds, entryId];
          this.#context.messages = [...this.#context.messages, normalized];
        }
        if (
          this.config.session !== undefined &&
          this.config.runtimeOwnsUserEntry !== true
        ) {
          let msgId: string;
          try {
            msgId = this.config.session.appendMessage(normalized);
          } catch (err) {
            const cause = err instanceof Error ? err : new Error(String(err));
            this.#emitRunFinished(
              sink,
              TaskFailed,
              "session_save",
              cause,
              undefined,
              undefined,
            );
            sink({
              type: EventError,
              error: new Error(
                `save user message to session: ${cause.message}`,
              ),
            });
            sink(this.agentEndEvent());
            return;
          }
          this.setMessageId(msgIndex, msgId);
        }
        await this.loop(ctx, sink);
        this.logDroppedEvents();
      } finally {
        this.setRunContext(undefined);
      }
    } finally {
      channel.close();
    }
  }

  async #runMessagesTask(
    ctx: RunContext,
    messages: Message[],
    channel: EventChannel,
  ): Promise<void> {
    const sink: EventSink = (ev) => channel.push(ev);
    try {
      const normalized = messages.map((m) => normalizeMessage(m)[0]);
      this.#messages = normalized;
      this.#messageIds = normalized.map(() => "");
      this.#context.messages = normalized;
      await this.loop(ctx, sink);
      this.logDroppedEvents();
    } finally {
      channel.close();
    }
  }

  async #runLoadedHistoryTask(
    ctx: RunContext,
    channel: EventChannel,
  ): Promise<void> {
    const sink: EventSink = (ev) => channel.push(ev);
    try {
      if (!this.#beginConversationTurnForRun()) {
        this.#emitRunFinished(
          sink,
          TaskFailed,
          "turn_start",
          new Error("failed to start conversation turn"),
          undefined,
          undefined,
        );
        sink(this.agentEndEvent());
        return;
      }
      await this.loop(ctx, sink);
      this.logDroppedEvents();
    } finally {
      channel.close();
    }
  }

  /**
   * Emits the single canonical terminal event for this run. It must be emitted
   * exactly once per run, immediately before EventAgentEnd.
   */
  #emitRunFinished(
    ch: EventSink,
    status: TaskStatus,
    reason: string,
    runErr: Error | undefined,
    usage: Usage | undefined,
    attachments: Attachment[] | undefined,
  ): void {
    const turnId = this.#conversationTurnId;
    const turnOpen = this.#conversationTurnOpen;
    const assistantEntryId = this.#lastAssistantEntryId;
    const assistantMessage = { ...this.#lastAssistantMessage };
    if (turnOpen && this.config.runtimeOwnsTurnEnd !== true) {
      this.#conversationTurnOpen = false;
    }
    if (turnOpen && this.config.session !== undefined) {
      let turnStatus = "failed";
      switch (status) {
        case TaskSuccess:
          turnStatus = "completed";
          break;
        case TaskCanceled:
          turnStatus = "cancelled";
          break;
        case TaskIncomplete:
          turnStatus = "incomplete";
          break;
      }
      try {
        this.config.session.endConversationTurn(turnId, turnStatus, reason);
      } catch (err) {
        console.error(
          `[agent] failed to close conversation turn ${turnId}: ${err}`,
        );
      }
    }
    ch({
      type: EventRunFinished,
      done: true,
      status,
      stopReason: reason,
      error: runErr,
      assistantEntryId,
      assistantMessage,
      usage,
      attachments,
      contextUsage: this.getContextUsage(),
    });
  }

  /**
   * Appends adapter-supplied follow-up messages and reports whether the loop
   * must continue. Messages follow the same in-memory delivery contract as
   * mid-run steering.
   */
  async #injectFollowUpMessages(
    ctx: RunContext,
    ch: EventSink,
  ): Promise<boolean> {
    if (this.config.getFollowUpMessages === undefined) return false;
    const messages = (await this.config.getFollowUpMessages(ctx)) ?? [];
    if (messages.length === 0) return false;
    for (const msg of messages) {
      this.sendEvent(ch, { type: EventMessageStart, message: msg });
      this.sendEvent(ch, { type: EventMessageEnd, message: msg });
      this.#messages = [...this.#messages, msg];
      this.#messageIds = [...this.#messageIds, ""];
      this.#context.messages = [...this.#context.messages, msg];
    }
    return true;
  }

  #beginConversationTurn(msg: Message): boolean {
    if (
      this.config.session === undefined ||
      this.config.conversationTurn !== true ||
      msg.systemInjected === true
    ) {
      return true;
    }
    return this.#beginConversationTurnForRun();
  }

  #beginConversationTurnForRun(): boolean {
    if (
      this.config.session === undefined ||
      this.config.conversationTurn !== true
    ) {
      return true;
    }
    let turnId = this.config.conversationTurnId ?? "";
    if (turnId === "") turnId = "turn-" + generateID();
    try {
      this.config.session.startConversationTurn(
        turnId,
        this.config.intentId ?? "",
        this.config.runId ?? "",
      );
    } catch {
      return false;
    }
    this.#conversationTurnId = turnId;
    this.#conversationTurnOpen = true;
    return true;
  }

  /**
   * Runs a summarization request through a child Agent loop. This deliberately
   * avoids constructing a provider request here: the child uses the same
   * provider implementation and model compatibility logic as every other
   * sub-agent.
   */
  async summarizeMessagesWithSubAgent(
    signal: AbortSignal | undefined,
    messages: Message[],
    maxTokens: number,
  ): Promise<string> {
    const workDir = workDirForAgent(this);
    const registry = newRegistry(workDir, newNoneSandbox());
    let model = this.config.model;
    if (model !== undefined) model = { ...model, contextWindow: 0 };
    const child = newAgentWithLoopConfig({
      provider: this.config.provider,
      vendor: this.config.vendor,
      model,
      mode: this.config.mode,
      thinkingLevel: this.config.thinkingLevel,
      maxTokens,
      compactionSettings: emptyCompactionSettings,
      maxIterations: 1,
      toolExecutionMode: "sequential",
    }, registry);
    child.#frozenSystemPrompt = this.#frozenSystemPrompt;
    child.#frozenToolDefs = [];
    child.#context.systemPrompt = this.#frozenSystemPrompt;
    child.#context.tools = [];
    let summary = "";
    for await (const event of child.runWithMessages(messages, signal)) {
      if (event.type === EventTextDelta) {
        summary += event.textDelta ?? "";
      } else if (event.type === EventError) {
        if (event.error !== undefined) throw event.error;
      }
    }
    const result = summary.trim();
    if (result === "") {
      throw new Error("tool result summarization returned empty result");
    }
    return result;
  }

  // --- Background Responses requests ---------------------------------------

  /**
   * Creates one durable Responses background request without entering the Agent
   * loop. The caller owns the remote response lifecycle and must not use this as
   * a substitute for runWithUserMessage.
   */
  buildBackgroundChatParams(localTurnId: string, msg: Message): ChatParams {
    return this.#buildBackgroundChatParams(localTurnId, msg);
  }

  /**
   * Builds a durable Responses continuation request from already-loaded local
   * history. It does not append a synthetic user message, which is important
   * when a process resumes a remote run.
   */
  buildBackgroundContinuationParams(localTurnId: string): ChatParams {
    return this.#buildBackgroundChatParams(localTurnId, undefined);
  }

  /**
   * Builds a background request from the local Responses archive, explicitly
   * dropping remote lineage. It is used when a continuation proves that the
   * remote response/conversation state is no longer available.
   */
  buildBackgroundReplayParams(localTurnId: string): ChatParams {
    const params = this.#buildBackgroundChatParams(localTurnId, undefined);
    const session = this.config.session;
    if (session === undefined || params.responseOptions === undefined) {
      return params;
    }
    // The background coordinator appends tool calls/results to the durable
    // session manager while the detached agent remains unchanged. Read the
    // latest session messages so replay includes the failed continuation.
    const state = session.getReplayState();
    if (state.messages.length > 0) {
      params.messages = [...state.messages];
    }
    let items: unknown[];
    try {
      items = this.nativeResponsesReplayItems(params.messages);
    } catch (err) {
      throw new Error(
        `load Responses background replay state: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    params.responseOptions.previousResponseId = "";
    params.responseOptions.replayItems = items;
    params.responseOptions.suppressConversation = true;
    return params;
  }

  /**
   * Delegates remote state classification to the configured provider without
   * exposing provider-specific types to callers.
   */
  responsesStateFallbackError(err: unknown): boolean {
    const fallback = responseStateFallbackOf(this.config.provider);
    return fallback !== undefined && fallback.responseStateFallbackError(err);
  }

  #buildBackgroundChatParams(
    localTurnId: string,
    newMessage: Message | undefined,
  ): ChatParams {
    const provider = this.config.provider;
    const model = this.config.model;
    if (provider === undefined || model === undefined) {
      throw new Error("agent provider and model are required");
    }
    let messages = [...this.#messages];
    const systemPrompt = this.#frozenSystemPrompt;
    const tools = [...this.#frozenToolDefs];
    if (newMessage !== undefined) {
      const msg: Message = { ...newMessage };
      if (msg.role === "") msg.role = "user";
      if (msg.timestamp === undefined || msg.timestamp.getTime() === 0) {
        msg.timestamp = new Date();
      }
      messages = [...messages, msg];
    }
    messages = [...messages, this.buildSessionContextMessage()];
    messages = applyCacheMarkers(messages, selectCacheMarkers(messages));
    const params: ChatParams = {
      messages,
      tools,
      systemPrompt,
      thinkingLevel: normalizeThinkingLevel(this.config.thinkingLevel ?? ""),
      maxTokens: this.maxTokensForRequest(messages),
      temperature: model.temperature,
      topP: model.topP,
      modelId: model.id ?? "",
      abort: this.#abortController.signal,
    };
    const session = this.config.session;
    if (session === undefined || provider.api() !== "openai-responses") {
      return params;
    }
    let state: ResponsesStateSnapshot;
    try {
      state = this.prepareResponsesState(localTurnId, messages, false);
    } catch (err) {
      throw new Error(
        `prepare Responses background state: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    params.responseOptions = {
      previousResponseId: state.previousResponseId,
      replayItems: state.replayItems,
      suppressConversation: state.suppressConversation,
    };
    return params;
  }

  /**
   * Runs one local function tool through the same approval, sandbox and
   * execution-record path as the normal agent loop. The returned event stream is
   * owned by the caller, which may publish approval and progress events while
   * waiting for the result.
   */
  executeBackgroundToolCall(
    ctx: RunContext | undefined,
    tc: ToolCallBlock,
    localTurnId: string,
  ): AsyncIterable<Event> {
    return this.#executeBackgroundToolCall(ctx, tc, localTurnId, false, null);
  }

  /**
   * Reopens only known read-only tool records left in an interrupted state.
   * Side-effecting records stay guarded by the normal idempotency path and are
   * never retried automatically.
   */
  executeBackgroundToolCallRecovering(
    ctx: RunContext | undefined,
    tc: ToolCallBlock,
    localTurnId: string,
  ): AsyncIterable<Event> {
    return this.#executeBackgroundToolCall(ctx, tc, localTurnId, true, null);
  }

  /**
   * Runs one call of a background batch that reports its starts in the declared
   * provider order. allowReadOnlyRecovery keeps the normal and recovering entry
   * points available to batch callers, and launch carries the batch position
   * (null executes unordered, as before).
   */
  executeBackgroundToolCallOrdered(
    ctx: RunContext | undefined,
    tc: ToolCallBlock,
    localTurnId: string,
    allowReadOnlyRecovery: boolean,
    launch: ToolLaunchHandle | null,
  ): AsyncIterable<Event> {
    return this.#executeBackgroundToolCall(
      ctx,
      tc,
      localTurnId,
      allowReadOnlyRecovery,
      launch,
    );
  }

  #executeBackgroundToolCall(
    ctx: RunContext | undefined,
    tc: ToolCallBlock,
    localTurnId: string,
    allowReadOnlyRecovery: boolean,
    launch: ToolLaunchHandle | null,
  ): AsyncIterable<Event> {
    const channel = new EventChannel();
    const sink: EventSink = (ev) => channel.push(ev);
    const runCtx = contextWithEventChan(ctx, sink);
    void (async () => {
      try {
        await this.executeSingleToolCallWithRecovery(
          runCtx,
          tc,
          localTurnId,
          sink,
          allowReadOnlyRecovery,
          launch,
        );
      } finally {
        channel.close();
      }
    })();
    return channel;
  }

  /**
   * Builds and guards the request message list, omitting oversized tool results
   * until the estimated request fits the input budget.
   */
  prepareRequestMessages(
    sessionContextMsg: Message,
    ch: EventSink,
  ): [Message[] | null, Error | null] {
    const [budgetTokens, reserveTokens, contextWindow, ok] = this
      .requestTokenBudget();
    if (!ok) return [this.buildRequestMessages(sessionContextMsg), null];
    const estimator = resolveTokenEstimator(
      this.config.compactionSettings ?? emptyCompactionSettings,
      this.config.model ?? null,
    );
    for (let attempts = 0; attempts < 16; attempts++) {
      const messages = this.buildRequestMessages(sessionContextMsg);
      const estimatedTokens = estimateGuardRequestTokens(
        this.#frozenSystemPrompt,
        messages,
        this.#frozenToolDefs,
        estimator,
      );
      if (estimatedTokens <= budgetTokens) return [messages, null];
      const [toolName, replaced] = this.replaceLargestToolResultForContext(
        estimatedTokens,
        budgetTokens,
        contextWindow,
        reserveTokens,
      );
      if (!replaced) {
        return [
          null,
          new Error(
            `estimated request tokens ${estimatedTokens} exceed input budget ${budgetTokens} for context window ${contextWindow} (reserved output: ${reserveTokens}). Narrow the request or reduce context before retrying`,
          ),
        ];
      }
      this.sendEvent(ch, {
        type: EventStatus,
        statusMessage: `Context guard omitted oversized ${
          toolName === "" ? "tool" : toolName
        } output; asking model to retry with a narrower scope.`,
      });
    }
    return [
      null,
      new Error(
        "estimated request still exceeds context after omitting oversized tool outputs",
      ),
    ];
  }

  /** Compacts context when forced or when the automatic threshold is crossed. */
  async compactIfNeeded(ctx: RunContext, ch: EventSink): Promise<void> {
    if (this.#forceCompact) {
      this.#forceCompact = false;
      if (this.canForceCompact()) await this.compact(ctx, ch, true);
      return;
    }
    if (this.shouldAutoCompact()) await this.compact(ctx, ch, false);
  }

  /** Performs context compaction using the Insert-then-Compress pattern. */
  async compact(
    ctx: RunContext,
    ch: EventSink,
    force: boolean,
  ): Promise<Error | undefined> {
    const model = this.config.model;
    const provider = this.config.provider;
    if (model === undefined || provider === undefined) {
      return new Error("no model set for compaction");
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    const signals: AbortSignal[] = [this.#abortController.signal];
    if (ctx.signal !== undefined) signals.push(ctx.signal);
    for (const signal of signals) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const removeListeners = () => {
      for (const signal of signals) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    this.sendEvent(ch, { type: EventCompactionStart });
    const msgs = [...this.#messages];
    const msgIds = [...this.#messageIds];
    const previousSummary = this.previousCompactionSummary(msgs);
    try {
      const result = await compactWithOptions(
        controller.signal,
        msgs,
        provider,
        model,
        this.#frozenSystemPrompt,
        this.#frozenToolDefs,
        this.config.compactionSettings ?? emptyCompactionSettings,
        previousSummary,
        {
          force,
          thinkingLevel: normalizeThinkingLevel(
            this.config.thinkingLevel ?? "",
          ),
          temperature: model.temperature,
          topP: model.topP,
          summarize: (
            signal: AbortSignal | undefined,
            summaryMessages: Message[],
            maxTokens: number,
          ) =>
            this.summarizeMessagesWithSubAgent(
              signal,
              summaryMessages,
              maxTokens,
            ),
        },
      );
      removeListeners();
      const firstKeptEntryId = result.firstKeptIndex >= 0 &&
          result.firstKeptIndex < msgIds.length
        ? msgIds[result.firstKeptIndex]
        : "";
      const summaryMsg = newSystemInjectedUserMessage(result.summary);
      const keptMessages = cloneMessagesWithoutUsage(
        msgs.slice(result.firstKeptIndex),
      );
      const newMessages = [summaryMsg, ...keptMessages];
      this.#messages = newMessages;
      this.#context.messages = newMessages;
      const newIds: string[] = [""];
      if (result.firstKeptIndex >= 0) {
        newIds.push(...msgIds.slice(result.firstKeptIndex));
      }
      this.#messageIds = newIds;
      if (this.config.session !== undefined) {
        try {
          this.config.session.appendCompaction(
            result.summary,
            firstKeptEntryId,
            result.tokensBefore,
          );
        } catch (err) {
          this.sendEvent(ch, {
            type: EventStatus,
            statusMessage: `Failed to persist compaction: ${
              (err as Error).message
            }`,
          });
        }
      }
      this.sendEvent(ch, {
        type: EventCompactionEnd,
        statusMessage: `Context compacted: ${result.tokensBefore} tokens`,
      });
      return undefined;
    } catch (err) {
      removeListeners();
      const cause = err instanceof Error ? err : new Error(String(err));
      if (
        controller.signal.aborted ||
        (cause instanceof DOMException && cause.name === "AbortError")
      ) {
        this.sendEvent(ch, {
          type: EventCompactionEnd,
          statusMessage: "Context compaction canceled",
          stopReason: "canceled",
        });
        return cause;
      }
      this.sendEvent(ch, { type: EventCompactionEnd, error: cause });
      return new Error(`compaction failed: ${cause.message}`);
    }
  }

  /**
   * Attempts a one-shot recovery when a request cannot be sent because it
   * exceeds the model context window.
   */
  async tryRecoverContextOverflow(
    ctx: RunContext,
    ch: EventSink,
    state: LoopRecoveryState,
    cause: Error,
  ): Promise<boolean> {
    if (
      state.contextOverflowRetried ||
      !(this.config.compactionSettings?.enabled ?? false) ||
      !this.canForceCompact()
    ) {
      return false;
    }
    state.contextOverflowRetried = true;
    this.sendEvent(ch, {
      type: EventStatus,
      statusMessage:
        `Context too large (${cause.message}); compacting context and retrying...`,
    });
    const err = await this.compact(ctx, ch, true);
    if (err !== undefined) {
      this.sendEvent(ch, {
        type: EventStatus,
        statusMessage:
          `Context compaction failed (${err.message}); dropping oldest messages to fit the context window...`,
      });
      this.truncateHistoryForOverflow(ch);
    }
    return true;
  }

  /**
   * Removes image blocks from the in-memory conversation and returns the number
   * of images removed plus the durable overrides to persist.
   */
  stripRefusedImages(
    detail: string,
    stripAll: boolean,
  ): [number, ContentOverride[]] {
    const start = stripAll ? 0 : lastUserTurnIndex(this.#messages);
    const messages = [...this.#messages];
    const messageIds = [...this.#messageIds];
    const overrides: ContentOverride[] = [];
    let removed = 0;
    for (let i = start; i < messages.length; i++) {
      const [stripped, count] = stripImagesFromMessage(messages[i], detail);
      if (count === 0) continue;
      messages[i] = stripped;
      removed += count;
      if (i < messageIds.length && messageIds[i] !== "") {
        overrides.push({ entryId: messageIds[i], message: stripped });
      }
    }
    if (removed > 0) {
      this.#messages = messages;
      this.#messageIds = messageIds;
      this.#context.messages = [...messages];
    }
    return [removed, overrides];
  }

  /**
   * Recovers a turn whose provider permanently refused content (typically an
   * image flagged by content inspection). Returns true when the caller should
   * retry the turn.
   */
  tryRecoverContentRejection(
    ch: EventSink,
    state: LoopRecoveryState,
    hasVisibleOutput: boolean,
    cause: Error | undefined,
  ): boolean {
    if (cause === undefined || !isContentRejectionError(cause)) return false;
    const detail = retryErrorDetail(cause);
    while (state.contentRejectionStage < maxContentRejectionStages) {
      state.contentRejectionStage += 1;
      const stripAll =
        state.contentRejectionStage >= maxContentRejectionStages ||
        hasVisibleOutput;
      const [removed, overrides] = this.stripRefusedImages(detail, stripAll);
      if (removed === 0) continue;
      for (const o of overrides) {
        if (this.config.session === undefined) break;
        try {
          this.config.session.appendContentOverride(
            o.entryId,
            o.message,
            detail,
            "",
          );
        } catch (err) {
          this.sendEvent(ch, {
            type: EventStatus,
            statusMessage:
              `Warning: failed to persist image removal for entry ${o.entryId}: ${
                (err as Error).message
              }`,
          });
        }
      }
      const scope = stripAll ? "the whole conversation" : "this turn";
      if (hasVisibleOutput) {
        this.sendEvent(ch, {
          type: EventStatus,
          statusMessage:
            `The provider rejected ${removed} image(s) during content inspection and removed them from ${scope}; the current turn cannot be safely retried because it already produced output.`,
        });
        return false;
      }
      this.sendEvent(ch, {
        type: EventStatus,
        statusMessage:
          `The provider rejected ${removed} image(s) during content inspection; removed them from ${scope} and retrying without them.`,
      });
      this.sendEvent(ch, {
        type: EventRetry,
        retryAttempt: state.contentRejectionStage,
        retryMaxAttempts: maxContentRejectionStages,
        retryReason: "content_rejected",
      });
      return true;
    }
    return false;
  }

  /** Retries a stalled provider stream that produced no visible output yet. */
  async tryRetryStreamTimeout(
    ctx: RunContext,
    ch: EventSink,
    state: LoopRecoveryState,
    maxRetries: number,
    textContent: string,
    thinkContent: string,
    cause: Error | undefined,
  ): Promise<boolean> {
    if (cause === undefined) return false;
    if (maxRetries > 0 && state.streamTimeoutRetries >= maxRetries) {
      return false;
    }
    if (!isStreamTimeoutError(cause)) return false;
    if (textContent !== "" || thinkContent !== "") return false;
    state.streamTimeoutRetries += 1;
    let msg =
      `⚠️ 供应商响应超时（长时间未收到数据），正在自动重试第 ${state.streamTimeoutRetries} 次…`;
    if (maxRetries > 0) {
      msg =
        `⚠️ 供应商响应超时（长时间未收到数据），正在自动重试第 ${state.streamTimeoutRetries}/${maxRetries} 次…`;
    }
    const delay = streamRecoveryRetryDelay(state.streamTimeoutRetries);
    this.sendEvent(ch, { type: EventStatus, statusMessage: msg });
    this.sendEvent(ch, {
      type: EventRetry,
      retryAttempt: state.streamTimeoutRetries,
      retryMaxAttempts: maxRetries,
      retryAfterMs: delay,
      retryReason: "timeout",
    });
    return await waitForStreamRecoveryRetry(ctx.signal, delay);
  }

  /**
   * Continues a turn whose provider stream failed with a transient transport
   * error after retries were unavailable or exhausted.
   */
  async tryContinueStreamFailure(
    ctx: RunContext,
    ch: EventSink,
    state: LoopRecoveryState,
    maxRetries: number,
    textContent: string,
    thinkContent: string,
    thinkSignature: string,
    toolCalls: ToolCallBlock[],
    cause: Error | undefined,
  ): Promise<boolean> {
    if (cause === undefined) return false;
    const streamTimeout = isStreamTimeoutError(cause);
    if (
      !streamTimeout && maxRetries > 0 &&
      state.streamFailureRetries >= maxRetries
    ) {
      return false;
    }
    if (ctx.signal?.aborted === true) return false;
    if (toolCalls.length > 0 || isContextOverflowError(cause)) return false;
    if (streamTimeout && textContent === "" && thinkContent === "") {
      return false;
    }
    if (!streamTimeout && !isRetryable(cause, 0)) return false;
    state.streamFailureRetries += 1;

    const partialContents: ContentBlock[] = [];
    if (thinkContent !== "" && thinkSignature !== "") {
      partialContents.push({
        type: "thinking",
        thinking: thinkContent,
        signature: thinkSignature,
      });
    }
    if (textContent !== "") {
      partialContents.push({ type: "text", text: textContent });
    }
    if (partialContents.length > 0) {
      for (const block of partialContents) {
        state.recoveryAssistantContents.push(cloneContentBlock(block));
      }
      const partial = newAssistantMessage(partialContents);
      const recovery = newSystemInjectedUserMessage(
        buildStreamRecoveryMessage(textContent),
      );
      this.#messages = [...this.#messages, partial, recovery];
      this.#messageIds = [...this.#messageIds, "", ""];
      this.#context.messages = [...this.#context.messages, partial, recovery];
    }
    let retryMaxAttempts = maxRetries;
    if (streamTimeout) retryMaxAttempts = 0;
    const delay = streamRecoveryRetryDelay(state.streamFailureRetries);
    this.sendEvent(ch, {
      type: EventStatus,
      statusMessage: retryCompatibilityStatus(
        state.streamFailureRetries,
        retryMaxAttempts,
        delay,
      ),
      retryStatus: true,
      retryAttempt: state.streamFailureRetries,
      retryMaxAttempts,
      retryAfterMs: delay,
    });
    this.sendEvent(ch, {
      type: EventRetry,
      statusMessage: retryErrorDetail(cause),
      retryAttempt: state.streamFailureRetries,
      retryMaxAttempts,
      retryAfterMs: delay,
      retryReason: "stream_interrupted",
      retryContinue: partialContents.length > 0,
    });
    return await waitForStreamRecoveryRetry(ctx.signal, delay);
  }

  /**
   * Drops the oldest messages, cutting only at user/assistant turn boundaries,
   * until the estimated request fits a safe share of the context budget.
   */
  truncateHistoryForOverflow(ch: EventSink): void {
    const msgs = [...this.#messages];
    const msgIds = [...this.#messageIds];
    if (msgs.length === 0) return;
    const estimator = resolveTokenEstimator(
      this.config.compactionSettings ?? emptyCompactionSettings,
      this.config.model ?? null,
    );
    const tokensBefore = estimateChatRequestTokens(
      this.#frozenSystemPrompt,
      msgs,
      this.#frozenToolDefs,
      estimator,
    );
    let target = 0;
    const [budget, , , ok] = this.requestTokenBudget();
    if (ok) target = Math.trunc(budget * 0.6);
    const fits = (candidate: Message[]): boolean =>
      target > 0 &&
      estimateChatRequestTokens(
          this.#frozenSystemPrompt,
          candidate,
          this.#frozenToolDefs,
          estimator,
        ) <= target;
    let cut = -1;
    for (let i = 1; i < msgs.length; i++) {
      if (msgs[i].role !== "user" && msgs[i].role !== "assistant") continue;
      if (
        this.config.session !== undefined &&
        (i >= msgIds.length || msgIds[i] === "")
      ) {
        continue;
      }
      if (fits(msgs.slice(i))) {
        cut = i;
        break;
      }
    }
    if (cut < 0) {
      for (let i = msgs.length - 1; i >= 1; i--) {
        if (msgs[i].role !== "user" && msgs[i].role !== "assistant") continue;
        if (
          this.config.session !== undefined &&
          (i >= msgIds.length || msgIds[i] === "")
        ) {
          continue;
        }
        cut = i;
        break;
      }
    }
    if (cut < 0) return;
    const kept = cloneMessagesWithoutUsage(msgs.slice(cut));
    const note =
      `[Context recovery] The provider rejected the request for exceeding the context window and automatic summarization failed, so ${cut} older messages were dropped without a summary to recover. Earlier context is no longer available.`;
    const newMessages = [newSystemInjectedUserMessage(note), ...kept];
    const newIds: string[] = [""];
    if (cut < msgIds.length) newIds.push(...msgIds.slice(cut));
    this.#messages = newMessages;
    this.#context.messages = newMessages;
    this.#messageIds = newIds;
    if (this.config.session !== undefined) {
      const firstKeptEntryId = cut < msgIds.length ? msgIds[cut] : "";
      try {
        this.config.session.appendCompaction(
          note,
          firstKeptEntryId,
          tokensBefore,
        );
      } catch (err) {
        this.sendEvent(ch, {
          type: EventStatus,
          statusMessage: `Failed to persist context recovery: ${
            (err as Error).message
          }`,
        });
      }
    }
    this.sendEvent(ch, {
      type: EventStatus,
      statusMessage:
        `Context recovery: dropped ${cut} oldest messages after provider context overflow`,
    });
  }

  // --- Responses remote state ---------------------------------------------

  #emptyResponsesState(): ResponsesStateSnapshot {
    return {
      previousResponseId: "",
      replayItems: [],
      suppressConversation: false,
      remoteStateActive: false,
      version: 0,
    };
  }

  prepareResponsesState(
    _localTurnId: string,
    messages: Message[],
    forceReplay: boolean,
  ): ResponsesStateSnapshot {
    const session = this.config.session;
    if (session === undefined) return this.#emptyResponsesState();
    const header = session.getHeader();
    if (header === null || header.id === "") {
      throw new Error("Responses archive requires an initialized session");
    }
    const modeProvider = responseStateModeOf(this.config.provider);
    if (modeProvider === undefined) return this.#emptyResponsesState();
    const mode = modeProvider.responseStateMode();
    if (forceReplay || mode === "replay") {
      let items: unknown[] = [];
      try {
        items = this.nativeResponsesReplayItems(messages);
      } catch (err) {
        throw new Error(
          `load Responses replay items: ${(err as Error).message}`,
        );
      }
      return {
        previousResponseId: "",
        replayItems: items,
        suppressConversation: forceReplay && mode === "conversation",
        remoteStateActive: false,
        version: 0,
      };
    }
    if (mode === "conversation") {
      return {
        previousResponseId: "",
        replayItems: [],
        suppressConversation: false,
        remoteStateActive: true,
        version: 0,
      };
    }
    if (mode !== "previous_response_id") return this.#emptyResponsesState();
    const state = getResponseSessionState(session.getSessionDir(), header.id);
    if (state === null || state.previousResponseId === "") {
      return this.#emptyResponsesState();
    }
    return {
      previousResponseId: state.previousResponseId,
      replayItems: [],
      suppressConversation: false,
      remoteStateActive: true,
      version: state.version,
    };
  }

  nativeResponsesReplayItems(messages: Message[]): unknown[] {
    const maxNativeReplayItemBytes = 128 * 1024;
    const session = this.config.session;
    if (session === undefined) return [];
    const header = session.getHeader();
    if (header === null || header.id === "") return [];
    let turns;
    try {
      turns = listResponseReplayTurns(session.getSessionDir(), header.id, 500);
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (turns.length === 0) return [];
    let assistantCount = 0;
    for (const message of messages) {
      if (message.role === "assistant") assistantCount++;
    }
    if (assistantCount !== turns.length) return [];
    const items: unknown[] = [];
    let turnIndex = 0;
    for (const message of messages) {
      if (message.role === "assistant") {
        for (const item of turns[turnIndex].items) {
          if (JSON.stringify(item).length > maxNativeReplayItemBytes) return [];
          items.push(item);
        }
        turnIndex++;
      } else if (message.role === "toolResult") {
        const [output, ok] = replayTextContent(message);
        if (!ok || (message.toolCallId ?? "") === "") return [];
        const raw = {
          type: "function_call_output",
          call_id: message.toolCallId,
          output,
        };
        if (JSON.stringify(raw).length > maxNativeReplayItemBytes) return [];
        items.push(raw);
      } else {
        const [text, ok] = replayTextContent(message);
        if (!ok) return [];
        let role = message.role;
        if (role === "") role = "user";
        const raw = {
          type: "message",
          role,
          content: [{ type: "input_text", text }],
        };
        if (JSON.stringify(raw).length > maxNativeReplayItemBytes) return [];
        items.push(raw);
      }
    }
    return items;
  }

  responseArchiveSink(
    localTurnId: string,
    expectedStateVersion: number,
  ): (archive: ResponseArchive) => void {
    return (archive: ResponseArchive) => {
      const session = this.config.session;
      const provider = this.config.provider;
      if (session === undefined || provider === undefined) return;
      const header = session.getHeader();
      if (header === null || header.id === "") return;
      const sessionDir = session.getSessionDir();
      const now = new Date();
      const responseSummaryFields: Record<string, unknown> = {
        responseId: archive.responseId,
        status: archive.status,
        itemCount: archive.items.length,
        incompleteReason: archive.incompleteReason,
        attachments: archive.attachments,
      };
      if (archive.unknownEventTypes.length > 0) {
        responseSummaryFields.unknownEventTypes = [
          ...archive.unknownEventTypes,
        ];
      }
      const modelId = this.config.model?.id ?? "";
      if (
        archive.status === "completed" && archive.responseId !== "" &&
        archive.stateMode === "previous_response_id"
      ) {
        responseSummaryFields.lineageExpectedVersion = expectedStateVersion;
        try {
          const advanced = compareAndSwapResponseSessionState(sessionDir, {
            sessionId: header.id,
            stateMode: archive.stateMode,
            previousResponseId: archive.responseId,
            conversationId: archive.conversationId,
            provider: provider.name(),
            api: provider.api(),
            model: modelId,
            version: expectedStateVersion,
            updatedAt: now,
          }, expectedStateVersion);
          responseSummaryFields.lineageUpdate = advanced
            ? "advanced"
            : "conflict";
          if (!advanced) {
            console.error(
              `[agent] Responses lineage conflict for session ${header.id} turn ${localTurnId}`,
            );
          }
        } catch (err) {
          responseSummaryFields.lineageUpdate = "error";
          console.error(`[agent] advance Responses lineage: ${err}`);
        }
      }
      const turn = {
        id: 0,
        sessionId: header.id,
        localTurnId,
        messageId: null,
        requestId: "",
        responseId: archive.responseId,
        previousResponseId: archive.previousResponseId,
        conversationId: archive.conversationId,
        provider: provider.name(),
        api: provider.api(),
        model: modelId,
        stateMode: archive.stateMode === "" ? "replay" : archive.stateMode,
        status: archive.status === "" ? "unknown" : archive.status,
        incompleteReason: archive.incompleteReason,
        requestSummary: null,
        responseSummary: responseSummaryFields,
        createdAt: now,
        completedAt: now,
      };
      try {
        saveResponseTurn(sessionDir, turn);
      } catch (err) {
        console.error(`[agent] archive Responses turn: ${err}`);
        return;
      }
      for (const item of archive.items) {
        try {
          saveResponseItem(sessionDir, {
            id: 0,
            sessionId: header.id,
            localTurnId,
            responseId: archive.responseId,
            itemId: item.id,
            outputIndex: item.outputIndex,
            itemType: item.type,
            itemStatus: item.status,
            itemKey: "",
            sanitizedJson: item.canonical,
            createdAt: now,
          });
        } catch (err) {
          console.error(`[agent] archive Responses item: ${err}`);
        }
      }
    };
  }

  recordResponsesStateFailure(
    localTurnId: string,
    state: ResponsesStateSnapshot,
    streamErr: Error,
  ): ResponseStateFailureClass {
    const session = this.config.session;
    const provider = this.config.provider;
    if (
      session === undefined || provider === undefined || localTurnId === ""
    ) {
      return responseStateFailureRequestFailed;
    }
    const header = session.getHeader();
    if (header === null || header.id === "") {
      return responseStateFailureRequestFailed;
    }
    let failureClass: ResponseStateFailureClass =
      responseStateFailureRequestFailed;
    const classifier = responseStateFailureOf(provider);
    if (classifier !== undefined) {
      failureClass = classifier.responseStateFailureClass(streamErr);
    }
    const modelId = this.config.model?.id ?? "";
    let stateMode = "previous_response_id";
    const modeProvider = responseStateModeOf(provider);
    if (modeProvider !== undefined && modeProvider.responseStateMode() !== "") {
      stateMode = modeProvider.responseStateMode();
    }
    const now = new Date();
    try {
      saveResponseTurn(session.getSessionDir(), {
        id: 0,
        sessionId: header.id,
        localTurnId,
        messageId: null,
        requestId: "",
        responseId: "",
        previousResponseId: state.previousResponseId,
        conversationId: "",
        provider: provider.name(),
        api: provider.api(),
        model: modelId,
        stateMode,
        status: "failed",
        incompleteReason: failureClass,
        requestSummary: null,
        responseSummary: {
          status: "failed",
          stateFailureClass: failureClass,
          remoteStateActive: true,
          lineageExpectedVersion: state.version,
        },
        createdAt: now,
        completedAt: now,
      });
    } catch (err) {
      console.error(`[agent] archive Responses state failure: ${err}`);
    }
    return failureClass;
  }

  // --- Tool execution ------------------------------------------------------

  /** Executes tool calls one by one. */
  async executeToolCallsSequential(
    ctx: RunContext,
    toolCalls: ToolCallBlock[],
    localTurnId: string,
    ch: EventSink,
  ): Promise<Message[]> {
    const results: Message[] = [];
    for (const tc of toolCalls) {
      results.push(
        await this.executeSingleToolCall(ctx, tc, localTurnId, ch, null),
      );
    }
    return results;
  }

  /**
   * Executes tool calls concurrently. Calls report their starts in the declared
   * provider order; results stay aligned with the declared order.
   */
  async executeToolCallsParallel(
    ctx: RunContext,
    toolCalls: ToolCallBlock[],
    localTurnId: string,
    ch: EventSink,
  ): Promise<Message[]> {
    const order = newToolLaunchOrder(toolCalls.length);
    const indexes = toolCalls.map((_, i) => i);
    return await boundedParallel(
      this.maxToolConcurrency(),
      indexes,
      (index) =>
        this.executeSingleToolCall(
          ctx,
          toolCalls[index],
          localTurnId,
          ch,
          order === null ? null : order.handle(index),
        ),
    );
  }

  /** Executes a single tool call. */
  executeSingleToolCall(
    ctx: RunContext,
    tc: ToolCallBlock,
    localTurnId: string,
    ch: EventSink,
    launch: ToolLaunchHandle | null,
  ): Promise<Message> {
    return this.executeSingleToolCallWithRecovery(
      ctx,
      tc,
      localTurnId,
      ch,
      false,
      launch,
    );
  }

  async executeSingleToolCallWithRecovery(
    ctx: RunContext,
    tc: ToolCallBlock,
    localTurnId: string,
    ch: EventSink,
    allowReadOnlyRecovery: boolean,
    launch: ToolLaunchHandle | null,
  ): Promise<Message> {
    const toolResult = (
      content: string,
      contents: ContentBlock[] | undefined,
      isError: boolean,
    ): Message => {
      const message = newToolResultMessageWithContents(
        tc.id,
        tc.name,
        content,
        contents ?? null,
        isError,
      );
      message.toolKind = tc.kind;
      return message;
    };
    try {
      // Parse arguments
      let params: Record<string, unknown> = {};
      const argsRaw = (tc.invalidArguments ?? "") !== ""
        ? tc.invalidArguments
        : tc.arguments;
      if (typeof argsRaw === "string" && argsRaw.length > 0) {
        try {
          const parsed = JSON.parse(argsRaw);
          if (
            parsed !== null && typeof parsed === "object" &&
            !Array.isArray(parsed)
          ) {
            params = parsed as Record<string, unknown>;
          }
        } catch (err) {
          const errMsg = `parse tool arguments: ${(err as Error).message}`;
          this.sendEvent(ch, {
            type: EventToolExecutionEnd,
            toolCallId: tc.id,
            toolName: tc.name,
            toolResult: errMsg,
            toolError: err as Error,
          });
          return toolResult(errMsg, undefined, true);
        }
      } else if (
        argsRaw !== null && argsRaw !== undefined &&
        typeof argsRaw === "object" && !Array.isArray(argsRaw)
      ) {
        params = argsRaw as Record<string, unknown>;
      }
      // Tool registration is the execution authorization boundary.
      if (!this.isToolRegisteredForRun(tc.name)) {
        const errMsg = `tool ${
          JSON.stringify(tc.name)
        } is not registered for this run`;
        this.sendEvent(ch, {
          type: EventToolExecutionEnd,
          toolCallId: tc.id,
          toolName: tc.name,
          toolResult: errMsg,
          toolError: new Error(errMsg),
        });
        return toolResult(errMsg, undefined, true);
      }
      if (launch !== null) await launch.waitStart();
      this.sendEvent(ch, {
        type: EventToolExecutionStart,
        toolCallId: tc.id,
        toolName: tc.name,
        toolArgs: params,
      });
      if (launch !== null) launch.markStarted();
      if (this.config.mode === "os" && tc.name !== "bash") {
        const errMsg = `tool ${
          JSON.stringify(tc.name)
        } is unavailable in OS mode; only bash is registered`;
        this.sendEvent(ch, {
          type: EventToolExecutionEnd,
          toolCallId: tc.id,
          toolName: tc.name,
          toolResult: errMsg,
          toolError: new Error(errMsg),
        });
        return toolResult(errMsg, undefined, true);
      }
      const found = this.#registry?.get(tc.name);
      if (found === undefined) {
        const errMsg = `unknown tool: ${tc.name}`;
        this.sendEvent(ch, {
          type: EventToolExecutionEnd,
          toolCallId: tc.id,
          toolName: tc.name,
          toolResult: errMsg,
          toolError: new Error(errMsg),
        });
        return toolResult(errMsg, undefined, true);
      }
      const tool: Tool = found;
      if (this.config.beforeToolCall !== undefined) {
        const blockResult = this.config.beforeToolCall({
          assistantMessage: emptyMessage(),
          toolCall: tc,
          args: params,
          context: this.getContext(),
        });
        if (blockResult !== undefined && blockResult.block) {
          const reason = blockResult.reason === ""
            ? "Tool execution was blocked"
            : blockResult.reason;
          this.sendEvent(ch, {
            type: EventToolExecutionEnd,
            toolCallId: tc.id,
            toolName: tc.name,
            toolResult: reason,
            toolError: new Error(reason),
          });
          return toolResult(reason, undefined, true);
        }
      }
      // Git metadata one-shot approval.
      let gitAccessApproved = false;
      if (
        tc.name === "bash" && this.config.mode !== "yolo" &&
        this.config.mode !== "os" && this.config.sandboxMgr !== undefined &&
        this.config.sandboxMgr.level() !== Level.None
      ) {
        const command = bashCommandArg(params);
        if (command !== undefined && gitAccessRequired(command, "")) {
          const request = {
            command,
            reason:
              "This command may access protected .git metadata. Allow once?",
          };
          gitAccessApproved = await this.resolveToolApproval(
            ctx,
            ch,
            tc.id,
            "git_access",
            request,
          );
          if (!gitAccessApproved) {
            const reason =
              "Git metadata access denied; .git is protected by the sandbox";
            this.sendEvent(ch, {
              type: EventToolExecutionEnd,
              toolCallId: tc.id,
              toolName: tc.name,
              toolResult: reason,
              toolError: new Error(reason),
            });
            return toolResult(reason, undefined, true);
          }
        }
      }
      if (this.needsApproval(tc.name, params)) {
        const approved = await this.resolveToolApproval(
          ctx,
          ch,
          tc.id,
          tc.name,
          params,
        );
        if (!approved) {
          const reason = "Tool execution denied by user";
          this.sendEvent(ch, {
            type: EventToolExecutionEnd,
            toolCallId: tc.id,
            toolName: tc.name,
            toolResult: reason,
            toolError: new Error(reason),
          });
          return toolResult(reason, undefined, true);
        }
      }
      const { ctx: execCtx, cancel: cancelExec } = toolExecutionContext(
        { signal: ctx.signal },
        tool,
        params,
      );
      try {
        let toolCtx: ToolContext = {
          ...execCtx,
          agentID: this.#id,
          eventSink: ch,
          parentRunContext: ctx,
          parentMode: this.config.mode ?? "",
          iterationBudget: iterationBudgetFromContext(ctx),
        };
        const asker: QuestionAsker = {
          askQuestion: (askCtx, question, options, context) => {
            const rc: RunContext = {
              signal: askCtx.signal,
              eventSink: ch,
            };
            return this.requestQuestion(rc, ch, question, options, context);
          },
        };
        toolCtx = contextWithQuestionAsker(toolCtx, asker);
        if (toolCtx.signal !== undefined) {
          contextWithGitAccess(toolCtx.signal, gitAccessApproved);
        }
        const [claimed, reused, claimErr] = this
          .claimToolExecutionWithRecovery(
            localTurnId,
            tc,
            params,
            allowReadOnlyRecovery,
          );
        if (claimErr !== null) {
          const errMsg = `record tool execution: ${claimErr.message}`;
          this.sendEvent(ch, {
            type: EventToolExecutionEnd,
            toolCallId: tc.id,
            toolName: tc.name,
            toolResult: errMsg,
            toolError: claimErr,
          });
          return toolResult(errMsg, undefined, true);
        }
        if (reused !== null) {
          const reusedResult: Message = { ...reused };
          let reusedErr: Error | undefined;
          if (reusedResult.contents !== undefined) {
            const [rc, rct, rie, rierr] = this.gateToolResultImages(
              reusedResult.content ?? "",
              reusedResult.contents,
              reusedResult.isError === true,
            );
            reusedResult.content = rc;
            reusedResult.contents = rct;
            reusedResult.isError = rie;
            reusedErr = rierr;
            if (rierr !== undefined) reusedResult.toolKind = tc.kind;
          }
          const executionState = reusedResult.isError === true
            ? "interrupted"
            : "reused";
          this.sendEvent(ch, {
            type: EventToolExecutionEnd,
            toolCallId: tc.id,
            toolName: tc.name,
            toolResult: reusedResult.content,
            toolError: reusedErr,
            toolExecutionState: executionState,
            toolImages: toolResultImages(reusedResult.contents ?? []),
          });
          this.sendEvent(ch, {
            type: EventToolResult,
            toolCallId: tc.id,
            toolName: tc.name,
            toolResult: reusedResult.content,
            toolError: reusedErr,
            toolExecutionState: executionState,
          });
          return reusedResult;
        }
        if (claimed !== null) {
          toolCtx = contextWithOperationID(toolCtx, claimed.executionKey);
        }
        if (this.config.beforeToolExecute !== undefined) {
          let sideEffecting = isSideEffectingToolName(tc.name);
          let executionKey = "";
          if (claimed !== null) {
            sideEffecting = claimed.sideEffecting;
            executionKey = claimed.executionKey;
          }
          const blockResult = this.config.beforeToolExecute({
            toolCall: tc,
            args: params,
            context: this.getContext(),
            executionContext: toolCtx,
            runId: this.config.runId ?? "",
            executionKey,
            sideEffecting,
          });
          if (blockResult !== undefined && blockResult.block) {
            const reason = blockResult.reason === ""
              ? "Tool execution was blocked before the side effect fence"
              : blockResult.reason;
            this.sendEvent(ch, {
              type: EventToolExecutionEnd,
              toolCallId: tc.id,
              toolName: tc.name,
              toolResult: reason,
              toolError: new Error(reason),
              toolExecutionState: "interrupted",
            });
            return toolResult(reason, undefined, true);
          }
        }
        let resultText = "";
        let resultContents: ContentBlock[] | undefined;
        let resultDiff: FileDiff | undefined;
        let resultPlan: TaskPlan | undefined;
        let isError = false;
        let err: Error | undefined;
        try {
          const result = await tool.execute(toolCtx, params);
          resultText = result.text;
          resultContents = result.contents;
          resultDiff = result.diff;
          resultPlan = result.plan;
        } catch (thrown) {
          err = thrown instanceof Error ? thrown : new Error(String(thrown));
          isError = true;
          resultText = err.message;
          resultContents = undefined;
          resultDiff = undefined;
          resultPlan = undefined;
        }
        let resultContent = resultText;
        if (this.config.afterToolCall !== undefined) {
          const afterResult = this.config.afterToolCall({
            assistantMessage: emptyMessage(),
            toolCall: tc,
            args: params,
            result: { content: resultContent, isError, terminate: false },
            isError,
            context: this.getContext(),
          });
          if (afterResult !== undefined) {
            if (afterResult.content !== "") {
              resultContent = afterResult.content;
            }
            isError = afterResult.isError;
            resultContents = undefined;
            resultPlan = undefined;
          }
        }
        const [gatedContent, gatedContents, gatedError, imageErr] = this
          .gateToolResultImages(resultContent, resultContents ?? [], isError);
        resultContent = gatedContent;
        resultContents = gatedContents;
        isError = gatedError;
        if (imageErr !== undefined) err = imageErr;
        if (claimed !== null && this.config.session !== undefined) {
          try {
            updateToolExecutionRecord(this.config.session.getSessionDir(), {
              ...claimed,
              executionState: "completed",
              resultSummary: toolExecutionResultSummary(
                resultContent,
                isError,
              ),
              completedAt: new Date(),
            });
          } catch (updateErr) {
            console.error(
              `[agent] failed to persist tool execution result: ${updateErr}`,
            );
          }
        }
        if (resultPlan !== undefined) {
          this.sendEvent(ch, {
            type: EventPlanUpdate,
            toolCallId: tc.id,
            toolName: tc.name,
            plan: resultPlan,
          });
        }
        this.sendEvent(ch, {
          type: EventToolExecutionEnd,
          toolCallId: tc.id,
          toolName: tc.name,
          toolResult: resultContent,
          toolDiff: resultDiff,
          toolError: err,
          toolImages: toolResultImages(resultContents ?? []),
        });
        this.sendEvent(ch, {
          type: EventToolResult,
          toolCallId: tc.id,
          toolName: tc.name,
          toolResult: resultContent,
          toolDiff: resultDiff,
          toolError: err,
        });
        return toolResult(resultContent, resultContents, isError);
      } finally {
        cancelExec();
      }
    } finally {
      if (launch !== null) launch.release();
    }
  }

  /**
   * Resolves one tool approval: a durable decision lookup, then a configured
   * approval handler, then an interactive request raced against cancellation.
   */
  resolveToolApproval(
    ctx: RunContext,
    ch: EventSink,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    if (this.config.approvalDecisionLookup !== undefined) {
      const [approved, found] = this.config.approvalDecisionLookup(
        toolCallId,
        toolName,
        args,
      );
      if (found) return Promise.resolve(approved);
    }
    if (this.config.approvalHandler !== undefined) {
      return Promise.resolve(
        this.config.approvalHandler(toolCallId, toolName, args),
      );
    }
    return this.requestToolApproval(ctx, ch, toolCallId, toolName, args);
  }

  /** Establishes the durable idempotency boundary immediately before execution. */
  claimToolExecutionWithRecovery(
    localTurnId: string,
    tc: ToolCallBlock,
    params: Record<string, unknown>,
    allowReadOnlyRecovery: boolean,
  ): [ToolExecutionRecord | null, Message | null, Error | null] {
    const session = this.config.session;
    const provider = this.config.provider;
    if (
      session === undefined || provider === undefined || localTurnId === "" ||
      tc.id === ""
    ) {
      return [null, null, null];
    }
    if (tc.name === "plan") return [null, null, null];
    const header = session.getHeader();
    if (header === null || header.id === "") return [null, null, null];
    let normalizedArgs: string;
    try {
      normalizedArgs = JSON.stringify(params);
    } catch (e) {
      return [null, null, new Error(`normalize tool arguments: ${e}`)];
    }
    const argsHash = createHash("sha256").update(normalizedArgs).digest("hex");
    const keyInput = header.id + "\u0000" + localTurnId + "\u0000" + tc.id +
      "\u0000" + tc.name + "\u0000" + argsHash;
    const keyHash = createHash("sha256").update(keyInput).digest("hex");
    const sessionDir = session.getSessionDir();
    const record: ToolExecutionRecord = {
      id: 0,
      sessionId: header.id,
      localTurnId,
      executionKey: `tool:${keyHash}`,
      provider: provider.name(),
      api: provider.api(),
      responseId: "",
      providerCallId: tc.id,
      toolKind: tc.kind ?? "",
      toolName: tc.name,
      argsHash,
      executionState: "running",
      resultSummary: null,
      providerMetadata: null,
      sideEffecting: isSideEffectingToolName(tc.name),
      createdAt: new Date(),
      completedAt: null,
    };
    let stored: ToolExecutionRecord;
    let created: boolean;
    try {
      const claimed = claimToolExecutionRecord(sessionDir, record);
      stored = claimed.record;
      created = claimed.created;
    } catch (err) {
      return [null, null, err instanceof Error ? err : new Error(String(err))];
    }
    if (created) return [stored, null, null];
    if (stored.executionState === "completed") {
      const [content, isError] = parseToolExecutionResultSummary(
        stored.resultSummary,
      );
      const message = newToolResultMessage(tc.id, tc.name, content, isError);
      message.toolKind = tc.kind;
      return [null, message, null];
    }
    const canRecover = allowReadOnlyRecovery &&
      ((isReadOnlyToolName(tc.name) && !stored.sideEffecting) ||
        stored.executionState === "retry_requested");
    if (canRecover) {
      let reclaimed: boolean;
      try {
        reclaimed = reclaimInterruptedToolExecution(
          sessionDir,
          stored.executionKey,
        );
      } catch (err) {
        return [
          null,
          null,
          err instanceof Error ? err : new Error(String(err)),
        ];
      }
      if (reclaimed) {
        stored = {
          ...stored,
          executionState: "running",
          resultSummary: null,
          completedAt: null,
        };
        return [stored, null, null];
      }
    }
    let messageText =
      "Tool execution is already in progress or was interrupted; it was not repeated.";
    if (stored.sideEffecting) {
      messageText +=
        " This side effect has no verified external idempotency guarantee, so exactly-once execution cannot be promised.";
    }
    const message = newToolResultMessage(tc.id, tc.name, messageText, true);
    message.toolKind = tc.kind;
    return [null, message, null];
  }

  // --- Core loop -----------------------------------------------------------

  async loop(ctx: RunContext, ch: EventSink): Promise<void> {
    const provider = this.config.provider;
    if (provider === undefined) throw new Error("agent has no provider");
    ch({ type: EventAgentStart });

    const runAbort = new AbortController();
    const signals: AbortSignal[] = [this.#abortController.signal];
    if (ctx.signal !== undefined) signals.push(ctx.signal);
    const onAbort = () => runAbort.abort();
    for (const signal of signals) {
      if (signal.aborted) runAbort.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const removeAbortListeners = () => {
      for (const signal of signals) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    let runCtx: RunContext = contextWithSignal(ctx, runAbort.signal);
    let budget: IterationBudget | undefined;
    let wallClock = 0;
    const policy = this.config.iterationBudget;
    if (policy !== undefined && iterationBudgetPolicyEnabled(policy)) {
      const normalized = normalizeIterationBudgetPolicy(
        policy,
        this.config.maxIterations ?? 0,
      );
      budget = newIterationBudget(normalized, this.config.maxIterations ?? 0);
      runCtx = contextWithIterationBudget(runCtx, budget) ?? runCtx;
      wallClock = normalized.maxWallClock;
    }
    const runStart = Date.now();
    this.setRunContext(runCtx);
    try {
      let consecutiveNoText = 0;
      const maxConsecutiveNoText = (this.config.maxConsecutiveNoText ?? 0) <= 0
        ? 95
        : this.config.maxConsecutiveNoText as number;
      const maxConsecutiveNoTextAfterWarning = 5;
      let warningIssued = false;
      let contextPressureFired = false;
      let budgetPressureFired = false;
      let escalated = false;
      let recoveryAttempts = 0;
      const maxStreamTimeoutRetries = 0;
      const maxStreamFailureRetries = 2;
      const state: LoopRecoveryState = {
        contextOverflowRetried: false,
        contentRejectionStage: 0,
        streamTimeoutRetries: 0,
        streamFailureRetries: 0,
        recoveryAssistantContents: [],
        toolArgumentNotices: [],
      };
      let emptyResponseRetries = 0;
      const maxEmptyResponseRetries = 2;
      let responsesReplayFallback = false;
      let lastRenewals = 0;

      for (let i = 0;; i++) {
        let limit = this.config.maxIterations ?? 0;
        if (budget !== undefined) {
          budget.setTurn(i);
          limit = budget.limitValue();
          const renewals = budget.renewalsCount();
          if (renewals > lastRenewals) {
            lastRenewals = renewals;
            budgetPressureFired = false;
            this.sendEvent(ch, {
              type: EventStatus,
              statusMessage: `Iteration budget renewed to ${limit} turns`,
            });
          }
        }
        if (limit > 0 && i >= limit) break;
        if (wallClock > 0 && Date.now() - runStart >= wallClock) {
          const err = new Error(
            `run exceeded the ${goDurationString(wallClock)} wall-clock budget`,
          );
          this.#emitRunFinished(
            ch,
            TaskIncomplete,
            "wall_clock_limit",
            err,
            undefined,
            undefined,
          );
          ch({ type: EventError, error: err, stopReason: "wall_clock_limit" });
          ch(this.agentEndEvent());
          return;
        }
        if (runAbort.signal.aborted) {
          const err = abortErrorFrom(runAbort.signal);
          this.#emitRunFinished(
            ch,
            TaskCanceled,
            "aborted",
            err,
            undefined,
            undefined,
          );
          ch({ type: EventError, error: err, stopReason: "aborted" });
          ch(this.agentEndEvent());
          return;
        }

        this.sendEvent(ch, { type: EventTurnStart });
        let truncated = false;

        if (this.config.getSteeringMessages !== undefined) {
          const steeringMessages = this.config.getSteeringMessages();
          if (steeringMessages.length > 0) {
            for (const msg of steeringMessages) {
              this.sendEvent(ch, { type: EventMessageStart, message: msg });
              this.sendEvent(ch, { type: EventMessageEnd, message: msg });
              this.#messages = [...this.#messages, msg];
              this.#messageIds = [...this.#messageIds, ""];
              this.#context.messages = [...this.#context.messages, msg];
            }
          }
        }

        this.#context.systemPrompt = this.#frozenSystemPrompt;
        this.#context.tools = this.#frozenToolDefs;

        await this.compactIfNeeded(runCtx, ch);

        const sessionContextMsg = this.buildSessionContextMessage();
        const [allMessages, reqErr] = this.prepareRequestMessages(
          sessionContextMsg,
          ch,
        );
        if (reqErr !== null || allMessages === null) {
          const err = reqErr ?? new Error("failed to build request messages");
          if (await this.tryRecoverContextOverflow(runCtx, ch, state, err)) {
            continue;
          }
          this.#emitRunFinished(
            ch,
            TaskIncomplete,
            "context_limit",
            err,
            undefined,
            undefined,
          );
          ch({ type: EventError, error: err, stopReason: "context_limit" });
          ch(this.agentEndEvent());
          return;
        }

        const markers = selectCacheMarkers(allMessages);
        const messagesWithMarkers = applyCacheMarkers(allMessages, markers);
        const params: ChatParams = {
          messages: messagesWithMarkers,
          tools: this.#frozenToolDefs,
          systemPrompt: this.#frozenSystemPrompt,
          thinkingLevel: normalizeThinkingLevel(
            this.config.thinkingLevel ?? "",
          ),
          maxTokens: this.maxTokensForRequest(messagesWithMarkers),
          temperature: this.config.model?.temperature,
          topP: this.config.model?.topP,
          modelId: this.config.model?.id ?? "",
          abort: runAbort.signal,
        };
        const imgErr = this.validateImageRequestBudget(allMessages);
        if (imgErr !== undefined) {
          this.#emitRunFinished(
            ch,
            TaskIncomplete,
            "image_request_limit",
            imgErr,
            undefined,
            undefined,
          );
          ch({
            type: EventError,
            error: imgErr,
            stopReason: "image_request_limit",
          });
          ch(this.agentEndEvent());
          return;
        }

        let responseState: ResponsesStateSnapshot = {
          previousResponseId: "",
          replayItems: [],
          suppressConversation: false,
          remoteStateActive: false,
          version: 0,
        };
        let responseTurnId = "";
        if (
          this.config.session !== undefined &&
          provider.api() === "openai-responses"
        ) {
          responseTurnId = generateID();
          try {
            responseState = this.prepareResponsesState(
              responseTurnId,
              allMessages,
              responsesReplayFallback,
            );
          } catch (err) {
            const cause = err instanceof Error ? err : new Error(String(err));
            this.#emitRunFinished(
              ch,
              TaskFailed,
              "error",
              cause,
              undefined,
              undefined,
            );
            ch({ type: EventError, error: cause, stopReason: "error" });
            ch(this.agentEndEvent());
            return;
          }
          params.responseOptions = {
            previousResponseId: responseState.previousResponseId,
            replayItems: responseState.replayItems,
            suppressConversation: responseState.suppressConversation,
            responseArchive: this.responseArchiveSink(
              responseTurnId,
              responseState.version,
            ),
          };
        }

        const streamStart = Date.now();
        let textContent = "";
        let thinkContent = "";
        let thinkSignature = "";
        const toolCalls: ToolCallBlock[] = [];
        const toolCallIds = new Set<string>();
        let usage: Usage | undefined;
        let attachments: Attachment[] | undefined;
        let stopReason = "";
        let streamErr: Error | undefined;

        try {
          for await (const event of provider.chat(params)) {
            switch (event.type) {
              case streamStart:
                break;
              case streamTextDelta:
                textContent += event.textDelta ?? "";
                this.sendEvent(ch, {
                  type: EventTextDelta,
                  textDelta: event.textDelta,
                });
                break;
              case streamThinkDelta:
                thinkContent += event.thinkDelta ?? "";
                this.sendEvent(ch, {
                  type: EventThinkDelta,
                  thinkDelta: event.thinkDelta,
                });
                break;
              case streamThinkSignature:
                thinkSignature = event.thinkSignature ?? "";
                break;
              case streamHostedItem:
                if (event.hostedItem !== undefined) {
                  this.sendEvent(ch, {
                    type: EventHostedItem,
                    hostedItem: event.hostedItem,
                  });
                }
                break;
              case streamToolCall:
                if (event.toolCall !== undefined) {
                  const toolCall = event.toolCall;
                  if (toolCall.id === "") {
                    toolCall.id = nextToolCallFallbackID("agent_toolcall");
                  }
                  if (toolCallIds.has(toolCall.id)) continue;
                  toolCallIds.add(toolCall.id);
                  const hadEmptyArgs = typeof toolCall.arguments === "string" &&
                    toolCall.arguments.length === 0;
                  const [args, argErr] = normalizeToolCallArguments(toolCall);
                  if (hadEmptyArgs && argErr === null) {
                    state.toolArgumentNotices.push(
                      `Tool ${
                        JSON.stringify(toolCall.name)
                      } streamed no JSON arguments. The runtime normalized the call to the safe fallback {}. Treat the tool result below as authoritative; use explicit valid JSON arguments for any follow-up call.`,
                    );
                  }
                  if (argErr !== null) {
                    state.toolArgumentNotices.push(
                      `Tool ${
                        JSON.stringify(toolCall.name)
                      } returned malformed JSON arguments (${argErr.message}). The original arguments were not executed; the safe fallback was {}. Treat this tool call as failed and reconstruct valid JSON before trying again. Do not assume any side effect occurred.`,
                    );
                    this.sendEvent(ch, {
                      type: EventStatus,
                      statusMessage:
                        `Warning: failed to parse tool arguments: ${argErr.message}`,
                    });
                  }
                  toolCalls.push(toolCall);
                  this.sendEvent(ch, {
                    type: EventToolCall,
                    toolCall,
                    toolArgs: args ?? undefined,
                  });
                }
                break;
              case streamUsage:
                usage = event.usage;
                break;
              case streamDone:
                stopReason = event.stopReason ?? "";
                attachments = event.attachments === undefined
                  ? []
                  : [...event.attachments];
                break;
              case streamError:
                streamErr = event.error;
                stopReason = event.stopReason ?? "";
                break;
              case streamRetry: {
                let retryMaxAttempts = event.retryMaxAttempts ?? 0;
                if (retryMaxAttempts === 0) {
                  retryMaxAttempts = event.retryMax ?? 0;
                }
                this.sendEvent(ch, {
                  type: EventStatus,
                  statusMessage: retryCompatibilityStatus(
                    event.retryAttempt ?? 0,
                    retryMaxAttempts,
                    event.retryAfterMs ?? 0,
                  ),
                  retryStatus: true,
                  retryAttempt: event.retryAttempt,
                  retryMaxAttempts,
                  retryAfterMs: event.retryAfterMs,
                });
                this.sendEvent(ch, {
                  type: EventRetry,
                  statusMessage: event.retryDetail,
                  retryAttempt: event.retryAttempt,
                  retryMaxAttempts,
                  retryAfterMs: event.retryAfterMs,
                  retryReason: "provider",
                });
                break;
              }
            }
          }
        } catch (thrown) {
          streamErr = thrown instanceof Error
            ? thrown
            : new Error(String(thrown));
        }

        if (streamErr !== undefined) {
          if (runAbort.signal.aborted) {
            const err = abortErrorFrom(runAbort.signal);
            this.#emitRunFinished(
              ch,
              TaskCanceled,
              "aborted",
              err,
              usage,
              undefined,
            );
            ch({ type: EventError, error: err, stopReason: "aborted" });
            ch(this.agentEndEvent());
            return;
          }
          let failureClass: ResponseStateFailureClass =
            responseStateFailureRequestFailed;
          if (
            responseTurnId !== "" && responseState.remoteStateActive
          ) {
            failureClass = this.recordResponsesStateFailure(
              responseTurnId,
              responseState,
              streamErr,
            );
          }
          if (!responsesReplayFallback && responseState.remoteStateActive) {
            const fallbackProvider = responseStateFallbackOf(provider);
            if (
              fallbackProvider !== undefined &&
              fallbackProvider.responseStateFallbackError(streamErr)
            ) {
              responsesReplayFallback = true;
              this.sendEvent(ch, {
                type: EventStatus,
                statusMessage: retryCompatibilityStatus(1, 1, 0),
                retryStatus: true,
                responseStateFailureClass: failureClass,
                retryAttempt: 1,
                retryMaxAttempts: 1,
              });
              this.sendEvent(ch, {
                type: EventRetry,
                retryAttempt: 1,
                retryMaxAttempts: 1,
                retryReason: "response_state",
              });
              continue;
            }
          }
          if (
            isContextOverflowError(streamErr) &&
            await this.tryRecoverContextOverflow(
              runCtx,
              ch,
              state,
              streamErr,
            )
          ) {
            continue;
          }
          if (
            this.tryRecoverContentRejection(
              ch,
              state,
              textContent !== "" || thinkContent !== "" ||
                toolCalls.length > 0,
              streamErr,
            )
          ) {
            continue;
          }
          if (
            await this.tryRetryStreamTimeout(
              runCtx,
              ch,
              state,
              maxStreamTimeoutRetries,
              textContent,
              thinkContent,
              streamErr,
            )
          ) {
            i--;
            continue;
          }
          if (
            !responseState.remoteStateActive &&
            await this.tryContinueStreamFailure(
              runCtx,
              ch,
              state,
              maxStreamFailureRetries,
              textContent,
              thinkContent,
              thinkSignature,
              toolCalls,
              streamErr,
            )
          ) {
            i--;
            continue;
          }
          let finalErr = streamErr;
          if (isStreamTimeoutError(streamErr)) {
            finalErr = new Error(
              `供应商响应超时，已自动重试 ${
                state.streamTimeoutRetries + state.streamFailureRetries
              } 次仍未恢复，请稍后重试或检查网络/供应商状态`,
            );
          }
          this.#emitRunFinished(
            ch,
            TaskFailed,
            stopReason,
            finalErr,
            usage,
            undefined,
          );
          ch({
            type: EventError,
            error: finalErr,
            stopReason,
            responseStateFailureClass: responseState.remoteStateActive
              ? failureClass
              : "",
          });
          ch(this.agentEndEvent());
          return;
        }
        responsesReplayFallback = false;

        if (isOutputTruncationReason(stopReason)) {
          if (
            !escalated && this.config.maxTokensUserSet !== true &&
            (this.config.model === undefined ||
              this.config.model.maxTokensSet !== true)
          ) {
            const nextMax = this.escalatedMaxTokens(params.maxTokens);
            if (nextMax > params.maxTokens) {
              escalated = true;
              this.config.maxTokens = nextMax;
              this.sendEvent(ch, {
                type: EventRetry,
                retryAttempt: 1,
                retryMaxAttempts: 1,
                retryMaxTokens: nextMax,
                retryReason: "output_limit",
              });
              continue;
            }
          }
          if (
            escalated && toolCalls.length === 0 &&
            recoveryAttempts < maxOutputRecoveryAttempts
          ) {
            recoveryAttempts++;
            if (textContent !== "" || thinkContent !== "") {
              const partialContents: ContentBlock[] = [];
              if (thinkContent !== "") {
                partialContents.push({
                  type: "thinking",
                  thinking: thinkContent,
                  signature: thinkSignature,
                });
              }
              if (textContent !== "") {
                partialContents.push({ type: "text", text: textContent });
              }
              const partial = newAssistantMessage(partialContents);
              this.#messages = [...this.#messages, partial];
              this.#messageIds = [...this.#messageIds, ""];
              this.#context.messages = [...this.#context.messages, partial];
            }
            const recovery = newSystemInjectedUserMessage(
              buildOutputRecoveryMessage(textContent),
            );
            this.#messages = [...this.#messages, recovery];
            this.#messageIds = [...this.#messageIds, ""];
            this.#context.messages = [...this.#context.messages, recovery];
            this.sendEvent(ch, {
              type: EventRetry,
              retryAttempt: recoveryAttempts + 1,
              retryMaxAttempts: maxOutputRecoveryAttempts + 1,
              retryMaxTokens: params.maxTokens,
              retryReason: "continuation",
              retryContinue: true,
            });
            continue;
          }
          if (toolCalls.length === 0) truncated = true;
        }

        if (
          classifyTurn(
            textContent,
            thinkContent,
            toolCalls,
            usage,
            stopReason,
          ) ===
            turnEmpty
        ) {
          emptyResponseRetries++;
          if (emptyResponseRetries <= maxEmptyResponseRetries) {
            this.sendEvent(ch, {
              type: EventStatus,
              statusMessage: retryCompatibilityStatus(
                emptyResponseRetries,
                maxEmptyResponseRetries,
                0,
              ),
              retryStatus: true,
              retryAttempt: emptyResponseRetries,
              retryMaxAttempts: maxEmptyResponseRetries,
            });
            this.sendEvent(ch, {
              type: EventRetry,
              retryAttempt: emptyResponseRetries,
              retryMaxAttempts: maxEmptyResponseRetries,
              retryReason: "empty_response",
            });
            continue;
          }
          const err = new Error(
            `provider returned an empty response ${emptyResponseRetries} times in a row; last usage: ${
              formatUsage(usage)
            }, stopReason: ${JSON.stringify(stopReason)}`,
          );
          this.#emitRunFinished(
            ch,
            TaskFailed,
            "empty_response",
            new Error(
              `provider returned an empty response ${emptyResponseRetries} times in a row`,
            ),
            usage,
            undefined,
          );
          ch({ type: EventError, error: err, stopReason: "empty_response" });
          ch(this.agentEndEvent());
          return;
        }
        emptyResponseRetries = 0;

        const contents: ContentBlock[] = [];
        if (thinkContent !== "") {
          contents.push({
            type: "thinking",
            thinking: thinkContent,
            signature: thinkSignature,
          });
        }
        if (textContent !== "") {
          contents.push({ type: "text", text: textContent });
        }
        for (const tc of toolCalls) {
          contents.push({ type: "toolCall", toolCall: tc });
        }
        const assistantMsg = newAssistantMessage(contents);
        let persistedAssistantMsg = assistantMsg;
        if (state.recoveryAssistantContents.length > 0) {
          persistedAssistantMsg = {
            ...assistantMsg,
            contents: [
              ...state.recoveryAssistantContents.map(cloneContentBlock),
              ...contents.map(cloneContentBlock),
            ],
          };
        }
        const estimator = resolveTokenEstimator(
          this.config.compactionSettings ?? emptyCompactionSettings,
          this.config.model ?? null,
        );
        const estimatedUsage = estimateProviderUsage(
          this.#frozenSystemPrompt,
          messagesWithMarkers,
          this.#frozenToolDefs,
          assistantMsg,
          estimator,
        );
        usage = completeProviderUsage(usage, estimatedUsage) ?? undefined;
        assistantMsg.usage = usage;
        persistedAssistantMsg.usage = usage;
        const deferAssistantEntry = this.config.runtimeOwnsTurnEnd === true &&
          this.config.session !== undefined && toolCalls.length === 0;
        let assistantEntryId = "";
        if (deferAssistantEntry) {
          assistantEntryId = runAssistantEntryID(this.config.runId ?? "");
        }
        const assistantIndex = this.#messages.length;
        this.#messages = [...this.#messages, assistantMsg];
        this.#messageIds = [...this.#messageIds, assistantEntryId];
        this.#context.messages = [...this.#context.messages, assistantMsg];
        if (
          this.config.session !== undefined && !deferAssistantEntry
        ) {
          let msgId: string;
          try {
            msgId = this.config.session.appendMessage(persistedAssistantMsg);
          } catch (err) {
            const cause = err instanceof Error ? err : new Error(String(err));
            this.#emitRunFinished(
              ch,
              TaskFailed,
              "session_save",
              cause,
              usage,
              undefined,
            );
            ch({
              type: EventError,
              error: new Error(
                `save assistant message to session: ${cause.message}`,
              ),
            });
            ch(this.agentEndEvent());
            return;
          }
          assistantEntryId = msgId;
          this.setMessageId(assistantIndex, msgId);
        }
        this.#lastAssistantEntryId = assistantEntryId;
        this.#lastAssistantMessage = { ...persistedAssistantMsg };
        state.recoveryAssistantContents = [];

        if (usage !== undefined && this.config.model !== undefined) {
          calculateCost(usage, this.config.model);
        }
        this.sendEvent(ch, {
          type: EventUsage,
          usage,
          contextUsage: this.getContextUsage(),
        });
        if (this.config.session !== undefined && usage !== undefined) {
          const vendor = usageStatsProviderName({
            vendor: this.config.vendor,
            provider: this.config.provider,
          });
          const protocol = provider.api();
          const modelId = this.config.model?.id ?? "";
          const durationMs = Date.now() - streamStart;
          try {
            this.config.session.recordUsageFromProviderUsage(
              vendor,
              protocol,
              modelId,
              usage,
              durationMs,
            );
          } catch (err) {
            console.error(`[agent] failed to record usage stats: ${err}`);
          }
        }

        if (textContent !== "") {
          consecutiveNoText = 0;
          warningIssued = false;
        }

        if (toolCalls.length === 0) {
          if (await this.#injectFollowUpMessages(runCtx, ch)) continue;
          if (runAbort.signal.aborted) {
            const err = abortErrorFrom(runAbort.signal);
            this.#emitRunFinished(
              ch,
              TaskCanceled,
              "aborted",
              err,
              undefined,
              undefined,
            );
            ch({ type: EventError, error: err, stopReason: "aborted" });
            ch(this.agentEndEvent());
            return;
          }
          const contextUsage = this.getContextUsage();
          this.sendEvent(ch, {
            type: EventTurnEnd,
            turnMessage: assistantMsg,
            contextUsage,
          });
          if (truncated) {
            this.#emitRunFinished(
              ch,
              TaskIncomplete,
              "output_limit",
              new Error(
                "provider output was truncated and could not be continued",
              ),
              usage,
              attachments,
            );
            ch({
              type: EventError,
              error: new Error(
                `provider output truncated (stop reason ${
                  JSON.stringify(stopReason)
                })`,
              ),
              stopReason: "output_limit",
            });
            ch(this.agentEndEvent());
            return;
          }
          this.#emitRunFinished(
            ch,
            TaskSuccess,
            stopReason,
            undefined,
            usage,
            attachments,
          );
          ch({
            type: EventDone,
            stopReason,
            usage,
            attachments,
            contextUsage,
          });
          ch(this.agentEndEvent());
          return;
        }

        let toolResults: Message[];
        let toolTurnId = "";
        if (this.config.session !== undefined) {
          toolTurnId = `assistant-turn-${assistantIndex}`;
        }
        if (this.config.toolExecutionMode === "sequential") {
          toolResults = await this.executeToolCallsSequential(
            runCtx,
            toolCalls,
            toolTurnId,
            ch,
          );
        } else {
          toolResults = await this.executeToolCallsParallel(
            runCtx,
            toolCalls,
            toolTurnId,
            ch,
          );
        }
        for (const result of toolResults) {
          this.#messages = [...this.#messages, result];
          this.#messageIds = [...this.#messageIds, ""];
          this.#context.messages = [...this.#context.messages, result];
        }
        const baseIndex = this.#messages.length - toolResults.length;
        if (this.config.session !== undefined && toolResults.length > 0) {
          let msgIds: string[];
          try {
            msgIds = this.config.session.appendMessages(toolResults);
          } catch (err) {
            const cause = err instanceof Error ? err : new Error(String(err));
            this.#emitRunFinished(
              ch,
              TaskFailed,
              "session_save",
              cause,
              usage,
              undefined,
            );
            ch({
              type: EventError,
              error: new Error(
                `save tool result to session: ${cause.message}`,
              ),
            });
            ch(this.agentEndEvent());
            return;
          }
          for (let k = 0; k < msgIds.length; k++) {
            this.setMessageId(baseIndex + k, msgIds[k]);
          }
        }
        if (state.toolArgumentNotices.length > 0) {
          const recoveryText = state.toolArgumentNotices.join("\n");
          const notice = newSystemInjectedUserMessage(
            "[System] Tool-call recovery notice:\n" + recoveryText,
          );
          this.sendEvent(ch, { type: EventMessageStart, message: notice });
          this.sendEvent(ch, { type: EventMessageEnd, message: notice });
          this.injectTransientMessage(notice);
          let retryReason = "invalid_tool_arguments";
          if (
            !recoveryText.includes("malformed JSON arguments") &&
            recoveryText.includes("streamed no JSON arguments")
          ) {
            retryReason = "empty_tool_arguments";
          }
          this.sendEvent(ch, {
            type: EventRetry,
            retryAttempt: 1,
            retryMaxAttempts: 1,
            retryReason,
            retryContinue: true,
          });
          state.toolArgumentNotices = [];
        }

        if (textContent === "") {
          consecutiveNoText++;
          let threshold = consecutiveNoText >= maxConsecutiveNoText &&
              !warningIssued
            ? maxConsecutiveNoText
            : maxConsecutiveNoTextAfterWarning;
          if (!warningIssued) threshold = maxConsecutiveNoText;
          if (consecutiveNoText >= threshold) {
            if (!warningIssued) {
              const warningMsg = newUserMessage(
                `[System] You have been making tool calls for ${consecutiveNoText} consecutive turns without any text response. Please explain what you are doing and whether you are stuck. If you are making progress, briefly describe your current task and continue. If you are truly stuck, please stop and explain the issue.`,
              );
              this.sendEvent(ch, {
                type: EventMessageStart,
                message: warningMsg,
              });
              this.sendEvent(ch, {
                type: EventMessageEnd,
                message: warningMsg,
              });
              const warningIndex = this.#messages.length;
              this.#messages = [...this.#messages, warningMsg];
              this.#messageIds = [...this.#messageIds, ""];
              this.#context.messages = [...this.#context.messages, warningMsg];
              if (this.config.session !== undefined) {
                let msgId: string;
                try {
                  msgId = this.config.session.appendMessage(warningMsg);
                } catch (err) {
                  const cause = err instanceof Error
                    ? err
                    : new Error(String(err));
                  this.#emitRunFinished(
                    ch,
                    TaskFailed,
                    "session_save",
                    cause,
                    usage,
                    undefined,
                  );
                  ch({
                    type: EventError,
                    error: new Error(
                      `save warning message to session: ${cause.message}`,
                    ),
                  });
                  ch(this.agentEndEvent());
                  return;
                }
                this.setMessageId(warningIndex, msgId);
              }
              warningIssued = true;
              consecutiveNoText = 0;
            } else {
              const err = new Error(
                `agent appears stuck: ${consecutiveNoText} consecutive turns without text output after warning`,
              );
              this.#emitRunFinished(
                ch,
                TaskIncomplete,
                "stuck",
                undefined,
                usage,
                undefined,
              );
              ch({ type: EventError, error: err, stopReason: "stuck" });
              ch(this.agentEndEvent());
              return;
            }
          }
        }

        const contextUsage = this.getContextUsage();
        this.sendEvent(ch, {
          type: EventTurnEnd,
          turnMessage: assistantMsg,
          turnToolResults: toolResults,
          contextUsage,
        });

        if (!contextPressureFired) {
          let threshold = this.config.contextPressureThreshold ?? 0;
          if (threshold <= 0) threshold = 0.55;
          if (
            contextUsage !== undefined && contextUsage.percent !== undefined &&
            contextUsage.percent >= threshold * 100
          ) {
            contextPressureFired = true;
            const warnMsg = `[Context Pressure] ${
              Math.round(contextUsage.percent)
            }% of context window used (${contextUsage.totalTokens}/${contextUsage.contextWindow} tokens). Compaction will trigger soon. Consider saving important context to memory.md and wrapping up the current task.`;
            this.sendEvent(ch, {
              type: EventContextPressure,
              pressureMessage: warnMsg,
              pressureType: "context",
              pressurePercent: contextUsage.percent,
              contextUsage,
            });
          }
        }

        if (!budgetPressureFired) {
          let threshold = this.config.budgetPressureThreshold ?? 0;
          if (threshold <= 0) threshold = 0.20;
          if (limit > 0) {
            const remaining = (limit - i) / limit;
            if (remaining <= threshold) {
              budgetPressureFired = true;
              const remainingTurns = limit - i;
              let warnMsg =
                `[Budget Pressure] ${remainingTurns}/${limit} turns remaining (${
                  Math.round(remaining * 100)
                }%). Complete the current task and summarize progress.`;
              if (budget !== undefined) {
                if (budget.canRenew()) {
                  warnMsg +=
                    ` If the task is genuinely unfinished, call ${IterationBudgetToolName} with a concrete reason.`;
                } else {
                  warnMsg +=
                    " The iteration budget can no longer be extended; finish the task and summarize progress.";
                }
              }
              this.sendEvent(ch, {
                type: EventBudgetPressure,
                pressureMessage: warnMsg,
                pressureType: "budget",
                pressurePercent: remaining * 100,
              });
              if (budget !== undefined) {
                this.injectTransientMessage(
                  newSystemInjectedUserMessage(warnMsg),
                );
              }
            }
          }
        }

        if (this.config.shouldStopAfterTurn !== undefined) {
          const [messagesSnapshot, contextSnapshot] = this.callbackSnapshot();
          if (
            this.config.shouldStopAfterTurn({
              message: assistantMsg,
              toolResults: cloneMessages(toolResults),
              context: contextSnapshot,
              newMessages: messagesSnapshot,
            })
          ) {
            this.#emitRunFinished(
              ch,
              TaskSuccess,
              "should_stop",
              undefined,
              usage,
              undefined,
            );
            ch({
              type: EventDone,
              stopReason: "should_stop",
              usage,
              contextUsage,
            });
            ch(this.agentEndEvent());
            return;
          }
        }

        if (this.config.prepareNextTurn !== undefined) {
          const [messagesSnapshot, contextSnapshot] = this.callbackSnapshot();
          const update = this.config.prepareNextTurn({
            message: assistantMsg,
            toolResults: cloneMessages(toolResults),
            context: contextSnapshot,
            newMessages: messagesSnapshot,
          });
          if (update !== undefined) {
            if (update.context !== undefined && update.context !== null) {
              this.#context = update.context;
            }
            if (update.model !== undefined) this.config.model = update.model;
            if ((update.thinkingLevel ?? "") !== "") {
              this.config.thinkingLevel = update.thinkingLevel;
            }
          }
        }

        if (this.config.getSteeringMessages !== undefined) {
          const steeringMessages = this.config.getSteeringMessages();
          if (steeringMessages.length > 0) {
            for (const msg of steeringMessages) {
              this.sendEvent(ch, { type: EventMessageStart, message: msg });
              this.sendEvent(ch, { type: EventMessageEnd, message: msg });
              this.#messages = [...this.#messages, msg];
              this.#messageIds = [...this.#messageIds, ""];
              this.#context.messages = [...this.#context.messages, msg];
            }
          }
        }
      }

      let maxErr = new Error(
        `max iterations (${this.config.maxIterations ?? 0}) exceeded`,
      );
      if (budget !== undefined) {
        maxErr = new Error(
          `max iterations (${budget.limitValue()}) exceeded (soft ${budget.softValue()}, hard ${budget.hardValue()}, ${budget.renewalsCount()} renewal(s) used)`,
        );
      }
      this.#emitRunFinished(
        ch,
        TaskIncomplete,
        "max_iterations",
        undefined,
        undefined,
        undefined,
      );
      ch({ type: EventError, error: maxErr, stopReason: "max_iterations" });
      ch(this.agentEndEvent());
    } finally {
      // Go's `defer cancelRun()`: the loop-owned run context is cancelled when
      // the loop returns, so spawned children whose runs derive from it are
      // cancelled with the parent run instead of leaking past its end.
      if (!runAbort.signal.aborted) {
        runAbort.abort(new DOMException("context canceled", "AbortError"));
      }
      this.setRunContext(undefined);
      removeAbortListeners();
    }
  }
}

// --- Construction ----------------------------------------------------------

/**
 * configureRegistryImageHint installs the provider/model image preprocessing
 * hint on the registry before tools are built.
 */
export function configureRegistryImageHint(
  cfg: Config,
  registry: Registry | undefined,
): void {
  if (registry === undefined) return;
  const hint: Hint = { providerID: cfg.vendor };
  if (cfg.provider !== undefined) {
    hint.providerName = cfg.provider.name();
    hint.api = cfg.provider.api();
    if ((hint.providerID ?? "") === "") hint.providerID = cfg.provider.name();
  }
  if (cfg.model !== undefined) {
    hint.modelID = cfg.model.id;
    if ((hint.providerID ?? "") === "") hint.providerID = cfg.model.provider;
  }
  if (cfg.settings !== undefined) {
    let providerKey = hint.providerID ?? "";
    if (providerKey === "") providerKey = cfg.settings.defaultProvider ?? "";
    const pc = getProviderConfig(cfg.settings, providerKey);
    if (pc !== undefined) {
      hint.vendor = pc.vendor;
      hint.baseURL = pc.baseUrl;
      if ((hint.api ?? "") === "") hint.api = pc.api;
    }
  }
  registry.setImageHint(hint);
}

/** Creates a new agent with default loop configuration. */
export function newAgent(
  cfg: Config,
  registry: Registry | undefined,
): Agent {
  const compactionSettings = normalizeCompactionSettings(
    cfg.compactionSettings ??
      { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
  );
  const normalized: Config = { ...cfg, compactionSettings };
  configureRegistryImageHint(normalized, registry);
  let toolExecutionMode = "parallel";
  let maxToolConcurrency = defaultToolExecutionMaxConcurrency;
  if (normalized.settings !== undefined) {
    const te = normalized.settings.toolExecution ?? {};
    toolExecutionMode = toolExecutionEffectiveMode(te);
    maxToolConcurrency = toolExecutionEffectiveMaxConcurrency(te);
  }
  const loopConfig: AgentLoopConfig = {
    ...normalized,
    toolExecutionMode,
    maxToolConcurrency,
    maxIterations: 200,
  };
  return finishConstruction(loopConfig, registry);
}

/** Creates a new agent with custom loop configuration. */
export function newAgentWithLoopConfig(
  cfg: AgentLoopConfig,
  registry: Registry | undefined,
): Agent {
  const normalized: AgentLoopConfig = { ...cfg };
  // ForcedMode is resolved by the front-end-neutral Runtime and inherited by
  // managed children; normalize Mode before building the frozen prompt.
  const forced = (cfg.forcedMode ?? "").trim();
  if (forced !== "") normalized.mode = forced;
  normalized.compactionSettings = normalizeCompactionSettings(
    cfg.compactionSettings ??
      { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
  );
  configureRegistryImageHint(normalized, registry);
  if ((normalized.maxIterations ?? 0) === 0) normalized.maxIterations = 200;
  if ((normalized.toolExecutionMode ?? "") === "") {
    if (normalized.settings !== undefined) {
      normalized.toolExecutionMode = toolExecutionEffectiveMode(
        normalized.settings.toolExecution ?? {},
      );
    } else {
      normalized.toolExecutionMode = "parallel";
    }
  }
  if ((normalized.maxToolConcurrency ?? 0) <= 0) {
    if (normalized.settings !== undefined) {
      normalized.maxToolConcurrency = toolExecutionEffectiveMaxConcurrency(
        normalized.settings.toolExecution ?? {},
      );
    }
    if ((normalized.maxToolConcurrency ?? 0) <= 0) {
      normalized.maxToolConcurrency = defaultToolExecutionMaxConcurrency;
    }
  }
  return finishConstruction(normalized, registry);
}

function finishConstruction(
  cfg: AgentLoopConfig,
  registry: Registry | undefined,
): Agent {
  const id = cfg.id !== undefined && cfg.id !== "" ? cfg.id : generateAgentID();
  const agent = new Agent(id, cfg.parentId ?? "", cfg, registry);
  // Build the frozen system prompt once at construction time (R2.1).
  agent.buildFrozenPrompt();
  const ctx = agent.getContext() ??
    { systemPrompt: "", messages: [], tools: [] };
  ctx.systemPrompt = agent.frozenSystemPrompt();
  ctx.tools = agent.frozenToolDefinitions();
  agent.setContext(ctx);
  return agent;
}
