// Ported from internal/serve/openaiapi/session_mgr.go — the session-core half:
// the `APISession` runtime record, the `SessionPool`, the shared error
// sentinels, and the pure transcript/projection helpers. The `Server`-bound
// methods of session_mgr.go (stop/capabilities/messages/plan projections) land
// with the server slice and keep calling into this module.
//
// Deviations: Go's `sync.Mutex`/`RWMutex` become an async `CountedMutex` for
// the request lock (it is held across `await` points) and are dropped for the
// short purely-synchronous critical sections (Deno is single-threaded);
// `context.Context` maps to `AbortSignal`; `time.Time` maps to `Date` (epoch 0
// stands in for Go's zero time where tests need an explicit "unset" value);
// unexported fields stay package-internal by convention because the Go
// package's files are split across TS modules in src/serve/openaiapi.
import type { Agent } from "../../agent/agent.ts";
import type { AgentManager } from "../../agent/manager.ts";
import {
  ExecutionRuntime,
  inspectSessionExecution,
  SessionExecutionIdle,
  SessionExecutionLocal,
  type SessionExecutionSnapshot,
  SessionExecutionUnknown,
} from "../../agentruntime/execution.ts";
import type { DecisionService } from "../../agentruntime/decision.ts";
import type { SessionRuntime } from "../../agentruntime/session_runtime.ts";
import { type Client as MCPClient, closeClients } from "../../mcp/mcp.ts";
import type {
  Attachment,
  ContentBlock,
  Message,
} from "../../provider/types.ts";
import type { Manager as SandboxManager } from "../../sandbox/mod.ts";
import type { SequencedMessage } from "../../session/replay.ts";
import {
  type SessionCapabilityEvent,
  type SessionRunEvent,
} from "../../session/session_events.ts";
import { Manager as SessionManager } from "../../session/manager.ts";
import type { Manager as SkillsManager } from "../../skills/skills.ts";
import type { Registry } from "../../tools/tool.ts";
import { truncateWithSuffix } from "../../util/truncate.ts";
import { CountedMutex } from "../../session/lock_registry.ts";
import type {
  SessionApprovalRequest,
  SessionCapabilityEventEntry,
  SessionQuestionRequest,
  SessionRunEventEntry,
} from "./types.ts";

/** pendingSessionApproval retains the protocol payload for one pending WebUI approval. */
export interface PendingSessionApproval {
  request: SessionApprovalRequest;
}

export interface PendingSessionQuestion {
  request: SessionQuestionRequest;
}

/** SessionApprovalResponse is a WebUI decision for one pending approval. */
export interface SessionApprovalResponse {
  action: string;
}

/**
 * ActiveSessionInfo is the management API view of an active API session.
 * Go's `*agentruntime.SessionExecutionSnapshot` execution pointer maps to the
 * canonical snapshot type.
 */
export interface ActiveSessionInfo {
  id: string;
  workDir: string;
  mode?: string;
  delegateMode?: boolean;
  workflows?: boolean;
  webSearch?: boolean;
  browser?: boolean;
  a2aMaster?: boolean;
  multiAgent?: boolean;
  active: boolean;
  running?: boolean;
  execution?: SessionExecutionSnapshot;
  lastUsed: Date;
  messageCount: number;
  preview?: string;
  title?: string;
  projectId?: string;
  pinned?: boolean;
  channelType?: string;
  channelId?: string;
  channelLabel?: string;
  bound?: boolean;
  parentSessionId?: string;
  forkBoundarySeq?: number;
  seedLength?: number;
  forkKind?: string;
}

/** SessionMessageEntry is a simplified message for the WebUI. */
export interface SessionMessageEntry {
  id?: string;
  seq?: number;
  role: string;
  content?: string;
  contents?: ContentBlock[];
  agentId?: string;
  memberId?: string;
  expertId?: string;
  memberDisplayName?: string;
  memberEmoji?: string;
  memberRole?: string;
  toolCallId?: string;
  toolName?: string;
  arguments?: unknown;
  invalidArguments?: string;
  plan?: SessionTaskPlan;
  isError?: boolean;
  summary?: string;
  hasDetail?: boolean;
  attachments?: Attachment[];
}

/** SessionToolResultDetail contains the full persisted result for one tool call. */
export interface SessionToolResultDetail {
  toolCallId: string;
  toolName?: string;
  content?: string;
  contents?: ContentBlock[];
  isError?: boolean;
}

/** SessionSubAgentInfo is the WebUI view of a managed sub-agent. */
export interface SessionSubAgentInfo {
  id: string;
  parentId?: string;
  memberId?: string;
  expertId?: string;
  memberDisplayName?: string;
  memberEmoji?: string;
  memberRole?: string;
  status: string;
  active: boolean;
  messageCount: number;
  lastResponse?: string;
  error?: string;
  startedAt?: string;
  updatedAt?: string;
}

/** SessionTaskPlan is the WebUI view of a plan tool call. */
export interface SessionTaskPlan {
  title?: string;
  steps?: SessionPlanStep[];
  note?: string;
}

/** SessionPlanStep is one todo item in a plan tool call. */
export interface SessionPlanStep {
  title: string;
  status: string;
}

/** Returned when a session ID matches multiple active workdirs. */
export const ErrActiveSessionIDAmbiguous = new Error(
  "active session ID is ambiguous",
);

/** Returned when a persisted tool result cannot be found. */
export const ErrSessionToolResultNotFound = new Error(
  "session tool result not found",
);

/** Returned when a session cannot be found in memory or persistence. */
export const ErrSessionNotFound = new Error("session not found");

/** Returned when a sub-agent cannot be found in an active session. */
export const ErrSubAgentNotFound = new Error("sub-agent not found");

/** Returned when a capability patch contains an invalid value. */
export const ErrInvalidCapability = new Error("invalid capability value");

/** Returned when the session pool is at capacity. */
export class PoolFullError extends Error {
  max: number;
  constructor(max: number) {
    super("session pool is at capacity");
    this.name = "PoolFullError";
    this.max = max;
  }
}

/** Fills the zero-value fields Go's composite literals leave unset. */
function executionSnapshot(
  overrides: Partial<SessionExecutionSnapshot>,
): SessionExecutionSnapshot {
  return {
    sessionId: "",
    sessionExists: false,
    state: SessionExecutionUnknown,
    phase: "",
    running: false,
    busy: false,
    canSubmit: false,
    canCancelLocal: false,
    canCancelRemote: false,
    leasePurpose: "",
    leaseEpoch: 0,
    leaseOwnerInstanceId: "",
    leaseOwnerPid: 0,
    leaseTokenIdentity: "",
    linkageState: "",
    recoveryAction: "",
    recoveryAttempt: 0,
    recoveryLastError: "",
    displayOwnerScope: "",
    remoteRunId: "",
    remoteProvider: "",
    remoteState: "",
    ...overrides,
  };
}

/**
 * APISession holds state for a single API session.
 *
 * Runtime owns the front-end-neutral session resources. The duplicated fields
 * below are temporary adapter aliases retained for API compatibility while
 * Channel, ACP and TUI migrate to agentruntime.SessionRuntime.
 */
export class APISession {
  runtime?: SessionRuntime;
  id = "";
  workDir = "";
  manager?: SessionManager;
  registry?: Registry;
  sandboxMgr?: SandboxManager;
  /** nil unless sub-agents/delegate/workflows enabled */
  agentMgr?: AgentManager;
  skillsMgr?: SkillsManager;
  activeSkills: Record<string, boolean> = {};
  extraContext = "";
  ruleContent = "";
  /** session-level mode override */
  mode = "";
  /** session-level transcript display mode */
  displayMode = "";
  /** session-level delegation mode */
  delegateMode = false;
  /** session-level workflow mode */
  workflows = false;
  /** session-level hosted web search toggle */
  webSearch = false;
  /** session-level browser tool toggle */
  browser = false;
  /** session-level A2A dispatch tool toggle */
  a2aMaster = false;
  /** session-level sub-agent tools toggle */
  multiAgent = false;
  mcpClients: MCPClient[] = [];
  lastUsed = new Date(0);
  /** serializes requests within this session (async: held across awaits) */
  mu = new CountedMutex();
  running = false;
  uses = 0;

  /** legacy/session flag consumed by the next agent run */
  forceCompact = false;

  execution?: ExecutionRuntime;
  decisions?: DecisionService;
  durableRuns: Set<string> = new Set();

  pendingApprovals = new Map<string, PendingSessionApproval>();
  pendingQuestions = new Map<string, PendingSessionQuestion>();
  activeRunId = "";
  activeRunStatus = "";
  activeRunAgent?: Agent;
  runCancel: (() => void) | null = null;

  /** Updates the last-used timestamp. */
  touch(): void {
    this.lastUsed = new Date();
  }

  lastUsedAt(): Date {
    return this.lastUsed;
  }

  pin(): void {
    this.uses++;
  }

  unpin(): void {
    if (this.uses > 0) this.uses--;
  }

  isInUse(): boolean {
    return this.uses > 0;
  }

  /** Records whether a chat run is currently active for this session. */
  setRunning(running: boolean): void {
    this.running = running;
  }

  /** Reports whether a chat run is currently active for this session. */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * inspectExecution is the compatibility boundary for callers that need a
   * session management projection. Durable state is always preferred; the
   * process-local fallback is used only by embedded fixtures that have no
   * shared session root yet.
   */
  inspectExecution(): SessionExecutionSnapshot {
    const sessionDir = this.manager ? this.manager.getSessionDir() : "";
    if (sessionDir.trim() !== "" && this.id !== "") {
      return inspectSessionExecution(sessionDir, this.id);
    }
    const execution = this.executionRuntime();
    if (execution) {
      const { runId, active } = execution.active();
      if (active) {
        return executionSnapshot({
          sessionId: this.id,
          sessionExists: true,
          state: SessionExecutionLocal,
          phase: "executing",
          running: true,
          busy: true,
          canSubmit: false,
          canCancelLocal: true,
          activeRun: {
            id: runId,
            status: String(execution.stateValue()),
            source: "",
            model: "",
            mode: "",
            startedAt: new Date(0),
            updatedAt: new Date(0),
          },
          linkageState: "legacy_unbound",
          recoveryAction: "none",
          displayOwnerScope: "local",
        });
      }
    }
    // Legacy embedded sessions may have only the old running bit. Keep that
    // conservative projection until they acquire a durable session root.
    if (this.running) {
      return executionSnapshot({
        sessionId: this.id,
        sessionExists: true,
        state: SessionExecutionUnknown,
        phase: "legacy",
        busy: true,
        displayOwnerScope: "unknown",
        linkageState: "legacy_unbound",
        recoveryAction: "none",
      });
    }
    return executionSnapshot({
      sessionId: this.id,
      sessionExists: this.id !== "",
      state: SessionExecutionIdle,
      phase: "idle",
      canSubmit: true,
      displayOwnerScope: "none",
      linkageState: "none",
      recoveryAction: "none",
    });
  }

  beginRun(runId: string): void {
    const execution = this.ensureExecution();
    // Go ignores the Begin error (`_, _ = execution.Begin(...)`); an already
    // active execution keeps its existing run.
    try {
      execution.begin(undefined, runId);
    } catch {
      // Go ignores the Begin error.
    }
    this.beginRunBookkeeping(runId);
  }

  /**
   * Lazily creates the session execution owner. Background tool progress can
   * arrive while the request that admitted the run has already returned, so
   * initialization must be idempotent (Go serialized it with executionMu).
   */
  ensureExecution(): ExecutionRuntime {
    if (!this.execution) {
      this.execution = new ExecutionRuntime();
    }
    // A foreground finalizer normally clears the adapter projection after a
    // successful terminal commit. If that commit outlives the request context,
    // Runtime-owned retry completion must perform the same cleanup
    // asynchronously.
    this.execution.setTerminalObserver((runId, _state) => {
      this.finishRun(runId);
      this.clearDurableRun(runId);
    });
    return this.execution;
  }

  executionRuntime(): ExecutionRuntime | undefined {
    return this.execution;
  }

  markDurableRun(runId: string): void {
    if (runId === "") return;
    this.durableRuns.add(runId);
  }

  isDurableRun(runId: string): boolean {
    if (runId === "") return false;
    return this.durableRuns.has(runId);
  }

  clearDurableRun(runId: string): void {
    if (runId === "") return;
    this.durableRuns.delete(runId);
  }

  beginRunBookkeeping(runId: string): void {
    this.activeRunId = runId;
    this.activeRunStatus = "running";
    this.activeRunAgent = undefined;
    this.runCancel = null;
    this.setRunning(true);
  }

  attachRunAgent(runId: string, a: Agent, cancel: () => void): boolean {
    if (this.activeRunId !== runId || this.activeRunStatus !== "running") {
      return false;
    }
    this.activeRunAgent = a;
    this.runCancel = cancel;
    const execution = this.executionRuntime();
    if (execution) execution.setAgent(a);
    return true;
  }

  markRunTerminalizing(runId: string): void {
    if (this.activeRunId === runId && this.activeRunStatus === "running") {
      this.activeRunStatus = "terminalizing";
    }
  }

  finishRun(runId: string): void {
    if (this.activeRunId === runId) {
      this.activeRunId = "";
      this.activeRunStatus = "";
      this.activeRunAgent = undefined;
      this.runCancel = null;
    }
    this.setRunning(false);
  }
}

/**
 * SessionPool manages multiple concurrent API sessions.
 *
 * Go's `List()` iterates the raw map keys, which are the composite
 * `workDir\x00id` pool keys — the port reproduces that quirk verbatim.
 */
export class SessionPool {
  #sessions = new Map<string, APISession>();
  #maxSess: number;
  #idleTTL: number; // milliseconds
  #stopped = false;
  #cleanupTimer: ReturnType<typeof setInterval> | undefined;
  #background = new Set<Promise<unknown>>();

  constructor(maxSessions: number, idleTimeoutMs: number) {
    this.#maxSess = maxSessions;
    this.#idleTTL = idleTimeoutMs;
    if (idleTimeoutMs > 0) {
      this.#cleanupTimer = setInterval(() => {
        this.evictIdle();
      }, 60_000);
    }
  }

  snapshot(): APISession[] {
    return [...this.#sessions.values()];
  }

  /**
   * Runs a short-lived pool-owned background task. Tracking these tasks keeps
   * best-effort work such as title generation from touching a test or server's
   * session database after Shutdown has returned.
   */
  go(fn: () => void | Promise<void>): boolean {
    if (this.#stopped) return false;
    const task = Promise.resolve().then(async () => {
      try {
        await fn();
      } finally {
        this.#background.delete(task);
      }
    });
    this.#background.add(task);
    return true;
  }

  /** Returns an existing session by ID, or undefined. */
  get(id: string): APISession | undefined {
    return this.getForWorkDir("", id);
  }

  /** Returns a session by workDir and ID, or undefined (nil on ambiguity). */
  getForWorkDir(workDir: string, id: string): APISession | undefined {
    if (workDir !== "") {
      return this.#sessions.get(sessionPoolKey(workDir, id));
    }
    let found: APISession | undefined;
    for (const sess of this.#sessions.values()) {
      if (sess.id !== id) continue;
      if (found) return undefined;
      found = sess;
    }
    return found;
  }

  /**
   * Keeps a session resident while a caller is about to use it. The pool lock
   * closes the gap between lookup and session locking, so idle eviction cannot
   * replace a live session with a second instance.
   */
  pin(s: APISession): boolean {
    if (this.#sessions.get(sessionPoolKey(s.workDir, s.id)) !== s) return false;
    s.pin();
    return true;
  }

  /** Releases a residency reference acquired by Pin. */
  unpin(s: APISession): void {
    s.unpin();
  }

  /** Adds a session to the pool. Throws PoolFullError at capacity. */
  put(s: APISession): void {
    const key = sessionPoolKey(s.workDir, s.id);
    if (this.#maxSess > 0 && this.#sessions.size >= this.#maxSess) {
      // Check if we have an existing entry (replace is OK)
      if (!this.#sessions.has(key)) {
        throw new PoolFullError(this.#maxSess);
      }
    }
    s.touch();
    this.#sessions.set(key, s);
  }

  /** Removes a session by ID. */
  remove(id: string): void {
    this.removeByWorkDir("", id);
  }

  /** Removes a session by workDir and ID. */
  removeByWorkDir(workDir: string, id: string): void {
    if (workDir !== "") {
      this.#sessions.delete(sessionPoolKey(workDir, id));
      return;
    }
    let key: string | undefined;
    let found = false;
    for (const [k, sess] of this.#sessions) {
      if (sess.id !== id) continue;
      if (found) return;
      key = k;
      found = true;
    }
    if (found && key !== undefined) this.#sessions.delete(key);
  }

  /** Swaps an existing session entry for a new one. */
  replace(oldId: string, s: APISession): void {
    this.replaceByWorkDir("", oldId, s);
  }

  /** Swaps an existing session entry for a new one. */
  replaceByWorkDir(workDir: string, oldId: string, s: APISession): void {
    if (oldId !== "") {
      if (workDir !== "") {
        this.#sessions.delete(sessionPoolKey(workDir, oldId));
      } else {
        for (const [k, sess] of this.#sessions) {
          if (sess.id === oldId) {
            this.#sessions.delete(k);
            break;
          }
        }
      }
    }
    if (s) {
      s.touch();
      let key = sessionPoolKey(s.workDir, s.id);
      if (
        !this.#sessions.has(key) && this.#maxSess > 0 &&
        this.#sessions.size >= this.#maxSess
      ) {
        for (const [k, sess] of this.#sessions) {
          if (sess.id === s.id && sess.workDir === s.workDir) {
            key = k;
            break;
          }
        }
      }
      this.#sessions.set(key, s);
    }
  }

  /** Returns the number of active sessions. */
  count(): number {
    return this.#sessions.size;
  }

  /** Returns all session pool keys (Go quirk: composite keys, not bare IDs). */
  list(): string[] {
    return [...this.#sessions.keys()];
  }

  /** Returns all session IDs for a specific workDir. */
  listForWorkDir(workDir: string): string[] {
    const ids: string[] = [];
    for (const sess of this.#sessions.values()) {
      if (sess.workDir === workDir) ids.push(sess.id);
    }
    return ids;
  }

  listDetails(): ActiveSessionInfo[] {
    const active = [...this.#sessions.values()];

    const sessions: ActiveSessionInfo[] = [];
    for (const s of active) {
      const lastUsed = s.lastUsedAt();
      const messageCount = s.manager ? s.manager.getMessages().length : 0;
      let execution: SessionExecutionSnapshot;
      try {
        execution = s.inspectExecution();
      } catch {
        execution = executionSnapshot({
          sessionId: s.id,
          state: SessionExecutionUnknown,
          busy: true,
          canSubmit: false,
        });
      }
      sessions.push({
        id: s.id,
        workDir: s.workDir,
        mode: s.mode,
        delegateMode: s.delegateMode,
        workflows: s.workflows,
        webSearch: s.webSearch,
        browser: s.browser,
        a2aMaster: s.a2aMaster,
        multiAgent: s.multiAgent,
        active: true,
        running: execution.running,
        execution,
        lastUsed,
        messageCount,
      });
    }
    sessions.sort((a, b) => {
      const at = a.lastUsed.getTime();
      const bt = b.lastUsed.getTime();
      if (at === bt) return a.id < b.id ? -1 : 1;
      return bt - at; // Go sorts LastUsed.After first (descending)
    });
    return sessions;
  }

  /**
   * Exact-ID lookup. Throws ErrActiveSessionIDAmbiguous when the ID matches
   * sessions in multiple workdirs; returns undefined when not found.
   */
  getExact(id: string): APISession | undefined {
    let found: APISession | undefined;
    for (const sess of this.#sessions.values()) {
      if (sess.id !== id) continue;
      if (found) throw ErrActiveSessionIDAmbiguous;
      found = sess;
    }
    return found;
  }

  /**
   * Stops eviction and closes every session through the shared SessionRuntime
   * boundary. The signal bounds agent cancellation and MCP cleanup; the pool
   * is emptied only after each runtime has been offered a chance to
   * terminalize its active run. Returns the first shutdown error, if any.
   */
  async shutdown(signal?: AbortSignal): Promise<Error | undefined> {
    if (!this.#stopped) {
      this.#stopped = true;
      if (this.#cleanupTimer !== undefined) clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = undefined;
    }
    await Promise.all([...this.#background]);
    const sessions = this.snapshot();
    let firstErr: Error | undefined;
    const closed = new Set<APISession>();
    for (const sess of sessions) {
      if (sess.runtime) {
        try {
          await sess.runtime.shutdown(signal);
          closed.add(sess);
          sess.mcpClients = [];
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!firstErr) {
            firstErr = new Error(`shutdown session ${sess.id}: ${message}`);
          }
        }
      } else {
        closeClients(sess.mcpClients);
        sess.mcpClients = [];
      }
    }
    for (const [key, sess] of this.#sessions) {
      if (closed.has(sess)) this.#sessions.delete(key);
    }
    return firstErr;
  }

  /**
   * Compatibility helper used by tests and embedders that do not have a
   * request context. Production server shutdown should call Shutdown.
   */
  stop(): Promise<void> {
    return this.shutdown(AbortSignal.timeout(1000)).then(() => {});
  }

  /** Periodically removes idle sessions. */
  async evictIdle(): Promise<void> {
    if (this.#idleTTL <= 0) return;
    const now = Date.now();
    const candidates: APISession[] = [];
    for (const s of this.#sessions.values()) {
      if (s.isInUse()) continue;
      candidates.push(s);
    }
    const evicted: APISession[] = [];
    // Inspect outside the pool lock; a durable external owner must keep the
    // session resident even when this process has no local runner.
    for (const s of candidates) {
      let execution: SessionExecutionSnapshot;
      try {
        execution = s.inspectExecution();
      } catch {
        continue;
      }
      if (execution.busy) continue;
      if (now - s.lastUsedAt().getTime() > this.#idleTTL) evicted.push(s);
    }
    for (const sess of evicted) {
      let shutdownOK = true;
      if (sess.runtime) {
        try {
          await sess.runtime.shutdown(AbortSignal.timeout(5000));
          sess.mcpClients = [];
        } catch {
          shutdownOK = false;
        }
      } else {
        closeClients(sess.mcpClients);
        sess.mcpClients = [];
      }
      if (shutdownOK) {
        for (const [key, current] of this.#sessions) {
          if (current === sess) this.#sessions.delete(key);
        }
      }
    }
  }
}

export function sessionPoolKey(workDir: string, id: string): string {
  return workDir + "\x00" + id;
}

export function formatEventTimestamp(ts: Date | null | undefined): string {
  if (!ts || Number.isNaN(ts.getTime()) || ts.getTime() === 0) return "";
  return ts.toISOString();
}

/** Go decoded a raw JSON object; the port carries decoded values. */
export function decodeEventData(
  data: unknown,
): Record<string, unknown> | undefined {
  if (data === null || data === undefined) return undefined;
  let value = data;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (
    typeof value !== "object" || Array.isArray(value) || value === null
  ) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 0 ? undefined : record;
}

export function sessionRunEventToEntry(
  ev: SessionRunEvent,
  seq: number,
): SessionRunEventEntry {
  return {
    seq,
    id: ev.id,
    sessionId: ev.sessionId,
    runId: ev.runId,
    eventType: ev.eventType,
    source: ev.source,
    status: ev.status,
    model: ev.model,
    mode: ev.mode,
    timestamp: formatEventTimestamp(ev.timestamp),
    data: decodeEventData(ev.data),
  };
}

export function sessionCapabilityEventToEntry(
  ev: SessionCapabilityEvent,
  seq: number,
): SessionCapabilityEventEntry {
  return {
    seq,
    id: ev.id,
    sessionId: ev.sessionId,
    runId: ev.runId,
    eventType: ev.eventType,
    source: ev.source,
    actor: ev.actor,
    capability: ev.capability,
    oldValue: ev.oldValue,
    newValue: ev.newValue,
    timestamp: formatEventTimestamp(ev.timestamp),
    data: decodeEventData(ev.data),
  };
}

export function sessionMessagesToEntries(
  msgs: Message[],
): SessionMessageEntry[] {
  const entries: SessionMessageEntry[] = [];
  for (const m of msgs) {
    entries.push(...providerMessageToSessionEntries(m, 0, ""));
  }
  return entries;
}

export function sequencedMessagesToEntries(
  msgs: SequencedMessage[],
): SessionMessageEntry[] {
  const entries: SessionMessageEntry[] = [];
  for (const item of msgs) {
    entries.push(
      ...providerMessageToSessionEntries(item.message, item.seq, item.entryID),
    );
  }
  return entries;
}

export function providerMessageToSessionEntries(
  m: Message,
  seq: number,
  entryId: string,
): SessionMessageEntry[] {
  const entries: SessionMessageEntry[] = [];
  if (m.systemInjected) return entries;
  const entryIdFor = (suffix: string): string => {
    if (entryId === "") return "";
    if (suffix === "") return entryId;
    return entryId + ":" + suffix;
  };
  const withCursor = (
    entry: SessionMessageEntry,
    suffix: string,
  ): SessionMessageEntry => {
    entry.id = entryIdFor(suffix);
    entry.seq = seq;
    return entry;
  };
  switch (m.role) {
    case "user": {
      const content = messageText(m);
      const entry: SessionMessageEntry = { role: m.role, content };
      if (m.contents && m.contents.length > 0) {
        entry.contents = cloneContentBlocks(m.contents);
      }
      entries.push(withCursor(entry, ""));
      break;
    }
    case "assistant": {
      const content = messageText(m);
      const hasThinking = (m.contents ?? []).some(
        (block) => block.type === "thinking" && block.thinking !== "",
      );
      if (content !== "" || (m.attachments?.length ?? 0) > 0 || hasThinking) {
        entries.push(
          withCursor(
            {
              role: m.role,
              content,
              contents: m.contents ? cloneContentBlocks(m.contents) : undefined,
              attachments: m.attachments ? [...m.attachments] : undefined,
            },
            "assistant",
          ),
        );
      }
      (m.contents ?? []).forEach((block, idx) => {
        if (!block.toolCall) return;
        let suffix = `tool:${idx}`;
        if (block.toolCall.id !== "") suffix = "tool:" + block.toolCall.id;
        entries.push(
          withCursor(
            {
              role: "toolCall",
              toolCallId: block.toolCall.id,
              toolName: block.toolCall.name,
              arguments: validRawMessage(block.toolCall.arguments),
              invalidArguments: block.toolCall.invalidArguments,
              plan: planFromToolCall(
                block.toolCall.name,
                block.toolCall.arguments,
              ),
            },
            suffix,
          ),
        );
      });
      break;
    }
    case "toolResult": {
      let suffix = "toolResult";
      if (m.toolCallId) suffix += ":" + m.toolCallId;
      entries.push(
        withCursor(
          {
            role: "toolResult",
            toolCallId: m.toolCallId,
            toolName: m.toolName,
            isError: m.isError,
            summary: summarizeToolResult(m),
            hasDetail: true,
          },
          suffix,
        ),
      );
      break;
    }
  }
  return entries;
}

export function messageText(msg: Message): string {
  if (msg.content) return msg.content;
  let content = "";
  for (const b of msg.contents ?? []) {
    if (b.type === "text" && b.text) content += b.text;
  }
  return content;
}

export function toolResultText(msg: Message): string {
  const text = messageText(msg);
  if (text !== "") return text;
  if ((msg.contents?.length ?? 0) > 0) return "(rich tool result)";
  return "";
}

export function summarizeToolResult(msg: Message): string {
  let text = toolResultText(msg).trim();
  if (text === "") text = "(empty result)";
  text = text.replaceAll("\r\n", "\n");
  const idx = text.indexOf("\n");
  if (idx >= 0) text = text.slice(0, idx);
  return truncateWithSuffix(text, 140, "...");
}

export function planFromToolCall(
  toolName: string,
  args: unknown,
): SessionTaskPlan | undefined {
  if (toolName !== "plan" || args === null || args === undefined) {
    return undefined;
  }
  if (typeof args !== "object") return undefined;
  const raw = args as {
    title?: unknown;
    steps?: unknown;
    note?: unknown;
  };
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) return undefined;
  const plan: SessionTaskPlan = {
    title: typeof raw.title === "string" ? raw.title.trim() : "",
    note: typeof raw.note === "string" ? raw.note.trim() : "",
    steps: [],
  };
  for (const step of raw.steps) {
    if (typeof step !== "object" || step === null) continue;
    const record = step as { title?: unknown; status?: unknown };
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (title === "") continue;
    let status = normalizeSessionPlanStatus(
      typeof record.status === "string" ? record.status : "",
    );
    if (status === "") status = "pending";
    plan.steps!.push({ title, status });
  }
  if (plan.steps!.length === 0) return undefined;
  return plan;
}

export function normalizeSessionPlanStatus(status: string): string {
  const normalized = status.trim().toLowerCase();
  switch (normalized) {
    case "pending":
    case "running":
    case "done":
    case "failed":
      return normalized;
    default:
      return "";
  }
}

/** Go validated raw JSON bytes; decoded values are valid by construction. */
export function validRawMessage(raw: unknown): unknown {
  if (raw === null || raw === undefined) return undefined;
  return raw;
}

export function cloneContentBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map((block) => {
    const cloned = { ...block };
    if (block.image) cloned.image = { ...block.image };
    if (block.toolCall) cloned.toolCall = { ...block.toolCall };
    if (block.cache_control) cloned.cache_control = { ...block.cache_control };
    return cloned;
  });
}

export function channelLabel(channelType: string, _channelId: string): string {
  switch (channelType) {
    case "wechat":
      return "WeChat";
    case "feishu":
      return "Feishu";
    default:
      return "Local";
  }
}
