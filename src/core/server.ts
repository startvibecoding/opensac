import { runtime as nodeRuntime } from "../platform/runtime.ts";
import type { Addr, HttpServer, NetAddr } from "../platform/runtime.ts";
import { CORE_CLIENT_ID_HEADER, CoreAuth } from "./auth.ts";
import { assertResolvedCoreConfig } from "./config.ts";
import {
  formatCoreHostForUrl,
  isWildcardCoreHost,
  localCoreConnectHost,
} from "./endpoint.ts";
import {
  CORE_METHODS,
  coreError,
  type CoreHealth,
  type CoreInfo,
  coreResult,
  type CoreRpcMessage,
  type CoreRpcNotification,
  type CoreRpcRequest,
  type CoreShutdownResult,
  parseCoreRpcMessage,
} from "./protocol.ts";
import { type ResolvedCoreConfig } from "./config.ts";
import { CoreEventStream } from "./event_stream.ts";
import { CoreRuntimeDispatcher } from "./dispatcher.ts";
import { CORE_RUNTIME_METHODS } from "./runtime_protocol.ts";
import { type CoreRuntimeHost } from "./runtime.ts";

/** The protocol version implemented by this Core server. */
export const CORE_PROTOCOL_VERSION = 1 as const;

/** Options for the HTTP-only Core server. */
export interface CoreServerOptions {
  config: ResolvedCoreConfig;
  version: string;
  protocolVersion: number;
  /** Optional Runtime Host; Core foundation tests may omit it. */
  runtime?: CoreRuntimeHost;
  /** Optional shared event transport for the Runtime Host. */
  events?: CoreEventStream;
  /**
   * Optional graceful shutdown hook invoked by `core.shutdown`. The Core
   * command owns registration removal and lock release through this hook;
   * without it the method reports "Method not found" instead of pretending
   * to stop a server nobody can clean up.
   */
  onShutdown?: () => void;
}

/** A running Core HTTP listener. */
export interface CoreServerHandle {
  /** The actual address selected by the operating system. */
  readonly address: NetAddr;
  /** A URL that can be used by local HTTP clients. */
  readonly url: string;
  /** Gracefully stops only this HTTP server. Safe to call repeatedly. */
  stop(): Promise<void>;
}

/** Metadata for a startup failure that may have left a partial listener live. */
export interface CoreServerStartFailure {
  /** True when the command must retain process ownership fail-closed. */
  readonly listenerMayBeAlive: boolean;
  /** The shutdown error, when partial-listener cleanup was attempted. */
  readonly cleanupError?: unknown;
}

/** Raised when CoreServer cannot prove that a partial listener was stopped. */
export class CoreServerStartError
  extends Error
  implements CoreServerStartFailure
{
  readonly listenerMayBeAlive = true;
  readonly cleanupError?: unknown;

  constructor(
    message: string,
    options?: { cause?: unknown; cleanupError?: unknown },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "CoreServerStartError";
    this.cleanupError = options?.cleanupError;
  }
}

/** Recognizes both the built-in and structurally compatible start failures. */
export function isCoreServerStartFailure(
  error: unknown,
): error is CoreServerStartFailure {
  if (error instanceof CoreServerStartError) return true;
  if (error === null || typeof error !== "object") return false;
  const candidate = error as Record<string, unknown>;
  return candidate.listenerMayBeAlive === true;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;
const CORE_FEATURES = [
  ...Object.values(CORE_METHODS),
  ...Object.values(CORE_RUNTIME_METHODS),
];

/**
 * The HTTP transport for the Core protocol.
 *
 * Discovery, registration, locking, and process cleanup intentionally remain
 * outside this class. It owns only the Node HTTP listener and its request
 * projection.
 */
export class CoreServer {
  readonly #options: CoreServerOptions;
  readonly #events: CoreEventStream;
  readonly #dispatcher: CoreRuntimeDispatcher | undefined;
  #startPromise: Promise<CoreServerHandle> | undefined;

  constructor(options: CoreServerOptions) {
    this.#options = options;
    this.#events = options.events ?? new CoreEventStream();
    this.#dispatcher =
      options.runtime === undefined
        ? undefined
        : new CoreRuntimeDispatcher({
            host: options.runtime,
            events: this.#events,
          });
  }

  /** Starts the listener, or returns the already-started listener handle. */
  start(signal?: AbortSignal): Promise<CoreServerHandle> {
    this.#startPromise ??= this.#start(signal);
    return this.#startPromise;
  }

  async #start(signal?: AbortSignal): Promise<CoreServerHandle> {
    throwIfAborted(signal);
    const { config } = this.#options;
    assertResolvedCoreConfig(config);
    if (config.auth && !config.passwords.some((password) => password !== "")) {
      throw new Error(
        "Core authentication requires at least one non-empty password",
      );
    }

    let resolveAddress!: (address: NetAddr) => void;
    let rejectAddress!: (error: unknown) => void;
    const addressReady = new Promise<NetAddr>((resolve, reject) => {
      resolveAddress = resolve;
      rejectAddress = reject;
    });

    let server: HttpServer;
    try {
      server = nodeRuntime.serve(
        {
          hostname: config.host,
          port: config.port,
          onListen: (address) => {
            try {
              resolveAddress(asNetAddress(address));
            } catch (error) {
              rejectAddress(error);
            }
          },
          // node:http reports a bind failure (e.g. EADDRINUSE) asynchronously
          // through the server's `error` event, so surface it as a rejection
          // instead of leaving `addressReady` pending forever.
          onError: (error) => rejectAddress(error),
        },
        (request) => this.#handleRequest(request),
      );
    } catch (error) {
      // nodeRuntime.serve reports bind failures synchronously. There is no listener
      // to await in that case, so do not leave an unobserved rejected promise.
      throw error;
    }

    let shutdownPromise: Promise<void> | undefined;
    let shutdownFailed = false;
    let shutdownError: unknown;
    const shutdownPartialListener = (): Promise<void> => {
      shutdownPromise ??= (async () => {
        try {
          await server.shutdown();
        } catch (error) {
          if (!isExpectedShutdownError(error)) {
            shutdownFailed = true;
            shutdownError = error;
            throw error;
          }
        }
        try {
          await server.finished;
        } catch (error) {
          if (!isExpectedShutdownError(error)) {
            shutdownFailed = true;
            shutdownError = error;
            throw error;
          }
        }
      })();
      return shutdownPromise;
    };

    let abortListener: (() => void) | undefined;
    if (signal !== undefined) {
      abortListener = () => {
        rejectAddress(abortReason(signal));
        void shutdownPartialListener().catch(() => undefined);
      };
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) abortListener();
    }

    let address: NetAddr;
    try {
      address = await addressReady;
    } catch (error) {
      try {
        await shutdownPartialListener();
      } catch (cleanupError) {
        throw new CoreServerStartError(
          "Core server startup failed and listener shutdown is uncertain",
          {
            cause: error,
            cleanupError: shutdownError ?? cleanupError,
          },
        );
      }
      if (shutdownFailed) {
        throw new CoreServerStartError(
          "Core server startup failed and listener shutdown is uncertain",
          { cause: error, cleanupError: shutdownError },
        );
      }
      throw error;
    } finally {
      if (abortListener !== undefined && signal !== undefined) {
        signal.removeEventListener("abort", abortListener);
      }
    }

    const handle = new CoreHttpServerHandle(
      server,
      address,
      buildServerUrl(config.host, address.port),
      async () => {
        await this.#events.close();
        await this.#options.runtime?.close();
      },
    );
    return handle;
  }

  async #handleRequest(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    if (pathname === "/health") {
      if (request.method !== "GET") {
        return methodNotAllowed(["GET"]);
      }
      return jsonResponse({ healthy: true });
    }

    if (pathname === "/events") {
      if (!CoreAuth.authenticate(request, this.#options.config)) {
        return jsonRpcErrorResponse(
          null,
          -32001,
          "authentication required",
          401,
          { "www-authenticate": "Bearer" },
        );
      }
      if (request.method !== "GET") return methodNotAllowed(["GET"]);
      const client = resolveClientIdentity(request);
      this.#events.registerClient(client.clientId, client.remoteAddress);
      const upgraded = nodeRuntime.upgradeWebSocket(request);
      this.#attachEventSocket(upgraded.socket, client.clientId);
      return upgraded.response;
    }

    if (pathname !== "/rpc") {
      return jsonRpcErrorResponse(null, -32601, "Not found", 404);
    }

    if (!CoreAuth.authenticate(request, this.#options.config)) {
      return jsonRpcErrorResponse(
        null,
        -32001,
        "authentication required",
        401,
        { "www-authenticate": "Bearer" },
      );
    }

    if (request.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }

    let input: unknown;
    try {
      input = await request.json();
    } catch {
      return jsonRpcErrorResponse(null, -32700, "Parse error", 400);
    }

    const message = parseCoreRpcMessage(input);
    if (message === undefined) {
      return jsonRpcErrorResponse(null, -32600, "Invalid Request", 400);
    }

    if (!isRequestOrNotification(message)) {
      return jsonRpcErrorResponse(null, -32600, "Invalid Request", 400);
    }

    // The client identity travels to the dispatcher for subscription
    // attribution. It is registered conditionally (see `registerRpcClient`):
    // the row survives while the client owns subscriptions and drops when its
    // last one releases, so a stateless HTTP caller never leaves a ghost.
    const response = await this.#dispatch(message, request.signal, {
      clientId: resolveClientIdentity(request).clientId,
    });
    if (!("id" in message)) {
      // JSON-RPC notifications are one-way and must not receive a response
      // envelope. The method still runs so health/info remain useful to
      // notification-capable transports.
      return new Response(null, { status: 204 });
    }
    return jsonResponse(response);
  }

  async #dispatch(
    message: CoreRpcRequest | CoreRpcNotification,
    signal: AbortSignal,
    context?: { clientId?: string },
  ): Promise<
    ReturnType<typeof coreResult> | ReturnType<typeof coreError> | undefined
  > {
    const { version, protocolVersion } = this.#options;
    const id = "id" in message ? message.id : null;

    switch (message.method) {
      case CORE_METHODS.health: {
        const result: CoreHealth = {
          healthy: true,
          version,
          protocolVersion,
        };
        return "id" in message ? coreResult(id, result) : undefined;
      }
      case CORE_METHODS.info: {
        const result: CoreInfo = {
          version,
          protocolVersion,
          coreProtocolVersion: CORE_PROTOCOL_VERSION,
          features: [...CORE_FEATURES],
        };
        return "id" in message ? coreResult(id, result) : undefined;
      }
      case CORE_METHODS.clientsList: {
        const result = {
          clients: this.#events.listClients().map((client) => ({
            clientId: client.clientId,
            ...(client.remoteAddress === undefined
              ? {}
              : { remoteAddress: client.remoteAddress }),
            connectedAt: client.connectedAt,
            subscriptions: client.subscriptions.map((subscription) => ({
              ...subscription,
            })),
          })),
        };
        return "id" in message ? coreResult(id, result) : undefined;
      }
      case CORE_METHODS.shutdown: {
        // JSON-RPC notifications are one-way and must never be able to stop
        // the shared Core; only a request with an id is acknowledged.
        if (!("id" in message)) return undefined;
        const onShutdown = this.#options.onShutdown;
        if (onShutdown === undefined) {
          return coreError(id, -32601, "Method not found");
        }
        // Schedule the stop after the response is handed back so the caller
        // observes the acknowledgement before the listener starts closing.
        setTimeout(() => onShutdown(), 0);
        const result: CoreShutdownResult = { ok: true };
        return coreResult(id, result);
      }
      default: {
        const dispatcher = this.#dispatcher;
        if (dispatcher === undefined) {
          return "id" in message
            ? coreError(id, -32601, "Method not found")
            : undefined;
        }
        return await dispatcher.dispatch(message, signal, context);
      }
    }
  }

  #attachEventSocket(socket: WebSocket, clientId: string): void {
    const send = (value: unknown): void => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(value));
      }
    };
    const stopEvents = this.#events.onEvent((event) => {
      send({
        jsonrpc: "2.0",
        method: "run.event",
        params: event,
      });
    });
    const stopRequests = this.#events.onRequest((request) => send(request));
    socket.onmessage = (event) => {
      void this.#handleEventSocketMessage(event.data, socket, clientId);
    };
    socket.onclose = () => {
      stopEvents();
      stopRequests();
      this.#events.unregisterClient(clientId);
    };
  }

  async #handleEventSocketMessage(
    data: unknown,
    socket: WebSocket,
    clientId: string,
  ): Promise<void> {
    if (typeof data !== "string") return;
    let input: unknown;
    try {
      input = JSON.parse(data);
    } catch {
      socket.send(JSON.stringify(coreError(null, -32700, "Parse error")));
      return;
    }
    const message = parseCoreRpcMessage(input);
    if (message === undefined) {
      socket.send(JSON.stringify(coreError(null, -32600, "Invalid Request")));
      return;
    }
    if (!("method" in message) || typeof message.method !== "string") {
      if ("id" in message) this.#events.respond(message);
      return;
    }
    const response = await this.#dispatch(
      message,
      new AbortController().signal,
      { clientId },
    );
    if (response !== undefined && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(response));
    }
  }
}

class CoreHttpServerHandle implements CoreServerHandle {
  readonly address: NetAddr;
  readonly url: string;
  readonly #server: HttpServer;
  readonly #cleanup: () => Promise<void>;
  #stopPromise: Promise<void> | undefined;

  constructor(
    server: HttpServer,
    address: NetAddr,
    url: string,
    cleanup: () => Promise<void>,
  ) {
    this.#server = server;
    this.address = address;
    this.url = url;
    this.#cleanup = cleanup;
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stop();
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    try {
      await this.#server.shutdown();
    } catch (error) {
      if (!isExpectedShutdownError(error)) throw error;
    }

    try {
      await this.#server.finished;
    } catch (error) {
      if (!isExpectedShutdownError(error)) throw error;
    }
    await this.#cleanup();
  }
}

/**
 * Resolves the identity of one Core client from an incoming request.
 *
 * Both transports need it: the `/events` upgrade registers the client so
 * `core.clients.list` can report it, and the `/rpc` path must attach the same
 * identity to a `run.events.subscribe` so the subscription is attributed to the
 * connection that created it rather than appearing ownerless. A caller that
 * sends no header gets a generated id, which keeps a plain HTTP or legacy client
 * observable for its own connection lifetime.
 */
function resolveClientIdentity(request: Request): {
  clientId: string;
  remoteAddress?: string;
} {
  const clientId =
    request.headers.get(CORE_CLIENT_ID_HEADER)?.trim() ||
    `event-${crypto.randomUUID()}`;
  const forwarded = request.headers
    .get("x-forwarded-for")
    ?.split(",")
    .at(0)
    ?.trim();
  return {
    clientId,
    ...(forwarded === undefined || forwarded === ""
      ? {}
      : {
          remoteAddress: forwarded,
        }),
  };
}
function isRequestOrNotification(
  message: CoreRpcMessage,
): message is CoreRpcRequest | CoreRpcNotification {
  return "method" in message;
}

function asNetAddress(address: Addr): NetAddr {
  if (
    address.transport !== "tcp" ||
    typeof address.hostname !== "string" ||
    typeof address.port !== "number"
  ) {
    throw new TypeError("Core server must bind a TCP address");
  }
  return address;
}

function buildServerUrl(hostname: string, port: number): string {
  const connectHost = isWildcardCoreHost(hostname)
    ? localCoreConnectHost(hostname)
    : hostname;
  return `http://${formatCoreHostForUrl(connectHost)}:${port}`;
}

function methodNotAllowed(allow: string[]): Response {
  return jsonRpcErrorResponse(null, -32600, "Method not allowed", 405, {
    allow: allow.join(", "),
  });
}

function jsonRpcErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return jsonResponse(coreError(id, code, message), status, extraHeaders);
}

function jsonResponse(
  value: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  const headers = new Headers(JSON_HEADERS);
  for (const [name, headerValue] of Object.entries(extraHeaders)) {
    headers.set(name, headerValue);
  }
  return new Response(`${JSON.stringify(value)}\n`, { status, headers });
}

function isExpectedShutdownError(error: unknown): boolean {
  return error instanceof nodeRuntime.errors.BadResource;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException("Core server startup aborted", "AbortError")
  );
}
