// Node-backed implementations of the process/net APIs the sources use.
//
// This module adds the richer process/network APIs on top of
// `./runtime_core.ts`: process spawning (`Command`), the HTTP server
// (`serve`/`upgradeWebSocket`), raw sockets (`listen`/`connect`), the
// fetch HTTP client, DNS, and the Web `Worker`/`fetch` globals. `./runtime.ts`
// merges the two into the single `runtime` module the rest of the tree imports.
//
// Known deviations from a runtime with a synchronous HTTP listen:
//   * An HTTP bind failure (e.g. port in use) surfaces asynchronously through
//     `finished`/`onError`, because `node:http` has no synchronous listen.
//   * HTTP proxy support needs the optional `undici` dependency.
//   * Module-URL web workers are unsupported (throw), which degrades the stats
//     offload to its in-process fallback. `data:`-URL workers work.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Buffer } from "node:buffer";
import { spawn as spawnChild, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  resolve4,
  resolve6,
  resolveCname,
  resolveMx,
  resolveTxt,
} from "node:dns/promises";
import { constants as fsConstants, openSync as openFileSync } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import {
  connect as netConnect,
  createServer as netCreateServer,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

const require = createRequire(import.meta.url);

/** Symbol carrying the raw Node upgrade context on a synthesized `Request`. */
const upgradeContext = Symbol("opensacNodeUpgrade");
/** Symbol marking a client produced by the `createHttpClient` shim. */
const httpClientMarker = Symbol("opensacHttpClient");

// ─── Command ──────────────────────────────────────────────────────────────

function currentArgs(): string[] {
  return process.argv.slice(2);
}

function normalizeMode(mode: unknown): string | undefined {
  if (mode === undefined) return undefined;
  if (typeof mode === "string") return mode;
  const kind = (mode as { kind?: string }).kind;
  return typeof kind === "string" ? kind : undefined;
}

function nodeStdio(
  mode: string | undefined,
  which: "stdin" | "stdout" | "stderr",
) {
  if (mode === "piped") return "pipe";
  if (mode === "inherit") return "inherit";
  if (mode === "null") return "ignore";
  return which === "stdin" ? "ignore" : "pipe";
}

function toWebReadable(stream: any): ReadableStream<Uint8Array> | null {
  return stream ? (Readable.toWeb(stream) as ReadableStream<Uint8Array>) : null;
}

function toWebWritable(stream: any): WritableStream<Uint8Array> | null {
  return stream ? Writable.toWeb(stream) : null;
}

class NodeChildProcess {
  readonly pid: number;
  readonly stdin: any;
  readonly stdout: any;
  readonly stderr: any;
  readonly status: Promise<any>;
  #proc: any;

  constructor(spec: any) {
    const env = spec.clearEnv
      ? { ...spec.env }
      : { ...process.env, ...spec.env };
    this.#proc = spawnChild(spec.command, spec.args, {
      cwd: spec.cwd,
      env,
      stdio: [
        nodeStdio(spec.stdin, "stdin"),
        nodeStdio(spec.stdout, "stdout"),
        nodeStdio(spec.stderr, "stderr"),
      ],
      uid: spec.uid,
      gid: spec.gid,
      ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
    });
    this.pid = this.#proc.pid ?? -1;
    this.stdin = toWebWritable(this.#proc.stdin);
    this.stdout = toWebReadable(this.#proc.stdout);
    this.stderr = toWebReadable(this.#proc.stderr);
    this.status = new Promise((resolve) => {
      this.#proc.once("exit", (code: number | null, signal: string | null) => {
        resolve({ success: code === 0, code: code ?? -1, signal });
      });
      this.#proc.once("error", () => {
        resolve({ success: false, code: -1, signal: null });
      });
    });
  }

  kill(signal?: string): void {
    this.#proc.kill((signal ?? "SIGTERM") as any);
  }

  async output(): Promise<any> {
    if (this.#proc.stdin !== null && !this.#proc.stdin.destroyed) {
      this.#proc.stdin.end();
    }
    const [stdout, stderr, status] = await Promise.all([
      readAll(this.stdout),
      readAll(this.stderr),
      this.status,
    ]);
    return { ...status, stdout, stderr };
  }

  ref(): void {
    this.#proc.ref();
  }

  unref(): void {
    this.#proc.unref();
    // The stdio pipes are separate handles: without unref'ing them a parent
    // that spawned a long-lived child (the shared Core) would keep its event
    // loop alive after it has nothing left to do.
    this.#proc.stdout?.unref?.();
    this.#proc.stderr?.unref?.();
    this.#proc.stdin?.unref?.();
  }
}

async function readAll(stream: any): Promise<Uint8Array> {
  if (stream === null) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

class NodeCommand {
  #spec: any;

  constructor(command: string, options: any = {}) {
    this.#spec = {
      command,
      args: options.args ?? [],
      cwd: options.cwd,
      env: options.env,
      clearEnv: options.clearEnv ?? false,
      stdin: normalizeMode(options.stdin),
      stdout: normalizeMode(options.stdout),
      stderr: normalizeMode(options.stderr),
      uid: options.uid,
      gid: options.gid,
      signal: options.signal,
    };
  }

  spawn(): NodeChildProcess {
    return new NodeChildProcess(this.#spec);
  }

  async output(): Promise<any> {
    const child = this.spawn();
    if (this.#spec.stdin === "piped" && child.stdin !== null) {
      const writer = child.stdin.getWriter();
      await writer.close().catch(() => {});
    }
    const [stdout, stderr, status] = await Promise.all([
      readAll(child.stdout),
      readAll(child.stderr),
      child.status,
    ]);
    return { ...status, stdout, stderr };
  }

  outputSync(): any {
    const res = spawnSync(this.#spec.command, this.#spec.args, {
      cwd: this.#spec.cwd,
      env: this.#spec.clearEnv
        ? { ...this.#spec.env }
        : { ...process.env, ...this.#spec.env },
      stdio: [
        this.#spec.stdin === "piped" ? "pipe" : "ignore",
        this.#spec.stdout === "inherit" ? "inherit" : "pipe",
        this.#spec.stderr === "inherit" ? "inherit" : "pipe",
      ],
      uid: this.#spec.uid,
      gid: this.#spec.gid,
    });
    return {
      success: res.status === 0,
      code: res.status ?? -1,
      signal: res.signal ?? null,
      stdout: res.stdout ?? new Uint8Array(0),
      stderr: res.stderr ?? new Uint8Array(0),
    };
  }
}

// ─── HTTP server ───────────────────────────────────────────────────────────

function requestFromNode(req: any): Request {
  const host = req.headers.host ?? "localhost";
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
  }
  const method = (req.method ?? "GET").toUpperCase();
  const init: any = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req);
    init.duplex = "half";
  }
  return new Request(`http://${host}${req.url ?? "/"}`, init);
}

async function respondToNode(res: any, response: Response): Promise<void> {
  res.statusCode = response.status;
  // Do not keep the connection alive. A client that holds a pooled socket to a
  // Core that has just stopped would otherwise see "other side closed" instead
  // of a clean connection refusal, which the Core client uses to detect that
  // the endpoint moved.
  res.shouldKeepAlive = false;
  for (const [k, v] of response.headers) res.setHeader(k, v);
  if (response.body !== null) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) res.write(Buffer.from(value));
    }
  }
  res.end();
}

/** Writes a plain HTTP response onto an already-upgraded socket (auth errors). */
async function respondToUpgradedSocket(
  socket: any,
  response: Response,
): Promise<void> {
  const body = response.body
    ? Buffer.from(await response.arrayBuffer())
    : Buffer.alloc(0);
  let head = `HTTP/1.1 ${response.status} ${statusText(response.status)}\r\n`;
  for (const [k, v] of response.headers) head += `${k}: ${v}\r\n`;
  head += `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
  socket.write(head);
  if (body.length > 0) socket.write(body);
  socket.end();
}

function statusText(status: number): string {
  switch (status) {
    case 200:
      return "OK";
    case 401:
      return "Unauthorized";
    case 404:
      return "Not Found";
    case 405:
      return "Method Not Allowed";
    case 500:
      return "Internal Server Error";
    default:
      return "";
  }
}

function serve(target: any, maybeHandler?: any): any {
  const options = typeof target === "function" ? {} : (target ?? {});
  const handler = typeof target === "function" ? target : maybeHandler;
  const server = createServer();
  const { WebSocketServer } = require("ws");
  const wss = new WebSocketServer({ noServer: true });

  let addr = {
    transport: "tcp",
    hostname: options.hostname ?? "0.0.0.0",
    port: 0,
  };
  let shuttingDown = false;
  let resolveFinished: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  server.on("request", (req, res) => {
    Promise.resolve(handler(requestFromNode(req))).then(
      (response) => respondToNode(res, response),
      (error) => {
        res.statusCode = 500;
        res.end(String(error?.message ?? error));
      },
    );
  });

  server.on("upgrade", (req, socket, head) => {
    const request = requestFromNode(req);
    const ctx = { req, socket, head, wss, upgraded: false };
    (request as any)[upgradeContext] = ctx;
    Promise.resolve(handler(request)).then(
      (response) => {
        // `upgradeWebSocket` performs the handshake itself and marks the
        // context; anything else is a plain response on the raw socket.
        if (ctx.upgraded) return;
        if (response !== undefined) {
          void respondToUpgradedSocket(socket, response).catch(() =>
            socket.destroy(),
          );
        } else {
          socket.destroy();
        }
      },
      () => socket.destroy(),
    );
  });

  server.on("error", (error: any) => {
    if (typeof options.onError === "function") options.onError(error);
    resolveFinished();
  });
  server.on("close", () => resolveFinished());

  server.listen(
    {
      host: options.hostname ?? undefined,
      port: options.port ?? 0,
    },
    () => {
      const address = server.address();
      if (address !== null && typeof address === "object") {
        addr = {
          transport: "tcp",
          hostname: address.address,
          port: address.port,
        };
        if (typeof options.onListen === "function") options.onListen(addr);
      }
    },
  );

  if (options.signal !== undefined) {
    options.signal.addEventListener(
      "abort",
      () => void shutdown().catch(() => {}),
      { once: true },
    );
  }

  async function shutdown(): Promise<void> {
    if (shuttingDown) {
      await finished;
      return;
    }
    shuttingDown = true;
    // Upgraded WebSocket sockets are detached from the HTTP server, so
    // `server.close()` alone would wait for them forever. Terminate them, then
    // force any remaining keep-alive connections closed.
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {
        // already gone
      }
    }
    wss.close();
    server.close(() => resolveFinished());
    server.closeAllConnections?.();
  }

  return {
    get addr() {
      return addr;
    },
    finished,
    shutdown,
    ref() {
      server.ref();
    },
    unref() {
      server.unref();
    },
    [Symbol.asyncDispose]() {
      return shutdown();
    },
  };
}

function upgradeWebSocket(request: Request): {
  socket: any;
  response: Response;
} {
  const ctx = (request as any)[upgradeContext];
  if (ctx === undefined) {
    throw new Error("upgradeWebSocket expects an upgrade request");
  }
  let socket: any;
  ctx.wss.handleUpgrade(ctx.req, ctx.socket, ctx.head, (ws: any) => {
    socket = ws;
  });
  if (socket === undefined) throw new Error("websocket upgrade failed");
  // Node's `Response` rejects a 101 status (only 200–599 are allowed), so the
  // handshake is signalled to `serve` through the context instead. The returned
  // response is a placeholder the caller may return as-is.
  ctx.upgraded = true;
  return { socket, response: new Response(null, { status: 200 }) };
}

// ─── connect / createHttpClient ─────────────────────────────────────────────

function wrapNetSocket(socket: any): any {
  let buffer: Buffer = Buffer.alloc(0);
  let waiter: ((n: number | null) => void) | null = null;
  let ended = false;
  socket.on("data", (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(buffer.length);
    }
  });
  socket.on("end", () => {
    ended = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(null);
    }
  });
  socket.on("error", () => {
    ended = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(null);
    }
  });
  return {
    rid: -1,
    readable: Readable.toWeb(socket),
    writable: Writable.toWeb(socket),
    async read(p: Uint8Array): Promise<number | null> {
      if (buffer.length === 0) {
        if (ended) return null;
        await new Promise<void>((resolve) => {
          waiter = () => resolve();
        });
      }
      const n = Math.min(p.length, buffer.length);
      buffer.copy(p, 0, 0, n);
      buffer = buffer.subarray(n);
      return n === 0 ? null : n;
    },
    async write(p: Uint8Array): Promise<number> {
      await new Promise<void>((resolve) =>
        socket.write(Buffer.from(p), resolve),
      );
      return p.length;
    },
    async closeWrite(): Promise<void> {
      socket.end();
    },
    close(): void {
      socket.destroy();
    },
  };
}

function listen(options: any): any {
  const server = netCreateServer();
  let addr = {
    transport: "tcp",
    hostname: options?.hostname ?? "0.0.0.0",
    port: options?.port ?? 0,
  };
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const pending: any[] = [];
  const waiters: Array<(conn: any) => void> = [];
  let closed = false;
  server.on("connection", (socket: any) => {
    const conn = wrapNetSocket(socket);
    const waiter = waiters.shift();
    if (waiter) waiter(conn);
    else pending.push(conn);
  });
  server.on("error", () => resolveReady());
  server.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()!(undefined);
  });
  server.listen(
    { host: options?.hostname ?? undefined, port: options?.port ?? 0 },
    () => {
      const a = server.address();
      if (a !== null && typeof a === "object") {
        addr = { transport: "tcp", hostname: a.address, port: a.port };
      }
      resolveReady();
    },
  );
  if (options?.signal !== undefined) {
    options.signal.addEventListener("abort", () => server.close(), {
      once: true,
    });
  }
  return {
    get addr() {
      return addr;
    },
    rid: -1,
    ready,
    accept(): Promise<any> {
      const conn = pending.shift();
      if (conn !== undefined) return Promise.resolve(conn);
      if (closed) return Promise.resolve(undefined);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close(): void {
      server.close();
    },
    ref(): void {
      server.ref();
    },
    unref(): void {
      server.unref();
    },
  };
}

function connect(options: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket =
      options.transport === "unix"
        ? netConnect({ path: options.path })
        : netConnect({
            host: options.hostname ?? "127.0.0.1",
            port: options.port,
          });
    socket.once("connect", () => {
      resolve({
        readable: Readable.toWeb(socket),
        writable: Writable.toWeb(socket),
        close() {
          socket.destroy();
        },
      });
    });
    socket.once("error", reject);
  });
}

function createHttpClient(options: any = {}): any {
  const proxyUrl: string | undefined = options?.proxy?.url;
  const client: any = {
    [httpClientMarker]: true,
    proxyUrl,
    dispatcher: undefined,
    close() {
      const dispose = this._dispose;
      if (typeof dispose === "function") void dispose();
    },
  };
  if (proxyUrl !== undefined) {
    void import("undici")
      .then((undici: any) => {
        const agent = new undici.ProxyAgent(proxyUrl);
        client.dispatcher = agent;
        client._dispose = () => agent.close();
      })
      .catch(() => {});
  }
  return client;
}

/** Translates a shim HTTP client passed to `fetch` into an undici dispatcher. */
function installFetchBridge(): void {
  const original = globalThis.fetch;
  if (original === undefined || (original as any).__opensacBridged === true) {
    return;
  }
  const patched = (input: any, init: any = {}) => {
    const client = init?.client;
    if (client !== undefined && client?.[httpClientMarker] === true) {
      const next = { ...init };
      delete next.client;
      if (client.dispatcher !== undefined) next.dispatcher = client.dispatcher;
      return original(input, next);
    }
    // Node's fetch does not implement `file:` URLs, but bundled WASM loaders
    // (e.g. `@jsquash/webp`) fetch their assets by file URL. Read them here.
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : typeof input?.url === "string"
            ? input.url
            : "";
    if (url.startsWith("file:")) {
      return readFile(fileURLToPath(url)).then(
        (bytes) =>
          new Response(
            bytes,
            url.endsWith(".wasm")
              ? { headers: { "content-type": "application/wasm" } }
              : undefined,
          ),
      );
    }
    return original(input, init);
  };
  (patched as any).__opensacBridged = true;
  (globalThis as any).fetch = patched;
}

// ─── makeTemp{File,Dir} (ignores dir/suffix placeholders in the name) ───────

function tempName(prefix: string, suffix: string): string {
  return `${prefix}${randomBytes(8).toString("hex")}${suffix}`;
}

async function makeTempDir({
  dir = tmpdir(),
  prefix = "",
  suffix = "",
}: any = {}): Promise<string> {
  for (;;) {
    const candidate = join(dir, tempName(prefix, suffix));
    try {
      await mkdir(candidate, { mode: 0o700 });
      return candidate;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

function makeTempDirSync({
  dir = tmpdir(),
  prefix = "",
  suffix = "",
}: any = {}): string {
  const { mkdirSync } = require("node:fs");
  for (;;) {
    const candidate = join(dir, tempName(prefix, suffix));
    try {
      mkdirSync(candidate, { mode: 0o700 });
      return candidate;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

async function makeTempFile({
  dir = tmpdir(),
  prefix = "",
  suffix = "",
}: any = {}): Promise<string> {
  for (;;) {
    const candidate = join(dir, tempName(prefix, suffix));
    try {
      const handle = await open(
        candidate,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      await handle.close();
      return candidate;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

function makeTempFileSync({
  dir = tmpdir(),
  prefix = "",
  suffix = "",
}: any = {}): string {
  for (;;) {
    const candidate = join(dir, tempName(prefix, suffix));
    try {
      const fd = openFileSync(
        candidate,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      const { closeSync } = require("node:fs");
      closeSync(fd);
      return candidate;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

// ─── Worker (Web Worker over node:worker_threads) ──────────────────────────

const workerBootstrap = [
  "const { parentPort } = require('node:worker_threads');",
  "globalThis.self = globalThis;",
  "globalThis.postMessage = (value, transfer) => parentPort.postMessage(value, transfer);",
  "globalThis.close = () => process.exit(0);",
  "parentPort.on('message', (data) => {",
  "  const handler = globalThis.onmessage;",
  "  if (typeof handler === 'function') handler({ data });",
  "});",
  "",
].join("\n");

class NodeWebWorker {
  onmessage: ((event: { data: any }) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  #worker: any;

  constructor(url: string | URL, options: any = {}) {
    const source = typeof url === "string" ? url : url.toString();
    if (!source.startsWith("data:")) {
      throw new Error("module-URL workers are not supported under Node");
    }
    const { Worker } = require("node:worker_threads");
    this.#worker = new Worker(workerBootstrap + decodeDataURL(source), {
      eval: true,
      ...(options.stdout === "inherit" ? { stdout: true } : {}),
      ...(options.stderr === "inherit" ? { stderr: true } : {}),
    });
    this.#worker.on("message", (data: any) => this.onmessage?.({ data }));
    this.#worker.on("error", (error: any) => this.onerror?.({ error }));
  }

  postMessage(value: any, transfer?: any): void {
    this.#worker.postMessage(value, transfer);
  }

  terminate(): Promise<void> {
    return this.#worker.terminate();
  }
}

/** Decodes a `data:` URL to its script text, base64 or percent-encoded. */
function decodeDataURL(url: string): string {
  const comma = url.indexOf(",");
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  return meta.includes("base64")
    ? Buffer.from(payload, "base64").toString("utf8")
    : decodeURIComponent(payload);
}

// ─── Public surface ─────────────────────────────────────────────────────────

/**
 * The richer process/net members, merged over `runtime_core` by `runtime.ts`.
 * These win over the base definitions (e.g. makeTemp* and exit).
 */
export const runtimeNet: Record<string, unknown> = {
  Command: NodeCommand,
  execPath: () => process.execPath,
  args: currentArgs(),
  exit: (code?: number | string) => {
    if (typeof code === "string") {
      console.error(code);
      process.exit(1);
    }
    process.exit(code ?? 0);
  },
  makeTempFile,
  makeTempFileSync,
  makeTempDir,
  makeTempDirSync,
  serve,
  listen,
  upgradeWebSocket,
  connect,
  createHttpClient,
  SeekMode: { Start: 0, Current: 1, End: 2 },
  unrefTimer: (id: any) => {
    if (
      id !== null &&
      typeof id === "object" &&
      typeof id.unref === "function"
    ) {
      id.unref();
    }
  },
  resolveDns: async (hostname: string, recordType = "A") => {
    switch (recordType) {
      case "A":
        return await resolve4(hostname);
      case "AAAA":
        return await resolve6(hostname);
      case "CNAME":
        return await resolveCname(hostname);
      case "MX":
        return (await resolveMx(hostname)).map(
          (r) => `${r.priority} ${r.exchange}`,
        );
      case "TXT":
        return (await resolveTxt(hostname)).map((parts) => parts.join(""));
      default:
        throw new Error(`resolveDns: unsupported record type ${recordType}`);
    }
  },
};

let workerInstalled = false;

/**
 * Installs the Web `Worker` global (over `node:worker_threads`) and bridges the
 * fetch HTTP-client option. Idempotent; `runtime.ts` calls it once at load.
 */
export function installWorkerGlobal(): void {
  if (workerInstalled) return;
  workerInstalled = true;
  if ((globalThis as any).Worker === undefined) {
    (globalThis as any).Worker = NodeWebWorker;
  }
  installFetchBridge();
}
