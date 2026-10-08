// Node runtime compatibility for the Deno APIs that `@deno/shim-deno` omits.
//
// `@deno/shim-deno` covers only the file/env/process surface.
// The product also uses `Deno.Command`, `Deno.serve`, `Deno.upgradeWebSocket`,
// `Deno.connect`, `Deno.createHttpClient`, `Deno.SeekMode`, `Deno.unrefTimer`,
// `Deno.resolveDns`, and the Web `Worker` global. This module installs those on
// top of Node built-ins so the same sources run unmodified under Node.
//
// It is imported for its side effect from the CLI entry. Under Deno every
// needed API already exists, so installation returns immediately and this file
// is a no-op there.
//
// Known deviations from Deno under Node:
//   * A `Deno.serve` bind failure (e.g. port in use) surfaces asynchronously
//     through `finished`/`onError`, because `node:http` has no synchronous
//     listen.
//   * `Deno.createHttpClient` proxy support needs the optional `undici`
//     dependency; without it the client connects directly.
//   * Module-URL web workers are unsupported (throw), which degrades the stats
//     offload to its in-process fallback. `data:`-URL workers work.

// deno-lint-ignore-file no-explicit-any

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
import { mkdir, open } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
// The Deno global the sources read at runtime. esbuild leaves `Deno` as a
// global reference; this module assigns it (from the shim) and extends it.
import { Deno as denoGlobal } from "@deno/shim-deno";

type AnyDeno = Record<string, any> & { serve?: unknown };

const require = createRequire(import.meta.url);

/** Symbol carrying the raw Node upgrade context on a synthesized `Request`. */
const upgradeContext = Symbol("opensacNodeUpgrade");
/** Symbol marking a client produced by the `createHttpClient` shim. */
const httpClientMarker = Symbol("opensacHttpClient");

/** True when running under Node rather than Deno (no native `Deno.serve`). */
function isNodeRuntime(deno: AnyDeno | undefined): boolean {
  return deno === undefined || typeof deno.serve !== "function";
}

/**
 * Overwrites a member on the shim's `Deno` object. The shim defines most
 * members as getter-only, so plain assignment throws; `defineProperty` works
 * because those descriptors are configurable.
 */
function override(target: AnyDeno, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

// ─── Deno.Command ──────────────────────────────────────────────────────────

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
  return stream ? Readable.toWeb(stream) : null;
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

  ref(): void {
    this.#proc.ref();
  }

  unref(): void {
    this.#proc.unref();
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

// ─── Deno.serve / upgradeWebSocket ─────────────────────────────────────────

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
  const options = typeof target === "function" ? {} : target ?? {};
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
    (request as any)[upgradeContext] = { req, socket, head, wss };
    Promise.resolve(handler(request)).then(
      (response) => {
        if (response !== undefined && response.status !== 101) {
          void respondToUpgradedSocket(socket, response).catch(() =>
            socket.destroy()
          );
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

  server.listen({
    host: options.hostname ?? undefined,
    port: options.port ?? 0,
  }, () => {
    const address = server.address();
    if (address !== null && typeof address === "object") {
      addr = {
        transport: "tcp",
        hostname: address.address,
        port: address.port,
      };
      if (typeof options.onListen === "function") options.onListen(addr);
    }
  });

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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resolveFinished();
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

function upgradeWebSocket(
  request: Request,
): { socket: any; response: Response } {
  const ctx = (request as any)[upgradeContext];
  if (ctx === undefined) {
    throw new Error("upgradeWebSocket expects an upgrade request");
  }
  let socket: any;
  ctx.wss.handleUpgrade(ctx.req, ctx.socket, ctx.head, (ws: any) => {
    socket = ws;
  });
  if (socket === undefined) throw new Error("websocket upgrade failed");
  return { socket, response: new Response(null, { status: 101 }) };
}

// ─── Deno.connect / createHttpClient ───────────────────────────────────────

function connect(options: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = options.transport === "unix"
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
    void import("undici").then((undici: any) => {
      const agent = new undici.ProxyAgent(proxyUrl);
      client.dispatcher = agent;
      client._dispose = () => agent.close();
    }).catch(() => {});
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
    return original(input, init);
  };
  (patched as any).__opensacBridged = true;
  (globalThis as any).fetch = patched;
}

// ─── Deno.makeTemp{File,Dir} (shim ignores dir/suffix) ─────────────────────

function tempName(prefix: string, suffix: string): string {
  return `${prefix}${randomBytes(8).toString("hex")}${suffix}`;
}

async function makeTempDir(
  { dir = tmpdir(), prefix = "", suffix = "" }: any = {},
): Promise<string> {
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

function makeTempDirSync(
  { dir = tmpdir(), prefix = "", suffix = "" }: any = {},
): string {
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

async function makeTempFile(
  { dir = tmpdir(), prefix = "", suffix = "" }: any = {},
): Promise<string> {
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

function makeTempFileSync(
  { dir = tmpdir(), prefix = "", suffix = "" }: any = {},
): string {
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

// ─── Install ───────────────────────────────────────────────────────────────

/** Installs the missing Deno APIs onto the shim's `Deno` global. No-op on Deno. */
export function installNodeDenoCompat(): void {
  const deno = denoGlobal as AnyDeno;
  if (!isNodeRuntime(deno)) return;

  // Expose it globally too, for code that reaches `globalThis.Deno`.
  if (typeof (globalThis as any).Deno === "undefined") {
    (globalThis as any).Deno = deno;
  }

  override(deno, "Command", NodeCommand);
  override(deno, "makeTempFile", makeTempFile);
  override(deno, "makeTempFileSync", makeTempFileSync);
  override(deno, "makeTempDir", makeTempDir);
  override(deno, "makeTempDirSync", makeTempDirSync);
  override(deno, "serve", serve);
  override(deno, "upgradeWebSocket", upgradeWebSocket);
  override(deno, "connect", connect);
  override(deno, "createHttpClient", createHttpClient);
  override(deno, "SeekMode", { Start: 0, Current: 1, End: 2 });
  override(deno, "unrefTimer", (id: any) => {
    if (
      id !== null && typeof id === "object" && typeof id.unref === "function"
    ) {
      id.unref();
    }
  });
  override(deno, "resolveDns", async (hostname: string, recordType = "A") => {
    switch (recordType) {
      case "A":
        return await resolve4(hostname);
      case "AAAA":
        return await resolve6(hostname);
      case "CNAME":
        return await resolveCname(hostname);
      case "MX":
        return (await resolveMx(hostname)).map((r) =>
          `${r.priority} ${r.exchange}`
        );
      case "TXT":
        return (await resolveTxt(hostname)).map((parts) => parts.join(""));
      default:
        throw new Error(`resolveDns: unsupported record type ${recordType}`);
    }
  });

  if ((globalThis as any).Worker === undefined) {
    (globalThis as any).Worker = NodeWebWorker;
  }
  installFetchBridge();
}

if (isNodeRuntime(denoGlobal as AnyDeno)) {
  installNodeDenoCompat();
}
