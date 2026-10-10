import {
  type CoreClient,
  CoreClientRpcError,
  type CoreEventConnection,
} from "../core/client.ts";
import {
  coreError,
  coreResult,
  type CoreRpcRequest,
  type CoreRpcResponse,
} from "../core/protocol.ts";
import { type CoreRuntimeEvent } from "../core/runtime.ts";
import { type CoreServerRequest } from "./bridge_protocol.ts";

export interface BridgeCoreClient {
  connect(): Promise<void>;
  callCore(request: CoreRpcRequest): Promise<CoreRpcResponse>;
  subscribe(sessionId: string, runId: string, cursor?: number): Promise<void>;
  replay(sessionId: string, runId: string, cursor?: number): Promise<unknown>;
  onEvent(listener: (event: CoreRuntimeEvent) => void): () => void;
  onReverseRequest(listener: (request: CoreServerRequest) => void): () => void;
  respondToReverseRequest(response: CoreRpcResponse): void;
  close(): Promise<void>;
  reconnect(): Promise<void>;
}

export interface ACPBridgeClientOptions {
  core: CoreClient;
}

/** Core-facing client used by the ACP protocol bridge. */
export class ACPBridgeClient implements BridgeCoreClient {
  readonly #core: CoreClient;
  #events: CoreEventConnection | undefined;
  #stopEvents: (() => void) | undefined;
  #stopReverse: (() => void) | undefined;
  #eventListeners = new Set<(event: CoreRuntimeEvent) => void>();
  #reverseListeners = new Set<(request: CoreServerRequest) => void>();
  #subscriptions = new Map<
    string,
    { sessionId: string; runId: string; cursor: number }
  >();
  #connected = false;

  constructor(options: ACPBridgeClientOptions) {
    this.#core = options.core;
  }

  async connect(): Promise<void> {
    if (this.#connected) return;
    await this.#core.health();
    const events = await this.#core.connectEvents();
    this.#events = events;
    this.#stopEvents = events.onNotification((notification) => {
      if (notification.method !== "run.event") return;
      const event = notification.params as unknown as CoreRuntimeEvent;
      for (const listener of this.#eventListeners) listener(event);
    });
    this.#stopReverse = events.onRequest((request) => {
      for (const listener of this.#reverseListeners) listener(request);
    });
    this.#connected = true;
  }

  async callCore(request: CoreRpcRequest): Promise<CoreRpcResponse> {
    await this.connect();
    try {
      const result = await this.#core.call(request.method, request.params);
      return coreResult(request.id, result ?? null);
    } catch (error) {
      if (error instanceof CoreClientRpcError) {
        return coreError(request.id, error.code, error.message, error.data);
      }
      throw error;
    }
  }

  async subscribe(sessionId: string, runId: string, cursor = 0): Promise<void> {
    await this.connect();
    await this.#events!.subscribe(sessionId, runId, cursor);
    this.#subscriptions.set(`${sessionId}\u0000${runId}`, {
      sessionId,
      runId,
      cursor,
    });
  }

  async replay(sessionId: string, runId: string, cursor = 0): Promise<unknown> {
    await this.connect();
    return await this.#events!.replay(sessionId, runId, cursor);
  }

  onEvent(listener: (event: CoreRuntimeEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  onReverseRequest(listener: (request: CoreServerRequest) => void): () => void {
    this.#reverseListeners.add(listener);
    return () => this.#reverseListeners.delete(listener);
  }

  respondToReverseRequest(response: CoreRpcResponse): void {
    if (this.#events === undefined) {
      throw new Error("Core event connection is not connected");
    }
    this.#events.respond(response);
  }

  async reconnect(): Promise<void> {
    await this.connect();
    if (this.#events !== undefined) await this.#events.reconnect();
    for (const subscription of this.#subscriptions.values()) {
      await this.#events!.subscribe(
        subscription.sessionId,
        subscription.runId,
        subscription.cursor,
      );
    }
  }

  async close(): Promise<void> {
    if (!this.#connected) return;
    this.#connected = false;
    this.#stopEvents?.();
    this.#stopReverse?.();
    this.#stopEvents = undefined;
    this.#stopReverse = undefined;
    await this.#events?.close();
    this.#events = undefined;
    await this.#core.close();
    this.#eventListeners.clear();
    this.#reverseListeners.clear();
    this.#subscriptions.clear();
  }
}
