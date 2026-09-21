// Ported from internal/serve/openaiapi/server.go (the Server struct and its
// handler-independent helpers) plus the Server-bound halves of
// session_stream.go (the lazy hub/broker accessors) and session_mgr.go
// (findSessionWorkDir). The run-options assembly and buildWorkDirContext live
// in lifecycle.ts, and the HTTP route table lives in routes.ts; the top-level
// Run() lifecycle wiring lands after the run-manager/ESM/background-driver
// slices it assembles.
//
// Deviations: Go's sync.RWMutex is dropped for short synchronous critical
// sections (Deno is single-threaded); the async CountedMutex stands in for
// the mutexes that are held across awaits (session creation, external sync);
// fields whose owning modules have not been ported yet (RunManager,
// RecoveryCoordinator, the Responses background driver, the ESM coordinator,
// the external sub-agent history, the run-slots semaphore) are added by their
// slices rather than stubbed here; ApplySettings is async because
// buildWorkDirContext awaits the workflow skill write, and its provider
// failure is thrown as `create provider: ...` like Go's wrapped error.
import { type AllowConfig, loadAllow } from "../../config/allow.ts";
import {
  getSessionDir,
  type Settings,
  type SkillHubSettings,
} from "../../config/settings.ts";
import { isWebSearchEnabled } from "../../config/mod.ts";
import { CountedMutex } from "../../session/lock_registry.ts";
import { openByIDExact } from "../../session/manager.ts";
import { create } from "../../provider/factory/factory.ts";
import { Provider as OpenAIProvider } from "../../provider/openai/provider.ts";
import { Level, newManagerWithOptions } from "../../sandbox/sandbox.ts";
import { sandboxOptionsFromSettings } from "../../agentruntime/session_runtime.ts";
import type { Model } from "../../provider/types.ts";
import type { Provider } from "../../provider/provider.ts";
import type { Manager as SandboxManager } from "../../sandbox/mod.ts";
import type { Manager as SkillsManager } from "../../skills/skills.ts";
import type { CronStore } from "../../cron/cron.ts";
import type { Scheduler } from "../../cron/scheduler.ts";
import { EventBroker } from "./event_broker.ts";
import {
  type AuthConfig as RouteAuthConfig,
  cloneConfig,
  type Config,
  getWorkDir,
} from "./config.ts";
import type { APISession, SessionPool } from "./session_mgr.ts";
import type { RunManager } from "./run_manager.ts";
import type { CommandResult } from "./commands.ts";
import type { ExecuteResponsesBackgroundRunFn } from "./background_run_coordinator.ts";
import type { SubmitExternalResponsesBackgroundFn } from "./chat_background.ts";
import type { BackgroundRunDriver } from "../runtime/background.ts";
import type { ExternalSubAgentHistory } from "./external_subagents.ts";
import type { ESMCoordinator } from "./esm_coordinator.ts";
import type { RecoveryCoordinator } from "../../agentruntime/recovery_coordinator.ts";
import { buildWorkDirContext } from "./lifecycle.ts";
import {
  newSessionStreamHub,
  type SessionStreamCursor,
  type SessionStreamHub,
} from "./session_stream.ts";

/**
 * Server is the OpenAI-compatible API HTTP server. The handler methods bind
 * to this record as they are ported.
 */
export class Server {
  cfg?: Config;
  settings: Settings | null;
  allow?: AllowConfig;
  saveProjectAllow?: (allow: AllowConfig) => Promise<void> | void;
  version = "";

  /**
   * responsesRuns is the Responses background-run driver (Go's
   * `s.responsesRuns`, a serviceruntime.BackgroundRunDriver). The concrete run
   * manager is installed by applySettings for openai-responses providers.
   */
  responsesRuns?: BackgroundRunDriver;
  /** Go's `s.runManager`: in-memory run fan-out over canonical durable rows. */
  runManager?: RunManager;
  /**
   * Go's `s.runSlots`: the MaxConcurrentReqs semaphore. The serve assembly
   * slice fills it; the chat handler skips the limiter while unset.
   */
  runSlots?: RunSlotLimiter;
  /**
   * Go's `s.SubmitExternalResponsesBackground`: the background-run coordinator
   * hook consumed by the chat-completions x_background branch. The concrete
   * coordinator is owned by the background-run slice.
   */
  submitExternalResponsesBackground?: SubmitExternalResponsesBackgroundFn;
  /**
   * Go's `s.handleCommand` (commands.go). The command cluster is bound by
   * commands.ts's `handleCommandFn`; while the hook is unset the submit path
   * skips slash-command handling.
   */
  handleCommand?: (
    sess: APISession,
    input: string,
    ...runIds: string[]
  ) => Promise<CommandResult | null>;
  /**
   * Go's `s.startESM` (esm_coordinator.go). The ESM coordinator slice fills
   * the hook; while it is unset the ESM state transitions persist and publish
   * without starting a continuation.
   */
  startESM?: (sessionId: string) => void;
  /**
   * Go's `s.stopESMForControl` (esm_coordinator.go): the explicit cancellation
   * boundary used by pause and clear. Awaited by the ESM control operations.
   */
  stopESMForControl?: (sessionId: string) => Promise<void> | void;
  /**
   * Go's `s.esmCoordinatorRunning` (esm_coordinator.go): reports whether the
   * local ESM continuation for a session is owned by this process.
   */
  esmCoordinatorRunning?: (sessionId: string) => boolean;
  /**
   * Go's `s.esmCoordinator` (esm_coordinator.go): the per-session WebUI ESM
   * continuation workers. Lazily created by ensureESMCoordinator.
   */
  esmCoordinator?: ESMCoordinator;
  /**
   * Go's `s.SetSessionExpert` (expert_api.go). The identity-transition slice
   * fills the hook; while it is unset the submit path skips expert binding.
   * Busy mutations are reported with an error whose name is
   * `ErrSessionExpertMutationBusy`.
   */
  setSessionExpert?: (
    signal: AbortSignal | undefined,
    sessionId: string,
    expertId: string,
  ) => Promise<unknown>;
  /**
   * Go's `s.executeResponsesBackgroundRun` (background_run_coordinator.go).
   * The background-run slice fills the hook; the submit path only dispatches
   * through it when the Responses background capability is available.
   */
  executeResponsesBackgroundRun?: ExecuteResponsesBackgroundRunFn;
  /**
   * Go's `s.recoveryCoordinator`: the Runtime-owned orphaned-run convergence
   * loop started by the serve assembly slice (run() in lifecycle.ts).
   */
  recoveryCoordinator?: RecoveryCoordinator;
  provider?: Provider;
  /** user-configured vendor name (e.g. "longcat") */
  providerName = "";
  providerOverride = "";
  modelOverride = "";
  model?: Model;
  sandboxMgr?: SandboxManager;
  skillsMgr?: SkillsManager;
  pool?: SessionPool;
  streamHub?: SessionStreamHub; // deprecated; use eventBroker for new code
  eventBroker?: EventBroker;
  /**
   * Go's `s.externalSubAgents`: per-session channel-owned sub-agent history
   * (guarded in Go by `externalSubAgentMu`). Lazily created by
   * externalSubAgentHistoryFor.
   */
  externalSubAgents?: Map<string, ExternalSubAgentHistory>;
  cronStore?: CronStore;
  cronScheduler?: Scheduler;
  runComplete?: (
    sessionId: string,
    runId: string,
    status: string,
    errMsg: string,
  ) => void;

  extraContext = "";
  /** key: workDir, used by the standard chat endpoint's internal session reuse */
  defaultSessionIDs = new Map<string, string>();
  /** server-issued IDs awaiting first WebUI run */
  allocatedSessionIDs = new Map<string, Date>();
  sessionCreateMu = new CountedMutex();
  externalSyncMu = new CountedMutex();
  externalCursors = new Map<string, SessionStreamCursor>();

  constructor(init: Partial<Server> = {}) {
    this.cfg = init.cfg;
    this.settings = init.settings ?? null;
    this.allow = init.allow;
    this.saveProjectAllow = init.saveProjectAllow;
    this.version = init.version ?? "";
    this.responsesRuns = init.responsesRuns;
    this.runManager = init.runManager;
    this.provider = init.provider;
    this.providerName = init.providerName ?? "";
    this.providerOverride = init.providerOverride ?? "";
    this.modelOverride = init.modelOverride ?? "";
    this.model = init.model;
    this.sandboxMgr = init.sandboxMgr;
    this.skillsMgr = init.skillsMgr;
    this.pool = init.pool;
    this.cronStore = init.cronStore;
    this.cronScheduler = init.cronScheduler;
    this.runComplete = init.runComplete;
    this.runSlots = init.runSlots;
    this.extraContext = init.extraContext ?? "";
  }

  /**
   * IsWebSearchAvailable reports whether hosted web search is available for
   * sessions. It is true when either the serve config enables web search or
   * the app-level settings.json has webSearch enabled with a configured
   * provider.
   */
  isWebSearchAvailable(): boolean {
    if (this.cfg?.enableWebSearch) return true;
    return this.settings !== null && isWebSearchEnabled(this.settings);
  }

  /** Lazily creates the deprecated legacy stream hub. */
  getStreamHub(): SessionStreamHub {
    if (!this.streamHub) this.streamHub = newSessionStreamHub();
    return this.streamHub;
  }

  /** Lazily creates the unified event broker. */
  getEventBroker(): EventBroker {
    if (!this.eventBroker) this.eventBroker = new EventBroker();
    return this.eventBroker;
  }

  /**
   * getAllow lazily loads the project allow rules (Go commands.go keeps this
   * beside the command handlers; the rule helpers consume it today).
   */
  getAllow(): AllowConfig {
    if (!this.allow) this.allow = loadAllow();
    return this.allow;
  }

  /**
   * settingsSkillHub returns a copy of marketplace settings for runtime
   * adapters; mutating the copy never touches the live settings object.
   */
  settingsSkillHub(): SkillHubSettings {
    const value = this.settings?.skillHub;
    if (!value) return {};
    return {
      ...value,
      officialHandles: value.officialHandles
        ? [...value.officialHandles]
        : undefined,
      markets: value.markets ? value.markets.map((m) => ({ ...m })) : undefined,
    };
  }

  /** sessionDir resolves the effective session storage directory. */
  sessionDir(): string {
    if (!this.settings) return "";
    return getSessionDir(this.settings);
  }

  /**
   * setRunCompleteObserver replaces the callback invoked after a run reaches
   * a terminal state. It is used by serve integrations such as channel
   * runtimes.
   */
  setRunCompleteObserver(
    observer: (
      sessionId: string,
      runId: string,
      status: string,
      errMsg: string,
    ) => void,
  ): void {
    this.runComplete = observer;
  }

  /** authConfig projects the current serve config onto the auth middleware. */
  authConfig(): RouteAuthConfig {
    const cfg = this.cfg;
    if (!cfg?.auth) return { enabled: false };
    return {
      enabled: cfg.auth.enabled,
      tokens: cfg.auth.tokens ? [...cfg.auth.tokens] : undefined,
    };
  }

  /**
   * applyServeConfig swaps the serve configuration at runtime: the server and
   * every pooled session receive a fresh sandbox manager at the configured
   * level, and running runtimes are told whether artifacts are enabled. A
   * session whose runtime completed shutdown just before eviction cannot
   * start another run, so it needs no update.
   */
  applyServeConfig(next: Config): void {
    if (!next) return;
    const settings = this.settings;
    if (!settings) {
      this.cfg = cloneConfig(next)!;
      return;
    }
    const workDir = getWorkDir(next);
    const mgr = newManagerWithOptions(
      workDir,
      sandboxOptionsFromSettings(settings.sandbox),
    );
    let level = Level.None;
    if (next.sandbox?.enabled) {
      level = Level.Standard;
      if (next.sandbox.level === "strict") level = Level.Strict;
      try {
        mgr.setLevel(level);
      } catch (err) {
        throw new Error(`apply serve sandbox: ${(err as Error).message}`);
      }
    } else {
      mgr.setLevel(Level.None);
    }
    this.cfg = cloneConfig(next)!;
    this.sandboxMgr = mgr;
    for (const sess of this.pool?.snapshot() ?? []) {
      if (!sess || !sess.registry) continue;
      const sessMgr = newManagerWithOptions(
        sess.workDir,
        sandboxOptionsFromSettings(settings.sandbox),
      );
      try {
        sessMgr.setLevel(level);
      } catch (err) {
        throw new Error(`apply session sandbox: ${(err as Error).message}`);
      }
      sess.sandboxMgr = sessMgr;
      sess.registry.setSandbox(sessMgr.getActive());
      sess.runtime?.setArtifactEnabled(next.enableArtifact ?? false);
    }
  }

  /**
   * applySettings updates the runtime provider/model from a saved
   * settings.json. The configured provider/model overrides win over the serve
   * config, which in turn wins over the settings defaults; an openai-responses
   * provider also installs its durable background-run driver.
   */
  async applySettings(next: Settings): Promise<void> {
    const cfg = this.cfg;
    if (!cfg) return;

    const runtime: Settings = { ...next };
    if (cfg.enableWebSearch) {
      runtime.webSearch = { ...runtime.webSearch, enabled: true };
    }
    let providerName = cfg.provider ?? "";
    if (this.providerOverride !== "") providerName = this.providerOverride;
    if (providerName === "") providerName = runtime.defaultProvider ?? "";
    let modelID = cfg.model ?? "";
    if (this.modelOverride !== "") modelID = this.modelOverride;
    if (modelID === "") {
      if (this.providerOverride !== "" || cfg.provider !== "") modelID = "";
      else modelID = runtime.defaultModel ?? "";
    }

    let p: Provider;
    let model: Model;
    try {
      ({ provider: p, model } = create(runtime, providerName, modelID));
    } catch (err) {
      throw new Error(`create provider: ${(err as Error).message}`);
    }
    const { skillsMgr, extraContext } = await buildWorkDirContext(
      runtime,
      getWorkDir(cfg),
      cfg.enableWorkflows ?? false,
      cfg.enableBrowser ?? false,
    );

    this.settings = runtime;
    this.provider = p;
    this.providerName = providerName;
    this.model = model;
    this.skillsMgr = skillsMgr;
    this.extraContext = extraContext;
    if (p instanceof OpenAIProvider && p.api() === "openai-responses") {
      this.responsesRuns = p.newResponsesRunManager(getSessionDir(runtime));
    } else {
      this.responsesRuns = undefined;
    }
  }

  /**
   * findSessionWorkDir resolves a session's working directory from the live
   * pool first and the persisted session header second. `found` is false only
   * when the ID does not resolve at all.
   */
  findSessionWorkDir(id: string): { workDir: string; found: boolean } {
    if (id === "") return { workDir: "", found: false };
    if (this.pool) {
      const sess = this.pool.getExact(id);
      if (sess) return { workDir: sess.workDir, found: true };
    }
    if (!this.settings) return { workDir: "", found: false };
    let mgr;
    try {
      mgr = openByIDExact(getSessionDir(this.settings), id);
    } catch {
      return { workDir: "", found: false };
    }
    const header = mgr.getHeader();
    if (header) return { workDir: header.cwd, found: true };
    return { workDir: "", found: true };
  }
}

/**
 * RunSlotLimiter stands in for Go's buffered `chan struct{}` semaphore
 * (MaxConcurrentReqs). tryAcquire reports whether a slot was free; release
 * returns it. The serve assembly slice fills it.
 */
export interface RunSlotLimiter {
  tryAcquire(): boolean;
  release(): void;
}

/**
 * newRunSlotLimiter ports Go's `make(chan struct{}, maxConcurrentReqs)`
 * used with a non-blocking select in the chat handler: acquisition fails
 * rather than blocks when every slot is busy. Returns undefined for a
 * non-positive budget, matching Go's nil channel (no limiter).
 */
export function newRunSlotLimiter(max: number): RunSlotLimiter | undefined {
  if (max <= 0) return undefined;
  let available = max;
  return {
    tryAcquire(): boolean {
      if (available <= 0) return false;
      available--;
      return true;
    },
    release(): void {
      available++;
    },
  };
}

/** newServer assembles a Server from ported dependencies (Go builds the literal in run.go). */
export function newServer(init: Partial<Server> = {}): Server {
  return new Server(init);
}
