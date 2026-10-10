// The single Node-backed runtime module for the sources.
//
// It merges `./runtime_core.ts` (file/env/process basics) with
// `./runtime_net.ts` (process spawning, HTTP server, sockets, DNS) and exposes
// one typed `runtime` object plus the error classes and value types the rest of
// the tree imports. Every former environment global call site now reads
// `runtime.*` from here.
//
// The callable surface is typed so callback parameters (for example the request
// handler passed to `runtime.serve`) get contextual types.

import { errors as errorClasses, runtimeCore } from "./runtime_core.ts";
import { installWorkerGlobal, runtimeNet } from "./runtime_net.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface NetAddr {
  transport: "tcp";
  hostname: string;
  port: number;
}

export interface UnixAddr {
  transport: "unix";
  path: string;
}

export type Addr = NetAddr | UnixAddr;

export interface FileInfo {
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  mtime: Date | null;
  atime: Date | null;
  birthtime: Date | null;
  ctime: Date | null;
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  blksize: number | null;
  blocks: number | null;
}

export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
}

export interface FsFile {
  readonly rid: number;
  close(): void;
  write(p: Uint8Array): Promise<number>;
  writeSync(p: Uint8Array): number;
  read(p: Uint8Array): Promise<number | null>;
  readSync(p: Uint8Array): number | null;
  seek(offset: number, whence?: SeekMode): Promise<number>;
  seekSync(offset: number, whence?: SeekMode): number;
  truncate(len?: number): Promise<void>;
  sync(): Promise<void>;
  syncSync(): void;
  stat(): Promise<FileInfo>;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

export interface Conn {
  readonly rid: number;
  read(p: Uint8Array): Promise<number | null>;
  write(p: Uint8Array): Promise<number>;
  closeWrite(): Promise<void>;
  close(): void;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

export interface Listener {
  readonly addr: Addr;
  readonly rid: number;
  /** Resolves once the socket is bound; `addr` is valid afterwards. */
  readonly ready: Promise<void>;
  accept(): Promise<Conn>;
  close(): void;
  ref(): void;
  unref(): void;
}

export interface ServeHandlerInfo {
  readonly remoteAddr: NetAddr;
  readonly completed: Promise<void>;
}

export interface HttpServer {
  readonly addr: NetAddr;
  readonly finished: Promise<void>;
  shutdown(): Promise<void>;
  ref(): void;
  unref(): void;
}

export interface HttpClient {
  close(): void;
}

export interface CommandOptions {
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  clearEnv?: boolean;
  stdin?: "piped" | "inherit" | "null";
  stdout?: "piped" | "inherit" | "null";
  stderr?: "piped" | "inherit" | "null";
  uid?: number;
  gid?: number;
  signal?: AbortSignal;
  windowsRawArguments?: boolean;
}

export interface CommandStatus {
  success: boolean;
  code: number;
  signal: string | null;
}

export interface CommandOutput {
  success: boolean;
  code: number;
  signal: string | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface ChildProcess {
  readonly pid: number;
  readonly status: Promise<CommandStatus>;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly stdin: WritableStream<Uint8Array> | null;
  output(): Promise<CommandOutput>;
  kill(signal?: string): void;
  ref(): void;
  unref(): void;
}

export interface CommandInstance {
  output(): Promise<CommandOutput>;
  outputSync(): CommandOutput;
  spawn(): ChildProcess;
}

export interface CommandConstructor {
  new (command: string, options?: CommandOptions): CommandInstance;
}

export interface MakeTempOptions {
  dir?: string;
  prefix?: string;
  suffix?: string;
}

export interface OpenOptions {
  read?: boolean;
  write?: boolean;
  append?: boolean;
  truncate?: boolean;
  create?: boolean;
  createNew?: boolean;
  mode?: number;
}

export interface WriteFileOptions {
  append?: boolean;
  create?: boolean;
  createNew?: boolean;
  mode?: number;
  signal?: AbortSignal;
}

export interface TestContext {
  readonly name: string;
  step<T>(
    name: string,
    fn: (context: TestContext) => T | Promise<T>,
  ): Promise<T>;
}

export interface StdWriter {
  writeSync(p: Uint8Array): number;
  write(p: Uint8Array): Promise<number>;
  readonly writable: WritableStream<Uint8Array>;
  isTerminal(): boolean;
}

/** File seek origins; a frozen object so Node's type stripper can erase it. */
export const SeekMode = {
  Start: 0,
  Current: 1,
  End: 2,
} as const;
export type SeekMode = (typeof SeekMode)[keyof typeof SeekMode];

export interface ServeOptions {
  hostname?: string;
  port?: number;
  onListen?: (localAddr: NetAddr) => void;
  onError?: (error: unknown) => unknown;
  signal?: AbortSignal;
}

export interface ServeHandler {
  (request: Request, info: ServeHandlerInfo): Response | Promise<Response>;
}

export interface ServeFunction {
  (handler: ServeHandler): HttpServer;
  (options: ServeOptions, handler?: ServeHandler): HttpServer;
}

export interface ListenOptions {
  transport?: "tcp";
  hostname?: string;
  port?: number;
  signal?: AbortSignal;
}

export interface ConnectOptions {
  transport?: "tcp" | "unix";
  hostname?: string;
  port?: number;
  path?: string;
  signal?: AbortSignal;
}

export interface Environment {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  has(key: string): boolean;
  toObject(): Record<string, string>;
}

export interface Runtime {
  // Environment / process.
  args: string[];
  build: {
    target: string;
    arch: string;
    os: string;
    vendor: string;
    env?: Record<string, string>;
  };
  env: Environment;
  errors: typeof errorClasses;
  version: { node: string; v8: string; typescript: string };
  pid: number;
  stdout: StdWriter;
  stderr: StdWriter;
  stdin: {
    readonly rid: number;
    read(p: Uint8Array): Promise<number | null>;
    readSync(p: Uint8Array): number | null;
    readonly readable: ReadableStream<Uint8Array>;
    isTerminal(): boolean;
    close(): void;
  };
  cwd(): string;
  chdir(directory: string | URL): void;
  exit(code?: number | string): never;
  execPath(): string;
  hostname(): string;
  consoleSize(rid?: number): { columns: number; rows: number };
  unrefTimer(id: unknown): void;
  refTimer(id: unknown): void;
  addSignalListener(signal: string, handler: () => void): void;
  removeSignalListener(signal: string, handler: () => void): void;
  kill(pid: number, signal?: string | number): void;

  // Filesystem.
  readFile(path: string | URL): Promise<Uint8Array>;
  readFileSync(path: string | URL): Uint8Array;
  readTextFile(path: string | URL): Promise<string>;
  readTextFileSync(path: string | URL): string;
  writeFile(
    path: string | URL,
    data: Uint8Array | string,
    options?: WriteFileOptions,
  ): Promise<void>;
  writeFileSync(
    path: string | URL,
    data: Uint8Array | string,
    options?: WriteFileOptions,
  ): void;
  writeTextFile(
    path: string | URL,
    data: string,
    options?: WriteFileOptions,
  ): Promise<void>;
  writeTextFileSync(
    path: string | URL,
    data: string,
    options?: WriteFileOptions,
  ): void;
  stat(path: string | URL): Promise<FileInfo>;
  statSync(path: string | URL): FileInfo;
  lstat(path: string | URL): Promise<FileInfo>;
  lstatSync(path: string | URL): FileInfo;
  readDir(path: string | URL): AsyncIterable<DirEntry>;
  readDirSync(path: string | URL): Iterable<DirEntry>;
  mkdir(
    path: string | URL,
    options?: { recursive?: boolean; mode?: number },
  ): Promise<void>;
  mkdirSync(
    path: string | URL,
    options?: { recursive?: boolean; mode?: number },
  ): void;
  remove(path: string | URL, options?: { recursive?: boolean }): Promise<void>;
  removeSync(path: string | URL, options?: { recursive?: boolean }): void;
  rename(oldPath: string | URL, newPath: string | URL): Promise<void>;
  renameSync(oldPath: string | URL, newPath: string | URL): void;
  copyFile(from: string | URL, to: string | URL): Promise<void>;
  copyFileSync(from: string | URL, to: string | URL): void;
  realPath(path: string | URL): Promise<string>;
  realPathSync(path: string | URL): string;
  chmod(path: string | URL, mode: number): Promise<void>;
  chmodSync(path: string | URL, mode: number): void;
  link(oldPath: string | URL, newPath: string | URL): Promise<void>;
  symlink(
    oldPath: string | URL,
    newPath: string | URL,
    options?: { type?: "file" | "dir" | "junction" },
  ): Promise<void>;
  symlinkSync(
    oldPath: string | URL,
    newPath: string | URL,
    options?: { type?: "file" | "dir" | "junction" },
  ): void;
  utime(
    path: string | URL,
    atime: number | Date,
    mtime: number | Date,
  ): Promise<void>;
  utimeSync(
    path: string | URL,
    atime: number | Date,
    mtime: number | Date,
  ): void;
  makeTempDir(options?: MakeTempOptions): Promise<string>;
  makeTempDirSync(options?: MakeTempOptions): string;
  makeTempFile(options?: MakeTempOptions): Promise<string>;
  makeTempFileSync(options?: MakeTempOptions): string;
  open(path: string | URL, options?: OpenOptions): Promise<FsFile>;
  openSync(path: string | URL, options?: OpenOptions): FsFile;

  // Process spawning.
  Command: CommandConstructor;

  // Networking.
  serve: ServeFunction;
  listen(options: ListenOptions): Listener;
  connect(options: ConnectOptions): Promise<Conn>;
  createHttpClient(options: {
    proxy?: unknown;
    caCerts?: string[];
    cert?: string;
    key?: string;
  }): HttpClient;
  upgradeWebSocket(request: Request): { socket: WebSocket; response: Response };
  resolveDns(hostname: string, options?: unknown): Promise<string[]>;

  SeekMode: typeof SeekMode;
}

// ─── Instance ───────────────────────────────────────────────────────────────

/**
 * The merged runtime. `runtimeNet` wins ties so its richer `Command`, `serve`,
 * `makeTemp*`, and `exit` replace the base definitions.
 */
export const runtime: Runtime = {
  ...runtimeCore,
  ...runtimeNet,
} as unknown as Runtime;

// Named re-exports so `import * as runtime` exposes each member (and its type)
// under the same namespace.
export const args = runtime.args;
export const build = runtime.build;
export const env = runtime.env;
export const errors = errorClasses;
export const version = runtime.version;
export const pid = runtime.pid;
export const stdout = runtime.stdout;
export const stderr = runtime.stderr;
export const stdin = runtime.stdin;
export const cwd = runtime.cwd;
export const chdir = runtime.chdir;
export const exit = runtime.exit;
export const execPath = runtime.execPath;
export const hostname = runtime.hostname;
export const consoleSize = runtime.consoleSize;
export const unrefTimer = runtime.unrefTimer;
export const refTimer = runtime.refTimer;
export const addSignalListener = runtime.addSignalListener;
export const removeSignalListener = runtime.removeSignalListener;
export const kill = runtime.kill;
export const readFile = runtime.readFile;
export const readFileSync = runtime.readFileSync;
export const readTextFile = runtime.readTextFile;
export const readTextFileSync = runtime.readTextFileSync;
export const writeFile = runtime.writeFile;
export const writeFileSync = runtime.writeFileSync;
export const writeTextFile = runtime.writeTextFile;
export const writeTextFileSync = runtime.writeTextFileSync;
export const stat = runtime.stat;
export const statSync = runtime.statSync;
export const lstat = runtime.lstat;
export const lstatSync = runtime.lstatSync;
export const readDir = runtime.readDir;
export const readDirSync = runtime.readDirSync;
export const mkdir = runtime.mkdir;
export const mkdirSync = runtime.mkdirSync;
export const remove = runtime.remove;
export const removeSync = runtime.removeSync;
export const rename = runtime.rename;
export const renameSync = runtime.renameSync;
export const copyFile = runtime.copyFile;
export const copyFileSync = runtime.copyFileSync;
export const realPath = runtime.realPath;
export const realPathSync = runtime.realPathSync;
export const chmod = runtime.chmod;
export const chmodSync = runtime.chmodSync;
export const link = runtime.link;
export const symlink = runtime.symlink;
export const symlinkSync = runtime.symlinkSync;
export const utime = runtime.utime;
export const utimeSync = runtime.utimeSync;
export const makeTempDir = runtime.makeTempDir;
export const makeTempDirSync = runtime.makeTempDirSync;
export const makeTempFile = runtime.makeTempFile;
export const makeTempFileSync = runtime.makeTempFileSync;
export const open = runtime.open;
export const openSync = runtime.openSync;
export const Command = runtime.Command;
export const serve = runtime.serve;
export const listen = runtime.listen;
export const connect = runtime.connect;
export const createHttpClient = runtime.createHttpClient;
export const upgradeWebSocket = runtime.upgradeWebSocket;
export const resolveDns = runtime.resolveDns;

installWorkerGlobal();
