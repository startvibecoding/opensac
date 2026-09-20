// Ported from vibe-browser pkg/cdp/client.go (v0.1.5).
//
// Implements the Chrome DevTools Protocol client: it manages a WebSocket
// connection to a Chrome/Chromium browser instance, dispatches CDP commands,
// and receives events.
//
// Deviations from Go: `gorilla/websocket` maps to the global `WebSocket`
// (Deno); goroutine/channel plumbing (`readLoop`, `keepalive`, `pending`
// channels, `Events() <-chan`) maps to an event-loop-backed promise queue with
// a bounded buffer and `nextEvent`; `sync.Mutex`/`atomic.Int64` are dropped
// because Deno is single-threaded.

/** A CDP JSON message (command or response/event). */
export interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: CdpError;
  sessionId?: string;
}

/** A CDP protocol error. */
export class CdpError extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(`CDP error ${code}: ${message}`);
    this.name = "CdpError";
    this.code = code;
  }
}

/** A parsed CDP event with its method name and params. */
export interface CdpEvent {
  method: string;
  params: unknown;
  sessionId: string;
}

/** Opens a WebSocket connection to the given CDP URL. */
export class CdpClient {
  #ws: WebSocket;
  #nextId = 0;
  #pending = new Map<number, (msg: CdpMessage | null) => void>();
  #events: CdpEvent[] = [];
  #eventWaiters: Array<(evt: CdpEvent | null) => void> = [];
  #done = false;
  #closed = false;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    this.#startReadLoop();
  }

  /** Establishes a WebSocket connection to the given CDP URL. */
  static async connect(
    wsUrl: string,
    signal?: AbortSignal,
  ): Promise<CdpClient> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`cdp: connect ${wsUrl}: websocket error`));
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          ws.close();
        } catch {
          // ignore
        }
        reject(new DOMException("Aborted", "AbortError"));
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    return new CdpClient(ws);
  }

  #startReadLoop(): void {
    this.#ws.addEventListener("message", (ev: MessageEvent) => {
      let msg: CdpMessage;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (msg.id !== undefined && msg.id !== 0) {
        const ch = this.#pending.get(msg.id);
        if (ch) {
          this.#pending.delete(msg.id);
          ch(msg);
        }
        return;
      }
      if (msg.method) {
        this.#pushEvent({
          method: msg.method,
          params: msg.params,
          sessionId: msg.sessionId ?? "",
        });
      }
    });
    this.#ws.addEventListener("close", () => {
      this.#done = true;
      for (const [id, ch] of this.#pending) {
        this.#pending.delete(id);
        ch(null);
      }
      const waiters = this.#eventWaiters;
      this.#eventWaiters = [];
      for (const waiter of waiters) waiter(null);
    });
    this.#ws.addEventListener("error", () => {
      // A close/error event follows; the close handler drains waiters.
    });
  }

  #pushEvent(evt: CdpEvent): void {
    const waiter = this.#eventWaiters.shift();
    if (waiter) {
      waiter(evt);
      return;
    }
    this.#events.push(evt);
  }

  /** Waits for the next CDP event, or null when the connection closes. */
  nextEvent(signal?: AbortSignal): Promise<CdpEvent | null> {
    if (this.#events.length > 0) {
      return Promise.resolve(this.#events.shift() as CdpEvent);
    }
    if (this.#done) return Promise.resolve(null);
    return new Promise<CdpEvent | null>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const waiter = (evt: CdpEvent | null) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(evt);
      };
      this.#eventWaiters.push(waiter);
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  /** Sends a CDP command and waits for the response. */
  async send(
    method: string,
    params?: unknown,
    signal?: AbortSignal,
  ): Promise<CdpMessage> {
    return await this.#send(method, params, undefined, signal);
  }

  /** Sends a CDP command targeting a specific session. */
  async sendToSession(
    method: string,
    params: unknown,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<CdpMessage> {
    return await this.#send(method, params, sessionId, signal);
  }

  async #send(
    method: string,
    params: unknown,
    sessionId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<CdpMessage> {
    const id = ++this.#nextId;
    const payload: CdpMessage = { id, method };
    if (params !== undefined) payload.params = params;
    if (sessionId !== undefined) payload.sessionId = sessionId;

    return await new Promise<CdpMessage>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        this.#pending.delete(id);
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        reject(new DOMException("Aborted", "AbortError"));
      };
      this.#pending.set(id, (m) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (m === null) {
          reject(new Error(`cdp: connection closed waiting for ${method}`));
          return;
        }
        if (m.error) {
          reject(new CdpError(m.error.code, m.error.message));
          return;
        }
        resolve(m);
      });
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        this.#ws.send(JSON.stringify(payload));
      } catch (err) {
        this.#pending.delete(id);
        if (!settled) {
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          reject(new Error(`cdp: write: ${err}`));
        }
      }
    });
  }

  /** Closes the WebSocket connection. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#ws.close(1000, "");
    } catch {
      // ignore
    }
  }

  /** Reports whether the WebSocket connection is still alive. */
  isConnected(): boolean {
    return !this.#done;
  }
}
