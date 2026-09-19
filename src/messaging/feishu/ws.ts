// Ported from the larksuite/oapi-sdk-go v3 `ws` package long-connection
// client. The Go `gorilla/websocket` connection is replaced by the Deno
// `WebSocket` API, and reconnect/ping/c fragmentation are preserved.
//
// Deliberate deviations: the Go `*http.Response` handshake status check is not
// available through the Deno WebSocket API, so handshake failures surface as
// the WebSocket `error`/`close` events instead of parsed headers.

import {
  DeviceID,
  type Frame,
  FrameTypeControl,
  FrameTypeData,
  GenEndpointUri,
  HeaderBizRt,
  HeaderMessageID,
  headersAdd,
  HeaderSeq,
  headersGetInt,
  headersGetString,
  HeaderSum,
  HeaderType,
  InternalError,
  marshalFrame,
  MessageTypeCard,
  MessageTypeEvent,
  MessageTypePong,
  newPingFrame,
  OK,
  ServiceID,
  SystemBusy,
  unmarshalFrame,
} from "./frame.ts";

export interface WsClientConfig {
  reconnectCount: number;
  reconnectInterval: number;
  reconnectNonce: number;
  pingInterval: number;
}

const defaultConfig: WsClientConfig = {
  reconnectCount: -1,
  reconnectInterval: 120,
  reconnectNonce: 30,
  pingInterval: 120,
};

/** WsEventHandler decodes and handles one inbound event payload. */
export interface WsEventHandler {
  handleEvent(eventType: string, payload: Uint8Array): Promise<unknown>;
}

export interface WsClientOptions {
  appID: string;
  appSecret: string;
  domain?: string;
  eventHandler: WsEventHandler;
  fetchFn?: typeof fetch;
  onError?: (err: unknown) => void;
  onReady?: () => void;
  onReconnecting?: () => void;
  onReconnected?: () => void;
  onDisconnected?: () => void;
  logger?: (message: string) => void;
}

/** WsClientError is a non-retriable protocol/client error. */
export class WsClientError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "WsClientError";
    this.code = code;
  }
}

/** WsServerError is a retriable server error. */
export class WsServerError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "WsServerError";
    this.code = code;
  }
}

interface EndpointResp {
  code: number;
  msg: string;
  data?: { URL?: string; ClientConfig?: Partial<WsClientConfig> };
}

/**
 * WsClient owns the Feishu WebSocket long connection, including the pbbp2
 * frame loop, ping/pong, and multi-frame reassembly.
 */
export class WsClient {
  private readonly appID: string;
  private readonly appSecret: string;
  private readonly domain: string;
  private readonly eventHandler: WsEventHandler;
  private readonly fetchFn: typeof fetch;
  private readonly opts: WsClientOptions;
  private config: WsClientConfig = { ...defaultConfig };
  private conn: WebSocket | null = null;
  private serviceID = "";
  private connID = "";
  private autoReconnect = true;
  private closed = false;
  private readonly fragments = new Map<string, Uint8Array[]>();
  private readonly fragmentTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(opts: WsClientOptions) {
    this.opts = opts;
    this.appID = opts.appID;
    this.appSecret = opts.appSecret;
    this.domain = (opts.domain ?? "https://open.feishu.cn").replace(/\/+$/, "");
    this.eventHandler = opts.eventHandler;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private log(message: string): void {
    if (this.opts.logger !== undefined) {
      this.opts.logger(message);
    }
  }

  /** close disables auto-reconnect and closes the current connection. */
  close(): void {
    this.autoReconnect = false;
    this.closed = true;
    const conn = this.conn;
    if (conn !== null) {
      try {
        conn.close();
      } catch {
        // best-effort
      }
    }
    this.conn = null;
    this.connID = "";
    this.serviceID = "";
    for (const timer of this.fragmentTimers.values()) {
      clearTimeout(timer);
    }
    this.fragmentTimers.clear();
    this.fragments.clear();
    this.opts.onDisconnected?.();
  }

  /** start connects, reconnects, and runs until the signal is aborted. */
  async start(signal: AbortSignal): Promise<void> {
    while (!this.closed) {
      if (signal.aborted) {
        return;
      }
      try {
        await this.connect(signal);
        this.opts.onReady?.();
      } catch (err) {
        this.log(`feishu ws connect failed: ${err}`);
        this.opts.onError?.(err);
        if (err instanceof WsClientError) {
          return;
        }
        if (!this.autoReconnect) {
          throw err;
        }
        const reconnected = await this.reconnect(signal, err);
        if (!reconnected) {
          return;
        }
        continue;
      }
      try {
        await this.receiveLoop(signal);
      } catch (err) {
        this.log(`feishu ws receive failed: ${err}`);
      }
      this.disconnect();
      if (signal.aborted || !this.autoReconnect || this.closed) {
        return;
      }
      const reconnected = await this.reconnect(signal, undefined);
      if (!reconnected) {
        return;
      }
    }
  }

  private async reconnect(
    signal: AbortSignal,
    firstError: unknown,
  ): Promise<boolean> {
    if (!this.autoReconnect || this.closed) {
      return false;
    }
    this.opts.onReconnecting?.();
    if (this.config.reconnectNonce > 0) {
      const jitter = Math.floor(
        Math.random() * this.config.reconnectNonce * 1000,
      );
      try {
        await sleep(signal, jitter);
      } catch {
        return false;
      }
    }
    let attempt = 0;
    while (!this.closed) {
      if (signal.aborted) {
        return false;
      }
      attempt++;
      try {
        await this.connect(signal);
        this.opts.onReconnected?.();
        return true;
      } catch (err) {
        if (err instanceof WsClientError) {
          this.opts.onError?.(err);
          return false;
        }
        this.opts.onError?.(err);
        this.log(`feishu ws reconnect attempt ${attempt} failed: ${err}`);
      }
      if (
        this.config.reconnectCount >= 0 &&
        attempt >= this.config.reconnectCount
      ) {
        throw firstError instanceof Error
          ? firstError
          : new Error(`unable to connect after ${attempt} retries`);
      }
      try {
        await sleep(signal, this.config.reconnectInterval * 1000);
      } catch {
        return false;
      }
    }
    return false;
  }

  private disconnect(): void {
    const conn = this.conn;
    if (conn === null) {
      return;
    }
    this.conn = null;
    this.connID = "";
    this.serviceID = "";
    try {
      conn.close();
    } catch {
      // best-effort
    }
    this.opts.onDisconnected?.();
  }

  private async getConnURL(signal: AbortSignal): Promise<string> {
    const res = await this.fetchFn(`${this.domain}${GenEndpointUri}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        locale: "zh",
      },
      body: JSON.stringify({ AppID: this.appID, AppSecret: this.appSecret }),
      signal,
    });
    const body = (await res.json()) as EndpointResp;
    if (!res.ok) {
      throw new WsServerError(res.status, body.msg || "system busy");
    }
    switch (body.code) {
      case OK:
        break;
      case SystemBusy:
        throw new WsServerError(body.code, "system busy");
      case InternalError:
        throw new WsServerError(body.code, body.msg);
      default:
        throw new WsClientError(body.code, body.msg);
    }
    const url = body.data?.URL ?? "";
    if (url === "") {
      throw new WsServerError(500, "endpoint is null");
    }
    if (body.data?.ClientConfig !== undefined) {
      this.configure(body.data.ClientConfig);
    }
    return url;
  }

  private configure(conf: Partial<WsClientConfig>): void {
    if (conf.reconnectCount !== undefined) {
      this.config.reconnectCount = conf.reconnectCount;
    }
    if (conf.reconnectInterval !== undefined) {
      this.config.reconnectInterval = conf.reconnectInterval;
    }
    if (conf.reconnectNonce !== undefined) {
      this.config.reconnectNonce = conf.reconnectNonce;
    }
    if (conf.pingInterval !== undefined) {
      this.config.pingInterval = conf.pingInterval;
    }
  }

  private async connect(signal: AbortSignal): Promise<void> {
    if (this.conn !== null) {
      return;
    }
    const connURL = await this.getConnURL(signal);
    let parsed: URL;
    try {
      parsed = new URL(connURL);
    } catch {
      throw new WsClientError(-1, `invalid ws endpoint URL: ${connURL}`);
    }
    const connID = parsed.searchParams.get(DeviceID) ?? "";
    const serviceID = parsed.searchParams.get(ServiceID) ?? "";
    const ws = new WebSocket(connURL);
    ws.binaryType = "arraybuffer";
    await openWebSocket(ws, signal);
    this.conn = ws;
    this.connID = connID;
    this.serviceID = serviceID;
    this.log("feishu ws connected");
  }

  private async receiveLoop(signal: AbortSignal): Promise<void> {
    const ws = this.conn;
    if (ws === null) {
      return;
    }
    const ping = setInterval(() => {
      void this.sendPing();
    }, Math.max(1, this.config.pingInterval) * 1000);
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          cleanup();
          resolve();
        };
        const onClose = () => {
          cleanup();
          resolve();
        };
        const onError = (ev: Event) => {
          cleanup();
          reject(ev);
        };
        const onMessage = (ev: MessageEvent) => {
          void this.handleRaw(ev.data);
        };
        const cleanup = () => {
          signal.removeEventListener("abort", onAbort);
          ws.removeEventListener("close", onClose);
          ws.removeEventListener("error", onError);
          ws.removeEventListener("message", onMessage);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        ws.addEventListener("close", onClose);
        ws.addEventListener("error", onError);
        ws.addEventListener("message", onMessage);
        if (signal.aborted) {
          onAbort();
        }
      });
    } finally {
      clearInterval(ping);
    }
  }

  private sendPing(): void {
    const ws = this.conn;
    if (ws === null) {
      return;
    }
    const serviceID = Number.parseInt(this.serviceID, 10);
    const frame = newPingFrame(Number.isNaN(serviceID) ? 0 : serviceID);
    try {
      ws.send(marshalFrame(frame));
    } catch (err) {
      this.log(`feishu ws ping failed: ${err}`);
    }
  }

  private async handleRaw(data: unknown): Promise<void> {
    let bytes: Uint8Array | null = null;
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
      bytes = data;
    } else if (typeof data === "string") {
      // The protocol is binary only; ignore text frames.
      return;
    } else if (typeof Blob !== "undefined" && data instanceof Blob) {
      bytes = new Uint8Array(await data.arrayBuffer());
    }
    if (bytes === null) {
      return;
    }
    let frame: Frame;
    try {
      frame = unmarshalFrame(bytes);
    } catch (err) {
      this.log(`feishu ws unmarshal failed: ${err}`);
      return;
    }
    await this.handleFrame(frame);
  }

  private async handleFrame(frame: Frame): Promise<void> {
    switch (frame.method) {
      case FrameTypeControl:
        this.handleControlFrame(frame);
        return;
      case FrameTypeData:
        await this.handleDataFrame(frame);
        return;
      default:
        return;
    }
  }

  private handleControlFrame(frame: Frame): void {
    const type = headersGetString(frame.headers, HeaderType);
    if (type !== MessageTypePong) {
      return;
    }
    if (frame.payload.length === 0) {
      return;
    }
    try {
      const conf = JSON.parse(
        new TextDecoder().decode(frame.payload),
      ) as Partial<WsClientConfig>;
      this.configure(conf);
    } catch (err) {
      this.log(`feishu ws unmarshal client config failed: ${err}`);
    }
  }

  private async handleDataFrame(frame: Frame): Promise<void> {
    const sum = headersGetInt(frame.headers, HeaderSum);
    const seq = headersGetInt(frame.headers, HeaderSeq);
    const msgID = headersGetString(frame.headers, HeaderMessageID);
    const type = headersGetString(frame.headers, HeaderType);

    let payload = frame.payload;
    if (sum > 1) {
      const combined = this.combine(msgID, sum, seq, payload);
      if (combined === null) {
        return;
      }
      payload = combined;
    }

    let responseData: unknown;
    let err: unknown = null;
    const start = Date.now();
    if (type === MessageTypeEvent) {
      try {
        const eventType = eventTypeFromPayload(payload);
        responseData = await this.eventHandler.handleEvent(eventType, payload);
      } catch (e) {
        err = e;
      }
    } else if (type === MessageTypeCard) {
      return;
    } else {
      return;
    }
    const elapsed = Date.now() - start;
    headersAdd(frame.headers, HeaderBizRt, String(elapsed));

    const code = err === null ? 200 : 500;
    const response: Record<string, unknown> = { code };
    if (err === null && responseData !== null && responseData !== undefined) {
      const headers: Record<string, string> = {};
      response.headers = headers;
      response.data = responseData;
    }
    frame.payload = new TextEncoder().encode(JSON.stringify(response));
    const ws = this.conn;
    if (ws === null) {
      return;
    }
    try {
      ws.send(marshalFrame(frame));
    } catch (sendErr) {
      this.log(`feishu ws response failed: ${sendErr}`);
    }
  }

  private combine(
    msgID: string,
    sum: number,
    seq: number,
    payload: Uint8Array,
  ): Uint8Array | null {
    let buf = this.fragments.get(msgID);
    if (buf === undefined) {
      buf = new Array<Uint8Array>(sum);
      this.fragments.set(msgID, buf);
    }
    buf[seq] = payload;
    const timer = setTimeout(() => {
      this.fragments.delete(msgID);
      this.fragmentTimers.delete(msgID);
    }, 5000);
    const previous = this.fragmentTimers.get(msgID);
    if (previous !== undefined) {
      clearTimeout(previous);
    }
    this.fragmentTimers.set(msgID, timer);

    let capacity = 0;
    for (const part of buf) {
      if (part === undefined || part.length === 0) {
        return null;
      }
      capacity += part.length;
    }
    const out = new Uint8Array(capacity);
    let offset = 0;
    for (const part of buf) {
      out.set(part, offset);
      offset += part.length;
    }
    this.fragments.delete(msgID);
    const pending = this.fragmentTimers.get(msgID);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.fragmentTimers.delete(msgID);
    }
    return out;
  }
}

function eventTypeFromPayload(payload: Uint8Array): string {
  try {
    const env = JSON.parse(new TextDecoder().decode(payload)) as {
      header?: { event_type?: string };
    };
    return env.header?.event_type ?? "";
  } catch {
    return "";
  }
}

async function openWebSocket(
  ws: WebSocket,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (ev: Event) => {
      cleanup();
      reject(new WsServerError(0, `feishu ws open failed: ${ev.type}`));
    };
    const onClose = (ev: CloseEvent) => {
      cleanup();
      reject(
        new WsServerError(ev.code, `feishu ws closed during handshake`),
      );
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("aborted", "AbortError"));
    };
    const cleanup = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

function sleep(signal: AbortSignal, ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
