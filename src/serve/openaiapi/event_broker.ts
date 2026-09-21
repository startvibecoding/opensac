// Ported from internal/serve/openaiapi/event_broker.go (the unified event
// distribution hub). Go's buffered subscriber channels map to a bounded
// asynchronous queue per subscription: a full queue drops the event for that
// subscriber (Publish) or closes the subscription and signals resync
// (PublishWithResync), exactly like Go's non-blocking channel send.
// `sync.RWMutex` and `sync/atomic` are dropped because Deno is single-threaded
// and these methods are synchronous.

/**
 * BrokerEvent is the unified event envelope used by EventBroker.
 * Every event flowing through the system carries a sessionID, optional runID,
 * a stream name, an event name, a monotonic seq, and arbitrary data.
 */
export interface BrokerEvent {
  sessionId: string;
  runId?: string;
  /** "transcript", "run", "capability", "tool", "approval", "runtime", "control", "esm" */
  stream: string;
  /** e.g. "tool_event", "transcript", "runtime_event", "done" */
  event: string;
  seq: number;
  data?: unknown;
}

const BROKER_BUFFER = 256;

export function formatRFC3339NanoUTC(d: Date): string {
  // Go's time.RFC3339Nano trims trailing fractional zeros; Date only carries
  // millisecond precision, so the fraction is emitted only when non-zero.
  const base = d.toISOString();
  const ms = d.getUTCMilliseconds();
  if (ms === 0) return base.replace(".000Z", "Z");
  return base.replace(/\.\d{3}Z$/, `.${String(ms).replace(/0+$/, "")}Z`);
}

/**
 * The TS projection of Go's `<-chan BrokerEvent`: an async stream whose
 * `next()` resolves with the next event, or `undefined` once the subscription
 * is closed and the buffered events are drained. `resync` resolves only when
 * backpressure closed the subscription (never on ordinary unsubscribe), so
 * protocol adapters can distinguish the two.
 */
export class BrokerEventStream {
  #queue: BrokerEvent[] = [];
  #waiters: ((value: BrokerEvent | undefined) => void)[] = [];
  #closed = false;
  #resyncResolve: (() => void) | null = null;
  readonly #resync: Promise<void>;

  constructor() {
    this.#resync = new Promise<void>((resolve) => {
      this.#resyncResolve = resolve;
    });
  }

  get resync(): Promise<void> {
    return this.#resync;
  }

  /** Receives the next event, or undefined when closed and drained. */
  next(): Promise<BrokerEvent | undefined> {
    if (this.#queue.length > 0) {
      return Promise.resolve(this.#queue.shift());
    }
    if (this.#closed) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<BrokerEvent, void, unknown> {
    for (;;) {
      const ev = await this.next();
      if (ev === undefined) return;
      yield ev;
    }
  }

  /** Non-blocking send used by Publish. Returns false when full. */
  offer(ev: BrokerEvent): boolean {
    if (this.#closed || this.#queue.length >= BROKER_BUFFER) return false;
    this.#deliver(ev);
    return true;
  }

  /** Closes the subscription; buffered events remain readable. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#flushWaiters();
  }

  /** Signals backpressure and closes the subscription. */
  overflow(): void {
    if (this.#closed) return;
    const resolve = this.#resyncResolve;
    this.#resyncResolve = null;
    this.#closed = true;
    this.#flushWaiters();
    if (resolve) resolve();
  }

  #deliver(ev: BrokerEvent): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter(ev);
      return;
    }
    this.#queue.push(ev);
  }

  #flushWaiters(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter(undefined);
  }
}

/**
 * EventBroker is the single event distribution hub for all session events.
 * It replaces sessionStreamHub as the unified publish/subscribe layer.
 */
export class EventBroker {
  #subscribers = new Map<string, Set<BrokerEventStream>>();
  #resync = new Map<BrokerEventStream, BrokerEventStream>();
  #seqs = new Map<string, number>();

  /** Returns the next monotonic sequence number for a session. */
  #nextSeq(sessionId: string): number {
    if (sessionId === "") return 0;
    const counter = this.#seqs.get(sessionId) ?? 0;
    const next = counter + 1;
    this.#seqs.set(sessionId, next);
    return next;
  }

  /**
   * Subscribe returns an event stream that receives BrokerEvent for the given
   * session. The returned cancel function unsubscribes and closes the stream.
   */
  subscribe(sessionId: string): {
    events: BrokerEventStream;
    cancel: () => void;
  } {
    const { events, cancel } = this.subscribeWithResync(sessionId);
    return { events, cancel };
  }

  /**
   * SubscribeWithResync also exposes a signal that resolves only when this
   * subscriber overflowed and must reconnect/replay. Ordinary unsubscribe only
   * closes the event stream, so protocol adapters can distinguish the two.
   */
  subscribeWithResync(sessionId: string): {
    events: BrokerEventStream;
    resync: Promise<void>;
    cancel: () => void;
  } {
    const events = new BrokerEventStream();
    if (sessionId === "") {
      events.close();
      return { events, resync: events.resync, cancel: () => {} };
    }
    let subs = this.#subscribers.get(sessionId);
    if (!subs) {
      subs = new Set();
      this.#subscribers.set(sessionId, subs);
    }
    subs.add(events);
    this.#resync.set(events, events);

    let cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      const current = this.#subscribers.get(sessionId);
      if (current && current.has(events)) {
        current.delete(events);
        this.#resync.delete(events);
        events.close();
      }
      if (current && current.size === 0) {
        this.#subscribers.delete(sessionId);
      }
    };
    return { events, resync: events.resync, cancel };
  }

  /**
   * Publish sends an event to all subscribers of the event's session.
   * Events are delivered best-effort; if a subscriber's queue is full, the
   * event is dropped for that subscriber and the subscriber is NOT
   * automatically closed. Callers should use PublishWithResync for
   * backpressure-aware delivery.
   */
  publish(ev: BrokerEvent): void {
    if (ev.sessionId === "") return;
    if (ev.seq === 0) ev.seq = this.#nextSeq(ev.sessionId);
    const subs = this.#subscribers.get(ev.sessionId);
    if (!subs) return;
    for (const sub of subs) {
      // Subscriber is too slow; drop the event for this subscriber.
      // The subscriber should detect gaps via seq and request resync.
      sub.offer(ev);
    }
  }

  /**
   * PublishWithResync is like Publish but signals resync to subscribers whose
   * queues are full, then closes their subscription.
   */
  publishWithResync(ev: BrokerEvent): void {
    if (ev.sessionId === "") return;
    if (ev.seq === 0) ev.seq = this.#nextSeq(ev.sessionId);
    const subs = this.#subscribers.get(ev.sessionId);
    if (!subs) return;
    for (const sub of [...subs]) {
      if (!sub.offer(ev)) {
        // Queue full — signal resync and close.
        subs.delete(sub);
        this.#resync.delete(sub);
        sub.overflow();
      }
    }
  }

  /** Returns the number of subscribers for a session. */
  activeSubscriberCount(sessionId: string): number {
    if (sessionId === "") return 0;
    return this.#subscribers.get(sessionId)?.size ?? 0;
  }

  /**
   * Returns the current monotonic sequence number for a session. This is used
   * to establish a replay boundary: events with seq <= this value are covered
   * by SQLite replay and should not be forwarded as live events.
   */
  currentSeq(sessionId: string): number {
    if (sessionId === "") return 0;
    return this.#seqs.get(sessionId) ?? 0;
  }

  /** Convenience wrapper for tool status events. */
  publishToolEvent(sessionId: string, runId: string, data: unknown): void {
    this.publishWithResync({
      sessionId,
      runId,
      stream: "tool",
      event: "tool_event",
      seq: 0,
      data,
    });
  }

  /** Convenience wrapper for transcript events. */
  publishTranscriptEvent(
    sessionId: string,
    runId: string,
    data: unknown,
  ): void {
    this.publishWithResync({
      sessionId,
      runId,
      stream: "transcript",
      event: "transcript",
      seq: 0,
      data,
    });
  }

  /** Convenience wrapper for runtime snapshot events. */
  publishRuntimeEvent(sessionId: string, runId: string, data: unknown): void {
    this.publishWithResync({
      sessionId,
      runId,
      stream: "runtime",
      event: "runtime_event",
      seq: 0,
      data,
    });
  }

  /** Publishes a run lifecycle event. */
  publishRunEvent(sessionId: string, runId: string, data: unknown): void {
    this.publishWithResync({
      sessionId,
      runId,
      stream: "run",
      event: "run_event",
      seq: 0,
      data,
    });
  }

  /** Publishes a capability change event. */
  publishCapabilityEvent(
    sessionId: string,
    runId: string,
    data: unknown,
  ): void {
    this.publishWithResync({
      sessionId,
      runId,
      stream: "capability",
      event: "capability_event",
      seq: 0,
      data,
    });
  }

  /** Publishes an approval-related event. */
  publishApprovalEvent(
    sessionId: string,
    runId: string,
    event: string,
    data: unknown,
  ): void {
    this.publishWithResync({
      sessionId,
      runId,
      stream: "approval",
      event,
      seq: 0,
      data,
    });
  }

  /** Publishes a stream done event for a session/run. */
  publishDone(sessionId: string, runId: string, data: unknown): void {
    this.publishWithResync({
      sessionId,
      runId,
      stream: "control",
      event: "done",
      seq: 0,
      data,
    });
  }

  /** Sends a keepalive to session subscribers. */
  publishHeartbeat(sessionId: string): void {
    this.publishWithResync({
      sessionId,
      stream: "control",
      event: "heartbeat",
      seq: 0,
      data: {
        sessionId,
        timestamp: formatRFC3339NanoUTC(new Date()),
      },
    });
  }

  /**
   * Publishes a raw JSON payload as an event, preserving the original event
   * name while mapping it onto the unified stream. This is used during
   * migration from sessionStreamHub to EventBroker.
   */
  publishRawJSON(
    sessionId: string,
    runId: string,
    eventName: string,
    data: unknown,
  ): void {
    let stream = eventName;
    switch (eventName) {
      case "tool_event":
        stream = "tool";
        break;
      case "transcript":
        stream = "transcript";
        break;
      case "runtime_event":
        stream = "runtime";
        break;
      case "run_event":
        stream = "run";
        break;
      case "capability_event":
        stream = "capability";
        break;
      case "approval_request":
      case "approval_response":
      case "approval_resolved":
        stream = "approval";
        break;
      case "done":
      case "heartbeat":
        stream = "control";
        break;
      case "esm.updated":
      case "esm.snapshot":
      case "esm.review":
      case "esm.recovery":
      case "esm.completed":
      case "esm.paused":
      case "esm.failed":
        stream = "esm";
        break;
    }
    this.publishWithResync({
      sessionId,
      runId,
      stream,
      event: eventName,
      seq: 0,
      data,
    });
  }
}

/**
 * Helper to prepare event data for durable replay. Go marshals to
 * `json.RawMessage`; the Deno port carries decoded JSON values, so this is the
 * identity for non-nil input.
 */
export function marshalEventData(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  return v;
}
