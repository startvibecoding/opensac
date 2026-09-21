// Ported from internal/serve/channels/dispatcher.go — the messaging channel
// dispatcher core: construction, config/settings application, the per-user
// session registry and its leases, the tool catalog, session stop/rotate
// admission, child-terminal forwarding, and the observer plumbing.
//
// The message-delivery path (HandleMessage/HandleDelivery/resolveSession/
// buildAgent/runAgent/handleCommand/artifact materialization/A2A master tool)
// lives in delivery.ts; the watchdog, decision persistence, background
// recovery, and webhook handler live beside this module as functions that take
// the Dispatcher first (a TS class cannot be spread across the Go package's
// files, mirroring the openaiapi projection).
//
// Deviations: Go's sync.RWMutex critical sections are all synchronous, so the
// mutex pairs collapse (single-threaded event loop); the session mutex that Go
// holds across awaits maps to an async CountedMutex; context.WithCancel maps
// to an AbortController; Go's `sessions`/`agentSessions` maps map to Map; Go's
// `reflect.DeepEqual` maps to a structural deepEqual over the plain-data
// config objects.

import { dirname, join } from "@std/path";
import {
  type Event as AgentEvent,
  EventRunFinished,
  type ManagedAgentStatus,
  subAgentToolNames,
  TaskCanceled,
  TaskFailed,
  TaskIncomplete,
  TaskSuccess,
} from "../../agent/mod.ts";
import type { AgentManager } from "../../agent/manager.ts";
import type { AgentID } from "../../../sdk/agent/types.ts";
import type { AllowConfig, Settings } from "../../config/mod.ts";
import { getSessionDir, loadAllow } from "../../config/mod.ts";
import {
  ModeYolo,
  sourceFromChannelType,
  SourceUnknown,
} from "../../agentruntime/source.ts";
import {
  buildRegistry,
  closeMCPClients,
  type RegistryPolicy,
} from "../../agentruntime/registry.ts";
import type { Registry } from "../../tools/tool.ts";
import { newAgentManager } from "../../agentruntime/agent_manager.ts";
import {
  sandboxOptionsFromSettings,
  SessionRuntime,
} from "../../agentruntime/session_runtime.ts";
import type { DecisionService } from "../../agentruntime/decision.ts";
import {
  acquireSessionMutation,
  type ExecutionAdmissionOptions,
} from "../../agentruntime/execution_admission.ts";
import {
  requestSessionStop,
  SessionStopAccepted,
  type SessionStopOptions,
  SessionStopRecoveryStarted,
  SessionStopRemoteAccepted,
  type SessionStopResult,
} from "../../agentruntime/execution_stop.ts";
import type { ExecutionRuntime } from "../../agentruntime/execution.ts";
import type { Client } from "../../mcp/mod.ts";
import type { CronStore } from "../../cron/cron.ts";
import type { Scheduler } from "../../cron/scheduler.ts";
import {
  agentListConfigPath,
  projectAgentListConfigPath,
} from "../../a2a/master.ts";
import {
  Level,
  type Manager as SandboxManager,
  newManagerWithOptions,
} from "../../sandbox/sandbox.ts";
import { ESMStore, SteeringSource } from "../../esm/mod.ts";
import { create as createProvider } from "../../provider/factory/factory.ts";
import type { Message, Model, Provider } from "../../provider/mod.ts";
import {
  CountedMutex,
  findBinding,
  getChannelToolGeneration,
  type IdentityLocks,
  listChannelTools,
  newIdentityLocks,
} from "../../session/mod.ts";
import type {
  InboundMessage,
  PlatformAttachment,
} from "../../messaging/mod.ts";
import type {
  InputIngress,
  InputStream,
} from "../../agentruntime/input_materializer.ts";
import type { AttachmentKind } from "../../agentruntime/attachment.ts";
import type { Manager as SessionManager } from "../../session/manager.ts";
import { HookManager } from "../hooks.ts";
import type { Config, ConfigMethods } from "./config.ts";
import { defaultConfig, withConfigMethods } from "./config.ts";
import { Security } from "./security.ts";
import { channelSessionDir, sessionKey } from "./session_paths.ts";
import { channelSafeSubAgentEvent } from "./run_helpers.ts";
import { startWatchdog } from "./watchdog.ts";
import { truncateWithSuffix } from "../../util/truncate.ts";
import type {
  BackgroundRequest,
  BackgroundSubmitter,
} from "../runtime/background.ts";

export type { BackgroundRequest, BackgroundSubmitter };

/** ToolCatalogItem describes a tool that may be configured for channel sessions. */
export interface ToolCatalogItem {
  name: string;
  available: boolean;
  default: boolean;
  unavailableReason?: string;
}

/**
 * ChannelToolDefinition is the single runtime definition used by the catalog,
 * persisted-tool validator and session registry builder.
 */
export interface ChannelToolDefinition {
  name: string;
  default: boolean;
  available: boolean;
  unavailableReason: string;
}

export function isMultiAgentToolName(name: string): boolean {
  return name === "delegate_subagent" || name.startsWith("subagent_") ||
    name.startsWith("workflow_");
}

/**
 * esmSteeringMessages provides one channel Agent run with the same persisted,
 * version-aware objective steering used by the TUI and WebUI. It deliberately
 * has no scheduling side effects: channel delivery remains a projection of the
 * shared Runtime lifecycle. The returned closure is the bound `next` of one
 * SteeringSource so version tracking persists across calls.
 */
export function esmSteeringMessages(
  d: Dispatcher | null,
  sess: ChannelSession | null,
): (() => Message[]) | null {
  if (
    d === null || d === undefined || sess === null || sess === undefined ||
    sess.id === ""
  ) {
    return null;
  }
  let sessionDir = d.sessionDir;
  if (
    sessionDir === "" && sess.manager !== undefined && sess.manager !== null
  ) {
    sessionDir = sess.manager.getSessionDir();
  }
  if (sessionDir === "") {
    return null;
  }
  const source = new SteeringSource(new ESMStore(sessionDir), sess.id);
  return () => source.next();
}

export interface ChannelToolState {
  name: string;
  requestedEnabled: boolean;
  available: boolean;
  effectiveEnabled: boolean;
  registered: boolean;
  willRegister: boolean;
  unavailableReason?: string;
}

/** AgentApprovalHandler decides one interactive tool approval. */
export type AgentApprovalHandler = (
  toolCallID: string,
  toolName: string,
  args: Record<string, unknown>,
) => boolean;

/**
 * Dispatcher routes messages to per-user agent sessions. The constructor takes
 * partial init because Go builds struct literals for the same purpose in
 * fixtures and embedded hosts; `newDispatcher` is the full NewDispatcher path.
 */
export interface NewDispatcherArgs {
  cfg: Config;
  settings: Settings;
  version: string;
  cronStore: CronStore | null;
  scheduler: Scheduler | null;
}

/** ChannelSession holds state for a single channel user session. */
export class ChannelSession {
  // Runtime owns the front-end-neutral session resources. The fields below
  // remain transition aliases while Channel-specific tool policy migrates.
  runtime: SessionRuntime | null = null;
  execution: ExecutionRuntime | null = null;
  decisions: DecisionService | null = null;
  id = ""; // e.g. "channels/wechat/wxid_user1"
  platform = ""; // "wechat", "feishu", "ws"
  userID = "";
  workDir = "";
  manager: SessionManager | null = null;
  sandboxMgr: SandboxManager | null = null;
  registry: Registry | null = null;
  // AgentMgr is the session-scoped manager that owns this session's member
  // mailbox (and a bound team's roster). The dispatcher-wide manager stays as a
  // process-level fallback for tools that do not carry session member state.
  agentMgr: AgentManager | null = null;
  mcpClients: Client[] = []; // connected MCP clients (empty if none)
  mode = "";
  lastUsed = new Date();
  // Serializes requests within this session; held across awaits like Go's
  // session mutex.
  mu = new CountedMutex();
  // ForceCompact is a legacy/session flag consumed by the next agent run.
  // The /compact command now executes compaction immediately.
  forceCompact = false;
  // Run-state cluster (Go's runStateMu-guarded fields). Every access is
  // synchronous, so the dedicated mutex collapses.
  runID = "";
  runCancel: (() => void) | null = null;
  runAgent: import("../../agent/mod.ts").Agent | null = null;
  runStartedAt = new Date(NaN);
  lastEventAt = new Date(NaN);
  invalidated = false;
  generation = 0;
  pendingEntrants = 0;
  activeRuns = 0;

  /** lock acquires the session lock. */
  lock(): Promise<void> {
    return this.mu.lock();
  }

  /** unlock releases the session lock. */
  unlock(): void {
    this.mu.unlock();
  }

  /** touch updates the last-used timestamp. */
  touch(): void {
    this.lastUsed = new Date();
  }

  /** Go's zero time.Time maps to an unset (NaN) date. */
  hasRunStartedAt(): boolean {
    return !Number.isNaN(this.runStartedAt.getTime());
  }

  hasLastEventAt(): boolean {
    return !Number.isNaN(this.lastEventAt.getTime());
  }
}

/**
 * ChannelSessionLease keeps a resolved session alive while a message waits for
 * the shared runtime lock. This prevents refresh/invalidation from closing its
 * Registry or MCP clients underneath the waiting request.
 */
export class ChannelSessionLease {
  #d: Dispatcher;
  #key: string;
  #platform: string;
  #userID: string;
  #session: ChannelSession;
  #generation: number;
  #promoted = false;
  #released = false;

  constructor(
    d: Dispatcher,
    key: string,
    platform: string,
    userID: string,
    session: ChannelSession,
    generation: number,
  ) {
    this.#d = d;
    this.#key = key;
    this.#platform = platform;
    this.#userID = userID;
    this.#session = session;
    this.#generation = generation;
  }

  async promoteAfterRuntimeLock(): Promise<boolean> {
    if (this.#released) return false;
    if (
      this.#d.sessions.get(this.#key) !== this.#session ||
      this.#session.invalidated || this.#session.generation !== this.#generation
    ) {
      this.releaseLocked();
      return false;
    }

    if (
      (this.#platform === "wechat" || this.#platform === "feishu") &&
      this.#d.identityLocks !== null
    ) {
      const releaseIdentity = await this.#d.identityLocks.lock(
        this.#platform,
        this.#userID,
      );
      let bound;
      try {
        bound = findBinding(this.#d.sessionDir, this.#platform, this.#userID);
      } finally {
        releaseIdentity();
      }
      const headerID = this.#session.manager?.getHeader()?.id ?? "";
      if (bound === null || headerID === "" || bound.sessionId !== headerID) {
        this.releaseLocked();
        return false;
      }
    }

    if (
      this.#d.sessions.get(this.#key) !== this.#session ||
      this.#session.invalidated || this.#session.generation !== this.#generation
    ) {
      this.releaseLocked();
      return false;
    }
    if (this.#session.pendingEntrants > 0) this.#session.pendingEntrants--;
    this.#session.activeRuns++;
    this.#promoted = true;
    return true;
  }

  release(): void {
    if (this.#released) return;
    this.releaseLocked();
  }

  releaseLocked(): void {
    if (this.#released) return;
    if (this.#promoted && this.#session.activeRuns > 0) {
      this.#session.activeRuns--;
    } else if (!this.#promoted && this.#session.pendingEntrants > 0) {
      this.#session.pendingEntrants--;
    }
    this.#released = true;
    if (
      this.#session.invalidated && this.#session.pendingEntrants === 0 &&
      this.#session.activeRuns === 0 &&
      this.#d.sessions.get(this.#key) === this.#session
    ) {
      this.#d.closeAndDeleteLocked(this.#key, this.#session);
    }
  }
}

/** dispatcherRuntimeSnapshot is the immutable config view one run uses. */
export class DispatcherRuntimeSnapshot {
  cfg: (Config & ConfigMethods) | null;
  settings: Settings;
  provider: Provider | null;
  providerName: string;
  model: Model | null;
  allow: AllowConfig;
  security: Security;
  hooksMgr: HookManager;
  multiAgent: boolean;
  sandbox: boolean;
  browser: boolean;
  artifact: boolean;
  a2aMaster: boolean;
  cronStore: CronStore | null;
  scheduler: Scheduler | null;
  agentMgr: AgentManager | null;

  constructor(
    cfg: (Config & ConfigMethods) | null,
    settings: Settings,
    provider: Provider | null,
    providerName: string,
    model: Model | null,
    allow: AllowConfig,
    security: Security,
    hooksMgr: HookManager,
    multiAgent: boolean,
    sandbox: boolean,
    browser: boolean,
    artifact: boolean,
    a2aMaster: boolean,
    cronStore: CronStore | null,
    scheduler: Scheduler | null,
    agentMgr: AgentManager | null,
  ) {
    this.cfg = cfg;
    this.settings = settings;
    this.provider = provider;
    this.providerName = providerName;
    this.model = model;
    this.allow = allow;
    this.security = security;
    this.hooksMgr = hooksMgr;
    this.multiAgent = multiAgent;
    this.sandbox = sandbox;
    this.browser = browser;
    this.artifact = artifact;
    this.a2aMaster = a2aMaster;
    this.cronStore = cronStore;
    this.scheduler = scheduler;
    this.agentMgr = agentMgr;
  }
}

export class Dispatcher {
  cfg: (Config & ConfigMethods) | null = null;
  settings: Settings;
  allow: AllowConfig;
  version = "";
  sessionDir = "";
  security: Security;
  hooksMgr: HookManager;

  // Cached provider/model for creating agent instances
  provider: Provider | null = null;
  providerName = ""; // user-configured vendor name
  model: Model | null = null;

  // Multi-agent mode
  multiAgent = false;
  agentMgr: AgentManager | null = null;

  // Cron
  cronStore: CronStore | null = null;
  scheduler: Scheduler | null = null;

  // Sandbox mode
  sandbox = false;
  sandboxMgr: SandboxManager | null = null;
  browser = false;
  artifact = false;
  a2aMaster = false;

  // Active sessions: key = "<platform-channel>/<user_id>"
  sessions = new Map<string, ChannelSession>();
  // agentSessions maps a channel run's root agent ID to its channel session ID.
  // It lets the manager status listener route terminal child-agent events to
  // the right session observer even after the parent event stream has closed.
  agentSessions = new Map<string, string>();
  // Optional callback invoked when a channel sub-agent emits an event. It lets
  // the WebUI display channel-owned sub-agent progress without sharing runtime
  // ownership of the channel AgentManager.
  subAgentObserver: ((sessionID: string, ev: AgentEvent) => void) | null = null;
  questionObserver: ((sessionID: string, ev: AgentEvent) => void) | null = null;
  runObserver: ((sessionID: string) => void) | null = null;
  rotateHandler:
    | ((
      platform: string,
      userID: string,
      force: boolean,
    ) => Promise<void>)
    | null = null;
  backgroundSubmitter: BackgroundSubmitter | null = null;
  runRootSignal: AbortSignal | null = null;
  runRootStop: (() => void) | null = null;
  identityLocks: IdentityLocks | null = null;
  watchdogFired = new Set<string>();

  constructor(init: Partial<NewDispatcherArgs> = {}) {
    this.settings = init.settings ?? ({} as Settings);
    this.allow = loadAllow();
    this.security = new Security(init.cfg ?? defaultConfig());
    if (init.cfg !== undefined) {
      this.cfg = withConfigMethods(init.cfg);
      this.multiAgent = init.cfg.multiAgent;
      this.sandbox = init.cfg.sandbox;
      this.browser = init.cfg.browser;
      this.artifact = init.cfg.artifact;
      this.a2aMaster = init.cfg.a2aMaster;
    }
    this.hooksMgr = new HookManager(
      init.cfg?.hooks.preToolCall ?? "",
      init.cfg?.hooks.postToolCall ?? "",
    );
    this.version = init.version ?? "";
    if (init.settings !== undefined) {
      this.sessionDir = getSessionDir(init.settings);
    }
    this.cronStore = init.cronStore ?? null;
    this.scheduler = init.scheduler ?? null;
  }

  runtimeSnapshot(): DispatcherRuntimeSnapshot {
    return new DispatcherRuntimeSnapshot(
      this.cfg,
      this.settings,
      this.provider,
      this.providerName,
      this.model,
      this.allow,
      this.security,
      this.hooksMgr,
      this.multiAgent,
      this.sandbox,
      this.browser,
      this.artifact,
      this.a2aMaster,
      this.cronStore,
      this.scheduler,
      this.agentMgr,
    );
  }

  /** acquireSessionLease pins a resolved session while a request waits. */
  acquireSessionLease(
    key: string,
    platform: string,
    userID: string,
    sess: ChannelSession | null,
  ): ChannelSessionLease | null {
    if (sess === null || sess === undefined) return null;
    if (this.sessions.get(key) !== sess || sess.invalidated) return null;
    sess.pendingEntrants++;
    return new ChannelSessionLease(
      this,
      key,
      platform,
      userID,
      sess,
      sess.generation,
    );
  }

  // --- Agent manager -------------------------------------------------------

  /**
   * forwardChildTerminalStatus routes terminal child-agent lifecycle
   * transitions to the channel session observer. It is the delivery path of
   * last resort for children whose parent event stream already closed: the
   * stream-forwarded copy is dropped in that case, and the sink deduplicates
   * when both paths deliver.
   *
   * mgr is the manager that owns the child (the session-scoped manager for
   * channel runs). It is captured by the listener registration because the
   * dispatcher-wide manager does not track session children, and using the
   * wrong manager would both mis-resolve the root and drop the mapping while
   * children are still live.
   */
  forwardChildTerminalStatus(
    mgr: AgentManager | null,
    st: ManagedAgentStatus,
  ): void {
    if (!isTerminalChildState(st.state)) return;
    let root: AgentID = st.parentId;
    if (root === "") {
      // Top-level channel agents finishing is run bookkeeping, not sub-agent
      // activity.
      return;
    }
    if (mgr === null || mgr === undefined) {
      mgr = this.agentManager();
    }
    if (mgr !== null && mgr !== undefined) {
      for (let depth = 0; depth < 8; depth++) {
        const [parent, ok] = mgr.parent(root);
        if (!ok || parent === undefined) break;
        root = parent;
      }
    }
    const sessionID = this.agentSessions.get(root);
    if (sessionID === undefined || sessionID === "") return;
    const ev: AgentEvent = {
      agentId: st.id,
      type: EventRunFinished,
      status: TaskSuccess,
      statusMessage: st.result,
    };
    switch (st.state) {
      case "error":
        ev.status = TaskFailed;
        if (st.error !== "") {
          ev.error = new Error(st.error);
          console.error(
            `[channels] deferred sub-agent ${st.id} failed: ${st.error}`,
          );
        }
        break;
      case "incomplete":
        ev.status = TaskIncomplete;
        break;
      case "canceled":
        ev.status = TaskCanceled;
        if (st.error !== "") {
          ev.error = new Error(st.error);
          console.error(
            `[channels] deferred sub-agent ${st.id} cancelled: ${st.error}`,
          );
        }
        break;
    }
    this.notifySubAgentObserver(sessionID, channelSafeSubAgentEvent(ev));
    this.notifyRunObserver(sessionID);
    // Now that this child is terminal, the root's mapping can be released once
    // the root has finished and no other child is still live. Doing it here
    // (instead of only at run cleanup) is what lets a child that outlives its
    // parent stream be delivered and still have its mapping cleaned up.
    this.releaseAgentSession(mgr, root);
  }

  /**
   * releaseAgentSession drops the root-agent → session mapping once the root
   * has finished and no non-terminal child is left in mgr. Mappings must
   * survive the run while children are still active so their late terminal
   * events can be routed, so a still-running root or a live child keeps the
   * mapping.
   */
  releaseAgentSession(mgr: AgentManager | null, id: AgentID): void {
    if (mgr === null || mgr === undefined) {
      mgr = this.agentManager();
    }
    if (mgr !== null && mgr !== undefined) {
      // The root is removed from the manager when its run finishes, so a
      // present status means the run is still live and may still spawn more
      // children.
      const [st, running] = mgr.status(id);
      if (running && st !== undefined) return;
      for (const child of mgr.statusesList()) {
        if (child.parentId === id && !isTerminalChildState(child.state)) {
          return;
        }
      }
    }
    this.agentSessions.delete(id);
  }

  /** Returns the dispatcher agent manager used by sub-agents and cron. */
  agentManager(): AgentManager | null {
    return this.agentMgr;
  }

  /** Creates the dispatcher agent manager if it is not already available. */
  ensureAgentManager(): AgentManager | null {
    return this.ensureAgentManagerImpl();
  }

  private ensureAgentManagerImpl(): AgentManager | null {
    if (this.agentMgr !== null) return this.agentMgr;
    if (this.sandboxMgr !== null) {
      if (this.sandbox) {
        try {
          this.sandboxMgr.setLevel(Level.Standard);
        } catch {
          return null;
        }
        const fallback = this.sandboxMgr.fallbackError();
        if (fallback !== undefined) {
          console.error(
            `[channels] sandbox unavailable; using direct execution: ${fallback}`,
          );
        }
      } else {
        try {
          this.sandboxMgr.setLevel(Level.None);
        } catch {
          // ignore
        }
      }
    }
    const runtime = new SessionRuntime({
      source: SourceUnknown,
      entrySource: SourceUnknown,
      sandboxMgr: this.sandboxMgr ?? undefined,
    });
    let mgr: AgentManager;
    try {
      mgr = newAgentManager({
        runtime,
        provider: this.provider!,
        model: this.model!,
        settings: this.settings,
        providerName: this.providerName,
        allow: this.allow,
        multiAgentEnabled: true,
      });
    } catch (err) {
      console.error(`[channels] create agent manager: ${err}`);
      return null;
    }
    this.agentMgr = mgr;
    // The manager is the authoritative source of terminal child-agent states:
    // an asynchronously spawned child can outlive the parent event stream, and
    // events forwarded through that stream are dropped once it closes.
    this.agentMgr.addStatusListener((st) =>
      this.forwardChildTerminalStatus(this.agentMgr, st)
    );
    return this.agentMgr;
  }

  /**
   * selectedSubAgentTools returns the canonical sub-agent tools that this
   * session's tool selection actually registered. Re-registering the whole
   * canonical set must not resurrect a tool the user switched off, so the
   * caller re-applies this selection afterwards.
   */
  selectedSubAgentTools(reg: Registry | null): Map<string, boolean> {
    const selected = new Map<string, boolean>();
    if (reg === null || reg === undefined) return selected;
    for (const name of subAgentToolNames()) {
      if (reg.get(name).ok) selected.set(name, true);
    }
    return selected;
  }

  /**
   * newSessionAgentManager creates the session-scoped manager that owns this
   * session's member mailbox (and a bound team's roster). It intentionally
   * does not reuse the dispatcher-wide manager: the latter is shared across
   * sessions, predates the session's Runtime, and has no session mailbox, so a
   * member's question or completion would have no wake path (N8).
   */
  newSessionAgentManager(
    runtime: SessionRuntime | null,
    snapshot: DispatcherRuntimeSnapshot,
  ): AgentManager | null {
    if (
      runtime === null || runtime === undefined || snapshot.provider === null ||
      snapshot.model === null
    ) {
      return null;
    }
    let manager: AgentManager;
    try {
      manager = newAgentManager({
        runtime,
        provider: snapshot.provider,
        providerName: snapshot.providerName,
        model: snapshot.model,
        settings: snapshot.settings,
        allow: snapshot.allow,
        multiAgentEnabled: snapshot.multiAgent || runtime.teamExpertActive(),
      });
    } catch (err) {
      console.error(`[channels] create session agent manager: ${err}`);
      return null;
    }
    manager.addStatusListener((st) =>
      this.forwardChildTerminalStatus(manager, st)
    );
    return manager;
  }

  // --- Injection points ----------------------------------------------------

  /**
   * SetIdentityLocks injects the shared identity lock set used by serve
   * lifecycle management. It should be called before the first inbound
   * message.
   */
  setIdentityLocks(locks: IdentityLocks | null): void {
    if (locks === null || locks === undefined) return;
    this.identityLocks = locks;
  }

  /** SetCronStore updates the cron store used by new channel sessions. */
  setCronStore(store: CronStore | null): void {
    this.cronStore = store;
  }

  /** SetCronScheduler updates the scheduler used by cron tools for sessions. */
  setCronScheduler(s: Scheduler | null): void {
    this.scheduler = s;
  }

  /** SetSubAgentObserver installs a callback for sub-agent events emitted
   * during channel execution. The session ID identifies the channel-bound
   * WebUI session. */
  setSubAgentObserver(
    observer: ((sessionID: string, ev: AgentEvent) => void) | null,
  ): void {
    this.subAgentObserver = observer;
  }

  /** SubAgentObserverConfigured reports whether channel sub-agent events have
   * a sink. It is used by serve integration tests to verify runtime wiring. */
  subAgentObserverConfigured(): boolean {
    return this.subAgentObserver !== null;
  }

  /** SetQuestionObserver installs a callback for channel-owned interactive
   * questions. The callback is optional; without a protocol-level responder,
   * channel runs remain unattended and the dispatcher resolves the question
   * with an empty answer after notifying the observer. */
  setQuestionObserver(
    observer: ((sessionID: string, ev: AgentEvent) => void) | null,
  ): void {
    this.questionObserver = observer;
  }

  /** SetRunObserver installs a session-ID based callback so the WebUI can
   * reuse its canonical runtime snapshot and event broker. */
  setRunObserver(observer: ((sessionID: string) => void) | null): void {
    this.runObserver = observer;
  }

  /** SetBackgroundSubmitter routes channel messages to the serve-owned durable
   * Responses runtime when the configured provider enables background mode. */
  setBackgroundSubmitter(submitter: BackgroundSubmitter | null): void {
    this.backgroundSubmitter = submitter;
  }

  responsesBackgroundEnabled(): boolean {
    const p = this.provider as
      | { responsesBackgroundEnabled?: () => boolean }
      | null;
    if (p === null || p === undefined) return false;
    return typeof p.responsesBackgroundEnabled === "function" &&
      p.responsesBackgroundEnabled();
  }

  /** SetRotateHandler lets the serve runtime route channel /new and /clear
   * through the shared lifecycle coordinator. The bool argument requests a
   * forced rotation (cancel the active run, wait a grace period, then rotate
   * even if the run ignored cancellation). */
  setRotateHandler(
    handler:
      | ((platform: string, userID: string, force: boolean) => Promise<void>)
      | null,
  ): void {
    this.rotateHandler = handler;
  }

  platformWorkDir(platform: string): string {
    if (this.cfg === null) return "";
    return this.cfg.getPlatformWorkDir(platform);
  }

  notifyQuestionObserver(sessionID: string, ev: AgentEvent): void {
    if (sessionID === "") return;
    this.questionObserver?.(sessionID, ev);
  }

  notifyRunObserver(sessionID: string): void {
    if (sessionID === "") return;
    this.runObserver?.(sessionID);
  }

  notifySubAgentObserver(sessionID: string, ev: AgentEvent): void {
    if (sessionID === "" || ev.agentId === undefined || ev.agentId === "") {
      return;
    }
    this.subAgentObserver?.(sessionID, ev);
  }

  // --- Session registry ----------------------------------------------------

  /** Returns a session by key, or null if not found. */
  getSession(key: string): ChannelSession | null {
    return this.sessions.get(key) ?? null;
  }

  /** Returns all active sessions. */
  listSessions(): ChannelSession[] {
    return [...this.sessions.values()];
  }

  /** RefreshBinding invalidates the cached runtime route for a channel
   * identity. The next inbound message resolves the identity from the
   * canonical binding stored in the root sessions database. */
  refreshBinding(platform: string, userID: string): void {
    if (userID === "") return;
    this.removeSession(sessionKey(platform, userID));
  }

  /** RefreshSessionTools drops the cached channel session so its registry is
   * rebuilt from the latest persisted tool configuration on the next message. */
  refreshSessionTools(sessionID: string): void {
    if (sessionID === "") return;
    for (const [key, sess] of this.sessions) {
      if (
        sess.manager !== null && sess.manager !== undefined &&
        sess.manager.getHeader()?.id === sessionID
      ) {
        this.invalidateSessionLocked(key, sess);
        return;
      }
    }
  }

  /** RemoveSession removes a session from the pool. */
  removeSession(key: string): void {
    const sess = this.sessions.get(key);
    if (sess !== undefined) this.invalidateSessionLocked(key, sess);
  }

  invalidateSessionLocked(key: string, sess: ChannelSession | null): void {
    if (sess === null || sess === undefined) {
      this.sessions.delete(key);
      return;
    }
    const busy = sess.pendingEntrants > 0 || sess.activeRuns > 0;
    if (busy) {
      sess.invalidated = true;
      return;
    }
    this.closeAndDeleteLocked(key, sess);
  }

  closeAndDeleteLocked(key: string, sess: ChannelSession | null): void {
    if (sess === null || sess === undefined) {
      this.sessions.delete(key);
      return;
    }
    if (sess.runtime !== null && sess.runtime !== undefined) {
      sess.runtime.close();
      sess.mcpClients = []; // legacy alias is released by Runtime.
    } else if (sess.mcpClients.length > 0) {
      closeMCPClients(sess.mcpClients);
      sess.mcpClients = [];
    }
    for (const [agentID, mapped] of this.agentSessions) {
      if (mapped === sess.id) this.agentSessions.delete(agentID);
    }
    this.sessions.delete(key);
  }

  evictInvalidated(key: string, target: ChannelSession): void {
    const current = this.sessions.get(key);
    if (current !== target) return;
    this.closeAndDeleteLocked(key, target);
  }

  /** Close cancels all channel runs and releases idle session resources. */
  close(): void {
    this.runRootStop?.();
    for (const [key, sess] of this.sessions) {
      this.invalidateSessionLocked(key, sess);
    }
  }

  // --- Config / settings application --------------------------------------

  /** ApplyConfig updates runtime channel settings and drops cached sessions
   * so the next inbound message is built from the new configuration. */
  applyConfig(cfg: Config): void {
    if (cfg === null || cfg === undefined) {
      throw new Error("dispatcher config is required");
    }
    const wrapped = withConfigMethods(cfg);
    if (cfg.webSearch) {
      this.settings.webSearch = { ...this.settings.webSearch, enabled: true };
    }
    const providerName = wrapped.getDefaultProvider(
      this.settings.defaultProvider ?? "",
    );
    const modelID = wrapped.getDefaultModel(this.settings.defaultModel ?? "");
    let p = this.provider;
    let model = this.model;
    if (
      this.provider === null || this.providerName !== providerName ||
      this.model === null || this.model.id !== modelID
    ) {
      try {
        const created = createProvider(this.settings, providerName, modelID);
        p = created.provider;
        model = created.model;
      } catch (err) {
        throw new Error(`create provider: ${message(err)}`);
      }
    }

    const previousCfg = this.cfg;
    this.cfg = wrapped;
    this.provider = p;
    this.providerName = providerName;
    this.model = model;
    this.security = new Security(cfg);
    this.hooksMgr = new HookManager(
      cfg.hooks.preToolCall,
      cfg.hooks.postToolCall,
    );
    this.multiAgent = cfg.multiAgent;
    this.sandbox = cfg.sandbox;
    this.browser = cfg.browser;
    this.artifact = cfg.artifact;
    this.a2aMaster = cfg.a2aMaster;
    for (const [key, sess] of this.sessions) {
      if (shouldInvalidateSession(previousCfg, wrapped, key)) {
        this.invalidateSessionLocked(key, sess);
      }
    }
    if (!cfg.multiAgent && this.agentMgr !== null) {
      this.agentMgr = null;
    }
  }

  /** ApplySettings rebuilds the provider from settings.json so future channel
   * runs and sub-agents use the same runtime configuration as the WebUI. */
  applySettings(settings: Settings): void {
    if (settings === null || settings === undefined) {
      throw new Error("dispatcher settings are required");
    }
    const cfg = this.cfg;
    if (cfg === null) {
      throw new Error("dispatcher config is required");
    }
    const allow = this.allow;

    const runtimeSettings: Settings = { ...settings };
    if (cfg.webSearch) {
      runtimeSettings.webSearch = {
        ...runtimeSettings.webSearch,
        enabled: true,
      };
    }
    const providerName = cfg.getDefaultProvider(
      runtimeSettings.defaultProvider ?? "",
    );
    const modelID = cfg.getDefaultModel(runtimeSettings.defaultModel ?? "");
    let p: Provider;
    let model: Model;
    try {
      const created = createProvider(runtimeSettings, providerName, modelID);
      p = created.provider;
      model = created.model;
    } catch (err) {
      throw new Error(`create provider: ${message(err)}`);
    }

    this.settings = runtimeSettings;
    this.provider = p;
    this.providerName = providerName;
    this.model = model;
    const manager = this.agentMgr;
    for (const [key, sess] of this.sessions) {
      this.invalidateSessionLocked(key, sess);
    }

    manager?.updateRuntimeConfig(
      p,
      providerName,
      model,
      runtimeSettings,
      allow,
    );
  }

  // --- Stop / rotate -------------------------------------------------------

  /** RequestSessionStop projects the shared Runtime stop operation for channel
   * commands. Channel-local maps are notification state only and do not decide
   * ownership or whether a Run exists. */
  async requestSessionStop(
    signal: AbortSignal | undefined,
    sessionID: string,
  ): Promise<SessionStopResult> {
    if (sessionID === "") {
      throw new Error("session ID is required");
    }
    const options: SessionStopOptions = {
      legacyLocalCancel: this.legacyLocalCancelHook(sessionID),
    };
    const result = await requestSessionStop(
      signal,
      this.sessionDir,
      sessionID,
      options,
    );
    this.notifyRunObserver(sessionID);
    return result;
  }

  /** legacyLocalCancelHook is the only remaining bridge for channel fixtures
   * and older embedded integrations that kept a run solely in process memory.
   * The Runtime has already inspected the durable facts before invoking this
   * hook; a durable/external Run therefore cannot be cancelled through this
   * path. */
  legacyLocalCancelHook(sessionID: string): () => boolean {
    return () => {
      if (sessionID === "") return false;
      let target: ChannelSession | undefined;
      for (const sess of this.sessions.values()) {
        if (sess.id === sessionID) {
          target = sess;
          break;
        }
      }
      if (target === undefined) return false;
      const { runID, runCancel, runAgent } = target;
      if (runID === "" || runCancel === null) return false;
      runCancel();
      runAgent?.abort();
      return true;
    };
  }

  /** CancelChannelSessionRun is retained for compatibility with callers that
   * only need an accepted/not-accepted answer. */
  async cancelChannelSessionRun(sessionID: string): Promise<boolean> {
    let result: SessionStopResult;
    try {
      result = await this.requestSessionStop(undefined, sessionID);
    } catch {
      return false;
    }
    switch (result.code) {
      case SessionStopAccepted:
      case SessionStopRemoteAccepted:
      case SessionStopRecoveryStarted:
        return true;
      default:
        return false;
    }
  }

  /** AcquireRuntimeForRotate takes an explicit mutation lease for a rotation.
   * sessionDir is the lifecycle owner's authoritative session directory; an
   * empty value falls back to the dispatcher's configured directory. With
   * force it requests cancellation of a local channel run and waits a bounded
   * grace period. It never mutates an externally-owned Session without the
   * durable lease. */
  async acquireRuntimeForRotate(
    signal: AbortSignal | undefined,
    sessionDir: string,
    sessionID: string,
    force: boolean,
  ): Promise<() => void> {
    const dir = sessionDir.trim() !== "" ? sessionDir : this.sessionDir;
    try {
      const guard = await acquireSessionMutation(signal, dir, sessionID, {});
      return () => guard.release();
    } catch {
      if (!force) throw ErrSessionRunBusy;
      await this.cancelChannelSessionRun(sessionID);
      const released = await awaitRuntimeRelease(
        signal,
        dir,
        sessionID,
        RotateForceGraceMS,
      );
      if (released !== null) return released;
      throw ErrSessionRunBusy;
    }
  }

  // --- Tool catalog --------------------------------------------------------

  /** ToolCatalog returns the complete channel tool catalog. Startup options
   * determine each dynamic tool's default selection; every catalog item
   * remains selectable per session. */
  toolCatalog(platform: string): ToolCatalogItem[] {
    const definitions = this.channelToolDefinitions(platform);
    return definitions.map((definition) => ({
      name: definition.name,
      default: definition.default,
      available: definition.available,
      unavailableReason: definition.unavailableReason === ""
        ? undefined
        : definition.unavailableReason,
    }));
  }

  channelToolDefinitions(platform: string): ChannelToolDefinition[] {
    return this.channelToolDefinitionsLocked(platform);
  }

  channelToolDefinitionsLocked(platform: string): ChannelToolDefinition[] {
    let cfg = this.cfg;
    const browserEnabled = this.browser;
    const a2aEnabled = this.a2aMaster;
    const multiAgentEnabled = this.multiAgent;
    const cronAvailable = this.cronStore !== null;
    if (cfg === null) cfg = withConfigMethods(defaultConfig());
    const workDir = cfg.getPlatformWorkDir(platform);
    let reg: Registry;
    try {
      reg = buildRegistry(
        workDir,
        null,
        this.settings,
        {
          registerDefaults: true,
          browser: false,
        } satisfies RegistryPolicy,
      );
    } catch {
      return [];
    }
    const seen = new Set<string>();
    const result: ChannelToolDefinition[] = [];
    const add = (
      name: string,
      available: boolean,
      defaultEnabled: boolean,
      reason?: string,
    ) => {
      if (seen.has(name)) return;
      seen.add(name);
      const item: ChannelToolDefinition = {
        name,
        available,
        default: defaultEnabled,
        unavailableReason: !available && reason ? reason : "",
      };
      result.push(item);
    };
    for (const item of reg.all()) {
      add(item.name(), true, true);
    }
    // The browser runtime can be enabled on demand, so the browser tool stays
    // selectable regardless of the feature flag; browserEnabled only decides
    // the default checked state.
    add("browser", true, browserEnabled);
    add("memory", true, true);
    add("cron", cronAvailable, cronAvailable, "cron scheduler is disabled");
    const [a2aAvailable, a2aReason] = a2aToolAvailability(a2aEnabled);
    add("a2a_dispatch", a2aAvailable, a2aAvailable, a2aReason);
    // The multi-agent runtime (agent manager) is always available, so these
    // tools stay selectable regardless of the multiAgent flag. multiAgent only
    // decides the default checked state; the user can still enable/disable
    // them per session from the WebUI.
    add("delegate_subagent", true, multiAgentEnabled);
    // Every sub-agent tool is listed so the WebUI can project the same surface
    // the session registry actually registers (multiAgentEnabled only decides
    // the default checked state).
    for (const name of subAgentToolNames()) {
      add(name, true, multiAgentEnabled);
    }
    for (
      const name of [
        "workflow_lint",
        "workflow_run",
        "workflow_status",
        "workflow_cancel",
      ]
    ) {
      add(name, true, multiAgentEnabled);
    }
    return result;
  }

  /** SessionToolStates projects the catalog against the session's persisted
   * tool selections and the live registry. */
  sessionToolStates(
    sessionID: string,
    platform: string,
  ): { states: ChannelToolState[]; generation: number } {
    const catalog = this.toolCatalog(platform);
    const configured = listChannelTools(this.sessionDir, sessionID);
    const generation = getChannelToolGeneration(this.sessionDir, sessionID);
    const requested = new Map<string, boolean>();
    for (const item of configured) requested.set(item.toolName, item.enabled);
    const hasConfig = configured.length > 0;
    const registered = this.registeredTools(sessionID);
    const states: ChannelToolState[] = [];
    for (const item of catalog) {
      let value = requested.get(item.name);
      if (value === undefined) value = !hasConfig && item.default;
      const effective = value && item.available;
      const isRegistered = registered?.get(item.name) ?? false;
      states.push({
        name: item.name,
        requestedEnabled: value,
        available: item.available,
        effectiveEnabled: effective,
        registered: isRegistered,
        willRegister: effective,
        unavailableReason: item.unavailableReason === ""
          ? undefined
          : item.unavailableReason,
      });
    }
    return { states, generation };
  }

  registeredTools(sessionID: string): Map<string, boolean> | null {
    for (const sess of this.sessions.values()) {
      if (
        sess.id === sessionID && sess.registry !== null &&
        sess.registry !== undefined
      ) {
        const result = new Map<string, boolean>();
        for (const tool of sess.registry.all()) {
          result.set(tool.name(), true);
        }
        return result;
      }
    }
    return null;
  }

  // --- Misc helpers --------------------------------------------------------

  /** Returns the directory for a platform user's sessions. */
  channelSessionDir(platform: string, userID: string): string {
    return channelSessionDir(this.sessionDir, platform, userID);
  }

  /** archiveCorrupt renames a corrupt session file. */
  archiveCorrupt(path: string): void {
    const dir = dirname(path);
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const archived = join(dir, `${stamp}_corrupt.db`);
    try {
      Deno.renameSync(path, archived);
    } catch {
      // Go ignores the rename error too (best-effort).
    }
  }

  /** ResolveQuestion sends an answer to a currently running agent question. */
  resolveQuestion(questionID: string, answer: string): boolean {
    let found = false;
    for (const ag of activeAgents.values()) {
      ag.handleQuestionResponse(questionID, answer);
      found = true;
      break;
    }
    return found;
  }
}

/** channelRunSource returns the canonical run-event source label for a
 * channel session: the Runtime-resolved source first, then the platform
 * mapping, then the fail-safe "channel:<platform>" projection. */
export function channelRunSource(sess: ChannelSession | null): string {
  if (sess !== null && sess !== undefined && sess.runtime !== null) {
    try {
      const { resolution } = sess.runtime.resolvePolicy(
        sess.mode,
        "",
        ModeYolo,
      );
      if (resolution.source !== SourceUnknown) return resolution.source;
    } catch {
      // fall through to the platform mapping
    }
  }
  if (sess !== null && sess !== undefined) {
    const source = sourceFromChannelType(sess.platform);
    if (source !== SourceUnknown) return source;
    const platform = sess.platform.trim();
    if (platform !== "") return "channel:" + platform;
  }
  return SourceUnknown;
}

/**
 * channelAttachmentIngresses maps a platform message's opaque attachment
 * references onto the shared Runtime input contract. The transport-owned
 * `open` closure is carried unchanged; the channel dispatcher must not build
 * provider content from these references itself.
 */
export function channelAttachmentIngresses(
  msg: InboundMessage,
): InputIngress[] {
  const attachments = msg.attachments ?? [];
  const ingresses: InputIngress[] = [];
  for (let index = 0; index < attachments.length; index++) {
    const attachment: PlatformAttachment = attachments[index];
    const kind: AttachmentKind = attachment.kind;
    const eventID = msg.messageID !== "" ? msg.messageID : attachment.messageID;
    ingresses.push({
      origin: "channel:" + msg.platform,
      eventId: eventID,
      itemIndex: index,
      reference: attachment.reference,
      kind,
      filenameHint: attachment.filename,
      mediaTypeHint: attachment.mediaType,
      sizeHint: attachment.sizeHint,
      open: (signal: AbortSignal | undefined): Promise<InputStream> => {
        if (attachment.reference === "" || attachment.open === undefined) {
          return Promise.reject(
            new Error(
              "channel attachment is missing an authenticated platform reader",
            ),
          );
        }
        return attachment.open(signal ?? new AbortController().signal).then(
          (stream) => ({
            stream: stream.reader,
            filename: stream.filename,
            mediaType: stream.mediaType,
            contentSize: stream.contentSize,
          }),
        );
      },
    });
  }
  return ingresses;
}

// --- Construction -----------------------------------------------------------

/**
 * NewDispatcher creates a dispatcher with the given configuration.
 */
export function newDispatcher(
  args: NewDispatcherArgs,
): Dispatcher {
  const { cfg, settings, version, cronStore, scheduler } = args;
  const wrapped = withConfigMethods(cfg);
  if (cfg.webSearch) {
    settings.webSearch = { ...settings.webSearch, enabled: true };
  }
  const providerName = wrapped.getDefaultProvider(
    settings.defaultProvider ?? "",
  );
  const modelID = wrapped.getDefaultModel(settings.defaultModel ?? "");

  let p: Provider;
  let model: Model;
  try {
    const created = createProvider(settings, providerName, modelID);
    p = created.provider;
    model = created.model;
  } catch (err) {
    throw new Error(`create provider: ${message(err)}`);
  }

  const controller = new AbortController();
  const d = new Dispatcher({ cfg, settings, version, cronStore, scheduler });
  d.provider = p;
  d.providerName = providerName;
  d.model = model;
  d.security = new Security(wrapped);
  d.hooksMgr = new HookManager(cfg.hooks.preToolCall, cfg.hooks.postToolCall);
  d.multiAgent = cfg.multiAgent;
  d.sandbox = cfg.sandbox;
  d.sandboxMgr = newManagerWithOptions(
    wrapped.getWorkDir(),
    sandboxOptionsFromSettings(settings.sandbox),
  );
  d.browser = cfg.browser;
  d.artifact = cfg.artifact;
  d.a2aMaster = cfg.a2aMaster;
  d.runRootSignal = controller.signal;
  d.runRootStop = () => controller.abort();
  d.identityLocks = newIdentityLocks();

  if (cfg.multiAgent || cronStore !== null) {
    d.ensureAgentManager();
  }
  startWatchdog(d);

  return d;
}

// --- Config invalidation ----------------------------------------------------

/** shouldInvalidateSession reports whether a config change must drop the
 * cached session registered under `key`. */
export function shouldInvalidateSession(
  previous: (Config & ConfigMethods) | null,
  next: (Config & ConfigMethods) | null,
  key: string,
): boolean {
  if (previous === null || next === null) return true;
  const globalChanged = previous.workDir !== next.workDir ||
    previous.multiAgent !== next.multiAgent ||
    previous.sandbox !== next.sandbox ||
    previous.browser !== next.browser ||
    previous.artifact !== next.artifact ||
    previous.a2aMaster !== next.a2aMaster ||
    !deepEqual(previous.security, next.security) ||
    !deepEqual(previous.memory, next.memory) ||
    !deepEqual(previous.cron, next.cron) ||
    !deepEqual(previous.hooks, next.hooks) ||
    !deepEqual(previous.agent, next.agent);
  if (globalChanged) return true;
  if (key.startsWith("channels/wechat/")) {
    return !deepEqual(previous.wechat, next.wechat);
  }
  if (key.startsWith("channels/feishu/")) {
    return !deepEqual(previous.feishu, next.feishu);
  }
  return true;
}

/** Structural equality over the plain-data config objects Go compares with
 * reflect.DeepEqual. Undefined and missing keys compare equal. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object" || typeof b !== "object") return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ka = Object.keys(a).filter((k) =>
    (a as Record<string, unknown>)[k] !== undefined
  );
  const kb = Object.keys(b).filter((k) =>
    (b as Record<string, unknown>)[k] !== undefined
  );
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (
      !deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      )
    ) {
      return false;
    }
  }
  return true;
}

// --- Rotate admission -------------------------------------------------------

/** RotateForceGrace is the bounded wait for a forced rotation (10s in Go). */
export const RotateForceGraceMS = 10_000;

/**
 * ErrSessionRunBusy reports that a session runtime lock is held by an active
 * run. It is shared by the channel rotation paths so callers get a consistent
 * busy signal (and a consistent hint about /stop and /new force).
 */
export const ErrSessionRunBusy = new Error("session has an active run");

/**
 * AwaitRuntimeRelease waits for an explicit mutation lease until the grace
 * period elapses. Orphaned local runs are reconciled before it returns.
 * Returns the release function, or null when the lease stayed busy.
 */
export async function awaitRuntimeRelease(
  signal: AbortSignal | undefined,
  sessionDir: string,
  sessionID: string,
  graceMs: number,
): Promise<(() => void) | null> {
  const controller = new AbortController();
  const onOuter = () => controller.abort();
  if (signal !== undefined) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onOuter, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new TimeoutAbortReason()),
    graceMs,
  );
  try {
    const guard = await acquireSessionMutation(
      controller.signal,
      sessionDir,
      sessionID,
      {
        wait: true,
        pollIntervalMs: 200,
      } satisfies ExecutionAdmissionOptions,
    );
    return () => guard.release();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuter);
  }
}

/** TimeoutAbortReason marks a grace-period expiry (Go's DeadlineExceeded). */
export class TimeoutAbortReason extends Error {
  override name = "TimeoutError";
  constructor() {
    super("deadline exceeded");
  }
}

// --- A2A availability -------------------------------------------------------

// --- A2A availability -------------------------------------------------------

/** loadA2AAgentList prefers the project-level list over the global one.
 * Deviation: Go reads the file synchronously and the tool-catalog availability
 * check must stay synchronous, so this uses readTextFileSync. */
export function loadA2AAgentList() {
  let a2aListPath = projectAgentListConfigPath();
  try {
    Deno.statSync(a2aListPath);
  } catch {
    a2aListPath = agentListConfigPath();
  }
  let data: string;
  try {
    data = Deno.readTextFileSync(a2aListPath);
  } catch (err) {
    throw new Error(`read a2a-list.json: ${message(err)}`);
  }
  try {
    return JSON.parse(data);
  } catch (err) {
    throw new Error(`parse a2a-list.json: ${message(err)}`);
  }
}

/** a2aToolAvailability projects whether a2a_dispatch can run. */
export function a2aToolAvailability(
  enabled: boolean,
): [boolean, string] {
  if (!enabled) return [false, "A2A master is disabled"];
  try {
    loadA2AAgentList();
  } catch (err) {
    return [false, `A2A agent list is unavailable: ${message(err)}`];
  }
  return [true, ""];
}

// --- Question resolution ----------------------------------------------------

/** activeAgents tracks running agents by ID for question resolution. */
const activeAgents = new Map<string, import("../../agent/mod.ts").Agent>();

/** RegisterActiveAgent registers a running agent for question resolution. */
export function registerActiveAgent(
  id: string,
  a: import("../../agent/mod.ts").Agent,
): void {
  activeAgents.set(id, a);
}

/** UnregisterActiveAgent removes an agent from the registry. */
export function unregisterActiveAgent(id: string): void {
  activeAgents.delete(id);
}

/** truncate truncates a string with an ellipsis suffix. */
export function truncate(s: string, maxLen: number): string {
  return truncateWithSuffix(s, maxLen, "...");
}

// --- Shared helpers ---------------------------------------------------------

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** isTerminalChildState reports whether a managed-agent state is terminal. */
export function isTerminalChildState(state: string): boolean {
  return state === "done" || state === "incomplete" || state === "error" ||
    state === "canceled";
}
