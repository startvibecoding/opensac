// Ported from internal/serve/openaiapi/server.go — the run-options assembly
// (RunOptions, loadRunConfig, applyRunOverrides, listenFromPortOverride),
// buildWorkDirContext, and the top-level Run() lifecycle (buildRunStack +
// run: settings/provider/sandbox/pool assembly, the Runtime-owned recovery
// coordinator startup, lease-notification fan-out, ESM shutdown, the
// middleware + auth-mux stack, signal handling, and the HTTP listener).
//
// Deviations: Go's Shutdown receive channel maps to an AbortSignal; Go's
// `skills.Manager` construction ignores the load error and so does the ported
// load(); `(mgr, extraContext, error)` returns as a Promise of a result
// object with errors thrown (`create workflow skill: ...` wrapping kept).
// config.LoadSettings is injectable through RunOptions.settings so embedded
// hosts and tests can supply their own snapshot; http.Server's per-connection
// timeouts have no Deno.serve equivalent and are replaced by a bounded
// shutdown window; debugpprof has no Deno counterpart and is not started;
// signal listeners are registered best-effort (Deno lacks SIGTERM on
// Windows); Go's goroutine select maps to await-then-shutdown sequencing
// with the same error wrapping (`server error`, `session shutdown error`,
// `shutdown error`).
import {
  configDir,
  getGlobalSkillsDir,
  getSessionDir,
  loadSettings,
  type Settings,
  setVerbose,
} from "../../config/settings.ts";
import {
  buildContextString,
  loadContextFiles,
} from "../../contextfiles/contextfiles.ts";
import type { CronStore } from "../../cron/cron.ts";
import type { Scheduler } from "../../cron/scheduler.ts";
import { SkillName as browserSkillName } from "../../browser/tool.ts";
import {
  type Manager as SkillsManager,
  newManagerWithProjectDirs,
  projectSkillDirs,
} from "../../skills/skills.ts";
import {
  ensureProjectSkill,
  skillName as workflowSkillName,
} from "../../workflow/skill.ts";
import {
  applyUnsafeAccess,
  cloneConfig,
  type Config,
  defaultConfig,
  getListenAddr,
  getWorkDir,
  normalizeConfig,
  splitHostPort,
  validateListenSecurity,
} from "./config.ts";
import { handleChatCompletions } from "./handler_chat.ts";
import { handleHealth } from "./handler_health.ts";
import { RunManager } from "./run_manager.ts";
import {
  executeResponsesBackgroundRunFn,
  recoverResponsesBackgroundRuns,
} from "./background_run_coordinator.ts";
import { submitExternalResponsesBackgroundFn } from "./background_external.ts";
import { handleCommandFn } from "./commands.ts";
import { shutdownESMFn, wireESMCoordinator } from "./esm_coordinator.ts";
import { wireExpertAPI } from "./expert_api.ts";
import { RecoveryCoordinator } from "../../agentruntime/recovery_coordinator.ts";
import { subscribeRuntimeLeaseNotifications } from "../../session/runtime_lease_bus.ts";
import { sandboxOptionsFromSettings } from "../../agentruntime/session_runtime.ts";
import { Level, newManagerWithOptions } from "../../sandbox/sandbox.ts";
import { create } from "../../provider/factory/factory.ts";
import { Provider as OpenAIProvider } from "../../provider/openai/provider.ts";
import { loadAllow } from "../../config/allow.ts";
import { EventBroker } from "./event_broker.ts";
import {
  authMiddlewareForConfig,
  concurrencyMiddleware,
  corsMiddleware,
  type HTTPHandler,
  webUIAuthStatusHandlerForConfig,
  webUILoginHandlerForConfig,
  webUILogoutHandler,
} from "./auth.ts";
import { loggingMiddleware } from "./routes.ts";
import {
  newSessionStreamHub,
  publishExternalSessionUpdate,
} from "./session_stream.ts";
import { apiSecurityWarning, registerRoutes, ServeMux } from "./routes.ts";
import type { Server } from "./server.ts";
import { newRunSlotLimiter, newServer } from "./server.ts";
import { SessionPool } from "./session_mgr.ts";
import type { Model } from "../../provider/types.ts";
import type { Provider } from "../../provider/provider.ts";

/**
 * RunOptions controls the OpenAI-compatible API runtime used by serve. The
 * top-level run() lifecycle consumes the runtime fields; loadRunConfig only
 * reads the config-shaping ones.
 */
export interface RunOptions {
  config?: Config;
  disableAPI?: boolean;
  port?: string;
  provider?: string;
  model?: string;
  workDir?: string;
  unsafe?: boolean;
  sandbox?: boolean;
  multiAgent?: boolean;
  delegate?: boolean;
  workflows?: boolean;
  webSearch?: boolean;
  browser?: boolean;
  artifact?: boolean;
  a2aMaster?: boolean;
  cronStore?: CronStore;
  cronScheduler?: Scheduler;
  verbose?: boolean;
  debug?: boolean;
  extraRoutes?: (server: Server, mux: ServeMux) => void;
  /** Connects external channel runtimes to the canonical runtime state. */
  onReady?: (server: Server) => void;
  /** Called once after an API run reaches a terminal state. */
  onRunComplete?: (
    sessionId: string,
    runId: string,
    status: string,
    errMsg: string,
  ) => void;
  /** Requests graceful termination without relying on process signals. */
  shutdown?: AbortSignal;
  /**
   * Overrides config.LoadSettings() for embedded hosts and tests. Go reads
   * the process-global settings.json unconditionally; the injection is a
   * port-side seam, not a behavior change for the CLI assembly.
   */
  settings?: Settings;
}

/** loadRunConfig clones/creates the config and applies the CLI overrides. */
export function loadRunConfig(opts: RunOptions): Config {
  let cfg: Config;
  if (opts.config) {
    cfg = cloneConfig(opts.config)!;
    normalizeConfig(cfg);
  } else {
    cfg = defaultConfig();
  }
  applyRunOverrides(cfg, opts);
  return cfg;
}

/** applyRunOverrides ports the flag → config override matrix. */
export function applyRunOverrides(cfg: Config, opts: RunOptions): void {
  if (!cfg) return;
  if (opts.port) cfg.listen = listenFromPortOverride(opts.port);
  if (opts.unsafe) applyUnsafeAccess(cfg);
  if (opts.multiAgent) cfg.enableSubAgents = true;
  if (opts.delegate) cfg.enableDelegate = true;
  if (opts.workflows) cfg.enableWorkflows = true;
  if (opts.webSearch) cfg.enableWebSearch = true;
  if (opts.browser) cfg.enableBrowser = true;
  if (opts.artifact) cfg.enableArtifact = true;
  if (opts.a2aMaster) cfg.enableA2AMaster = true;
  if (opts.sandbox) {
    cfg.sandbox = { ...cfg.sandbox, enabled: true };
  }
  if (opts.workDir) {
    cfg.defaultWorkDir = opts.workDir;
    cfg.workingDir = "";
  }
}

/** listenFromPortOverride normalizes a --port override into a listen address. */
export function listenFromPortOverride(port: string): string {
  port = port.trim();
  if (port === "") return "";
  if (port.startsWith(":") || port.includes(":")) return port;
  return ":" + port;
}

/**
 * buildWorkDirContext assembles the skills manager and extra context string:
 * the workflow skill is ensured on disk when workflows are enabled, project
 * context files are loaded when the settings enable them, and the all-skills
 * context plus the optional workflow/browser skill pages are appended.
 */
export async function buildWorkDirContext(
  settings: Settings,
  workDir: string,
  workflows: boolean,
  browser: boolean,
): Promise<{ skillsMgr: SkillsManager; extraContext: string }> {
  if (workflows) {
    try {
      await ensureProjectSkill(workDir);
    } catch (err) {
      throw new Error(`create workflow skill: ${(err as Error).message}`);
    }
  }
  const skillsMgr = newManagerWithProjectDirs(
    getGlobalSkillsDir(settings),
    projectSkillDirs(workDir),
  );
  skillsMgr.load();

  let extraContext = "";
  if (settings.contextFiles?.enabled) {
    const cfResult = loadContextFiles(
      workDir,
      configDir(),
      settings.contextFiles.extraFiles ?? null,
    );
    const ctx = buildContextString(cfResult);
    if (ctx !== "") extraContext = ctx;
  }
  extraContext += skillsMgr.buildAllSkillsContext();
  if (workflows) extraContext += skillsMgr.buildSkillContext(workflowSkillName);
  if (browser) extraContext += skillsMgr.buildSkillContext(browserSkillName);
  return { skillsMgr, extraContext };
}

/** The Go shutdown window used for the bounded graceful termination. */
const shutdownTimeoutMs = 10_000;

/**
 * RunStack is Go's Run() state from the assembled Server through the full
 * middleware/auth-mux handler chain. `shutdown` runs Go's graceful shutdown
 * branch plus its deferred cleanup (ESM shutdown, pool shutdown, recovery
 * coordinator stop, lease-notification unsubscribe) exactly once.
 */
export interface RunStack {
  srv: Server;
  cfg: Config;
  /** The auth-wrapped handler installed as the http.Server Handler. */
  handler: HTTPHandler;
  /** Bounded, idempotent graceful shutdown of every assembled resource. */
  shutdown(): Promise<void>;
}

/**
 * buildRunStack ports Go's Run() up to (not including) the http.Server: the
 * provider/model resolution, sandbox setup, work-dir context, session pool,
 * run-slot limiter, run manager, the Runtime-owned recovery coordinator
 * startup, the lease-notification fan-out, the ESM/expert/background hook
 * wiring, OnReady, the route table with the chat-completions handler bound,
 * and the middleware + auth-mux stack.
 */
export async function buildRunStack(
  opts: RunOptions,
  version: string,
): Promise<RunStack> {
  const settings = opts.settings ?? loadSettings();

  const cfg = loadRunConfig(opts);
  validateListenSecurity(cfg, opts.unsafe ?? false);
  if (cfg.enableWebSearch) {
    settings.webSearch = { ...settings.webSearch, enabled: true };
  }

  // Resolve provider/model
  let providerName = cfg.provider ?? "";
  if (opts.provider) providerName = opts.provider;
  if (providerName === "") providerName = settings.defaultProvider ?? "";

  let modelID = cfg.model ?? "";
  if (opts.model) modelID = opts.model;
  if (modelID === "") {
    if (opts.provider || cfg.provider) modelID = "";
    else modelID = settings.defaultModel ?? "";
  }

  let p: Provider;
  let model: Model;
  try {
    ({ provider: p, model } = create(settings, providerName, modelID));
  } catch (err) {
    throw new Error(`create provider: ${(err as Error).message}`);
  }

  // Setup working directory
  const cwd = getWorkDir(cfg);

  // Setup sandbox
  const sbMgr = newManagerWithOptions(
    cwd,
    sandboxOptionsFromSettings(settings.sandbox),
  );
  const sbEnabled = cfg.sandbox?.enabled ?? false;
  if (!sbEnabled) {
    sbMgr.setLevel(Level.None);
  } else {
    let level = Level.Standard;
    if (cfg.sandbox?.level === "strict") level = Level.Strict;
    try {
      sbMgr.setLevel(level);
    } catch (err) {
      throw new Error(
        `strict sandbox enabled but unavailable: ${(err as Error).message}`,
      );
    }
    const fallback = sbMgr.fallbackError();
    if (fallback) {
      console.error(
        `Warning: sandbox unavailable; using direct execution: ${fallback.message}`,
      );
    }
  }

  const { skillsMgr, extraContext } = await buildWorkDirContext(
    settings,
    cwd,
    cfg.enableWorkflows ?? false,
    cfg.enableBrowser ?? false,
  );

  // Build session pool and the run-slot semaphore
  const idleTimeout = (cfg.session?.idleTimeoutSeconds ?? 0) * 1000;
  const pool = new SessionPool(cfg.session?.maxSessions ?? 0, idleTimeout);
  const runSlots = newRunSlotLimiter(cfg.maxConcurrentReqs ?? 0);

  const srv = newServer({
    cfg,
    settings,
    allow: loadAllow(),
    version,
    provider: p,
    providerName,
    providerOverride: opts.provider ?? "",
    modelOverride: opts.model ?? "",
    model,
    sandboxMgr: sbMgr,
    skillsMgr,
    pool,
    cronStore: opts.cronStore,
    cronScheduler: opts.cronScheduler,
    runComplete: opts.onRunComplete,
    extraContext,
    runSlots,
    runManager: new RunManager(getSessionDir(settings)),
  });
  srv.streamHub = newSessionStreamHub();
  srv.eventBroker = new EventBroker();
  if (p instanceof OpenAIProvider && p.api() === "openai-responses") {
    srv.responsesRuns = p.newResponsesRunManager(getSessionDir(settings));
  }

  // Recovery is a Runtime-owned startup and periodic responsibility. Durable
  // response_runs are the evidence for retaining provider-native background
  // work; source labels alone are never treated as proof of a remote owner.
  const recoveryCoordinator = new RecoveryCoordinator(getSessionDir(settings), {
    onResult: (result) => {
      if (result.kept.length === 0) return;
      recoverResponsesBackgroundRuns(srv).then((err) => {
        if (err) {
          console.error(
            `Warning: failed to recover Responses background runs: ${err.message}`,
          );
        }
      });
    },
    onError: (err) => {
      console.error(`Warning: failed to recover orphaned runs: ${err.message}`);
    },
  });
  srv.recoveryCoordinator = recoveryCoordinator;
  try {
    await recoveryCoordinator.start();
  } catch (err) {
    console.error(
      `Warning: initial orphan recovery failed: ${(err as Error).message}`,
    );
  }

  // ESM objectives are user-controlled background work. Do not infer a new
  // execution request from an old persisted "active" row during serve startup:
  // a role may have failed before the process exited, and replaying it here
  // would silently re-run the user's task. Create/Edit/ResumeESM are the
  // explicit execution entry points.
  // Other local entry points (CLI, TUI, ACP) publish only advisory UDP
  // wake-ups after durable state changes. Re-read SQLite before broadcasting so
  // a lost, duplicated, or forged datagram can never change runtime state.
  const stopLeaseNotifications = subscribeRuntimeLeaseNotifications(
    (notification) => {
      switch (notification.type) {
        case "acquired":
        case "released":
        case "lost":
        case "state_changed":
          recoveryCoordinator.wake();
          void publishExternalSessionUpdate(srv, notification.sessionId ?? "");
          break;
      }
    },
  );

  let shutdownDone = false;
  const shutdownStack = async (): Promise<void> => {
    if (shutdownDone) return;
    shutdownDone = true;
    await shutdownESMFn(srv)();
    const window = AbortSignal.timeout(shutdownTimeoutMs);
    const poolErr = await pool.shutdown(window);
    if (poolErr) {
      throw new Error(`session shutdown error: ${poolErr.message}`);
    }
    stopLeaseNotifications();
    await recoveryCoordinator.stop();
  };

  wireRunServer(srv);

  if (opts.onReady) opts.onReady(srv);

  // Build routes
  const mux = new ServeMux();
  registerRoutes(mux, srv, {
    disableAPI: opts.disableAPI,
    chatCompletions: (server, request) =>
      handleChatCompletions(server, request),
    extraRoutes: opts.extraRoutes,
  });

  // Apply middleware stack (inside-out)
  let handler: HTTPHandler = (request) => mux.dispatch(request);
  handler = concurrencyMiddleware(cfg.maxConcurrentReqs ?? 0, handler);
  handler = corsMiddleware(cfg.cors ?? { enabled: false }, handler);
  handler = loggingMiddleware(handler);

  // Auth middleware wraps everything except health and the narrow public Web UI
  // bootstrap/login endpoints. Web UI assets must remain reachable so users can
  // enter an auth token; all management APIs and WebSocket streams stay protected.
  const authMux = new ServeMux();
  authMux.handle(
    "/health",
    loggingMiddleware((request: Request) => handleHealth(srv, request)),
  );
  authMux.handle(
    "/api/auth/login",
    loggingMiddleware(webUILoginHandlerForConfig(() => srv.authConfig())),
  );
  authMux.handle(
    "/api/auth/status",
    loggingMiddleware(webUIAuthStatusHandlerForConfig(() => srv.authConfig())),
  );
  authMux.handle(
    "/api/auth/logout",
    loggingMiddleware(webUILogoutHandler()),
  );
  authMux.handle(
    "/",
    authMiddlewareForConfig(() => srv.authConfig(), handler),
  );

  return {
    srv,
    cfg,
    handler: (request) => authMux.dispatch(request),
    shutdown: shutdownStack,
  };
}

/**
 * wireRunServer installs the Server-bound hook halves Go implements as
 * concrete methods: the slash-command cluster, the ESM coordinator, the
 * expert identity transition, and the Responses background coordinator.
 */
function wireRunServer(srv: Server): void {
  srv.handleCommand ??= handleCommandFn(srv);
  wireESMCoordinator(srv);
  wireExpertAPI(srv);
  srv.executeResponsesBackgroundRun ??= executeResponsesBackgroundRunFn(srv);
  srv.submitExternalResponsesBackground ??= submitExternalResponsesBackgroundFn(
    srv,
  );
}

/**
 * serveListenOptions converts a Go-style listen address into Deno.serve
 * options. An empty host listens on every interface; the default port
 * matches the config default.
 */
export function serveListenOptions(
  addr: string,
): { hostname?: string; port: number } {
  const parsed = splitHostPort(addr.trim());
  const port = parsed?.port ? Number(parsed.port) : 7872;
  const hostname = parsed?.host
    ? parsed.host.replace(/^\[(.*)\]$/, "$1")
    : undefined;
  return { hostname, port };
}

/**
 * run ports Go's top-level openaiapi Run(): assemble the stack, print the
 * startup banner, serve until a shutdown request or a process signal, then
 * terminate gracefully within the bounded window.
 */
export async function run(opts: RunOptions, version: string): Promise<void> {
  setVerbose(opts.verbose ?? opts.debug ?? false);

  const stack = await buildRunStack(opts, version);
  const { cfg, srv } = stack;

  const { hostname, port } = serveListenOptions(getListenAddr(cfg));
  const controller = new AbortController();
  let shutdownRequested = false;
  let server: Deno.HttpServer | undefined;
  const requestShutdown = (signal?: string): void => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    if (signal) {
      console.error(`\nReceived ${signal}, shutting down...`);
    }
    if (server) {
      try {
        server.shutdown();
      } catch {
        // The listener may already be closed.
      }
    } else {
      // The listener never started (or was not created yet); aborting the
      // serve signal unblocks a pending start.
      controller.abort();
    }
  };

  const signalDisposers: Array<() => void> = [];
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    const listener = () => requestShutdown(sig);
    try {
      Deno.addSignalListener(sig, listener);
      signalDisposers.push(() => {
        try {
          Deno.removeSignalListener(sig, listener);
        } catch {
          // The listener may already be gone during teardown.
        }
      });
    } catch {
      // The signal is unsupported on this platform (e.g. Windows SIGTERM).
    }
  }
  if (opts.shutdown) {
    const external = opts.shutdown;
    if (external.aborted) requestShutdown();
    else {
      external.addEventListener("abort", () => requestShutdown(), {
        once: true,
      });
    }
  }

  let serveErr: Error | undefined;
  try {
    server = Deno.serve(
      { hostname, port, signal: controller.signal },
      (request) => stack.handler(request),
    );
  } catch (err) {
    serveErr = new Error(`server error: ${(err as Error).message}`);
  }
  for (const dispose of signalDisposers) dispose();

  if (!serveErr) {
    printServeBanner(srv, cfg, version);
    try {
      await server!.finished;
    } catch (err) {
      if (!shutdownRequested) {
        serveErr = new Error(`server error: ${(err as Error).message}`);
      }
    }
  }
  try {
    await stack.shutdown();
  } catch (err) {
    if (serveErr) throw serveErr;
    throw err;
  }
  if (serveErr) throw serveErr;
}

/** printServeBanner ports Go's startup log block. */
function printServeBanner(srv: Server, cfg: Config, version: string): void {
  const listen = getListenAddr(cfg);
  console.error(`MothX Serve API ${version} starting on ${listen}`);
  console.error(
    `  Provider: ${srv.providerName} | Model: ${
      srv.model?.id ?? ""
    } | Mode: ${cfg.defaultMode}`,
  );
  console.error(`  WorkDir: ${getWorkDir(cfg)}`);
  if (cfg.auth?.enabled) {
    console.error(`  Auth: enabled (${cfg.auth.tokens?.length ?? 0} tokens)`);
  } else {
    console.error("  Auth: disabled");
  }
  const warning = apiSecurityWarning(cfg);
  if (warning !== "") {
    console.error(`  WARNING: ${warning}`);
  }
  if (cfg.sandbox?.enabled) {
    console.error(`  Sandbox: enabled (level: ${cfg.sandbox.level})`);
  }
  if (cfg.enableSubAgents) console.error("  Sub-Agents: enabled");
  if (cfg.enableDelegate) console.error("  Delegate: enabled");
  if (cfg.enableWorkflows) console.error("  Workflows: enabled");
  if (cfg.enableWebSearch) console.error("  Web search: enabled");
  if (cfg.enableBrowser) console.error("  Browser: enabled");
  if (cfg.enableArtifact) console.error("  Artifacts: enabled");
  if (cfg.enableA2AMaster) console.error("  A2A master: enabled");
  console.error(
    `  Tool visibility: ${cfg.toolVisibility?.mode} | System prompt: ${cfg.systemPromptMode}`,
  );
  console.error("\nReady to serve.");
}
