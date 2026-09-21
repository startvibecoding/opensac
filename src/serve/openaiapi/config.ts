// Ported from internal/serve/openaiapi/config.go (the OpenAI-compatible API
// configuration). Go's `net.ParseIP().IsLoopback()` maps to a small loopback
// parser (IPv4 127/8 and "::1"); `*[]string` allowedWorkDirs maps to
// `string[] | undefined` (undefined = no check, [] = deny all).

import { join, relative } from "@std/path";
import { resolvePathWithExistingSymlinks } from "../../util/path.ts";

/** AuthConfig controls bearer token authentication. */
export interface AuthConfig {
  enabled: boolean;
  tokens?: string[];
}

/** SandboxConfig controls sandbox behavior for API requests. */
export interface SandboxConfig {
  enabled: boolean;
  /** "none", "standard", "strict"; empty = auto from mode. */
  level?: string;
}

/** SessionConfig controls session pool behavior. */
export interface SessionConfig {
  idleTimeoutSeconds?: number;
  maxSessions?: number;
}

/** CORSConfig controls cross-origin resource sharing. */
export interface CORSConfig {
  enabled: boolean;
  allowOrigins?: string[];
}

/**
 * ToolVisibilityConfig controls how tool calls are exposed to the client.
 * mode: "content" (default) mixes tool output into the content stream,
 * "sse_event" emits separate SSE events, "none" sends no tool output.
 * detail: "collapsed" (default) or "expanded".
 */
export interface ToolVisibilityConfig {
  mode?: string;
  detail?: string;
}

/** Config holds the OpenAI-compatible API configuration used by serve. */
export interface Config {
  listen?: string;
  auth?: AuthConfig;
  defaultMode?: string;
  defaultThinkingLevel?: string;
  enableSubAgents?: boolean;
  enableDelegate?: boolean;
  enableWorkflows?: boolean;
  enableWebSearch?: boolean;
  enableBrowser?: boolean;
  enableArtifact?: boolean;
  enableA2AMaster?: boolean;
  sandbox?: SandboxConfig;
  /** undefined = no check, [] = deny all overrides. */
  allowedWorkDirs?: string[];
  session?: SessionConfig;
  defaultWorkDir?: string;
  /** legacy alias for defaultWorkDir */
  workingDir?: string;
  cors?: CORSConfig;
  provider?: string;
  model?: string;
  toolVisibility?: ToolVisibilityConfig;
  /** "append" (default), "ignore" */
  systemPromptMode?: string;
  requestTimeoutSecs?: number;
  /** hard cap for durable background polling (default 57600). */
  backgroundRunMaxSecs?: number;
  maxConcurrentReqs?: number;
  logLevel?: string;
}

/** DefaultConfig returns the default OpenAI-compatible API configuration. */
export function defaultConfig(): Config {
  return {
    listen: "127.0.0.1:7872",
    auth: { enabled: false },
    defaultMode: "yolo",
    defaultThinkingLevel: "medium",
    enableSubAgents: false,
    enableDelegate: false,
    enableWorkflows: false,
    sandbox: { enabled: false },
    session: { idleTimeoutSeconds: 1800 },
    cors: { enabled: false, allowOrigins: ["*"] },
    toolVisibility: { mode: "content", detail: "collapsed" },
    systemPromptMode: "append",
    requestTimeoutSecs: 1800,
    logLevel: "info",
  };
}

export function cloneConfig(cfg: Config | null): Config | null {
  if (cfg === null) return null;
  const clone: Config = { ...cfg };
  clone.auth = cfg.auth === undefined ? undefined : {
    ...cfg.auth,
    tokens: cfg.auth.tokens ? [...cfg.auth.tokens] : undefined,
  };
  clone.cors = cfg.cors === undefined ? undefined : {
    ...cfg.cors,
    allowOrigins: cfg.cors.allowOrigins
      ? [...cfg.cors.allowOrigins]
      : undefined,
  };
  if (cfg.allowedWorkDirs !== undefined) {
    clone.allowedWorkDirs = [...cfg.allowedWorkDirs];
  }
  return clone;
}

/** normalizeConfig fills in defaults for empty fields (in place, like Go). */
export function normalizeConfig(cfg: Config): void {
  if (cfg.listen === undefined || cfg.listen === "") {
    cfg.listen = "127.0.0.1:7872";
  }
  if (cfg.defaultMode === undefined || cfg.defaultMode === "") {
    cfg.defaultMode = "yolo";
  }
  cfg.toolVisibility ??= {};
  if (cfg.toolVisibility.mode === undefined || cfg.toolVisibility.mode === "") {
    cfg.toolVisibility.mode = "content";
  }
  if (
    cfg.toolVisibility.detail === undefined || cfg.toolVisibility.detail === ""
  ) {
    cfg.toolVisibility.detail = "collapsed";
  }
  if (cfg.systemPromptMode === undefined || cfg.systemPromptMode === "") {
    cfg.systemPromptMode = "append";
  }
  if (cfg.requestTimeoutSecs === undefined || cfg.requestTimeoutSecs <= 0) {
    cfg.requestTimeoutSecs = 1800;
  }
}

export function validateListenSecurity(
  cfg: Config | null,
  unsafe: boolean,
): void {
  if (cfg === null || unsafe || isLoopbackListen(getListenAddr(cfg))) return;
  const enabled = cfg.auth?.enabled ?? false;
  const tokens = cfg.auth?.tokens?.length ?? 0;
  if (!enabled || tokens === 0) {
    throw new Error(
      `public listen address "${
        getListenAddr(cfg)
      }" requires at least one configured API token; use --unsafe to override`,
    );
  }
}

export function isLoopbackListen(addr: string): boolean {
  const host = splitHostPort(addr.trim())?.host;
  if (host === undefined) return false;
  if (host.toLowerCase() === "localhost") return true;
  return isLoopbackIP(host);
}

/**
 * Parses a host/port pair with Go net.SplitHostPort's bracket rules. Returns
 * undefined on Go's error shapes (no port, too many colons).
 */
export function splitHostPort(
  addr: string,
): { host: string; port: string } | undefined {
  if (addr === "") return undefined;
  if (addr.startsWith("[")) {
    const end = addr.indexOf("]");
    if (end < 0) return undefined;
    const host = addr.slice(1, end);
    const rest = addr.slice(end + 1);
    if (!rest.startsWith(":")) return undefined;
    return { host, port: rest.slice(1) };
  }
  const first = addr.indexOf(":");
  const last = addr.lastIndexOf(":");
  if (first < 0) return undefined;
  if (first !== last) return undefined;
  return { host: addr.slice(0, first), port: addr.slice(first + 1) };
}

function isLoopbackIP(host: string): boolean {
  if (host === "::1") return true;
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match === null) return false;
  return match.slice(1).every((group) => {
    const value = Number(group);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

/** Returns the effective listen address. */
export function getListenAddr(cfg: Config): string {
  if (cfg.listen !== undefined && cfg.listen !== "") return cfg.listen;
  return "127.0.0.1:7872";
}

/** Returns the effective working directory. */
export function getWorkDir(cfg: Config): string {
  let workDir = cfg.defaultWorkDir ?? "";
  if (workDir === "") workDir = cfg.workingDir ?? "";
  if (workDir !== "") {
    if (workDir.startsWith("~")) {
      const home = userHomeDir();
      if (home !== "") return join(home, workDir.slice(1));
    }
    return workDir;
  }
  return Deno.cwd();
}

function userHomeDir(): string {
  return Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
}

/** Returns the effective tool detail level. */
export function getToolDetail(cfg: Config): string {
  const detail = cfg.toolVisibility?.detail;
  if (detail !== undefined && detail !== "") return detail;
  return "collapsed";
}

/**
 * Disables API auth and exposes loopback/default listens on all interfaces.
 * `applyUnsafeAccess` mutates in place exactly like the Go method.
 */
export function applyUnsafeAccess(cfg: Config | null): void {
  if (cfg === null) return;
  cfg.auth = { enabled: false };
  cfg.listen = unsafeListenAddr(getListenAddr(cfg));
}

export function unsafeListenAddr(listen: string): string {
  listen = listen.trim();
  if (listen === "") listen = "127.0.0.1:7872";
  const split = splitHostPort(listen);
  if (split === undefined) {
    if (listen.startsWith(":")) return "0.0.0.0" + listen;
    if (!listen.includes(":")) return `0.0.0.0:${listen}`;
    return listen;
  }
  if (shouldUnsafeBindAll(split.host)) {
    return `0.0.0.0:${split.port}`;
  }
  return listen;
}

function shouldUnsafeBindAll(host: string): boolean {
  if (host === "" || host.toLowerCase() === "localhost") return true;
  return isLoopbackIP(host);
}

/**
 * Checks if the given directory is allowed by the allowedWorkDirs whitelist.
 * Throws with Go's message when the directory is not allowed. Async because
 * the symlink-resolving path check is async in Deno.
 */
export async function validateWorkDir(cfg: Config, dir: string): Promise<void> {
  // undefined AllowedWorkDirs = no restriction
  if (cfg.allowedWorkDirs === undefined) return;
  const allowed = cfg.allowedWorkDirs;
  // empty list = deny all overrides
  if (allowed.length === 0) {
    throw new Error("x_working_dir overrides are disabled");
  }

  const resolvedDir = await resolveDir(
    dir,
    `resolve directory ${JSON.stringify(dir)}`,
  );
  for (const a of allowed) {
    const resolvedAllowed = await resolveDir(
      a,
      `resolve allowedWorkDirs entry ${JSON.stringify(a)}`,
    );
    if (resolvedDir === resolvedAllowed) return;
    const rel = relative(resolvedAllowed, resolvedDir);
    if (rel !== ".." && !rel.startsWith(".." + "/")) return;
  }
  throw new Error(`directory ${JSON.stringify(dir)} is not in allowedWorkDirs`);
}

async function resolveDir(dir: string, wrap: string): Promise<string> {
  try {
    return await resolvePathWithExistingSymlinks(dir);
  } catch (err) {
    throw new Error(`${wrap}: ${(err as Error).message}`);
  }
}
