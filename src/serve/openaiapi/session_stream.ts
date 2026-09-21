// Ported from internal/serve/openaiapi/session_stream.go — the legacy stream
// hub, the Server-bound publish/subscribe helpers, and the per-session SSE
// stream handler. The `Server`-bound methods of session_stream.go become
// exported functions taking the `Server` as their first argument, because a
// TypeScript class cannot be spread across the Go package's files; the Server
// type is imported type-only so no runtime import cycle exists.
//
// Also ports `messageTranscriptEvent` from handler_chat.go, which the replay
// path shares.
//
// Deviations: Go's buffered `chan sessionStreamEvent` maps to a bounded
// `SessionStreamEventStream` whose full queue drops events exactly like Go's
// non-blocking send; the HTTP handler maps to `(Request) => Response` and the
// SSE body is a `ReadableStream` (the header set Go applied to the
// ResponseWriter is applied to the streaming `Response`); Go's `select` over
// the request context, event channel, and two tickers maps to a
// `Promise.race` over the broker stream, `Request.signal`, and interval
// tickers with the same 500 ms poll / 15 s heartbeat periods.
import { debugLogf } from "../../provider/debug.ts";
import {
  listSessionCapabilityEventsAfter,
  listSessionMessagesAfter,
  listSessionRunEventsAfter,
} from "../../session/session_events.ts";
import {
  classifyError,
  displayErrorMessage,
  PhasePersistence,
  RetryReconcile,
  type RunPhase,
} from "../../agentruntime/error_info.ts";
import { inspectSessionExecution } from "../../agentruntime/execution.ts";
import type { SequencedMessage } from "../../session/replay.ts";
import type { Server } from "./server.ts";
import { formatRFC3339NanoUTC } from "./event_broker.ts";
import type { ToolStatusEvent, TranscriptStreamEvent } from "./types.ts";
import type { SessionMessageEntry } from "./session_mgr.ts";
import {
  providerMessageToSessionEntries,
  sessionCapabilityEventToEntry,
  sessionRunEventToEntry,
} from "./session_mgr.ts";
import { getSessionDir } from "../../config/settings.ts";
import { publishSessionRuntimeById } from "./session_runtime_snapshot.ts";

/** sessionStreamEvent is one legacy-hub frame: an event name plus its payload. */
export interface SessionStreamEvent {
  name: string;
  data: unknown;
}

const HUB_QUEUE_CAPACITY = 128;

/**
 * SessionStreamEventStream is the bounded queue behind one legacy-hub
 * subscription. `push` drops events when full (Go's `select` with a
 * `default` branch) and `close` releases waiters.
 */
export class SessionStreamEventStream {
  readonly #queue: SessionStreamEvent[] = [];
  readonly #waiters: Array<
    (result: IteratorResult<SessionStreamEvent>) => void
  > = [];
  #closed = false;

  /** Non-blocking send. Returns false when the queue is full (event dropped). */
  push(event: SessionStreamEvent): boolean {
    if (this.#closed) return false;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return true;
    }
    if (this.#queue.length >= HUB_QUEUE_CAPACITY) return false;
    this.#queue.push(event);
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  next(): Promise<IteratorResult<SessionStreamEvent>> {
    const queued = this.#queue.shift();
    if (queued !== undefined) {
      return Promise.resolve({ value: queued, done: false });
    }
    if (this.#closed) {
      return Promise.resolve({ value: undefined as never, done: true });
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<SessionStreamEvent> {
    return {
      next: () => this.next(),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}

/**
 * sessionStreamHub is the deprecated per-session fan-out hub. New code should
 * use the EventBroker; this hub remains for any remaining legacy subscribers.
 */
export class SessionStreamHub {
  readonly #subscribers = new Map<string, Set<SessionStreamEventStream>>();

  /**
   * Subscribes to one session's legacy stream. An empty session ID (or a nil
   * hub in Go) yields an already-closed stream and a no-op cancel, matching
   * Go's pre-closed channel return.
   */
  subscribe(
    sessionId: string,
  ): { events: SessionStreamEventStream; cancel: () => void } {
    if (sessionId === "") {
      const closed = new SessionStreamEventStream();
      closed.close();
      return { events: closed, cancel: () => {} };
    }
    let subs = this.#subscribers.get(sessionId);
    if (!subs) {
      subs = new Set();
      this.#subscribers.set(sessionId, subs);
    }
    const events = new SessionStreamEventStream();
    subs.add(events);

    const cancel = () => {
      const current = this.#subscribers.get(sessionId);
      if (current) {
        current.delete(events);
        if (current.size === 0) this.#subscribers.delete(sessionId);
      }
      events.close();
    };
    return { events, cancel };
  }

  /** Publishes best-effort to every subscriber; full queues drop the event. */
  publish(sessionId: string, event: SessionStreamEvent): void {
    if (sessionId === "" || event.name === "") return;
    const subs = this.#subscribers.get(sessionId);
    if (!subs) return;
    for (const events of subs) {
      events.push(event);
    }
  }
}

/** Creates the empty legacy hub (Go's newSessionStreamHub). */
export function newSessionStreamHub(): SessionStreamHub {
  return new SessionStreamHub();
}

export function publishSessionStreamEvent(
  server: Server,
  sessionId: string,
  eventName: string,
  data: unknown,
): void {
  const broker = server.getEventBroker();
  // Also publish to legacy hub for any remaining subscribers.
  const hub = server.getStreamHub();
  if (hub) {
    hub.publish(sessionId, { name: eventName, data });
  }
  // Extract runID from data if present.
  let runId = "";
  if (data && typeof data === "object" && "runId" in data) {
    const rid = (data as Record<string, unknown>).runId;
    if (typeof rid === "string") runId = rid;
  }
  broker.publishRawJSON(sessionId, runId, eventName, data);
}

export function activeRunIDForSession(
  server: Server,
  sessionId: string,
): string {
  if (sessionId === "") return "";
  // The shared Runtime snapshot is authoritative, including Runs created by
  // another process or a channel adapter. Do not let a stale RunManager entry
  // manufacture a second local ownership view.
  if (server.settings) {
    const snapshot = inspectSessionExecution(
      getSessionDir(server.settings),
      sessionId,
    );
    if (snapshot.activeRun) return snapshot.activeRun.id;
    return "";
  }
  // Fall back to in-memory cache only for embedded servers without a shared
  // session root.
  if (!server.pool) return "";
  const sess = server.pool.getExact(sessionId);
  if (!sess) return "";
  return sess.activeRunId;
}

export function publishToolEvent(
  server: Server,
  sessionId: string,
  event: ToolStatusEvent,
): void {
  const ev = event;
  if (sessionId === "") return;
  if (ev.sessionId === "") ev.sessionId = sessionId;
  if (ev.runId === "") ev.runId = activeRunIDForSession(server, sessionId);
  if (ev.timestamp === "") ev.timestamp = formatRFC3339NanoUTC(new Date());
  const broker = server.getEventBroker();
  if (broker) {
    broker.publishToolEvent(sessionId, ev.runId ?? "", event);
  }
  // Also publish to legacy hub.
  const hub = server.getStreamHub();
  if (hub) {
    hub.publish(sessionId, { name: "tool_event", data: event });
  }
}

export function publishTranscriptEvent(
  server: Server,
  sessionId: string,
  evt: TranscriptStreamEvent,
): void {
  if (sessionId === "") return;
  if (evt.x_session_id === "") evt.x_session_id = sessionId;
  if (evt.runId === "") evt.runId = activeRunIDForSession(server, sessionId);
  if (evt.timestamp === "") evt.timestamp = formatRFC3339NanoUTC(new Date());
  const broker = server.getEventBroker();
  if (broker) {
    broker.publishTranscriptEvent(sessionId, evt.runId ?? "", evt);
  }
  // Also publish to legacy hub.
  const hub = server.getStreamHub();
  if (hub) {
    hub.publish(sessionId, { name: "transcript", data: evt });
  }
}

/**
 * The SSE sink abstraction. Go wrote into an http.ResponseWriter with a
 * Flusher; the Deno handler passes the stream controller (or any string sink
 * for tests).
 */
export interface SessionSSESink {
  enqueue(frame: string): void;
}

export function writeTranscriptEvent(
  server: Server,
  sse: { writeTranscriptEvent(evt: TranscriptStreamEvent): void } | null,
  sessionId: string,
  evt: TranscriptStreamEvent,
): void {
  if (evt.x_session_id === "") evt.x_session_id = sessionId;
  if (evt.runId === "") evt.runId = activeRunIDForSession(server, sessionId);
  if (evt.timestamp === "") evt.timestamp = formatRFC3339NanoUTC(new Date());
  if (sse) sse.writeTranscriptEvent(evt);
  publishTranscriptEvent(server, sessionId, evt);
}

export function publishSessionStreamDone(
  server: Server,
  sessionId: string,
  runId: string,
  status: string,
): void {
  const data = {
    sessionId,
    runId,
    status,
    timestamp: formatRFC3339NanoUTC(new Date()),
  };
  const broker = server.getEventBroker();
  if (broker) {
    broker.publishDone(sessionId, runId, data);
  }
  // Also publish to legacy hub.
  const hub = server.getStreamHub();
  if (hub) {
    hub.publish(sessionId, { name: "done", data });
  }
}

/** sessionStreamCursor tracks replay positions across the three event ledgers. */
export interface SessionStreamCursor {
  entrySeq: number;
  runSeq: number;
  capabilitySeq: number;
}

/**
 * PublishExternalSessionUpdate forwards newly persisted transcript and run
 * events produced outside the OpenAI API (for example WeChat/Feishu runs).
 * The per-session cursors make repeated lifecycle notifications cheap while
 * retaining the durable replay path for clients that connect later.
 *
 * Deviation: Go's `s.PublishSessionRuntime(sessionID)` call is projected
 * through `publishSessionRuntimeById` from the runtime-snapshot module.
 */
export async function publishExternalSessionUpdate(
  server: Server,
  sessionId: string,
): Promise<void> {
  if (!server.settings || sessionId === "") return;
  publishSessionRuntimeById(server, sessionId);
  await server.externalSyncMu.lock();
  try {
    let cursor = server.externalCursors.get(sessionId);
    if (!cursor) {
      cursor = { entrySeq: 0, runSeq: 0, capabilitySeq: 0 };
    }
    const sessionDir = getSessionDir(server.settings);
    const broker = server.getEventBroker();
    if (!broker) return;
    for (;;) {
      const items = listSessionMessagesAfter(
        sessionDir,
        sessionId,
        cursor.entrySeq,
        500,
      );
      for (const item of items) {
        for (
          const entry of providerMessageToSessionEntries(
            item.message,
            item.seq,
            item.entryID,
          )
        ) {
          const evt = messageTranscriptEvent(entry);
          evt.x_session_id = sessionId;
          broker.publishTranscriptEvent(
            sessionId,
            activeRunIDForSession(server, sessionId),
            evt,
          );
          const hub = server.getStreamHub();
          if (hub) {
            hub.publish(sessionId, { name: "transcript", data: evt });
          }
        }
        if (item.seq > cursor.entrySeq) cursor.entrySeq = item.seq;
      }
      if (items.length < 500) break;
    }
    for (;;) {
      let items;
      try {
        items = listSessionRunEventsAfter(
          sessionDir,
          sessionId,
          cursor.runSeq,
          500,
        );
      } catch (err) {
        debugLogf(
          "sync external session %q run events after %d: %v",
          sessionId,
          cursor.runSeq,
          err,
        );
        return;
      }
      for (const item of items) {
        const entry = sessionRunEventToEntry(item.event, item.seq);
        broker.publishRunEvent(sessionId, item.event.runId, entry);
        const hub = server.getStreamHub();
        if (hub) {
          hub.publish(sessionId, { name: "run_event", data: entry });
        }
        if (item.seq > cursor.runSeq) cursor.runSeq = item.seq;
      }
      if (items.length < 500) break;
    }
    server.externalCursors.set(sessionId, cursor);
  } finally {
    server.externalSyncMu.unlock();
  }
}

/** messageTranscriptEvent wraps one transcript entry as a stream event (from handler_chat.go). */
export function messageTranscriptEvent(
  entry: SessionMessageEntry,
): TranscriptStreamEvent {
  return {
    type: "message",
    message: entry,
  };
}

/**
 * StreamSession streams persisted and live transcript/event updates for one
 * WebUI session as an SSE body.
 */
export function streamSession(
  server: Server,
  req: Request,
  id: string,
): Response | Promise<Response> {
  if (req.method !== "GET") {
    return new Response(null, { status: 405 });
  }
  if (!server.settings || id === "") {
    return new Response(
      JSON.stringify({
        error: { message: "session not found", type: "not_found" },
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }
  const workDir = server.findSessionWorkDir(id);
  if (!workDir.found) {
    return new Response(
      JSON.stringify({
        error: { message: "session not found", type: "not_found" },
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }

  const cursor: SessionStreamCursor = {
    entrySeq: streamIntQuery(
      new URL(req.url),
      "after_entry_seq",
      "afterEntrySeq",
      "entrySeq",
    ),
    runSeq: streamIntQuery(
      new URL(req.url),
      "after_run_seq",
      "afterRunSeq",
      "runSeq",
    ),
    capabilitySeq: streamIntQuery(
      new URL(req.url),
      "after_capability_seq",
      "afterCapabilitySeq",
      "capabilitySeq",
    ),
  };
  const broker = server.getEventBroker();
  const { events, cancel } = broker.subscribe(id);

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sink: SessionSSESink = {
        enqueue: (frame) => {
          controller.enqueue(new TextEncoder().encode(frame));
        },
      };
      const close = () => {
        try {
          controller.close();
        } catch {
          // already closed by the platform after a client disconnect
        }
      };
      try {
        const replayed = await replaySessionStream(
          server,
          sink,
          id,
          cursor,
          true,
        );
        if (replayed.err) {
          close();
          return;
        }
        if (!isSessionRunActive(server, id)) {
          writeSessionSSE(sink, "done", { sessionId: id });
          close();
          return;
        }

        const poll = ticker(500);
        const heartbeat = ticker(15_000);
        const abort = req.signal
          ? new Promise<"abort">((resolve) => {
            req.signal.addEventListener(
              "abort",
              () => resolve("abort"),
              { once: true },
            );
          })
          : new Promise<"abort">(() => {}); // never resolves
        try {
          for (;;) {
            const outcome = await Promise.race([
              events.next().then((ev) => ({ kind: "event" as const, ev })),
              poll.wait().then(() => ({ kind: "poll" as const })),
              heartbeat.wait().then(() => ({ kind: "heartbeat" as const })),
              abort,
            ]);
            if (outcome === "abort") return;
            if (outcome.kind === "event") {
              if (outcome.ev === undefined) return;
              const evt = outcome.ev;
              if (evt.event === "done") {
                const beforeDone = await replaySessionStream(
                  server,
                  sink,
                  id,
                  cursor,
                  false,
                );
                if (beforeDone.err) {
                  debugLogf(
                    "replay session %q before done event: %v",
                    id,
                    beforeDone.err,
                  );
                  return;
                }
                try {
                  writeSessionSSE(sink, "done", evt.data);
                } catch (err) {
                  debugLogf("write session %q done event: %v", id, err);
                }
                return;
              }
              try {
                writeSessionSSE(sink, evt.event, evt.data);
              } catch (err) {
                debugLogf(
                  "write session %q stream event %q: %v",
                  id,
                  evt.event,
                  err,
                );
                return;
              }
            } else if (outcome.kind === "poll") {
              const polled = await replaySessionStream(
                server,
                sink,
                id,
                cursor,
                false,
              );
              if (polled.err) {
                debugLogf("poll replay for session %q: %v", id, polled.err);
                return;
              }
              if (!isSessionRunActive(server, id)) {
                const final = await replaySessionStream(
                  server,
                  sink,
                  id,
                  cursor,
                  false,
                );
                if (final.err) {
                  debugLogf(
                    "final replay for session %q: %v",
                    id,
                    final.err,
                  );
                  return;
                }
                try {
                  writeSessionSSE(sink, "done", { sessionId: id });
                } catch (err) {
                  debugLogf("write final session %q done event: %v", id, err);
                }
                return;
              }
            } else {
              try {
                writeSessionSSE(sink, "heartbeat", { sessionId: id });
              } catch (err) {
                debugLogf("write session %q heartbeat: %v", id, err);
                return;
              }
            }
          }
        } finally {
          poll.stop();
          heartbeat.stop();
        }
      } finally {
        cancel();
        close();
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

/** ticker is the Promise-friendly equivalent of Go's time.NewTicker. */
function ticker(
  ms: number,
): { wait: () => Promise<void>; stop: () => void } {
  let notify: (() => void) | null = null;
  const id = setInterval(() => {
    const waiter = notify;
    notify = null;
    waiter?.();
  }, ms);
  return {
    wait: () =>
      new Promise<void>((resolve) => {
        notify = resolve;
      }),
    stop: () => clearInterval(id),
  };
}

export function replaySessionStream(
  server: Server,
  sink: SessionSSESink,
  sessionId: string,
  cursor: SessionStreamCursor,
  includeMessages: boolean,
): { changed: boolean; err: Error | null } {
  if (!server.settings || sessionId === "") {
    return { changed: false, err: null };
  }
  const sessionDir = getSessionDir(server.settings);
  let changed = false;

  if (includeMessages) {
    let messages: SequencedMessage[];
    try {
      messages = listSessionMessagesAfter(
        sessionDir,
        sessionId,
        cursor.entrySeq,
        200,
      );
    } catch (err) {
      writeSessionSSEFailure(sink, err, PhasePersistence);
      return {
        changed,
        err: err instanceof Error ? err : new Error(String(err)),
      };
    }
    for (const item of messages) {
      for (
        const entry of providerMessageToSessionEntries(
          item.message,
          item.seq,
          item.entryID,
        )
      ) {
        const evt = messageTranscriptEvent(entry);
        evt.x_session_id = sessionId;
        try {
          writeSessionSSE(sink, "transcript", evt);
        } catch (err) {
          return {
            changed,
            err: err instanceof Error ? err : new Error(String(err)),
          };
        }
        changed = true;
      }
      if (item.seq > cursor.entrySeq) cursor.entrySeq = item.seq;
    }
  }

  let runEvents;
  try {
    runEvents = listSessionRunEventsAfter(
      sessionDir,
      sessionId,
      cursor.runSeq,
      200,
    );
  } catch (err) {
    writeSessionSSEFailure(sink, err, PhasePersistence);
    return {
      changed,
      err: err instanceof Error ? err : new Error(String(err)),
    };
  }
  for (const item of runEvents) {
    try {
      writeSessionSSE(
        sink,
        "run_event",
        sessionRunEventToEntry(item.event, item.seq),
      );
    } catch (err) {
      return {
        changed,
        err: err instanceof Error ? err : new Error(String(err)),
      };
    }
    if (item.seq > cursor.runSeq) cursor.runSeq = item.seq;
    changed = true;
  }

  let capabilityEvents;
  try {
    capabilityEvents = listSessionCapabilityEventsAfter(
      sessionDir,
      sessionId,
      cursor.capabilitySeq,
      200,
    );
  } catch (err) {
    writeSessionSSEFailure(sink, err, PhasePersistence);
    return {
      changed,
      err: err instanceof Error ? err : new Error(String(err)),
    };
  }
  for (const item of capabilityEvents) {
    try {
      writeSessionSSE(
        sink,
        "capability_event",
        sessionCapabilityEventToEntry(item.event, item.seq),
      );
    } catch (err) {
      return {
        changed,
        err: err instanceof Error ? err : new Error(String(err)),
      };
    }
    if (item.seq > cursor.capabilitySeq) cursor.capabilitySeq = item.seq;
    changed = true;
  }

  return { changed, err: null };
}

export function isSessionRunActive(server: Server, id: string): boolean {
  if (id === "") return false;
  if (server.settings) {
    // A stream must not emit a false terminal event while the durable
    // execution state is temporarily unavailable; the shared inspection
    // treats an unavailable database as busy rather than idle.
    const snapshot = inspectSessionExecution(
      getSessionDir(server.settings),
      id,
    );
    return snapshot.activeRun !== undefined && snapshot.activeRun !== null;
  }
  if (!server.pool) return false;
  const sess = server.pool.getExact(id);
  if (!sess) return false;
  const execution = sess.executionRuntime();
  if (execution) {
    return execution.active().active;
  }
  return false;
}

export function streamIntQuery(url: URL, ...keys: string[]): number {
  for (const key of keys) {
    const raw = url.searchParams.get(key);
    if (raw === null || raw === "") continue;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 0) return 0;
    return n;
  }
  return 0;
}

export function writeSessionSSE(
  sink: SessionSSESink,
  event: string,
  data: unknown,
): void {
  const payload = JSON.stringify(data);
  sink.enqueue(`event: ${event}\ndata: ${payload}\n\n`);
}

export function writeSessionSSEFailure(
  sink: SessionSSESink,
  err: unknown,
  phase: RunPhase,
): void {
  const info = classifyError(err, {
    phase,
    type: "server_error",
    messageKey: "run.error.persistence",
  });
  info.retryMode = RetryReconcile;
  info.retryable = true;
  writeSessionSSE(sink, "error", {
    errorInfo: info,
    error: displayErrorMessage(info),
  });
}
