// Node-backed implementation of the runtime file/env/process surface.
//
// This repository runs on the Node runtime, with no external runtime or
// package-registry dependency.
// This module is the base layer that `src/platform/runtime.ts` merges with
// `src/platform/runtime_net.ts` and exposes as the `runtime` object every module
// imports. Nothing else defines a second runtime object.
//
// Scope: only the file/env/process/system surface that this codebase actually
// calls, backed by `node:fs`, `node:fs/promises`, `node:process`, and `node:os`.
// Networking and process spawning live in `runtime_net.ts`.

import * as nodeFs from "node:fs";
import {
  appendFile,
  chmod,
  chown,
  copyFile,
  link,
  lstat as lstatAsync,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat as statAsync,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import * as nodeOs from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

type AnyRecord = Record<string, any>;

// ─── Errors ───────────────────────────────────────────────────────────────

function errorClass(name: string): any {
  const Ctor = class extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
      super(message);
      // The classes are named after the error kind (`NotFound`, …) and
      // code checks `err.name === "NotFound"`; set the instance name, not just
      // the constructor's.
      this.name = name;
      if (options && "cause" in options) {
        Object.defineProperty(this, "cause", {
          value: options.cause,
          writable: true,
          configurable: true,
        });
      }
    }
  };
  Object.defineProperty(Ctor, "name", { value: name, configurable: true });
  return Ctor;
}

/** Error classes named after the error kind, mapped onto Node `fs`/`net` codes. */
export const errors = {
  NotFound: errorClass("NotFound"),
  AlreadyExists: errorClass("AlreadyExists"),
  PermissionDenied: errorClass("PermissionDenied"),
  BadResource: errorClass("BadResource"),
  AddrInUse: errorClass("AddrInUse"),
  AddrNotAvailable: errorClass("AddrNotAvailable"),
  ConnectionRefused: errorClass("ConnectionRefused"),
  ConnectionReset: errorClass("ConnectionReset"),
  BrokenPipe: errorClass("BrokenPipe"),
  NotSupported: errorClass("NotSupported"),
  Interrupted: errorClass("Interrupted"),
  IsADirectory: errorClass("IsADirectory"),
  NotADirectory: errorClass("NotADirectory"),
  InvalidData: errorClass("InvalidData"),
  TimedOut: errorClass("TimedOut"),
  UnexpectedEof: errorClass("UnexpectedEof"),
  WriteZero: errorClass("WriteZero"),
  ResourceBusy: errorClass("ResourceBusy"),
};

const ERROR_CODE_MAP: Record<string, any> = {
  ENOENT: errors.NotFound,
  // `process.kill(pid, 0)` reports a missing process as ESRCH; the runtime surfaces
  // that as NotFound, and liveness checks rely on it.
  ESRCH: errors.NotFound,
  EEXIST: errors.AlreadyExists,
  EACCES: errors.PermissionDenied,
  EPERM: errors.PermissionDenied,
  EBADF: errors.BadResource,
  EADDRINUSE: errors.AddrInUse,
  EADDRNOTAVAIL: errors.AddrNotAvailable,
  ECONNREFUSED: errors.ConnectionRefused,
  ECONNRESET: errors.ConnectionReset,
  EPIPE: errors.BrokenPipe,
  ENOSYS: errors.NotSupported,
  EOPNOTSUPP: errors.NotSupported,
  EINTR: errors.Interrupted,
  EISDIR: errors.IsADirectory,
  ENOTDIR: errors.NotADirectory,
  EINVAL: errors.InvalidData,
  ETIMEDOUT: errors.TimedOut,
  EBUSY: errors.ResourceBusy,
};

/** Rewrites a Node syscall error into its named error class. */
export function toRuntimeError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const code = (error as AnyRecord).code as string | undefined;
  if (!code) return error;
  const Cls = ERROR_CODE_MAP[code];
  if (!Cls) return error;
  const translated = new Cls(String((error as AnyRecord).message ?? error), {
    cause: error,
  });
  (translated as AnyRecord).code = code;
  if ("path" in (error as AnyRecord)) {
    (translated as AnyRecord).path = (error as AnyRecord).path;
  }
  return translated;
}

function wrapSync<T extends (...args: any[]) => any>(fn: T): T {
  return function (this: any, ...args: any[]) {
    try {
      return fn.apply(this, args);
    } catch (error) {
      throw toRuntimeError(error);
    }
  } as T;
}

function wrapAsync<F extends (...args: any[]) => Promise<any>>(fn: F): F {
  return async function (this: any, ...args: any[]) {
    try {
      return await fn.apply(this, args);
    } catch (error) {
      throw toRuntimeError(error);
    }
  } as F;
}

// ─── Small helpers ─────────────────────────────────────────────────────────

/** Path-or-URL → filesystem path. */
function p(path: string | URL): string {
  if (typeof path === "string") return path;
  const url = path instanceof URL ? path : new URL(String(path));
  return decodeURIComponent(url.pathname);
}

function optsToFlags(options: AnyRecord = {}): string {
  if (typeof options.flag === "string") return options.flag;
  // `createNew` is exclusive-create (O_EXCL); Node spells it "wx".
  if (options.createNew) return options.read && !options.write ? "wx+" : "wx";
  if (options.read && options.write) return options.append ? "a+" : "r+";
  if (options.write) {
    if (options.append) return "a";
    return options.truncate === false ? "r+" : "w";
  }
  if (options.create) return "w";
  return "r";
}

/** Maps the write-file options onto Node's `writeFile` flag/mode. */
function writeFlags(options: AnyRecord = {}): { flag: string; mode?: number } {
  const flag = options.createNew ? "wx" : options.append ? "a" : "w";
  return options.mode === undefined ? { flag } : { flag, mode: options.mode };
}

function tempName(options: AnyRecord = {}): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${options.prefix ?? ""}${Date.now().toString(36)}${rand}${
    options.suffix ?? ""
  }`;
}

function tempPath(options: AnyRecord = {}): string {
  return join(options.dir ?? nodeOs.tmpdir(), tempName(options));
}

type StatsLike = nodeFs.Stats;

function fileInfo(stat: StatsLike): AnyRecord {
  return {
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    isSymlink: false,
    size: stat.size,
    mtime: stat.mtime,
    atime: stat.atime,
    ctime: stat.ctime,
    birthtime: stat.birthtime,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    uid: stat.uid,
    gid: stat.gid,
    rdev: stat.rdev,
    blksize: (stat as AnyRecord).blksize,
    blocks: (stat as AnyRecord).blocks,
  };
}

function lstatInfo(stat: StatsLike & { isSymbolicLink(): boolean }): AnyRecord {
  const info = fileInfo(stat);
  info.isSymlink = stat.isSymbolicLink();
  return info;
}

function dirEntry(entry: nodeFs.Dirent): AnyRecord {
  return {
    name: entry.name,
    isFile: entry.isFile(),
    isDirectory: entry.isDirectory(),
    isSymlink: entry.isSymbolicLink(),
  };
}

function bytes(data: Uint8Array | string): Uint8Array | Buffer {
  return typeof data === "string" ? Buffer.from(data, "utf8") : data;
}

// ─── FsFile ────────────────────────────────────────────────────────────────

/**
 * File handle over a Node file descriptor. Node tracks no portable
 * read/write cursor for an O_RDONLY/O_RDWR descriptor opened through libuv, so
 * the cursor is maintained here: every read/write/seek goes through explicit
 * positional I/O against `#pos`.
 */
class NodeFsFile {
  #fd: number;
  #filePath: string;
  #pos = 0;
  #closed = false;

  constructor(fd: number, filePath: string) {
    this.#fd = fd;
    this.#filePath = filePath;
  }

  get rid(): number {
    return this.#fd;
  }

  get path(): string {
    return this.#filePath;
  }

  get readable(): ReadableStream<Uint8Array> {
    return this.readableWebStream();
  }

  #assertOpen(): void {
    if (this.#closed) throw new errors.BadResource("File is closed");
  }

  read(buffer: Uint8Array): Promise<number | null> {
    return Promise.resolve(this.readSync(buffer));
  }

  readSync(buffer: Uint8Array): number | null {
    this.#assertOpen();
    const n = nodeFs.readSync(
      this.#fd,
      buffer,
      0,
      buffer.byteLength,
      this.#pos,
    );
    if (n === 0) return null;
    this.#pos += n;
    return n;
  }

  /** Reads up to `size` bytes, or the whole remainder when `size` is omitted. */
  async readFile(size?: number): Promise<Uint8Array | null> {
    if (size === undefined) {
      const data = await readFile(this.#filePath).catch((error) => {
        throw toRuntimeError(error);
      });
      return new Uint8Array(data);
    }
    const buf = new Uint8Array(Math.max(0, size));
    let offset = 0;
    while (offset < buf.byteLength) {
      const n = this.readSync(buf.subarray(offset));
      if (n === null) break;
      offset += n;
    }
    if (offset === 0 && buf.byteLength > 0) return null;
    return buf.subarray(0, offset);
  }

  write(data: Uint8Array | string): Promise<number> {
    return Promise.resolve(this.writeSync(data));
  }

  writeSync(data: Uint8Array | string): number {
    this.#assertOpen();
    const chunk = bytes(data);
    const n = nodeFs.writeSync(this.#fd, chunk, 0, chunk.byteLength, this.#pos);
    this.#pos += n;
    return n;
  }

  seek(
    offset: number | { offset: number; whence: number },
    whence = 0,
  ): Promise<number> {
    return Promise.resolve(this.seekSync(offset, whence));
  }

  seekSync(
    offset: number | { offset: number; whence: number },
    whence = 0,
  ): number {
    this.#assertOpen();
    const delta = typeof offset === "number" ? offset : offset.offset;
    const mode = typeof offset === "number" ? whence : offset.whence;
    const size = nodeFs.fstatSync(this.#fd).size;
    if (mode === 1) this.#pos += delta;
    else if (mode === 2) this.#pos = size + delta;
    else this.#pos = delta;
    return this.#pos;
  }

  tellSync(): number {
    this.#assertOpen();
    return this.#pos;
  }

  truncate(len?: number): Promise<void> {
    return Promise.resolve(this.truncateSync(len));
  }

  truncateSync(len?: number): void {
    this.#assertOpen();
    nodeFs.ftruncateSync(this.#fd, len);
    if (len !== undefined && this.#pos > len) this.#pos = len;
  }

  datasync(): Promise<void> {
    return Promise.resolve(this.datasyncSync());
  }

  datasyncSync(): void {
    this.#assertOpen();
    nodeFs.fdatasyncSync(this.#fd);
  }

  sync(): Promise<void> {
    return Promise.resolve(this.syncSync());
  }

  syncSync(): void {
    this.#assertOpen();
    nodeFs.fsyncSync(this.#fd);
  }

  utime(atime: Date | null, mtime: Date | null): Promise<void> {
    return Promise.resolve(this.utimeSync(atime, mtime));
  }

  utimeSync(atime: Date | null, mtime: Date | null): void {
    this.#assertOpen();
    nodeFs.futimesSync(this.#fd, atime ?? new Date(), mtime ?? new Date());
  }

  readableWebStream(): ReadableStream<Uint8Array> {
    const self = this;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = new Uint8Array(64 * 1024);
        const n = await self.read(chunk);
        if (n === null) controller.close();
        else controller.enqueue(chunk.subarray(0, n));
      },
    });
  }

  writableWebStream(options: { type?: "bytes" | "direct" } = {}) {
    const self = this;
    const direct = options.type === "direct";
    let pending = new Uint8Array(0);
    const flush = async () => {
      if (pending.byteLength === 0) return;
      await self.write(pending);
      pending = new Uint8Array(0);
    };
    return {
      kind: direct ? "raw" : "bytes",
      async write(chunk: Uint8Array | string) {
        const data = bytes(chunk);
        if (direct) await self.write(data);
        else {
          const next = new Uint8Array(pending.byteLength + data.byteLength);
          next.set(pending, 0);
          next.set(data, pending.byteLength);
          pending = next;
          if (pending.byteLength >= 64 * 1024) await flush();
        }
      },
      async close() {
        await flush();
        await self.close();
      },
      async abort() {
        await self.close();
      },
    };
  }

  lockExclusive(): Promise<void> {
    return Promise.reject(new errors.NotSupported("lockExclusive"));
  }

  lockShared(): Promise<void> {
    return Promise.reject(new errors.NotSupported("lockShared"));
  }

  unlock(): Promise<void> {
    return Promise.reject(new errors.NotSupported("unlock"));
  }

  close(): Promise<void> {
    return Promise.resolve(this.closeSync());
  }

  closeSync(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      nodeFs.closeSync(this.#fd);
    } catch {
      /* already closed by the OS */
    }
  }
}

// Lazily built so importing the runtime does not hold a stdin stream (and,
// with it, an open handle) alive for processes that never read input.
let stdinReadableStream: ReadableStream<Uint8Array> | undefined;

function stdinReadable(): ReadableStream<Uint8Array> {
  if (stdinReadableStream !== undefined) return stdinReadableStream;
  stdinReadableStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      ensureStdin();
      while (stdinBuffer.length === 0 && !stdinClosed) {
        await new Promise<void>((resolveWake) => {
          const wake = () => {
            stdinWaiters.delete(wake);
            resolveWake();
          };
          stdinWaiters.add(wake);
        });
      }
      if (stdinBuffer.length === 0) {
        controller.close();
        return;
      }
      controller.enqueue(takeStdin(64 * 1024));
    },
  });
  return stdinReadableStream;
}

// ─── Std streams ───────────────────────────────────────────────────────────

let stdinStarted = false;
let stdinClosed = false;
let stdinBuffer = Buffer.alloc(0);
const stdinWaiters = new Set<() => void>();

function ensureStdin(): void {
  if (stdinStarted) return;
  stdinStarted = true;
  process.stdin.on("data", (chunk: Buffer) => {
    stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
    for (const wake of stdinWaiters) wake();
  });
  const finish = () => {
    stdinClosed = true;
    for (const wake of stdinWaiters) wake();
  };
  process.stdin.on("end", finish);
  process.stdin.on("close", finish);
  process.stdin.resume();
}

function takeStdin(maxBytes: number): Uint8Array {
  const chunk = stdinBuffer.subarray(0, maxBytes);
  stdinBuffer = stdinBuffer.subarray(chunk.length);
  return new Uint8Array(chunk);
}

function stdinReadInto(buffer: Uint8Array): number | null {
  ensureStdin();
  if (stdinBuffer.length === 0) return stdinClosed ? null : 0;
  const chunk = takeStdin(buffer.byteLength);
  buffer.set(chunk);
  return chunk.byteLength;
}

async function* stdinLines(): AsyncIterableIterator<string> {
  ensureStdin();
  let text = "";
  const decoder = new TextDecoder();
  while (!stdinClosed || stdinBuffer.length > 0) {
    if (stdinBuffer.length === 0) {
      await new Promise<void>((resolveWake) => {
        const wake = () => {
          stdinWaiters.delete(wake);
          resolveWake();
        };
        stdinWaiters.add(wake);
      });
      continue;
    }
    text += decoder.decode(takeStdin(64 * 1024), { stream: true });
    const lines = text.split("\n");
    text = lines.pop() ?? "";
    for (const line of lines) yield line.replace(/\r$/, "");
  }
  text += decoder.decode();
  if (text.length > 0) yield text.replace(/\r$/, "");
}

function outputStream(fd: 1 | 2) {
  let queue: Promise<number> = Promise.resolve(0);
  const writeChunk = (data: Uint8Array | string): Promise<number> => {
    const chunk = bytes(data);
    queue = queue.then(
      () =>
        new Promise<number>((res, rej) => {
          nodeFs.write(fd, chunk, 0, chunk.byteLength, null, (error, n) =>
            error ? rej(toRuntimeError(error)) : res(n),
          );
        }),
    );
    return queue;
  };
  return {
    writable: Writable.toWeb(
      fd === 1 ? process.stdout : process.stderr,
    ) as unknown as WritableStream<Uint8Array>,
    readable: false,
    rid: fd,
    isTerminal: () =>
      Boolean((fd === 1 ? process.stdout : process.stderr).isTTY),
    write: writeChunk,
    writeSync(data: Uint8Array | string): number {
      const chunk = bytes(data);
      return nodeFs.writeSync(fd, chunk, 0, chunk.byteLength, null);
    },
    async *[Symbol.asyncIterator]() {
      throw new errors.NotSupported("iterating an output stream");
    },
  };
}

// ─── Namespace ─────────────────────────────────────────────────────────────

/** The Node-backed runtime core, merged into `runtime` by `runtime.ts`. */
export const runtimeCore: AnyRecord = {
  version: {
    // The runtime name keeps `doctor`/telemetry honest about which runtime is
    // hosting the process.
    node: process.version,
    v8: process.versions.v8 ?? "",
    typescript: process.version,
  },
  pid: process.pid,
  execPath: () => process.execPath,
  args: [] as string[],
  env: {
    get: (key: string) => process.env[key],
    set: (key: string, value: string) => {
      process.env[key] = value;
    },
    delete: (key: string) => {
      delete process.env[key];
    },
    toObject: () => ({ ...process.env }),
  },
  errors,
  SeekMode: { Start: 0, Current: 1, End: 2 },
  build: {
    target: `${process.platform}-${process.arch}`,
    arch: process.arch,
    os: process.platform,
    vendor: process.platform === "darwin" ? "apple" : "pc",
    env: process.platform === "win32" ? "windows" : "native",
  },
  hostname: () => nodeOs.hostname(),
  osRelease: () => nodeOs.release(),
  systemMemoryInfo: () => {
    const total = nodeOs.totalmem();
    const free = nodeOs.freemem();
    return {
      total,
      free,
      available: free,
      buffersAndCache: 0,
      loadAvg: (nodeOs as AnyRecord).loadavg?.() ?? [],
    };
  },
  memoryUsage: () => {
    const m = process.memoryUsage();
    return {
      total: m.heapTotal,
      used: m.heapUsed,
      free: m.heapTotal - m.heapUsed,
    };
  },
  consoleSize: () => ({
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  }),
  isatty: (ridOrStream?: unknown) => {
    // isatty(0)/isatty(1)/isatty(2) take a resource id; anything
    // else (including no argument) is treated as stdout.
    if (ridOrStream === 0) return Boolean(process.stdin.isTTY);
    if (ridOrStream === 2) return Boolean(process.stderr.isTTY);
    return Boolean(process.stdout.isTTY);
  },
  addSignalListener: (signal: string, handler: () => void) => {
    process.on(signal as NodeJS.Signals, handler);
  },
  removeSignalListener: (signal: string, handler: () => void) => {
    process.off(signal as NodeJS.Signals, handler);
  },
  kill: wrapSync((pid: number, signal: number | string = "SIGTERM") => {
    process.kill(pid, signal as NodeJS.Signals);
  }),
  stdin: {
    get readable() {
      return stdinReadable();
    },
    rid: 0,
    isTerminal: () => Boolean(process.stdin.isTTY),
    read: (buffer: Uint8Array) => Promise.resolve(stdinReadInto(buffer)),
    readSync: (buffer: Uint8Array) => stdinReadInto(buffer),
    readAll: () =>
      new Promise<Uint8Array>((resolveAll) => {
        ensureStdin();
        const chunks: Uint8Array[] = [];
        const collect = () => {
          const merged = new Uint8Array(
            chunks.reduce((n, c) => n + c.byteLength, 0),
          );
          let offset = 0;
          for (const c of chunks) {
            merged.set(c, offset);
            offset += c.byteLength;
          }
          resolveAll(merged);
        };
        const pump = async () => {
          for await (const _line of stdinLines()) {
            void _line;
          }
          collect();
        };
        void pump();
      }),
    setRaw(enable: boolean): void {
      if (process.stdin.isTTY) {
        if (enable) process.stdin.setRawMode(true);
        else process.stdin.setRawMode(false);
      }
    },
    readText: () =>
      new Promise<string | null>((resolveText) => {
        ensureStdin();
        void (async () => {
          const parts: string[] = [];
          for await (const line of stdinLines()) parts.push(line);
          resolveText(
            parts.length === 0 && stdinClosed ? null : parts.join("\n"),
          );
        })();
      }),
    readTextSync: (): string | null => {
      ensureStdin();
      if (stdinBuffer.length === 0) return stdinClosed ? null : "";
      return new TextDecoder().decode(takeStdin(stdinBuffer.length));
    },
    readLine: () => stdinLines(),
    [Symbol.asyncIterator]: () => stdinLines(),
  },
  stdout: outputStream(1),
  stderr: outputStream(2),
  cwd: () => process.cwd(),
  chdir: (directory: string | URL) => {
    process.chdir(p(directory));
  },

  // Filesystem: metadata.
  stat: wrapAsync(async (path: string | URL) =>
    fileInfo(await statAsync(p(path))),
  ),
  statSync: wrapSync((path: string | URL) =>
    fileInfo(nodeFs.statSync(p(path))),
  ),
  lstat: wrapAsync(async (path: string | URL) =>
    lstatInfo(await lstatAsync(p(path))),
  ),
  lstatSync: wrapSync((path: string | URL) =>
    lstatInfo(nodeFs.lstatSync(p(path))),
  ),
  tryStat: (path: string | URL) => {
    try {
      return fileInfo(nodeFs.statSync(p(path)));
    } catch {
      return null;
    }
  },
  tryLstat: (path: string | URL) => {
    try {
      return lstatInfo(nodeFs.lstatSync(p(path)));
    } catch {
      return null;
    }
  },
  realPath: wrapAsync((path: string | URL) => realpath(p(path))),
  realPathSync: wrapSync((path: string | URL) => nodeFs.realpathSync(p(path))),

  // Filesystem: directories and links.
  mkdir: wrapAsync((path: string | URL, options: AnyRecord = {}) =>
    mkdir(p(path), {
      recursive: options.recursive === true,
      mode: options.mode,
    }),
  ),
  mkdirSync: wrapSync((path: string | URL, options: AnyRecord = {}) => {
    nodeFs.mkdirSync(p(path), {
      recursive: options.recursive === true,
      mode: options.mode,
    });
  }),
  remove: wrapAsync((path: string | URL, options: AnyRecord = {}) =>
    rm(p(path), {
      recursive: !!options.recursive,
      force: true,
      maxRetries: 3,
    }),
  ),
  removeSync: wrapSync((path: string | URL, options: AnyRecord = {}) => {
    nodeFs.rmSync(p(path), {
      recursive: !!options.recursive,
      force: true,
      maxRetries: 3,
    });
  }),
  rename: wrapAsync((from: string | URL, to: string | URL) =>
    rename(p(from), p(to)),
  ),
  renameSync: wrapSync((from: string | URL, to: string | URL) => {
    nodeFs.renameSync(p(from), p(to));
  }),
  copyFile: wrapAsync((from: string | URL, to: string | URL) =>
    copyFile(p(from), p(to)),
  ),
  copyFileSync: wrapSync((from: string | URL, to: string | URL) => {
    nodeFs.copyFileSync(p(from), p(to));
  }),
  symlink: wrapAsync((target: string, path: string | URL) =>
    symlink(target, p(path)),
  ),
  symlinkSync: wrapSync(
    (target: string, path: string | URL, options: AnyRecord = {}) => {
      nodeFs.symlinkSync(
        target,
        p(path),
        options?.type ?? (process.platform === "win32" ? "junction" : "file"),
      );
    },
  ),
  link: wrapAsync((from: string | URL, to: string | URL) =>
    link(p(from), p(to)),
  ),
  linkSync: wrapSync((from: string | URL, to: string | URL) => {
    nodeFs.linkSync(p(from), p(to));
  }),
  chmod: wrapAsync((path: string | URL, mode: number) => chmod(p(path), mode)),
  chmodSync: wrapSync((path: string | URL, mode: number) => {
    nodeFs.chmodSync(p(path), mode);
  }),
  chown: wrapAsync(
    (path: string | URL, uid: number | null, gid: number | null) =>
      chown(p(path), uid ?? -1, gid ?? -1),
  ),
  chownSync: wrapSync(
    (path: string | URL, uid: number | null, gid: number | null) => {
      nodeFs.chownSync(p(path), uid ?? -1, gid ?? -1);
    },
  ),
  utime: wrapAsync(
    (path: string | URL, atime: Date | null, mtime: Date | null) =>
      utimes(p(path), atime ?? new Date(), mtime ?? new Date()),
  ),
  utimeSync: wrapSync(
    (path: string | URL, atime: Date | null, mtime: Date | null) => {
      nodeFs.utimesSync(p(path), atime ?? new Date(), mtime ?? new Date());
    },
  ),
  readDir: wrapSync((path: string | URL) => {
    const entries = nodeFs.readdirSync(p(path), { withFileTypes: true });
    const iterator = entries.map(dirEntry)[Symbol.iterator]();
    return {
      [Symbol.iterator]: () => iterator,
      next: () => iterator.next(),
      return: () => Promise.resolve({ done: true as const, value: undefined }),
    };
  }),
  readDirSync: wrapSync((path: string | URL) => {
    const entries = nodeFs
      .readdirSync(p(path), { withFileTypes: true })
      .map(dirEntry);
    return entries[Symbol.iterator]();
  }),

  // Filesystem: file contents.
  readFile: wrapAsync(
    async (path: string | URL) => new Uint8Array(await readFile(p(path))),
  ),
  readFileSync: wrapSync(
    (path: string | URL) => new Uint8Array(nodeFs.readFileSync(p(path))),
  ),
  readTextFile: wrapAsync((path: string | URL) => readFile(p(path), "utf8")),
  readTextFileSync: wrapSync((path: string | URL) =>
    nodeFs.readFileSync(p(path), "utf8"),
  ),
  writeFile: wrapAsync(
    (path: string | URL, data: Uint8Array | string, options: AnyRecord = {}) =>
      writeFile(p(path), bytes(data) as any, writeFlags(options)),
  ),
  writeFileSync: wrapSync(
    (
      path: string | URL,
      data: Uint8Array | string,
      options: AnyRecord = {},
    ) => {
      nodeFs.writeFileSync(p(path), bytes(data) as any, writeFlags(options));
    },
  ),
  writeTextFile: wrapAsync(
    (path: string | URL, data: string, options: AnyRecord = {}) =>
      writeFile(p(path), data, writeFlags(options)),
  ),
  writeTextFileSync: wrapSync(
    (path: string | URL, data: string, options: AnyRecord = {}) => {
      nodeFs.writeFileSync(p(path), data, writeFlags(options));
    },
  ),
  appendFile: wrapAsync((path: string | URL, data: Uint8Array | string) =>
    appendFile(p(path), bytes(data) as any),
  ),
  appendFileSync: wrapSync((path: string | URL, data: Uint8Array | string) => {
    nodeFs.appendFileSync(p(path), bytes(data) as any);
  }),
  open: wrapAsync(
    async (path: string | URL, options: AnyRecord = {}) =>
      new NodeFsFile(
        nodeFs.openSync(p(path), optsToFlags(options), options.mode),
        p(path),
      ),
  ),
  openSync: wrapSync(
    (path: string | URL, options: AnyRecord = {}) =>
      new NodeFsFile(
        nodeFs.openSync(p(path), optsToFlags(options), options.mode),
        p(path),
      ),
  ),
  create: wrapAsync(
    async (path: string | URL) =>
      new NodeFsFile(nodeFs.openSync(p(path), "w"), p(path)),
  ),
  createSync: wrapSync(
    (path: string | URL) =>
      new NodeFsFile(nodeFs.openSync(p(path), "w"), p(path)),
  ),

  // Temp files.
  makeTempDir: wrapAsync(async (options: AnyRecord = {}) => {
    const target = tempPath(options);
    await mkdir(target, { recursive: true });
    return target;
  }),
  makeTempDirSync: wrapSync((options: AnyRecord = {}) => {
    const target = tempPath(options);
    nodeFs.mkdirSync(target, { recursive: true });
    return target;
  }),
  makeTempFile: wrapAsync(async (options: AnyRecord = {}) => {
    const target = tempPath(options);
    await writeFile(target, "");
    return target;
  }),
  makeTempFileSync: wrapSync((options: AnyRecord = {}) => {
    const target = tempPath(options);
    nodeFs.writeFileSync(target, "");
    return target;
  }),

  // Constructors exposed for `instanceof`/typing parity.
  FsFile: NodeFsFile,
  FileInfo: fileInfo,
  DirEntry: dirEntry,
};
