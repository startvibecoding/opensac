import {
  coreError,
  type CoreRpcId,
  type CoreRpcParams,
  type CoreRpcRequest,
  type CoreRpcResponse,
} from "./protocol.ts";
import { type CoreRuntimeEvent } from "./runtime.ts";

export type CoreEventRequest = CoreRpcRequest;
export type CoreEventRequestListener = (request: CoreEventRequest) => void;

interface PendingEvent {
  resolve(response: CoreRpcResponse): void;
}

interface Subscription {
  readonly clientId?: string;
  readonly sessionId: string;
  readonly runId: string;
  enqueue(event: CoreRuntimeEvent): void;
  next(): Promise<IteratorResult<CoreRuntimeEvent>>;
  return(): Promise<IteratorResult<CoreRuntimeEvent>>;
  [Symbol.asyncIterator](): AsyncIterableIterator<CoreRuntimeEvent>;
}

/** Observable state for one live Core event client. */
export interface CoreEventClientState {
  clientId: string;
  remoteAddress?: string;
  connectedAt: number;
  subscriptions: Array<{ sessionId: string; runId: string }>;
}

/** In-memory ordered event and reverse-request transport for one Core host. */
export class CoreEventStream {
  readonly #events = new Map<string, CoreRuntimeEvent[]>();
  readonly #subscriptions = new Set<Subscription>();
  readonly #clients = new Map<
    string,
    { remoteAddress?: string; connectedAt: number }
  >();
  // Identities that reached the Core over the stateless `/rpc` channel only.
  // An HTTP request has no connection to watch, so a client row is kept while
  // it can still own subscriptions and is dropped once it holds none: an RPC
  // `run.events.subscribe` must stay attributable in `core.clients.list`, and
  // a stateless caller must not leave a permanent ghost row behind.
  readonly #rpcOnlyClients = new Set<string>();
  // One attribution row per client: the RPC-channel `run.events.subscribe`
  // record, keyed by the identity that issued it. Distinct from the socket
  // subscriptions in `#subscriptions`, an attribution never receives events;
  // it exists so `listClients` can report what each connection watches.
  readonly #attributions = new Map<
    string,
    { key: string; sessionId: string; runId: string }
  >();
  readonly #requestListeners = new Set<CoreEventRequestListener>();
  readonly #eventListeners = new Set<(event: CoreRuntimeEvent) => void>();
  readonly #pendingRequests = new Map<string, PendingEvent>();
  #closed = false;

  #key(sessionId: string, runId: string): string {
    return `${sessionId}\u0000${runId}`;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("core event stream is closed");
  }

  publish(event: CoreRuntimeEvent): void {
    this.#assertOpen();
    const key = this.#key(event.sessionId, event.runId);
    const events = this.#events.get(key) ?? [];
    const previous = events.at(-1);
    if (previous !== undefined && event.sequence <= previous.sequence) return;
    const stored = { ...event, payload: { ...event.payload } };
    events.push(stored);
    this.#events.set(key, events);
    for (const listener of this.#eventListeners) listener(stored);
    for (const subscription of this.#subscriptions) {
      if (
        subscription.sessionId === stored.sessionId &&
        subscription.runId === stored.runId
      ) {
        subscription.enqueue(stored);
      }
    }
  }

  onEvent(listener: (event: CoreRuntimeEvent) => void): () => void {
    this.#assertOpen();
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  replay(
    sessionId: string,
    runId: string,
    cursor = 0,
  ): CoreRuntimeEvent[] {
    this.#assertOpen();
    return (this.#events.get(this.#key(sessionId, runId)) ?? [])
      .filter((event) => event.sequence > cursor)
      .map((event) => ({ ...event, payload: { ...event.payload } }));
  }

  subscribe(
    sessionId: string,
    runId: string,
    cursor = 0,
    client?: { clientId: string; remoteAddress?: string },
  ): AsyncIterableIterator<CoreRuntimeEvent> {
    this.#assertOpen();
    if (client !== undefined) {
      this.registerClient(client.clientId, client.remoteAddress);
    }
    const queue = this.replay(sessionId, runId, cursor);
    let resolveNext:
      | ((result: IteratorResult<CoreRuntimeEvent>) => void)
      | undefined;
    let finished = false;

    const finish = (): void => {
      finished = true;
      if (resolveNext !== undefined) {
        resolveNext({ done: true, value: undefined });
        resolveNext = undefined;
      }
    };

    const subscription: Subscription = {
      ...(client === undefined ? {} : { clientId: client.clientId }),
      sessionId,
      runId,
      enqueue(event) {
        if (finished) return;
        if (resolveNext !== undefined) {
          const resolve = resolveNext;
          resolveNext = undefined;
          resolve({ done: false, value: event });
        } else {
          queue.push(event);
        }
      },
      next() {
        if (queue.length > 0) {
          return Promise.resolve({ done: false, value: queue.shift()! });
        }
        if (finished) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          resolveNext = resolve;
        });
      },
      return: async () => {
        await Promise.resolve();
        finish();
        this.#subscriptions.delete(subscription);
        // A live socket iterator's release must not drop the client row if
        // an attribution still references it; the conditional mark decides.
        this.#releaseRpcOnlyClient(subscription.clientId);
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    this.#subscriptions.add(subscription);
    return subscription;
  }

  registerClient(clientId: string, remoteAddress?: string): void {
    this.#assertOpen();
    // A real connection (the `/events` upgrade) makes the row unconditional:
    // the socket's own close path owns its removal from here on.
    this.#rpcOnlyClients.delete(clientId);
    const existing = this.#clients.get(clientId);
    const nextRemoteAddress = remoteAddress ?? existing?.remoteAddress;
    this.#clients.set(clientId, {
      ...(nextRemoteAddress === undefined
        ? {}
        : { remoteAddress: nextRemoteAddress }),
      connectedAt: existing?.connectedAt ?? Date.now(),
    });
  }

  /**
   * Registers one identity seen on the stateless `/rpc` channel. Unlike
   * `registerClient`, this keeps the row conditional: it is removed as soon
   * as it owns no subscription, so an operator never sees a dead RPC client
   * listed forever. A later socket registration upgrades the row to
   * unconditional (the socket's own close path then owns its removal).
   */
  registerRpcClient(clientId: string, remoteAddress?: string): void {
    this.#assertOpen();
    const existing = this.#clients.get(clientId);
    const nextRemoteAddress = remoteAddress ?? existing?.remoteAddress;
    this.#clients.set(clientId, {
      ...(nextRemoteAddress === undefined
        ? {}
        : { remoteAddress: nextRemoteAddress }),
      connectedAt: existing?.connectedAt ?? Date.now(),
    });
    this.#rpcOnlyClients.add(clientId);
  }

  /**
   * Attaches one RPC-channel subscription to the calling client's identity.
   * The row exists only for attribution — live events reach the client
   * through its event socket's own subscription — so it carries no drain
   * iterator and receives nothing from `publish`.
   */
  attributeSubscription(
    sessionId: string,
    runId: string,
    clientId: string,
  ): void {
    this.#assertOpen();
    if (this.#attributions.has(clientId)) {
      throw new Error(`duplicate Core subscription attribution: ${clientId}`);
    }
    this.registerRpcClient(clientId);
    const key = this.#key(sessionId, runId);
    this.#attributions.set(clientId, { key, sessionId, runId });
  }

  /**
   * Releases one client's attribution row. The conditional (rpc-only) client
   * row drops with it unless a live socket subscription still references the
   * identity; a socket-owned row survives until its socket closes. Returns
   * false when the client holds no attribution.
   */
  releaseAttribution(clientId: string): boolean {
    const attribution = this.#attributions.get(clientId);
    if (attribution === undefined) return false;
    this.#attributions.delete(clientId);
    // Keep the row while the client still owns a live socket subscription;
    // otherwise the last fact about it is gone.
    for (const subscription of this.#subscriptions) {
      if (subscription.clientId === clientId) return true;
    }
    this.#releaseRpcOnlyClient(clientId);
    return true;
  }

  unregisterClient(clientId: string): void {
    this.#rpcOnlyClients.delete(clientId);
    this.#clients.delete(clientId);
  }

  /** Drops an rpc-only row that no longer owns any subscription. */
  #releaseRpcOnlyClient(clientId: string | undefined): void {
    if (clientId === undefined) return;
    if (!this.#rpcOnlyClients.has(clientId)) return;
    for (const subscription of this.#subscriptions) {
      if (subscription.clientId === clientId) return;
    }
    this.#clients.delete(clientId);
    this.#rpcOnlyClients.delete(clientId);
  }

  listClients(): CoreEventClientState[] {
    return [...this.#clients.entries()]
      .filter(([clientId]) => !this.#isHiddenGhostRow(clientId))
      .map(([clientId, client]) => ({
        clientId,
        ...(client.remoteAddress === undefined
          ? {}
          : { remoteAddress: client.remoteAddress }),
        connectedAt: client.connectedAt,
        subscriptions: [
          ...[
            ...this.#subscriptions,
            ...this.#attributionRowsFor(clientId),
          ].map((subscription) => ({
            sessionId: subscription.sessionId,
            runId: subscription.runId,
          })),
        ],
      }));
  }

  /**
   * An rpc-only identity with neither a live subscription nor an attribution
   * is invisible: listing it would claim a connection that owns nothing.
   */
  #isHiddenGhostRow(clientId: string): boolean {
    if (!this.#rpcOnlyClients.has(clientId)) return false;
    if (this.#attributions.has(clientId)) return false;
    for (const subscription of this.#subscriptions) {
      if (subscription.clientId === clientId) return false;
    }
    return true;
  }

  #attributionRowsFor(
    clientId: string,
  ): Array<{ sessionId: string; runId: string }> {
    const attribution = this.#attributions.get(clientId);
    return attribution === undefined
      ? []
      : [{ sessionId: attribution.sessionId, runId: attribution.runId }];
  }

  onRequest(listener: CoreEventRequestListener): () => void {
    this.#requestListeners.add(listener);
    return () => this.#requestListeners.delete(listener);
  }

  request(
    id: CoreRpcId,
    method: string,
    params?: CoreRpcParams,
  ): Promise<CoreRpcResponse> {
    this.#assertOpen();
    const key = JSON.stringify(id);
    if (this.#pendingRequests.has(key)) {
      throw new Error(`duplicate Core reverse request id: ${String(id)}`);
    }
    const request: CoreEventRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    const response = new Promise<CoreRpcResponse>((resolve) => {
      this.#pendingRequests.set(key, { resolve });
    });
    for (const listener of this.#requestListeners) listener(request);
    return response;
  }

  respond(response: CoreRpcResponse): void {
    const key = JSON.stringify(response.id);
    const pending = this.#pendingRequests.get(key);
    if (pending === undefined) {
      throw new Error(
        `unknown Core reverse request id: ${String(response.id)}`,
      );
    }
    this.#pendingRequests.delete(key);
    pending.resolve(response);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const [key, pending] of this.#pendingRequests) {
      const id = JSON.parse(key) as CoreRpcId;
      pending.resolve(coreError(id, -32000, "core event stream closed"));
    }
    this.#pendingRequests.clear();
    for (const subscription of this.#subscriptions) {
      await subscription.return();
    }
    this.#events.clear();
    this.#clients.clear();
    this.#rpcOnlyClients.clear();
    this.#attributions.clear();
    this.#requestListeners.clear();
    this.#eventListeners.clear();
  }
}
