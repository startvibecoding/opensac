import { type Settings } from "../config/settings.ts";
import {
  type CoreRpcId,
  type CoreRpcParams,
  type CoreRpcResponse,
} from "./protocol.ts";

/** A front-end-neutral runtime source identifier. */
export type CoreRuntimeSource = string;

export type CoreReverseRequest = (
  id: CoreRpcId,
  method: string,
  params?: CoreRpcParams,
) => Promise<CoreRpcResponse>;

/** A front-end-neutral session creation request. */
export interface CoreSessionCreateInput {
  workDir: string;
  providerName?: string;
  modelID?: string;
  mode?: string;
  thinkingLevel?: string;
  capabilities?: Record<string, boolean>;
  /**
   * Runtime source recorded on the session's runs (for example `cli` for the
   * print action); empty falls back to the Core host's own source.
   */
  source?: string;
  /** Run-record approval policy (`runtime`, `print`, ...). */
  approvalPolicy?: string;
  /** Run-record question policy (`runtime`, `unattended`, ...). */
  questionPolicy?: string;
  /**
   * Optional existing session identity to adopt (open-or-create semantics).
   * Clients use it to rebind to a session that already has a persisted
   * identity (for example after a fork or reload); the Core still owns the
   * session lifecycle.
   */
  sessionId?: string;
}

/** One Runtime-materialized input resource staged before a prompt. */
export interface CorePreparedInput {
  resourceId: string;
  kind: string;
  relativePath: string;
  filename: string;
  mediaType: string;
  bytes: number;
}

/** One materialized-input intake request (content travels base64-encoded). */
export interface CorePrepareInput {
  name: string;
  mediaType: string;
  contentBase64: string;
  kind?: string;
}

/** The neutral projection of one discovered skill. */
export interface CoreSkillView {
  name: string;
  source: string;
  description: string;
  active: boolean;
}

/** Capability discovery metadata keyed by capability name. */
export type CoreCapabilityView = Record<
  string,
  { enabled: boolean; available: boolean }
>;

/** The secret-safe catalog entry for one built-in or configured provider. */
export interface CoreProviderCatalogView {
  id: string;
  /** Whether settings.json carries an explicit block for this provider. */
  configured: boolean;
  isDefault: boolean;
  /** Raw configured API kind/base URL/model count (empty when unconfigured). */
  api: string;
  baseUrl: string;
  modelCount: number;
  /** Preset-filled model listing (the Core-owned model catalog). */
  models: Array<{ id: string; name: string }>;
}

/** The session-owned rule/extra system-prompt context. */
export interface CoreSessionContextView {
  ruleContent: string;
  extraContext: string;
}

/** The neutral projection of one discoverable expert bundle. */
export interface CoreExpertSummaryView {
  name: string;
  displayName: { zh: string; en: string };
  expertType: string;
  source: string;
  invalid: boolean;
  invalidReason: string;
}

/** One expert member row in a team bundle projection. */
export interface CoreExpertMemberView {
  id: string;
  name: { zh: string; en: string };
  profession: { zh: string; en: string };
  role: string;
}

/** The neutral projection of one expert bundle's details. */
export interface CoreExpertBundleView {
  name: string;
  displayName: { zh: string; en: string };
  expertType: string;
  invalid: boolean;
  invalidReason: string;
  members: CoreExpertMemberView[];
}

/** The resolved expert binding of one session. */
export interface CoreExpertStateView {
  expertId: string;
}

/** The neutral projection of one managed agent (sub-agent/delegate/ESM role). */
export interface CoreAgentView {
  id: string;
  /** Parent agent ID; empty for a root agent. */
  parent: string;
  children: string[];
  /** Managed scheduling state; empty when no status row exists yet. */
  state: string;
}

/** The neutral, JSON-safe projection of one ESM objective row. */
export interface CoreEsmObjectiveView {
  sessionId: string;
  esmId: string;
  objective: string;
  status: string;
  tokensUsed: number;
  timeUsedMs: number;
  blockedCount: number;
  blockedReason: string;
  blockedRunId: string;
  completionReason: string;
  completionRunId: string;
  completionReview: string;
  phase: string;
  progressSummary: string;
  remainingWork: string[];
  rejectionCount: number;
  rejectionRunId: string;
  recoveryCount: number;
  recoveryReason: string;
  createdAt: string;
  updatedAt: string;
}

/** The ESM supervisor projection for one session. */
export interface CoreEsmView {
  objective: CoreEsmObjectiveView | null;
  /** Whether a Core-owned continuation worker is currently running. */
  workerRunning: boolean;
  /** The role agent currently executing, if any. */
  activeAgentId: string;
}

/** One ESM supervisor mutation request. */
export interface CoreEsmCommandInput {
  sessionId: string;
  action: "create" | "edit" | "pause" | "resume" | "guide" | "clear";
  /** The objective text for `create`/`edit`. */
  objective?: string;
  /** The guidance text for `guide`. */
  guide?: string;
}

/** One accepted ESM continuation worker. */
export interface CoreEsmContinuation {
  runId: string;
  /** False when no new worker started (idle or already running). */
  started: boolean;
}

/** One transient side-query prompt (read-only, no session history mutation). */
export interface CoreTransientPromptInput {
  sessionId: string;
  question: string;
  /** Per-query policy overrides; empty fields fall back to session config. */
  providerName?: string;
  modelID?: string;
  thinkingLevel?: string;
}

/** The collected answer of one transient side query. */
export interface CoreTransientPromptResult {
  answer: string;
}

/** A forced conversation compaction accepted by the Core Runtime Host. */
export interface CoreCompactAccepted {
  sessionId: string;
  runId: string;
  status: "running";
}

/** The public, adapter-neutral view of a Core-owned session. */
export interface CoreSessionView {
  sessionId: string;
  workDir: string;
  source: CoreRuntimeSource;
  providerName: string;
  modelID: string;
  mode: string;
  thinkingLevel: string;
  capabilities: Record<string, boolean>;
  /** Run-record approval policy resolved for this session's runs. */
  approvalPolicy: string;
  /** Run-record question policy resolved for this session's runs. */
  questionPolicy: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One rendered turn of a session's durable conversation, projected for a front
 * end that must reprint a resumed session's history.
 *
 * This is a presentation projection of Runtime-owned session replay, not a
 * second transcript store: the host derives it from the persisted branch, so it
 * survives a Core restart and matches what the user saw originally. Providers,
 * tool payloads, and secrets never appear; only the user's own text and the
 * assistant's visible text.
 */
export interface CoreTranscriptMessage {
  /** Whose turn this was, in the transcript's own vocabulary. */
  role: "user" | "assistant";
  /** The turn's text content; empty when the turn carried only tool calls. */
  text: string;
}

/** The adapter-neutral summary of one persisted session row. */
export interface CoreSessionListEntry {
  sessionId: string;
  workDir: string;
  modTime: Date;
  messageCount: number;
  preview: string;
}

/** A prompt accepted by the Core Runtime Host. */
export interface CorePromptInput {
  sessionId: string;
  text: string;
  attachments?: string[];
  metadata?: Record<string, unknown>;
  /** Per-run policy overrides; empty fields fall back to session config. */
  providerName?: string;
  modelID?: string;
  mode?: string;
  thinkingLevel?: string;
  /** Runtime-materialized resources staged before this prompt. */
  preparedInputs?: CorePreparedInput[];
}

/** The admission result for a prompt. */
export interface CorePromptAccepted {
  sessionId: string;
  runId: string;
  status: "running";
  /** The lead agent identity for this run, when the runtime exposes one. */
  agentId?: string;
}

/** A front-end-neutral Run status projection. */
export interface CoreRunView {
  sessionId: string;
  runId: string;
  status: "running" | "completed" | "cancelled" | "failed" | "timed_out";
  sequence: number;
  error?: string;
  startedAt: Date;
  updatedAt: Date;
}

/** One canonical event emitted by a Core-owned Run. */
export interface CoreRuntimeEvent {
  sessionId: string;
  runId: string;
  sequence: number;
  eventType: string;
  payload: Record<string, unknown>;
  terminal: boolean;
}

/** A prompt execution returned by a Core-owned session runtime. */
export interface CorePromptExecution {
  runId: string;
  agentId?: string;
  events?: AsyncIterable<CoreRuntimeEvent>;
}

/** A Core-owned session runtime dependency used by the host. */
export interface CoreSessionRuntime {
  readonly sessionId: string;
  prompt(input: CorePromptInput): Promise<CorePromptExecution>;
  cancelRun(runId: string): Promise<void>;
  close(): Promise<void>;
  setSkillActive?(input: { name: string; active: boolean }): Promise<void>;
  /** Projects the discovered skill index for this session. */
  listSkills?(): Promise<CoreSkillView[]>;
  /** Materializes one input resource before a run exists. */
  prepareInput?(input: CorePrepareInput): Promise<CorePreparedInput>;
  /** Projects the session's capability discovery metadata. */
  capabilityView?(): Promise<CoreCapabilityView>;
  /** Projects the session's rule/extra system-prompt context. */
  contextView?(): Promise<CoreSessionContextView>;
  /**
   * Updates the session's rule/extra system-prompt context; absent fields keep
   * their current value.
   */
  setContext?(input: {
    ruleContent?: string;
    extraContext?: string;
  }): Promise<void>;
  /** Projects the discoverable expert bundles for this session. */
  listExperts?(): Promise<CoreExpertSummaryView[]>;
  /** Resolves one expert bundle for display. */
  inspectExpert?(expertId: string): Promise<CoreExpertBundleView>;
  /** Projects the session's resolved expert binding. */
  expertState?(): Promise<CoreExpertStateView>;
  /** Binds or unbinds the session expert (empty id unbinds). */
  setExpert?(expertId: string): Promise<void>;
  /** Projects the managed agent registry (delegate/ESM sub-agents). */
  listAgents?(): Promise<CoreAgentView[]>;
  /** Destroys one managed agent and its children. */
  destroyAgent?(agentId: string): Promise<void>;
  /** Enables/disables the blocking delegate tool; returns the effective state. */
  setDelegate?(enabled: boolean): Promise<boolean>;
  /** Projects the blocking delegate tool state. */
  delegateState?(): Promise<boolean>;
  /** Enables/disables one named capability option (for example `browser`). */
  setCapability?(input: {
    id: string;
    enabled: boolean;
  }): Promise<CoreCapabilityView>;
  /** Applies capability changes mirrored through `session.config.set`. */
  setCapabilities?(capabilities: Record<string, boolean>): void;
  /**
   * Projects the persisted session identity (work directory and persisted
   * mode) so the host session view reflects one canonical binding. Calling it
   * also establishes the persisted session identity for a fresh session.
   */
  persistedSummary?(): { workDir?: string; mode?: string };
  /** Projects the ESM supervisor state. */
  esmState?(): Promise<CoreEsmView>;
  /** Applies one ESM supervisor mutation and re-projects the state. */
  esmCommand?(
    input: Omit<CoreEsmCommandInput, "sessionId">,
  ): Promise<CoreEsmView>;
  /** Starts (or reports) the ESM continuation worker for this session. */
  esmContinue?(): Promise<CorePromptExecution & { started: boolean }>;
  /** Stops the running ESM continuation worker, if any. */
  esmStop?(): Promise<void>;
  /** Runs one transient side query over a read-only tool registry. */
  askTransient?(
    input: Omit<CoreTransientPromptInput, "sessionId">,
  ): Promise<CoreTransientPromptResult>;
  /** Runs one forced conversation compaction as a canonical event run. */
  compact?(): Promise<CorePromptExecution>;
  /**
   * Projects the session's durable conversation turns for a resume-time
   * reprint. Absent when the runtime has no persisted branch to replay.
   */
  transcriptMessages?(): CoreTranscriptMessage[];
}

/** Construction dependencies for the Core Runtime Host. */
export interface CoreRuntimeDependencies {
  createSessionRuntime(input: {
    sessionId: string;
    workDir: string;
    source: CoreRuntimeSource;
    providerName: string;
    modelID: string;
    mode?: string;
    thinkingLevel?: string;
    capabilities?: Record<string, boolean>;
    approvalPolicy?: string;
    questionPolicy?: string;
    settings: Settings;
    reverseRequest?: CoreReverseRequest;
  }): CoreSessionRuntime;
  openSessionRuntime?(input: {
    sessionId: string;
    workDir: string;
    source: CoreRuntimeSource;
    providerName: string;
    modelID: string;
    mode?: string;
    thinkingLevel?: string;
    capabilities?: Record<string, boolean>;
    approvalPolicy?: string;
    questionPolicy?: string;
    settings: Settings;
    reverseRequest?: CoreReverseRequest;
  }): CoreSessionRuntime;
  newId?: () => string;
  now?: () => Date;
}

export type CoreExtensionHandler = (
  method: string,
  params: CoreRpcParams,
  signal: AbortSignal,
) => Promise<unknown>;

/** Construction options for the shared Core Runtime Host. */
export interface CoreRuntimeHostOptions {
  source: CoreRuntimeSource;
  workDir: string;
  settings: Settings;
  providerName: string;
  modelID: string;
  dependencies: CoreRuntimeDependencies;
  extension?: CoreExtensionHandler;
  eventSink?: (event: CoreRuntimeEvent) => void;
  reverseRequest?: CoreReverseRequest;
  /**
   * Reports a failed orphan-recovery sweep. Convergence is retried on the next
   * tick, so a report is diagnostic only and never fails startup.
   */
  onRecoveryError?: (error: Error) => void;
}

/** The shared Core-owned runtime facade. */
export interface CoreRuntimeHost {
  createSession(input: CoreSessionCreateInput): Promise<CoreSessionView>;
  /**
   * Binds one persisted session as a resident Core session.
   *
   * `workDir` scopes the lookup to the directory the caller believes the
   * session belongs to, exactly like ACP's `session/load`. A session that does
   * not belong to that directory is rejected rather than adopted under it.
   */
  openSession(input: {
    sessionId: string;
    workDir?: string;
  }): Promise<CoreSessionView>;
  closeSession(input: { sessionId: string }): Promise<void>;
  /** Removes one persisted session (Core-owned session lifecycle). */
  deleteSession(input: { sessionId: string }): Promise<void>;
  history(input: { sessionId: string }): Promise<CoreRuntimeEvent[]>;
  /**
   * Projects the durable conversation of one session for resume-time reprint.
   * Unlike `history` (the live event log of the current process), this reads
   * the persisted branch, so it is non-empty after a Core restart.
   */
  transcript(input: { sessionId: string }): Promise<CoreTranscriptMessage[]>;
  prompt(input: CorePromptInput): Promise<CorePromptAccepted>;
  cancelRun(input: { sessionId: string; runId: string }): Promise<CoreRunView>;
  getRun(input: {
    sessionId: string;
    runId: string;
  }): Promise<CoreRunView | undefined>;
  listSessions(): Promise<CoreSessionView[]>;
  /** Lists the persisted sessions of one working directory. */
  listPersistedSessions(input: {
    workDir?: string;
  }): Promise<CoreSessionListEntry[]>;
  setSessionConfig(input: {
    sessionId: string;
    mode?: string;
    thinkingLevel?: string;
    providerName?: string;
    modelID?: string;
    capabilities?: Record<string, boolean>;
  }): Promise<CoreSessionView>;
  setSessionSkill?(input: {
    sessionId: string;
    name: string;
    active: boolean;
  }): Promise<Record<string, unknown>>;
  getSessionSkillState?(input: {
    sessionId: string;
  }): Promise<Record<string, unknown>>;
  /** Projects the discovered skill index of one session. */
  listSessionSkills(input: { sessionId: string }): Promise<CoreSkillView[]>;
  /** Materializes one input resource for a session before a run exists. */
  prepareInput(
    input: CorePrepareInput & { sessionId: string },
  ): Promise<CorePreparedInput>;
  /** Projects capability discovery metadata for one session. */
  sessionCapabilities(input: {
    sessionId: string;
  }): Promise<CoreCapabilityView>;
  /**
   * Reads one settings document. `"effective"` merges global and project
   * settings for the work directory; `"global"` returns only the fields
   * explicitly present in the global settings file (sparse editor round-trip).
   */
  settingsDocument(input: {
    scope?: "effective" | "global";
    workDir?: string;
  }): Promise<Settings>;
  /**
   * Applies one sparse settings patch (global or project scope) and returns
   * the refreshed effective document for the work directory.
   */
  updateSettingsDocument(input: {
    scope: "global" | "project";
    updates: Record<string, unknown>;
    workDir?: string;
  }): Promise<Settings>;
  /** Projects the built-in-plus-configured provider catalog. */
  providerCatalog(input: {
    workDir?: string;
  }): Promise<CoreProviderCatalogView[]>;
  /** Validates one provider/model pair; rejects with the raw cause. */
  validateProviderModel(input: {
    providerID: string;
    modelID: string;
    workDir?: string;
  }): Promise<void>;
  /** Reads the global environment-variable document. */
  envDocument(): Promise<Record<string, string>>;
  /** Replaces the global environment-variable document. */
  updateEnvDocument(input: {
    vars: Record<string, string>;
  }): Promise<Record<string, string>>;
  /** Projects one session's rule/extra system-prompt context. */
  sessionContext(input: { sessionId: string }): Promise<CoreSessionContextView>;
  /** Updates one session's rule/extra system-prompt context. */
  setSessionContext(input: {
    sessionId: string;
    ruleContent?: string;
    extraContext?: string;
  }): Promise<CoreSessionContextView>;
  /** Projects the discoverable expert bundles of one session. */
  listExperts(input: { sessionId: string }): Promise<CoreExpertSummaryView[]>;
  /** Resolves one expert bundle for display. */
  inspectExpert(input: {
    sessionId: string;
    expertId: string;
  }): Promise<CoreExpertBundleView>;
  /** Projects one session's resolved expert binding. */
  expertState(input: { sessionId: string }): Promise<CoreExpertStateView>;
  /** Binds or unbinds one session's expert (empty id unbinds). */
  setExpert(input: {
    sessionId: string;
    expertId: string;
  }): Promise<CoreExpertStateView>;
  /**
   * Forks one session's history into a child branch. A non-null `expertId`
   * applies the expert binding only to the child (empty string unbinds it).
   */
  forkSession(input: {
    sessionId: string;
    expertId?: string;
    titleMode?: string;
  }): Promise<CoreSessionView>;
  /** Projects the managed agent registry of one session. */
  listAgents(input: { sessionId: string }): Promise<CoreAgentView[]>;
  /** Destroys one managed agent and its children. */
  destroyAgent(input: { sessionId: string; agentId: string }): Promise<void>;
  /** Enables/disables the blocking delegate tool of one session. */
  setDelegate(input: {
    sessionId: string;
    enabled: boolean;
  }): Promise<{ enabled: boolean }>;
  /** Projects the blocking delegate tool state of one session. */
  delegateState(input: { sessionId: string }): Promise<{ enabled: boolean }>;
  /** Enables/disables one named capability option of one session. */
  setSessionCapability(input: {
    sessionId: string;
    id: string;
    enabled: boolean;
  }): Promise<CoreCapabilityView>;
  /** Projects the ESM supervisor state of one session. */
  esmState(input: { sessionId: string }): Promise<CoreEsmView>;
  /** Applies one ESM supervisor mutation and re-projects the state. */
  esmUpdate(input: CoreEsmCommandInput): Promise<CoreEsmView>;
  /** Starts (or reports) the ESM continuation worker of one session. */
  esmContinue(input: { sessionId: string }): Promise<CoreEsmContinuation>;
  /** Stops the running ESM continuation worker of one session. */
  esmStop(input: { sessionId: string }): Promise<void>;
  /** Runs one transient side query over a read-only tool registry. */
  transientPrompt(
    input: CoreTransientPromptInput,
  ): Promise<CoreTransientPromptResult>;
  /** Runs one forced conversation compaction as a canonical event run. */
  compact(input: { sessionId: string }): Promise<CoreCompactAccepted>;
  subscribeRunEvents(
    sessionId: string,
    runId: string,
    cursor?: number,
  ): AsyncIterableIterator<CoreRuntimeEvent>;
  close(): Promise<void>;
  extension?: CoreExtensionHandler;
}
