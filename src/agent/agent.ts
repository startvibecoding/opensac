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
//   - `context.Context` maps to the `RunContext` value bag (`run_context.ts`)
//     carrying an `AbortSignal`; the typed context keys below are created with
//     the shared `contextKey` helper.
//   - `chan<- Event` will map to an event producer once the core loop lands; the
//     `Run*` entry points, `loop`, `sendEvent`/`emit`/`emitRunFinished`, and the
//     `eventSink` are deferred with the loop and tool-execution paths (see
//     docs/proposal/go-to-deno-migration.md backlog #19).
//   - `sync.RWMutex`/`sync/atomic` are dropped (Deno is single-threaded);
//     `atomic.Int64`/`Int32` map to plain number fields.
//   - `time.Now().UnixNano()` agent IDs map to a millisecond clock plus a
//     monotonic counter so generated IDs stay unique within a process.

import {
  type Attachment,
  calculateCost,
  type ChatParams,
  classifyTurn,
  type ContentBlock,
  formatUsage,
  type Message,
  type Model,
  newAssistantMessage,
  newSystemInjectedUserMessage,
  newToolResultMessage,
  newToolResultMessageWithContents,
  newUserMessage,
  normalizeThinkingLevel,
  type Provider,
  type ResponseArchive,
  type ResponseStateFailureClass,
  type ResponseStateFailureClassifier,
  type ResponseStateFallbackProvider,
  type ResponseStateModeProvider,
  responseStateFailureRequestFailed,
  type ThinkingLevel,
  type ToolCallBlock,
  type ToolDefinition,
  turnEmpty,
  type Usage,
} from "../provider/types.ts";
import { isContextOverflowError } from "../provider/context_overflow.ts";
import { isContentRejectionError } from "../provider/content_rejection.ts";
import { isStreamTimeoutError } from "../provider/idle_timeout.ts";
import { isRetryable, retryErrorDetail } from "../provider/retry.ts";
import { nextToolCallFallbackId } from "../provider/toolcall_id.ts";
import {
  DefaultToolExecutionMaxConcurrency,
  getProviderConfig,
  normalizeSamplingPtr,
  type Settings,
  toolExecutionEffectiveMaxConcurrency,
  toolExecutionEffectiveMode,
} from "../config/settings.ts";
import type { AllowConfig } from "../config/allow.ts";
import {
  type CompactionSettings,
  compactWithOptions,
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
import { type Registry, newRegistry } from "../tools/tool.ts";
import type { Sandbox } from "../sandbox/sandbox.ts";
import { Level } from "../sandbox/sandbox.ts";
import { newNoneSandbox } from "../sandbox/none.ts";
import { contextWithGitAccess, gitAccessRequired } from "../sandbox/git.ts";
import type { Manager as SessionManager } from "../session/manager.ts";
import { generateID } from "../session/entry.ts";
import {
  runAssistantEntryID,
  runUserEntryID,
} from "../session/run_user_message.ts";
import {
  claimToolExecutionRecord,
  compareAndSwapResponseSessionState,
  getResponseSessionState,
  listResponseReplayTurns,
  reclaimInterruptedToolExecution,
  type ResponseItemArchive,
  type ResponseSessionState,
  type ResponseTurn,
  saveResponseItem,
  saveResponseTurn,
  type ToolExecutionRecord,
  updateToolExecutionRecord,
} from "../session/response_store.ts";
import {
  contextWithOperationID,
  contextWithQuestionAsker,
  type ToolContext,
} from "../tools/tool.ts";
import {
  contextWithIterationBudget,
  emptyIterationBudgetPolicy,
  IterationBudget,
  IterationBudgetToolName,
  iterationBudgetPolicyEnabled,
  newIterationBudget,
  type IterationBudgetPolicy,
} from "./iteration_budget.ts";
import { boundedParallel } from "./parallel.ts";
import { newToolLaunchOrder, ToolLaunchHandle } from "./tool_launch.ts";
import { bashCommandArg, needsApproval } from "./agent_approval.ts";
import {
  type AgentContext,
  buildOutputRecoveryMessage,
  buildStreamRecoveryMessage,
  cloneAgentContext,
  cloneContentBlock,
  cloneMessage,
  cloneMessages,
  cloneMessagesWithoutUsage,
  configuredWebSearchToolDefinition,
  isOutputTruncationReason,
  isSideEffectingToolName,
  normalizeToolCallArguments,
  openAIResponsesWebSearchToolDefinition,
  parseToolExecutionResultSummary,
  replayTextContent,
  retryCompatibilityStatus,
  toolExecutionContext,
  toolExecutionResultSummary,
  usageStatsProviderName,
} from "./agent_support.ts";
import {
  buildSystemPromptWithOptions,
  type SystemPromptOptions,
} from "./system_prompt.ts";
import {
  clampMaxTokensToContext,
  containsImageContent,
  contextGuardToolResult,
  contentRejectionPlaceholder,
  contextTokenSafetyMargin,
  defaultAutoCompactionThreshold,
  encodedImagePayloadBytes,
  estimateChatRequestTokens,
  estimateGuardRequestTokens,
  isContextGuardToolResult,
  lastUserTurnIndex,
  maxContentRejectionStages,
  providerImageRequestBudget,
  repairDanglingToolCalls,
  selectCacheMarkers,
  stripImagesFromMessage,
  streamRecoveryRetryDelay,
  toolResultImages,
  unsupportedImageToolResultMessage,
  waitForStreamRecoveryRetry,
} from "./agent_context.ts";
import { applyCacheMarkers } from "./agent_context.ts";
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
  EventPlanUpdate,
  EventQuestionRequest,
  EventRetry,
  EventRunFinished,
  EventStatus,
  EventTextDelta,
  EventThinkDelta,
  EventToolApprovalRequest,
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
  TaskSuccess,
} from "./events.ts";
import { EventChannel } from "./event_channel.ts";
import type { AgentID } from "../../sdk/agent/types.ts";
import {
  agentIDKey,
  contextKey,
  contextValue,
  contextWithSignal,
  contextWithValue,
  type RunContext,
} from "./run_context.ts";
import { createHash } from "node:crypto";

// --- Run-scoped context helpers -------------------------------------------

/** The per-run event-channel context key. */
export const agentEventChanKey = contextKey<(ev: Event) => boolean>(
  "agentEventChan",
);

/** Carries the parent agent run context through tool timeouts. */
export const parentRunContextKey = contextKey<RunContext>("parentRunContext");

/** Carries the parent agent's execution mode for sub-agent inheritance. */
export const parentModeKey = contextKey<string>("parentMode");

/** Returns a copy of ctx carrying the agent ID. */
export function contextWithAgentID(
  ctx: RunContext | undefined,
  id: AgentID,
): RunContext {
  return contextWithValue(ctx, agentIDKey, id);
}

/** Extracts the agent ID, or `[undefined, false]`. */
export function agentIDFromContext(
  ctx: RunContext | undefined,
): [AgentID | undefined, boolean] {
  const id = contextValue(ctx, agentIDKey);
  return [id, id !== undefined];
}

/** Returns a copy of ctx carrying the event channel push function. */
export function contextWithEventChan(
  ctx: RunContext | undefined,
  ch: (ev: Event) => boolean,
): RunContext {
  return contextWithValue(ctx, agentEventChanKey, ch);
}

/** Extracts the event-channel push function, or `[undefined, false]`. */
export function eventChanFromContext(
  ctx: RunContext | undefined,
): [((ev: Event) => boolean) | undefined, boolean] {
  const ch = contextValue(ctx, agentEventChanKey);
  return [ch, ch !== undefined];
}

/** Returns a copy of ctx carrying the parent agent run context. */
export function contextWithParentRunContext(
  ctx: RunContext | undefined,
  parent: RunContext,
): RunContext {
  return contextWithValue(ctx, parentRunContextKey, parent);
}

/** Extracts the parent agent run context, or `[undefined, false]`. */
export function parentRunContextFromContext(
  ctx: RunContext | undefined,
): [RunContext | undefined, boolean] {
  const parent = contextValue(ctx, parentRunContextKey);
  return [parent, parent !== undefined];
}

/** Returns a copy of ctx carrying the parent agent's execution mode. */
export function contextWithParentMode(
  ctx: RunContext | undefined,
  mode: string,
): RunContext {
  return contextWithValue(ctx, parentModeKey, mode);
}

/** Extracts the parent agent's execution mode, or `[undefined, false]`. */
export function parentModeFromContext(
  ctx: RunContext | undefined,
): [string | undefined, boolean] {
  const mode = contextValue(ctx, parentModeKey);
  return [mode, mode !== undefined];
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
  /** Content of .mothx/rule.md (project rules). */
  ruleContent?: string;
  expertIdentity?: string;
  expertRoster?: string;
  compactionSettings?: CompactionSettings;
  approvalHandler?: (
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => boolean;
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
  getFollowUpMessages?: (ctx: RunContext) => Message[];
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
    if (configured <= 0) return DefaultToolExecutionMaxConcurrency;
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
   * Reports dropped events. The Go implementation logs to stderr; the loop
   * port will consume `droppedEvents` when the event channel lands.
   */
  logDroppedEvents(): void {
    // No-op until the event pipeline is ported.
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
  let maxToolConcurrency = DefaultToolExecutionMaxConcurrency;
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
      normalized.maxToolConcurrency = DefaultToolExecutionMaxConcurrency;
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
