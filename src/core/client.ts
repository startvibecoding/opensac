import { runtime as nodeRuntime } from "../platform/runtime.ts";
import type { ChildProcess } from "../platform/runtime.ts";
import { basename, fileURLToPath, fromFileUrl } from "../compat/path.ts";
import { CORE_AUTH_HEADER, CORE_CLIENT_ID_HEADER } from "./auth.ts";
import {
  assertResolvedCoreConfig,
  type ResolvedCoreConfig,
  validateCorePassword,
} from "./config.ts";
import {
  isLoopbackCoreHost,
  isWildcardCoreHost,
  registrationMatchesConfiguredEndpoint,
  registrationUrl,
} from "./endpoint.ts";
import { CorePaths } from "./paths.ts";
import {
  CORE_ERROR_SESSION_NOT_RESIDENT,
  CORE_RUNTIME_METHODS,
} from "./runtime_protocol.ts";
import { type CoreRegistration, CoreRegistry } from "./registry.ts";
import {
  CORE_METHODS,
  type CoreHealth,
  type CoreInfo,
  type CoreRpcError as CoreRpcErrorPayload,
  type CoreRpcErrorResponse,
  type CoreRpcId,
  type CoreRpcMessage,
  type CoreRpcNotification,
  type CoreRpcParams,
  type CoreRpcRequest,
  type CoreRpcResponse,
  type CoreRpcSuccessResponse,
  type CoreShutdownResult,
  parseCoreRpcMessage,
} from "./protocol.ts";
import { CORE_PROTOCOL_VERSION } from "./server.ts";

/** The default amount of time an auto-start may spend waiting for readiness. */
export const DEFAULT_CORE_START_TIMEOUT_MS = 10_000;

/** The largest accepted auto-start budget. */
export const MAX_CORE_START_TIMEOUT_MS = 300_000;

/**
 * How long a replaced Core is given to actually exit. A Core that answered
 * `core.shutdown` normally leaves well inside this; the budget only covers a
 * process that is slow to unwind.
 */
export const DEFAULT_CORE_REPLACE_TIMEOUT_MS = 15_000;

const START_POLL_INTERVAL_MS = 25;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * HTTP header used to identify a Core client across RPC and event sockets.
 * The constant is owned by `auth.ts` so the server can read it without
 * importing this module (the client already imports the server); it is
 * re-exported here because the client is the side that sets it.
 */
export { CORE_CLIENT_ID_HEADER };

/** Default wait for a replacement Core after the endpoint in use refused. */
export const DEFAULT_CORE_TAKEOVER_WAIT_MS = 2_000;

/** Largest accepted endpoint-takeover wait. */
export const MAX_CORE_TAKEOVER_WAIT_MS = 60_000;

/**
 * How long a failed launcher keeps startup polling for a peer Core.
 *
 * A spawned `opensac core` child that exits because another process won the
 * Core lock (a concurrent `opensac core restart` is starting the shared Core,
 * or the child adopted that peer and returned) must not fail this client's
 * startup while the peer is about to publish its registration.
 */
const LAUNCH_ADOPTION_GRACE_MS = 2_000;

/** Lower bound for one discovery attempt inside the takeover window. */
const TAKEOVER_PROBE_FLOOR_MS = 250;

/**
 * Starts the current OpenSAC Core process.
 *
 * The signal bounds the launch operation itself. Implementations should stop
 * or avoid publishing a child when it is aborted; the client will never treat
 * a late completion as a successful startup.
 */
export type CoreLauncher = (signal: AbortSignal) => Promise<void>;

/** Configuration for a Core HTTP client. */
export interface CoreClientOptions {
  /** Directory containing the Core registry and lock. */
  stateDir: string;
  /** OpenSAC version this client requires. */
  version: string;
  /** Core application protocol version this client requires. */
  protocolVersion: number;
  /** Resolved authentication and listener configuration. */
  config: ResolvedCoreConfig;
  /** Optional process launcher; the default launches `opensac core`. */
  launcher?: CoreLauncher;
  /**
   * Optional explicit Bearer password selection. When omitted, the first
   * non-empty configured password is selected deterministically.
   */
  password?: string;
  /** Bounded readiness budget for `ensureStarted`; defaults to 10 seconds. */
  startTimeoutMs?: number;
  /**
   * Bounded wait for a replacement Core when the endpoint in use refuses a
   * request or an event dial because the Core was restarted concurrently.
   * Defaults to 2 seconds; 0 keeps a single discovery attempt and fails on
   * the first non-ready answer.
   */
  takeoverWaitMs?: number;
  /** Optional cancellation signal for discovery and RPC requests. */
  signal?: AbortSignal;
  /**
   * Ignore the conservative dead-PID shortcut and verify the endpoint
   * identity instead. Reserved for recovery/diagnostic callers that already
   * hold the Core lock.
   */
  ignoreProcessLiveness?: boolean;
}

/** A healthy Core that passed registration, identity, and health checks. */
export interface CoreDiscoveryReady {
  status: "ready";
  registration: CoreRegistration;
  info: CoreInfo;
  health: CoreHealth;
  url: string;
}

/** No registration is present in the state directory. */
export interface CoreDiscoveryMissing {
  status: "missing";
}

/** A registration exists, but its endpoint is not currently usable. */
export interface CoreDiscoveryStale {
  status: "stale";
  registration?: CoreRegistration;
  reason: string;
  error?: CoreClientError;
}

/** A reachable endpoint does not speak the requested Core version/protocol. */
export interface CoreDiscoveryIncompatible {
  status: "incompatible";
  registration?: CoreRegistration;
  url?: string;
  expectedVersion: string;
  actualVersion?: string;
  expectedProtocolVersion: number;
  actualProtocolVersion?: number;
  actualCoreProtocolVersion?: number;
  error: CoreIncompatibleError;
}

/** The endpoint requires authentication that this client cannot provide. */
export interface CoreDiscoveryUnauthenticated {
  status: "unauthenticated";
  registration?: CoreRegistration;
  url?: string;
  error: CoreAuthenticationError;
}

/** Result of validating the registered Core endpoint. */
export type CoreDiscoveryResult =
  | CoreDiscoveryReady
  | CoreDiscoveryMissing
  | CoreDiscoveryStale
  | CoreDiscoveryIncompatible
  | CoreDiscoveryUnauthenticated;

/** Options for `ensureStarted`. */
export interface EnsureStartedOptions {
  /**
   * Replaces a registered Core that this client can never use instead of
   * failing startup.
   *
   * A version or protocol mismatch means the registered Core cannot answer a
   * single request from this build, so there is no useful client that can talk
   * to it. Replacing it is what an operator would otherwise do by hand with
   * `opensac core stop`, and the replacement is the same launch every other
   * startup performs. This is opt-in because it stops another process.
   */
  replaceIncompatible?: boolean;
  /**
   * Invoked once, immediately before an incompatible Core is stopped, so a
   * front end can tell the user why the Core is going away. Not called when no
   * replacement happens.
   */
  onReplacingIncompatible?: (registration: CoreRegistration) => void;
  /** How long to wait for the replaced Core to actually exit. */
  replaceTimeoutMs?: number;
}

/** Alias for callers that prefer the success-oriented name. */
export type CoreDiscoverySuccess = CoreDiscoveryReady;

/** Discriminator values returned by Core discovery. */
export type CoreDiscoveryStatus = CoreDiscoveryResult["status"];

/** Base class for errors produced by the Core client boundary. */
export class CoreClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A transport or response could not be decoded as a Core response. */
export class CoreClientProtocolError extends CoreClientError {}

/** The HTTP request could not reach the registered endpoint. */
export class CoreClientTransportError extends CoreClientError {}

/** A JSON-RPC error response returned by Core. */
export class CoreClientRpcError extends CoreClientError {
  readonly code: number;
  readonly data: unknown;
  readonly requestId: CoreRpcId;
  readonly httpStatus: number;

  constructor(
    error: CoreRpcErrorPayload,
    requestId: CoreRpcId,
    httpStatus = 200,
  ) {
    super(error.message);
    this.code = error.code;
    this.data = error.data;
    this.requestId = requestId;
    this.httpStatus = httpStatus;
  }
}

/** Backwards-friendly name for the typed JSON-RPC call failure. */
export { CoreClientRpcError as CoreRpcCallError };
/** Conventional JSON-RPC error name for consumers of the client module. */
export { CoreClientRpcError as CoreRpcError };

/** The registered Core is not the requested version/protocol. */
export class CoreIncompatibleError extends CoreClientError {
  readonly expectedVersion: string;
  readonly actualVersion?: string;
  readonly expectedProtocolVersion: number;
  readonly actualProtocolVersion?: number;
  readonly actualCoreProtocolVersion?: number;

  constructor(
    message: string,
    details: {
      expectedVersion: string;
      actualVersion?: string;
      expectedProtocolVersion: number;
      actualProtocolVersion?: number;
      actualCoreProtocolVersion?: number;
    },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.expectedVersion = details.expectedVersion;
    this.actualVersion = details.actualVersion;
    this.expectedProtocolVersion = details.expectedProtocolVersion;
    this.actualProtocolVersion = details.actualProtocolVersion;
    this.actualCoreProtocolVersion = details.actualCoreProtocolVersion;
  }
}

/** The endpoint rejected the configured authentication. */
export class CoreAuthenticationError extends CoreClientError {
  readonly httpStatus: number;

  constructor(message = "Core authentication is required", httpStatus = 401) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

/** No usable Core endpoint is currently connected. */
export class CoreNotConnectedError extends CoreClientError {
  readonly discovery: CoreDiscoveryResult;

  constructor(discovery: CoreDiscoveryResult, options?: ErrorOptions) {
    super(discoveryMessage(discovery), options);
    this.discovery = discovery;
  }
}

/** Alias for consumers that describe the same condition as unavailable. */
export { CoreNotConnectedError as CoreClientUnavailableError };

/** A bounded auto-start attempt did not produce a healthy registration. */
export class CoreStartupError extends CoreClientError {
  readonly discovery: CoreDiscoveryResult;
  readonly timeoutMs: number;

  constructor(
    message: string,
    discovery: CoreDiscoveryResult,
    timeoutMs: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.discovery = discovery;
    this.timeoutMs = timeoutMs;
  }
}

/** Alternate name used by callers that qualify the startup error. */
export { CoreStartupError as CoreClientStartupError };

/** A child process used for auto-start exited before Core became ready. */
export class CoreLauncherError extends CoreClientError {
  readonly exitCode?: number;
  readonly signal?: string;
  readonly detail?: string;

  constructor(
    message: string,
    details: {
      exitCode?: number;
      signal?: string;
      detail?: string;
      cause?: unknown;
    } = {},
  ) {
    super(
      message,
      details.cause === undefined
        ? undefined
        : {
            cause: details.cause,
          },
    );
    this.exitCode = details.exitCode;
    this.signal = details.signal;
    this.detail = details.detail;
  }
}

/** Alternate name for a version/protocol compatibility failure. */
export { CoreIncompatibleError as CoreVersionMismatchError };

interface RpcSuccess {
  ok: true;
  result: unknown;
  status: number;
}

interface RpcFailure {
  ok: false;
  error: CoreClientRpcError;
  status: number;
  unauthenticated: boolean;
}

type RpcOutcome = RpcSuccess | RpcFailure;

interface CoreConnection {
  url: string;
  registration: CoreRegistration;
  clientId: string;
}

/** A live WebSocket connection for Core events and reverse requests. */
export interface CoreEventConnection {
  readonly connected: boolean;
  subscribe(sessionId: string, runId: string, cursor?: number): Promise<void>;
  replay(sessionId: string, runId: string, cursor?: number): Promise<unknown>;
  onNotification(
    listener: (notification: CoreRpcNotification) => void,
  ): () => void;
  onRequest(listener: (request: CoreRpcRequest) => void): () => void;
  /**
   * Reports that the Core dropped the event socket on its own — a restart, for
   * example. An intentional `close()` does not notify, so a listener can tell
   * "my subscription is gone" from "I asked for it to be gone".
   */
  onClose(listener: () => void): () => void;
  respond(response: CoreRpcResponse): void;
  close(): Promise<void>;
  reconnect(): Promise<void>;
}

interface InternalDiscoveryOptions {
  requestTimeoutMs: number;
  signal?: AbortSignal;
}

/**
 * A small, front-end-neutral JSON-RPC client for the shared Core.
 *
 * The client owns no process or server lifecycle. It reads the registry,
 * validates the live endpoint, and can ask an injected launcher to start the
 * shared Core. `close()` only drops local connection state; it never stops the
 * globally shared Core process.
 */
export class CoreClient {
  readonly #paths: CorePaths;
  readonly #version: string;
  readonly #protocolVersion: number;
  readonly #config: ResolvedCoreConfig;
  readonly #launcher: CoreLauncher;
  readonly #startTimeoutMs: number;
  readonly #takeoverWaitMs: number;
  readonly #signal?: AbortSignal;
  readonly #ignoreProcessLiveness: boolean;

  readonly #clientId: string;
  #connection: CoreConnection | undefined;
  #discoveryPromise: Promise<CoreDiscoveryResult> | undefined;
  #startPromise: Promise<CoreDiscoveryResult> | undefined;
  #pendingLaunchCleanup: Promise<void> | undefined;
  #selectedPassword: string | undefined;
  #nextRequestId = 1;

  constructor(options: CoreClientOptions) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("CoreClient options are required");
    }

    this.#clientId = createClientId();
    this.#paths = CorePaths.fromStateDir(options.stateDir);
    if (typeof options.version !== "string" || options.version.trim() === "") {
      throw new TypeError("CoreClient version must be a non-empty string");
    }
    this.#version = options.version.trim();
    if (
      typeof options.protocolVersion !== "number" ||
      !Number.isInteger(options.protocolVersion) ||
      options.protocolVersion < 0
    ) {
      throw new TypeError("CoreClient protocolVersion must be an integer >= 0");
    }
    this.#protocolVersion = options.protocolVersion;
    this.#config = copyConfig(options.config);
    this.#selectedPassword = initialPassword(this.#config, options.password);
    this.#startTimeoutMs = validateStartTimeout(options.startTimeoutMs);
    this.#takeoverWaitMs = validateTakeoverWait(options.takeoverWaitMs);
    this.#signal = options.signal;
    this.#ignoreProcessLiveness = options.ignoreProcessLiveness === true;

    if (
      options.launcher !== undefined &&
      typeof options.launcher !== "function"
    ) {
      throw new TypeError("CoreClient launcher must be a function");
    }
    this.#launcher =
      options.launcher ??
      createDefaultCoreLauncher(
        this.#paths.stateDir,
        this.#config.passwords,
        this.#version,
        this.#protocolVersion,
      );
  }

  /**
   * Reads and validates the registered Core without starting a process.
   *
   * A PID is only used as a conservative early stale hint. Every other path
   * still performs the authenticated `core.info` request, so a reused PID can
   * never establish Core identity by itself.
   */
  discover(signal?: AbortSignal): Promise<CoreDiscoveryResult> {
    const pendingCleanup = this.#pendingLaunchCleanup;
    if (pendingCleanup !== undefined) {
      return pendingCleanup.then(() =>
        this.#discover({
          requestTimeoutMs: REQUEST_TIMEOUT_MS,
          signal: combineAbortSignals(this.#signal, signal),
        }),
      );
    }

    const effectiveSignal = combineAbortSignals(this.#signal, signal);
    if (signal !== undefined) {
      return this.#discover({
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        signal: effectiveSignal,
      });
    }

    this.#discoveryPromise ??= this.#discover({
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      signal: effectiveSignal,
    });
    const promise = this.#discoveryPromise;
    void promise.then(
      () => {
        if (this.#discoveryPromise === promise) {
          this.#discoveryPromise = undefined;
        }
      },
      () => {
        if (this.#discoveryPromise === promise) {
          this.#discoveryPromise = undefined;
        }
      },
    );
    return promise;
  }

  /**
   * Ensures a healthy Core is available, launching at most one process for
   * concurrent callers on this client instance.
   */
  ensureStarted(
    signal?: AbortSignal,
    options: EnsureStartedOptions = {},
  ): Promise<CoreDiscoveryResult> {
    if (this.#startPromise !== undefined) return this.#startPromise;

    const promise = this.#ensureStartedAllowingReplacement(signal, options);
    this.#startPromise = promise;
    void promise.then(
      () => {
        if (this.#startPromise === promise) this.#startPromise = undefined;
      },
      () => {
        if (this.#startPromise === promise) this.#startPromise = undefined;
      },
    );
    return promise;
  }

  /**
   * Replaces an unusable registered Core, when asked to, before the ordinary
   * startup path runs.
   *
   * The replacement happens up front rather than as a retry inside
   * `#ensureStarted`, so the existing deadline, launch-adoption, and polling
   * rules stay exactly as they are. A replacement that does not complete is not
   * fatal here: the same registration is still in place, and `#ensureStarted`
   * then reports the mismatch with its own accurate error.
   */
  async #ensureStartedAllowingReplacement(
    signal: AbortSignal | undefined,
    options: EnsureStartedOptions,
  ): Promise<CoreDiscoveryResult> {
    if (options.replaceIncompatible === true) {
      await this.#replaceIncompatibleCore(signal, options);
    }
    return await this.#ensureStarted(signal);
  }

  /**
   * Stops a registered Core whose version or protocol this client cannot use,
   * leaving the next startup to launch a replacement.
   *
   * Returns true only when a Core was actually stopped and observed gone, so a
   * caller can tell a completed replacement from an attempted one.
   */
  async #replaceIncompatibleCore(
    signal: AbortSignal | undefined,
    options: EnsureStartedOptions,
  ): Promise<boolean> {
    const registry = new CoreRegistry(this.#paths);
    let discovery: CoreDiscoveryResult;
    try {
      discovery = await this.discover(signal);
    } catch {
      // A discovery failure is the ordinary startup path's problem to report;
      // it says nothing about compatibility.
      return false;
    }
    if (discovery.status !== "incompatible") return false;
    const registration = discovery.registration;
    if (registration === undefined) return false;

    options.onReplacingIncompatible?.(registration);

    let signalled = false;
    try {
      await this.shutdown(signal);
    } catch (error) {
      // A Core predating `core.shutdown` cannot be asked politely. SIGTERM is
      // that process's clean stop path, but it is only safe once the
      // registration is still the one discovery inspected: a replacement that
      // appeared in between must never be signalled by mistake.
      const replaceable =
        isMethodNotFoundError(error) &&
        (await isCurrentRegistration(registry, registration));
      if (!replaceable) return false;
      try {
        nodeRuntime.kill(registration.pid, "SIGTERM");
        signalled = true;
      } catch {
        return false;
      }
    }

    const exited = await waitForRegistrationExit(registry, registration, {
      timeoutMs: options.replaceTimeoutMs ?? DEFAULT_CORE_REPLACE_TIMEOUT_MS,
      signal,
    });
    if (!exited) {
      // The stop was requested but the Core still holds its registration, so
      // launching a replacement now would race it for the Core lock. Report the
      // mismatch instead; the caller decides whether to force the issue.
      throw new CoreStartupError(
        signalled
          ? "The registered Core is incompatible and did not exit in time"
          : "The registered Core is incompatible and did not shut down in time",
        discovery,
        options.replaceTimeoutMs ?? DEFAULT_CORE_REPLACE_TIMEOUT_MS,
      );
    }

    // The endpoint this client cached points at the Core that just exited, so
    // the next startup must resolve the replacement's registration instead.
    this.#connection = undefined;
    this.#discoveryPromise = undefined;
    return true;
  }

  /** Sends one ordinary JSON-RPC request to the discovered `/rpc` endpoint. */
  async call<T>(
    method: string,
    params?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    validateMethod(method);
    validateParams(params);
    const requestSignal = combineAbortSignals(this.#signal, signal);
    let connection = await this.#requireConnection(requestSignal);
    let retried = false;
    // At most one re-open per call: the replay must not loop if the Core keeps
    // reporting the same session as not resident.
    let residentReplayed = false;
    while (true) {
      const requestId = this.#nextId();
      let outcome: RpcOutcome;
      try {
        outcome = await this.#sendRpc(
          connection.url,
          method,
          params,
          requestId,
          REQUEST_TIMEOUT_MS,
          requestSignal,
        );
      } catch (error) {
        if (!retried && isNeverConnectedError(error)) {
          // The connection was never established, so this request cannot have
          // reached a Core: the endpoint it was addressed to is gone and the
          // registered Core may have been restarted elsewhere. Resolve that
          // replacement and send the request once more.
          retried = true;
          connection = await this.#resolveReplacementConnection(requestSignal);
          continue;
        }
        if (isEndpointGoneError(error)) {
          // The endpoint stopped answering mid-request. The outcome of this
          // request is uncertain, so it is never replayed — but the cached
          // connection is dropped so the next call re-discovers instead of
          // reusing a dead endpoint.
          this.#connection = undefined;
        }
        throw error;
      }
      if (!outcome.ok) {
        // A session the Core reports as not resident is the restart case: the
        // Core rejected the request before doing any work, so re-opening that
        // session and replaying is safe. Every other error stands.
        if (!residentReplayed && reopensResidentSession(outcome.error)) {
          residentReplayed = true;
          await this.#reopenResidentSession(
            residentSessionId(outcome.error),
            requestSignal,
          );
          continue;
        }
        throw outcome.error;
      }
      return outcome.result as T;
    }
  }

  /**
   * Re-opens a persisted session in the Core that just reported it as not
   * resident. A session that no longer exists fails here, which surfaces the
   * real cause instead of replaying into a second failure.
   */
  async #reopenResidentSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.call(CORE_RUNTIME_METHODS.sessionOpen, { sessionId }, signal);
  }

  async connectEvents(signal?: AbortSignal): Promise<CoreEventConnection> {
    const requestSignal = combineAbortSignals(this.#signal, signal);
    let connection = await this.#requireConnection(requestSignal);
    let url = eventsUrl(connection.url);
    let socket: WebSocket;
    const openSocket = async (endpoint: string): Promise<WebSocket> => {
      const next = new WebSocket(endpoint);
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new CoreClientTransportError("Core event WebSocket failed"));
        };
        const cleanup = () => {
          next.removeEventListener("open", onOpen);
          next.removeEventListener("error", onError);
        };
        next.addEventListener("open", onOpen, { once: true });
        next.addEventListener("error", onError, { once: true });
      });
      return next;
    };
    // Captured for the connection object below: its `this` is the object
    // literal, so it resolves the endpoint through this closure.
    const resolveEndpoint = (): Promise<CoreConnection> =>
      this.#resolveReplacementConnection(requestSignal);
    try {
      socket = await openSocket(url);
    } catch {
      // The Core may have been replaced between discovery and this dial (a
      // concurrent `opensac core restart`): resolve the registered endpoint
      // once more and dial the replacement before giving up.
      connection = await resolveEndpoint();
      url = eventsUrl(connection.url);
      socket = await openSocket(url);
    }

    const pending = new Map<
      string,
      {
        resolve(result: unknown): void;
        reject(error: unknown): void;
      }
    >();
    const notifications = new Set<
      (notification: CoreRpcNotification) => void
    >();
    const requests = new Set<(request: CoreRpcRequest) => void>();
    const drops = new Set<() => void>();
    // Subscriptions this connection owns, so a reconnect onto a replacement
    // Core re-establishes them before anyone has to notice they are gone.
    const subscriptions = new Map<
      string,
      {
        sessionId: string;
        runId: string;
        cursor: number;
      }
    >();
    let closed = false;
    let nextId = 1;

    // A restarted Core drops this socket without the client asking. Requests
    // already in flight can never be answered, and a listener that owns a
    // long-lived subscription has to re-establish it, so an unexpected close
    // is reported. An intentional `close()` sets `closed` first and is silent.
    const watchSocket = (target: WebSocket): void => {
      target.addEventListener("close", () => {
        // A socket replaced by `reconnect()` closes asynchronously, after the
        // replacement is already live. Reporting that would blame a healthy
        // connection for a close the client asked for.
        if (closed || target !== socket) return;
        closed = true;
        for (const waiter of pending.values()) {
          waiter.reject(
            new CoreClientTransportError("Core event WebSocket closed"),
          );
        }
        pending.clear();
        for (const listener of [...drops]) listener();
      });
    };
    watchSocket(socket);

    const send = (message: CoreRpcMessage): void => {
      if (closed || socket.readyState !== WebSocket.OPEN) {
        throw new CoreClientTransportError("Core event WebSocket is closed");
      }
      socket.send(JSON.stringify(message));
    };
    const request = async (
      method: string,
      params?: unknown,
    ): Promise<unknown> => {
      const id = `event-${nextId++}`;
      const result = new Promise<unknown>((resolve, reject) => {
        // The lookup side matches responses by `JSON.stringify(message.id)`;
        // store the key the same way or no response can ever resolve.
        pending.set(JSON.stringify(id), { resolve, reject });
      });
      send({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params: params as CoreRpcParams }),
      });
      return await result;
    };

    // One frame handler serves both the initial socket and every reconnect,
    // so a restored socket routes responses and reverse requests, not only
    // notifications.
    const handleFrame = (data: unknown): void => {
      if (typeof data !== "string") return;
      let input: unknown;
      try {
        input = JSON.parse(data);
      } catch {
        // Ignore malformed frames; the next frame remains usable.
        return;
      }
      const message = parseCoreRpcMessage(input);
      if (message === undefined) return;
      if (!("method" in message)) {
        const key = JSON.stringify(message.id);
        const waiter = pending.get(key);
        if (waiter === undefined) return;
        pending.delete(key);
        if ("error" in message && message.error !== undefined) {
          waiter.reject(new CoreClientRpcError(message.error, message.id));
        } else {
          waiter.resolve(message.result);
        }
        return;
      }
      if (message.id !== undefined && typeof message.method === "string") {
        for (const listener of requests) listener(message);
      } else if (typeof message.method === "string") {
        for (const listener of notifications) listener(message);
      }
    };
    socket.onmessage = (event) => handleFrame(event.data);

    const connectionObject: CoreEventConnection = {
      get connected() {
        return !closed && socket.readyState === WebSocket.OPEN;
      },
      async subscribe(sessionId, runId, cursor = 0) {
        await request("run.events.subscribe", { sessionId, runId, cursor });
        subscriptions.set(`${sessionId}\u0000${runId}`, {
          sessionId,
          runId,
          cursor,
        });
      },
      async replay(sessionId, runId, cursor = 0) {
        return await request("run.events.replay", { sessionId, runId, cursor });
      },
      onNotification(listener) {
        notifications.add(listener);
        return () => notifications.delete(listener);
      },
      onRequest(listener) {
        requests.add(listener);
        return () => requests.delete(listener);
      },
      onClose(listener) {
        drops.add(listener);
        return () => drops.delete(listener);
      },
      respond(response) {
        send(response);
      },
      async close() {
        await Promise.resolve();
        if (closed) return;
        closed = true;
        for (const waiter of pending.values()) {
          waiter.reject(
            new CoreClientTransportError("Core event WebSocket closed"),
          );
        }
        pending.clear();
        socket.close();
      },
      async reconnect() {
        await connectionObject.close();
        // The Core may have restarted onto another endpoint while the socket
        // was down; resolve the registered endpoint again instead of redialing
        // the URL from before the restart.
        connection = await resolveEndpoint();
        url = eventsUrl(connection.url);
        const next = await openSocket(url);
        socket = next;
        closed = false;
        watchSocket(next);
        socket.onmessage = (event) => handleFrame(event.data);
        // The subscription table lived in the dropped process. Re-establish
        // every registered subscription on the replacement so a notification
        // listener (the TUI decision bridge, a run event stream) keeps seeing
        // events without knowing the socket underneath changed. The restore is
        // not reported as a drop: an intentional reconnect must stay silent
        // by the `onClose` contract, and the listeners were never removed.
        for (const subscription of subscriptions.values()) {
          await request("run.events.subscribe", {
            sessionId: subscription.sessionId,
            runId: subscription.runId,
            cursor: subscription.cursor,
          });
        }
      },
    };
    return connectionObject;
  }

  /**
   * Requests graceful shutdown of the registered Core (`core.shutdown`).
   *
   * This lifecycle operation serves owners of a Core process (a standalone
   * private Core or operator tooling). It deliberately does not require a
   * `ready` discovery so a reachable but version-incompatible registered Core
   * can still be stopped and replaced; callers verify registration identity
   * before acting on the result.
   */
  async shutdown(signal?: AbortSignal): Promise<CoreShutdownResult> {
    const requestSignal = combineAbortSignals(this.#signal, signal);
    let registration: CoreRegistration | undefined;
    try {
      registration = await new CoreRegistry(this.#paths).read();
    } catch (error) {
      throw new CoreClientProtocolError("Core registration is invalid", {
        cause: error,
      });
    }
    if (registration === undefined) {
      throw new CoreClientError("no Core is registered");
    }
    const url = registrationUrl(registration, this.#config);
    const outcome = await this.#sendRpc(
      url,
      CORE_METHODS.shutdown,
      undefined,
      this.#nextId(),
      REQUEST_TIMEOUT_MS,
      requestSignal,
    );
    if (!outcome.ok) throw outcome.error;
    const result = parseCoreShutdownResult(outcome.result);
    if (result === undefined) {
      throw new CoreClientProtocolError(
        "Core shutdown response has an invalid shape",
      );
    }
    return result;
  }

  /** Calls and validates `core.health` for the current connection. */
  async health(signal?: AbortSignal): Promise<CoreHealth> {
    const value = await this.call<unknown>(
      CORE_METHODS.health,
      undefined,
      signal,
    );
    const health = parseCoreHealth(value);
    if (health === undefined) {
      throw new CoreClientProtocolError(
        "Core health response has an invalid shape",
      );
    }
    if (!health.healthy) {
      throw new CoreClientError("Core reported an unhealthy state");
    }
    if (!this.#matchesVersion(health.version, health.protocolVersion)) {
      throw this.#incompatibleError(
        health.version,
        health.protocolVersion,
        "Core health version/protocol does not match the client",
      );
    }
    return health;
  }

  /**
   * Selects the Bearer password for subsequent requests. Passing `undefined`
   * restores the deterministic first configured password.
   */
  setPassword(password: string | undefined): void {
    this.#selectedPassword =
      password === undefined
        ? deterministicPassword(this.#config)
        : validateSelectedPassword(password);
  }

  /** Alias for callers that describe the operation as credential selection. */
  selectPassword(password: string | undefined): void {
    this.setPassword(password);
  }

  /** Drops local endpoint state; the shared Core process is left running. */
  async close(): Promise<void> {
    this.#connection = undefined;
    this.#discoveryPromise = undefined;
    const pendingCleanup = this.#pendingLaunchCleanup;
    if (pendingCleanup !== undefined) await pendingCleanup;
  }

  async #ensureStarted(
    operationSignal?: AbortSignal,
  ): Promise<CoreDiscoveryResult> {
    const deadline = Date.now() + this.#startTimeoutMs;
    const controller = new AbortController();
    const externalSignals = [this.#signal, operationSignal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const relayExternalAbort = (event: Event): void => {
      const signal = event.currentTarget as AbortSignal | null;
      controller.abort(signal?.reason);
    };
    for (const signal of externalSignals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        break;
      }
      signal.addEventListener("abort", relayExternalAbort, { once: true });
    }
    let deadlineElapsed = false;
    const deadlineTimer = setTimeout(() => {
      deadlineElapsed = true;
      controller.abort(
        new DOMException("Core startup deadline elapsed", "TimeoutError"),
      );
    }, this.#startTimeoutMs);
    let ready = false;
    try {
      let discovery: CoreDiscoveryResult;
      try {
        discovery = await awaitWithDeadline(
          this.#discover({
            requestTimeoutMs: Math.min(
              REQUEST_TIMEOUT_MS,
              this.#startTimeoutMs,
            ),
            signal: controller.signal,
          }),
          deadline,
          "Core discovery timed out before startup",
          controller.signal,
        );
      } catch (error) {
        throw new CoreStartupError(
          controller.signal.aborted
            ? "Core startup was cancelled before launch"
            : "Core discovery failed before startup",
          staleResult(
            undefined,
            "Core discovery failed",
            asClientError(error, "Core discovery failed"),
          ),
          this.#startTimeoutMs,
          { cause: error },
        );
      }

      if (discovery.status === "ready") {
        ready = true;
        return discovery;
      }
      if (discovery.status === "incompatible") {
        throw new CoreStartupError(
          "Cannot start Core: the registered Core is incompatible",
          discovery,
          this.#startTimeoutMs,
        );
      }
      if (discovery.status === "unauthenticated") {
        throw new CoreStartupError(
          "Cannot start Core: the registered Core rejected authentication",
          discovery,
          this.#startTimeoutMs,
        );
      }

      if (Date.now() >= deadline) {
        throw new CoreStartupError(
          "Core startup deadline elapsed before launch",
          discovery,
          this.#startTimeoutMs,
        );
      }

      const baseline = await this.#readLaunchBaseline();
      const launchPromise = Promise.resolve().then(() =>
        this.#launcher(controller.signal),
      );
      // A launcher may represent a long-lived child rather than a one-shot
      // spawn operation, so its completion is never awaited here. A rejection
      // is remembered instead of failing startup on the spot: a child that
      // exits because another process won the Core lock (a concurrent
      // `opensac core restart` is starting the shared Core, or the child
      // adopted that peer and returned) leaves a healthy Core that may publish
      // its registration a moment later.
      let launchFailed = false;
      let launchError: unknown;
      let launchFailedAt = 0;
      void launchPromise.then(
        () => undefined,
        (error) => {
          launchFailed = true;
          launchError = error;
          launchFailedAt = Date.now();
        },
      );

      // Ranks the failures every exit of the readiness poll can report, so the
      // rule lives in one place: a real cancellation wins, then a launcher that
      // failed outside its adoption window, then the exit's own failure. The
      // startup deadline aborts the controller itself, so it is never mistaken
      // for a cancellation, and a launcher failure is only reported once the
      // window in which a peer could still be adopted has closed. `otherwise`
      // builds the error that is specific to the call site.
      const startupFailure = (
        pollDeadline: number,
        cause: unknown,
        otherwise: (cause: unknown) => CoreStartupError,
      ): CoreStartupError => {
        if (controller.signal.aborted && !deadlineElapsed) {
          return new CoreStartupError(
            "Core startup was cancelled while waiting for readiness",
            discovery,
            this.#startTimeoutMs,
            { cause },
          );
        }
        if (launchFailed && Date.now() >= pollDeadline) {
          return launcherStartupError(
            launchError,
            discovery,
            this.#startTimeoutMs,
          );
        }
        return otherwise(cause);
      };

      while (true) {
        const pollDeadline = launchFailed
          ? Math.min(deadline, launchFailedAt + LAUNCH_ADOPTION_GRACE_MS)
          : deadline;
        const remaining = pollDeadline - Date.now();
        if (remaining <= 0) {
          this.#trackLateLaunchCleanup(launchPromise, baseline);
          throw startupFailure(
            pollDeadline,
            controller.signal.reason,
            () =>
              new CoreStartupError(
                "Core did not become ready before the startup deadline",
                discovery,
                this.#startTimeoutMs,
              ),
          );
        }

        try {
          discovery = await awaitWithDeadline(
            this.#discover({
              requestTimeoutMs: Math.min(REQUEST_TIMEOUT_MS, remaining),
              signal: controller.signal,
            }),
            pollDeadline,
            "Core discovery timed out while waiting for startup",
            controller.signal,
          );
        } catch (error) {
          // Only an exit that abandons this launch tracks the late
          // registration cleanup; a discovery failure early in the adoption
          // window still has the startup cancellation to stop the launcher.
          if (
            (controller.signal.aborted && !deadlineElapsed) ||
            Date.now() >= pollDeadline
          ) {
            this.#trackLateLaunchCleanup(launchPromise, baseline);
          }
          throw startupFailure(
            pollDeadline,
            error,
            (cause) =>
              new CoreStartupError(
                "Core discovery failed while waiting for startup",
                staleResult(
                  undefined,
                  "Core discovery failed",
                  asClientError(cause, "Core discovery failed"),
                ),
                this.#startTimeoutMs,
                { cause },
              ),
          );
        }
        if (discovery.status === "ready") {
          ready = true;
          return discovery;
        }
        if (discovery.status === "incompatible") {
          throw new CoreStartupError(
            "Started Core is incompatible with this client",
            discovery,
            this.#startTimeoutMs,
          );
        }
        if (discovery.status === "unauthenticated") {
          throw new CoreStartupError(
            "Started Core rejected the configured authentication",
            discovery,
            this.#startTimeoutMs,
          );
        }

        const wait = Math.min(
          START_POLL_INTERVAL_MS,
          pollDeadline - Date.now(),
        );
        if (wait > 0) {
          try {
            await delay(wait, controller.signal);
          } catch (error) {
            this.#trackLateLaunchCleanup(launchPromise, baseline);
            throw startupFailure(
              pollDeadline,
              error,
              (cause) =>
                new CoreStartupError(
                  controller.signal.aborted
                    ? "Core startup was cancelled while waiting for readiness"
                    : "Core startup polling failed",
                  discovery,
                  this.#startTimeoutMs,
                  { cause },
                ),
            );
          }
        }
      }
    } finally {
      clearTimeout(deadlineTimer);
      for (const signal of externalSignals) {
        signal.removeEventListener("abort", relayExternalAbort);
      }
      if (!ready) controller.abort();
    }
  }

  async #requireConnection(signal?: AbortSignal): Promise<CoreConnection> {
    if (this.#connection !== undefined) return this.#connection;
    const discovered = await this.discover(signal);
    if (discovered.status === "ready") {
      // `discover` installs the connection before returning. Keep this guard
      // for type safety if that implementation changes.
      if (this.#connection === undefined) {
        throw new CoreClientError("Core discovery returned no endpoint");
      }
      return this.#connection;
    }
    throw discoveryError(discovered);
  }

  /**
   * Re-resolves the registered Core after the endpoint in use refused a
   * request or an event dial.
   *
   * A concurrent `opensac core restart` publishes its registration only once
   * the replacement is listening, so discovery is polled for a short bounded
   * window instead of failing on the first `missing`/`stale` answer.
   * Readiness ends the wait; incompatible and unauthenticated results are
   * terminal for this client and are surfaced immediately.
   */
  async #resolveReplacementConnection(
    signal?: AbortSignal,
  ): Promise<CoreConnection> {
    this.#connection = undefined;
    const pendingCleanup = this.#pendingLaunchCleanup;
    if (pendingCleanup !== undefined) await pendingCleanup;

    const deadline = Date.now() + this.#takeoverWaitMs;
    while (true) {
      throwIfAborted(signal);
      const remaining = deadline - Date.now();
      const requestTimeoutMs = Math.min(
        REQUEST_TIMEOUT_MS,
        Math.max(remaining, TAKEOVER_PROBE_FLOOR_MS),
      );
      const discovery = await this.#discover({ requestTimeoutMs, signal });
      if (discovery.status === "ready") {
        const connection: CoreConnection = {
          url: discovery.url,
          registration: discovery.registration,
          clientId: this.#clientId,
        };
        this.#connection = connection;
        return connection;
      }
      if (
        discovery.status === "incompatible" ||
        discovery.status === "unauthenticated"
      ) {
        throw discoveryError(discovery);
      }
      if (Date.now() >= deadline) throw discoveryError(discovery);
      await delay(START_POLL_INTERVAL_MS, signal);
    }
  }

  async #readLaunchBaseline(): Promise<CoreRegistration | undefined> {
    try {
      return await new CoreRegistry(this.#paths).read();
    } catch {
      return undefined;
    }
  }

  #trackLateLaunchCleanup(
    launchPromise: Promise<void>,
    baseline: CoreRegistration | undefined,
  ): void {
    const cleanup = launchPromise
      .then(
        () => this.#cleanupLateRegistration(baseline),
        () => undefined,
      )
      .catch(() => undefined);
    // A broken launcher may ignore cancellation forever. Do not make close()
    // wait on that abandoned promise; the completion branch still performs
    // best-effort identity cleanup if the launcher eventually returns.
    const boundedCleanup = waitBounded(cleanup, 100);
    const tracked = boundedCleanup.finally(() => {
      if (this.#pendingLaunchCleanup === tracked) {
        this.#pendingLaunchCleanup = undefined;
      }
    });
    this.#pendingLaunchCleanup = tracked;
  }

  async #cleanupLateRegistration(
    baseline: CoreRegistration | undefined,
  ): Promise<void> {
    const registry = new CoreRegistry(this.#paths);
    let current: CoreRegistration | undefined;
    try {
      current = await registry.read();
    } catch {
      return;
    }
    if (
      current === undefined ||
      sameRegistrationForCleanup(current, baseline)
    ) {
      return;
    }

    // Only remove a registration that is demonstrably unusable. A healthy
    // late Core is left for the next caller rather than being treated as a
    // malicious side effect.
    //
    // An alive PID is never proof of unusability: while a concurrent
    // `opensac core restart` is coming up, its replacement can be registered
    // but slower than this probe to answer, and deleting that row would strand
    // a healthy Core. The same applies to a remote or indeterminate PID, which
    // cannot be judged from this host at all.
    if (
      !isLocalCoreHost(current.host) ||
      processLiveness(current.pid) !== "dead"
    ) {
      return;
    }

    const result = await this.#discover({
      requestTimeoutMs: 100,
      signal: AbortSignal.timeout(200),
    });
    if (result.status === "stale") {
      await registry.remove(current.id);
    }
  }

  async #discover(
    options: InternalDiscoveryOptions,
  ): Promise<CoreDiscoveryResult> {
    throwIfAborted(options.signal);
    let registration: CoreRegistration | undefined;
    try {
      registration = await new CoreRegistry(this.#paths).read();
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      this.#connection = undefined;
      return staleResult(
        undefined,
        "Core registration is missing or invalid",
        new CoreClientProtocolError("Core registration is invalid", {
          cause: error,
        }),
      );
    }

    throwIfAborted(options.signal);
    if (registration === undefined) {
      this.#connection = undefined;
      return { status: "missing" };
    }

    // A demonstrably dead local PID is enough to avoid a pointless request.
    // An alive, reused, or indeterminate PID is never accepted as identity.
    if (
      !this.#ignoreProcessLiveness &&
      isLocalCoreHost(registration.host) &&
      processLiveness(registration.pid) === "dead"
    ) {
      this.#connection = undefined;
      return staleResult(
        registration,
        "registered Core process is not running",
      );
    }

    let url: string;
    try {
      url = registrationUrl(registration, this.#config);
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      this.#connection = undefined;
      const reason =
        error instanceof TypeError &&
        error.message.includes("configured fixed port")
          ? error.message
          : "Core registration has an invalid endpoint";
      return staleResult(
        registration,
        reason,
        asClientError(error, "Core registration endpoint is invalid"),
      );
    }

    if (!registrationMatchesConfiguredEndpoint(registration, this.#config)) {
      this.#connection = undefined;
      return staleResult(
        registration,
        "registered Core endpoint does not match the configured endpoint",
      );
    }

    let authFailure: CoreAuthenticationError | undefined;
    try {
      this.#assertAuthenticationAvailable();
    } catch (error) {
      if (!(error instanceof CoreAuthenticationError)) throw error;
      authFailure = error;
    }
    if (authFailure !== undefined) {
      this.#connection = undefined;
      return {
        status: "unauthenticated",
        registration,
        url,
        error: authFailure,
      };
    }

    if (
      registration.version !== this.#version ||
      registration.protocolVersion !== this.#protocolVersion
    ) {
      // Do not reject an old registration solely from its metadata. A dead
      // process or an unreachable endpoint must remain recoverable; a live
      // endpoint is probed so an actually running incompatible Core is still
      // reported accurately.
      let metadataProbe: RpcOutcome;
      try {
        metadataProbe = await this.#sendRpc(
          url,
          CORE_METHODS.info,
          undefined,
          this.#nextId(),
          options.requestTimeoutMs,
          options.signal,
        );
      } catch (error) {
        if (options.signal?.aborted) throw abortReason(options.signal);
        this.#connection = undefined;
        return staleResult(
          registration,
          "registered Core endpoint is unreachable",
          asClientError(error, "Core registration probe failed"),
        );
      }
      if (!metadataProbe.ok) {
        this.#connection = undefined;
        if (metadataProbe.unauthenticated) {
          return {
            status: "unauthenticated",
            registration,
            url,
            error: new CoreAuthenticationError(
              "Core rejected the configured authentication",
              metadataProbe.status,
            ),
          };
        }
        return staleResult(
          registration,
          "registered Core returned an error for core.info",
          metadataProbe.error,
        );
      }
      const probedInfo = parseCoreInfo(metadataProbe.result);
      const error = this.#incompatibleError(
        probedInfo?.version ?? registration.version,
        probedInfo?.protocolVersion ?? registration.protocolVersion,
        "Core registration version/protocol does not match the client",
        probedInfo?.coreProtocolVersion,
      );
      this.#connection = undefined;
      return incompatibleResult(registration, url, error, probedInfo);
    }

    let infoOutcome: RpcOutcome;
    try {
      infoOutcome = await this.#sendRpc(
        url,
        CORE_METHODS.info,
        undefined,
        this.#nextId(),
        options.requestTimeoutMs,
        options.signal,
      );
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      this.#connection = undefined;
      return staleResult(
        registration,
        "registered Core endpoint did not answer core.info",
        asClientError(error, "Core info request failed"),
      );
    }

    if (!infoOutcome.ok) {
      this.#connection = undefined;
      if (infoOutcome.unauthenticated) {
        return {
          status: "unauthenticated",
          registration,
          url,
          error: new CoreAuthenticationError(
            "Core rejected the configured authentication",
            infoOutcome.status,
          ),
        };
      }
      return staleResult(
        registration,
        "registered Core returned an error for core.info",
        infoOutcome.error,
      );
    }

    const info = parseCoreInfo(infoOutcome.result);
    if (info === undefined) {
      this.#connection = undefined;
      const error = this.#incompatibleError(
        undefined,
        undefined,
        "Core info response has an invalid shape",
      );
      return incompatibleResult(registration, url, error);
    }
    if (!this.#matchesInfo(info)) {
      this.#connection = undefined;
      const error = this.#incompatibleError(
        info.version,
        info.protocolVersion,
        "Core info version/protocol does not match the client",
        info.coreProtocolVersion,
      );
      return incompatibleResult(registration, url, error, info);
    }

    let healthOutcome: RpcOutcome;
    try {
      healthOutcome = await this.#sendRpc(
        url,
        CORE_METHODS.health,
        undefined,
        this.#nextId(),
        options.requestTimeoutMs,
        options.signal,
      );
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      this.#connection = undefined;
      return staleResult(
        registration,
        "registered Core endpoint did not answer core.health",
        asClientError(error, "Core health request failed"),
      );
    }

    if (!healthOutcome.ok) {
      this.#connection = undefined;
      if (healthOutcome.unauthenticated) {
        return {
          status: "unauthenticated",
          registration,
          url,
          error: new CoreAuthenticationError(
            "Core rejected the configured authentication",
            healthOutcome.status,
          ),
        };
      }
      return staleResult(
        registration,
        "registered Core returned an error for core.health",
        healthOutcome.error,
      );
    }

    const health = parseCoreHealth(healthOutcome.result);
    if (health === undefined || !health.healthy) {
      this.#connection = undefined;
      return staleResult(
        registration,
        health === undefined
          ? "Core health response has an invalid shape"
          : "Core reported an unhealthy state",
      );
    }
    if (!this.#matchesVersion(health.version, health.protocolVersion)) {
      this.#connection = undefined;
      const error = this.#incompatibleError(
        health.version,
        health.protocolVersion,
        "Core health version/protocol does not match the client",
      );
      return incompatibleResult(registration, url, error, info);
    }

    let current: boolean;
    try {
      current = await new CoreRegistry(this.#paths).isCurrent(registration);
    } catch (error) {
      this.#connection = undefined;
      return staleResult(
        registration,
        "Core registration could not be rechecked",
        asClientError(error, "Core registration currency check failed"),
      );
    }
    if (!current) {
      this.#connection = undefined;
      return staleResult(
        registration,
        "Core registration changed during discovery",
      );
    }

    throwIfAborted(options.signal);
    this.#connection = { url, registration, clientId: this.#clientId };
    return {
      status: "ready",
      registration,
      info,
      health,
      url,
    };
  }

  async #sendRpc(
    baseUrl: string,
    method: string,
    params: unknown,
    requestId: CoreRpcId,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RpcOutcome> {
    const password = this.#authenticationPassword();
    const outcome = await this.#sendRpcOnce(
      baseUrl,
      method,
      params,
      requestId,
      timeoutMs,
      password,
      signal,
    );
    if (outcome.ok) this.#cacheSuccessfulPassword(password);
    return outcome;
  }

  async #sendRpcOnce(
    baseUrl: string,
    method: string,
    params: unknown,
    requestId: CoreRpcId,
    timeoutMs: number,
    password: string | undefined,
    signal?: AbortSignal,
  ): Promise<RpcOutcome> {
    const request: Record<string, unknown> = {
      jsonrpc: "2.0",
      id: requestId,
      method,
    };
    if (params !== undefined) request.params = params;

    let encodedRequest: string;
    try {
      encodedRequest = JSON.stringify(request);
    } catch (error) {
      throw new CoreClientProtocolError("Core RPC params are not JSON-safe", {
        cause: error,
      });
    }

    const headers = new Headers({
      accept: "application/json",
      "content-type": "application/json",
      [CORE_CLIENT_ID_HEADER]: this.#clientId,
    });
    if (password !== undefined) {
      headers.set(CORE_AUTH_HEADER, `Bearer ${password}`);
    }

    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal?.reason);
    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort(
          new DOMException("Core request timed out", "TimeoutError"),
        );
      },
      Math.max(1, timeoutMs),
    );
    try {
      let response: Response;
      try {
        response = await fetch(new URL("/rpc", baseUrl), {
          method: "POST",
          headers,
          body: encodedRequest,
          redirect: "error",
          signal: controller.signal,
        });
      } catch (error) {
        throw new CoreClientTransportError(
          timedOut ? "Core request timed out" : "Core request failed",
          { cause: error },
        );
      }

      return await this.#decodeRpcResponse(response, requestId, timedOut);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async #decodeRpcResponse(
    response: Response,
    requestId: CoreRpcId,
    timedOut = false,
  ): Promise<RpcOutcome> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (isAbortError(error)) {
        throw new CoreClientTransportError(
          timedOut ? "Core request timed out" : "Core request aborted",
          { cause: error },
        );
      }
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          error: new CoreClientRpcError(
            { code: -32001, message: "authentication required" },
            requestId,
            response.status,
          ),
          status: response.status,
          unauthenticated: true,
        };
      }
      throw new CoreClientProtocolError("Core returned invalid JSON", {
        cause: error,
      });
    }

    const message = parseCoreRpcMessage(payload);
    if (message === undefined || !isResponseMessage(message)) {
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          error: new CoreClientRpcError(
            { code: -32001, message: "authentication required" },
            requestId,
            response.status,
          ),
          status: response.status,
          unauthenticated: true,
        };
      }
      throw new CoreClientProtocolError(
        "Core returned an invalid JSON-RPC response envelope",
      );
    }

    const authenticationStatus =
      response.status === 401 || response.status === 403;
    if (
      message.id !== requestId &&
      !(authenticationStatus && message.id === null)
    ) {
      throw new CoreClientProtocolError(
        "Core JSON-RPC response ID does not match the request",
      );
    }

    if (authenticationStatus) {
      const responseError = "error" in message ? message.error : undefined;
      return {
        ok: false,
        error: new CoreClientRpcError(
          responseError ?? {
            code: -32001,
            message: "authentication required",
          },
          requestId,
          response.status,
        ),
        status: response.status,
        unauthenticated: true,
      };
    }

    const responseError = "error" in message ? message.error : undefined;
    if (responseError !== undefined) {
      return {
        ok: false,
        error: new CoreClientRpcError(
          responseError,
          requestId,
          response.status,
        ),
        status: response.status,
        unauthenticated: responseError.code === -32001,
      };
    }

    return {
      ok: true,
      result: message.result,
      status: response.status,
    };
  }

  #nextId(): string {
    const id = `core-client-${this.#nextRequestId++}`;
    return id;
  }

  #assertAuthenticationAvailable(): void {
    if (this.#config.auth && this.#authenticationPassword() === undefined) {
      throw new CoreAuthenticationError();
    }
  }

  #authenticationPassword(): string | undefined {
    if (!this.#config.auth) return undefined;
    return this.#selectedPassword ?? deterministicPassword(this.#config);
  }

  #cacheSuccessfulPassword(password: string | undefined): void {
    if (!this.#config.auth) {
      this.#selectedPassword = undefined;
      return;
    }
    if (password !== undefined) this.#selectedPassword = password;
  }

  #matchesInfo(info: CoreInfo): boolean {
    return (
      this.#matchesVersion(info.version, info.protocolVersion) &&
      info.coreProtocolVersion === CORE_PROTOCOL_VERSION
    );
  }

  #matchesVersion(version: string, protocolVersion: number): boolean {
    return (
      version === this.#version && protocolVersion === this.#protocolVersion
    );
  }

  #incompatibleError(
    actualVersion: string | undefined,
    actualProtocolVersion: number | undefined,
    message: string,
    actualCoreProtocolVersion?: number,
  ): CoreIncompatibleError {
    return new CoreIncompatibleError(message, {
      expectedVersion: this.#version,
      actualVersion,
      expectedProtocolVersion: this.#protocolVersion,
      actualProtocolVersion,
      actualCoreProtocolVersion,
    });
  }
}

function createClientId(): string {
  return `core-client-${crypto.randomUUID()}`;
}

function validateMethod(method: string): void {
  if (typeof method !== "string" || method.trim() === "") {
    throw new TypeError("Core RPC method must be a non-empty string");
  }
}

function validateParams(params: unknown): void {
  if (params === undefined) return;
  if (params === null || typeof params !== "object") {
    throw new TypeError("Core RPC params must be an object or array");
  }
}

function validateStartTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CORE_START_TIMEOUT_MS;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_CORE_START_TIMEOUT_MS
  ) {
    throw new TypeError(
      `CoreClient startTimeoutMs must be an integer from 1 to ${MAX_CORE_START_TIMEOUT_MS}`,
    );
  }
  return value;
}

function validateTakeoverWait(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CORE_TAKEOVER_WAIT_MS;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_CORE_TAKEOVER_WAIT_MS
  ) {
    throw new TypeError(
      `CoreClient takeoverWaitMs must be an integer from 0 to ${MAX_CORE_TAKEOVER_WAIT_MS}`,
    );
  }
  return value;
}

function initialPassword(
  config: ResolvedCoreConfig,
  override: string | undefined,
): string | undefined {
  if (override !== undefined) return validateSelectedPassword(override);
  return deterministicPassword(config);
}

function deterministicPassword(config: ResolvedCoreConfig): string | undefined {
  if (!config.auth) return undefined;
  return config.passwords.find((password) => password.length > 0);
}

function validateSelectedPassword(password: string): string {
  if (typeof password !== "string" || password.length === 0) {
    throw new TypeError("CoreClient password must be a non-empty string");
  }
  validateCorePassword(password);
  return password;
}

function copyConfig(config: ResolvedCoreConfig): ResolvedCoreConfig {
  assertResolvedCoreConfig(config);
  return {
    host: config.host,
    port: config.port,
    auth: config.auth,
    passwords: [...config.passwords],
  };
}

function isResponseMessage(
  message: CoreRpcMessage,
): message is CoreRpcSuccessResponse | CoreRpcErrorResponse {
  return "id" in message && ("result" in message || "error" in message);
}

function parseCoreInfo(value: unknown): CoreInfo | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const object = value as Record<string, unknown>;
  if (
    typeof object.version !== "string" ||
    !Number.isInteger(object.protocolVersion) ||
    (object.protocolVersion as number) < 0 ||
    !Number.isInteger(object.coreProtocolVersion) ||
    (object.coreProtocolVersion as number) < 0 ||
    !Array.isArray(object.features) ||
    !object.features.every((feature) => typeof feature === "string")
  ) {
    return undefined;
  }
  return {
    version: object.version,
    protocolVersion: object.protocolVersion as number,
    coreProtocolVersion: object.coreProtocolVersion as number,
    features: [...object.features] as string[],
  };
}

function parseCoreHealth(value: unknown): CoreHealth | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const object = value as Record<string, unknown>;
  if (
    typeof object.healthy !== "boolean" ||
    typeof object.version !== "string" ||
    !Number.isInteger(object.protocolVersion) ||
    (object.protocolVersion as number) < 0
  ) {
    return undefined;
  }
  return {
    healthy: object.healthy,
    version: object.version,
    protocolVersion: object.protocolVersion as number,
  };
}

function parseCoreShutdownResult(
  value: unknown,
): CoreShutdownResult | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const object = value as Record<string, unknown>;
  return object.ok === true ? { ok: true } : undefined;
}

function isLocalCoreHost(value: string): boolean {
  return isLoopbackCoreHost(value) || isWildcardCoreHost(value);
}

/** Reports whether a PID is alive, dead, or indeterminate on this host. */
export function processLiveness(pid: number): "alive" | "dead" | "unknown" {
  try {
    nodeRuntime.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error instanceof nodeRuntime.errors.NotFound) return "dead";
    return "unknown";
  }
}

/** A JSON-RPC "method not found", i.e. a Core older than `core.shutdown`. */
function isMethodNotFoundError(error: unknown): boolean {
  return error instanceof CoreClientRpcError && error.code === -32601;
}

/**
 * Confirms a registration is still the current one before anything destructive
 * is done to it. A registry that cannot answer counts as "not current", so an
 * unverifiable identity fails closed.
 */
async function isCurrentRegistration(
  registry: CoreRegistry,
  registration: CoreRegistration,
): Promise<boolean> {
  try {
    return await registry.isCurrent(registration);
  } catch {
    return false;
  }
}

/** The read-only registry surface used when observing a Core's exit. */
export interface CoreRegistrationReader {
  read(): MaybePromise<CoreRegistration | undefined>;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Waits until the registered Core is observed gone: its registration was
 * removed (or replaced by another owner) or its local process is dead.
 *
 * Returns false when the wait budget expires with the registration still
 * current, so callers can distinguish "requested, still exiting" from
 * "observed exit".
 */
export async function waitForRegistrationExit(
  registry: CoreRegistrationReader,
  registration: CoreRegistration,
  options: {
    timeoutMs: number;
    intervalMs?: number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    signal?: AbortSignal;
  },
): Promise<boolean> {
  const intervalMs = options.intervalMs ?? 50;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + options.timeoutMs;
  while (true) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    let current: CoreRegistration | undefined;
    try {
      current = await registry.read();
    } catch {
      return false;
    }
    if (current === undefined || current.id !== registration.id) return true;
    if (
      isLocalCoreHost(registration.host) &&
      processLiveness(registration.pid) === "dead"
    ) {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs, options.signal);
  }
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
}

function staleResult(
  registration: CoreRegistration | undefined,
  reason: string,
  error?: CoreClientError,
): CoreDiscoveryStale {
  const result: CoreDiscoveryStale = { status: "stale", reason };
  if (registration !== undefined) result.registration = registration;
  if (error !== undefined) result.error = error;
  return result;
}

function incompatibleResult(
  registration: CoreRegistration | undefined,
  url: string | undefined,
  error: CoreIncompatibleError,
  info?: CoreInfo,
): CoreDiscoveryIncompatible {
  // Only expose actual values that were observed in a valid endpoint
  // response; registration metadata is not a substitute for malformed info.
  const result: CoreDiscoveryIncompatible = {
    status: "incompatible",
    expectedVersion: error.expectedVersion,
    expectedProtocolVersion: error.expectedProtocolVersion,
    error,
  };
  if (registration !== undefined) result.registration = registration;
  if (url !== undefined) result.url = url;
  if (info !== undefined || error.actualVersion !== undefined) {
    result.actualVersion = info?.version ?? error.actualVersion;
  }
  if (info !== undefined || error.actualProtocolVersion !== undefined) {
    result.actualProtocolVersion =
      info?.protocolVersion ?? error.actualProtocolVersion;
  }
  const actualCoreProtocolVersion =
    error.actualCoreProtocolVersion ?? info?.coreProtocolVersion;
  if (actualCoreProtocolVersion !== undefined) {
    result.actualCoreProtocolVersion = actualCoreProtocolVersion;
  }
  return result;
}

function discoveryError(result: CoreDiscoveryResult): CoreClientError {
  switch (result.status) {
    case "ready":
      return new CoreClientError("Core is unexpectedly unavailable");
    case "missing":
      return new CoreNotConnectedError(result);
    case "stale":
      return result.error ?? new CoreNotConnectedError(result);
    case "incompatible":
      return result.error;
    case "unauthenticated":
      return result.error;
  }
}

/**
 * Wraps a launcher failure as the typed startup error callers rely on. The
 * launcher error stays the `cause` so a child's own diagnostics (port in use,
 * exit code, sanitized output) remain reachable.
 *
 * A launcher is caller-supplied, so its rejection value is not necessarily an
 * `Error`; anything that is not a `CoreLauncherError` still reports a launcher
 * failure rather than the weaker "did not become ready" message.
 */
function launcherStartupError(
  error: unknown,
  discovery: CoreDiscoveryResult,
  timeoutMs: number,
): CoreStartupError {
  return error instanceof CoreLauncherError
    ? new CoreStartupError(
        `Core launcher failed: ${error.message}`,
        discovery,
        timeoutMs,
        { cause: error },
      )
    : new CoreStartupError(
        "Core launcher failed",
        discovery,
        timeoutMs,
        error === undefined ? {} : { cause: error },
      );
}

/**
 * True when the Core rejected the request because its session is persisted but
 * not resident in the serving process.
 *
 * The Core answers this before starting any work, so the request never had an
 * effect and the caller may re-open the session and replay it. The signal is
 * the dedicated protocol code, never the error message.
 */
function reopensResidentSession(error: unknown): boolean {
  return (
    error instanceof CoreClientRpcError &&
    error.code === CORE_ERROR_SESSION_NOT_RESIDENT
  );
}

/** The session the Core named in a not-resident error, if it named one. */
function residentSessionId(error: unknown): string {
  if (!(error instanceof CoreClientRpcError)) return "";
  const data = error.data;
  if (data === null || typeof data !== "object") return "";
  const sessionId = (data as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" ? sessionId : "";
}

/** WebSocket endpoint of the Core event stream for an HTTP base URL. */
function eventsUrl(baseUrl: string): string {
  return `${baseUrl
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:")}/events`;
}

/** Signals that mean a connection was never established with a Core. */
const NEVER_CONNECTED_CODES = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

const NEVER_CONNECTED_PATTERNS = [
  /connection refused/i,
  /os error 111/i,
  /host (?:is )?unreachable/i,
  /network is unreachable/i,
  /failed to lookup address/i,
];

/** Signals that mean an established connection stopped answering. */
const ENDPOINT_GONE_CODES = new Set([
  ...NEVER_CONNECTED_CODES,
  "ECONNRESET",
  "ENOTCONN",
  "EPIPE",
  "UND_ERR_SOCKET",
]);

const ENDPOINT_GONE_PATTERNS = [
  ...NEVER_CONNECTED_PATTERNS,
  /connection reset/i,
  /os error 104/i,
  /broken pipe/i,
  /os error 32/i,
  /socket hang up/i,
  /other side closed/i,
  // Node's `fetch` reports a Core that disappears while a request is in
  // flight as a *send* failure, not a connection error: the request may
  // already have reached the peer, so the outcome is uncertain and must only
  // invalidate the cached endpoint, never be replayed.
  /connection closed before message completed/i,
  /client error \(SendRequest\)/i,
];

/**
 * Collects the messages and structured codes of an error cause chain.
 *
 * Node's `fetch` reports a refused connection as `TypeError: fetch failed`
 * wrapping a transport error string without a `code`, so classification has
 * to look at the whole chain rather than the top-level error alone.
 */
function transportDiagnostics(error: unknown): {
  text: string;
  codes: Set<string>;
} {
  const parts: string[] = [];
  const codes = new Set<string>();
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (
    current !== null &&
    typeof current === "object" &&
    !seen.has(current)
  ) {
    seen.add(current);
    const value = current as {
      message?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    if (typeof value.message === "string") parts.push(value.message);
    if (typeof value.code === "string") codes.add(value.code.toUpperCase());
    current = value.cause;
  }
  return { text: parts.join("\n"), codes };
}

function transportMatches(
  error: unknown,
  codes: Set<string>,
  patterns: RegExp[],
): boolean {
  const diagnostics = transportDiagnostics(error);
  for (const code of diagnostics.codes) {
    if (codes.has(code)) return true;
  }
  return patterns.some((pattern) => pattern.test(diagnostics.text));
}

/**
 * True when the request never reached a Core, so replaying it against a
 * replacement endpoint cannot duplicate a side effect.
 */
function isNeverConnectedError(error: unknown): boolean {
  return transportMatches(
    error,
    NEVER_CONNECTED_CODES,
    NEVER_CONNECTED_PATTERNS,
  );
}

/**
 * True when the endpoint stopped answering mid-request. The outcome of such a
 * request is uncertain, so it is never replayed — only the cached connection
 * is dropped.
 */
function isEndpointGoneError(error: unknown): boolean {
  return transportMatches(error, ENDPOINT_GONE_CODES, ENDPOINT_GONE_PATTERNS);
}

function discoveryMessage(result: CoreDiscoveryResult): string {
  switch (result.status) {
    case "missing":
      return "No Core registration was found";
    case "stale":
      return `Core registration is stale: ${result.reason}`;
    case "incompatible":
      return "Registered Core is incompatible with this client";
    case "unauthenticated":
      return "Registered Core requires different authentication";
    case "ready":
      return "Core is unexpectedly unavailable";
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function asClientError(error: unknown, fallback: string): CoreClientError {
  if (error instanceof CoreClientError) return error;
  return new CoreClientError(fallback, { cause: error });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("Core operation aborted", "AbortError")
  );
}

function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const active = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (active.length === 0) return undefined;
  const any = (
    AbortSignal as unknown as {
      any?: (signals: AbortSignal[]) => AbortSignal;
    }
  ).any;
  if (typeof any === "function") return any.call(AbortSignal, active);
  const controller = new AbortController();
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller.signal;
}

function sameRegistrationForCleanup(
  left: CoreRegistration,
  right: CoreRegistration | undefined,
): boolean {
  return (
    right !== undefined &&
    left.id === right.id &&
    left.version === right.version &&
    left.protocolVersion === right.protocolVersion &&
    left.pid === right.pid &&
    left.host === right.host &&
    left.connectHost === right.connectHost &&
    left.port === right.port &&
    left.startedAt === right.startedAt
  );
}

async function awaitWithDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(message);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const abort =
      signal === undefined
        ? new Promise<T>(() => undefined)
        : new Promise<T>((_resolve, reject) => {
            onAbort = () => reject(abortReason(signal!));
            signal!.addEventListener("abort", onAbort, { once: true });
            if (signal!.aborted) onAbort();
          });
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), remaining);
      }),
      abort,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined && signal !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function waitBounded(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    void operation.then(finish, finish);
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
}

// Permissions/entrypoint for a Core child launched from source. The child is
// the real runtime host: it runs tools, MCP servers, git, and sandbox binaries.

function createDefaultCoreLauncher(
  stateDir: string,
  secrets: string[] = [],
  version = "",
  protocolVersion = 0,
): CoreLauncher {
  return (signal) => {
    if (signal.aborted) {
      return Promise.reject(
        new DOMException("Core launch aborted", "AbortError"),
      );
    }
    const executable = nodeRuntime.execPath();
    const args = defaultLauncherArgs(executable);
    let child: ChildProcess;
    try {
      child = new nodeRuntime.Command(executable, {
        args,
        env: {
          ...nodeRuntime.env.toObject(),
          OPENSAC_DIR: stateDir,
          ...(version === "" ? {} : { OPENSAC_CORE_VERSION: version }),
          ...(protocolVersion === 0
            ? {}
            : { OPENSAC_CORE_PROTOCOL_VERSION: String(protocolVersion) }),
        },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    } catch (error) {
      return Promise.reject(
        new CoreLauncherError("Core child process could not be started", {
          cause: error,
        }),
      );
    }

    // The Core process is shared and intentionally outlives this client. Do
    // not let its long-lived status/stdio promises keep an ACP bridge process
    // alive after EOF.
    child.unref();
    const output = Promise.all([
      readChildOutput(child.stdout),
      readChildOutput(child.stderr),
    ]);
    return new Promise<void>((_resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = (): void => {
        try {
          child.kill();
        } catch {
          // The child may have exited between the abort and the kill.
        }
        finish(() => reject(abortReason(signal)));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();

      void child.status.then(
        async (status) => {
          const [stdout, stderr] = await output;
          if (settled) return;
          const detail = sanitizeLauncherOutput(
            `${stderr}\n${stdout}`,
            secrets,
          );
          const code =
            typeof status.code === "number" ? status.code : undefined;
          const signalName = status.signal ?? undefined;
          const suffix =
            code === undefined
              ? `signal ${signalName ?? "unknown"}`
              : `code ${code}`;
          finish(() =>
            reject(
              new CoreLauncherError(
                `Core child exited during startup (${suffix})${
                  detail === "" ? "" : `: ${detail}`
                }`,
                {
                  exitCode: code,
                  signal: signalName,
                  detail: detail === "" ? undefined : detail,
                },
              ),
            ),
          );
        },
        (error) => {
          finish(() =>
            reject(
              new CoreLauncherError("Core child status could not be read", {
                cause: error,
              }),
            ),
          );
        },
      );
    });
  };
}

async function readChildOutput(
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
  if (stream === null) return "";
  try {
    return await new Response(stream).text();
  } catch {
    return "";
  }
}

function stripLauncherControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? " " : character;
    })
    .join("");
}

function sanitizeLauncherOutput(value: string, secrets: string[] = []): string {
  let sanitized = stripLauncherControlCharacters(value)
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(
      /((?:password|passwd|token|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    )
    .replace(/(https?:\/\/[^/\s:@]+:)[^@/\s]+@/gi, "$1[redacted]@");
  for (const secret of secrets) {
    if (secret.length > 0) {
      sanitized = sanitized.replaceAll(secret, "[redacted]");
    }
  }
  return sanitized.replace(/\s+/g, " ").trim().slice(0, 1_000);
}

export function defaultLauncherArgs(executable: string): string[] {
  const executableName = basename(executable).toLowerCase();
  if (executableName === "node" || executableName.startsWith("node.")) {
    return [fileURLToPath(new URL("./main.ts", import.meta.url)), "core"];
  }
  return ["core"];
}
