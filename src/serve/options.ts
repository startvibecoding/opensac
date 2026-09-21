// Ported from internal/serve/run.go (the option/override surface consumed by
// the serve runtime before the HTTP layer starts). The HTTP server itself
// lands in later #36 slices; this module owns the pure flag→config mapping so
// tests and the `serve` CLI command share one source of truth.

import * as path from "@std/path";
import { normalizeServeConfig, type ServeConfig } from "./config.ts";

/** CLI/process options for `mothx serve` (ports serve.RunOptions). */
export interface RunOptions {
  configPath: string;
  port: string;
  webUIDir: string;
  provider: string;
  model: string;
  workDir: string;
  unsafe: boolean;
  sandbox: boolean;
  multiAgent: boolean;
  delegate: boolean;
  workflows: boolean;
  webSearch: boolean;
  browser: boolean;
  artifact: boolean;
  a2aMaster: boolean;
  lobster: boolean;
  verbose: boolean;
  debug: boolean;
  /** Go RunOptions.Shutdown: external graceful-termination request. */
  shutdown?: AbortSignal;
  /** Go RunOptions.OnReady: fired with the assembled API server + dispatcher. */
  onReady?: (
    server: import("./openaiapi/server.ts").Server,
    dispatcher: import("./channels/mod.ts").Dispatcher | null,
  ) => void;
}

export function defaultRunOptions(): RunOptions {
  return {
    configPath: "",
    port: "",
    webUIDir: "",
    provider: "",
    model: "",
    workDir: "",
    unsafe: false,
    sandbox: false,
    multiAgent: false,
    delegate: false,
    workflows: false,
    webSearch: false,
    browser: false,
    artifact: false,
    a2aMaster: false,
    lobster: false,
    verbose: false,
    debug: false,
  };
}

/** Human-friendly listen address for startup banners (`:7872` → `127.0.0.1:7872`). */
export function displayListenAddr(addr: string): string {
  return addr.startsWith(":") ? `127.0.0.1${addr}` : addr;
}

/** Normalizes a --port override into a listen address (`7872`, `:7872`, host:port). */
export function listenFromPortOverride(port: string): string {
  const trimmed = port.trim();
  if (trimmed === "") return "";
  if (trimmed.startsWith(":") || trimmed.includes(":")) return trimmed;
  return `:${trimmed}`;
}

const DEFAULT_WEB_UI_DIR = "ui/dist";

/** Reports whether dir selects the embedded frontend (`""` or `ui/dist`). */
export function useEmbeddedWebUI(dir: string): boolean {
  if (dir === "") return true;
  const normalized = path.normalize(dir).replaceAll("\\", "/");
  return normalized === DEFAULT_WEB_UI_DIR;
}

/**
 * Rewrites loopback/empty listen addresses onto all interfaces. Port of
 * openaiapi/config.go `unsafeListenAddr` + `shouldUnsafeBindAll`.
 */
export function unsafeListenAddr(listen: string): string {
  const trimmed = listen.trim();
  if (trimmed === "") return "0.0.0.0:7872";
  const lastColon = trimmed.lastIndexOf(":");
  if (trimmed.startsWith(":")) return `0.0.0.0${trimmed}`;
  let host: string;
  let port: string;
  if (lastColon === -1) {
    host = trimmed;
    port = "";
  } else {
    host = trimmed.slice(0, lastColon);
    port = trimmed.slice(lastColon + 1);
  }
  if (shouldUnsafeBindAll(host)) {
    return port === "" ? `0.0.0.0:${host}` : `0.0.0.0:${port}`;
  }
  return trimmed;
}

function shouldUnsafeBindAll(host: string): boolean {
  if (host === "" || host.toLowerCase() === "localhost") return true;
  const ip = parseIPv4(host);
  if (ip !== undefined) {
    // 127.0.0.0/8 loopback
    return ip[0] === 127;
  }
  // IPv6 loopback ::1
  if (host === "[::1]" || host === "::1") return true;
  return false;
}

function parseIPv4(
  value: string,
): [number, number, number, number] | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined;
    const n = Number(part);
    if (n < 0 || n > 255) return undefined;
    octets.push(n);
  }
  return [octets[0], octets[1], octets[2], octets[3]];
}

/** Disables auth and binds all interfaces (openaiapi APIConfig.ApplyUnsafeAccess). */
export function applyUnsafeAccess(cfg: ServeConfig): void {
  cfg.api.auth.enabled = false;
  cfg.api.auth.tokens = [];
  cfg.api.listen = unsafeListenAddr(cfg.api.listen);
}

/** Projects feature flags onto the concrete subsystems they gate. */
export function applyRuntimeFeatures(cfg: ServeConfig): void {
  cfg.webUI.enabled = cfg.features.webUI;
  cfg.api.enableSubAgents = cfg.features.multiAgent;
  cfg.channels.wechat.enabled = cfg.features.wechat;
  cfg.channels.feishu.enabled = cfg.features.feishu;
  cfg.cron.enabled = cfg.features.cron;
  cfg.memory.enabled = cfg.features.memory;
}

/**
 * Applies ephemeral CLI/process overrides to an effective config. Mirrors
 * `applyOverrides`: the writable layer is never mutated with these values.
 */
export function applyOverrides(cfg: ServeConfig, opts: RunOptions): void {
  if (opts.port !== "") {
    cfg.api.listen = listenFromPortOverride(opts.port);
  }
  if (opts.webUIDir !== "") {
    let webUIDir = opts.webUIDir;
    if (!useEmbeddedWebUI(webUIDir)) {
      try {
        webUIDir = path.resolve(webUIDir);
      } catch {
        // keep the supplied relative path
      }
    }
    cfg.webUI.dir = webUIDir;
    cfg.webUI.enabled = true;
    cfg.features.webUI = true;
  }
  if (opts.workDir !== "") {
    cfg.api.defaultWorkDir = opts.workDir;
    cfg.api.workingDir = "";
  }
  if (opts.unsafe) applyUnsafeAccess(cfg);
  if (opts.provider !== "") cfg.api.provider = opts.provider;
  if (opts.model !== "") cfg.api.model = opts.model;
  if (opts.sandbox) cfg.api.sandbox.enabled = true;
  if (opts.multiAgent) {
    cfg.api.enableSubAgents = true;
    cfg.features.multiAgent = true;
  }
  if (opts.delegate) cfg.api.enableDelegate = true;
  if (opts.workflows) cfg.api.enableWorkflows = true;
  if (opts.webSearch) cfg.api.enableWebSearch = true;
  if (opts.artifact) cfg.api.enableArtifact = true;
  if (opts.browser) cfg.api.enableBrowser = true;
  if (opts.a2aMaster) cfg.api.enableA2AMaster = true;
  if (opts.lobster) cfg.lobsterMode = true;
  normalizeServeConfig(cfg);
}
