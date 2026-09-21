// Ported from internal/serve/logs.go
//
// The serve log hub fans management and process log events out to WebSocket
// subscribers with a bounded replay history. Go's channel-per-subscriber
// (buffered 32, non-blocking publish) maps to a small push queue with an
// async iterator; Go's `log.SetOutput` writer hook maps to a module-level
// writer seam because Deno has no interceptable standard logger.

import type { ServeStatus } from "./http.ts";

/** Go's time.Time fields map to RFC3339 ISO strings (JSON wire values). */
export interface ServeLogEvent {
  type: string;
  message?: string;
  timestamp?: string;
  status?: ServeStatus;
  data?: unknown;
}

export const LOG_HISTORY_LIMIT = 200;

const SUBSCRIBER_BUFFER_LIMIT = 32;

/**
 * One subscriber's event channel: a buffered queue whose publish drops the
 * newest event when full (Go's `select { case ch <- ev: default: }`).
 */
class SubscriberChannel {
  #pending: ServeLogEvent[] = [];
  #wake: (() => void) | null = null;
  #closed = false;

  push(ev: ServeLogEvent): boolean {
    if (this.#closed) return false;
    if (this.#pending.length >= SUBSCRIBER_BUFFER_LIMIT) return false;
    this.#pending.push(ev);
    this.#wake?.();
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#wake?.();
  }

  get closed(): boolean {
    return this.#closed;
  }

  async *events(): AsyncIterableIterator<ServeLogEvent> {
    while (true) {
      if (this.#pending.length > 0) {
        yield this.#pending.shift()!;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = null;
    }
  }
}

export class LogHub {
  #subscribers = new Map<SubscriberChannel, void>();
  #history: ServeLogEvent[] = [];
  #historySize = LOG_HISTORY_LIMIT;
  #closed = false;

  constructor(historySize = LOG_HISTORY_LIMIT) {
    this.#historySize = historySize;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  /**
   * Write implements the process log writer seam: every non-empty line the
   * process logs becomes a `log` event.
   */
  write(p: string): void {
    for (const rawLine of p.split("\n")) {
      const line = rawLine.trim();
      if (line === "") continue;
      this.publish({
        type: "log",
        message: line,
        timestamp: new Date().toISOString(),
      });
    }
  }

  subscribe(): {
    events: AsyncIterableIterator<ServeLogEvent>;
    history: ServeLogEvent[];
    unsubscribe: () => void;
  } {
    const ch = new SubscriberChannel();
    if (this.#closed) {
      ch.close();
      return { events: ch.events(), history: [], unsubscribe: () => {} };
    }
    this.#subscribers.set(ch, undefined);
    const history = [...this.#history];
    const unsubscribe = () => {
      if (this.#subscribers.has(ch)) {
        this.#subscribers.delete(ch);
        ch.close();
      }
    };
    return { events: ch.events(), history, unsubscribe };
  }

  publish(ev: ServeLogEvent): void {
    if (this.#closed) return;
    this.#remember(ev);
    for (const ch of this.#subscribers.keys()) {
      ch.push(ev);
    }
  }

  #remember(ev: ServeLogEvent): void {
    if (this.#historySize <= 0 || ev.type === "heartbeat") return;
    this.#history.push(ev);
    if (this.#history.length > this.#historySize) {
      this.#history = this.#history.slice(
        this.#history.length - this.#historySize,
      );
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const ch of this.#subscribers.keys()) {
      ch.close();
    }
    this.#subscribers.clear();
  }
}

type LogWriter = { write(p: string): void };

let processLogWriter: LogWriter | null = null;

function defaultProcessLogWriter(): LogWriter {
  return {
    write(p: string): void {
      // Go's standard logger writes to stderr; `log.Printf` maps to
      // console.error across the port.
      console.error(p.replace(/\n$/, ""));
    },
  };
}

/**
 * installLogHub installs hub as an additional process log writer, mirroring
 * Go's `log.SetOutput(io.MultiWriter(previous, hub))`. The returned function
 * restores the previous writer and closes the hub.
 */
export function installLogHub(hub?: LogHub | null): () => void {
  if (hub === undefined || hub === null) return () => {};
  const previous = processLogWriter ?? defaultProcessLogWriter();
  processLogWriter = {
    write(p: string): void {
      previous.write(p);
      hub.write(p);
    },
  };
  return () => {
    processLogWriter = previous;
    hub.close();
  };
}

/** Writes a line through the currently installed process log writer. */
export function serveLogWrite(p: string): void {
  const writer = processLogWriter ?? defaultProcessLogWriter();
  writer.write(p);
}

export interface LogsWebSocketHandlerOptions {
  logHub?: LogHub | null;
  statusSnapshot: () => ServeStatus;
}

const LOG_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Builds the `/ws/logs` WebSocket handler: a `connected` event carrying the
 * current status snapshot, then retained history replay, then live events
 * with a 30s heartbeat.
 */
export function createLogsWebSocketHandler(
  options: LogsWebSocketHandlerOptions,
): (request: Request) => Response {
  return (request: Request) => {
    const { socket, response } = Deno.upgradeWebSocket(request);
    const hub = options.logHub;
    if (hub === undefined || hub === null) {
      socket.onopen = () => {
        socket.send(JSON.stringify({
          type: "error",
          message: "log stream not configured",
          timestamp: new Date().toISOString(),
        }));
        socket.close();
      };
      return response;
    }

    const subscription = hub.subscribe();
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      subscription.unsubscribe();
    };

    const send = (ev: ServeLogEvent): boolean => {
      if (socket.readyState !== WebSocket.OPEN) return false;
      try {
        socket.send(JSON.stringify(ev));
        return true;
      } catch {
        return false;
      }
    };

    socket.onopen = () => {
      if (
        !send({
          type: "connected",
          timestamp: new Date().toISOString(),
          status: options.statusSnapshot(),
        })
      ) {
        cleanup();
        return;
      }
      for (const ev of subscription.history) {
        if (!send(ev)) {
          cleanup();
          return;
        }
      }
      const pump = (async () => {
        for await (const ev of subscription.events) {
          if (closed || !send(ev)) break;
        }
      })();
      pump.catch(() => {});
      heartbeat = setInterval(() => {
        if (!send({ type: "heartbeat", timestamp: new Date().toISOString() })) {
          cleanup();
          try {
            socket.close();
          } catch {
            // already closing
          }
        }
      }, LOG_HEARTBEAT_INTERVAL_MS);
    };
    socket.onclose = cleanup;
    socket.onerror = cleanup;
    return response;
  };
}
