import {
  coreError,
  type CoreRpcId,
  type CoreRpcParams,
  type CoreRpcRequest,
  type CoreRpcResponse,
} from "./protocol.ts";
import type { CoreRuntimeEvent } from "./runtime.ts";

export type CoreEventRequest = CoreRpcRequest;
export type CoreEventRequestListener = (request: CoreEventRequest) => void;

interface PendingEvent {
  resolve(response: CoreRpcResponse): void;
}

interface Subscription {
  readonly sessionId: string;
  readonly runId: string;
  enqueue(event: CoreRuntimeEvent): void;
  next(): Promise<IteratorResult<CoreRuntimeEvent>>;
  return(): Promise<IteratorResult<CoreRuntimeEvent>>;
  [Symbol.asyncIterator](): AsyncIterableIterator<CoreRuntimeEvent>;
}

/** In-memory ordered event and reverse-request transport for one Core host. */
export class CoreEventStream {
  readonly #events = new Map<string, CoreRuntimeEvent[]>();
  readonly #subscriptions = new Set<Subscription>();
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
  ): AsyncIterableIterator<CoreRuntimeEvent> {
    this.#assertOpen();
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
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    this.#subscriptions.add(subscription);
    return subscription;
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
    this.#requestListeners.clear();
    this.#eventListeners.clear();
  }
}
