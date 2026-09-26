// The `opensac core` service host. The command owns the process-level Core
// lifecycle (settings, lock, registration, HTTP listener, and cleanup); the
// Core server itself deliberately owns only the listener.

import {
  configDir,
  defaultSettings,
  loadSettings,
  type Settings,
} from "../config/mod.ts";
import {
  type CoreSettings,
  resolveCoreConfig,
  type ResolvedCoreConfig,
} from "../core/config.ts";
import {
  CoreClient,
  CoreClientRpcError,
  type CoreDiscoveryResult,
  processLiveness,
  waitForRegistrationExit,
} from "../core/client.ts";
import { type CoreShutdownResult } from "../core/protocol.ts";
import {
  registrationConnectHost,
  registrationMatchesConfiguredEndpoint,
} from "../core/endpoint.ts";
import { CoreLock, CoreLockBusyError } from "../core/lock.ts";
import { CorePaths } from "../core/paths.ts";
import { type CoreRegistration, CoreRegistry } from "../core/registry.ts";
import { CoreEventStream } from "../core/event_stream.ts";
import { createSQLiteCronStore } from "../cron/sqlite_store.ts";
import { createScheduler, type Scheduler } from "../cron/scheduler.ts";
import {
  createKnowledgeBaseService,
  defaultKnowledgeBaseIndexPolicy,
  type KnowledgeBaseService,
} from "../agentruntime/knowledgebase.ts";
import { runKnowledgeBaseCronJob } from "../agentruntime/knowledge_cron.ts";
import {
  CORE_PROTOCOL_VERSION,
  CoreServer,
  type CoreServerHandle,
  type CoreServerOptions,
  type CoreServerStartFailure,
  isCoreServerStartFailure,
} from "../core/server.ts";
import { SOURCE_UNKNOWN } from "../agentruntime/source.ts";
import { current as currentVersion } from "../version/version.ts";
import type { CoreRuntimeHost } from "../core/runtime.ts";

/** Options that can override process/environment-derived Core inputs. */
export interface CoreCommandOptions {
  /** A resolved (or partial) Core configuration override. */
  config?: ResolvedCoreConfig | CoreSettings;
  /** State root containing core.json and core.lock. */
  stateDir?: string;
  /** Product version recorded by the Core and its clients. */
  version?: string;
  /** Core application protocol version recorded by the service. */
  protocolVersion?: number;
  /** Cancels startup work. Normal shutdown uses the returned handle. */
  signal?: AbortSignal;
}

/** The small lifecycle surface used by callers and by the Cliffy action. */
export interface CoreCommandHandle {
  /** The URL exposed by the running Core HTTP server. */
  readonly url: string;
  /**
   * Stops the server and releases registration/lock ownership. A cleanup
   * failure rejects this promise; the handle's `done` promise still exposes
   * exit code 1 and ownership is retained when shutdown is uncertain.
   */
  stop(): Promise<void>;
  /** Resolves with 0 on clean shutdown or 1 if cleanup failed. */
  readonly done: Promise<number>;
}

type MaybePromise<T> = T | Promise<T>;

interface CoreLockLike {
  release(): MaybePromise<void>;
  /** Returns whether this exact lock token still owns the lock directory. */
  isCurrent?(): MaybePromise<boolean>;
}

interface CoreRegistryLike {
  write(
    registration: CoreRegistration,
    signal?: AbortSignal,
  ): MaybePromise<void>;
  remove(id: string, signal?: AbortSignal): MaybePromise<void>;
  isCurrent?(registration: CoreRegistration): MaybePromise<boolean>;
}

interface CoreServerLike {
  start(signal?: AbortSignal): MaybePromise<CoreServerHandle>;
}

type CoreServerStartable = CoreServerLike | CoreServerHandle;

/** A factory or already-created Core server. */
export type CoreServerFactory =
  | CoreServerStartable
  | ((
    options: CoreServerOptions,
    signal?: AbortSignal,
  ) => CoreServerStartable | Promise<CoreServerStartable>);

/** Inputs used by the identity-safe discovery seam. */
export interface CoreCommandDiscoveryOptions {
  paths: CorePaths;
  stateDir: string;
  config: ResolvedCoreConfig;
  version: string;
  protocolVersion: number;
}

/** Injectable process and filesystem seams used by the command. */
export interface CoreCommandDependencies {
  /** Load settings when options.config is not supplied. */
  loadSettings?: (signal?: AbortSignal) => MaybePromise<Settings>;
  /** Optional settings value for callers that already loaded them. */
  settings?: Settings;
  /** Default state root when options.stateDir is not supplied. */
  stateDir?: string | (() => string);
  /** Optional CorePaths factory, primarily for focused tests. */
  createPaths?: (stateDir: string) => CorePaths;
  /** Alias for createPaths. */
  paths?: (stateDir: string) => CorePaths;
  /** Acquire the process-level Core lock. */
  acquireLock?: (
    paths: CorePaths,
    signal?: AbortSignal,
  ) => MaybePromise<CoreLockLike>;
  /** Alias for acquireLock, useful to callers that name the resource. */
  lockAcquire?: (
    paths: CorePaths,
    signal?: AbortSignal,
  ) => MaybePromise<CoreLockLike>;
  /** Alias for acquireLock. */
  createLock?: (
    paths: CorePaths,
    signal?: AbortSignal,
  ) => MaybePromise<CoreLockLike>;
  /** Object-shaped lock dependency, matching the CoreLock class API. */
  lock?:
    | {
      acquire(
        paths: CorePaths,
        signal?: AbortSignal,
      ): MaybePromise<CoreLockLike>;
    }
    | ((
      paths: CorePaths,
      signal?: AbortSignal,
    ) => MaybePromise<CoreLockLike>);
  /** Create a registry facade for the paths. */
  registry?: CoreRegistryLike | ((paths: CorePaths) => CoreRegistryLike);
  /** Alias for registry. */
  registryFactory?: (paths: CorePaths) => CoreRegistryLike;
  /** Alias for registry. */
  createRegistry?: (paths: CorePaths) => CoreRegistryLike;
  /** Create/start a Core HTTP server. */
  createServer?: CoreServerFactory;
  /** Alias for createServer. */
  server?: CoreServerFactory;
  /** Alias for createServer. */
  startServer?: CoreServerFactory;
  /** Identity-safe discovery seam used by reuse and bind diagnostics. */
  discoverCore?: (
    options: CoreCommandDiscoveryOptions,
    signal?: AbortSignal,
  ) => MaybePromise<CoreDiscoveryResult>;
  /** Alias for discoverCore. */
  discover?: (
    options: CoreCommandDiscoveryOptions,
    signal?: AbortSignal,
  ) => MaybePromise<CoreDiscoveryResult>;
  /**
   * Optional additional probe applied only after identity-safe discovery says
   * ready. It cannot turn an unrelated endpoint into a healthy Core.
   */
  probeRegisteredCore?: (
    paths: CorePaths,
    config: ResolvedCoreConfig,
  ) => MaybePromise<boolean>;
  /** Version used when options.version is absent. */
  version?: string;
  /** Application protocol version used when options.protocolVersion is absent. */
  protocolVersion?: number;
  /** Clock used for registration.startedAt. */
  now?: () => number;
  /** PID used for registration.pid. */
  pid?: number;
  /** Registration ID factory. */
  createId?: () => string;
  /** Ownership monitor interval; a small value is useful in lifecycle tests. */
  ownershipMonitorIntervalMs?: number;
  /** Signal used when options.signal is absent. */
  signal?: AbortSignal;
  /** Signal registration seam for lifecycle tests and restricted runtimes. */
  addSignalListener?: (
    signal: "SIGINT" | "SIGTERM",
    handler: () => void,
  ) => void;
  removeSignalListener?: (
    signal: "SIGINT" | "SIGTERM",
    handler: () => void,
  ) => void;
}

/** Short alias retained for callers that prefer the shorter name. */
export type CoreCommandDeps = CoreCommandDependencies;

const SIGNALS = ["SIGINT", "SIGTERM"] as const;
type CoreSignal = (typeof SIGNALS)[number];

function createLazyProductionRuntimeHost(
  settings: Settings,
  eventSink: (event: import("../core/runtime.ts").CoreRuntimeEvent) => void,
  reverseRequest: import("../core/runtime.ts").CoreReverseRequest,
): CoreRuntimeHost {
  let hostPromise: Promise<CoreRuntimeHost> | undefined;
  let runtimeHost: CoreRuntimeHost | undefined;
  let cronScheduler: Scheduler | undefined;
  let knowledgeService: KnowledgeBaseService | undefined;

  const runCron = async (
    job: import("../cron/cron.ts").CronJob,
    signal: AbortSignal,
  ): Promise<string> => {
    if (signal.aborted) throw new Error("cron run aborted");
    const current = runtimeHost ?? await load();
    const session = job.sessionId
      ? await current.openSession({ sessionId: job.sessionId })
      : await current.createSession({
        workDir: job.workDir ?? Deno.cwd(),
      });
    try {
      const accepted = await current.prompt({
        sessionId: session.sessionId,
        text: job.prompt ?? "",
      });
      let response = "";
      for await (
        const event of current.subscribeRunEvents(
          session.sessionId,
          accepted.runId,
        )
      ) {
        if (event.eventType === "text_delta") {
          const text = event.payload.text;
          if (typeof text === "string") response += text;
        }
      }
      return response;
    } finally {
      if (!job.sessionId) {
        await current.closeSession({
          sessionId: session.sessionId,
        });
      }
    }
  };

  const triggerCron = (id: string, _signal: AbortSignal): void => {
    if (cronScheduler === undefined) {
      throw new Error("cron runtime is unavailable");
    }
    cronScheduler.runNow(id);
  };

  const load = (): Promise<CoreRuntimeHost> => {
    hostPromise ??= import("../core/runtime_host.ts").then(async (module) => {
      const runtime = await module.createCoreRuntimeHost({
        source: SOURCE_UNKNOWN,
        workDir: Deno.cwd(),
        settings,
        providerName: settings.defaultProvider ?? "",
        modelID: settings.defaultModel ?? "",
        dependencies: module.createProductionCoreRuntimeDependencies(settings),
        extension: module.createProductionCoreExtensionHandler(settings, {
          runCronJob: runCron,
          triggerCronJob: triggerCron,
          cronRunning: () => cronScheduler?.isRunning() ?? false,
          knowledgeServiceFactory: (currentSettings) =>
            knowledgeService ??= createKnowledgeBaseService(
              currentSettings.sessionDir ?? "",
              defaultKnowledgeBaseIndexPolicy(),
              currentSettings,
            ),
          setSessionSkill: async (sessionId, name, active) => {
            const host = runtimeHost;
            if (host === undefined) {
              throw new Error("core runtime host is unavailable");
            }
            if (host.setSessionSkill === undefined) {
              throw new Error("core session skill control is unavailable");
            }
            return await host.setSessionSkill({ sessionId, name, active });
          },
          getSessionSkillState: async (sessionId) => {
            const host = runtimeHost;
            if (host === undefined || host.getSessionSkillState === undefined) {
              throw new Error("core session skill state is unavailable");
            }
            return await host.getSessionSkillState({ sessionId });
          },
        }),
        eventSink,
        reverseRequest,
      });
      runtimeHost = runtime;
      const store = createSQLiteCronStore(settings.sessionDir ?? "");
      const scheduler = createScheduler(
        store,
        null,
        30_000,
        settings.sessionDir ?? "",
        async (job, signal) => {
          const jobSignal = signal ?? new AbortController().signal;
          try {
            const knowledge = await runKnowledgeBaseCronJob(
              jobSignal,
              knowledgeService ??= createKnowledgeBaseService(
                settings.sessionDir ?? "",
                defaultKnowledgeBaseIndexPolicy(),
                settings,
              ),
              job.id ?? "",
            );
            if (knowledge.handled) {
              return {
                handled: true,
                response: knowledge.response,
                error: null,
              };
            }
            return {
              handled: true,
              response: await runCron(job, jobSignal),
              error: null,
            };
          } catch (error) {
            return {
              handled: true,
              response: "",
              error: error instanceof Error ? error : new Error(String(error)),
            };
          }
        },
      );
      cronScheduler = scheduler;
      scheduler.start();
      return runtime;
    });
    return hostPromise;
  };
  const facade: CoreRuntimeHost = {
    extension: (method, params, signal) =>
      load().then((runtime) => {
        if (runtime.extension === undefined) {
          throw new Error("Core production extension handler is unavailable");
        }
        return runtime.extension(method, params, signal);
      }),
    createSession: (input) =>
      load().then((runtime) => runtime.createSession(input)),
    openSession: (input) =>
      load().then((runtime) => runtime.openSession(input)),
    closeSession: (input) =>
      load().then((runtime) => runtime.closeSession(input)),
    deleteSession: (input) =>
      load().then((runtime) => runtime.deleteSession(input)),
    listSessionSkills: (input) =>
      load().then((runtime) => runtime.listSessionSkills(input)),
    prepareInput: (input) =>
      load().then((runtime) => runtime.prepareInput(input)),
    sessionCapabilities: (input) =>
      load().then((runtime) => runtime.sessionCapabilities(input)),
    sessionContext: (input) =>
      load().then((runtime) => runtime.sessionContext(input)),
    setSessionContext: (input) =>
      load().then((runtime) => runtime.setSessionContext(input)),
    listExperts: (input) =>
      load().then((runtime) => runtime.listExperts(input)),
    inspectExpert: (input) =>
      load().then((runtime) => runtime.inspectExpert(input)),
    expertState: (input) =>
      load().then((runtime) => runtime.expertState(input)),
    setExpert: (input) => load().then((runtime) => runtime.setExpert(input)),
    forkSession: (input) =>
      load().then((runtime) => runtime.forkSession(input)),
    listAgents: (input) => load().then((runtime) => runtime.listAgents(input)),
    destroyAgent: (input) =>
      load().then((runtime) => runtime.destroyAgent(input)),
    setDelegate: (input) =>
      load().then((runtime) => runtime.setDelegate(input)),
    delegateState: (input) =>
      load().then((runtime) => runtime.delegateState(input)),
    setSessionCapability: (input) =>
      load().then((runtime) => runtime.setSessionCapability(input)),
    esmState: (input) => load().then((runtime) => runtime.esmState(input)),
    esmUpdate: (input) => load().then((runtime) => runtime.esmUpdate(input)),
    esmContinue: (input) =>
      load().then((runtime) => runtime.esmContinue(input)),
    esmStop: (input) => load().then((runtime) => runtime.esmStop(input)),
    transientPrompt: (input) =>
      load().then((runtime) => runtime.transientPrompt(input)),
    compact: (input) => load().then((runtime) => runtime.compact(input)),
    settingsDocument: (input) =>
      load().then((runtime) => runtime.settingsDocument(input)),
    updateSettingsDocument: (input) =>
      load().then((runtime) => runtime.updateSettingsDocument(input)),
    providerCatalog: (input) =>
      load().then((runtime) => runtime.providerCatalog(input)),
    validateProviderModel: (input) =>
      load().then((runtime) => runtime.validateProviderModel(input)),
    envDocument: () => load().then((runtime) => runtime.envDocument()),
    updateEnvDocument: (input) =>
      load().then((runtime) => runtime.updateEnvDocument(input)),
    history: (input) => load().then((runtime) => runtime.history(input)),
    prompt: (input) => load().then((runtime) => runtime.prompt(input)),
    cancelRun: (input) => load().then((runtime) => runtime.cancelRun(input)),
    getRun: (input) => load().then((runtime) => runtime.getRun(input)),
    listSessions: () => load().then((runtime) => runtime.listSessions()),
    listPersistedSessions: (input) =>
      load().then((runtime) => runtime.listPersistedSessions(input)),
    setSessionConfig: (input) =>
      load().then((runtime) => runtime.setSessionConfig(input)),
    setSessionSkill: (input) =>
      load().then((runtime) => {
        if (runtime.setSessionSkill === undefined) {
          throw new Error("core session skill control is unavailable");
        }
        return runtime.setSessionSkill(input);
      }),
    subscribeRunEvents: (sessionId, runId, cursor = 0) =>
      (async function* () {
        const runtime = await load();
        yield* runtime.subscribeRunEvents(sessionId, runId, cursor);
      })(),
    close: async () => {
      const scheduler = cronScheduler;
      cronScheduler = undefined;
      if (scheduler !== undefined) await scheduler.stop();
      if (hostPromise !== undefined) await (await hostPromise).close();
    },
  };
  return facade;
}

/**
 * Starts the shared Core and returns only after its registration is published.
 * All cleanup is owned by the returned handle; callers must await `done` (or
 * `stop`) before treating the state root as released.
 */
export async function startCoreCommand(
  options: CoreCommandOptions = {},
  deps: CoreCommandDependencies = {},
): Promise<CoreCommandHandle> {
  const signal = options.signal ?? deps.signal;
  throwIfAborted(signal);

  const settings = await resolveCommandSettings(options, deps, signal);
  throwIfAborted(signal);
  const resolvedConfig = resolveCoreConfig(settings);
  const stateDir = resolveStateDir(options, deps);
  const paths = (deps.createPaths ?? deps.paths ?? CorePaths.fromStateDir)(
    stateDir,
  );
  const version = resolveVersion(options, deps);
  const protocolVersion = resolveProtocolVersion(options, deps);
  const registry = resolveRegistry(paths, deps);
  const acquireLock = resolveLockAcquirer(deps);

  // Read and validate an existing registration before attempting the
  // exclusive lock. A healthy Core owns that lock for its entire lifetime, so
  // acquiring first would make the normal reuse path unreachable.
  let preflight: CoreDiscoveryResult | undefined;
  let preflightError: unknown;
  try {
    preflight = await discoverExistingCore(
      {
        paths,
        stateDir: paths.stateDir,
        config: resolvedConfig,
        version,
        protocolVersion,
      },
      deps,
      signal,
      false,
    );
  } catch (error) {
    preflightError = error;
  }

  if (preflight?.status === "ready") {
    if (
      !registrationMatchesConfiguredEndpoint(
        preflight.registration,
        resolvedConfig,
      )
    ) {
      preflightError = new Error(
        "Registered Core endpoint does not match the configured endpoint; refusing to reuse it",
      );
    } else {
      try {
        throwIfAborted(signal);
        return borrowedCoreHandle(preflight.url);
      } catch (error) {
        preflightError = error;
      }
    }
  }

  let lock: CoreLockLike;
  try {
    lock = await acquireLock(paths, signal);
  } catch (error) {
    // A contender can lose the lock race after its preflight read. Re-read
    // once before surfacing the lock error so a healthy Core is still reused.
    if (isCoreLockBusyError(error)) {
      const raced = await discoverForLockRace(
        {
          paths,
          stateDir: paths.stateDir,
          config: resolvedConfig,
          version,
          protocolVersion,
        },
        deps,
        signal,
        preflightError,
      );
      if (raced !== undefined) return raced;
    }
    if (preflightError !== undefined && !isCoreLockBusyError(error)) {
      throw preflightError;
    }
    throw error;
  }

  if (preflightError !== undefined) {
    return await failAfterLock(preflightError, lock);
  }

  let existing: CoreDiscoveryResult;
  try {
    // Once the lock is held, endpoint identity is authoritative even when a
    // registration carries a stale/reused PID. The preflight path remains
    // conservative for callers that do not own the lock.
    existing = await discoverExistingCore(
      {
        paths,
        stateDir: paths.stateDir,
        config: resolvedConfig,
        version,
        protocolVersion,
      },
      deps,
      signal,
      true,
    );
  } catch (error) {
    return await failAfterLock(error, lock);
  }

  if (existing.status === "ready") {
    if (
      registrationMatchesConfiguredEndpoint(
        existing.registration,
        resolvedConfig,
      )
    ) {
      await releaseTemporaryLock(lock, signal);
      return borrowedCoreHandle(existing.url);
    }
    // A fixed-endpoint mismatch is not safe to reuse, but it is still a
    // useful diagnostic path: attempt the configured bind so the typed
    // address-in-use classifier can distinguish a live same-port Core from an
    // unrelated process. A real live Core would have kept the lock, so this
    // branch is reachable mainly after a stale registration race.
  }

  if (existing.status === "incompatible") {
    return await failAfterLock(
      new Error(
        "A registered Core is already running but incompatible; refusing to replace it",
        { cause: existing.error },
      ),
      lock,
    );
  }
  if (existing.status === "unauthenticated") {
    return await failAfterLock(
      new Error(
        "A registered Core requires different authentication; refusing to replace it",
        { cause: existing.error },
      ),
      lock,
    );
  }

  let server: CoreServerHandle | undefined;
  let registrationId: string | undefined;
  let registration: CoreRegistration | undefined;
  let startupUncertain: CoreServerStartFailure | undefined;
  // Resolved by a `core.shutdown` request. ownedCoreHandle turns it into the
  // same idempotent stop used for signals so cleanup stays single-path:
  // server stop, runtime shutdown, registration removal, lock release.
  const stopRequested = deferred<void>();

  try {
    throwIfAborted(signal);
    const events = new CoreEventStream();
    const serverOptions: CoreServerOptions = {
      config: resolvedConfig,
      version,
      protocolVersion,
      events,
      onShutdown: () => stopRequested.resolve(),
      runtime: createLazyProductionRuntimeHost(
        settings,
        (event) => events.publish(event),
        (id, method, params) => events.request(id, method, params),
      ),
    };

    try {
      server = await startServer(serverOptions, deps, signal);
    } catch (error) {
      startupUncertain = getServerStartFailure(error);
      if (startupUncertain !== undefined) throw error;
      throw await portConflictError(
        error,
        resolvedConfig,
        paths,
        deps,
        { version, protocolVersion },
        signal,
        existing.status === "ready" ? existing : undefined,
      );
    }
    throwIfAborted(signal);

    const id = createRegistrationId(deps);
    registrationId = id;
    registration = {
      id,
      version,
      protocolVersion,
      pid: deps.pid ?? Deno.pid,
      host: resolvedConfig.host,
      connectHost: registrationConnectHost(resolvedConfig.host),
      port: server.address.port,
      startedAt: (deps.now ?? Date.now)(),
    };
    await registry.write(registration, signal);
    // Registration is the publication boundary. Once it succeeds, hand off
    // the owned handle even if cancellation arrives before the caller assigns
    // it; runCoreCommand will observe the signal and perform normal stop.
  } catch (error) {
    const cleanupErrors = await cleanupFailedStartup(
      server,
      registry,
      registrationId,
      lock,
      startupUncertain,
    );
    if (cleanupErrors.length > 0) {
      throw aggregateErrors(
        [error, ...cleanupErrors],
        "Core startup and cleanup failed; ownership was retained when uncertain",
      );
    }
    throw error;
  }

  return ownedCoreHandle(
    server,
    registry,
    registration,
    lock,
    deps.ownershipMonitorIntervalMs,
    stopRequested.promise,
  );
}

/**
 * Runs the command as a long-lived process. Both termination signals abort
 * startup and request the same idempotent stop; the returned value is the
 * numeric lifecycle exit code, not a handle.
 */
export async function runCoreCommand(
  options: CoreCommandOptions = {},
  deps: CoreCommandDependencies = {},
): Promise<number> {
  const controller = new AbortController();
  const externalSignal = options.signal ?? deps.signal;
  let handle: CoreCommandHandle | undefined;
  const relayExternalAbort = (): void => {
    controller.abort(externalSignal?.reason);
    if (handle !== undefined) void handle.stop().catch(() => undefined);
  };
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) relayExternalAbort();
    else {externalSignal.addEventListener("abort", relayExternalAbort, {
        once: true,
      });}
  }

  const addSignal = deps.addSignalListener ?? defaultAddSignalListener;
  const removeSignal = deps.removeSignalListener ?? defaultRemoveSignalListener;
  const onSignal = (): void => {
    controller.abort();
    if (handle !== undefined) void handle.stop().catch(() => undefined);
  };

  for (const signal of SIGNALS) {
    try {
      addSignal(signal, onSignal);
    } catch {
      // Some restricted runtimes do not expose process signal listeners.
    }
  }

  try {
    try {
      handle = await startCoreCommand(
        { ...options, signal: controller.signal },
        deps,
      );
    } catch (error) {
      if (
        controller.signal.aborted &&
        (isAbortError(error) || error === controller.signal.reason)
      ) {
        return 1;
      }
      throw error;
    }

    if (controller.signal.aborted) {
      try {
        await handle.stop();
      } catch {
        // `done` carries the non-clean exit code; direct callers can observe
        // the aggregate error from stop().
      }
    }
    return await handle.done;
  } finally {
    for (const signal of SIGNALS) {
      try {
        removeSignal(signal, onSignal);
      } catch {
        // Optional signal-hook cleanup must not mask lifecycle completion.
      }
    }
    externalSignal?.removeEventListener("abort", relayExternalAbort);
  }
}

/** Options for `opensac core stop`. */
export interface CoreStopOptions {
  /** A resolved (or partial) Core configuration override. */
  config?: ResolvedCoreConfig | CoreSettings;
  /** State root containing core.json and core.lock. */
  stateDir?: string;
  /** Product version recorded by the Core and its clients. */
  version?: string;
  /** Core application protocol version recorded by the service. */
  protocolVersion?: number;
  /** Cancels discovery, shutdown, and exit waiting. */
  signal?: AbortSignal;
  /** Bounded wait for the stopped Core to exit; defaults to 15 seconds. */
  stopTimeoutMs?: number;
}

/** Result of an `opensac core stop` run. */
export interface CoreStopOutcome {
  /** "stopped" when a running Core was asked to exit; "absent" when none ran. */
  status: "stopped" | "absent";
  /** True when the Core process was observed exiting within the wait budget. */
  exited: boolean;
  /** True when the registered process was signalled instead of `core.shutdown`. */
  signalled: boolean;
}

/** The client surface `core stop` needs from `CoreClient`. */
export interface CoreStopClient {
  discover(signal?: AbortSignal): Promise<CoreDiscoveryResult>;
  shutdown(signal?: AbortSignal): Promise<CoreShutdownResult>;
  close(): Promise<void>;
}

/** Identity inputs for the lifecycle client created by `core stop`. */
export interface CoreStopClientOptions {
  paths: CorePaths;
  config: ResolvedCoreConfig;
  version: string;
  protocolVersion: number;
  signal?: AbortSignal;
}

/** The registry surface `core stop` needs for exit observation and identity. */
export interface CoreStopRegistryLike {
  read(): MaybePromise<CoreRegistration | undefined>;
  isCurrent?(registration: CoreRegistration): MaybePromise<boolean>;
}

/** Injectable process and filesystem seams used by `core stop`. */
export interface CoreStopDependencies {
  /** Load settings when options.config is not supplied. */
  loadSettings?: (signal?: AbortSignal) => MaybePromise<Settings>;
  /** Optional settings value for callers that already loaded them. */
  settings?: Settings;
  /** Default state root when options.stateDir is not supplied. */
  stateDir?: string | (() => string);
  /** Optional CorePaths factory, primarily for focused tests. */
  createPaths?: (stateDir: string) => CorePaths;
  /** Alias for createPaths. */
  paths?: (stateDir: string) => CorePaths;
  /** Registry facade used for registration identity and exit observation. */
  registry?:
    | CoreStopRegistryLike
    | ((paths: CorePaths) => CoreStopRegistryLike);
  /** Alias for registry. */
  createRegistry?: (paths: CorePaths) => CoreStopRegistryLike;
  /** Create the lifecycle client used for discovery and shutdown. */
  createClient?: (
    options: CoreStopClientOptions,
  ) => MaybePromise<CoreStopClient>;
  /** Sends a termination signal to a verified local Core process. */
  kill?: (pid: number, signal: "SIGTERM") => void;
  /** Bounded wait used while observing a stopped Core's exit. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Signal used when options.signal is absent. */
  signal?: AbortSignal;
}

const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const EXIT_POLL_INTERVAL_MS = 100;

/**
 * Stops a running Core through `core.shutdown` and waits for it to exit.
 *
 * The SIGTERM fallback is deliberately narrow: it is only used when discovery
 * already verified the registered endpoint identity and the Core is an older
 * build that predates `core.shutdown`. A registration that cannot be verified
 * (stale endpoint, foreign authentication) fails closed with an actionable
 * error instead of signalling a process it cannot identify.
 */
export async function stopCoreCommand(
  options: CoreStopOptions = {},
  deps: CoreStopDependencies = {},
): Promise<CoreStopOutcome> {
  const signal = options.signal ?? deps.signal;
  throwIfAborted(signal);

  const settings = await resolveCommandSettings(
    options,
    { loadSettings: deps.loadSettings, settings: deps.settings },
    signal,
  );
  throwIfAborted(signal);
  const resolvedConfig = resolveCoreConfig(settings);
  const stateDir = resolveStateDir(options, { stateDir: deps.stateDir });
  const paths = (deps.createPaths ?? deps.paths ?? CorePaths.fromStateDir)(
    stateDir,
  );
  const version = resolveVersion(options, {});
  const protocolVersion = resolveProtocolVersion(options, {});
  const registry = resolveStopRegistry(paths, deps);
  const kill = deps.kill ?? ((pid, signalName) => Deno.kill(pid, signalName));

  const client = await (deps.createClient ?? createStopClient)({
    paths,
    config: resolvedConfig,
    version,
    protocolVersion,
    signal,
  });
  try {
    const discovery = await client.discover(signal);
    if (discovery.status === "missing") {
      return { status: "absent", exited: true, signalled: false };
    }
    const registration = "registration" in discovery
      ? discovery.registration
      : undefined;

    if (discovery.status === "stale") {
      if (
        registration === undefined ||
        processLiveness(registration.pid) === "dead"
      ) {
        return { status: "absent", exited: true, signalled: false };
      }
      throw new Error(
        `A registered Core process (PID ${registration.pid}) is not answering; stop it manually before restarting`,
        { cause: discovery.error },
      );
    }
    if (discovery.status === "unauthenticated") {
      throw new Error(
        `A registered Core${
          registration === undefined ? "" : ` (PID ${registration.pid})`
        } requires different authentication; fix core.passwords or stop it manually`,
        { cause: discovery.error },
      );
    }
    if (registration === undefined) {
      throw new Error("Registered Core has no registration identity");
    }

    // ready | incompatible: discovery reached the registered endpoint.
    let signalled = false;
    try {
      await client.shutdown(signal);
    } catch (error) {
      const replaceable = isMethodNotFound(error) &&
        await isCurrentRegistration(registry, registration);
      if (!replaceable) throw error;
      // Older Core builds predate `core.shutdown`. Their endpoint identity was
      // verified by discovery and SIGTERM is that process's clean stop path
      // (the same path as a terminal signal), so replacing them is safe once
      // the registration is still current.
      kill(registration.pid, "SIGTERM");
      signalled = true;
    }

    const exited = await waitForRegistrationExit(registry, registration, {
      timeoutMs: options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
      intervalMs: EXIT_POLL_INTERVAL_MS,
      sleep: deps.sleep,
      signal,
    });
    return { status: "stopped", exited, signalled };
  } finally {
    await client.close();
  }
}

function createStopClient(
  options: CoreStopClientOptions,
): CoreStopClient {
  return new CoreClient({
    stateDir: options.paths.stateDir,
    version: options.version,
    protocolVersion: options.protocolVersion,
    config: options.config,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

function resolveStopRegistry(
  paths: CorePaths,
  deps: CoreStopDependencies,
): CoreStopRegistryLike {
  if (deps.registry !== undefined) {
    return typeof deps.registry === "function"
      ? deps.registry(paths)
      : deps.registry;
  }
  if (deps.createRegistry !== undefined) return deps.createRegistry(paths);
  return new CoreRegistry(paths);
}

function isMethodNotFound(error: unknown): boolean {
  return error instanceof CoreClientRpcError && error.code === -32601;
}

/**
 * Registration identity is required before the destructive signal fallback.
 * A registry without an `isCurrent` probe cannot prove identity, so the
 * fallback fails closed in that case.
 */
async function isCurrentRegistration(
  registry: CoreStopRegistryLike,
  registration: CoreRegistration,
): Promise<boolean> {
  if (registry.isCurrent === undefined) return false;
  try {
    return await registry.isCurrent(registration);
  } catch {
    return false;
  }
}

async function resolveCommandSettings(
  options: CoreCommandOptions,
  deps: CoreCommandDependencies,
  signal?: AbortSignal,
): Promise<Settings> {
  if (options.config !== undefined) {
    return {
      ...defaultSettings(),
      core: options.config,
    } as Settings;
  }
  if (deps.settings !== undefined) return deps.settings;
  if (deps.loadSettings !== undefined) {
    return await awaitAbortable(
      Promise.resolve().then(() => deps.loadSettings!(signal)),
      signal,
    );
  }
  return loadSettings();
}

function resolveStateDir(
  options: CoreCommandOptions,
  deps: CoreCommandDependencies,
): string {
  if (options.stateDir !== undefined) return options.stateDir;
  if (typeof deps.stateDir === "string") return deps.stateDir;
  if (typeof deps.stateDir === "function") return deps.stateDir();
  return configDir();
}

function resolveVersion(
  options: CoreCommandOptions,
  deps: CoreCommandDependencies,
): string {
  const version = options.version ?? deps.version ??
    Deno.env.get("OPENSAC_CORE_VERSION") ?? currentVersion();
  if (typeof version !== "string" || version.trim() === "") {
    throw new TypeError("Core command version must be a non-empty string");
  }
  return version;
}

function resolveProtocolVersion(
  options: CoreCommandOptions,
  deps: CoreCommandDependencies,
): number {
  const protocolVersion = options.protocolVersion ?? deps.protocolVersion ??
    Number(
      Deno.env.get("OPENSAC_CORE_PROTOCOL_VERSION") ?? CORE_PROTOCOL_VERSION,
    );
  if (
    typeof protocolVersion !== "number" ||
    !Number.isInteger(protocolVersion) ||
    protocolVersion < 0
  ) {
    throw new TypeError(
      "Core command protocolVersion must be an integer >= 0",
    );
  }
  return protocolVersion;
}

function resolveRegistry(
  paths: CorePaths,
  deps: CoreCommandDependencies,
): CoreRegistryLike {
  if (deps.registry !== undefined) {
    if (typeof deps.registry === "function") return deps.registry(paths);
    return deps.registry;
  }
  if (deps.registryFactory !== undefined) return deps.registryFactory(paths);
  if (deps.createRegistry !== undefined) return deps.createRegistry(paths);
  return new CoreRegistry(paths);
}

function resolveLockAcquirer(
  deps: CoreCommandDependencies,
): (
  paths: CorePaths,
  signal?: AbortSignal,
) => MaybePromise<CoreLockLike> {
  if (deps.acquireLock !== undefined) return deps.acquireLock;
  if (deps.lockAcquire !== undefined) return deps.lockAcquire;
  if (deps.createLock !== undefined) return deps.createLock;
  if (typeof deps.lock === "function") return deps.lock;
  const lock = deps.lock;
  if (lock !== undefined) return (paths, signal) => lock.acquire(paths, signal);
  return (paths, signal) => CoreLock.acquire(paths, signal);
}

async function discoverExistingCore(
  options: CoreCommandDiscoveryOptions,
  deps: CoreCommandDependencies,
  signal?: AbortSignal,
  ignoreProcessLiveness = false,
): Promise<CoreDiscoveryResult> {
  const factory = deps.discoverCore ?? deps.discover;
  let result: CoreDiscoveryResult;
  if (factory !== undefined) {
    result = await awaitAbortable(
      Promise.resolve().then(() => factory(options, signal)),
      signal,
    );
  } else {
    const client = new CoreClient({
      stateDir: options.paths.stateDir,
      version: options.version,
      protocolVersion: options.protocolVersion,
      config: options.config,
      signal,
      ignoreProcessLiveness,
    });
    const pending = client.discover();
    void pending.catch(() => undefined);
    try {
      result = await awaitAbortable(pending, signal);
    } finally {
      await client.close();
    }
  }

  if (result.status === "ready") {
    verifyReadyIdentity(result, options);
    // CoreClient performs this check after its RPCs. Repeat it at the command
    // boundary so an injected discovery result or a registration replacement
    // cannot authorize reuse or bind-error classification.
    let current = false;
    try {
      current = await awaitAbortable(
        new CoreRegistry(options.paths).isCurrent(result.registration),
        signal,
      );
    } catch (error) {
      throw new Error("Core registration ownership could not be verified", {
        cause: error,
      });
    }
    if (!current) {
      throw new Error("Core registration changed during discovery");
    }
  }

  if (
    result.status === "ready" &&
    deps.probeRegisteredCore !== undefined
  ) {
    let probeResult: boolean;
    try {
      probeResult = await awaitAbortable(
        Promise.resolve().then(() =>
          deps.probeRegisteredCore!(options.paths, options.config)
        ),
        signal,
      );
    } catch {
      return staleDiscovery(result.registration, "Core health probe failed");
    }
    if (!probeResult) {
      return staleDiscovery(
        result.registration,
        "Core health probe rejected the registered endpoint",
      );
    }
  }
  return result;
}

async function discoverForLockRace(
  options: CoreCommandDiscoveryOptions,
  deps: CoreCommandDependencies,
  signal: AbortSignal | undefined,
  preflightError: unknown,
): Promise<CoreCommandHandle | undefined> {
  let result: CoreDiscoveryResult;
  try {
    result = await discoverExistingCore(options, deps, signal, false);
  } catch (error) {
    if (preflightError !== undefined) throw preflightError;
    throw error;
  }

  if (result.status === "ready") {
    if (
      !registrationMatchesConfiguredEndpoint(
        result.registration,
        options.config,
      )
    ) {
      throw new Error(
        "Registered Core endpoint does not match the configured endpoint; refusing to reuse it",
      );
    }
    return borrowedCoreHandle(result.url);
  }
  if (preflightError !== undefined) throw preflightError;
  if (result.status === "incompatible") {
    throw new Error(
      "A registered Core is already running but incompatible; refusing to replace it",
      { cause: result.error },
    );
  }
  if (result.status === "unauthenticated") {
    throw new Error(
      "A registered Core requires different authentication; refusing to replace it",
      { cause: result.error },
    );
  }
  // A stale/missing result after losing the lock race is not enough to claim
  // that the other process is healthy. Let the original lock error surface.
  return undefined;
}

function isCoreLockBusyError(error: unknown): boolean {
  return error instanceof CoreLockBusyError ||
    (error instanceof Error && error.name === "CoreLockBusyError");
}

function staleDiscovery(
  registration: CoreRegistration | undefined,
  reason: string,
): CoreDiscoveryResult {
  if (registration === undefined) return { status: "stale", reason };
  return { status: "stale", registration, reason };
}

function verifyReadyIdentity(
  result: Extract<CoreDiscoveryResult, { status: "ready" }>,
  options: CoreCommandDiscoveryOptions,
): void {
  const { registration, info } = result;
  if (
    registration.version !== options.version ||
    registration.protocolVersion !== options.protocolVersion ||
    info.version !== options.version ||
    info.protocolVersion !== options.protocolVersion ||
    info.coreProtocolVersion !== CORE_PROTOCOL_VERSION
  ) {
    throw new Error("Registered Core identity is incompatible");
  }
}

async function startServer(
  options: CoreServerOptions,
  deps: CoreCommandDependencies,
  signal?: AbortSignal,
): Promise<CoreServerHandle> {
  const source = deps.createServer ?? deps.startServer ?? deps.server;
  if (source === undefined) return await new CoreServer(options).start(signal);
  const value = typeof source === "function"
    ? await source(options, signal)
    : await source;
  if (isServerStartable(value)) return await value.start(signal);
  return value;
}

function isServerStartable(
  value: CoreServerStartable,
): value is CoreServerLike {
  return isObject(value) && "start" in value &&
    typeof value.start === "function";
}

function createRegistrationId(deps: CoreCommandDependencies): string {
  const value = deps.createId?.() ?? createUuid();
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("Core command registration id must be non-empty");
  }
  return value;
}

function createUuid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
}

function borrowedCoreHandle(url: string): CoreCommandHandle {
  const done = Promise.resolve(0);
  return {
    url,
    stop: () => Promise.resolve(),
    done,
  };
}

function ownedCoreHandle(
  server: CoreServerHandle,
  registry: CoreRegistryLike,
  registration: CoreRegistration,
  lock: CoreLockLike,
  monitorIntervalMs = 100,
  stopRequested?: Promise<void>,
): CoreCommandHandle {
  const done = deferred<number>();
  let stopPromise: Promise<void> | undefined;
  let stopping = false;
  let monitorTask: Promise<void> | undefined;
  const interval = normalizeMonitorInterval(monitorIntervalMs);
  const monitorTimer = interval === undefined ? undefined : setInterval(() => {
    if (stopping || monitorTask !== undefined) return;
    const task = checkOwnership().finally(() => {
      if (monitorTask === task) monitorTask = undefined;
    });
    monitorTask = task;
  }, interval);
  if (monitorTimer !== undefined) {
    // A monitor must never keep a test runner or an embedding process alive
    // after its owner has been explicitly stopped.
    try {
      Deno.unrefTimer(monitorTimer);
    } catch {
      // Older restricted runtimes may not expose timer unref.
    }
  }

  const stop = (): Promise<void> => {
    if (stopPromise !== undefined) return stopPromise;
    stopping = true;
    if (monitorTimer !== undefined) clearInterval(monitorTimer);
    stopPromise = (async () => {
      const errors: unknown[] = [];
      let serverStopped = false;
      try {
        await server.stop();
        serverStopped = true;
      } catch (error) {
        errors.push(error);
      }

      // A listener whose shutdown failed may still be alive. Retain both the
      // registration and lock until a later owner can prove it is safe.
      if (serverStopped) {
        try {
          await registry.remove(registration.id);
        } catch (error) {
          errors.push(error);
        }
      }
      if (serverStopped && errors.length === 0) {
        try {
          await lock.release();
        } catch (error) {
          errors.push(error);
        }
      }

      done.resolve(errors.length === 0 ? 0 : 1);
      if (errors.length > 0) {
        throw aggregateErrors(
          errors,
          "Core shutdown cleanup failed; ownership was retained when uncertain",
        );
      }
    })();
    return stopPromise;
  };

  const checkOwnership = async (): Promise<void> => {
    if (stopping) return;

    let registrationCurrent = true;
    try {
      registrationCurrent = registry.isCurrent === undefined
        ? true
        : await registry.isCurrent(registration);
    } catch {
      // A registration read that throws is not proof of ownership loss. Do
      // not consult the lock and destroy a still-owned process on uncertainty.
      return;
    }

    let lockCurrent = true;
    try {
      lockCurrent = lock.isCurrent === undefined
        ? true
        : await lock.isCurrent();
    } catch {
      // A known registration loss remains definitive even when the lock read
      // is unreadable. Stop through the same idempotent cleanup path; an
      // unknown registration result above still returns without stopping.
      if (registrationCurrent === false) {
        void stop().catch(() => undefined);
      }
      return;
    }

    if (registrationCurrent === false || lockCurrent === false) {
      // Only a definitive `false` ownership result invokes the destructive
      // stop path. Throws above remain uncertainty and are retried later.
      void stop().catch(() => undefined);
    }
  };

  if (stopRequested !== undefined) {
    // A `core.shutdown` request performs the same cleanup as a termination
    // signal; `done` then carries the lifecycle exit code to runCoreCommand.
    void stopRequested.then(() => stop().catch(() => undefined));
  }

  return { url: server.url, stop, done: done.promise };
}

function normalizeMonitorInterval(
  value: number | undefined,
): number | undefined {
  if (value === undefined) return 100;
  if (!Number.isFinite(value) || value < 0) return 100;
  if (value === 0) return undefined;
  return Math.max(1, value);
}

async function failAfterLock(
  error: unknown,
  lock: CoreLockLike,
): Promise<never> {
  try {
    await lock.release();
  } catch (cleanupError) {
    throw aggregateErrors(
      [error, cleanupError],
      "Core startup failed and lock cleanup also failed; ownership was retained",
    );
  }
  throw error;
}

async function releaseTemporaryLock(
  lock: CoreLockLike,
  signal?: AbortSignal,
): Promise<void> {
  await lock.release();
  throwIfAborted(signal);
}

function getServerStartFailure(
  error: unknown,
): CoreServerStartFailure | undefined {
  if (isCoreServerStartFailure(error)) return error;
  if (error instanceof AggregateError) {
    return { listenerMayBeAlive: true, cleanupError: error };
  }
  if (error instanceof Error && error.cause !== undefined) {
    return getServerStartFailure(error.cause);
  }
  return undefined;
}

async function portConflictError(
  error: unknown,
  config: ResolvedCoreConfig,
  paths: CorePaths,
  deps: CoreCommandDependencies,
  identity: { version: string; protocolVersion: number },
  signal?: AbortSignal,
  knownDiscovery?: CoreDiscoveryResult,
): Promise<unknown> {
  if (!isAddressInUse(error)) return error;
  const endpoint = `${config.host}:${config.port}`;
  let healthy = false;
  try {
    const discovery = knownDiscovery ?? await discoverExistingCore(
      {
        paths,
        stateDir: paths.stateDir,
        config,
        ...identity,
      },
      deps,
      signal,
    );
    healthy = discovery.status === "ready" &&
      registrationMatchesConfiguredEndpoint(discovery.registration, config);
  } catch (probeError) {
    if (signal?.aborted) throw probeError;
    healthy = false;
  }
  const message = healthy
    ? `Core port ${endpoint} is occupied by a healthy registered Core`
    : `Core port ${endpoint} is already in use by an unrelated process`;
  return new Error(message, { cause: error });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAddressInUse(error: unknown): boolean {
  if (error instanceof Deno.errors.AddrInUse) return true;
  const code = isObject(error) ? error.code : undefined;
  if (code === "addr_in_use" || code === "EADDRINUSE") return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("address already in use") ||
    message.includes("address in use") ||
    message.includes("bind: address");
}

async function cleanupFailedStartup(
  server: CoreServerHandle | undefined,
  registry: CoreRegistryLike,
  registrationId: string | undefined,
  lock: CoreLockLike,
  startupUncertain?: CoreServerStartFailure,
): Promise<unknown[]> {
  if (startupUncertain !== undefined) {
    return [
      startupUncertain.cleanupError ??
        new Error("Core listener shutdown outcome is uncertain"),
    ];
  }

  const errors: unknown[] = [];
  let serverStopped = server === undefined;
  if (server !== undefined) {
    try {
      await server.stop();
      serverStopped = true;
    } catch (error) {
      errors.push(error);
    }
  }
  if (serverStopped && registrationId !== undefined) {
    try {
      await registry.remove(registrationId);
    } catch (error) {
      errors.push(error);
    }
  }
  if (serverStopped && errors.length === 0) {
    try {
      await lock.release();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function aggregateErrors(errors: unknown[], message: string): AggregateError {
  return new AggregateError(errors, message);
}

function defaultAddSignalListener(
  signal: CoreSignal,
  handler: () => void,
): void {
  Deno.addSignalListener(signal, handler);
}

function defaultRemoveSignalListener(
  signal: CoreSignal,
  handler: () => void,
): void {
  Deno.removeSignalListener(signal, handler);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ??
    new DOMException("Core startup aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function awaitAbortable<T>(
  operation: MaybePromise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const pending = Promise.resolve().then(() => operation);
  if (signal === undefined) return pending;
  if (signal.aborted) {
    void pending.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    void pending.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
