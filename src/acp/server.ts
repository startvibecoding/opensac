// (the ACP stdio server shell and its
// non-prompt handlers) and internal/acp/extensions.go (the server-bound half
// of the Phase 1 additive extensions).
//
// Background: Go splits the `server` struct and its methods across `acp.go`,
// `extensions.go`, and `manage*.go`. TypeScript requires one class body per
// module, so `AcpServer` is declared here and grows across the remaining #35
// slices. This slice ports the transport/notification glue, `initialize` and
// `doctor`, every server-bound extension of §4.1–§4.8 (run status, session
// metadata/projects, workspace extension, decision-deadline reminders,
// sub-agent lifecycle events, and attachment listing), the session lifecycle
// handlers, the agent-event projection, and the prompt run
// (`handlePrompt`/`requestQuestion`/`requestPermission`). The stdio dispatch
// loop (`Run`) and the `opensac/manage/*` plane land in later slices.
//
// Deviations (see docs/proposal/go-to-deno-migration.md):
//   - Go's `sync.Mutex`/`sync.Once` are dropped; Deno's single-threaded event
//     loop runs these handlers without interleaving.
//   - `io.Writer` maps to a synchronous `AcpServerSink`, and `*bufio.Reader`
//     to the ported `ACPLineReader`.
//   - `json.RawMessage` ids are carried as their raw JSON text, so response
//     echoing and pending-response correlation stay verbatim.
//   - `time.Time` maps to `Date` and `time.Duration` to milliseconds.

import { createHash } from "node:crypto";
import { isAbortError, isTimeoutError } from "../util/errors.ts";
import { isAbsolute, normalize } from "@std/path";
import {
  calculateCost,
  type Message,
  type Model,
  newUserMessage,
  streamError,
  streamTextDelta,
  type ThinkingLevel,
  totalInputTokens,
  type Usage,
} from "../provider/types.ts";
import type { Provider } from "../provider/provider.ts";
import { createWithOptions, resolveModel } from "../provider/factory/mod.ts";
import {
  getSessionDir,
  isWebSearchEnabled,
  normalizeSamplingPtr,
  type Settings,
} from "../config/settings.ts";
import type { MCPServer } from "../config/mcp.ts";
import type { AllowConfig } from "../config/allow.ts";
import {
  COMMAND as systeminitCommand,
  prompt as systeminitPrompt,
} from "../systeminit/systeminit.ts";
import { ESMSteeringSource, ESMStore } from "../esm/mod.ts";
import { AgentAdapter, newAgentAdapter } from "../agent/bridge.ts";
import type { Agent } from "../agent/agent.ts";
import type { Manager as SkillsManager } from "../skills/mod.ts";
import type { Manager as SandboxManager } from "../sandbox/sandbox.ts";
import { resolveMaxTokens } from "../agent/max_tokens.ts";
import {
  registerDelegateSubAgentTool,
  registerSubAgentTools,
  subAgentToolNames,
} from "../agent/subagent.ts";
import { QuestionTool } from "../tools/question.ts";
import { registerWorkflowTools } from "../workflow/tools.ts";
import {
  buildRegistry,
  defaultPlanToolPolicy,
} from "../agentruntime/registry.ts";
import { newAgentManager } from "../agentruntime/agent_manager.ts";
import { attachSessionResources } from "../agentruntime/attach.ts";
import {
  createSession,
  deleteSession,
  openSessionForWorkDir,
} from "../agentruntime/session_lifecycle.ts";
import {
  CONFIG_OPTION_BROWSER,
  CONFIG_OPTION_EXPERT,
  CONFIG_OPTION_MODE,
  CONFIG_OPTION_SANDBOX,
  CONFIG_OPTION_THINKING_LEVEL,
  CONFIG_OPTION_WEB_SEARCH,
  type ProviderCatalog,
  sessionConfigOptionsWithProviders,
} from "../agentruntime/session_options.ts";
import {
  expertConfigOption,
  inspectExpert as inspectExpertBundle,
} from "../agentruntime/expert.ts";
import {
  fork as forkSessionPrefix,
  forkWithExpert as forkSessionPrefixWithExpert,
} from "../agentruntime/fork.ts";
import { type DurableRun, RunStore } from "../agentruntime/run_store.ts";
import type { RunEvent } from "../agentruntime/run_event.ts";
import type { ArtifactCollector } from "../agentruntime/artifact.ts";
import { withKnowledgeContext } from "../agentruntime/knowledgebase.ts";
import type { KnowledgeBaseReference } from "../agentruntime/knowledge_context.ts";
import {
  type InputIngress,
  type InputSubmission,
  resourceIds,
} from "../agentruntime/input_materializer.ts";
import {
  RUN_STATE_CANCELLED,
  RUN_STATE_COMPLETED,
  RUN_STATE_FAILED,
  RUN_STATE_TIMED_OUT,
  type RunState,
} from "../agentruntime/run_state.ts";
import { generateID } from "../session/entry.ts";
import { runUserEntryID } from "../session/run_user_message.ts";
import type { ExecutionIntent } from "../session/execution_intent.ts";
import {
  KnowledgeBaseNotFoundError,
  KnowledgeBaseUnindexedError,
} from "../session/knowledge_bases.ts";
import { current as appversionCurrent } from "../version/version.ts";
import {
  type Response as DoctorResponse,
  run as doctorRun,
} from "../doctor/doctor.ts";
import { rawIDKey, RPCError } from "../mcp/rpc.ts";
import { AttachmentService } from "../agentruntime/input.ts";
import { defaultAttachmentPolicy } from "../agentruntime/attachment.ts";
import { normalizeAdditionalDirectories } from "../agentruntime/session_directories.ts";
import {
  getActiveDurableRun,
  listLatestDurableRunsBySessions,
} from "../agentruntime/run_queries.ts";
import type { SessionRun } from "../session/run_store.ts";
import type { SessionRuntime } from "../agentruntime/session_runtime.ts";
import type { SessionConfigOption } from "../agentruntime/session_options.ts";
import {
  DECISION_APPROVAL,
  DECISION_QUESTION,
  type DecisionKind,
  type DecisionRequest,
  DecisionService,
} from "../agentruntime/decision.ts";
import type { DecisionRecord } from "../agentruntime/decision_record.ts";
import {
  type Event as AgentEvent,
  EVENT_COMPACTION_END,
  EVENT_COMPACTION_START,
  EVENT_DONE,
  EVENT_ERROR,
  EVENT_HOSTED_ITEM,
  EVENT_PLAN_UPDATE,
  EVENT_QUESTION_REQUEST,
  EVENT_RETRY,
  EVENT_RUN_FINISHED,
  EVENT_STATUS,
  EVENT_TEXT_DELTA,
  EVENT_THINK_DELTA,
  EVENT_TOOL_CALL,
  EVENT_TOOL_EXECUTION_END,
  EVENT_TOOL_EXECUTION_START,
  EVENT_TOOL_EXECUTION_UPDATE,
  EVENT_TOOL_RESULT,
  EVENT_TURN_END,
  EVENT_TURN_START,
  EVENT_USAGE,
  TASK_CANCELED,
  TASK_FAILED,
  TASK_INCOMPLETE,
  TASK_SUCCESS,
} from "../agent/events.ts";
import type { ContextUsage } from "../context/mod.ts";
import type { AgentManager } from "../agent/manager.ts";
import type { Manager as SessionManager } from "../session/manager.ts";
import {
  latestAdditionalDirectoriesByID,
  latestModelChangeByID,
  listAllDetailed,
  openByIDExact,
  type SessionDetail,
} from "../session/manager.ts";
import { acquireMutations } from "../session/runtime_lock.ts";
import { ExecutionRuntime } from "../agentruntime/execution.ts";
import { acquireExecutionAdmission } from "../agentruntime/execution_admission.ts";
import {
  loadDecisionRecords,
  recordDecisionEvent,
} from "../agentruntime/decision_events.ts";
import {
  expiredDecisions,
  replayDecisions,
  replayDecisionsAt,
} from "../agentruntime/decision_replay.ts";
import { SessionRunEventSink } from "../agentruntime/run_event.ts";
import { deleteSessionWithMutation } from "../agentruntime/session_lifecycle.ts";
import {
  MODE_YOLO,
  resolveSourceFromSession,
  SOURCE_ACP,
  SOURCE_UNKNOWN,
} from "../agentruntime/source.ts";
import {
  classifyError,
  displayErrorMessage,
  type ErrorInfo,
  FAILURE_INCOMPLETE,
  PHASE_ADMISSION,
  PHASE_MODEL,
  PHASE_PERSISTENCE,
  PHASE_TOOL,
  PHASE_TRANSPORT,
  RETRY_USER,
  type RunPhase,
} from "../agentruntime/error_info.ts";
import {
  listGeneratedArtifacts,
  listSessionAttachments,
} from "../session/artifacts.ts";
import {
  createProject,
  deleteProject,
  getSessionMetadata,
  latestSessionTitle,
  listProjects,
  listSessionMetadata,
  projectSessionCounts,
  renameProject,
  type SessionMetadata,
  setSessionMetadata,
} from "../session/projects.ts";
import {
  acquireMutation,
  type RuntimeLeaseGuard,
  runtimeLeaseLost,
} from "../session/runtime_lock.ts";
import type { Registry as ToolsRegistry } from "../tools/tool.ts";
import {
  type Callbacks as MCPCallbacks,
  type Client as MCPClient,
  closeClients,
  sanitizeToolName,
} from "../mcp/mcp.ts";
import {
  acpErrorEnvelope,
  type ACPLineReader,
  acpProtocolVersion,
  type ACPRPCRequest,
  readRequest as readACPRequest,
} from "./wire.ts";
import {
  acpEventName,
  acpHostedStatus,
  acpPlanEntries,
  acpPlanMeta,
  acpRetryEvent,
  acpRunStatus,
  acpStreamFallbackMessageID,
  acpStreamMessageID,
  acpStructuredRPCError,
  acpToolImageContents,
  acpToolKind,
  artifactSessionUpdate,
  decodeSessionCursor,
  encodeSessionCursor,
  opensacExtensionNamespace,
  questionProjectionFor,
  textToolContent,
  toolCallLocations,
} from "./projection.ts";
import {
  acpProjectResult,
  formatRFC3339,
  isZeroTime,
  sessionListLastRun as projectSessionListLastRun,
} from "./extensions.ts";
import {
  acpConfigValue,
  acpElicitationFormProtocol,
  elicitationRequestForQuestion,
  messageUpdates as projectMessageUpdates,
  normalizeStopReason,
  questionAnswer,
  type QuestionRequest,
  toolRawInput,
  ToolTitleRegistry,
  transcriptPage as projectTranscriptPage,
  type TranscriptPageResult,
} from "./support.ts";
import {
  formatEditorContext,
  requestEditorContext,
  type RequestMeta,
  requestParentSessionID,
  requestSurface,
  requestWorkspace,
  sessionModes,
  type SessionModeState,
} from "./metadata.ts";
import {
  type ContentBlock,
  type SessionUpdate,
  ToolCallContent,
} from "./protocol.ts";
import { acpPromptRequestSnapshot, promptToIngresses } from "./input.ts";

/**
 * RunOptions configure one ACP stdio process. Go's `time.Duration` fields map
 * to milliseconds; zero falls back to the documented ACP defaults.
 */
export interface ACPRunOptions {
  version?: string;
  provider?: string;
  model?: string;
  mode?: string;
  thinking?: string;
  sandbox?: boolean;
  verbose?: boolean;
  debug?: boolean;
  multiAgent?: boolean;
  delegate?: boolean;
  workflows?: boolean;
  webSearch?: boolean;
  browser?: boolean;
  artifact?: boolean;
  permissionTimeoutMs?: number;
  questionTimeoutMs?: number;
}

/** Documented ACP decision-deadline defaults (5 minutes). */
export const defaultPermissionTimeoutMs = 5 * 60 * 1000;
export const defaultQuestionTimeoutMs = 5 * 60 * 1000;

/**
 * Caps the negotiated workspace window so a buggy or hostile client cannot
 * grow the granted roots without bound (§4.3).
 */
export const workspaceAdditionalDirectoryLimit = 16;

/**
 * Decision-deadline reminder marks (§4.4): the first reminder fires at
 * `min(firstNoticeCapMs, timeout/2)` and the final notice at
 * `timeout - finalNoticeMs` when that mark is later than the first. Go keeps
 * these as mutable package vars only so tests can exercise both marks without
 * minute-scale sleeps; production code must not mutate them.
 */
export const acpDecisionDeadlineMarks = {
  firstNoticeCapMs: 60_000,
  finalNoticeMs: 60_000,
};

/** One destination for a newline-terminated ACP message. */
export interface AcpServerSink {
  write(data: string): void;
}

/** ACP `clientInfo` (name/title/version). */
export interface ACPClientInfo {
  name?: string;
  title?: string;
  version?: string;
}

/** ACP client fs capabilities. */
export interface ACPClientFSCapabilities {
  readTextFile?: boolean;
  writeTextFile?: boolean;
}

/** ACP client auth capabilities. */
export interface ACPClientAuthCapabilities {
  terminal?: boolean;
}

/** ACP client elicitation capabilities. */
export interface ACPClientElicitationCapabilities {
  form?: Record<string, never>;
  url?: Record<string, never>;
}

/** ACP client config-option capabilities. */
export interface ACPClientConfigOptionCapabilities {
  boolean?: Record<string, never>;
}

/** ACP client session capabilities. */
export interface ACPClientSessionCapabilities {
  configOptions?: ACPClientConfigOptionCapabilities;
}

/**
 * The typed client capability model. It stays typed even where the current
 * Runtime does not invoke client-owned reverse requests, so capability
 * negotiation is truthful.
 */
export interface ACPClientCapabilities {
  fs?: ACPClientFSCapabilities;
  terminal?: boolean;
  auth?: ACPClientAuthCapabilities;
  elicitation?: ACPClientElicitationCapabilities;
  session?: ACPClientSessionCapabilities;
}

/** ACP agent MCP capabilities. */
export interface ACPMCPCapabilities {
  http: boolean;
  sse: boolean;
}

/** ACP agent prompt capabilities. */
export interface ACPPromptCapabilities {
  image: boolean;
  audio: boolean;
  embeddedContext: boolean;
}

/**
 * ACP agent session capabilities. `session/new`, `session/prompt`,
 * `session/cancel`, and `session/update` are required ACP v1 baseline methods,
 * so only the additive lifecycle capabilities are flag-gated.
 */
export interface ACPSessionCapabilities {
  close?: Record<string, never>;
  delete?: Record<string, never>;
  list?: Record<string, never>;
  resume?: Record<string, never>;
  fork?: Record<string, never>;
  additionalDirectories?: Record<string, never>;
}

/** ACP agent capabilities. */
export interface ACPAgentCapabilities {
  loadSession: boolean;
  promptCapabilities: ACPPromptCapabilities;
  sessionCapabilities: ACPSessionCapabilities;
  mcpCapabilities: ACPMCPCapabilities;
  _meta?: Record<string, unknown>;
}

/** One advertised ACP auth method. */
export interface ACPAuthMethod {
  id: string;
  name: string;
  description?: string;
}

/** The `initialize` result. */
export interface ACPInitializeResult {
  protocolVersion: number;
  agentCapabilities: ACPAgentCapabilities;
  agentInfo: ACPClientInfo;
  authMethods: ACPAuthMethod[];
  _meta?: Record<string, unknown>;
}

/** The `opensac/doctor` request. */
export interface ACPDoctorRequest {
  cwd?: string;
}

/** The `opensac/session/setMeta` request. */
export interface ACPSessionSetMetaRequest {
  sessionId?: string;
  pinned?: boolean;
  projectId?: unknown;
  _meta?: RequestMeta;
}

/** The `opensac/session/setMeta` result. */
export interface ACPSessionSetMetaResult {
  pinned: boolean;
  projectId: string | null;
  updatedAt: string;
}

/** The `opensac/projects/*` request. */
export interface ACPProjectRequest {
  id?: string;
  name?: string;
}

/** The `opensac/workspace/extend` request. */
export interface ACPWorkspaceExtendRequest {
  additionalDirectories?: string[];
}

/** The `opensac/attachment/list` request. */
export interface ACPAttachmentListRequest {
  sessionId?: string;
  status?: string;
}

/** One `opensac/attachment/list` entry. */
export interface ACPAttachmentListEntry {
  attachmentId: string;
  filename: string;
  kind: string;
  mediaType: string;
  size: number;
  status: string;
  runId?: string;
  createdAt: string;
}

/** The `opensac/session/history` request. */
export interface ACPTranscriptPageRequest {
  sessionId?: string;
  cursor?: string;
  limit?: number;
}

/** The `session/list` and `opensac/session/listAll` request. */
export interface ACPListSessionsRequest {
  cwd?: string;
  additionalDirectories?: string[];
  cursor?: string;
  /** Only honored by `opensac/session/listAll` (`all`/`project`/`ungrouped`). */
  scope?: string;
  projectId?: string;
  query?: string;
  _meta?: RequestMeta;
}

/** One listed session projection. */
export interface ACPListedSession {
  sessionId: string;
  cwd: string;
  additionalDirectories?: string[];
  title?: string;
  provider: string;
  model: string;
  mode?: string;
  thoughtLevel?: string;
  parentSessionId?: string;
  updatedAt?: string;
  _meta?: Record<string, unknown>;
}

/** The `session/list` and `opensac/session/listAll` result. */
export interface ACPListSessionsResult {
  sessions: ACPListedSession[];
  nextCursor?: string;
}

/** The `session/close` request. */
export interface ACPCloseSessionRequest {
  sessionId?: string;
  _meta?: RequestMeta;
}

/** The `opensac/session/delete` / `session/delete` request. */
export interface ACPDeleteSessionRequest {
  sessionId?: string;
  _meta?: RequestMeta;
}

/** The `opensac/session/setTitle` request. */
export interface ACPSetTitleRequest {
  sessionId?: string;
  title?: string;
  _meta?: RequestMeta;
}

/** The `opensac/session/setWorkDir` request. */
export interface ACPSetWorkDirRequest {
  sessionId?: string;
  cwd?: string;
  _meta?: RequestMeta;
}

/** The `opensac/session/setWorkDir` result. */
export interface ACPSetWorkDirResult {
  cwd: string;
}

/** The `session/prompt` request. */
export interface ACPPromptRequest {
  sessionId?: string;
  prompt: ContentBlock[];
  /** Additive ACP input capability resolved by the shared Runtime. */
  knowledgeBaseRefs?: KnowledgeBaseReference[];
  _meta?: RequestMeta;
}

/** The `session/prompt` result. */
export interface ACPPromptResult {
  stopReason: string;
}

/**
 * Raised only when a persisted session points at a provider this ACP process
 * cannot construct or select. `acpFailureRPCError` maps it to the documented
 * `-32002` mismatch envelope instead of a generic failure.
 */
export class SessionProviderMismatchError extends Error {
  sessionProvider: string;
  sessionModel: string;
  currentProvider: string;

  constructor(
    sessionProvider: string,
    sessionModel: string,
    currentProvider: string,
    cause?: unknown,
  ) {
    super(
      cause === undefined || cause === null
        ? "session provider mismatch"
        : `session provider ${
          JSON.stringify(sessionProvider)
        } could not be selected: ${errorMessage(cause)}`,
    );
    this.name = "SessionProviderMismatchError";
    this.sessionProvider = sessionProvider;
    this.sessionModel = sessionModel;
    this.currentProvider = currentProvider;
  }
}

/**
 * Raised when a prompt cannot be admitted because the session already has an
 * active run (locally or in the durable store).
 */
export class ACPActiveSessionRunError extends Error {
  override name = "ACPActiveSessionRunError";

  constructor() {
    super("session already has an active run");
  }
}

/**
 * Session-cumulative prompt-cache totals projected on `usage_update` under
 * `_meta["opensac.dev"]` (feature key `usageCacheProjection`). One accumulator
 * serves both the persisted-history seed and live usage events.
 */
export class ACPCacheUsage {
  cacheRead = 0;
  cacheWrite = 0;
  inputTotal = 0;

  addTurn(cacheRead: number, cacheWrite: number, totalInput: number): void {
    this.cacheRead += cacheRead;
    this.cacheWrite += cacheWrite;
    this.inputTotal += totalInput;
  }

  /**
   * Projects the additive extension, or `undefined` while no input token has
   * been observed so clients keep the standard ACP payload.
   */
  meta(): Record<string, unknown> | undefined {
    if (this.inputTotal <= 0) return undefined;
    return {
      [opensacExtensionNamespace]: {
        cacheRead: this.cacheRead,
        cacheWrite: this.cacheWrite,
        totalInputTokens: this.inputTotal,
      },
    };
  }
}

/**
 * The per-session server state. Go's `sessionRuntime` struct is a plain data
 * carrier; the port keeps its zero-value defaults so fixtures can construct
 * one and set only the fields they exercise.
 */
export class ACPSessionRuntime {
  runtime: SessionRuntime | null = null;
  execution: ExecutionRuntime | null = null;
  decisions: DecisionService | null = null;
  id = "";
  mgr: SessionManager | null = null;
  registry: ToolsRegistry | null = null;
  mcp: MCPClient[] = [];
  agentMgr: AgentManager | null = null;
  promptID = "";
  runID = "";
  closed = false;
  terminalNotified = false;
  messageID = "";
  thoughtMessageID = "";
  userMessageID = "";
  streamSegment = 0;
  activeModel: Model | null = null;
  activeMode = "";
  activeThinking: ThinkingLevel = "";
  /** The public adapter of the Agent backing the active run (Go's `agent`). */
  agent: AgentAdapter | null = null;
  /** Cancels the in-flight prompt run (Go's `sessionRuntime.cancel`). */
  cancel: (() => void) | null = null;
  activeSkills = new Map<string, boolean>();
  cost = 0;
  usageCache = new ACPCacheUsage();

  /**
   * Releases the Runtime-owned resources of one session. The Runtime owns MCP
   * client lifetime, so a bound runtime closes them; legacy state carriers that
   * only own a raw client list close those directly (and idempotently).
   */
  closeResources(): void {
    if (this.runtime !== null) {
      this.runtime.close();
      this.mcp = [];
      return;
    }
    if (this.mcp.length > 0) closeClients(this.mcp);
    this.mcp = [];
  }
}

/**
 * Tracks which sub-agent lifecycle events were already projected for one
 * session so exactly one `started` and one terminal event are emitted per
 * child agent.
 */
export interface ACPSubagentProjection {
  started: boolean;
  terminal: boolean;
  memberId: string;
  expertId: string;
  memberDisplayName: string;
  memberEmoji: string;
  memberRole: string;
}

/** The projected expert/team metadata of one sub-agent event. */
export interface ACPSubagentEventMeta {
  memberId: string;
  expertId: string;
  memberDisplayName: string;
  memberEmoji: string;
  memberRole: string;
}

/** ACP `initialize` request params. */
interface ACPInitializeRequest {
  protocolVersion?: number;
  clientCapabilities?: unknown;
  clientInfo?: ACPClientInfo;
  _meta?: RequestMeta;
}

/**
 * The ACP stdio server. Construct one, bind a sink (and optionally a line
 * reader), and call the handlers directly; `Run` (the stdio dispatch loop)
 * lands in a later slice.
 */
export class AcpServer {
  settings: Settings | null = null;
  cwd = "";
  version = "";
  /** The configured provider name, used as the last-resort list default. */
  providerName = "";
  /** The configured model, used as the last-resort list default. */
  m: Model | null = null;
  mode = "";
  /** The configured thinking level (Go's `server.thinkingLevel`). */
  thinkingLevel = "";
  artifact = false;
  artifactOverride = false;
  runtime: SessionRuntime | null = null;
  agentMgr: AgentManager | null = null;
  /** The primary provider constructed at startup (Go's `server.p`). */
  p: Provider | null = null;
  /**
   * The provider catalog built once at startup so ACP can advertise every
   * usable configured provider and switch a session without restarting.
   */
  providers: ProviderCatalog = {};
  /** The shared sandbox manager (Go's `server.sbMgr`). */
  sbMgr: SandboxManager | null = null;
  /** The shared skills manager (Go's `server.skillsMgr`). */
  skillsMgr: SkillsManager | null = null;
  /** The shared extra context/rules injected into each session. */
  extraContext = "";
  ruleContent = "";
  /** Adapter-level workflow/browser/multi-agent/delegate policy. */
  workflows = false;
  browser = false;
  multiAgent = false;
  delegate = false;
  /** The loaded allow configuration (Go's `server.allow`). */
  allow: AllowConfig | undefined = undefined;
  sessions = new Map<string, ACPSessionRuntime>();
  pending = new Map<string, (payload: unknown) => void>();
  /** Per-session tool-call title cache (Go's `server.toolTitles`). */
  toolTitles = new ToolTitleRegistry();
  mcpNotify = new Map<string, boolean>();
  initialized = false;
  clientCaps: ACPClientCapabilities = {};
  subagents = new Map<string, ACPSubagentProjection>();
  /**
   * The negotiated workspace window: the only roots this ACP process may
   * expose. It stays empty for direct/unit fixtures that do not negotiate
   * workspace metadata.
   */
  workspaceCwd = "";
  workspaceAdditionalDirectories: string[] = [];
  nextID = 0;
  sink: AcpServerSink | null = null;
  reader: ACPLineReader | null = null;
  permissionTimeoutMs = 0;
  questionTimeoutMs = 0;
  // Phase 3 management-plane cron runtime (manage.go): lazily started SQLite
  // store + scheduler, plus the AgentManager dedicated to cron runs.
  cronScheduler: import("../cron/scheduler.ts").Scheduler | null = null;
  cronStore: import("../cron/cron.ts").CronStore | null = null;
  cronAgentMgr: AgentManager | null = null;
  /** Process-wide cached Runtime knowledge-base service. */
  knowledgeService:
    | import("../agentruntime/knowledgebase.ts").KnowledgeBaseService
    | null = null;

  // ─── transport and notification glue ──────────────────────────────────────

  /** Writes one JSON value as a single newline-terminated message. */
  writeMessage(value: unknown): void {
    this.writeRaw(JSON.stringify(value) + "\n");
  }

  /** Writes already-serialized output verbatim (used for raw-id echoes). */
  private writeRaw(line: string): void {
    if (this.sink === null) {
      throw new Error("ACP message sink is not bound");
    }
    this.sink.write(line);
  }

  /**
   * Writes a response, echoing the raw request id verbatim. A missing or blank
   * id denotes a JSON-RPC notification and receives no response; an explicit
   * JSON `null` remains a request id and is preserved.
   */
  writeResponse(
    idRaw: string | null,
    result: unknown,
    errResp: RPCError | null,
  ): void {
    if (idRaw === null || idRaw.trim() === "") return;
    const body = errResp !== null
      ? `"error":${JSON.stringify(acpErrorEnvelope(errResp))}`
      : `"result":${JSON.stringify(result ?? null)}`;
    this.writeRaw(`{"jsonrpc":"2.0","id":${idRaw.trim()},${body}}\n`);
  }

  /** Delivers one reverse-request response to its pending callback. */
  deliverResponse(
    idRaw: string | null,
    result: unknown,
    errMsg: unknown,
  ): void {
    if (idRaw === null) return;
    const key = rawIDKey(idRaw);
    const callback = this.pending.get(key);
    if (callback === undefined) return;
    this.pending.delete(key);
    callback(errMsg !== undefined && errMsg !== null ? errMsg : result);
  }

  /** Forgets one pending reverse request. */
  deletePending(id: string): void {
    this.pending.delete(id);
  }

  /** Writes a `session/update` notification. */
  notify(sessionId: string, update: SessionUpdate): void {
    this.writeMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    });
  }

  /** Writes a `session_info_update` after a persisted session mutation. */
  notifySessionInfo(sessionId: string): void {
    let title = "";
    const rt = this.sessionRuntime(sessionId);
    if (rt !== null && rt.mgr !== null) {
      title = latestSessionTitle(rt.mgr.getSessionDir(), sessionId).name;
    } else if (this.settings !== null) {
      title = latestSessionTitle(getSessionDir(this.settings), sessionId).name;
    }
    this.notify(sessionId, {
      sessionUpdate: "session_info_update",
      title,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Writes an extension notification under its method name. */
  notifyExtension(method: string, params: unknown): void {
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  /** Writes a standard ACP reverse request with a string id. */
  notifyRequest(id: string, method: string, params: unknown): void {
    this.writeMessage({ jsonrpc: "2.0", id, method, params });
  }

  /** Returns the next process-local ACP reverse-request id (`acp-N`). */
  nextRequestID(): string {
    this.nextID++;
    return `acp-${this.nextID}`;
  }

  /** Reads one request line, or null at EOF. */
  async readRequest(): Promise<ACPRPCRequest | null> {
    if (this.reader === null) return null;
    return await readACPRequest(this.reader);
  }

  // ─── shared server helpers ────────────────────────────────────────────────

  /** Reports whether ACP artifact publishing is enabled for this process. */
  artifactEnabled(): boolean {
    return this.artifact;
  }

  /**
   * Updates the ACP/Desktop artifact policy for subsequent runs without moving
   * the setting into Electron-owned presentation storage. A CLI override stays
   * authoritative for the lifetime of this process.
   */
  applyACPArtifactSetting(enabled: boolean): void {
    if (this.settings !== null) {
      this.settings.enableACPArtifact = enabled;
    }
    this.artifact = enabled || this.artifactOverride;
    const effective = this.artifact;
    const runtimes: SessionRuntime[] = [];
    if (this.runtime !== null) runtimes.push(this.runtime);
    for (const session of this.sessions.values()) {
      if (session.runtime !== null) runtimes.push(session.runtime);
    }
    for (const runtime of runtimes) {
      runtime.setArtifactEnabled(effective);
    }
  }

  /** Returns the effective approval decision deadline in milliseconds. */
  effectivePermissionTimeoutMs(): number {
    if (this.permissionTimeoutMs > 0) return this.permissionTimeoutMs;
    return defaultPermissionTimeoutMs;
  }

  /** Returns the effective question decision deadline in milliseconds. */
  effectiveQuestionTimeoutMs(): number {
    if (this.questionTimeoutMs > 0) return this.questionTimeoutMs;
    return defaultQuestionTimeoutMs;
  }

  /** Returns the configured or product version string. */
  productVersion(): string {
    if (this.version.trim() !== "") return this.version;
    return appversionCurrent();
  }

  /** Reports whether `initialize` has completed on this server. */
  acpInitialized(): boolean {
    return this.initialized;
  }

  /** Returns the open session state for one exact session id. */
  sessionRuntime(sessionId: string): ACPSessionRuntime | null {
    if (sessionId.trim() === "") return null;
    return this.sessions.get(sessionId) ?? null;
  }

  /** Returns the resolved config options of one open session. */
  sessionConfigOptions(sessionId: string): SessionConfigOption[] | undefined {
    const rt = this.sessionRuntime(sessionId);
    if (rt === null || rt.runtime === null) return undefined;
    return rt.runtime.configOptions();
  }

  /** Serializes a value as JSON text (Go's `json.Marshal` projection). */
  mustJSON(value: unknown): string {
    return JSON.stringify(value);
  }

  /**
   * Combines request-level workspace metadata with the top-level
   * cwd/additionalDirectories fields and applies the window negotiated during
   * `initialize`. A process without negotiated metadata keeps the permissive
   * behavior needed by embedded/unit callers.
   */
  resolveWorkspace(
    meta: RequestMeta | undefined,
    requestedCwd: string,
    requestedAdditional?: string[],
  ): { cwd: string; additionalDirectories: string[] } {
    const configuredCwd = this.workspaceCwd;
    const configuredAdditional = [...this.workspaceAdditionalDirectories];
    const fallbackCwd = this.cwd;

    const spec = requestWorkspace(meta);
    requestedCwd = requestedCwd.trim();
    if (spec !== undefined && (spec.cwd ?? "").trim() !== "") {
      const metaCwd = filepathClean((spec.cwd ?? "").trim());
      if (!isAbsolute(metaCwd)) {
        throw new Error("workspace cwd must be an absolute path");
      }
      if (requestedCwd !== "" && filepathClean(requestedCwd) !== metaCwd) {
        throw new Error("cwd does not match workspace cwd");
      }
      requestedCwd = metaCwd;
    }
    if (requestedCwd === "") requestedCwd = configuredCwd;
    if (requestedCwd === "") requestedCwd = fallbackCwd;
    if (requestedCwd !== "") {
      if (!isAbsolute(requestedCwd)) {
        throw new Error("cwd must be an absolute path");
      }
      requestedCwd = filepathClean(requestedCwd);
    }

    let additional: string[];
    if (requestedAdditional !== undefined) {
      additional = requestedAdditional;
    } else if (spec !== undefined) {
      additional = spec.additionalDirectories ?? [];
    } else {
      additional = [];
    }
    const normalizedAdditional = normalizeAdditionalDirectories(additional);

    if (configuredCwd !== "") {
      const allowed = new Set<string>([filepathClean(configuredCwd)]);
      for (const directory of configuredAdditional) {
        allowed.add(filepathClean(directory));
      }
      if (requestedCwd === "") {
        throw new Error("workspace cwd is required");
      }
      if (!allowed.has(requestedCwd)) {
        throw new Error("cwd is outside the negotiated workspace");
      }
      for (const directory of normalizedAdditional) {
        if (!allowed.has(directory)) {
          throw new Error(
            `additional directory is outside the negotiated workspace: ${directory}`,
          );
        }
      }
    }
    return { cwd: requestedCwd, additionalDirectories: normalizedAdditional };
  }

  /**
   * Synchronizes the additional directories of one open session under the
   * shared mutation lease.
   */
  setSessionAdditionalDirectories(
    rt: ACPSessionRuntime | null,
    directories: string[],
  ): void {
    if (rt === null || rt.runtime === null) {
      throw new Error("session runtime is unavailable");
    }
    const normalized = normalizeAdditionalDirectories(directories);
    const runtime = rt.runtime;
    if (sameStringSlice(normalized, runtime.additionalDirectoriesSnapshot())) {
      return;
    }
    this.withSessionMutationLease(rt.id, () => {
      runtime.setAdditionalDirectories(normalized);
    });
  }

  /**
   * Runs a mutation under the shared session mutation lease. A prompt in this
   * process already owns the authoritative lease, so its own writes only
   * validate that lease's epoch and token.
   */
  withSessionMutationLease(sessionId: string, mutate: () => void): void {
    if (this.settings === null || sessionId.trim() === "") {
      mutate();
      return;
    }
    const sessionDir = getSessionDir(this.settings);
    if (runtimeLeaseLost(sessionDir, sessionId) !== undefined) {
      mutate();
      return;
    }
    let guard: RuntimeLeaseGuard;
    try {
      guard = acquireMutation(sessionDir, sessionId);
    } catch {
      throw new Error("session already has an active run");
    }
    try {
      mutate();
    } finally {
      guard.release();
    }
  }

  // ─── initialize / doctor ──────────────────────────────────────────────────

  /** Handles `initialize` and negotiates the workspace window. */
  handleInitialize(req: ACPRPCRequest): void {
    let inRequest: ACPInitializeRequest;
    if (req.params === undefined || req.params === null) {
      // Keep direct unit fixtures and legacy embedders working; wire clients
      // must provide protocolVersion per ACP v1.
      inRequest = { protocolVersion: acpProtocolVersion };
    } else {
      inRequest = decodeInitializeRequest(req.params);
      if (inRequest.protocolVersion !== acpProtocolVersion) {
        this.writeResponse(
          req.idRaw,
          null,
          new RPCError(
            -32602,
            `unsupported protocolVersion ${inRequest.protocolVersion ?? 0}`,
          ),
        );
        return;
      }
    }
    let workspaceCwd = "";
    let workspaceAdditionalDirectories: string[] = [];
    try {
      const resolved = this.resolveWorkspace(inRequest._meta, "");
      workspaceCwd = resolved.cwd;
      workspaceAdditionalDirectories = resolved.additionalDirectories;
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, errorMessage(error)),
      );
      return;
    }
    if (this.initialized) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32600, "initialize may only be called once"),
      );
      return;
    }
    this.initialized = true;
    this.clientCaps = decodeClientCapabilities(inRequest.clientCapabilities);
    if (
      requestWorkspace(inRequest._meta) !== undefined && workspaceCwd !== ""
    ) {
      this.workspaceCwd = workspaceCwd;
      this.workspaceAdditionalDirectories = workspaceAdditionalDirectories;
    }

    const meta: Record<string, unknown> = {
      [opensacExtensionNamespace]: {
        minClientProtocol: 1,
        doctor: true,
        requestQuestion: true,
        sessionEvent: true,
        artifactProjection: true,
        attachmentFetch: true,
        artifactEnabled: this.artifactEnabled(),
        features: [
          "sessionConfigProvider",
          "sessionDraftConfigOptions",
          "sessionDelete",
          "sessionSetTitle",
          "sessionListCwd",
          "sessionListAll",
          "sessionWorkDir",
          "sessionHistoryPaging",
          "sessionFork",
          "editorContext",
          "doctor",
          "requestQuestion",
          "artifactProjection",
          "attachmentFetch",
          "runStatus",
          "sessionMeta",
          "projects",
          "workspaceExtend",
          "decisionDeadline",
          "subagentEvents",
          "toolResultImages",
          // usage_update carries the cumulative prompt-cache totals under
          // _meta["opensac.dev"] only while this key is advertised.
          "usageCacheProjection",
          "attachmentList",
          "manageSettings",
          "manageApplicationSettings",
          "manageProviders",
          "manageProviderConfig",
          "manageSkills",
          "manageMcp",
          "manageCron",
          "manageStats",
          "manageMemory",
          "manageSkillHub",
          "manageSkillHubCatalog",
          "manageExperts",
          "manageKnowledgeBases",
          "manageEnv",
          "manageDeliveries",
          "knowledgeGraphIndex",
          "knowledgeBaseContext",
        ],
      },
    };
    const result: ACPInitializeResult = {
      protocolVersion: acpProtocolVersion,
      agentCapabilities: {
        loadSession: true,
        // promptToIngresses materializes image/audio content blocks and
        // embedded resource/resource_link content through the Runtime input
        // contract, so the negotiated capabilities declare them truthfully.
        promptCapabilities: {
          image: true,
          audio: true,
          embeddedContext: true,
        },
        sessionCapabilities: {
          close: {},
          delete: {},
          list: {},
          resume: {},
          fork: {},
          additionalDirectories: {},
        },
        mcpCapabilities: { http: true, sse: true },
        _meta: meta,
      },
      agentInfo: {
        name: "opensac",
        title: "OpenSAC",
        version: this.productVersion(),
      },
      authMethods: [],
      _meta: meta,
    };
    this.writeResponse(req.idRaw, result, null);
  }

  /** Handles `opensac/doctor`. */
  handleDoctor(req: ACPRPCRequest): void {
    let inRequest: ACPDoctorRequest = {};
    const params = req.params;
    if (params !== undefined && params !== null) {
      if (typeof params !== "object" || Array.isArray(params)) {
        this.writeResponse(
          req.idRaw,
          null,
          new RPCError(-32602, "invalid params"),
        );
        return;
      }
      const record = params as Record<string, unknown>;
      if (typeof record.cwd === "string") inRequest = { cwd: record.cwd };
    }
    const requestedCwd = inRequest.cwd ?? "";
    if (requestedCwd !== "" && !isAbsolute(requestedCwd)) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "cwd must be an absolute path"),
      );
      return;
    }
    const cwd = requestedCwd !== "" ? requestedCwd : this.cwd;
    const result: DoctorResponse = doctorRun(cwd, this.productVersion());
    this.writeResponse(req.idRaw, result, null);
  }

  // ─── §4.1 session run status ──────────────────────────────────────────────

  /**
   * Projects the additive `run_status` session event at durable run
   * begin/finish. It complements (never replaces) the terminal event and the
   * prompt response.
   */
  notifyRunStatus(sessionId: string, runId: string, status: string): void {
    this.notifyExtension("_opensac/session_event", {
      sessionId,
      event: "run_status",
      runId,
      status,
    });
  }

  /**
   * Re-reads the canonical durable Run after an advisory cross-process
   * lease-bus wake-up. UDP data never becomes projected state directly.
   */
  notifyExternalRunStatus(sessionId: string): void {
    if (this.settings === null || sessionId.trim() === "") return;
    const sessionDir = getSessionDir(this.settings);
    let runs: Map<string, SessionRun>;
    try {
      runs = listLatestDurableRunsBySessions(sessionDir, [sessionId]);
    } catch (error) {
      console.error(`[acp] refresh external run ${sessionId}: ${error}`);
      return;
    }
    const run = runs.get(sessionId);
    if (run === undefined || run.id === "") return;
    let status = acpRunStatus(run.status);
    let runId = run.id;
    try {
      const active = getActiveDurableRun(sessionDir, sessionId);
      if (active !== null) {
        runId = active.id;
        status = "running";
      }
    } catch {
      // A read failure keeps the latest durable projection.
    }
    this.notifyRunStatus(sessionId, runId, status);
  }

  /**
   * Assembles the additive `listedSession._meta.lastRun` projection for one
   * page of sessions.
   */
  sessionListLastRun(
    sessionIds: string[],
  ): Record<string, Record<string, unknown>> {
    if (this.settings === null) return {};
    return projectSessionListLastRun(getSessionDir(this.settings), sessionIds);
  }

  // ─── §4.2 session metadata (pinned/project) and projects ──────────────────

  /**
   * Serves `opensac/session/setMeta`: a thin projection of
   * `session.setSessionMetadata`. Absent fields keep their persisted values,
   * an explicit null `projectId` clears the assignment, and the change is
   * broadcast as a `session_info_update`.
   */
  handleSetSessionMeta(req: ACPRPCRequest): void {
    const inRequest = (req.params ?? {}) as ACPSessionSetMetaRequest;
    const sessionId = typeof inRequest.sessionId === "string"
      ? inRequest.sessionId.trim()
      : "";
    const raw = req.params;
    const malformed = raw === undefined || raw === null ||
      typeof raw !== "object" || Array.isArray(raw);
    if (malformed || sessionId === "") {
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32602,
          "invalid_params",
          "sessionId is required",
        ),
      );
      return;
    }
    if (inRequest.pinned === undefined && inRequest.projectId === undefined) {
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32602,
          "invalid_params",
          "pinned or projectId is required",
        ),
      );
      return;
    }
    let present = false;
    let projectValue = "";
    if (inRequest.projectId !== undefined) {
      if (
        inRequest.projectId !== null && typeof inRequest.projectId !== "string"
      ) {
        this.writeResponse(
          req.idRaw,
          null,
          acpStructuredRPCError(
            -32602,
            "invalid_params",
            "projectId must be a string or null",
          ),
        );
        return;
      }
      present = true;
      projectValue = typeof inRequest.projectId === "string"
        ? inRequest.projectId.trim()
        : "";
    }
    if (this.settings === null) {
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32000,
          "session_meta_unavailable",
          "ACP settings are unavailable",
        ),
      );
      return;
    }
    const sessionDir = getSessionDir(this.settings);
    let header = null;
    try {
      header = openByIDExact(sessionDir, sessionId).getHeader();
    } catch {
      header = null;
    }
    if (header === null) {
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32000,
          "session_not_found",
          `session ${sessionId} is not available`,
        ),
      );
      return;
    }
    try {
      this.resolveWorkspace(inRequest._meta, header.cwd);
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32000,
          "workspace_forbidden",
          errorMessage(error),
        ),
      );
      return;
    }
    let existing: SessionMetadata;
    try {
      existing = getSessionMetadata(sessionDir, sessionId);
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32000,
          "session_meta_unavailable",
          `load session metadata: ${errorMessage(error)}`,
        ),
      );
      return;
    }
    const merged: SessionMetadata = {
      projectId: existing.projectId,
      pinned: existing.pinned,
    };
    if (inRequest.pinned !== undefined) merged.pinned = inRequest.pinned;
    if (present) merged.projectId = projectValue;
    try {
      setSessionMetadata(sessionDir, sessionId, merged);
    } catch (error) {
      const message = errorMessage(error);
      const code = message.toLowerCase().includes("project not found")
        ? "project_not_found"
        : "session_meta_unavailable";
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(-32000, code, message),
      );
      return;
    }
    let stored: SessionMetadata;
    try {
      stored = getSessionMetadata(sessionDir, sessionId);
      if (stored.updatedAt === undefined || isZeroTime(stored.updatedAt)) {
        stored = { ...merged, updatedAt: new Date() };
      }
    } catch {
      stored = { ...merged, updatedAt: new Date() };
    }
    this.notifySessionMetaInfo(sessionId, stored);
    const projectId = (stored.projectId ?? "") !== ""
      ? stored.projectId!
      : null;
    const result: ACPSessionSetMetaResult = {
      pinned: stored.pinned,
      projectId,
      updatedAt: (stored.updatedAt ?? new Date()).toISOString(),
    };
    this.writeResponse(req.idRaw, result, null);
  }

  /**
   * Projects the standard `session_info_update` carrying the additive
   * `_meta.pinned`/`_meta.projectId` keys after a persisted metadata change.
   */
  notifySessionMetaInfo(sessionId: string, metadata: SessionMetadata): void {
    let title = "";
    if (this.settings !== null) {
      title = latestSessionTitle(getSessionDir(this.settings), sessionId).name;
    }
    const meta: Record<string, unknown> = { pinned: metadata.pinned };
    meta.projectId = (metadata.projectId ?? "") !== ""
      ? metadata.projectId
      : null;
    const updatedAt = metadata.updatedAt !== undefined &&
        !isZeroTime(metadata.updatedAt)
      ? metadata.updatedAt
      : new Date();
    this.notify(sessionId, {
      sessionUpdate: "session_info_update",
      title,
      updatedAt: updatedAt.toISOString(),
      _meta: meta,
    });
  }

  /** Assembles the additive pinned/projectId keys of `_meta` for one page. */
  sessionListMetadata(
    sessionIds: string[],
  ): Map<string, SessionMetadata> {
    if (this.settings === null || sessionIds.length === 0) return new Map();
    try {
      return listSessionMetadata(getSessionDir(this.settings), sessionIds);
    } catch (error) {
      console.error(`[acp] list session metadata: ${error}`);
      return new Map();
    }
  }

  /** Serves `opensac/projects/list`. */
  handleProjectsList(req: ACPRPCRequest): void {
    if (this.settings === null) {
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32000,
          "projects_unavailable",
          "ACP settings are unavailable",
        ),
      );
      return;
    }
    const sessionDir = getSessionDir(this.settings);
    let projects;
    try {
      projects = listProjects(sessionDir);
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32000,
          "projects_unavailable",
          `list projects: ${errorMessage(error)}`,
        ),
      );
      return;
    }
    let counts: Map<string, number>;
    try {
      counts = projectSessionCounts(sessionDir);
    } catch (error) {
      console.error(`[acp] project session counts: ${error}`);
      counts = new Map();
    }
    const items = projects.map((project) =>
      acpProjectResult(project, counts.get(project.id) ?? 0)
    );
    this.writeResponse(req.idRaw, { projects: items }, null);
  }

  /** Serves `opensac/projects/create`. */
  handleProjectsCreate(req: ACPRPCRequest): void {
    const inRequest = (req.params ?? {}) as ACPProjectRequest;
    const name = typeof inRequest.name === "string"
      ? inRequest.name.trim()
      : "";
    const malformed = req.params === undefined || req.params === null ||
      typeof req.params !== "object" || Array.isArray(req.params);
    if (malformed || name === "") {
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(-32602, "invalid_params", "name is required"),
      );
      return;
    }
    if (this.settings === null) {
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32000,
          "projects_unavailable",
          "ACP settings are unavailable",
        ),
      );
      return;
    }
    try {
      const project = createProject(getSessionDir(this.settings), name);
      this.writeResponse(req.idRaw, acpProjectResult(project), null);
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32000,
          "projects_unavailable",
          `create project: ${errorMessage(error)}`,
        ),
      );
    }
  }

  /** Serves `opensac/projects/rename`. */
  handleProjectsRename(req: ACPRPCRequest): void {
    const inRequest = (req.params ?? {}) as ACPProjectRequest;
    const id = typeof inRequest.id === "string" ? inRequest.id.trim() : "";
    const name = typeof inRequest.name === "string"
      ? inRequest.name.trim()
      : "";
    const malformed = req.params === undefined || req.params === null ||
      typeof req.params !== "object" || Array.isArray(req.params);
    if (malformed || id === "" || name === "") {
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32602,
          "invalid_params",
          "id and name are required",
        ),
      );
      return;
    }
    if (this.settings === null) {
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32000,
          "projects_unavailable",
          "ACP settings are unavailable",
        ),
      );
      return;
    }
    try {
      const project = renameProject(getSessionDir(this.settings), id, name);
      this.writeResponse(req.idRaw, acpProjectResult(project), null);
    } catch (error) {
      const message = errorMessage(error);
      const code = message.toLowerCase().includes("project not found")
        ? "project_not_found"
        : "projects_unavailable";
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(-32000, code, `rename project: ${message}`),
      );
    }
  }

  /** Serves `opensac/projects/delete`. */
  handleProjectsDelete(req: ACPRPCRequest): void {
    const inRequest = (req.params ?? {}) as ACPProjectRequest;
    const id = typeof inRequest.id === "string" ? inRequest.id.trim() : "";
    const malformed = req.params === undefined || req.params === null ||
      typeof req.params !== "object" || Array.isArray(req.params);
    if (malformed || id === "") {
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(-32602, "invalid_params", "id is required"),
      );
      return;
    }
    if (this.settings === null) {
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32000,
          "projects_unavailable",
          "ACP settings are unavailable",
        ),
      );
      return;
    }
    try {
      deleteProject(getSessionDir(this.settings), id);
      this.writeResponse(req.idRaw, {}, null);
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32000,
          "projects_unavailable",
          `delete project: ${errorMessage(error)}`,
        ),
      );
    }
  }

  // ─── §4.3 dynamic workspace extension ─────────────────────────────────────

  /**
   * Serves `opensac/workspace/extend`: grow-only expansion of the workspace
   * window negotiated at `initialize`. The cwd is immutable and the window
   * never shrinks.
   */
  handleWorkspaceExtend(req: ACPRPCRequest): void {
    const inRequest = (req.params ?? {}) as ACPWorkspaceExtendRequest;
    const malformed = req.params === undefined || req.params === null ||
      typeof req.params !== "object" || Array.isArray(req.params);
    const requestedRaw = Array.isArray(inRequest.additionalDirectories)
      ? inRequest.additionalDirectories
      : [];
    if (malformed || requestedRaw.length === 0) {
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32602,
          "invalid_params",
          "additionalDirectories is required",
        ),
      );
      return;
    }
    const requested: string[] = [];
    for (const raw of requestedRaw) {
      const value = typeof raw === "string" ? raw.trim() : "";
      if (value === "" || !isAbsolute(value)) {
        this.writeResponse(
          req.idRaw,
          null,
          acpStructuredRPCError(
            -32602,
            "workspace_directory_invalid",
            `additional directory must be an absolute path: ${
              JSON.stringify(raw)
            }`,
          ),
        );
        return;
      }
      let resolved: string;
      try {
        resolved = Deno.realPathSync(filepathClean(value));
      } catch {
        this.writeResponse(
          req.idRaw,
          null,
          acpStructuredRPCError(
            -32602,
            "workspace_directory_unavailable",
            `additional directory ${JSON.stringify(value)} cannot be resolved`,
          ),
        );
        return;
      }
      let isDir = false;
      try {
        isDir = Deno.statSync(resolved).isDirectory;
      } catch {
        isDir = false;
      }
      if (!isDir) {
        this.writeResponse(
          req.idRaw,
          null,
          acpStructuredRPCError(
            -32602,
            "workspace_directory_unavailable",
            `additional directory ${
              JSON.stringify(value)
            } is not an existing directory`,
          ),
        );
        return;
      }
      requested.push(resolved);
    }
    const current = [...this.workspaceAdditionalDirectories];
    const cwd = this.workspaceCwd !== "" ? this.workspaceCwd : this.cwd;
    const runtimes = [...this.sessions.values()];
    // Grow-only merge: the requested roots join the negotiated window.
    let merged: string[];
    try {
      merged = normalizeAdditionalDirectories([...current, ...requested]);
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32602,
          "workspace_directory_invalid",
          errorMessage(error),
        ),
      );
      return;
    }
    if (merged.length > workspaceAdditionalDirectoryLimit) {
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32602,
          "workspace_limit_exceeded",
          `the workspace window accepts at most ${workspaceAdditionalDirectoryLimit} additional directories`,
          {
            max: workspaceAdditionalDirectoryLimit,
            merged: merged.length,
          },
        ),
      );
      return;
    }
    this.workspaceAdditionalDirectories = merged;
    // Synchronize open sessions so their tools and prompt resource resolution
    // share the grown window. Per-session failures are logged and skipped.
    for (const rt of runtimes) {
      if (rt.runtime === null) continue;
      const union = [...rt.runtime.additionalDirectoriesSnapshot(), ...merged];
      try {
        this.setSessionAdditionalDirectories(rt, union);
      } catch (error) {
        console.error(`[acp] extend workspace for session ${rt.id}: ${error}`);
        continue;
      }
      if (rt.registry !== null) {
        rt.registry.setAdditionalDirectories(
          rt.runtime.additionalDirectoriesSnapshot(),
        );
      }
    }
    this.notifyExtension("_opensac/session_event", {
      event: "workspace",
      cwd,
      additionalDirectories: merged,
    });
    this.writeResponse(
      req.idRaw,
      { cwd, additionalDirectories: merged },
      null,
    );
  }

  // ─── §4.4 decision deadline reminders ─────────────────────────────────────

  /**
   * Emits the additive `decision_deadline` reminders for a projected
   * approval/question request. The returned stop function must be called when
   * the decision resolves, is cancelled, or times out; it is idempotent.
   */
  scheduleDecisionDeadline(
    sessionId: string,
    requestId: string,
    kind: DecisionKind,
    timeoutMs: number,
    deadline: Date,
  ): () => void {
    const noop = () => {};
    if (timeoutMs <= 0) return noop;
    let first = Math.trunc(timeoutMs / 2);
    if (first > acpDecisionDeadlineMarks.firstNoticeCapMs) {
      first = acpDecisionDeadlineMarks.firstNoticeCapMs;
    }
    if (first <= 0) return noop;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    const second = timeoutMs - acpDecisionDeadlineMarks.finalNoticeMs;
    const emitFinal = () => {
      if (stopped) return;
      this.emitDecisionDeadline(sessionId, requestId, kind, deadline);
    };
    const emitFirst = () => {
      if (stopped) return;
      this.emitDecisionDeadline(sessionId, requestId, kind, deadline);
      if (second <= first) return;
      timer = setTimeout(emitFinal, second - first);
    };
    timer = setTimeout(emitFirst, first);
    return stop;
  }

  /** Emits one `decision_deadline` reminder mark. */
  emitDecisionDeadline(
    sessionId: string,
    requestId: string,
    kind: DecisionKind,
    deadline: Date,
  ): void {
    let remaining = deadline.getTime() - Date.now();
    if (remaining < 0) remaining = 0;
    this.notifyExtension("_opensac/session_event", {
      sessionId,
      event: "decision_deadline",
      requestId,
      kind,
      deadline: deadline.toISOString(),
      remainingMs: remaining,
    });
  }

  // ─── §4.6 sub-agent lifecycle events ──────────────────────────────────────

  /**
   * Projects the additive `subagent` session event for child agent activity:
   * `started` on the first observed event of an agent id and exactly one
   * terminal `completed`/`failed` projection. Child text/tool events remain
   * projected on the parent session stream as before.
   */
  observeSubagentEvent(sessionId: string, ev: AgentEvent): void {
    if ((ev.agentId ?? "") === "") return;
    const agentId = String(ev.agentId);
    const key = sessionId + "\u0000" + agentId;
    let state = this.subagents.get(key);
    if (state === undefined) {
      state = {
        started: false,
        terminal: false,
        memberId: "",
        expertId: "",
        memberDisplayName: "",
        memberEmoji: "",
        memberRole: "",
      };
      this.subagents.set(key, state);
    }
    const first = !state.started;
    state.started = true;
    if ((ev.memberId ?? "") !== "") state.memberId = ev.memberId!;
    if ((ev.expertId ?? "") !== "") state.expertId = ev.expertId!;
    if ((ev.memberDisplayName ?? "") !== "") {
      state.memberDisplayName = ev.memberDisplayName!;
    }
    if ((ev.memberEmoji ?? "") !== "") state.memberEmoji = ev.memberEmoji!;
    if ((ev.memberRole ?? "") !== "") state.memberRole = ev.memberRole!;
    let terminalStatus = "";
    if (!state.terminal) {
      switch (ev.type) {
        case EVENT_RUN_FINISHED:
          state.terminal = true;
          switch (ev.status) {
            case TASK_FAILED:
            case TASK_CANCELED:
              terminalStatus = "failed";
              break;
            default:
              // success and incomplete both terminated without error.
              terminalStatus = "completed";
          }
          break;
        case EVENT_ERROR:
          state.terminal = true;
          terminalStatus = "failed";
          break;
        case EVENT_DONE:
          state.terminal = true;
          terminalStatus = "completed";
          break;
      }
    }
    const meta: ACPSubagentEventMeta = {
      memberId: state.memberId,
      expertId: state.expertId,
      memberDisplayName: state.memberDisplayName,
      memberEmoji: state.memberEmoji,
      memberRole: state.memberRole,
    };
    if (!first && terminalStatus === "") return;
    let parentID = "";
    if (this.agentMgr !== null) {
      const [parent, ok] = this.agentMgr.parent(ev.agentId!);
      if (ok && parent !== undefined) parentID = String(parent);
    }
    if (first) {
      this.emitSubagentEvent(sessionId, agentId, parentID, "started", meta);
    }
    if (terminalStatus !== "") {
      this.emitSubagentEvent(
        sessionId,
        agentId,
        parentID,
        terminalStatus,
        meta,
      );
    }
  }

  /** Emits one `subagent` extension event. */
  emitSubagentEvent(
    sessionId: string,
    agentId: string,
    parentId: string,
    status: string,
    meta: ACPSubagentEventMeta,
  ): void {
    const params: Record<string, unknown> = {
      sessionId,
      event: "subagent",
      agentId,
      status,
    };
    if (parentId !== "") params.parentAgentId = parentId;
    if (meta.memberId !== "") params.memberId = meta.memberId;
    if (meta.expertId !== "") params.expertId = meta.expertId;
    if (meta.memberDisplayName !== "") {
      params.memberDisplayName = meta.memberDisplayName;
    }
    if (meta.memberEmoji !== "") params.memberEmoji = meta.memberEmoji;
    if (meta.memberRole !== "") params.memberRole = meta.memberRole;
    this.notifyExtension("_opensac/session_event", params);
  }

  /**
   * Forgets the projected sub-agent lifecycle states of one session when its
   * runtime shuts down or the session is deleted.
   */
  clearSubagentProjections(sessionId: string): void {
    const prefix = sessionId + "\u0000";
    for (const key of [...this.subagents.keys()]) {
      if (key.startsWith(prefix)) this.subagents.delete(key);
    }
  }

  // ─── §4.8 attachment metadata listing ─────────────────────────────────────

  /**
   * Serves the `opensac/attachment/list` extension: a metadata-only listing of
   * the Runtime-owned attachment rows of one session, optionally filtered by
   * protocol status. Content bytes stay behind `opensac/attachment/fetch`.
   */
  handleAttachmentList(req: ACPRPCRequest): void {
    const inRequest = (req.params ?? {}) as ACPAttachmentListRequest;
    const malformed = req.params === undefined || req.params === null ||
      typeof req.params !== "object" || Array.isArray(req.params);
    const sessionId = typeof inRequest.sessionId === "string"
      ? inRequest.sessionId.trim()
      : "";
    if (malformed || sessionId === "") {
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32602,
          "invalid_params",
          "sessionId is required",
        ),
      );
      return;
    }
    const status = typeof inRequest.status === "string"
      ? inRequest.status.trim()
      : "";
    let filter = "";
    switch (status) {
      case "":
        break;
      case "generated":
        filter = "generated";
        break;
      case "input":
        // Input attachments persist with the canonical "accepted" status.
        filter = "accepted";
        break;
      default:
        this.writeResponse(
          req.idRaw,
          null,
          acpStructuredRPCError(
            -32602,
            "attachment_list_invalid_status",
            `status ${
              JSON.stringify(status)
            } is not supported; use generated or input`,
          ),
        );
        return;
    }
    if (this.settings === null) {
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32000,
          "attachment_unavailable",
          "ACP settings are unavailable",
        ),
      );
      return;
    }
    let records;
    try {
      records = listSessionAttachments(
        getSessionDir(this.settings),
        sessionId,
        filter,
      );
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpStructuredRPCError(
          -32000,
          "attachment_unavailable",
          `list attachments: ${errorMessage(error)}`,
        ),
      );
      return;
    }
    const items: ACPAttachmentListEntry[] = records.map((record) => {
      const entry: ACPAttachmentListEntry = {
        attachmentId: record.id,
        filename: record.filename,
        kind: record.kind,
        mediaType: record.mediaType,
        size: record.bytes,
        status: record.status,
        runId: record.runId,
        createdAt: "",
      };
      if (!isZeroTime(record.createdAt)) {
        entry.createdAt = record.createdAt.toISOString();
      }
      return entry;
    });
    this.writeResponse(req.idRaw, { attachments: items }, null);
  }

  /**
   * Returns the Runtime-owned attachment service bound to the session root.
   */
  attachmentService(): AttachmentService {
    if (this.settings === null) {
      throw new Error("ACP settings are unavailable");
    }
    return new AttachmentService(
      getSessionDir(this.settings),
      defaultAttachmentPolicy(),
    );
  }

  /**
   * Re-emits artifact updates for artifacts persisted by earlier runs when a
   * session is loaded. Listing failures are logged and never fail the load.
   */
  replayGeneratedArtifacts(sessionId: string): void {
    if (this.settings === null || sessionId.trim() === "") return;
    let artifacts;
    try {
      artifacts = listGeneratedArtifacts(
        getSessionDir(this.settings),
        sessionId,
      );
    } catch (error) {
      console.error(
        `[acp] list generated artifacts for ${sessionId}: ${error}`,
      );
      return;
    }
    for (const artifact of artifacts) {
      this.notify(
        sessionId,
        artifactSessionUpdate(
          artifact.id,
          artifact.filename,
          artifact.kind,
          artifact.mediaType,
          artifact.bytes,
          artifact.runId,
        ),
      );
    }
  }

  /** Builds the structured attachment-fetch RPC error. */
  attachmentFetchRPCError(
    code: string,
    message: string,
    extra?: Record<string, unknown>,
  ): RPCError {
    return acpStructuredRPCError(-32000, code, message, extra);
  }

  // ─── session transcript history ──────────────────────────────────────────

  /**
   * Returns one earlier transcript page for an already loaded session. It is a
   * read-only projection of the Runtime-owned manager, never a second history
   * store.
   */
  handleSessionHistory(req: ACPRPCRequest): void {
    const inRequest = decodeTranscriptPageRequest(req.params);
    if (inRequest === null || (inRequest.sessionId ?? "").trim() === "") {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "invalid params"),
      );
      return;
    }
    const sessionId = inRequest.sessionId!.trim();
    const rt = this.sessionRuntime(sessionId);
    if (rt === null || rt.mgr === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, "unknown session"),
      );
      return;
    }
    let page: TranscriptPageResult;
    try {
      page = projectTranscriptPage(
        sessionId,
        rt.mgr,
        inRequest.cursor ?? "",
        inRequest.limit ?? 0,
        this.toolTitles,
      );
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, errorMessage(error)),
      );
      return;
    }
    this.writeResponse(req.idRaw, page, null);
  }

  // ─── session catalog: session/list and opensac/session/listAll ──────────────

  /** Serves `session/list` scoped to the negotiated workspace roots. */
  handleListSessions(req: ACPRPCRequest): void {
    const inRequest = decodeListSessionsRequest(req.params);
    if (inRequest === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "invalid params"),
      );
      return;
    }
    let cwd = "";
    let additionalDirectories: string[] = [];
    try {
      const resolved = this.resolveWorkspace(
        inRequest._meta,
        inRequest.cwd ?? "",
        inRequest.additionalDirectories ?? [],
      );
      cwd = resolved.cwd;
      additionalDirectories = resolved.additionalDirectories;
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, errorMessage(error)),
      );
      return;
    }
    if (cwd === "") {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "cwd is required"),
      );
      return;
    }
    if (this.settings === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, "ACP settings are unavailable"),
      );
      return;
    }
    let details: SessionDetail[];
    try {
      details = listAllDetailed(getSessionDir(this.settings));
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpFailureRPCError(error, null, PHASE_PERSISTENCE),
      );
      return;
    }
    const allowedRoots = new Set<string>([filepathClean(cwd)]);
    for (const directory of additionalDirectories) {
      allowedRoots.add(filepathClean(directory));
    }
    const filtered = details.filter((detail) =>
      allowedRoots.has(filepathClean(detail.cwd))
    );
    this.writeSessionList(req, filtered, inRequest.cursor ?? "");
  }

  /**
   * Projects the persisted task library across every project. It is additive
   * to ACP's standard `session/list` endpoint, whose cwd filter remains a
   * negotiated-workspace safety boundary for generic ACP clients.
   */
  handleListAllSessions(req: ACPRPCRequest): void {
    const inRequest = decodeListSessionsRequest(req.params);
    if (inRequest === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "invalid params"),
      );
      return;
    }
    if (this.settings === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, "ACP settings are unavailable"),
      );
      return;
    }
    let details: SessionDetail[];
    try {
      details = listAllDetailed(getSessionDir(this.settings));
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpFailureRPCError(error, null, PHASE_PERSISTENCE),
      );
      return;
    }
    try {
      details = this.filterGlobalSessionList(details, inRequest);
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpFailureRPCError(error, null, PHASE_PERSISTENCE),
      );
      return;
    }
    this.writeSessionList(req, details, inRequest.cursor ?? "");
  }

  /**
   * Narrows `opensac/session/listAll` before cursor pagination. It only combines
   * persisted session details, canonical session metadata, and canonical project
   * names for a read-only adapter query.
   */
  filterGlobalSessionList(
    details: SessionDetail[],
    inRequest: ACPListSessionsRequest,
  ): SessionDetail[] {
    let scope = (inRequest.scope ?? "").trim().toLowerCase();
    const projectId = (inRequest.projectId ?? "").trim();
    if (scope === "") scope = "all";
    if (scope === "all" && projectId !== "") scope = "project";
    if (scope !== "all" && scope !== "project" && scope !== "ungrouped") {
      throw new Error(
        `invalid session list scope ${JSON.stringify(inRequest.scope ?? "")}`,
      );
    }
    if (scope === "project" && projectId === "") {
      throw new Error("projectId is required for project session list scope");
    }
    if (scope === "ungrouped" && projectId !== "") {
      throw new Error(
        "projectId is not valid for ungrouped session list scope",
      );
    }
    const query = (inRequest.query ?? "").trim().toLowerCase();
    if (scope === "all" && query === "") return details;
    if (this.settings === null) {
      throw new Error("ACP settings are unavailable");
    }
    const sessionDir = getSessionDir(this.settings);
    const metadata = this.sessionListMetadata(
      details.map((detail) => detail.id),
    );
    const projectNames = new Map<string, string>();
    if (query !== "") {
      for (const project of listProjects(sessionDir)) {
        projectNames.set(project.id, project.name);
      }
    }
    const filtered: SessionDetail[] = [];
    for (const detail of details) {
      const meta = metadata.get(detail.id);
      const metaProject = meta?.projectId ?? "";
      if (scope === "project" && metaProject !== projectId) continue;
      if (scope === "ungrouped" && metaProject !== "") continue;
      if (query !== "") {
        let title = detail.name;
        if (title === "") title = detail.preview;
        const projectName = projectNames.get(metaProject) ?? "";
        if (
          !detail.id.toLowerCase().includes(query) &&
          !title.toLowerCase().includes(query) &&
          !detail.cwd.toLowerCase().includes(query) &&
          !projectName.toLowerCase().includes(query)
        ) {
          continue;
        }
      }
      filtered.push(detail);
    }
    return filtered;
  }

  /**
   * Projects one page of session details plus the additive `_meta` run-status
   * and pin/project metadata.
   */
  writeSessionList(
    req: ACPRPCRequest,
    details: SessionDetail[],
    cursor: string,
  ): void {
    let offset = 0;
    if (cursor !== "") {
      try {
        offset = decodeSessionCursor(cursor);
      } catch {
        this.writeResponse(
          req.idRaw,
          null,
          new RPCError(-32602, "invalid cursor"),
        );
        return;
      }
    }
    if (offset > details.length) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "invalid cursor"),
      );
      return;
    }
    let end = offset + sessionListPageSize;
    if (end > details.length) end = details.length;
    const page = details.slice(offset, end);
    const pageIDs = page.map((detail) => detail.id);
    const lastRuns = this.sessionListLastRun(pageIDs);
    const pageMetadata = this.sessionListMetadata(pageIDs);
    const sessionDir = this.settings !== null
      ? getSessionDir(this.settings)
      : "";
    const result: ACPListSessionsResult = { sessions: [] };
    for (const detail of page) {
      let title = detail.name;
      if (title === "") title = detail.preview;
      let modelProvider = "";
      let modelID = "";
      let mode = "";
      let thoughtLevel = "";
      if (sessionDir !== "") {
        try {
          const binding = latestModelChangeByID(sessionDir, detail.id);
          if (binding !== null) {
            modelProvider = binding.provider;
            modelID = binding.modelId;
          }
        } catch { /* an unreadable binding keeps the list default */ }
        try {
          const mgr = openByIDExact(sessionDir, detail.id);
          const modeEntry = mgr.getLatestModeChange();
          if (modeEntry !== null) mode = modeEntry.mode;
          const thinkingEntry = mgr.getLatestThinkingLevelChange();
          if (thinkingEntry !== null) {
            thoughtLevel = thinkingEntry.thinkingLevel;
          }
        } catch { /* an unreadable session keeps the empty projection */ }
      }
      if (modelProvider === "") modelProvider = this.providerName;
      if (modelID === "" && this.m !== null) modelID = this.m.id;
      const metadata = pageMetadata.get(detail.id);
      const meta: Record<string, unknown> = {
        messageCount: detail.messageCount,
      };
      meta.pinned = metadata?.pinned ?? false;
      meta.projectId = (metadata?.projectId ?? "") !== ""
        ? metadata!.projectId
        : null;
      const lastRun = lastRuns[detail.id];
      if (lastRun !== undefined) meta.lastRun = lastRun;
      let additionalDirectories: string[] = [];
      if (sessionDir !== "") {
        try {
          additionalDirectories = latestAdditionalDirectoriesByID(
            sessionDir,
            detail.id,
          );
        } catch {
          additionalDirectories = [];
        }
      }
      const listed: ACPListedSession = {
        sessionId: detail.id,
        cwd: detail.cwd,
        provider: modelProvider,
        model: modelID,
      };
      if (additionalDirectories.length > 0) {
        listed.additionalDirectories = additionalDirectories;
      }
      if (title !== "") listed.title = title;
      if (mode !== "") listed.mode = mode;
      if (thoughtLevel !== "") listed.thoughtLevel = thoughtLevel;
      if (detail.parentSession !== "") {
        listed.parentSessionId = detail.parentSession;
      }
      listed.updatedAt = formatRFC3339(detail.modTime);
      listed._meta = meta;
      result.sessions.push(listed);
    }
    if (end < details.length) result.nextCursor = encodeSessionCursor(end);
    this.writeResponse(req.idRaw, result, null);
  }

  // ─── session lifecycle mutations ─────────────────────────────────────────

  /** Serves `session/close`, cascading to persisted descendant sessions. */
  async handleCloseSession(req: ACPRPCRequest): Promise<void> {
    const inRequest = decodeCloseSessionRequest(req.params);
    if (inRequest === null || (inRequest.sessionId ?? "").trim() === "") {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "invalid params"),
      );
      return;
    }
    const sessionId = inRequest.sessionId!.trim();
    if (this.settings !== null) {
      try {
        const mgr = openByIDExact(getSessionDir(this.settings), sessionId);
        const header = mgr.getHeader();
        if (header !== null) {
          try {
            this.resolveWorkspace(inRequest._meta, header.cwd);
          } catch (error) {
            this.writeResponse(
              req.idRaw,
              null,
              new RPCError(-32000, errorMessage(error)),
            );
            return;
          }
        }
      } catch {
        // A missing root session still closes any in-memory runtime below.
      }
    }
    let targets: string[];
    try {
      targets = this.sessionCascadeIDs(sessionId);
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpFailureRPCError(error, null, PHASE_PERSISTENCE),
      );
      return;
    }
    for (const target of targets) {
      if (this.settings !== null) {
        try {
          const mgr = openByIDExact(getSessionDir(this.settings), target);
          const header = mgr.getHeader();
          if (header !== null) {
            try {
              this.resolveWorkspace(inRequest._meta, header.cwd);
            } catch (error) {
              this.writeResponse(
                req.idRaw,
                null,
                new RPCError(-32000, errorMessage(error)),
              );
              return;
            }
          }
        } catch {
          // Ignore an unreadable descendant; it has no live runtime to close.
        }
      }
      try {
        await this.closeSessionRuntime(target);
      } catch (error) {
        this.writeResponse(
          req.idRaw,
          null,
          acpFailureRPCError(error, null, PHASE_PERSISTENCE),
        );
        return;
      }
    }
    this.writeResponse(req.idRaw, {}, null);
  }

  /** Shuts one session runtime down and forgets it on success. */
  async closeSessionRuntime(
    sessionId: string,
  ): Promise<ACPSessionRuntime | null> {
    const rt = this.sessions.get(sessionId) ?? null;
    if (rt === null) return null;
    await this.shutdownSessionRuntime(rt);
    if (this.sessions.get(sessionId) === rt) {
      this.sessions.delete(sessionId);
    }
    return rt;
  }

  /**
   * Shuts one session runtime down through the shared Runtime boundary so its
   * active run, MCP clients, and resources reach a terminal state.
   */
  async shutdownSessionRuntime(rt: ACPSessionRuntime | null): Promise<void> {
    if (rt === null) return;
    rt.closed = true;
    this.clearSessionDecisionsForRuntime(rt);
    this.clearSubagentProjections(rt.id);
    if (rt.runtime !== null) {
      let failure: unknown;
      try {
        await rt.runtime.shutdown(AbortSignal.timeout(10_000));
      } catch (error) {
        failure = error;
      }
      if (failure === undefined) {
        rt.closeResources();
        return;
      }
      throw failure instanceof Error ? failure : new Error(String(failure));
    }
    if (rt.execution !== null && rt.execution.cancel()) {
      rt.closeResources();
      return;
    }
    rt.closeResources();
  }

  /**
   * Process-boundary cleanup for stdin EOF and startup/runtime errors. Explicit
   * `session/close` uses the same bounded shutdown and removes the runtime only
   * after cleanup succeeds.
   */
  async shutdownAllSessionRuntimes(): Promise<void> {
    const runtimes = [...this.sessions.values()];
    for (const rt of runtimes) {
      try {
        await this.shutdownSessionRuntime(rt);
      } catch (error) {
        console.error(
          `[acp] session ${JSON.stringify(rt.id)} shutdown: ${error}`,
        );
      }
      if (this.sessions.get(rt.id) === rt) this.sessions.delete(rt.id);
    }
  }

  /**
   * Returns a parent followed by all persisted descendants. Fork lineage is
   * stored in the shared session index, so adapters need no second child
   * registry.
   */
  sessionCascadeIDs(root: string): string[] {
    if (this.settings === null) return [root];
    const details = listAllDetailed(getSessionDir(this.settings));
    const children = new Map<string, string[]>();
    for (const detail of details) {
      if (detail.parentSession === "") continue;
      const siblings = children.get(detail.parentSession) ?? [];
      siblings.push(detail.id);
      children.set(detail.parentSession, siblings);
    }
    const result: string[] = [];
    const queue: string[] = [root];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      result.push(id);
      for (const child of children.get(id) ?? []) queue.push(child);
    }
    return result;
  }

  /** Serves `opensac/session/delete` and `session/delete`. */
  handleDeleteSession(req: ACPRPCRequest): void {
    const inRequest = decodeDeleteSessionRequest(req.params);
    if (inRequest === null || (inRequest.sessionId ?? "").trim() === "") {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "invalid params"),
      );
      return;
    }
    if (this.settings === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, "ACP settings are unavailable"),
      );
      return;
    }
    const sessionId = inRequest.sessionId!.trim();
    const sessionDir = getSessionDir(this.settings);
    let root;
    try {
      root = openByIDExact(sessionDir, sessionId);
    } catch (error) {
      if (errorMessage(error).toLowerCase().includes("not found")) {
        this.writeResponse(req.idRaw, {}, null);
        return;
      }
      this.writeResponse(
        req.idRaw,
        null,
        acpFailureRPCError(error, null, PHASE_PERSISTENCE),
      );
      return;
    }
    const rootHeader = root.getHeader();
    if (rootHeader !== null) {
      try {
        this.resolveWorkspace(inRequest._meta, rootHeader.cwd);
      } catch (error) {
        this.writeResponse(
          req.idRaw,
          null,
          new RPCError(-32000, errorMessage(error)),
        );
        return;
      }
    }
    let targets: string[];
    try {
      targets = this.sessionCascadeIDs(sessionId);
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpFailureRPCError(error, null, PHASE_PERSISTENCE),
      );
      return;
    }
    for (const id of targets) {
      if (this.sessions.has(id)) {
        this.writeResponse(
          req.idRaw,
          null,
          new RPCError(-32000, "cannot delete an active session"),
        );
        return;
      }
      let childHeader;
      try {
        childHeader = openByIDExact(sessionDir, id).getHeader();
      } catch {
        continue;
      }
      if (childHeader !== null) {
        try {
          this.resolveWorkspace(inRequest._meta, childHeader.cwd);
        } catch (error) {
          this.writeResponse(
            req.idRaw,
            null,
            new RPCError(-32000, errorMessage(error)),
          );
          return;
        }
      }
    }
    let leaseGroup;
    try {
      leaseGroup = acquireMutations(sessionDir, targets);
    } catch {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, "cannot delete an active session"),
      );
      return;
    }
    try {
      for (let i = targets.length - 1; i >= 0; i--) {
        const guard = leaseGroup.guard(targets[i]);
        if (guard === null) continue;
        try {
          deleteSessionWithMutation(sessionDir, targets[i], guard);
        } catch (error) {
          if (errorMessage(error).toLowerCase().includes("not found")) {
            continue;
          }
          this.writeResponse(
            req.idRaw,
            null,
            acpFailureRPCError(error, null, PHASE_PERSISTENCE),
          );
          return;
        }
      }
    } finally {
      leaseGroup.release();
    }
    this.writeResponse(req.idRaw, {}, null);
  }

  /** Serves `opensac/session/setTitle`. */
  handleSetSessionTitle(req: ACPRPCRequest): void {
    const inRequest = decodeSetTitleRequest(req.params);
    const sessionId = (inRequest?.sessionId ?? "").trim();
    const title = (inRequest?.title ?? "").trim();
    if (inRequest === null || sessionId === "" || title === "") {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "sessionId and title are required"),
      );
      return;
    }
    let mgr = this.sessionRuntime(sessionId)?.mgr ?? null;
    if (mgr === null) {
      if (this.settings === null) {
        this.writeResponse(
          req.idRaw,
          null,
          new RPCError(-32000, "ACP settings are unavailable"),
        );
        return;
      }
      try {
        mgr = openByIDExact(getSessionDir(this.settings), sessionId);
      } catch (error) {
        this.writeResponse(
          req.idRaw,
          null,
          acpFailureRPCError(error, null, PHASE_PERSISTENCE),
        );
        return;
      }
    }
    const header = mgr.getHeader();
    if (header === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, "session header is unavailable"),
      );
      return;
    }
    try {
      this.resolveWorkspace(inRequest._meta, header.cwd);
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, errorMessage(error)),
      );
      return;
    }
    try {
      this.withSessionMutationLease(sessionId, () => {
        mgr!.appendSessionTitle(title, "manual");
      });
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpFailureRPCError(error, null, PHASE_PERSISTENCE),
      );
      return;
    }
    this.notifySessionInfo(sessionId);
    this.writeResponse(req.idRaw, {}, null);
  }

  /**
   * Serves `opensac/session/setWorkDir`: moves an idle session to an
   * already-authorized directory. Runtime resources are bound to a workdir, so
   * an open idle runtime is shut down and rebuilt on the next `session/load`.
   */
  async handleSetSessionWorkDir(req: ACPRPCRequest): Promise<void> {
    const inRequest = decodeSetWorkDirRequest(req.params);
    const sessionId = (inRequest?.sessionId ?? "").trim();
    const requestedCwd = (inRequest?.cwd ?? "").trim();
    if (inRequest === null || sessionId === "" || requestedCwd === "") {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "sessionId and cwd are required"),
      );
      return;
    }
    if (this.settings === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, "ACP settings are unavailable"),
      );
      return;
    }
    let targetCwd = "";
    try {
      targetCwd = this.resolveWorkspace(inRequest._meta, requestedCwd).cwd;
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, errorMessage(error)),
      );
      return;
    }
    if (targetCwd === "") {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "cwd is required"),
      );
      return;
    }
    const sessionDir = getSessionDir(this.settings);
    let mgr;
    try {
      mgr = openByIDExact(sessionDir, sessionId);
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpFailureRPCError(error, null, PHASE_PERSISTENCE),
      );
      return;
    }
    const header = mgr.getHeader();
    if (header === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, "session header is unavailable"),
      );
      return;
    }
    // The task library is global, but mutations still require the source and
    // target project roots to be in the negotiated window.
    try {
      this.resolveWorkspace(undefined, header.cwd);
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, errorMessage(error)),
      );
      return;
    }
    if (filepathClean(header.cwd) === targetCwd) {
      this.writeResponse(req.idRaw, { cwd: targetCwd }, null);
      return;
    }
    let activeRun;
    try {
      activeRun = getActiveDurableRun(sessionDir, sessionId);
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpFailureRPCError(error, null, PHASE_PERSISTENCE),
      );
      return;
    }
    if (activeRun !== null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(
          -32000,
          "cannot change the work directory while the session is running",
        ),
      );
      return;
    }
    const rt = this.sessionRuntime(sessionId);
    if (rt !== null) {
      if (rt.execution !== null && rt.execution.active().active) {
        this.writeResponse(
          req.idRaw,
          null,
          new RPCError(
            -32000,
            "cannot change the work directory while the session is running",
          ),
        );
        return;
      }
      try {
        await this.closeSessionRuntime(sessionId);
      } catch (error) {
        this.writeResponse(
          req.idRaw,
          null,
          acpFailureRPCError(error, null, PHASE_PERSISTENCE),
        );
        return;
      }
    }
    try {
      this.withSessionMutationLease(sessionId, () => {
        mgr.setWorkDir(targetCwd);
      });
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpFailureRPCError(error, null, PHASE_PERSISTENCE),
      );
      return;
    }
    this.notifySessionInfo(sessionId);
    this.writeResponse(req.idRaw, { cwd: targetCwd }, null);
  }

  // ─── durable decision plumbing (shared with prompt/load) ──────────────────

  /** Returns the canonical durable run identity of an open session. */
  sessionRunID(sessionID: string): string {
    const rt = this.sessionRuntime(sessionID);
    if (rt === null) return "";
    return rt.runID !== "" ? rt.runID : rt.promptID;
  }

  /** Loads the durable decision ledger of one session. */
  loadPersistedDecisionRecords(sessionID: string): DecisionRecord[] {
    if (this.settings === null || sessionID === "") return [];
    return loadDecisionRecords(getSessionDir(this.settings), sessionID);
  }

  /**
   * Re-emits pending decision requests for a reconnecting client after full
   * replay so resolved or expired decisions are never revived.
   */
  replayPendingDecisionRequests(sessionID: string): void {
    const records = this.loadPersistedDecisionRecords(sessionID);
    const rt = this.sessionRuntime(sessionID);
    if (rt === null || rt.decisions === null) return;
    const rehydrated = new Set<string>();
    for (const request of rt.decisions.pending()) rehydrated.add(request.id);
    const pending = replayDecisions(records);
    for (const [id, record] of pending) {
      if (!rehydrated.has(id)) continue;
      if (record.payload === undefined || record.payload === null) continue;
      if (!this.pending.has(id)) this.pending.set(id, () => {});
      switch (record.kind) {
        case DECISION_QUESTION: {
          const request = record.payload as QuestionRequest;
          const projection = questionProjectionFor(
            this.acpInitialized(),
            {
              question: request.question,
              options: request.options ?? [],
              explanation: request.explanation ?? "",
            },
          );
          let method = projection.method;
          let payload: unknown = projection.params;
          if (
            request.protocol === acpElicitationFormProtocol &&
            this.supportsElicitationForm()
          ) {
            method = "elicitation/create";
            payload = elicitationRequestForQuestion(request);
          }
          this.notifyRequest(id, method, payload);
          break;
        }
        case DECISION_APPROVAL:
          this.notifyRequest(id, "session/request_permission", record.payload);
          break;
      }
    }
  }

  /**
   * Terminalizes unrecoverable persisted decisions on session restore and
   * rehydrates the pending set of a still-active run.
   */
  rehydrateSessionDecisions(rt: ACPSessionRuntime): void {
    if (rt.decisions === null || this.settings === null) return;
    const records = this.loadPersistedDecisionRecords(rt.id);
    const now = new Date();
    const expired = expiredDecisions(records, now);
    const pending = replayDecisionsAt(records, now);
    const active = rt.execution !== null
      ? rt.execution.active()
      : { runId: "", active: false };
    if (expired.length > 0 || (!active.active && pending.size > 0)) {
      this.withSessionMutationLease(rt.id, () => {
        for (const record of expired) {
          this.persistDecisionRecord(
            rt.id,
            record.runId,
            record.id,
            record.kind,
            "timed_out",
            "",
            { reason: "decision expired while session was offline" },
          );
        }
        if (!active.active) {
          for (const record of pending.values()) {
            this.persistDecisionRecord(
              rt.id,
              record.runId,
              record.id,
              record.kind,
              "cancelled",
              "",
              {
                reason:
                  "decision execution was not recoverable after session restore",
              },
            );
          }
        }
      });
    }
    if (!active.active) return;
    const activeRecords: DecisionRecord[] = [];
    for (const record of pending.values()) {
      if (record.runId === active.runId) activeRecords.push(record);
    }
    rt.decisions.rehydrate(activeRecords);
  }

  /** Registers one pending decision against its session run. */
  registerDecision(
    sessionID: string,
    id: string,
    kind: DecisionKind,
  ): void {
    if (id === "") return;
    const rt = this.sessionRuntime(sessionID);
    if (rt === null) return;
    if (rt.decisions === null) rt.decisions = new DecisionService();
    try {
      rt.decisions.register({
        id,
        runId: this.sessionRunID(sessionID),
        sessionId: sessionID,
        kind,
      });
    } catch {
      // A duplicate registration is tolerated; the durable ledger is canonical.
    }
  }

  /** Resolves one decision and commits its durable transition. */
  resolveDecision(
    sessionID: string,
    id: string,
    kind: DecisionKind,
    value: string,
    status: string,
  ): void {
    if (id === "") return;
    const rt = this.sessionRuntime(sessionID);
    if (rt === null || rt.decisions === null) return;
    const runID = this.sessionRunID(sessionID);
    rt.decisions.resolveWith({ id, kind, status, value }, () => {
      this.persistDecisionRecord(sessionID, runID, id, kind, status, value, {
        value,
      });
    });
  }

  /** Clears pending decisions for one open session. */
  clearSessionDecisions(sessionID: string): void {
    this.clearSessionDecisionsForRuntime(this.sessionRuntime(sessionID));
  }

  /** Clears pending decisions of one runtime and terminalizes them durably. */
  clearSessionDecisionsForRuntime(rt: ACPSessionRuntime | null): void {
    if (rt === null || rt.decisions === null) return;
    const runID = rt.runID !== "" ? rt.runID : rt.promptID;
    for (const request of rt.decisions.clearRunWithValue(runID, "")) {
      this.persistDecisionRecord(
        rt.id,
        runID,
        request.id,
        request.kind,
        "cancelled",
        "",
        { reason: "ACP session closed before the decision was resolved" },
      );
    }
  }

  /** Persists one decision transition with no deadline. */
  persistDecisionRecord(
    sessionID: string,
    runID: string,
    id: string,
    kind: DecisionKind,
    status: string,
    value: string,
    payload: unknown,
  ): void {
    this.persistDecisionRecordWithDeadline(
      sessionID,
      runID,
      id,
      kind,
      status,
      value,
      payload,
      undefined,
    );
  }

  /**
   * Persists one decision transition through the canonical Run-event sink. The
   * session's resolved source is retained so the ledger stays truthful.
   */
  persistDecisionRecordWithDeadline(
    sessionID: string,
    runID: string,
    id: string,
    kind: DecisionKind,
    status: string,
    value: string,
    payload: unknown,
    expiresAt: Date | undefined,
  ): void {
    if (
      this.settings === null || sessionID === "" || runID === "" || id === ""
    ) {
      return;
    }
    const request: DecisionRequest = {
      id,
      sessionId: sessionID,
      runId: runID,
      kind,
    };
    let source: string = SOURCE_ACP;
    const rt = this.sessionRuntime(sessionID);
    if (rt !== null && rt.runtime !== null) {
      let sessionMode = rt.runtime.configSnapshot().mode;
      if (sessionMode === "") sessionMode = this.mode;
      try {
        const resolved = rt.runtime.resolvePolicy(sessionMode, "", this.mode);
        if (resolved.resolution.source !== SOURCE_UNKNOWN) {
          source = resolved.resolution.source;
        }
      } catch {
        // A source conflict keeps the ACP-default source attribution.
      }
    }
    recordDecisionEvent(new SessionRunEventSink(getSessionDir(this.settings)), {
      request,
      status,
      value,
      payload,
      expiresAt,
      source,
    });
  }

  /** Reports whether the client can receive standard-form elicitation. */
  supportsElicitationForm(): boolean {
    return this.clientCaps.elicitation?.form !== undefined;
  }

  // ─── Agent approval/question projection ───────────────────────────────────

  /**
   * Projects one Agent question to the client and returns the chosen answer.
   * Standard-form elicitation is used when the client advertises it; otherwise
   * the pre-v1 extension method is preserved. Both paths share the pending
   * reverse-request store and the DecisionService, so `$/cancel_request`
   * releases the request exactly like Go's channel select.
   */
  async requestQuestion(
    ctx: AbortSignal | undefined,
    sessionID: string,
    question: string,
    options: string[],
    explanation: string,
  ): Promise<string> {
    const id = this.nextRequestID();
    let resolvePending: (payload: unknown) => void = () => {};
    const pending = new Promise<unknown>((resolve) => {
      resolvePending = resolve;
    });
    this.pending.set(id, resolvePending);
    this.registerDecision(sessionID, id, DECISION_QUESTION);
    const timeout = this.effectiveQuestionTimeoutMs();
    const deadline = new Date(Date.now() + timeout);
    const request: QuestionRequest = {
      sessionId: sessionID,
      question,
      options,
      explanation,
      timeoutMs: timeout,
    };
    let method = "";
    let payload: unknown;
    if (this.supportsElicitationForm()) {
      request.protocol = acpElicitationFormProtocol;
      method = "elicitation/create";
      payload = elicitationRequestForQuestion(request);
    } else {
      const projection = questionProjectionFor(this.acpInitialized(), {
        question,
        options,
        explanation,
      });
      method = projection.method;
      payload = projection.params;
    }
    try {
      this.persistDecisionRecordWithDeadline(
        sessionID,
        this.sessionRunID(sessionID),
        id,
        DECISION_QUESTION,
        "pending",
        "",
        request,
        deadline,
      );
    } catch {
      this.deletePending(id);
      return "";
    }
    try {
      this.notifyRequest(id, method, payload);
    } catch {
      this.deletePending(id);
      this.resolveDecision(sessionID, id, DECISION_QUESTION, "", "cancelled");
      return "";
    }
    const stopDeadlineReminders = this.scheduleDecisionDeadline(
      sessionID,
      id,
      DECISION_QUESTION,
      timeout,
      deadline,
    );
    try {
      const outcome = await racePendingRequest(pending, ctx, timeout);
      if (outcome.kind === "aborted") {
        this.deletePending(id);
        this.resolveDecision(sessionID, id, DECISION_QUESTION, "", "cancelled");
        return "";
      }
      if (outcome.kind === "timed_out") {
        this.deletePending(id);
        this.resolveDecision(sessionID, id, DECISION_QUESTION, "", "timed_out");
        return "";
      }
      const decoded = questionAnswer(
        outcome.value,
        request.protocol === acpElicitationFormProtocol,
      );
      this.resolveDecision(
        sessionID,
        id,
        DECISION_QUESTION,
        decoded.answer,
        decoded.status,
      );
      for (const option of options) {
        if (decoded.answer === option) return option;
      }
      return "";
    } finally {
      stopDeadlineReminders();
    }
  }

  /**
   * Asks the client to approve one tool call. `requestPermissionContext` is the
   * cancellable form used by the prompt run.
   */
  requestPermission(
    sessionID: string,
    toolCallID: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    return this.requestPermissionContext(
      undefined,
      sessionID,
      toolCallID,
      toolName,
      args,
    );
  }

  /**
   * Sends one `session/request_permission` reverse request and resolves to the
   * allow-once decision. A timeout, cancellation, rejection, or any malformed
   * response denies the tool call.
   */
  async requestPermissionContext(
    ctx: AbortSignal | undefined,
    sessionID: string,
    toolCallID: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    const id = this.nextRequestID();
    let resolvePending: (payload: unknown) => void = () => {};
    const pending = new Promise<unknown>((resolve) => {
      resolvePending = resolve;
    });
    this.pending.set(id, resolvePending);
    this.registerDecision(sessionID, id, DECISION_APPROVAL);
    const timeout = this.effectivePermissionTimeoutMs();
    const deadline = new Date(Date.now() + timeout);
    const rawInput = toolRawInput(args);
    try {
      this.persistDecisionRecordWithDeadline(
        sessionID,
        this.sessionRunID(sessionID),
        id,
        DECISION_APPROVAL,
        "pending",
        "",
        {
          sessionId: sessionID,
          toolCall: {
            toolCallId: toolCallID,
            title: toolName,
            status: "pending",
            rawInput,
          },
        },
        deadline,
      );
    } catch {
      this.deletePending(id);
      return false;
    }
    try {
      this.notifyRequest(id, "session/request_permission", {
        sessionId: sessionID,
        toolCall: {
          toolCallId: toolCallID,
          title: toolName,
          kind: acpToolKind(toolName),
          status: "pending",
          rawInput,
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });
    } catch {
      this.deletePending(id);
      this.resolveDecision(sessionID, id, DECISION_APPROVAL, "", "cancelled");
      return false;
    }
    const stopDeadlineReminders = this.scheduleDecisionDeadline(
      sessionID,
      id,
      DECISION_APPROVAL,
      timeout,
      deadline,
    );
    try {
      const outcome = await racePendingRequest(pending, ctx, timeout);
      if (outcome.kind !== "value") {
        this.deletePending(id);
        this.resolveDecision(
          sessionID,
          id,
          DECISION_APPROVAL,
          "",
          outcome.kind === "aborted" ? "cancelled" : "timed_out",
        );
        return false;
      }
      const record = jsonRecord(outcome.value);
      const selected = record !== undefined
        ? jsonRecord(record.outcome)
        : undefined;
      let value = "deny";
      if (selected !== undefined) {
        value = typeof selected.optionId === "string" ? selected.optionId : "";
      }
      this.resolveDecision(sessionID, id, DECISION_APPROVAL, value, "resolved");
      return selected !== undefined && selected.outcome === "selected" &&
        selected.optionId === "allow-once";
    } finally {
      stopDeadlineReminders();
    }
  }

  /**
   * Answers one Agent question through the shared decision contract. It runs as
   * a background task so the canonical event stream keeps flowing while the
   * client decides.
   */
  async handleQuestion(
    ctx: AbortSignal | undefined,
    rt: ACPSessionRuntime,
    runID: string,
    ev: AgentEvent,
  ): Promise<void> {
    const adapter = rt.agent;
    if (adapter === null) return;
    const questionId = ev.questionId ?? "";
    const execution = rt.execution;
    if (execution === null) {
      adapter.handleQuestionResponse(questionId, "");
      return;
    }
    try {
      execution.waitForQuestion(runID);
    } catch {
      adapter.handleQuestionResponse(questionId, "");
      return;
    }
    try {
      const answer = await this.requestQuestion(
        ctx,
        rt.id,
        ev.questionText ?? "",
        ev.questionOptions ?? [],
        ev.questionContext ?? "",
      );
      adapter.handleQuestionResponse(questionId, answer);
    } finally {
      try {
        execution.resume(runID);
      } catch {
        // The run already left the waiting state.
      }
    }
  }

  // ─── provider catalog and per-session resource assembly ──────────────────

  /**
   * Resolves one provider/model pair from the ACP catalog, falling back to a
   * fresh provider constructed from settings. An unavailable provider always
   * throws so callers can project a structured mismatch.
   */
  providerFor(
    name: string,
    modelId: string,
  ): { provider: Provider; model: Model } {
    name = name.trim();
    if (name === "") name = this.providerName;
    for (const catalogName of Object.keys(this.providers)) {
      const candidate = this.providers[catalogName];
      if (
        catalogName.toLowerCase() !== name.toLowerCase() ||
        candidate === null || candidate === undefined
      ) {
        continue;
      }
      if (modelId === "") {
        const models = candidate.models();
        if (models.length === 0) {
          throw new Error(
            `provider ${JSON.stringify(catalogName)} has no usable model`,
          );
        }
        return { provider: candidate, model: models[0] };
      }
      return {
        provider: candidate,
        model: resolveModel(candidate, catalogName, modelId),
      };
    }
    if (this.settings === null) {
      throw new Error(
        `ACP settings are required to construct provider ${
          JSON.stringify(name)
        }`,
      );
    }
    const created = createACPProvider(this.settings, name, modelId);
    this.providers[name] = created.provider;
    return created;
  }

  /**
   * Builds the ACP tool registry (Go's `newToolRegistry`). It is the only
   * registry construction path for ACP sessions; a failure returns null so the
   * session-establishing handler can clean up and report the structured error.
   */
  newToolRegistry(cwd: string, _mgr: SessionManager): ToolsRegistry | null {
    if (cwd === "") cwd = this.cwd;
    try {
      return buildRegistry(cwd, this.sbMgr, this.settings, {
        registerDefaults: true,
        enablePlanTool: defaultPlanToolPolicy(this.settings),
        skillsMgr: this.skillsMgr ?? undefined,
        browser: this.browser,
        mutators: [
          (registry: ToolsRegistry) => {
            // The interactive question tool is exposed in plan/agent modes (see
            // Registry.ModeTools). ACP maps it to request_permission.
            registry.register(new QuestionTool(registry));
            if (this.agentMgr !== null) {
              // Team experts receive a session-scoped manager after their
              // Runtime is attached. Keep this legacy shared manager for
              // explicit ACP multi-agent mode only.
              if (this.multiAgent) {
                registerSubAgentTools(registry, this.agentMgr);
              }
              if (this.delegate) {
                registerDelegateSubAgentTool(registry, this.agentMgr);
              }
              if (this.workflows) {
                registerWorkflowTools(registry, { manager: this.agentMgr });
              }
            }
          },
        ],
      });
    } catch {
      return null;
    }
  }

  /**
   * Installs the team-only manager after the shared SessionRuntime has resolved
   * its persisted expert binding. Member definitions and completion mailboxes
   * are session resources and must never be shared between ACP sessions.
   */
  registerTeamExpertTools(
    runtime: SessionRuntime,
    registry: ToolsRegistry,
  ): AgentManager | null {
    if (runtime === null || registry === null || !runtime.teamExpertActive()) {
      return null;
    }
    const snapshot = runtime.configSnapshot();
    if (snapshot.provider === null || snapshot.model === null) {
      throw new Error("team expert session provider and model are required");
    }
    if (this.settings === null) {
      throw new Error("ACP settings are required");
    }
    const manager = newAgentManager({
      runtime,
      provider: snapshot.provider,
      providerName: snapshot.providerName,
      model: snapshot.model,
      settings: this.settings,
      allow: this.allow,
      multiAgentEnabled: true,
    });
    registerSubAgentTools(registry, manager);
    return manager;
  }

  /**
   * Updates only the adapter projection of the Runtime-owned expert binding.
   * `SessionRuntime.SetExpert` remains responsible for validation, persistence,
   * identity/skills rehydration and the canonical team capability decision.
   */
  refreshSessionExpertTools(rt: ACPSessionRuntime): void {
    if (rt === null || rt.runtime === null || rt.registry === null) {
      throw new Error("session runtime is unavailable");
    }
    for (const name of subAgentToolNames()) rt.registry.remove(name);
    rt.agentMgr = null;
    if (rt.runtime.teamExpertActive()) {
      rt.agentMgr = this.registerTeamExpertTools(rt.runtime, rt.registry);
      return;
    }
    // Preserve the existing ACP --multi-agent behavior for an unbound or
    // single-expert session after removing a former team manager.
    if (this.multiAgent && this.agentMgr !== null) {
      registerSubAgentTools(rt.registry, this.agentMgr);
    }
  }

  /**
   * Restores persisted per-session configuration. `persistDefaults` is only
   * true while creating a session; loading an older session must remain
   * read-only when those optional bindings are absent.
   */
  configureSessionBindings(
    runtime: SessionRuntime,
    mgr: SessionManager,
    persistDefaults: boolean,
  ): void {
    if (runtime === null || mgr === null) {
      throw new Error("session runtime and manager are required");
    }
    // Some unit fixtures exercise session replay without constructing an ACP
    // provider catalog. Leave those runtimes unbound.
    if (this.p === null) return;
    const primaryProvider = this.p;
    const primaryModel = this.m;
    let providerName = this.providerName;
    let modelId = "";
    const modelEntry = mgr.getLatestModelChange();
    const hasModel = modelEntry !== null;
    if (modelEntry !== null) {
      if (modelEntry.provider !== "") providerName = modelEntry.provider;
      modelId = modelEntry.modelId;
    }
    const sameProvider = providerName.toLowerCase() ===
      this.providerName.toLowerCase();
    let p: Provider;
    let model: Model;
    try {
      if (!hasModel && sameProvider && primaryModel !== null) {
        p = primaryProvider;
        model = primaryModel;
      } else {
        const resolved = this.providerFor(providerName, modelId);
        p = resolved.provider;
        model = resolved.model;
      }
    } catch (error) {
      if (hasModel && !sameProvider) {
        throw new SessionProviderMismatchError(
          providerName,
          modelId,
          this.providerName,
          error,
        );
      }
      throw error;
    }
    let mode = this.mode;
    const modeEntry = mgr.getLatestModeChange();
    if (modeEntry !== null && modeEntry.mode.trim() !== "") {
      mode = modeEntry.mode;
    }
    let thinking = this.thinkingLevel;
    const thinkingEntry = mgr.getLatestThinkingLevelChange();
    if (
      thinkingEntry !== null && thinkingEntry.thinkingLevel.trim() !== ""
    ) {
      thinking = thinkingEntry.thinkingLevel;
    }
    const effectiveMode = runtime.resolvePolicy(mode, mode, MODE_YOLO).mode;
    runtime.configureSession(p, providerName, model, effectiveMode, thinking);
    if (persistDefaults && !hasModel) {
      mgr.appendModelChange(providerName, model.id);
    }
    if (persistDefaults && modeEntry === null) {
      mgr.appendModeChange(effectiveMode);
    }
    if (persistDefaults && thinkingEntry === null) {
      mgr.appendThinkingLevelChange(runtime.configSnapshot().thinkingLevel);
    }
  }

  /** Applies the adapter-level capability defaults to one attached runtime. */
  configureSessionCapabilities(runtime: SessionRuntime): void {
    if (runtime === null) {
      throw new Error("session runtime is required");
    }
    let sandboxEnabled = false;
    let browserEnabled = false;
    let webSearchEnabled = false;
    browserEnabled = this.browser;
    if (this.settings !== null) {
      sandboxEnabled = this.settings.sandbox?.enabled === true;
      webSearchEnabled = isWebSearchEnabled(this.settings);
    }
    runtime.configureCapabilities(
      sandboxEnabled,
      browserEnabled,
      webSearchEnabled,
    );
  }

  /** Creates the canonical durable run lifecycle for one ACP session. */
  newSessionExecution(): ExecutionRuntime {
    const execution = new ExecutionRuntime();
    if (this.settings !== null) {
      const sessionDir = getSessionDir(this.settings);
      execution.setRunStore(new RunStore(sessionDir));
      execution.setEventSink(new SessionRunEventSink(sessionDir));
    }
    return execution;
  }

  /**
   * Opens, configures and installs a persisted session that is not yet open in
   * this process. It is the shared path behind `session/load`, `session/resume`
   * and `session/fork`.
   */
  async openSessionRuntime(
    sessionId: string,
    cwd: string,
    servers: MCPServer[],
  ): Promise<ACPSessionRuntime> {
    if (this.settings === null) {
      throw new Error("ACP settings are required");
    }
    const sessionDir = getSessionDir(this.settings);
    const mgr = openSessionForWorkDir(cwd, sessionDir, sessionId);
    const registry = this.newToolRegistry(cwd, mgr);
    if (registry === null) {
      throw new Error("build ACP registry failed");
    }
    const resolvedSource = resolveSourceFromSession(sessionDir, sessionId, {
      sessionHeader: mgr.getHeader(),
      requested: SOURCE_ACP,
    });
    const runtime = await attachSessionResources({
      id: sessionId,
      source: resolvedSource.source,
      entrySource: SOURCE_ACP,
      workDir: cwd,
      manager: mgr,
      registry,
      providers: this.providers,
      sandboxMgr: this.sbMgr ?? undefined,
      skillsMgr: this.skillsMgr ?? undefined,
      extraContext: this.extraContext,
      ruleContent: this.ruleContent,
      settings: this.settings,
      workflows: this.workflows,
      browser: this.browser,
      artifactEnabled: this.artifactEnabled(),
    });
    let teamAgentMgr: AgentManager | null = null;
    try {
      this.configureSessionBindings(runtime, mgr, false);
      this.configureSessionCapabilities(runtime);
      teamAgentMgr = this.registerTeamExpertTools(runtime, registry);
      registry.setAdditionalDirectories(
        runtime.additionalDirectoriesSnapshot(),
      );
      await runtime.connectConfiguredMCP(undefined, {
        servers,
        callbacks: this.buildMCPCallbacks(sessionId),
        optional: false,
      });
    } catch (error) {
      runtime.close();
      throw error;
    }
    const execution = this.newSessionExecution();
    runtime.setExecution(execution);
    const decisions = new DecisionService();
    const rt = new ACPSessionRuntime();
    rt.runtime = runtime;
    rt.execution = execution;
    rt.decisions = decisions;
    rt.id = sessionId;
    rt.mgr = mgr;
    rt.registry = registry;
    rt.mcp = runtime.mcpClients;
    rt.agentMgr = teamAgentMgr;
    runtime.setDecisions(decisions);
    const seeded = persistedSessionUsage(mgr, runtimeModelOf(runtime));
    rt.cost = seeded.cost;
    rt.usageCache = seeded.usageCache;
    try {
      this.rehydrateSessionDecisions(rt);
    } catch (error) {
      rt.closeResources();
      throw error;
    }
    return rt;
  }

  /** Publishes a newly opened session runtime, shutting down any previous one. */
  installSessionRuntime(rt: ACPSessionRuntime): void {
    const old = this.sessions.get(rt.id) ?? null;
    this.sessions.set(rt.id, rt);
    if (old !== null) {
      try {
        this.shutdownSessionRuntime(old);
      } catch {
        // Shutdown is best-effort; the new runtime already owns the session.
      }
    }
  }

  // ─── session lifecycle handlers ───────────────────────────────────────────

  /**
   * Builds one `session/new`-shaped result, omitting the optional fields Go
   * drops through `omitempty` (mode/config/history/parent).
   */
  sessionOpenResult(
    sessionId: string,
    opts: {
      parentSessionId?: string;
      modes?: SessionModeState;
      configOptions?: SessionConfigOption[];
      history?: TranscriptPageResult | null;
    } = {},
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { sessionId };
    if (
      opts.parentSessionId !== undefined && opts.parentSessionId !== ""
    ) {
      result.parentSessionId = opts.parentSessionId;
    }
    if (opts.modes !== undefined) result.modes = opts.modes;
    if (
      opts.configOptions !== undefined && opts.configOptions.length > 0
    ) {
      result.configOptions = opts.configOptions;
    }
    if (opts.history !== undefined && opts.history !== null) {
      result.history = opts.history;
    }
    return result;
  }

  /** Handles `session/new`. */
  async handleNewSession(req: ACPRPCRequest): Promise<void> {
    const inRequest = decodeNewSessionRequest(req.params);
    if (inRequest === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "invalid params"),
      );
      return;
    }
    if (this.settings === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, "ACP settings are unavailable"),
      );
      return;
    }
    let resolved: { cwd: string; additionalDirectories: string[] };
    try {
      resolved = this.resolveWorkspace(
        inRequest._meta,
        inRequest.cwd ?? "",
        inRequest.additionalDirectories,
      );
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, errorMessage(error)),
      );
      return;
    }
    const cwd = resolved.cwd;
    if (cwd === "") {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "cwd is required"),
      );
      return;
    }
    const sessionDir = getSessionDir(this.settings);
    let id: string;
    let mgr: SessionManager;
    try {
      mgr = createSession({ workDir: cwd, sessionDir });
      id = mgr.getHeader()!.id;
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpFailureRPCError(error, null, PHASE_PERSISTENCE),
      );
      return;
    }
    const registry = this.newToolRegistry(cwd, mgr);
    if (registry === null) {
      await safeDeleteSession(sessionDir, id);
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, "build ACP registry failed"),
      );
      return;
    }
    let runtime: SessionRuntime | null = null;
    let teamAgentMgr: AgentManager | null = null;
    try {
      runtime = await attachSessionResources({
        id,
        source: SOURCE_ACP,
        workDir: cwd,
        manager: mgr,
        registry,
        providers: this.providers,
        sandboxMgr: this.sbMgr ?? undefined,
        skillsMgr: this.skillsMgr ?? undefined,
        extraContext: this.extraContext,
        ruleContent: this.ruleContent,
        settings: this.settings,
        workflows: this.workflows,
        browser: this.browser,
        artifactEnabled: this.artifactEnabled(),
      });
      this.configureSessionBindings(runtime, mgr, true);
      this.configureSessionCapabilities(runtime);
      teamAgentMgr = this.registerTeamExpertTools(runtime, registry);
      registry.setAdditionalDirectories(
        runtime.additionalDirectoriesSnapshot(),
      );
      runtime.setAdditionalDirectories(resolved.additionalDirectories);
      registry.setAdditionalDirectories(
        runtime.additionalDirectoriesSnapshot(),
      );
      await runtime.connectConfiguredMCP(undefined, {
        servers: inRequest.mcpServers ?? [],
        callbacks: this.buildMCPCallbacks(id),
        optional: false,
      });
    } catch (error) {
      runtime?.close();
      await safeDeleteSession(sessionDir, id);
      this.writeResponse(
        req.idRaw,
        null,
        acpFailureRPCError(error, null, PHASE_PERSISTENCE),
      );
      return;
    }
    const execution = this.newSessionExecution();
    runtime.setExecution(execution);
    const old = this.sessions.get(id) ?? null;
    if (old !== null) old.closeResources();
    const rt = new ACPSessionRuntime();
    rt.runtime = runtime;
    rt.execution = execution;
    rt.decisions = new DecisionService();
    rt.id = id;
    rt.mgr = mgr;
    rt.registry = registry;
    rt.mcp = runtime.mcpClients;
    rt.agentMgr = teamAgentMgr;
    this.sessions.set(id, rt);
    runtime.setDecisions(rt.decisions);
    this.writeResponse(
      req.idRaw,
      this.sessionOpenResult(id, {
        modes: sessionModes(runtime),
        configOptions: this.sessionConfigOptions(id),
      }),
      null,
    );
    this.notifyAvailableCommands(id);
  }

  /** Handles `opensac/session/draft-config-options` before a session exists. */
  handleDraftConfigOptions(req: ACPRPCRequest): void {
    const inRequest = decodeDraftConfigOptionsRequest(req.params);
    if (inRequest === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "invalid params"),
      );
      return;
    }
    let cwd = "";
    try {
      cwd = this.resolveWorkspace(inRequest._meta, inRequest.cwd ?? "").cwd;
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, errorMessage(error)),
      );
      return;
    }
    if (cwd.trim() === "") {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "cwd is required"),
      );
      return;
    }
    if (this.p === null || this.m === null) {
      this.writeResponse(req.idRaw, { configOptions: [] }, null);
      return;
    }
    let options = sessionConfigOptionsWithProviders(
      this.providerName,
      this.providers,
      this.p.models(),
      this.m,
      this.mode,
      this.thinkingLevel,
    );
    options = options.concat([expertConfigOption(cwd, "")]);
    this.writeResponse(req.idRaw, { configOptions: options }, null);
  }

  /** Handles `session/load`. */
  async handleLoadSession(req: ACPRPCRequest): Promise<void> {
    const inRequest = decodeLoadSessionRequest(req.params);
    if (inRequest === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "invalid params"),
      );
      return;
    }
    if (this.settings === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, "ACP settings are unavailable"),
      );
      return;
    }
    const sessionId = (inRequest.sessionId ?? "").trim();
    let resolved: { cwd: string; additionalDirectories: string[] };
    try {
      resolved = this.resolveWorkspace(
        inRequest._meta,
        inRequest.cwd ?? "",
        inRequest.additionalDirectories,
      );
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, errorMessage(error)),
      );
      return;
    }
    const cwd = resolved.cwd;
    if (cwd === "") {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "cwd is required"),
      );
      return;
    }
    const historyLimit = inRequest.historyLimit ?? 0;
    const existing = this.sessionRuntime(sessionId);
    if (existing !== null) {
      const header = existing.mgr?.getHeader() ?? null;
      if (
        existing.mgr === null || header === null ||
        filepathClean(header.cwd) !== cwd
      ) {
        this.writeResponse(
          req.idRaw,
          null,
          new RPCError(-32000, "session is not available for cwd"),
        );
        return;
      }
      try {
        this.setSessionAdditionalDirectories(
          existing,
          resolved.additionalDirectories,
        );
        existing.registry?.setAdditionalDirectories(
          existing.runtime!.additionalDirectoriesSnapshot(),
        );
        this.replayPendingDecisionRequests(sessionId);
      } catch (error) {
        this.writeResponse(
          req.idRaw,
          null,
          acpFailureRPCError(error, null, PHASE_PERSISTENCE),
        );
        return;
      }
      let history: TranscriptPageResult | null = null;
      try {
        history = this.projectInitialTranscript(
          sessionId,
          existing.mgr,
          historyLimit,
        );
      } catch (error) {
        this.writeResponse(
          req.idRaw,
          null,
          new RPCError(-32602, errorMessage(error)),
        );
        return;
      }
      this.replayGeneratedArtifacts(sessionId);
      this.writeResponse(
        req.idRaw,
        this.sessionOpenResult(sessionId, {
          modes: sessionModes(existing.runtime),
          configOptions: this.sessionConfigOptions(sessionId),
          history,
        }),
        null,
      );
      this.notifyAvailableCommands(sessionId);
      return;
    }
    let rt: ACPSessionRuntime;
    try {
      rt = await this.openSessionRuntime(
        sessionId,
        cwd,
        inRequest.mcpServers ?? [],
      );
      this.setSessionAdditionalDirectories(rt, resolved.additionalDirectories);
      rt.registry?.setAdditionalDirectories(
        rt.runtime!.additionalDirectoriesSnapshot(),
      );
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpFailureRPCError(error, null, PHASE_PERSISTENCE),
      );
      return;
    }
    this.installSessionRuntime(rt);
    let history: TranscriptPageResult | null;
    try {
      history = this.projectInitialTranscript(sessionId, rt.mgr!, historyLimit);
    } catch (error) {
      rt.closeResources();
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, errorMessage(error)),
      );
      return;
    }
    this.replayGeneratedArtifacts(sessionId);
    this.writeResponse(
      req.idRaw,
      this.sessionOpenResult(sessionId, {
        modes: sessionModes(rt.runtime),
        configOptions: this.sessionConfigOptions(sessionId),
        history,
      }),
      null,
    );
    this.notifyAvailableCommands(sessionId);
  }

  /** Handles `session/resume`. */
  async handleResumeSession(req: ACPRPCRequest): Promise<void> {
    const inRequest = decodeResumeSessionRequest(req.params);
    if (inRequest === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "invalid params"),
      );
      return;
    }
    if (this.settings === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, "ACP settings are unavailable"),
      );
      return;
    }
    const sessionId = (inRequest.sessionId ?? "").trim();
    let resolved: { cwd: string; additionalDirectories: string[] };
    try {
      resolved = this.resolveWorkspace(
        inRequest._meta,
        inRequest.cwd ?? "",
        inRequest.additionalDirectories,
      );
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, errorMessage(error)),
      );
      return;
    }
    const cwd = resolved.cwd;
    if (cwd === "") {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "cwd is required"),
      );
      return;
    }
    const existing = this.sessionRuntime(sessionId);
    if (existing !== null) {
      const header = existing.mgr?.getHeader() ?? null;
      if (
        existing.mgr === null || header === null ||
        filepathClean(header.cwd) !== cwd
      ) {
        this.writeResponse(
          req.idRaw,
          null,
          new RPCError(-32000, "session is not available for cwd"),
        );
        return;
      }
      try {
        this.setSessionAdditionalDirectories(
          existing,
          resolved.additionalDirectories,
        );
        existing.registry?.setAdditionalDirectories(
          existing.runtime!.additionalDirectoriesSnapshot(),
        );
        this.replayPendingDecisionRequests(sessionId);
      } catch (error) {
        this.writeResponse(
          req.idRaw,
          null,
          acpFailureRPCError(error, null, PHASE_PERSISTENCE),
        );
        return;
      }
      this.replayGeneratedArtifacts(sessionId);
      this.writeResponse(
        req.idRaw,
        this.sessionOpenResult(sessionId, {
          modes: sessionModes(existing.runtime),
          configOptions: this.sessionConfigOptions(sessionId),
        }),
        null,
      );
      this.notifyAvailableCommands(sessionId);
      return;
    }
    let rt: ACPSessionRuntime;
    try {
      rt = await this.openSessionRuntime(
        sessionId,
        cwd,
        inRequest.mcpServers ?? [],
      );
      this.setSessionAdditionalDirectories(rt, resolved.additionalDirectories);
      rt.registry?.setAdditionalDirectories(
        rt.runtime!.additionalDirectoriesSnapshot(),
      );
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpFailureRPCError(error, null, PHASE_PERSISTENCE),
      );
      return;
    }
    this.installSessionRuntime(rt);
    this.replayGeneratedArtifacts(sessionId);
    this.writeResponse(
      req.idRaw,
      this.sessionOpenResult(sessionId, {
        modes: sessionModes(rt.runtime),
        configOptions: this.sessionConfigOptions(sessionId),
      }),
      null,
    );
    this.notifyAvailableCommands(sessionId);
  }

  /** Handles `session/fork` (including the Runtime-owned expert switch). */
  async handleForkSession(req: ACPRPCRequest): Promise<void> {
    const inRequest = decodeForkSessionRequest(req.params);
    if (
      inRequest === null || (inRequest.sessionId ?? "").trim() === ""
    ) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "sessionId is required"),
      );
      return;
    }
    if (this.settings === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, "ACP settings are unavailable"),
      );
      return;
    }
    const sessionDir = getSessionDir(this.settings);
    const sourceSessionId = inRequest.sessionId!.trim();
    let parent: SessionManager;
    try {
      parent = openByIDExact(sessionDir, sourceSessionId);
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpFailureRPCError(error, null, PHASE_PERSISTENCE),
      );
      return;
    }
    const parentHeader = parent.getHeader();
    if (parentHeader === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, "parent session header is unavailable"),
      );
      return;
    }
    const requestedParent = requestParentSessionID(inRequest._meta);
    if (
      requestedParent.trim() !== "" && requestedParent !== sourceSessionId
    ) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "fork parentSessionId must match sessionId"),
      );
      return;
    }
    let cwd = inRequest.cwd ?? "";
    if (cwd.trim() === "") cwd = parentHeader.cwd;
    let resolved: { cwd: string; additionalDirectories: string[] };
    try {
      resolved = this.resolveWorkspace(
        inRequest._meta,
        cwd,
        inRequest.additionalDirectories,
      );
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, errorMessage(error)),
      );
      return;
    }
    if (resolved.cwd !== filepathClean(parentHeader.cwd)) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "fork cwd must match the parent session cwd"),
      );
      return;
    }
    let requestId = (inRequest.requestId ?? "").trim();
    if (requestId === "") requestId = (req.idRaw ?? "").trim();
    if (requestId === "") {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(
          -32602,
          "fork request requires an idempotency requestId",
        ),
      );
      return;
    }
    const forkOptions = {
      sourceSessionId,
      atSeq: inRequest.atSeq ?? null,
      requestId,
      titleMode: inRequest.titleMode ?? "",
    };
    let result;
    try {
      if (inRequest.expertIdSet === true) {
        const expertId = (inRequest.expertId ?? "").trim();
        if (expertId !== "") {
          const bundle = inspectExpertBundle(resolved.cwd, expertId);
          if (bundle === null || bundle.invalid) {
            let message = `expert bundle ${
              JSON.stringify(expertId)
            } is invalid`;
            if (bundle !== null && bundle.invalidReason.trim() !== "") {
              message += ": " + bundle.invalidReason;
            }
            this.writeResponse(req.idRaw, null, new RPCError(-32602, message));
            return;
          }
        }
        result = forkSessionPrefixWithExpert(
          sessionDir,
          forkOptions,
          expertId,
        );
      } else {
        result = forkSessionPrefix(sessionDir, forkOptions);
      }
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpFailureRPCError(error, null, PHASE_PERSISTENCE),
      );
      return;
    }
    await this.completeForkSession(
      req,
      inRequest,
      result.sessionId,
      result.parentSessionId,
      resolved.cwd,
      resolved.additionalDirectories,
    );
  }

  /**
   * Opens and publishes the child after either a normal fork or the
   * Runtime-owned expert-switch fork has persisted it.
   */
  async completeForkSession(
    req: ACPRPCRequest,
    inRequest: ACPForkSessionRequest,
    childSessionId: string,
    parentSessionId: string,
    resolvedCwd: string,
    additionalDirectories: string[],
  ): Promise<void> {
    if (this.settings === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, "ACP settings are unavailable"),
      );
      return;
    }
    const sessionDir = getSessionDir(this.settings);
    let rt: ACPSessionRuntime;
    try {
      rt = await this.openSessionRuntime(
        childSessionId,
        resolvedCwd,
        inRequest.mcpServers ?? [],
      );
    } catch (error) {
      await safeDeleteSession(sessionDir, childSessionId);
      this.writeResponse(
        req.idRaw,
        null,
        acpFailureRPCError(error, null, PHASE_PERSISTENCE),
      );
      return;
    }
    const workspaceSpec = requestWorkspace(inRequest._meta);
    if (
      inRequest.additionalDirectories !== undefined ||
      (workspaceSpec !== undefined &&
        workspaceSpec.additionalDirectories !== undefined)
    ) {
      try {
        this.setSessionAdditionalDirectories(rt, additionalDirectories);
        rt.registry?.setAdditionalDirectories(
          rt.runtime!.additionalDirectoriesSnapshot(),
        );
      } catch (error) {
        rt.closeResources();
        await safeDeleteSession(sessionDir, childSessionId);
        this.writeResponse(
          req.idRaw,
          null,
          acpFailureRPCError(error, null, PHASE_PERSISTENCE),
        );
        return;
      }
    }
    this.installSessionRuntime(rt);
    this.writeResponse(
      req.idRaw,
      this.sessionOpenResult(childSessionId, {
        parentSessionId,
        modes: sessionModes(rt.runtime),
        configOptions: this.sessionConfigOptions(childSessionId),
      }),
      null,
    );
    this.notifyAvailableCommands(childSessionId);
  }

  /** Handles `session/set_config_option`. */
  async handleSetConfigOption(req: ACPRPCRequest): Promise<void> {
    const inRequest = decodeSetConfigOptionRequest(req.params);
    if (
      inRequest === null || (inRequest.sessionId ?? "").trim() === "" ||
      (inRequest.configId ?? "").trim() === "" || inRequest.value === undefined
    ) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(
          -32602,
          "sessionId, configId, and value are required",
        ),
      );
      return;
    }
    const sessionId = inRequest.sessionId!.trim();
    let configId = inRequest.configId!.trim();
    switch (configId) {
      case "thought_level":
      case "thinking":
        configId = CONFIG_OPTION_THINKING_LEVEL;
        break;
      case "web-search":
      case "websearch":
        configId = CONFIG_OPTION_WEB_SEARCH;
        break;
    }
    let value: string;
    try {
      value = acpConfigValue(
        inRequest.value,
        configId === CONFIG_OPTION_EXPERT,
      );
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, errorMessage(error)),
      );
      return;
    }
    const rt = this.sessionRuntime(sessionId);
    if (rt === null || rt.runtime === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, "unknown session"),
      );
      return;
    }
    const runtime = rt.runtime;
    try {
      if (
        configId === CONFIG_OPTION_SANDBOX ||
        configId === CONFIG_OPTION_BROWSER ||
        configId === CONFIG_OPTION_WEB_SEARCH
      ) {
        const parsed = parseBoolean(value.trim());
        if (parsed === undefined) {
          this.writeResponse(
            req.idRaw,
            null,
            new RPCError(-32602, "boolean config value is required"),
          );
          return;
        }
        this.withSessionMutationLease(sessionId, () => {
          runtime.setCapabilityOption(configId, parsed);
        });
      } else if (configId === CONFIG_OPTION_EXPERT) {
        await this.withSessionMutationLeaseAsync(sessionId, async () => {
          await runtime.setConfigOption(configId, value);
          this.refreshSessionExpertTools(rt);
        });
      } else {
        await this.withSessionMutationLeaseAsync(
          sessionId,
          () => runtime.setConfigOption(configId, value),
        );
      }
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, errorMessage(error)),
      );
      return;
    }
    const options = this.sessionConfigOptions(sessionId);
    this.notify(sessionId, {
      sessionUpdate: "config_option_update",
      configOptions: options,
    });
    this.notifySessionInfo(sessionId);
    this.writeResponse(req.idRaw, { configOptions: options }, null);
  }

  /** Handles `session/set_mode`. */
  async handleSetMode(req: ACPRPCRequest): Promise<void> {
    const inRequest = decodeSetModeRequest(req.params);
    if (
      inRequest === null || (inRequest.sessionId ?? "").trim() === ""
    ) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "sessionId and mode are required"),
      );
      return;
    }
    const sessionId = inRequest.sessionId!.trim();
    let modeId = (inRequest.modeId ?? "").trim();
    if (modeId === "") modeId = (inRequest.mode ?? "").trim();
    if (modeId === "") {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "sessionId and modeId are required"),
      );
      return;
    }
    const rt = this.sessionRuntime(sessionId);
    if (rt === null || rt.runtime === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, "unknown session"),
      );
      return;
    }
    const runtime = rt.runtime;
    try {
      // SessionRuntime snapshots the binding for the active prompt; changing
      // the mode here therefore affects the next prompt and stays safe.
      await this.withSessionMutationLeaseAsync(
        sessionId,
        () => runtime.setConfigOption(CONFIG_OPTION_MODE, modeId),
      );
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, errorMessage(error)),
      );
      return;
    }
    const options = this.sessionConfigOptions(sessionId);
    const effectiveMode = runtime.configSnapshot().mode;
    this.notify(sessionId, {
      sessionUpdate: "current_mode_update",
      currentModeId: effectiveMode,
    });
    this.notify(sessionId, {
      sessionUpdate: "config_option_update",
      configOptions: options,
    });
    this.notifySessionInfo(sessionId);
    this.writeResponse(req.idRaw, {}, null);
  }

  // ─── prompt admission and cancellation ────────────────────────────

  /**
   * Serializes ACP with the other local entry points and checks the durable row
   * before attempting the unique active-run insert. The shared runtime lock
   * covers concurrent local adapters and prompt requests.
   */
  async acquirePromptAdmission(rt: ACPSessionRuntime): Promise<() => void> {
    if (this.settings === null || rt.id.trim() === "") {
      throw new Error("ACP session runtime is unavailable");
    }
    let guard: RuntimeLeaseGuard;
    try {
      guard = await acquireExecutionAdmission(
        undefined,
        getSessionDir(this.settings),
        rt.id,
        {},
      );
    } catch {
      throw new ACPActiveSessionRunError();
    }
    if (rt.cancel !== null) {
      guard.release();
      throw new ACPActiveSessionRunError();
    }
    return () => guard.release();
  }

  /**
   * Handles `session/prompt`: admits the run under the shared lease, assembles
   * the Runtime-owned input, durably claims the canonical Run, builds the Agent
   * through the shared Runtime, and streams the canonical events back as ACP
   * `session/update` notifications. The admitted run owns the response, so it
   * is written when the event stream reaches a terminal state.
   */
  async handlePrompt(req: ACPRPCRequest): Promise<void> {
    const inRequest = decodePromptRequest(req.params);
    if (inRequest === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "invalid params"),
      );
      return;
    }
    const rt = this.sessions.get(inRequest.sessionId ?? "") ?? null;
    if (rt === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, "unknown session"),
      );
      return;
    }
    const runtime = rt.runtime;
    if (runtime === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, "session runtime is unavailable"),
      );
      return;
    }
    let workspace: { cwd: string; additionalDirectories: string[] };
    try {
      workspace = this.resolveWorkspace(inRequest._meta, runtime.workDir);
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, errorMessage(error)),
      );
      return;
    }
    const parentId = (requestParentSessionID(inRequest._meta) ?? "").trim();
    if (parentId !== "") {
      let persistedParent = "";
      const header = rt.mgr?.getHeader() ?? null;
      if (header !== null) persistedParent = header.parentSession ?? "";
      if (persistedParent !== parentId) {
        this.writeResponse(
          req.idRaw,
          null,
          new RPCError(
            -32000,
            "prompt parentSessionId does not match the session lineage",
          ),
        );
        return;
      }
    }
    const promptKey = rawIDKey(req.idRaw ?? "null");
    let promptText = "";
    let promptIngresses: InputIngress[] = [];
    try {
      const converted = promptToIngresses(
        inRequest.prompt,
        workspace.cwd,
        workspace.additionalDirectories,
        "acp:" + promptKey,
      );
      promptText = converted.text;
      promptIngresses = converted.ingresses;
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpFailureRPCError(error, null, PHASE_ADMISSION),
      );
      return;
    }
    let userText = promptText.trim();
    if (userText === "" && promptIngresses.length === 0) {
      this.writeResponse(req.idRaw, null, new RPCError(-32602, "empty prompt"));
      return;
    }
    if (promptIngresses.length === 0) {
      let activated = false;
      try {
        activated = await this.activateSkillPrompt(rt, userText);
      } catch (error) {
        this.writeResponse(
          req.idRaw,
          null,
          acpFailureRPCError(error, null, PHASE_ADMISSION),
        );
        return;
      }
      if (activated) {
        this.writeResponse(req.idRaw, { stopReason: "end_turn" }, null);
        return;
      }
    }
    const editorContextText = formatEditorContext(
      requestEditorContext(inRequest._meta),
    );
    const snapshot = runtime.configSnapshot();
    const sessionProvider = snapshot.provider;
    const sessionProviderName = snapshot.providerName;
    const sessionModel = snapshot.model;
    const sessionMode = snapshot.mode;
    const sessionThinking = snapshot.thinkingLevel;
    if (sessionProvider === null || sessionModel === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, "session model is unavailable"),
      );
      return;
    }
    let effectiveMode = sessionMode;
    let runSource = SOURCE_ACP;
    try {
      const resolved = runtime.resolvePolicy(sessionMode, "", MODE_YOLO);
      effectiveMode = resolved.mode;
      runSource = resolved.resolution.source;
      if (runSource === "") runSource = SOURCE_ACP;
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpFailureRPCError(error, null, PHASE_ADMISSION),
      );
      return;
    }
    // Expand the /systeminit slash command into the full instruction prompt. In
    // ACP the question tool is available, so use the interactive variant.
    // /systeminit must also be able to write AGENTS.md, so upgrade plan mode to
    // agent for this prompt only.
    {
      const fields = userText.trim().split(/\s+/).filter((part) => part !== "");
      if (fields.length > 0 && fields[0] === systeminitCommand) {
        const extra = userText.trim().slice(systeminitCommand.length).trim();
        userText = systeminitPrompt(true, extra);
        if (effectiveMode === "plan") effectiveMode = "agent";
      }
    }
    // ACP SDK request IDs restart at 0 for every connection, so a bare request
    // ID would collide with runs persisted by earlier processes. Keep the
    // request ID for readability but append a random suffix for uniqueness.
    const runID = "acp_" + promptKey + "_" + generateID();
    let runtimeRelease: () => void;
    try {
      runtimeRelease = await this.acquirePromptAdmission(rt);
    } catch (error) {
      this.writeResponse(
        req.idRaw,
        null,
        acpFailureRPCError(error, null, PHASE_ADMISSION),
      );
      return;
    }
    const settings = this.settings;
    if (settings === null) {
      runtimeRelease();
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, "session runtime is unavailable"),
      );
      return;
    }
    const sessionDir = getSessionDir(settings);
    let admissionTransferred = false;
    try {
      let execution = rt.execution;
      if (execution === null) {
        execution = this.newSessionExecution();
        rt.execution = execution;
      }
      const startedAt = new Date();
      const caps = runtime.capabilitySnapshot();
      const sandboxEnabled = caps.sandboxEnabled;
      const browserEnabled = caps.browserEnabled;
      const webSearchEnabled = caps.webSearchEnabled;
      let workDir = runtime.workDir;
      if (workDir === "") workDir = workspace.cwd;
      if (workDir === "") workDir = this.cwd;
      const policySnapshot = {
        source: runSource,
        mode: effectiveMode,
        workDir,
        surface: requestSurface(inRequest._meta),
        capabilities: {
          multiAgent: this.multiAgent,
          delegate: this.delegate,
          workflows: this.workflows,
          browser: browserEnabled,
          webSearch: webSearchEnabled,
        },
        sandbox: { enabled: sandboxEnabled },
        approvalPolicy: "runtime",
        questionPolicy: "runtime",
      };
      let runSubmission: InputSubmission;
      try {
        runSubmission = await runtime.acceptInput(
          undefined,
          runID,
          userText,
          promptIngresses,
        );
      } catch (error) {
        this.writeResponse(
          req.idRaw,
          null,
          acpFailureRPCError(error, null, PHASE_ADMISSION),
        );
        return;
      }
      const knowledgeRefs = inRequest.knowledgeBaseRefs ?? [];
      if (knowledgeRefs.length > 0) {
        try {
          runSubmission = await withKnowledgeContext(
            runtime,
            undefined,
            runSubmission,
            knowledgeRefs,
          );
        } catch (error) {
          runtime.discardInput(runSubmission);
          this.writeResponse(
            req.idRaw,
            null,
            manageKnowledgeBaseRPCError(error),
          );
          return;
        }
      }
      let promptMessage: Message;
      try {
        promptMessage = runtime.buildUserMessage(undefined, runSubmission);
      } catch (error) {
        runtime.discardInput(runSubmission);
        this.writeResponse(
          req.idRaw,
          null,
          acpFailureRPCError(error, null, PHASE_ADMISSION),
        );
        return;
      }
      let requestSnapshot: string;
      try {
        requestSnapshot = acpPromptRequestSnapshot(
          runtime,
          userText,
          runSubmission,
        );
      } catch (error) {
        runtime.discardInput(runSubmission);
        this.writeResponse(
          req.idRaw,
          null,
          acpFailureRPCError(error, null, PHASE_ADMISSION),
        );
        return;
      }
      const intent: ExecutionIntent = {
        id: "intent_" + generateID(),
        sessionId: rt.id,
        source: runSource,
        model: sessionModel.id,
        mode: effectiveMode,
        workDir,
        requestFingerprint: "prompt:" + sha256Hex(requestSnapshot),
        request: requestSnapshot,
        policy: policySnapshot,
        createdAt: startedAt,
      };
      const startData = { intentId: intent.id, attempt: 1 };
      let signal: AbortSignal;
      try {
        signal = execution.beginIntentDurable(
          undefined,
          intent,
          makeDurableRun({
            id: runID,
            sessionId: rt.id,
            intentId: intent.id,
            attempt: 1,
            workDir,
            source: runSource,
            model: sessionModel.id,
            mode: effectiveMode,
            inputResourceIds: resourceIds(runSubmission),
            userEntryId: runUserEntryID(runID),
            userMessage: promptMessage,
            status: "running",
            startedAt,
            conversationTurnId: "turn-" + intent.id,
            conversationTurn: true,
          }),
          makeRunEvent({
            sessionId: rt.id,
            runId: runID,
            eventType: "started",
            source: runSource,
            status: "running",
            model: sessionModel.id,
            mode: effectiveMode,
            timestamp: startedAt,
            data: startData,
          }),
        );
      } catch (error) {
        runtime.discardInput(runSubmission);
        let active = false;
        try {
          active = getActiveDurableRun(sessionDir, rt.id) !== null;
        } catch {
          active = false;
        }
        const failure = active ? new ACPActiveSessionRunError() : error;
        this.writeResponse(
          req.idRaw,
          null,
          acpFailureRPCError(failure, null, PHASE_ADMISSION),
        );
        return;
      }
      // Project the durable begin as the additive run_status event; it
      // complements the terminal event and the prompt response.
      this.notifyRunStatus(rt.id, runID, "running");
      const cancel = () => {
        execution.cancel();
      };
      const finishEarly = async (
        state: RunState,
        message: string,
      ): Promise<void> => {
        cancel();
        try {
          await execution.finishDurableWithRetry(
            undefined,
            runID,
            state,
            message,
            makeRunEvent({
              sessionId: rt.id,
              runId: runID,
              eventType: "finished",
              source: runSource,
              status: state,
              model: sessionModel.id,
              mode: effectiveMode,
              timestamp: new Date(),
            }),
          );
        } catch (error) {
          console.error(
            `[acp] finish early run ${runID}: ${errorMessage(error)}`,
          );
        }
        this.notifyRunStatus(rt.id, runID, acpRunStatus(state));
      };
      // Publication is a Runtime capability, not an ACP-local output
      // convention. It must be installed before BuildAgent freezes the tool
      // registry.
      let artifacts: ArtifactCollector | null;
      try {
        artifacts = runtime.beginArtifactCollection(runID);
      } catch (error) {
        await finishEarly(RUN_STATE_FAILED, errorMessage(error));
        this.writeResponse(
          req.idRaw,
          null,
          acpFailureRPCError(error, null, PHASE_ADMISSION),
        );
        return;
      }
      // Project generated artifacts as canonical session/update notifications.
      // The observer only renders Runtime-owned attachment records after
      // durable persistence; content retrieval stays with the
      // opensac/attachment/fetch extension method.
      artifacts?.setObserver((record) => {
        try {
          this.notify(
            rt.id,
            artifactSessionUpdate(
              record.id,
              record.filename,
              record.kind,
              record.mediaType,
              record.bytes,
              runID,
            ),
          );
        } catch (error) {
          console.error(
            `[acp] notify artifact ${record.id}: ${errorMessage(error)}`,
          );
        }
      });
      rt.cancel = cancel;
      rt.promptID = promptKey;
      rt.runID = runID;
      rt.streamSegment = 0;
      rt.messageID = acpStreamMessageID(
        rt.id,
        promptKey,
        "message",
        rt.streamSegment,
      );
      rt.thoughtMessageID = acpStreamMessageID(
        rt.id,
        promptKey,
        "thought",
        rt.streamSegment,
      );
      rt.userMessageID = "acp_" + rt.id + "_" + promptKey + "_user";
      rt.activeModel = sessionModel;
      rt.activeMode = effectiveMode;
      rt.activeThinking = sessionThinking;
      rt.terminalNotified = false;
      // Echo the accepted user content using the same message grouping contract
      // used by streamed agent chunks.
      this.notify(rt.id, {
        sessionUpdate: "user_message_chunk",
        messageId: rt.userMessageID,
        content: { type: "text", text: userText } satisfies ContentBlock,
      });
      let extraContext = runtime.extraContext;
      if (editorContextText !== "") {
        if (extraContext.trim() !== "") extraContext += "\n\n";
        extraContext += editorContextText;
      }
      const runSettings: Settings = {
        ...settings,
        webSearch: { ...(settings.webSearch ?? {}), enabled: webSearchEnabled },
      };
      let a: Agent;
      try {
        a = runtime.buildAgent({
          provider: sessionProvider,
          providerName: sessionProviderName,
          model: sessionModel,
          settings: runSettings,
          allow: this.allow,
          mode: effectiveMode,
          thinkingLevel: sessionThinking,
          extraContext,
          sandboxEnabled,
          multiAgent: this.multiAgent,
          delegateMode: this.delegate,
          workflows: this.workflows,
          getSteeringMessages: esmSteeringMessages(runSettings, rt.id),
          conversationTurnId: "turn-" + intent.id,
          intentId: intent.id,
          runId: runID,
          conversationTurn: true,
          runtimeOwnsTurnEnd: true,
          approvalHandler: async (toolCallId, toolName, args) => {
            try {
              execution.waitForApproval(runID);
            } catch {
              return false;
            }
            try {
              return await this.requestPermissionContext(
                signal,
                rt.id,
                toolCallId,
                toolName,
                args,
              );
            } finally {
              try {
                execution.resume(runID);
              } catch {
                // The run already left the waiting state.
              }
            }
          },
        });
      } catch (error) {
        rt.cancel = null;
        rt.promptID = "";
        rt.runID = "";
        rt.activeModel = null;
        rt.activeMode = "";
        rt.activeThinking = "";
        let info: ErrorInfo | null = null;
        try {
          info = execution.recordFailure(error, { phase: PHASE_ADMISSION });
        } catch (observeError) {
          console.error(
            `[acp] record agent build failure for ${runID}: ${
              errorMessage(observeError)
            }`,
          );
        }
        console.error(
          `[acp] build agent for ${runID} failed: ${errorMessage(error)}`,
        );
        await finishEarly(
          RUN_STATE_FAILED,
          info !== null ? displayErrorMessage(info) : errorMessage(error),
        );
        this.writeResponse(
          req.idRaw,
          null,
          acpFailureRPCError(error, info, PHASE_ADMISSION),
        );
        return;
      }
      execution.setAgent(a);
      let agentMgr = rt.agentMgr;
      if (agentMgr === null) agentMgr = this.agentMgr;
      if (agentMgr !== null) agentMgr.register(newAgentAdapter(a));
      rt.agent = newAgentAdapter(a);
      // The runtime lock is held for the full lifetime of the admitted Run so
      // another adapter cannot race its terminal persistence with a new Run.
      admissionTransferred = true;
      const registeredAgentMgr = agentMgr;
      void (async () => {
        let stopReason = "end_turn";
        let runErr: Error | null = null;
        let terminalInfo: ErrorInfo | null = null;
        try {
          const events = a.runWithUserMessage(promptMessage, signal);
          let terminalSeen = false;
          let legacyTerminalSeen = false;
          for await (const coreEvent of events) {
            // Child-agent terminal events are projected to ACP as sub-agent
            // activity and must not mutate the parent Run's terminal facts.
            if (
              (coreEvent.agentId ?? "") === "" ||
              (coreEvent.type !== EVENT_RUN_FINISHED &&
                coreEvent.type !== EVENT_ERROR)
            ) {
              try {
                const observation = execution.observeAgentEvent(coreEvent);
                if (observation.error !== undefined) {
                  terminalInfo = observation.error;
                }
              } catch (error) {
                console.error(
                  `[acp] observe agent event for ${runID}: ${
                    errorMessage(error)
                  }`,
                );
              }
            }
            this.handleAgentEvent(rt.id, coreEvent);
            // A child-agent timeout is isolated to the child and must not turn
            // the ACP request into a failed parent run.
            if ((coreEvent.agentId ?? "") !== "") continue;
            switch (coreEvent.type) {
              case EVENT_QUESTION_REQUEST:
                void this.handleQuestion(signal, rt, runID, coreEvent);
                break;
              case EVENT_RUN_FINISHED:
                terminalSeen = true;
                switch (coreEvent.status ?? TASK_SUCCESS) {
                  case TASK_FAILED:
                    runErr = coreEvent.error ?? new Error("run failed");
                    stopReason = normalizeStopReason(
                      coreEvent.stopReason ?? "",
                    );
                    break;
                  case TASK_CANCELED:
                    stopReason = "cancelled";
                    break;
                  case TASK_INCOMPLETE:
                    stopReason = "max_tokens";
                    break;
                  default:
                    stopReason = normalizeStopReason(
                      coreEvent.stopReason ?? "",
                    );
                }
                break;
              case EVENT_DONE:
                if (!terminalSeen) {
                  legacyTerminalSeen = true;
                  stopReason = normalizeStopReason(coreEvent.stopReason ?? "");
                }
                break;
              case EVENT_ERROR:
                if (!terminalSeen) {
                  legacyTerminalSeen = true;
                  runErr = coreEvent.error ??
                    new Error("agent error event without error detail");
                  stopReason = normalizeStopReason(coreEvent.stopReason ?? "");
                }
                break;
            }
          }
          if (!terminalSeen && !legacyTerminalSeen && runErr === null) {
            // Event stream closed without any terminal event — protocol
            // failure, never a successful completion.
            runErr = new Error("event stream closed without terminal result");
            try {
              terminalInfo = execution.recordFailure(runErr, {
                code: "event_stream_interrupted",
                type: "transport_error",
                phase: PHASE_TRANSPORT,
                messageKey: "run.error.streamInterrupted",
                message: "The run stopped before it could finish.",
              });
            } catch (error) {
              console.error(
                `[acp] record interrupted stream for ${runID}: ${
                  errorMessage(error)
                }`,
              );
            }
          }
          if (runErr !== null && stopReason !== "cancelled") {
            console.error(
              `[acp] agent prompt ${runID} failed: ${errorMessage(runErr)}`,
            );
            this.writeResponse(
              req.idRaw,
              null,
              acpFailureRPCError(runErr, terminalInfo, PHASE_MODEL),
            );
            return;
          }
          this.writeResponse(req.idRaw, { stopReason }, null);
        } finally {
          try {
            if (registeredAgentMgr !== null && rt.agent !== null) {
              registeredAgentMgr.finish(rt.agent.id(), runErr ?? undefined);
            }
          } catch (error) {
            console.error(
              `[acp] finish agent manager ${runID}: ${errorMessage(error)}`,
            );
          }
          if (rt.promptID === promptKey) {
            rt.cancel = null;
            rt.promptID = "";
            rt.runID = "";
            rt.messageID = "";
            rt.thoughtMessageID = "";
            rt.userMessageID = "";
            rt.activeModel = null;
            rt.activeMode = "";
            rt.activeThinking = "";
          }
          if (rt.closed) {
            try {
              rt.closeResources();
            } catch (error) {
              console.error(
                `[acp] close session ${rt.id}: ${errorMessage(error)}`,
              );
            }
          }
          cancel();
          let state: RunState = RUN_STATE_COMPLETED;
          if (isTimeoutError(runErr)) {
            state = RUN_STATE_TIMED_OUT;
          } else if (stopReason === "cancelled" || isAbortError(runErr)) {
            state = RUN_STATE_CANCELLED;
          } else if (runErr !== null) {
            state = RUN_STATE_FAILED;
          }
          let message = "";
          let data: unknown;
          if (runErr !== null) {
            const info = acpFailureInfo(runErr, terminalInfo, PHASE_MODEL);
            message = displayErrorMessage(info);
            data = { error: message, errorInfo: info };
          }
          try {
            await execution.finishDurableWithRetry(
              undefined,
              runID,
              state,
              message,
              makeRunEvent({
                sessionId: rt.id,
                runId: runID,
                eventType: "finished",
                source: runSource,
                status: state,
                model: sessionModel.id,
                mode: effectiveMode,
                timestamp: new Date(),
                data,
              }),
            );
          } catch (error) {
            console.error(
              `[acp] finish durable run ${runID}: ${errorMessage(error)}`,
            );
          }
          this.notifyRunStatus(rt.id, runID, acpRunStatus(state));
          try {
            artifacts?.close();
          } catch (error) {
            console.error(
              `[acp] close artifacts ${runID}: ${errorMessage(error)}`,
            );
          }
          runtimeRelease();
        }
      })();
    } finally {
      if (!admissionTransferred) runtimeRelease();
    }
  }

  /** Handles `session/cancel`, aborting the session's active prompt run. */
  handleCancel(req: ACPRPCRequest): void {
    const inRequest = decodeCancelRequest(req.params);
    if (inRequest === null || (inRequest.sessionId ?? "").trim() === "") {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32602, "sessionId is required"),
      );
      return;
    }
    const sessionId = inRequest.sessionId!.trim();
    const rt = this.sessions.get(sessionId) ?? null;
    if (rt === null) {
      this.writeResponse(
        req.idRaw,
        null,
        new RPCError(-32000, "unknown session"),
      );
      return;
    }
    if (rt.execution !== null && rt.execution.cancel()) {
      // ExecutionRuntime also aborts the core agent.
    } else if (rt.cancel !== null) {
      rt.cancel();
    }
    this.writeResponse(req.idRaw, {}, null);
  }

  /**
   * Handles `$/cancel_request`, cancelling the prompt identified by its ACP
   * request id and releasing any pending reverse request with a cancelled
   * outcome.
   */
  handleCancelRequest(req: ACPRPCRequest): void {
    const requestId = parseJSONMap(req.params)?.requestId;
    if (requestId === undefined || requestId === null) return;
    const key = rawIDKey(JSON.stringify(requestId));
    const callback = this.pending.get(key);
    if (callback !== undefined) this.pending.delete(key);
    let execution: ExecutionRuntime | null = null;
    let cancel: (() => void) | null = null;
    for (const rt of this.sessions.values()) {
      if (rt.promptID === key) {
        cancel = rt.cancel;
        execution = rt.execution;
      }
      if (cancel !== null || execution !== null) break;
    }
    if (callback !== undefined) {
      callback({ outcome: { outcome: "cancelled" } });
    }
    if (execution !== null && execution.cancel()) {
      // Already cancelled through the shared execution state.
    } else if (cancel !== null) {
      cancel();
    }
  }

  /**
   * Runs a potentially asynchronous mutation under the shared session mutation
   * lease (the async sibling of `withSessionMutationLease`).
   */
  async withSessionMutationLeaseAsync(
    sessionId: string,
    mutate: () => void | Promise<void>,
  ): Promise<void> {
    if (this.settings === null || sessionId.trim() === "") {
      await mutate();
      return;
    }
    const sessionDir = getSessionDir(this.settings);
    if (runtimeLeaseLost(sessionDir, sessionId) !== undefined) {
      await mutate();
      return;
    }
    let guard: RuntimeLeaseGuard;
    try {
      guard = acquireMutation(sessionDir, sessionId);
    } catch {
      throw new Error("session already has an active run");
    }
    try {
      await mutate();
    } finally {
      guard.release();
    }
  }

  // ─── available commands and skill activation ──────────────────────────────

  /** Projects the standard available-commands catalog for this process. */
  availableCommands(): AvailableCommand[] {
    return this.availableCommandsFor(this.skillsMgr);
  }

  /** Projects the available-commands catalog for one skills manager. */
  availableCommandsFor(manager: SkillsManager | null): AvailableCommand[] {
    if (manager === null || manager === undefined) return [];
    const commands: AvailableCommand[] = [{
      name: systeminitCommand,
      description: "Initialize project guidance",
      _meta: { [opensacExtensionNamespace]: { kind: "command" } },
    }];
    for (const skill of manager.list()) {
      if (skill === null || skill === undefined || skill.name.trim() === "") {
        continue;
      }
      commands.push({
        name: "/" + skill.name,
        description: skill.description,
        _meta: { [opensacExtensionNamespace]: { kind: "skill" } },
      });
    }
    return commands;
  }

  /** Notifies one session of the available-commands catalog. */
  notifyAvailableCommands(sessionId: string): void {
    this.notifyAvailableCommandsFor(sessionId, this.skillsMgr);
  }

  /** Notifies one session of an explicit catalog. */
  notifyAvailableCommandsFor(
    sessionId: string,
    manager: SkillsManager | null,
  ): void {
    const commands = this.availableCommandsFor(manager);
    if (commands.length === 0) return;
    this.notify(sessionId, {
      sessionUpdate: "available_commands_update",
      availableCommands: commands as unknown[],
    });
  }

  /**
   * Recognizes the explicit skill directives exposed by TUI, Serve and Desktop.
   * The shared Runtime owns the reload and prompt context; ACP only recognizes
   * its wire command.
   */
  async activateSkillPrompt(
    rt: ACPSessionRuntime,
    text: string,
  ): Promise<boolean> {
    if (rt === null || rt.runtime === null) return false;
    const parts = text.trim().split(/\s+/).filter((part) => part !== "");
    if (parts.length === 0) return false;
    let name = "";
    if (parts.length === 1 && parts[0].startsWith("/skill:")) {
      name = parts[0].slice("/skill:".length);
    } else if (parts.length === 2 && parts[0] === "/skill") {
      name = parts[1];
    } else if (parts.length === 1 && parts[0].startsWith("/")) {
      name = parts[0].slice(1);
    } else {
      return false;
    }
    name = name.trim();
    const skillsMgr = rt.runtime.skillsMgr;
    if (name === "" || skillsMgr === undefined || skillsMgr === null) {
      return false;
    }
    if (skillsMgr.get(name) === undefined) return false;
    const previous = rt.activeSkills.get(name);
    const existed = rt.activeSkills.has(name);
    rt.activeSkills.set(name, true);
    const browserEnabled = rt.runtime.capabilitySnapshot().browserEnabled;
    try {
      await rt.runtime.refreshResources(this.settings!, {
        workflows: this.workflows,
        browser: browserEnabled,
        activeSkills: Object.fromEntries(rt.activeSkills),
      });
    } catch (error) {
      if (existed && previous !== undefined) {
        rt.activeSkills.set(name, previous);
      } else {
        rt.activeSkills.delete(name);
      }
      throw error;
    }
    return true;
  }

  /** Emits one persisted provider message as its ACP transcript updates. */
  emitMessage(sessionId: string, msg: Message): void {
    for (
      const update of projectMessageUpdates(this.toolTitles, sessionId, msg, "")
    ) {
      this.notify(sessionId, update);
    }
  }

  /**
   * Projects the initial transcript of a loaded session. A non-positive limit
   * streams the complete transcript as notifications and returns null; a
   * positive limit returns one earlier page.
   */
  projectInitialTranscript(
    sessionId: string,
    mgr: SessionManager,
    limit: number,
  ): TranscriptPageResult | null {
    if (limit <= 0) {
      for (const msg of mgr.getMessages()) this.emitMessage(sessionId, msg);
      return null;
    }
    return projectTranscriptPage(sessionId, mgr, "", limit, this.toolTitles);
  }

  // ─── agent-event projection ───────────────────────────────────────────────

  /**
   * Projects one Agent Core event onto the ACP session stream. This is the
   * single adapter projection of the canonical event vocabulary: child agent
   * lifecycle is projected additively while child text/tool events keep
   * rendering on the parent stream, and a child terminal event never mutates
   * the parent run facts.
   */
  handleAgentEvent(sessionId: string, ev: AgentEvent): void {
    if ((ev.agentId ?? "") !== "") {
      this.observeSubagentEvent(sessionId, ev);
    }
    switch (ev.type) {
      case EVENT_HOSTED_ITEM: {
        const item = ev.hostedItem;
        if (item !== undefined) {
          let status = item.status ?? "";
          if (status === "") status = "updated";
          let title = item.type ?? "";
          if (title === "") title = "hosted item";
          this.notify(sessionId, {
            sessionUpdate: "tool_call_update",
            toolCallId: item.id ?? "",
            title: `${title}: ${status}`,
            kind: "other",
            status: acpHostedStatus(status),
          });
        }
        break;
      }
      case EVENT_TEXT_DELTA: {
        const textDelta = ev.textDelta ?? "";
        this.notify(sessionId, {
          sessionUpdate: "agent_message_chunk",
          messageId: this.streamMessageID(sessionId, false, textDelta),
          content: { type: "text", text: textDelta } satisfies ContentBlock,
        });
        break;
      }
      case EVENT_THINK_DELTA: {
        const thinkDelta = ev.thinkDelta ?? "";
        this.notify(sessionId, {
          sessionUpdate: "agent_thought_chunk",
          messageId: this.streamMessageID(sessionId, true, thinkDelta),
          content: { type: "text", text: thinkDelta } satisfies ContentBlock,
        });
        break;
      }
      case EVENT_TOOL_CALL: {
        const call = ev.toolCall;
        if (call !== undefined) {
          const title = this.toolTitles.rememberToolTitle(
            call.id,
            call.name,
            ev.toolArgs,
          );
          this.notify(sessionId, {
            sessionUpdate: "tool_call",
            toolCallId: call.id,
            title,
            kind: acpToolKind(call.name),
            status: "pending",
            rawInput: toolRawInput(ev.toolArgs),
          });
        }
        break;
      }
      case EVENT_TOOL_EXECUTION_START: {
        const toolCallId = ev.toolCallId ?? "";
        const toolName = ev.toolName ?? "";
        this.notify(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId,
          title: this.toolTitles.rememberToolTitle(
            toolCallId,
            toolName,
            ev.toolArgs,
          ),
          kind: acpToolKind(toolName),
          status: "in_progress",
          rawInput: toolRawInput(ev.toolArgs),
        });
        break;
      }
      case EVENT_TOOL_EXECUTION_END: {
        const toolCallId = ev.toolCallId ?? "";
        const toolName = ev.toolName ?? "";
        let status = "completed";
        let toolContent = ev.toolResult ?? "";
        const rawOutput: Record<string, unknown> = { content: toolContent };
        if (ev.toolError !== undefined) {
          status = "failed";
          const info = acpFailureInfo(ev.toolError, null, PHASE_TOOL);
          toolContent = displayErrorMessage(info);
          rawOutput.content = toolContent;
          rawOutput.errorInfo = info;
        }
        const diff = ev.toolDiff;
        if (diff !== undefined) rawOutput.diff = diff;
        const toolContents: ToolCallContent[] = [];
        const text = toolContent.trim();
        if (text !== "") {
          toolContents.push(
            new ToolCallContent({
              type: "content",
              content: { type: "text", text },
            }),
          );
        }
        if ((ev.toolImages ?? []).length > 0) {
          toolContents.push(...acpToolImageContents(ev.toolImages ?? []));
        }
        if (diff !== undefined) {
          toolContents.push(
            new ToolCallContent({
              type: "diff",
              path: diff.path,
              oldText: diff.oldText,
              newText: diff.newText,
            }),
          );
        }
        const locations = toolCallLocations(diff);
        this.notify(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId,
          title: this.toolTitles.toolTitleFor(toolCallId, toolName),
          kind: acpToolKind(toolName),
          status,
          content: toolContents.length > 0 ? toolContents : undefined,
          locations: locations.length > 0 ? locations : undefined,
          rawOutput,
        });
        break;
      }
      case EVENT_TOOL_EXECUTION_UPDATE: {
        const content = textToolContent(renderScalar(ev.partialResult));
        this.notify(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: ev.toolCallId ?? "",
          content: content.length > 0 ? content : undefined,
        });
        break;
      }
      case EVENT_TOOL_RESULT:
        break;
      case EVENT_PLAN_UPDATE: {
        const plan = ev.plan;
        if (plan !== undefined) {
          this.notify(sessionId, {
            sessionUpdate: "plan",
            entries: acpPlanEntries(plan),
            _meta: acpPlanMeta(plan),
          });
        }
        break;
      }
      case EVENT_USAGE:
        this.emitUsageUpdate(sessionId, ev, true);
        break;
      case EVENT_DONE:
        this.emitUsageUpdate(sessionId, ev, false);
        break;
      case EVENT_ERROR:
      case EVENT_RUN_FINISHED: {
        // Terminal errors use the same structured Runtime contract as the
        // prompt response and durable replay. Child-agent terminal events were
        // already projected above as subagent lifecycle events and must not
        // produce a parent terminal projection.
        if ((ev.agentId ?? "") !== "") return;
        if (!this.markTerminalNotified(sessionId)) return;
        let status = "failed";
        let info: ErrorInfo | null = null;
        if (ev.type === EVENT_RUN_FINISHED) {
          switch (ev.status) {
            case TASK_SUCCESS:
              status = "completed";
              break;
            case TASK_CANCELED:
              status = "cancelled";
              break;
            case TASK_INCOMPLETE:
              status = "incomplete";
              break;
          }
        }
        if (status !== "completed") {
          let classified = acpFailureInfo(ev.error, null, PHASE_MODEL);
          if (ev.status === TASK_CANCELED) {
            classified = classifyError(
              new DOMException("The operation was aborted.", "AbortError"),
              { phase: PHASE_MODEL },
            );
          } else if (ev.status === TASK_INCOMPLETE) {
            classified.code = "run_incomplete";
            classified.type = "incomplete_error";
            classified.failureClass = FAILURE_INCOMPLETE;
            classified.phase = PHASE_MODEL;
            classified.messageKey = "run.error.incomplete";
            classified.message = "The run ended before it could complete.";
            classified.retryMode = RETRY_USER;
            classified.retryable = true;
          }
          info = classified;
        }
        const params: Record<string, unknown> = {
          sessionId,
          event: "terminal",
          status,
        };
        if (info !== null) {
          params.errorInfo = info;
          params.error = displayErrorMessage(info);
        }
        this.notifyExtension("_opensac/session_event", params);
        break;
      }
      case EVENT_RETRY:
        this.notifyExtension(
          "_opensac/session_event",
          acpRetryEvent(sessionId, ev),
        );
        break;
      case EVENT_STATUS:
        if (ev.retryStatus === true) return;
        this.notifyExtension("_opensac/session_event", {
          sessionId,
          event: "status",
          message: ev.statusMessage ?? "",
        });
        break;
      case EVENT_TURN_START:
        // A model turn begins after any preceding tool executions. Assigning a
        // new ID here keeps its streamed text/thought separate from earlier
        // turns and leaves the tool cards at their canonical transcript point.
        this.advanceStreamSegment(sessionId);
        this.notifyExtension("_opensac/session_event", {
          sessionId,
          event: acpEventName(ev.type),
          message: ev.statusMessage ?? "",
        });
        break;
      case EVENT_COMPACTION_START:
      case EVENT_COMPACTION_END:
      case EVENT_TURN_END:
        this.notifyExtension("_opensac/session_event", {
          sessionId,
          event: acpEventName(ev.type),
          message: ev.statusMessage ?? "",
        });
        break;
    }
  }

  /**
   * Starts a new model turn. Tool calls already have stable `toolCallId`
   * values, while the following text/thought chunks need a new `messageId` to
   * preserve their transcript position in ACP clients.
   */
  advanceStreamSegment(sessionId: string): void {
    const rt = this.sessions.get(sessionId);
    if (rt === undefined) return;
    if (rt.promptID === "" || rt.messageID === "") return;
    rt.streamSegment++;
    rt.messageID = acpStreamMessageID(
      rt.id,
      rt.promptID,
      "message",
      rt.streamSegment,
    );
    rt.thoughtMessageID = acpStreamMessageID(
      rt.id,
      rt.promptID,
      "thought",
      rt.streamSegment,
    );
  }

  /**
   * Returns the active model turn's stable ACP message ID. Fixture sessions
   * that emit events without a prompt still receive a deterministic ID so
   * their wire payload remains schema-valid.
   */
  streamMessageID(sessionId: string, thought: boolean, _text: string): string {
    const rt = this.sessions.get(sessionId);
    if (rt !== undefined) {
      if (thought && rt.thoughtMessageID !== "") return rt.thoughtMessageID;
      if (!thought && rt.messageID !== "") return rt.messageID;
    }
    return acpStreamFallbackMessageID(sessionId, thought);
  }

  /** Claims the single terminal projection of one session run. */
  markTerminalNotified(sessionId: string): boolean {
    const rt = this.sessions.get(sessionId);
    if (rt === undefined || rt.terminalNotified) return false;
    rt.terminalNotified = true;
    return true;
  }

  /**
   * Projects an Agent usage event onto the cumulative ACP `usage_update`.
   * `addCost` is false for the final `done` event so its usage is never
   * double-counted.
   */
  emitUsageUpdate(sessionId: string, ev: AgentEvent, addCost: boolean): void {
    const rt = this.sessions.get(sessionId);
    if (rt === undefined) return;
    let model = rt.activeModel;
    if (model === null) model = runtimeModelOf(rt.runtime);
    if (model === null) model = this.m;
    const usage = ev.usage;
    const [used, size] = usageContext(ev.contextUsage, usage, model);
    if (addCost && usage !== undefined && usage !== null) {
      if (model !== null) calculateCost(usage, model);
      rt.cost += usage.cost.total;
      rt.usageCache.addTurn(
        usage.cacheRead,
        usage.cacheWrite,
        totalInputTokens(usage),
      );
    }
    const update: SessionUpdate = {
      sessionUpdate: "usage_update",
      used,
      size,
      _meta: rt.usageCache.meta(),
    };
    if (rt.cost > 0) {
      update.cost = { amount: rt.cost, currency: "USD" };
    }
    this.notify(sessionId, update);
  }

  // ─── MCP callbacks (notification + sampling) ──────────────────────────────

  /** Builds the per-session MCP callback set. */
  buildMCPCallbacks(sessionId: string): MCPCallbacks {
    return {
      onNotification: (serverName, method, params) => {
        this.handleMCPNotification(sessionId, serverName, method, params);
      },
      onSamplingCreateMessage: (signal, serverName, params) =>
        this.handleMCPSamplingCreateMessage(
          signal,
          sessionId,
          serverName,
          params,
        ),
    };
  }

  /** Projects an inbound MCP notification as an additive tool-call update. */
  handleMCPNotification(
    sessionId: string,
    serverName: string,
    method: string,
    params: unknown,
  ): void {
    const callId = "mcp-notify-" + sanitizeToolName(serverName);
    const title = "mcp_notification: " + serverName;
    if (!this.mcpNotify.get(callId)) {
      this.mcpNotify.set(callId, true);
      this.notify(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: callId,
        title,
        kind: "other",
        status: "pending",
      });
    }
    const rawOut: Record<string, unknown> = { method };
    const parsed = parseJSONMap(params);
    if (parsed !== undefined) {
      rawOut.params = parsed;
    } else {
      const text = typeof params === "string" ? params : "";
      if (text.trim() !== "" && text.trim() !== "null") {
        rawOut.paramsText = text.trim();
      }
    }
    switch (method) {
      case "notifications/progress":
      case "notifications/message":
      case "logging/message":
      case "notifications/cancelled":
        this.notify(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: callId,
          title,
          status: "in_progress",
          rawOutput: rawOut,
        });
        break;
    }
  }

  /** Handles one MCP `sampling/createMessage` request. */
  async handleMCPSamplingCreateMessage(
    signal: AbortSignal,
    sessionId: string,
    serverName: string,
    params: unknown,
  ): Promise<{ result?: unknown; error?: RPCError }> {
    const rt = this.sessionRuntime(sessionId);
    if (rt === null || rt.runtime === null) {
      return { error: new RPCError(-32000, "unknown session") };
    }
    const snapshot = rt.runtime.configSnapshot();
    const p = snapshot.provider;
    const model = snapshot.model;
    if (p === null || model === null) {
      return { error: new RPCError(-32000, "session model is unavailable") };
    }
    const sampling = extractSamplingInput(params);
    if (sampling.prompt.trim() === "") {
      return {
        error: new RPCError(
          -32602,
          "sampling/createMessage requires non-empty messages",
        ),
      };
    }
    let maxTokens = sampling.maxTokens;
    if (maxTokens <= 0) maxTokens = resolveMaxTokens(model);
    const modelId = model.id;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort);
    const outText: string[] = [];
    try {
      const events = p.chat({
        messages: [newUserMessage(sampling.prompt)],
        systemPrompt: sampling.systemPrompt,
        thinkingLevel: snapshot.thinkingLevel,
        maxTokens,
        temperature: normalizeSamplingPtr(model.temperature),
        topP: normalizeSamplingPtr(model.topP),
        modelId,
        abort: controller.signal,
      });
      for await (const ev of events) {
        if (ev.type === streamTextDelta) {
          outText.push(ev.textDelta ?? "");
        } else if (ev.type === streamError) {
          if (ev.error !== undefined && ev.error !== null) {
            return {
              error: acpFailureRPCError(ev.error, null, PHASE_MODEL),
            };
          }
        }
      }
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    }
    let text = outText.join("").trim();
    if (text === "") text = "(empty response)";
    this.notify(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "MCP[" + serverName + "] sampling/createMessage completed",
      },
    });
    return {
      result: {
        model: modelId,
        role: "assistant",
        content: [{ type: "text", text }],
      },
    };
  }
}

/** One projected ACP available command (Go's `availableCommand`). */
export interface AvailableCommand {
  name: string;
  description?: string;
  input?: unknown;
  _meta?: Record<string, unknown>;
}

/** ACP `session/new` request params. */
export interface ACPNewSessionRequest {
  sessionId?: string;
  cwd?: string;
  additionalDirectories?: string[];
  mcpServers?: MCPServer[];
  _meta?: RequestMeta;
}

/** ACP `opensac/session/draft-config-options` request params. */
export interface ACPDraftConfigOptionsRequest {
  cwd?: string;
  _meta?: RequestMeta;
}

/** ACP `session/load` request params. */
export interface ACPLoadSessionRequest {
  sessionId?: string;
  cwd?: string;
  additionalDirectories?: string[];
  mcpServers?: MCPServer[];
  historyLimit?: number;
  _meta?: RequestMeta;
}

/** ACP `session/resume` request params. */
export interface ACPResumeSessionRequest {
  sessionId?: string;
  cwd?: string;
  additionalDirectories?: string[];
  mcpServers?: MCPServer[];
  _meta?: RequestMeta;
}

/** ACP `session/fork` request params. */
export interface ACPForkSessionRequest {
  sessionId?: string;
  cwd?: string;
  additionalDirectories?: string[];
  mcpServers?: MCPServer[];
  atSeq?: number;
  requestId?: string;
  titleMode?: string;
  /** The additive OpenSAC fork expert override; track presence separately. */
  expertId?: string;
  expertIdSet?: boolean;
  _meta?: RequestMeta;
}

/** ACP `session/set_config_option` request params. */
export interface ACPSetConfigOptionRequest {
  sessionId?: string;
  configId?: string;
  type?: string;
  value?: unknown;
  _meta?: RequestMeta;
}

/** ACP `session/set_mode` request params. */
export interface ACPSetModeRequest {
  sessionId?: string;
  modeId?: string;
  /** Compatibility alias accepted for older ACP clients. */
  mode?: string;
}

/** Constructs one ACP provider from settings (Go's `createProvider`). */
function createACPProvider(
  settings: Settings,
  providerName: string,
  modelId: string,
): { provider: Provider; model: Model } {
  return createWithOptions(settings, providerName, modelId, {
    builtinAnthropicCacheControl: true,
    requireModel: true,
  });
}

/** Removes a persisted session, ignoring a failure during cleanup. */
async function safeDeleteSession(
  sessionDir: string,
  id: string,
): Promise<void> {
  try {
    await deleteSession(sessionDir, id);
  } catch {
    // Best-effort cleanup of a session that failed to initialize.
  }
}

/** Returns the model configured on one runtime, or null. */
function runtimeModelOf(runtime: SessionRuntime | null): Model | null {
  if (runtime === null) return null;
  return runtime.configSnapshot().model;
}

/**
 * Resolves the `(used, size)` pair of one usage projection, preferring the
 * provider context footprint and falling back to the model window.
 */
function usageContext(
  contextUsage: ContextUsage | undefined,
  usage: Usage | undefined,
  model: Model | null,
): [number, number] {
  let used = 0;
  let size = 0;
  if (contextUsage !== undefined && contextUsage !== null) {
    used = contextUsage.totalTokens;
    if (used === 0) used = contextUsage.tokens;
    size = contextUsage.contextWindow;
  }
  if (used === 0 && usage !== undefined && usage !== null) {
    used = usage.totalTokens;
    if (used === 0) {
      used = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
    }
  }
  if (size === 0 && model !== null) size = model.contextWindow;
  return [used, size];
}

/**
 * Renders a scalar-ish tool-update partial result as text: a nullish value
 * renders as `"null"`, scalars use their native text, and everything else
 * falls back to JSON.
 */
function renderScalar(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  } catch {
    return String(value);
  }
}

/**
 * Rebuilds the cumulative usage_update projections from the canonical
 * persisted history so a loaded, resumed, or reattached session reports the
 * same baseline as an uninterrupted one. Compacted messages drop their usage by
 * design, so compacted history contributes nothing here.
 */
export function persistedSessionUsage(
  mgr: SessionManager | null,
  model: Model | null,
): { cost: number; usageCache: ACPCacheUsage } {
  const usageCache = new ACPCacheUsage();
  if (mgr === null) return { cost: 0, usageCache };
  let cost = 0;
  for (const msg of mgr.getMessages()) {
    const usage: Usage | undefined = msg.usage;
    if (usage === undefined || usage === null) continue;
    if (usage.cost.total === 0 && model !== null) calculateCost(usage, model);
    cost += usage.cost.total;
    usageCache.addTurn(
      usage.cacheRead,
      usage.cacheWrite,
      totalInputTokens(usage),
    );
  }
  return { cost, usageCache };
}

/** Parses a Go `strconv.ParseBool` value, returning undefined when invalid. */
function parseBoolean(value: string): boolean | undefined {
  switch (value) {
    case "1":
    case "t":
    case "T":
    case "true":
    case "TRUE":
    case "True":
      return true;
    case "0":
    case "f":
    case "F":
    case "false":
    case "FALSE":
    case "False":
      return false;
    default:
      return undefined;
  }
}

/** Projects already-decoded JSON params into a map, or undefined. */
function parseJSONMap(params: unknown): Record<string, unknown> | undefined {
  if (params === undefined || params === null) return undefined;
  if (typeof params === "object" && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  return undefined;
}

/** Extracts the provider sampling input from an MCP sampling request. */
function extractSamplingInput(params: unknown): {
  prompt: string;
  systemPrompt: string;
  maxTokens: number;
} {
  let maxTokens = 0;
  const raw = parseJSONMap(params);
  if (raw === undefined) return { prompt: "", systemPrompt: "", maxTokens };
  const rawMax = raw.maxTokens;
  if (typeof rawMax === "number" && Math.trunc(rawMax) > 0) {
    maxTokens = Math.trunc(rawMax);
  }
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  const parts: string[] = [];
  let systemPrompt = "";
  for (const item of messages) {
    const msgMap = parseJSONMap(item);
    if (msgMap === undefined) continue;
    const content = msgMap.content;
    const role = typeof msgMap.role === "string" ? msgMap.role : "";
    if (typeof content === "string") {
      if (content.trim() !== "") {
        if (role === "system") {
          if (systemPrompt === "") systemPrompt = content;
          continue;
        }
        parts.push(content);
      }
      continue;
    }
    if (!Array.isArray(content)) continue;
    const blockTexts: string[] = [];
    for (const blockItem of content) {
      const block = parseJSONMap(blockItem);
      if (block === undefined) continue;
      if (block.type !== "text") continue;
      const text = typeof block.text === "string" ? block.text : "";
      if (text.trim() !== "") blockTexts.push(text);
    }
    if (blockTexts.length === 0) continue;
    const joined = blockTexts.join("\n");
    if (role === "system") {
      if (systemPrompt === "") systemPrompt = joined;
      continue;
    }
    parts.push(joined);
  }
  return { prompt: parts.join("\n"), systemPrompt, maxTokens };
}

/** Decodes the shared `{sessionId,cwd,mcpServers,_meta}` request envelope. */
function decodeSessionLifecycleRequest(
  params: unknown,
): Record<string, unknown> | null {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) return null;
  const record = params as Record<string, unknown>;
  const request: Record<string, unknown> = {};
  if (typeof record.sessionId === "string") {
    request.sessionId = record.sessionId;
  }
  if (typeof record.cwd === "string") request.cwd = record.cwd;
  if (Array.isArray(record.additionalDirectories)) {
    request.additionalDirectories = record.additionalDirectories.filter(
      (value): value is string => typeof value === "string",
    );
  }
  if (Array.isArray(record.mcpServers)) {
    request.mcpServers = record.mcpServers.filter(
      (value): value is MCPServer =>
        typeof value === "object" && value !== null && !Array.isArray(value),
    );
  }
  if (
    record._meta !== undefined && typeof record._meta === "object" &&
    record._meta !== null
  ) {
    request._meta = record._meta as RequestMeta;
  }
  return request;
}

/** Decodes a `session/new` request; null marks malformed params. */
function decodeNewSessionRequest(params: unknown): ACPNewSessionRequest | null {
  return decodeSessionLifecycleRequest(params) as ACPNewSessionRequest | null;
}

/** Decodes a `opensac/session/draft-config-options` request. */
function decodeDraftConfigOptionsRequest(
  params: unknown,
): ACPDraftConfigOptionsRequest | null {
  return decodeSessionLifecycleRequest(
    params,
  ) as ACPDraftConfigOptionsRequest | null;
}

/** Decodes a `session/load` request; null marks malformed params. */
function decodeLoadSessionRequest(
  params: unknown,
): ACPLoadSessionRequest | null {
  const request = decodeSessionLifecycleRequest(params) as
    | ACPLoadSessionRequest
    | null;
  if (request === null) return null;
  const record = params as Record<string, unknown>;
  if (typeof record.historyLimit === "number") {
    request.historyLimit = Math.trunc(record.historyLimit);
  }
  return request;
}

/** Decodes a `session/resume` request; null marks malformed params. */
function decodeResumeSessionRequest(
  params: unknown,
): ACPResumeSessionRequest | null {
  return decodeSessionLifecycleRequest(
    params,
  ) as ACPResumeSessionRequest | null;
}

/** Decodes a `session/fork` request; null marks malformed params. */
function decodeForkSessionRequest(
  params: unknown,
): ACPForkSessionRequest | null {
  const request = decodeSessionLifecycleRequest(params) as
    | ACPForkSessionRequest
    | null;
  if (request === null) return null;
  const record = params as Record<string, unknown>;
  if (typeof record.atSeq === "number") {
    request.atSeq = Math.trunc(record.atSeq);
  }
  if (typeof record.requestId === "string") {
    request.requestId = record.requestId;
  }
  if (typeof record.titleMode === "string") {
    request.titleMode = record.titleMode;
  }
  if (typeof record.expertId === "string") {
    request.expertId = record.expertId;
    request.expertIdSet = true;
  }
  return request;
}

/** Decodes a `session/set_config_option` request. */
function decodeSetConfigOptionRequest(
  params: unknown,
): ACPSetConfigOptionRequest | null {
  const request = decodeSessionLifecycleRequest(params) as
    | ACPSetConfigOptionRequest
    | null;
  if (request === null) return null;
  const record = params as Record<string, unknown>;
  if (typeof record.configId === "string") request.configId = record.configId;
  if (typeof record.type === "string") request.type = record.type;
  if (record.value !== undefined) request.value = record.value;
  return request;
}

/** Decodes a `session/set_mode` request; null marks malformed params. */
function decodeSetModeRequest(params: unknown): ACPSetModeRequest | null {
  const request = decodeSessionLifecycleRequest(params) as
    | ACPSetModeRequest
    | null;
  if (request === null) return null;
  const record = params as Record<string, unknown>;
  if (typeof record.modeId === "string") request.modeId = record.modeId;
  if (typeof record.mode === "string") request.mode = record.mode;
  return request;
}

/** Mirrors `filepath.Clean`'s trailing-separator removal. */
function filepathClean(value: string): string {
  const cleaned = normalize(value);
  if (cleaned.length <= 1) return cleaned;
  const trimmed = cleaned.replace(/[/\\]+$/, "");
  return trimmed === "" ? cleaned : trimmed;
}

/** Reports whether two string slices are element-wise equal. */
function sameStringSlice(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

/** Returns an error's message, tolerating non-Error throws. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Decodes the typed `initialize` request params. */
function decodeInitializeRequest(params: unknown): ACPInitializeRequest {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return { protocolVersion: 0 };
  }
  const record = params as Record<string, unknown>;
  const request: ACPInitializeRequest = {};
  if (typeof record.protocolVersion === "number") {
    request.protocolVersion = Math.trunc(record.protocolVersion);
  } else {
    request.protocolVersion = 0;
  }
  if (record.clientCapabilities !== undefined) {
    request.clientCapabilities = record.clientCapabilities;
  }
  if (
    record.clientInfo !== undefined && typeof record.clientInfo === "object" &&
    record.clientInfo !== null
  ) {
    request.clientInfo = record.clientInfo as ACPClientInfo;
  }
  if (
    record._meta !== undefined && typeof record._meta === "object" &&
    record._meta !== null
  ) {
    request._meta = record._meta as RequestMeta;
  }
  return request;
}

/** Decodes the typed client capability model. */
function decodeClientCapabilities(raw: unknown): ACPClientCapabilities {
  if (raw === undefined || raw === null || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  const caps: ACPClientCapabilities = {};
  const fs = obj.fs;
  if (fs !== null && typeof fs === "object" && !Array.isArray(fs)) {
    const f = fs as Record<string, unknown>;
    const out: ACPClientFSCapabilities = {};
    if (f.readTextFile === true) out.readTextFile = true;
    if (f.writeTextFile === true) out.writeTextFile = true;
    caps.fs = out;
  }
  if (typeof obj.terminal === "boolean") caps.terminal = obj.terminal;
  const auth = obj.auth;
  if (auth !== null && typeof auth === "object" && !Array.isArray(auth)) {
    const a = auth as Record<string, unknown>;
    caps.auth = { terminal: a.terminal === true };
  }
  const elicitation = obj.elicitation;
  if (
    elicitation !== null && typeof elicitation === "object" &&
    !Array.isArray(elicitation)
  ) {
    const e = elicitation as Record<string, unknown>;
    const out: ACPClientElicitationCapabilities = {};
    if (e.form !== null && typeof e.form === "object") out.form = {};
    if (e.url !== null && typeof e.url === "object") out.url = {};
    caps.elicitation = out;
  }
  const session = obj.session;
  if (
    session !== null && typeof session === "object" && !Array.isArray(session)
  ) {
    const s = session as Record<string, unknown>;
    const out: ACPClientSessionCapabilities = {};
    const configOptions = s.configOptions;
    if (
      configOptions !== null && typeof configOptions === "object" &&
      !Array.isArray(configOptions)
    ) {
      const c = configOptions as Record<string, unknown>;
      const co: ACPClientConfigOptionCapabilities = {};
      if (c.boolean !== null && typeof c.boolean === "object") {
        co.boolean = {};
      }
      out.configOptions = co;
    }
    caps.session = out;
  }
  return caps;
}

/** Server-side session list page size (Go's `sessionListPageSize`). */
export const sessionListPageSize = 50;

/**
 * ACP presentation adapter for the shared Runtime failure contract. It accepts
 * a Runtime observation when one exists so tool/output safety facts are
 * preserved instead of being inferred again by ACP.
 */
export function acpFailureInfo(
  error: unknown,
  observed: ErrorInfo | null | undefined,
  phase: RunPhase,
): ErrorInfo {
  if (
    observed !== null && observed !== undefined &&
    displayErrorMessage(observed).trim() !== ""
  ) {
    return observed;
  }
  return classifyError(error, { phase });
}

/** Builds the structured ACP failure envelope for one Runtime failure. */
export function acpFailureRPCError(
  error: unknown,
  observed: ErrorInfo | null | undefined,
  phase: RunPhase,
): RPCError {
  if (error instanceof SessionProviderMismatchError) {
    return new RPCError(-32002, "session provider mismatch", {
      sessionProvider: error.sessionProvider,
      sessionModel: error.sessionModel,
      currentProvider: error.currentProvider,
    });
  }
  const info = acpFailureInfo(error, observed, phase);
  let message = displayErrorMessage(info).trim();
  if (message === "") message = "The run could not be completed.";
  // MCP/JSON-RPC clients receive the complete safe contract in `data`; the
  // legacy code/message fields remain for clients that do not understand the
  // extension, while `detail` carries the bounded provider diagnostic.
  return new RPCError(-32000, message, {
    code: info.code,
    type: info.type,
    failureClass: info.failureClass,
    phase: info.phase,
    messageKey: info.messageKey,
    detail: info.detail,
    retryMode: info.retryMode,
    retryable: info.retryable,
    retryAfterMs: info.retryAfterMs,
    attempt: info.attempt,
    maxAttempts: info.maxAttempts,
    sideEffectState: info.sideEffectState,
    partialOutput: info.partialOutput,
    runId: info.runId,
    intentId: info.intentId,
    requestId: info.requestId,
  });
}

/** Decodes the `opensac/session/history` request; null marks malformed params. */
function decodeTranscriptPageRequest(
  params: unknown,
): ACPTranscriptPageRequest | null {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) return null;
  const record = params as Record<string, unknown>;
  const request: ACPTranscriptPageRequest = {};
  if (typeof record.sessionId === "string") {
    request.sessionId = record.sessionId;
  }
  if (typeof record.cursor === "string") request.cursor = record.cursor;
  if (typeof record.limit === "number") {
    request.limit = Math.trunc(record.limit);
  }
  return request;
}

/** Decodes a `session/list` request; null marks malformed params. */
function decodeListSessionsRequest(
  params: unknown,
): ACPListSessionsRequest | null {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) return null;
  const record = params as Record<string, unknown>;
  const request: ACPListSessionsRequest = {};
  if (typeof record.cwd === "string") request.cwd = record.cwd;
  if (Array.isArray(record.additionalDirectories)) {
    request.additionalDirectories = record.additionalDirectories.filter(
      (value): value is string => typeof value === "string",
    );
  }
  if (typeof record.cursor === "string") request.cursor = record.cursor;
  if (typeof record.scope === "string") request.scope = record.scope;
  if (typeof record.projectId === "string") {
    request.projectId = record.projectId;
  }
  if (typeof record.query === "string") request.query = record.query;
  if (
    record._meta !== undefined && typeof record._meta === "object" &&
    record._meta !== null
  ) {
    request._meta = record._meta as RequestMeta;
  }
  return request;
}

/** Decodes a `session/cancel` request; null marks malformed params. */
function decodeCancelRequest(
  params: unknown,
): { sessionId?: string } | null {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) return null;
  const record = params as Record<string, unknown>;
  const request: { sessionId?: string } = {};
  if (typeof record.sessionId === "string") {
    request.sessionId = record.sessionId;
  }
  return request;
}

/** Decodes a `session/close` request; null marks malformed params. */
function decodeCloseSessionRequest(
  params: unknown,
): ACPCloseSessionRequest | null {
  return decodeSessionRequest(params) as ACPCloseSessionRequest | null;
}

/** Decodes a session delete request; null marks malformed params. */
function decodeDeleteSessionRequest(
  params: unknown,
): ACPDeleteSessionRequest | null {
  return decodeSessionRequest(params) as ACPDeleteSessionRequest | null;
}

/** Decodes a `opensac/session/setTitle` request; null marks malformed params. */
function decodeSetTitleRequest(params: unknown): ACPSetTitleRequest | null {
  return decodeSessionRequest(params) as ACPSetTitleRequest | null;
}

/** Decodes a `opensac/session/setWorkDir` request; null marks malformed params. */
function decodeSetWorkDirRequest(params: unknown): ACPSetWorkDirRequest | null {
  return decodeSessionRequest(params) as ACPSetWorkDirRequest | null;
}

/** Shared decode of the `{sessionId,cwd,title,_meta}` request envelope. */
function decodeSessionRequest(
  params: unknown,
): Record<string, unknown> | null {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) return null;
  const record = params as Record<string, unknown>;
  const request: Record<string, unknown> = {};
  if (typeof record.sessionId === "string") {
    request.sessionId = record.sessionId;
  }
  if (typeof record.cwd === "string") request.cwd = record.cwd;
  if (typeof record.title === "string") request.title = record.title;
  if (
    record._meta !== undefined && typeof record._meta === "object" &&
    record._meta !== null
  ) {
    request._meta = record._meta as RequestMeta;
  }
  return request;
}

/** Decodes a `session/prompt` request; null marks malformed params. */
function decodePromptRequest(params: unknown): ACPPromptRequest | null {
  if (params === undefined || params === null) return null;
  if (typeof params !== "object" || Array.isArray(params)) return null;
  const record = params as Record<string, unknown>;
  const request: ACPPromptRequest = { prompt: [] };
  if (typeof record.sessionId === "string") {
    request.sessionId = record.sessionId;
  }
  if (Array.isArray(record.prompt)) {
    request.prompt = record.prompt.filter((block): block is ContentBlock =>
      typeof block === "object" && block !== null && !Array.isArray(block)
    );
  }
  if (Array.isArray(record.knowledgeBaseRefs)) {
    const refs: KnowledgeBaseReference[] = [];
    for (const raw of record.knowledgeBaseRefs) {
      const ref = jsonRecord(raw);
      if (ref === undefined) continue;
      if (typeof ref.knowledgeBaseId !== "string") continue;
      const reference: KnowledgeBaseReference = {
        knowledgeBaseId: ref.knowledgeBaseId,
      };
      if (typeof ref.required === "boolean") reference.required = ref.required;
      refs.push(reference);
    }
    request.knowledgeBaseRefs = refs;
  }
  if (
    record._meta !== undefined && typeof record._meta === "object" &&
    record._meta !== null
  ) {
    request._meta = record._meta as RequestMeta;
  }
  return request;
}

/**
 * Adapts the shared, persisted ESM objective into an ACP prompt run. It owns no
 * state and does not schedule work; the source only emits a changed objective
 * at an Agent loop steering boundary.
 */
export function esmSteeringMessages(
  settings: Settings | null,
  sessionID: string,
): (() => Message[]) | undefined {
  if (settings === null) return undefined;
  const sessionDir = getSessionDir(settings);
  if (sessionDir === "" || sessionID === "") return undefined;
  const source = new ESMSteeringSource(new ESMStore(sessionDir), sessionID);
  return () => source.next();
}

/** Fills the required fields of a canonical durable Run row. */
function makeDurableRun(partial: Partial<DurableRun>): DurableRun {
  return {
    id: "",
    sessionId: "",
    intentId: "",
    retryOf: "",
    attempt: 0,
    workDir: "",
    source: "",
    model: "",
    mode: "",
    status: "",
    startedAt: new Date(0),
    finishedAt: null,
    error: "",
    errorInfo: {},
    progress: {},
    usage: undefined,
    contextUsage: undefined,
    inputResourceIds: [],
    submissionKeyHash: "",
    submissionScope: "",
    submissionFingerprint: "",
    userEntryId: "",
    userMessage: undefined,
    assistantEntryId: "",
    assistantMessage: undefined,
    conversationTurnId: "",
    conversationTurn: false,
    ...partial,
  };
}

/** Fills the shared envelope fields of a canonical Run event. */
function makeRunEvent(
  partial: Partial<RunEvent> & {
    sessionId: string;
    runId: string;
    eventType: string;
  },
): RunEvent {
  return {
    source: "",
    status: "",
    model: "",
    mode: "",
    ...partial,
  };
}

/** The outcome of racing one pending reverse request. */
type PendingRequestOutcome =
  | { kind: "value"; value: unknown }
  | { kind: "aborted" }
  | { kind: "timed_out" };

/**
 * Races a pending reverse-request promise against the run cancellation and the
 * decision deadline, the JS projection of Go's `select { ctx.Done,
 * time.After, ch }`.
 */
function racePendingRequest(
  pending: Promise<unknown>,
  ctx: AbortSignal | undefined,
  timeoutMs: number,
): Promise<PendingRequestOutcome> {
  return new Promise<PendingRequestOutcome>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish({ kind: "aborted" });
    const finish = (outcome: PendingRequestOutcome) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (ctx !== undefined) ctx.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    if (ctx !== undefined) {
      if (ctx.aborted) {
        finish({ kind: "aborted" });
        return;
      }
      ctx.addEventListener("abort", onAbort, { once: true });
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => finish({ kind: "timed_out" }), timeoutMs);
    }
    pending.then(
      (value) => finish({ kind: "value", value }),
      () => finish({ kind: "aborted" }),
    );
  });
}

/** Narrows a decoded JSON value to a plain object. */
function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Maps one knowledge-base failure to its documented structured ACP error. The
 * management plane and the prompt knowledge-reference path share it so a
 * missing or disabled base never leaks as a generic failure.
 */
export function manageKnowledgeBaseRPCError(error: unknown): RPCError {
  const err = error instanceof Error ? error : new Error(String(error));
  if (err instanceof KnowledgeBaseNotFoundError) {
    return acpStructuredRPCError(
      -32602,
      "knowledge_base_not_found",
      "knowledge base was not found",
      undefined,
    );
  }
  if (err instanceof KnowledgeBaseUnindexedError) {
    return acpStructuredRPCError(
      -32602,
      "knowledge_base_unindexed",
      "knowledge base has no completed index",
      undefined,
    );
  }
  const message = err.message.trim();
  if (message.includes("is disabled")) {
    return acpStructuredRPCError(
      -32602,
      "knowledge_base_disabled",
      message,
      undefined,
    );
  }
  if (
    message.includes("knowledge base root") ||
    message.includes("path escaped root")
  ) {
    return acpStructuredRPCError(
      -32602,
      "knowledge_base_root_unavailable",
      message,
      undefined,
    );
  }
  return acpStructuredRPCError(
    -32000,
    "knowledge_base_operation_failed",
    message,
    undefined,
  );
}
