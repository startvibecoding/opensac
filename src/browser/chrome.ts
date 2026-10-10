// (v0.1.5).
//
// Handles launching and managing Chrome/Chromium-based browsers plus CDP URL
// discovery. Supports Chrome, Chromium, Brave, Edge, and variants.
//
// Deviations from Go: `os/exec` maps to `runtime.Command`; `net/http` maps to
// `fetch`; `context.Context` maps to `AbortSignal`; `log/slog` logging is
// dropped (callers can observe errors); process-group handling is omitted
// because `runtime.Command` children are detached enough for our use.

import { runtime } from "../platform/runtime.ts";
import type { ChildProcess } from "../platform/runtime.ts";
import { type BrowserType, type LaunchOptions } from "./protocol.ts";

/** DEFAULT_CDP_PORT is the default Chrome DevTools Protocol port. */
export const DEFAULT_CDP_PORT = 9222;
/** ALTERNATE_CDP_PORT is the fallback port for CDP. */
export const ALTERNATE_CDP_PORT = 9229;
/** DEFAULT_VIEWPORT_WIDTH is the default browser window width. */
export const DEFAULT_VIEWPORT_WIDTH = 1920;
/** DEFAULT_VIEWPORT_HEIGHT is the default browser window height. */
export const DEFAULT_VIEWPORT_HEIGHT = 1080;

/** A running browser process. */
export class Process {
  #child: ChildProcess;
  browser: BrowserType;
  executable: string;
  userDataDir: string;
  cdpUrl: string;
  remotePort: number;
  pid: number;
  #killed = false;

  constructor(init: {
    child: ChildProcess;
    browser: BrowserType;
    executable: string;
    userDataDir: string;
    cdpUrl: string;
    remotePort: number;
    pid: number;
  }) {
    this.#child = init.child;
    this.browser = init.browser;
    this.executable = init.executable;
    this.userDataDir = init.userDataDir;
    this.cdpUrl = init.cdpUrl;
    this.remotePort = init.remotePort;
    this.pid = init.pid;
  }

  /** CDPWebSocketURL returns the browser-level DevTools WebSocket URL. */
  cdpWebSocketUrl(): string {
    return this.cdpUrl;
  }

  /** Terminates the browser process and cleans up its temp profile. */
  kill(): void {
    if (this.#killed) return;
    this.#killed = true;
    try {
      this.#child.kill("SIGKILL");
    } catch {
      // ignore
    }
    if (this.userDataDir && this.userDataDir.includes("vibe-browser-")) {
      try {
        runtime.removeSync(this.userDataDir, { recursive: true });
      } catch {
        // ignore
      }
    }
  }
}

function getBrowserCandidates(browserType: BrowserType): string[] {
  const t = browserType || "chrome";
  switch (runtime.build.os) {
    case "darwin":
      return darwinCandidates(t);
    case "linux":
      return linuxCandidates(t);
    case "windows":
      return windowsCandidates(t);
    default:
      return [t];
  }
}

function darwinCandidates(t: string): string[] {
  switch (t) {
    case "chrome":
      return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "google-chrome",
      ];
    case "chrome-canary":
      return [
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      ];
    case "chromium":
      return ["/Applications/Chromium.app/Contents/MacOS/Chromium", "chromium"];
    case "brave":
      return [
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "brave-browser",
      ];
    case "edge":
      return ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];
    default:
      return [];
  }
}

function linuxCandidates(t: string): string[] {
  switch (t) {
    case "chrome":
      return [
        "google-chrome",
        "google-chrome-stable",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/opt/google/chrome/chrome",
      ];
    case "chromium":
      return [
        "chromium-browser",
        "chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        "/snap/bin/chromium",
      ];
    case "brave":
      return [
        "brave-browser",
        "brave-browser-stable",
        "/usr/bin/brave-browser",
      ];
    case "edge":
      return [
        "microsoft-edge",
        "microsoft-edge-stable",
        "/usr/bin/microsoft-edge",
      ];
    default:
      return [];
  }
}

function windowsCandidates(t: string): string[] {
  const local = runtime.env.get("LOCALAPPDATA") ?? "";
  const progFiles = runtime.env.get("PROGRAMFILES") ?? "";
  const progFilesX86 = runtime.env.get("PROGRAMFILES(X86)") ?? "";
  switch (t) {
    case "chrome": {
      const candidates = [
        join(progFiles, "Google/Chrome/Application/chrome.exe"),
        join(progFilesX86, "Google/Chrome/Application/chrome.exe"),
      ];
      if (local) {
        candidates.push(join(local, "Google/Chrome/Application/chrome.exe"));
      }
      return candidates;
    }
    case "chromium": {
      const candidates = [join(progFiles, "Chromium/Application/chrome.exe")];
      if (local) {
        candidates.push(join(local, "Chromium/Application/chrome.exe"));
      }
      return candidates;
    }
    case "brave": {
      const candidates: string[] = [];
      if (local) {
        candidates.push(
          join(local, "BraveSoftware/Brave-Browser/Application/brave.exe"),
        );
      }
      return candidates;
    }
    case "edge":
      return [
        join(progFiles, "Microsoft/Edge/Application/msedge.exe"),
        join(progFilesX86, "Microsoft/Edge/Application/msedge.exe"),
      ];
    default:
      return [];
  }
}

function join(...parts: string[]): string {
  return parts
    .filter((p) => p !== "")
    .join("/")
    .replace(/\/+/g, "/");
}

function isExecutable(p: string): boolean {
  if (p.includes("/") || p.includes("\\")) {
    try {
      return runtime.statSync(p).isFile;
    } catch {
      return false;
    }
  }
  const pathEnv = runtime.env.get("PATH") ?? "";
  const sep = runtime.build.os === "windows" ? ";" : ":";
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    try {
      if (runtime.statSync(`${dir}/${p}`).isFile) return true;
    } catch {
      // continue
    }
  }
  return false;
}

/** Finds a browser executable for the given type. */
export function findBrowser(browserType: BrowserType): string {
  const t = browserType || "chrome";
  for (const candidate of getBrowserCandidates(t)) {
    if (isExecutable(candidate)) return candidate;
  }
  throw new Error(`${t} not found; install it or use --executable-path`);
}

/** Extracts the host and port from a browser-level WebSocket URL. */
export function extractHostPort(wsUrl: string): { host: string; port: number } {
  let url = wsUrl;
  if (url.startsWith("ws://")) url = url.slice(5);
  else if (url.startsWith("wss://")) url = url.slice(6);
  const slash = url.indexOf("/");
  const hostPort = slash >= 0 ? url.slice(0, slash) : url;
  const colon = hostPort.indexOf(":");
  let port = DEFAULT_CDP_PORT;
  let host = hostPort;
  if (colon >= 0) {
    host = hostPort.slice(0, colon);
    const parsed = Number.parseInt(hostPort.slice(colon + 1), 10);
    if (!Number.isNaN(parsed)) port = parsed;
  }
  return { host, port };
}

function rewriteWsHost(wsUrl: string, host: string, port: number): string {
  if (wsUrl.startsWith("ws://")) {
    const parts = wsUrl.slice(5).split(/\/(.*)/s);
    if (parts.length >= 2) return `ws://${host}:${port}/${parts[1]}`;
  }
  if (wsUrl.startsWith("wss://")) {
    const parts = wsUrl.slice(6).split(/\/(.*)/s);
    if (parts.length >= 2) return `wss://${host}:${port}/${parts[1]}`;
  }
  return wsUrl;
}

async function fetchJson(url: string, timeoutMs = 2000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (resp.status !== 200) {
      throw new Error(`unexpected status: ${resp.status}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Discovers a running browser's CDP WebSocket URL. */
export async function discoverCdpUrl(
  hostIn: string,
  portIn: number,
): Promise<string> {
  const host = hostIn || "127.0.0.1";
  const port = portIn || DEFAULT_CDP_PORT;

  try {
    const info = (await fetchJson(`http://${host}:${port}/json/version`)) as {
      webSocketDebuggerUrl?: string;
    };
    if (info.webSocketDebuggerUrl) {
      return rewriteWsHost(info.webSocketDebuggerUrl, host, port);
    }
  } catch {
    // fall through to /json/list
  }

  try {
    const targets = (await fetchJson(
      `http://${host}:${port}/json/list`,
    )) as Array<{
      type?: string;
      webSocketDebuggerUrl?: string;
    }>;
    for (const t of targets) {
      if (t.type === "browser" && t.webSocketDebuggerUrl) {
        return rewriteWsHost(t.webSocketDebuggerUrl, host, port);
      }
    }
    for (const t of targets) {
      if (t.webSocketDebuggerUrl) {
        return rewriteWsHost(t.webSocketDebuggerUrl, host, port);
      }
    }
  } catch {
    // fall through
  }

  throw new Error(
    `no browser found on ${host}:${port} (is Chrome running with --remote-debugging-port=${port}?)`,
  );
}

/** Tries to find a running browser on the common CDP ports. */
export async function autoConnectCdp(): Promise<string> {
  for (const port of [DEFAULT_CDP_PORT, ALTERNATE_CDP_PORT]) {
    try {
      return await discoverCdpUrl("127.0.0.1", port);
    } catch {
      // try next
    }
  }
  throw new Error(
    `no running browser found; launch Chrome with --remote-debugging-port=${DEFAULT_CDP_PORT} or use --cdp-url`,
  );
}

async function waitForCdp(
  hostIn: string,
  port: number,
  signal?: AbortSignal,
): Promise<string> {
  const host = hostIn || "127.0.0.1";
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await discoverCdpUrl(host, port);
    } catch {
      // retry
    }
    await delay(100, signal);
  }
  throw new Error(`CDP not available after 30s on ${host}:${port}`);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Launches a browser process and returns its CDP URL. */
export async function launch(
  opts: LaunchOptions,
  signal?: AbortSignal,
): Promise<Process> {
  const execPath = opts.executablePath || findBrowser(opts.browser ?? "");
  const port = DEFAULT_CDP_PORT;
  const remoteAddr = "127.0.0.1";

  let userDataDir = opts.userDataDir ?? "";
  if (!userDataDir) {
    userDataDir = runtime.makeTempDirSync({ prefix: "vibe-browser-" });
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--remote-debugging-address=${remoteAddr}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-client-side-phishing-detection",
    "--disable-default-apps",
    "--disable-hang-monitor",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-sync",
    "--disable-translate",
    "--metrics-recording-only",
    "--safebrowsing-disable-auto-update",
  ];

  if (opts.headless !== false) args.push("--headless=new");
  if (opts.proxy) args.push(`--proxy-server=${opts.proxy}`);

  const viewportWidth =
    opts.viewportWidth && opts.viewportWidth > 0
      ? opts.viewportWidth
      : DEFAULT_VIEWPORT_WIDTH;
  const viewportHeight =
    opts.viewportHeight && opts.viewportHeight > 0
      ? opts.viewportHeight
      : DEFAULT_VIEWPORT_HEIGHT;
  args.push(`--window-size=${viewportWidth},${viewportHeight}`);

  if (opts.extensions && opts.extensions.length > 0) {
    args.push(`--disable-extensions-except=${opts.extensions.join(",")}`);
    args.push(`--load-extension=${opts.extensions.join(",")}`);
  } else {
    args.push("--disable-extensions");
  }

  if (opts.profile) args.push(`--profile-directory=${opts.profile}`);
  if (opts.args) args.push(...opts.args);

  const command = new runtime.Command(execPath, {
    args,
    stdout: "null",
    stderr: "null",
    stdin: "null",
  });
  const child = command.spawn();

  let cdpUrl: string;
  try {
    cdpUrl = await waitForCdp(remoteAddr, port, signal);
  } catch (err) {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    throw new Error(`wait for CDP: ${err}`);
  }

  return new Process({
    child,
    browser: opts.browser ?? "",
    executable: execPath,
    userDataDir,
    cdpUrl,
    remotePort: port,
    pid: child.pid,
  });
}

/** Returns the list of available DevTools targets. */
export async function listTargets(
  hostIn: string,
  port: number,
): Promise<
  Array<{
    id: string;
    type: string;
    title?: string;
    url?: string;
    webSocketDebuggerUrl?: string;
  }>
> {
  const host = hostIn || "127.0.0.1";
  return (await fetchJson(`http://${host}:${port}/json/list`)) as Array<{
    id: string;
    type: string;
    title?: string;
    url?: string;
    webSocketDebuggerUrl?: string;
  }>;
}

/** Returns the browser version information from the DevTools endpoint. */
export async function getBrowserVersion(
  hostIn: string,
  port: number,
): Promise<Record<string, unknown>> {
  const host = hostIn || "127.0.0.1";
  return (await fetchJson(`http://${host}:${port}/json/version`)) as Record<
    string,
    unknown
  >;
}
