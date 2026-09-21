// Ported from internal/serve/run.go (the channelRuntime lifecycle core) plus
// channels_api.go's syncPlatformRuntime: construction (startChannels), the
// cron scheduler composition over ServeCronState, the config-update transaction
// (applyConfigUpdate + platformTransportChanged), the platform
// startup/candidate/rollback lifecycle, bound-session result mirroring, and
// coordinated shutdown. The management HTTP handlers that share the Go
// receiver (status/projects/sessions/experts/env/settings/browse/…) remain
// unported and land with the run.go handler slices.
//
// Deviations: Go's sync.RWMutex/mutex fields are not reproduced — the Deno
// event loop makes synchronous field access atomic and no guard below must be
// held across an await (the Go code unlocks before its asynchronous sections
// too). Go's blocking `candidate.Start` goroutine + `done` channel maps to a
// promise resolving to the start error; `context.Context` maps to
// `AbortSignal`; `time.Duration(sec) * time.Second` maps to milliseconds;
// `log.Printf` maps to `console.error`. The cron half is composed over
// `ServeCronState` (cron_api.ts) and the knowledge half over
// `ServeKnowledgeBaseState` (knowledge_bases_api.ts), not reimplemented.

import { join } from "@std/path";
import { type CronStore, newSQLiteCronStore, Scheduler } from "../cron/mod.ts";
import { configDir, loadSettings, type Settings } from "../config/settings.ts";
import type {
  MessageHandler,
  Platform,
  Readiness,
} from "../messaging/platform.ts";
import { Bot as FeishuBot } from "../messaging/feishu/feishu.ts";
import { loadCredentials } from "../messaging/wechat/auth.ts";
import { Bot as WechatBot } from "../messaging/wechat/wechat.ts";
import {
  type Config as ChannelConfig,
  defaultConfig as defaultChannelConfig,
  type Dispatcher,
  newDispatcher,
} from "./channels/mod.ts";
import { handleDelivery as channelHandleDelivery } from "./channels/delivery.ts";
import { findBindingBySessionId } from "../session/bindings.ts";
import { type IdentityLocks, newIdentityLocks } from "../session/mod.ts";
import { cloneServeConfig, type ServeConfigState } from "./config_state.ts";
import type { ServeConfig } from "./config.ts";
import { cronMaintenancePolicy, ServeCronState } from "./cron_api.ts";
import { runDeliveryRecovery } from "./delivery_recovery.ts";
import { ServeKnowledgeBaseState } from "./knowledge_bases_api.ts";
import { buildServeStatus, type ChannelStatusView } from "./http.ts";
import type { LogHub } from "./logs.ts";
import { PlatformSupervisor } from "./platform_supervisor.ts";
import { applyRuntimeFeatures } from "./options.ts";
import { getWorkDir } from "./openaiapi/config.ts";
import { publishExternalSessionUpdate } from "./openaiapi/session_stream.ts";
import { publishExternalSubAgentEvent } from "./openaiapi/external_subagents.ts";
import type { Server } from "./openaiapi/server.ts";
import { SessionLifecycleService } from "./session_lifecycle.ts";
import { errorString, WechatLoginSession } from "./channels_api.ts";

export { errorString, WechatLoginSession };

/** Go's messaging platform startup order is fixed: wechat first, then feishu. */
const PLATFORM_NAMES = ["wechat", "feishu"] as const;

/**
 * buildConfigFromServeConfig ports run.go's helper of the same name: projects
 * the merged serve config into the channels dispatcher config.
 */
export function buildConfigFromServeConfig(
  cfg: ServeConfig | null,
): ChannelConfig {
  const hCfg = defaultChannelConfig();
  if (cfg === null) return hCfg;
  applyRuntimeFeatures(cfg);
  hCfg.defaultProvider = cfg.api.provider;
  hCfg.defaultModel = cfg.api.model;
  hCfg.multiAgent = cfg.api.enableSubAgents;
  hCfg.sandbox = cfg.api.sandbox.enabled;
  hCfg.webSearch = cfg.api.enableWebSearch;
  hCfg.browser = cfg.api.enableBrowser;
  hCfg.artifact = cfg.channels.artifact;
  hCfg.a2aMaster = cfg.api.enableA2AMaster;
  hCfg.workDir = getWorkDirOf(cfg);
  hCfg.wechat = cfg.channels.wechat;
  hCfg.feishu = {
    enabled: cfg.channels.feishu.enabled,
    appID: cfg.channels.feishu.appId,
    appSecret: cfg.channels.feishu.appSecret,
    workDir: cfg.channels.feishu.workDir,
  };
  hCfg.cron = cfg.cron;
  hCfg.memory = cfg.memory;
  hCfg.security = cfg.security;
  hCfg.hooks = cfg.hooks;
  hCfg.agent = cfg.agent;
  return hCfg;
}

/** getWorkDirOf is Go's cfg.API.GetWorkDir over the serve config. */
function getWorkDirOf(cfg: ServeConfig): string {
  return getWorkDir({
    defaultWorkDir: cfg.api.defaultWorkDir,
    workingDir: cfg.api.workingDir,
  });
}

/** buildCronStore ports run.go's helper: enabled cron owns a SQLite store. */
export function buildCronStore(
  hCfg: ChannelConfig | null,
  sessionDir: string,
): CronStore | null {
  if (hCfg !== null && hCfg.cron.enabled) {
    return newSQLiteCronStore(sessionDir);
  }
  return null;
}

/** cronStorePath ports run.go's helper: the session-root SQLite database. */
export function cronStorePath(sessionDir: string): string {
  return join(sessionDir, "sessions.db");
}

/** errorFromRun ports run.go's helper: a completed run carries no error. */
export function errorFromRun(status: string, errMsg: string): Error | null {
  if (status === "completed" || status === "incomplete") return null;
  let message = errMsg.trim();
  if (message === "") message = status;
  if (message === "") message = "run failed";
  return new Error(message);
}

/**
 * platformTransportChanged ports run.go's helper: a transport restart is
 * required only when its identity-affecting fields changed.
 */
export function platformTransportChanged(
  old: ServeConfig | null,
  next: ServeConfig | null,
  platform: string,
): boolean {
  if (old === null || next === null) return true;
  if (platform === "wechat") {
    return old.channels.wechat.enabled !== next.channels.wechat.enabled ||
      old.channels.wechat.credPath !== next.channels.wechat.credPath ||
      old.channels.wechat.autoTyping !== next.channels.wechat.autoTyping;
  }
  return old.channels.feishu.enabled !== next.channels.feishu.enabled ||
    old.channels.feishu.appId !== next.channels.feishu.appId ||
    old.channels.feishu.appSecret !== next.channels.feishu.appSecret;
}

/**
 * startChannels ports run.go's constructor for the channel runtime: feature
 * projection, dispatcher construction with the shared cron store, identity
 * locks, the rotate handler, the cron scheduler, and the delivery recovery
 * worker.
 */
export function startChannels(
  cfg: ServeConfig,
  sessionDir: string,
  version: string,
  /** Overrides the process settings read (Go passes the mutated settings). */
  settingsOverride?: Settings,
): ChannelRuntime {
  applyRuntimeFeatures(cfg);

  const hCfg = buildConfigFromServeConfig(cfg);
  const cronStore = buildCronStore(hCfg, sessionDir);

  const dispatcher = newDispatcher({
    cfg: hCfg,
    settings: settingsOverride ?? loadSettings(),
    version,
    cronStore,
    scheduler: null,
  });
  const identityMux = newIdentityLocks();
  dispatcher.setIdentityLocks(identityMux);
  const rt = new ChannelRuntime({
    cfg,
    version,
    dispatcher,
    sessionDir,
    identityMux,
    cronStore,
  });
  dispatcher.setRotateHandler((platform, userID, force) =>
    rt.rotateChannelSession(platform, userID, force)
  );
  rt.setupCronScheduler(hCfg);
  rt.startDeliveryRecovery();
  return rt;
}

/**
 * ChannelRuntime owns the serve process's channel half: the dispatcher, the
 * live platform instances, the cron runtime, and the durable delivery
 * recovery worker. It is the Go `channelRuntime` struct minus the HTTP
 * handlers, which remain in the run.go handler slices.
 */
export class ChannelRuntime {
  cfg: ServeConfig | null;
  configState: ServeConfigState | null = null;
  version: string;
  dispatcher: Dispatcher | null;
  platforms: PlatformSupervisor;
  wechatLogin: WechatLoginSession | null = null;
  logHub: LogHub | null = null;
  /** The cron half is composed over the shared ServeCronState component. */
  readonly cron: ServeCronState;
  sessionDir: string;
  identityMux: IdentityLocks;
  /** The knowledge half is composed over the shared ServeKnowledgeBaseState. */
  readonly knowledge: ServeKnowledgeBaseState;
  nativeDirectoryPicker:
    | ((signal: AbortSignal | undefined, start?: string) => Promise<string>)
    | null = null;
  deliveryController: AbortController | null = null;
  deliveryDone: Promise<void> | null = null;
  /**
   * deliveryReopened tracks operations already given a second retry window by
   * this process (reconnect recovery), so a permanently undeliverable target
   * cannot loop across every reconnect.
   */
  readonly deliveryReopened = new Set<string>();

  constructor(opts: {
    cfg: ServeConfig | null;
    version: string;
    dispatcher: Dispatcher | null;
    sessionDir: string;
    identityMux: IdentityLocks;
    cronStore: CronStore | null;
    logHub?: LogHub | null;
  }) {
    this.cfg = opts.cfg;
    this.version = opts.version;
    this.dispatcher = opts.dispatcher;
    this.platforms = new PlatformSupervisor();
    this.sessionDir = opts.sessionDir;
    this.identityMux = opts.identityMux;
    this.logHub = opts.logHub ?? null;
    this.knowledge = new ServeKnowledgeBaseState(opts.sessionDir);
    this.cron = new ServeCronState({
      sessionDir: opts.sessionDir,
      configSnapshot: () => this.configSnapshot(),
      dispatcher: opts.dispatcher,
    });
    // Construction seeded the store from the same snapshot startChannels used;
    // keep the component's fields aligned so its handlers see it.
    this.cron.cronStore = opts.cronStore;
    this.cron.cronStorePath = opts.cronStore === null
      ? ""
      : cronStorePath(opts.sessionDir);
  }

  // --- config snapshot -------------------------------------------------------

  configSnapshot(): ServeConfig | null {
    if (this.cfg === null) return null;
    return cloneServeConfig(this.cfg);
  }

  setConfig(cfg: ServeConfig | null): void {
    this.cfg = cfg;
  }

  setConfigState(state: ServeConfigState): void {
    this.configState = state;
  }

  // --- API wiring ------------------------------------------------------------

  /**
   * configureAPI ports run.go's receiver: the dispatcher's run/sub-agent
   * observers and the background submitter are projections of the shared
   * openaiapi server, never independent event paths.
   */
  configureAPI(api: Server | null): void {
    if (api === null || this.dispatcher === null) return;
    this.dispatcher.setRunObserver((sessionID) => {
      void publishExternalSessionUpdate(api, sessionID);
    });
    this.dispatcher.setSubAgentObserver((sessionID, ev) => {
      publishExternalSubAgentEvent(api, sessionID, ev);
    });
    this.dispatcher.setBackgroundSubmitter(
      api.submitExternalResponsesBackground ?? null,
    );
  }

  cronSnapshot(): CronStore | null {
    return this.cron.cronStore;
  }

  cronSchedulerSnapshot(): Scheduler | null {
    return this.cron.cronScheduler;
  }

  // --- cron lifecycle ----------------------------------------------------------

  /**
   * setupCronScheduler ports run.go's receiver: with cron enabled and an agent
   * runtime available, install the shared scheduler projecting the Runtime
   * maintenance policy, the bound-session completion observer, and the
   * knowledge-base cron handler.
   */
  setupCronScheduler(hCfg: ChannelConfig | null): void {
    if (hCfg === null || !hCfg.cron.enabled) {
      console.error("  Cron: disabled");
      return;
    }
    if (
      this.cron.cronStore === null || this.dispatcher === null ||
      this.dispatcher.ensureAgentManager() === null
    ) {
      console.error("  Cron: disabled (agent runtime unavailable)");
      return;
    }
    this.installCronScheduler(hCfg.cron.interval ?? 0);
    console.error("  Cron: enabled");
  }

  /** cronIntervalMS maps Go's time.Duration(Interval) * time.Second. */
  private cronIntervalMS(intervalSeconds: number): number {
    const interval = intervalSeconds * 1000;
    return interval > 0 ? interval : 30_000;
  }

  /** installCronScheduler builds and starts one scheduler over the live store. */
  private installCronScheduler(intervalSeconds: number): Scheduler {
    const scheduler = new Scheduler(
      this.cron.cronStore!,
      this.dispatcher!.agentManager(),
      this.cronIntervalMS(intervalSeconds),
      this.sessionDir,
      async (job, signal) => {
        const outcome = await this.knowledge.runKnowledgeBaseCronJob(
          signal,
          job,
        );
        return { ...outcome, error: null };
      },
    );
    scheduler.setMaintenancePolicy(cronMaintenancePolicy());
    scheduler.setCompletionObserver((sessionID, response, runErr) =>
      this.pushBoundSessionResult(sessionID, response, runErr)
    );
    this.cron.cronScheduler = scheduler;
    this.dispatcher!.setCronScheduler(scheduler);
    scheduler.start();
    return scheduler;
  }

  /**
   * syncCronRuntime ports run.go's receiver: after every config update the
   * store, dispatcher projection, and scheduler are brought back in sync with
   * the effective config — disabled cron tears the runtime down, a changed
   * store path rotates it, and a stopped scheduler restarts on the new
   * interval.
   */
  syncCronRuntime(): void {
    if (!this.cron.cronEnabled()) {
      this.stopCronSchedulerLocked();
      this.cron.cronStore = null;
      this.cron.cronStorePath = "";
      if (this.dispatcher !== null) this.dispatcher.setCronStore(null);
      return;
    }

    const snapshot = this.configSnapshot();
    const nextPath = join(this.sessionDir, "sessions.db");
    if (this.cron.cronStore === null || this.cron.cronStorePath !== nextPath) {
      this.stopCronSchedulerLocked();
      this.cron.cronStorePath = nextPath;
      this.cron.cronStore = newSQLiteCronStore(this.sessionDir);
    }
    if (this.dispatcher !== null) {
      this.dispatcher.setCronStore(this.cron.cronStore);
    }

    if (
      this.cron.cronStore === null || this.dispatcher === null ||
      this.dispatcher.ensureAgentManager() === null
    ) {
      this.stopCronSchedulerLocked();
      return;
    }
    if (
      this.cron.cronScheduler === null || !this.cron.cronScheduler.isRunning()
    ) {
      this.installCronScheduler(snapshot?.cron.interval ?? 0);
    }
  }

  stopCronScheduler(): void {
    this.stopCronSchedulerLocked();
  }

  /** Mirrors Go's stopCronSchedulerLocked (callers hold the cron lock). */
  private stopCronSchedulerLocked(): void {
    this.cron.stopCronSchedulerLocked();
  }

  // --- config update transaction ------------------------------------------------

  /**
   * applyConfigUpdate ports run.go's receiver: apply the channel dispatcher
   * config, swap the snapshot, re-sync the cron runtime, then restart only the
   * platforms whose transport identity changed. A platform failure rolls the
   * dispatcher and snapshot back before the config-state transaction restores
   * the writable file.
   */
  async applyConfigUpdate(next: ServeConfig): Promise<void> {
    applyRuntimeFeatures(next);
    const previous = this.configSnapshot();
    if (this.dispatcher !== null) {
      try {
        this.dispatcher.applyConfig(buildConfigFromServeConfig(next));
      } catch (err) {
        throw new Error(
          `apply channel dispatcher config: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    this.setConfig(next);
    this.syncCronRuntime();
    try {
      await this.syncPlatformRuntime(previous, next);
    } catch (err) {
      if (previous !== null) {
        if (this.dispatcher !== null) {
          try {
            this.dispatcher.applyConfig(buildConfigFromServeConfig(previous));
          } catch (rollbackErr) {
            console.error(
              `[serve] rollback dispatcher config after platform failure: ${
                rollbackErr instanceof Error ? rollbackErr.message : rollbackErr
              }`,
            );
          }
        }
        this.setConfig(previous);
        this.syncCronRuntime();
      }
      throw err;
    }
  }

  /**
   * syncPlatformRuntime ports channels_api.go's receiver: restart exactly the
   * platforms whose transport configuration changed.
   */
  async syncPlatformRuntime(
    previous: ServeConfig | null,
    next: ServeConfig,
  ): Promise<void> {
    for (const name of PLATFORM_NAMES) {
      if (platformTransportChanged(previous, next, name)) {
        await this.restartPlatform(name, next);
      }
    }
  }

  // --- platform lifecycle ---------------------------------------------------------

  async startPlatforms(): Promise<void> {
    const cfg = this.configSnapshot();
    for (const name of PLATFORM_NAMES) {
      try {
        await this.restartPlatform(name, cfg);
      } catch (err) {
        console.error(
          `[serve] ${name} startup unavailable: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }
  }

  /**
   * restartPlatform ports run.go's receiver: build the configured candidate
   * (or none), then either register it immediately, tear the previous instance
   * down, or run the guarded candidate startup. Invalid credentials are a
   * failed candidate, not a request to tear down a healthy instance.
   */
  async restartPlatform(name: string, cfg: ServeConfig | null): Promise<void> {
    this.publishManagementEvent("channel_status_changed", {
      platform: name,
      state: "starting",
    });
    let next: Platform | null = null;
    let configured = false;
    let candidateErr: Error | null = null;
    if (cfg !== null) {
      if (name === "wechat") {
        if (cfg.channels.wechat.enabled) {
          configured = true;
          let credPath = cfg.channels.wechat.credPath;
          if (credPath === "") {
            credPath = join(configDir(), "wechat-credentials.json");
          }
          let creds: ReturnType<typeof loadCredentials> = null;
          try {
            creds = loadCredentials(credPath);
          } catch (err) {
            candidateErr = new Error(
              `load wechat credentials: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          if (creds === null) {
            console.error("  WeChat: enabled but not logged in");
          } else {
            const bot = new WechatBot({
              credPath,
              autoTyping: cfg.channels.wechat.autoTyping,
            });
            bot.setStatusCallback(() => this.publishChannelStatus());
            next = bot;
          }
        } else {
          console.error("  WeChat: disabled");
        }
      } else if (name === "feishu") {
        if (cfg.channels.feishu.enabled) {
          configured = true;
          if (
            cfg.channels.feishu.appId === "" ||
            cfg.channels.feishu.appSecret === ""
          ) {
            console.error(
              "  Feishu: enabled but app_id/app_secret not configured",
            );
          } else {
            const bot = new FeishuBot({
              appID: cfg.channels.feishu.appId,
              appSecret: cfg.channels.feishu.appSecret,
            });
            bot.setStatusCallback(() => this.publishChannelStatus());
            next = bot;
          }
        } else {
          console.error("  Feishu: disabled");
        }
      }
    }

    const previous = this.platforms.get(name);
    // Invalid credentials/configuration are a failed candidate, not a request
    // to tear down a healthy existing instance.
    if (configured && next === null) {
      if (candidateErr !== null) throw candidateErr;
      return;
    }
    if (next === null) {
      this.platforms.replace(name, null);
      if (previous !== undefined) {
        await stopQuietly(previous);
      }
      return;
    }
    if (previous === undefined) {
      this.platforms.replace(name, next);
      void this.runPlatform(next);
      return;
    }
    // Keep the healthy owner in the supervisor while the replacement performs
    // its startup handshake. A candidate that fails before readiness therefore
    // cannot interrupt the old receive loop.
    await this.startPlatformCandidate(name, next, previous);
  }

  /**
   * startPlatformCandidate ports run.go's receiver. Go's `done` channel maps
   * to a promise resolving to the start error (null on clean exit); Go's
   * `ready.Ready()` maps to the Readiness promise. Platforms without
   * readiness keep the legacy immediate promotion behavior.
   */
  async startPlatformCandidate(
    name: string,
    candidate: Platform,
    previous: Platform,
  ): Promise<void> {
    const signal = new AbortController().signal;
    const done: Promise<unknown> = candidate
      .start(signal, this.deliveryHandler())
      .then(
        () => null,
        (err) => err,
      );

    const readyFn = (candidate as Partial<Readiness>).ready;
    if (typeof readyFn !== "function") {
      // Third-party transports may not expose readiness; preserve the legacy
      // behavior for them while built-in transports use the guarded path.
      const promoted = this.platforms.replaceIf(name, previous, candidate);
      if (!promoted) {
        await stopQuietly(candidate);
        return;
      }
      void stopQuietly(previous);
      void this.finishPlatform(candidate, done, previous);
      return;
    }

    const DONE_TOKEN = Symbol("done");
    const outcome = await Promise.race([
      readyFn.call(candidate).then(
        () => null,
        (err) => err,
      ),
      done.then(() => DONE_TOKEN),
    ]);
    if (outcome !== DONE_TOKEN) {
      const startupErr = outcome;
      if (startupErr !== null) {
        await done;
        this.publishManagementEvent("channel_status_changed", {
          platform: name,
          state: "rollback",
          error: errorString(startupErr),
        });
        throw startupErr;
      }
      const promoted = this.platforms.replaceIf(name, previous, candidate);
      if (!promoted) {
        await stopQuietly(candidate);
        return;
      }
      void stopQuietly(previous);
      void this.finishPlatform(candidate, done, previous);
      return;
    }
    const startErr = await done;
    if (startErr !== null) {
      this.publishManagementEvent("channel_status_changed", {
        platform: name,
        state: "rollback",
        error: errorString(startErr),
      });
      throw startErr;
    }
  }

  /**
   * finishPlatform ports run.go's receiver: observe the candidate's receive
   * loop, remove it only if it is still the registered instance, and fall back
   * to the previous instance when a live owner failed.
   */
  async finishPlatform(
    platform: Platform,
    done: Promise<unknown>,
    fallback: Platform | null,
  ): Promise<void> {
    const err = await done;
    const removed = this.platforms.removeIf(platform.name(), platform);
    if (removed && err !== null && fallback !== null) {
      this.platforms.replace(platform.name(), fallback);
    }
    if (removed) {
      await stopQuietly(platform);
      if (err !== null && fallback !== null) {
        void this.runPlatform(fallback);
      }
    }
    const state = err !== null && fallback !== null
      ? "rollback"
      : "disconnected";
    this.publishManagementEvent("channel_status_changed", {
      platform: platform.name(),
      state,
      error: errorString(err),
    });
    this.publishChannelStatus();
  }

  /**
   * runPlatform ports run.go's receiver: run the receive loop to completion,
   * remove the platform only if it is still registered, and fall back on a
   * live-owner failure.
   */
  async runPlatform(p: Platform, fallback?: Platform): Promise<void> {
    let err: unknown = null;
    try {
      await p.start(
        new AbortController().signal,
        this.deliveryHandler(),
      );
    } catch (startErr) {
      err = startErr;
      console.error(
        `[serve] ${p.name()} stopped: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
    const removed = this.platforms.removeIf(p.name(), p);
    if (removed && err !== null && fallback) {
      this.platforms.replace(p.name(), fallback);
    }
    if (removed) {
      await stopQuietly(p);
      if (err !== null && fallback) {
        void this.runPlatform(fallback);
      }
    }
    const state = err !== null && fallback ? "rollback" : "disconnected";
    this.publishManagementEvent("channel_status_changed", {
      platform: p.name(),
      state,
      error: errorString(err),
    });
    this.publishChannelStatus();
  }

  /** deliveryHandler projects Go's rt.dispatcher.HandleDelivery method value. */
  private deliveryHandler() {
    return (signal: AbortSignal, msg: Parameters<MessageHandler>[1]) =>
      channelHandleDelivery(this.dispatcher!, signal, msg);
  }

  platformSnapshot(): Platform[] {
    return this.platforms.snapshot();
  }

  // --- status/events ------------------------------------------------------------

  /**
   * publishChannelStatus ports run.go's receiver: broadcast the current
   * serve status snapshot (features + channel connectivity) on the log hub.
   */
  publishChannelStatus(): void {
    if (this.logHub === null) return;
    const cfg = this.configSnapshot();
    this.logHub.publish({
      type: "channel_status_changed",
      timestamp: new Date().toISOString(),
      status: buildServeStatus({
        config: cfg ?? undefined,
        channels: this.channelStatuses(),
        sessions: 0,
      }),
      data: { state: "updated" },
    });
  }

  /** channelStatuses ports run.go's receiver over the platform supervisor. */
  channelStatuses(): ChannelStatusView[] {
    const cfg = this.configSnapshot();
    if (cfg === null) {
      return [
        { name: "wechat", enabled: false, connected: false },
        { name: "feishu", enabled: false, connected: false },
      ];
    }
    const statuses: ChannelStatusView[] = [
      {
        name: "wechat",
        enabled: cfg.channels.wechat.enabled,
        connected: false,
      },
      {
        name: "feishu",
        enabled: cfg.channels.feishu.enabled,
        connected: false,
      },
    ];
    const byName = new Map([
      ["wechat", 0],
      ["feishu", 1],
    ]);
    for (const p of this.platformSnapshot()) {
      const idx = byName.get(p.name());
      if (idx !== undefined) {
        statuses[idx].connected = p.isConnected();
        continue;
      }
      statuses.push({
        name: p.name(),
        enabled: true,
        connected: p.isConnected(),
      });
    }
    return statuses;
  }

  publishManagementEvent(eventType: string, data: unknown): void {
    if (this.logHub === null) return;
    this.logHub.publish({
      type: eventType,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  // --- bound-session result mirroring ----------------------------------------------

  /**
   * pushBoundSessionResult mirrors runs initiated outside a messaging channel
   * back to the platform currently bound to that session.
   */
  async pushBoundSessionResult(
    sessionID: string,
    response: string,
    runErr: Error | null,
  ): Promise<void> {
    if (sessionID === "") return;
    let binding;
    try {
      binding = findBindingBySessionId(this.sessionDir, sessionID);
    } catch (err) {
      console.error(
        `[serve] find channel binding for session ${sessionID}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      return;
    }
    if (
      binding === null ||
      (binding.channelType !== "wechat" && binding.channelType !== "feishu")
    ) {
      return;
    }
    let platform: Platform | null = null;
    for (const candidate of this.platformSnapshot()) {
      if (
        candidate !== null &&
        candidate.name().toLowerCase() === binding.channelType.toLowerCase()
      ) {
        platform = candidate;
        break;
      }
    }
    if (platform === null) {
      console.error(
        `[serve] no ${binding.channelType} platform for bound session ${sessionID}`,
      );
      return;
    }
    let text = response.trim();
    if (runErr !== null) {
      const errorText = `Error: ${runErr.message.trim()}`;
      text = text === "" ? errorText : `${text}\n\n${errorText}`;
    }
    if (text === "") return;
    try {
      await platform.sendMessage(
        new AbortController().signal,
        binding.channelId,
        text,
      );
    } catch (err) {
      console.error(
        `[serve] send ${binding.channelType} result for session ${sessionID}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  // --- channel session rotation hook -------------------------------------------------

  /** rotateChannelSession is the dispatcher's rotate-handler projection. */
  async rotateChannelSession(
    platform: string,
    userID: string,
    force: boolean,
  ): Promise<void> {
    const lifecycle = new SessionLifecycleService(
      null,
      this.dispatcher,
      this.sessionDir,
      this.identityMux,
    );
    lifecycle.setEventPublisher((eventType, data) =>
      this.publishManagementEvent(eventType, data)
    );
    await lifecycle.rotate(undefined, platform, userID, force);
  }

  // --- delivery recovery ---------------------------------------------------------------

  /** startDeliveryRecovery launches the durable-outbox recovery worker. */
  startDeliveryRecovery(): void {
    const controller = new AbortController();
    this.deliveryController = controller;
    this.deliveryDone = runDeliveryRecovery(this, controller.signal);
  }

  // --- shutdown ---------------------------------------------------------------------------

  /** stop ports run.go's receiver: the coordinated shutdown boundary. */
  async stop(): Promise<void> {
    this.stopCronScheduler();
    if (this.deliveryController !== null) {
      this.deliveryController.abort();
      if (this.deliveryDone !== null) {
        await this.deliveryDone.catch(() => {});
      }
    }
    await this.platforms.stopAll().catch(() => {});
    if (this.dispatcher !== null) {
      this.dispatcher.close();
    }
    this.publishManagementEvent("channel_status_changed", {
      state: "stopped",
    });
  }
}

/** stopQuietly awaits a platform stop, tolerating void returns and errors. */
async function stopQuietly(platform: Platform): Promise<void> {
  try {
    await platform.stop();
  } catch {
    // Go discards Stop errors on the teardown paths (`_ = previous.Stop()`).
  }
}
