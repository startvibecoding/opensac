// Ported from vibe-browser pkg/client/client.go (v0.1.5).
//
// The high-level SDK entry point. It supports two modes:
//   - Direct mode: connects directly to a browser via CDP (or launches one)
//   - Daemon mode: communicates with a vibe-browser daemon over a Unix socket
//
// Deviations from Go: `context.Context` maps to `AbortSignal`; `net.Dial` maps
// to `Deno.connect({transport:"unix"})`; `log/slog` logging is dropped;
// `os.FindProcess` liveness probing falls back to a Linux `/proc` check
// because Deno exposes no portable signal-0 probe.

import { Browser } from "./ops.ts";
import { discoverCdpUrl, launch } from "./chrome.ts";
import type {
  Cookie,
  HTMLOptions,
  LaunchOptions,
  NavigationOptions,
  Response as ProtocolResponse,
  ScreenshotOptions,
  SnapshotOptions,
} from "./protocol.ts";
import type { BrowserType } from "./protocol.ts";

/** Options configures the client behavior. */
export interface Options {
  /** Session name for daemon mode. If empty, uses "default". */
  session?: string;
  /** CDPURL is the Chrome DevTools Protocol WebSocket URL. */
  cdpUrl?: string;
  /** CDPHost and CDPPort discover CDP from a running Chrome instance. */
  cdpHost?: string;
  cdpPort?: number;
  /** Launch options (used when starting a new browser). */
  launch?: LaunchOptions;
  /** Browser type to launch (chrome, chromium, brave, edge, chrome-canary). */
  browser?: BrowserType;
  /** Headless mode for launched browsers (default true). */
  headless?: boolean;
  /** ExecutablePath is the path to the Chrome executable. */
  executablePath?: string;
  /** DaemonSocketDir overrides the default daemon socket directory. */
  daemonSocketDir?: string;
}

/** The main SDK entry point. */
export class Client {
  #browser: Browser | undefined;
  #daemon: boolean;
  #session: string;
  #socketPath: string;

  private constructor(init: {
    browser?: Browser;
    daemon: boolean;
    session: string;
    socketPath: string;
  }) {
    this.#browser = init.browser;
    this.#daemon = init.daemon;
    this.#session = init.session;
    this.#socketPath = init.socketPath;
  }

  /** Connects directly to a browser via CDP or launches one. */
  static async open(opts?: Options, signal?: AbortSignal): Promise<Client> {
    const o = opts ?? {};
    if (o.cdpUrl) {
      const b = await Browser.connectToCdp(o.cdpUrl, signal);
      return new Client({
        browser: b,
        daemon: false,
        session: "",
        socketPath: "",
      });
    }
    if (o.cdpPort && o.cdpPort > 0) {
      const host = o.cdpHost || "127.0.0.1";
      const cdpUrl = await discoverCdpUrl(host, o.cdpPort);
      const b = await Browser.connectToCdp(cdpUrl, signal);
      return new Client({
        browser: b,
        daemon: false,
        session: "",
        socketPath: "",
      });
    }

    const launchOpts: LaunchOptions = {
      browser: o.browser,
      headless: o.headless,
      executablePath: o.executablePath,
    };
    if (o.launch) {
      launchOpts.browser = o.launch.browser ?? launchOpts.browser;
      launchOpts.headless = o.launch.headless ?? launchOpts.headless;
      launchOpts.executablePath = o.launch.executablePath ??
        launchOpts.executablePath;
      launchOpts.args = o.launch.args;
      launchOpts.proxy = o.launch.proxy;
      launchOpts.userDataDir = o.launch.userDataDir;
      launchOpts.viewportWidth = o.launch.viewportWidth;
      launchOpts.viewportHeight = o.launch.viewportHeight;
      launchOpts.extensions = o.launch.extensions;
      launchOpts.profile = o.launch.profile;
    }
    if (!launchOpts.executablePath && o.executablePath) {
      launchOpts.executablePath = o.executablePath;
    }
    if (!launchOpts.browser && o.browser) launchOpts.browser = o.browser;
    if (!launchOpts.headless && o.headless) launchOpts.headless = o.headless;

    const proc = await launch(launchOpts, signal);
    try {
      const b = await Browser.connectToCdp(proc.cdpUrl, signal);
      b.setProcessKiller(() => proc.kill());
      return new Client({
        browser: b,
        daemon: false,
        session: "",
        socketPath: "",
      });
    } catch (err) {
      proc.kill();
      throw new Error(`client: connect to launched browser: ${err}`);
    }
  }

  /** Connects to a daemon session. */
  static async connect(opts?: Options): Promise<Client> {
    const o = opts ?? {};
    const session = o.session || "default";
    const socketDir = o.daemonSocketDir || getSocketDir();
    const socketPath = `${socketDir}/${session}.sock`;

    if (!isDaemonRunning(socketPath, session, socketDir)) {
      throw new Error(
        `client: daemon not running for session "${session}"; start it with: vibe-browser daemon --session ${session}`,
      );
    }
    const conn = await dialDaemonTimeout(socketPath, 5000);
    conn.close();
    return new Client({ daemon: true, session, socketPath });
  }

  /** Returns the underlying high-level Browser for direct CDP operations. */
  browser(): Browser | undefined {
    return this.#browser;
  }

  async navigate(
    url: string,
    opts?: NavigationOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#daemon) {
      const extra: Record<string, unknown> = { url };
      if (opts?.waitUntil) extra.waitUntil = opts.waitUntil;
      return await this.#daemonExec("navigate", extra, signal);
    }
    return await this.#browser!.navigate(url, opts, signal);
  }

  async url(signal?: AbortSignal): Promise<string> {
    if (this.#daemon) {
      return await this.#daemonValue<string>("get_url", undefined, signal);
    }
    return await this.#browser!.getUrl(signal);
  }

  async title(signal?: AbortSignal): Promise<string> {
    if (this.#daemon) {
      return await this.#daemonValue<string>("get_title", undefined, signal);
    }
    return await this.#browser!.getTitle(signal);
  }

  async click(selector: string, signal?: AbortSignal): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec("click", { selector }, signal);
    }
    return await this.#browser!.click(selector, undefined, signal);
  }

  async clickAt(x: number, y: number, signal?: AbortSignal): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec("click_at", { x, y }, signal);
    }
    return await this.#browser!.clickAt(x, y, undefined, signal);
  }

  async doubleClick(selector: string, signal?: AbortSignal): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec("dblclick", { selector }, signal);
    }
    return await this.#browser!.doubleClick(selector, signal);
  }

  async doubleClickAt(
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec("dblclick_at", { x, y }, signal);
    }
    return await this.#browser!.doubleClickAt(x, y, signal);
  }

  async fill(
    selector: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec("fill", { selector, value }, signal);
    }
    return await this.#browser!.fill(selector, value, signal);
  }

  async type(
    selector: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec(
        "type",
        { selector, text, delay: 50 },
        signal,
      );
    }
    return await this.#browser!.type(selector, text, 50, signal);
  }

  async press(key: string, signal?: AbortSignal): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec("press", { key }, signal);
    }
    return await this.#browser!.press(key, signal);
  }

  async hover(selector: string, signal?: AbortSignal): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec("hover", { selector }, signal);
    }
    return await this.#browser!.hover(selector, signal);
  }

  async moveMouse(x: number, y: number, signal?: AbortSignal): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec("move", { x, y }, signal);
    }
    return await this.#browser!.moveMouse(x, y, signal);
  }

  async drag(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    steps: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec(
        "drag",
        { startX, startY, endX, endY, steps },
        signal,
      );
    }
    return await this.#browser!.drag(startX, startY, endX, endY, steps, signal);
  }

  async scroll(
    deltaX: number,
    deltaY: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec("scroll", { deltaX, deltaY }, signal);
    }
    return await this.#browser!.scroll(deltaX, deltaY, signal);
  }

  async scrollAt(
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec(
        "scroll_at",
        { x, y, deltaX, deltaY },
        signal,
      );
    }
    return await this.#browser!.scrollAt(x, y, deltaX, deltaY, signal);
  }

  async focus(selector: string, signal?: AbortSignal): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec("focus", { selector }, signal);
    }
    return await this.#browser!.focus(selector, signal);
  }

  async check(selector: string, signal?: AbortSignal): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec("check", { selector }, signal);
    }
    return await this.#browser!.check(selector, signal);
  }

  async uncheck(selector: string, signal?: AbortSignal): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec("uncheck", { selector }, signal);
    }
    return await this.#browser!.uncheck(selector, signal);
  }

  async select(
    selector: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec("select", { selector, value }, signal);
    }
    return await this.#browser!.select(selector, value, signal);
  }

  async eval(expression: string, signal?: AbortSignal): Promise<unknown> {
    if (this.#daemon) {
      return await this.#daemonValue<unknown>(
        "eval",
        { expression },
        signal,
      );
    }
    return await this.#browser!.evalJs(expression, signal);
  }

  async getText(selector: string, signal?: AbortSignal): Promise<string> {
    if (this.#daemon) {
      return await this.#daemonValue<string>("get_text", { selector }, signal);
    }
    return await this.#browser!.getText(selector, signal);
  }

  async getHtml(
    selector: string,
    opts?: HTMLOptions,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.#daemon) {
      const extra: Record<string, unknown> = { selector };
      if (opts) {
        if (opts.maxBytes !== undefined) extra.maxBytes = opts.maxBytes;
        if (opts.maxChars !== undefined) extra.maxChars = opts.maxChars;
      }
      return await this.#daemonValue<string>("get_html", extra, signal);
    }
    return await this.#browser!.getHtmlWithOptions(selector, opts, signal);
  }

  async getValue(selector: string, signal?: AbortSignal): Promise<string> {
    if (this.#daemon) {
      return await this.#daemonValue<string>("get_value", { selector }, signal);
    }
    return await this.#browser!.getValue(selector, signal);
  }

  async getAttr(
    selector: string,
    attr: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.#daemon) {
      return await this.#daemonValue<string>(
        "get_attr",
        { selector, attr },
        signal,
      );
    }
    return await this.#browser!.getAttr(selector, attr, signal);
  }

  async isVisible(selector: string, signal?: AbortSignal): Promise<boolean> {
    if (this.#daemon) {
      return await this.#daemonValue<boolean>(
        "is_visible",
        { selector },
        signal,
      );
    }
    return await this.#browser!.isVisible(selector, signal);
  }

  async isEnabled(selector: string, signal?: AbortSignal): Promise<boolean> {
    if (this.#daemon) {
      return await this.#daemonValue<boolean>(
        "is_enabled",
        { selector },
        signal,
      );
    }
    return await this.#browser!.isEnabled(selector, signal);
  }

  async isChecked(selector: string, signal?: AbortSignal): Promise<boolean> {
    if (this.#daemon) {
      return await this.#daemonValue<boolean>(
        "is_checked",
        { selector },
        signal,
      );
    }
    return await this.#browser!.isChecked(selector, signal);
  }

  async snapshot(
    opts?: SnapshotOptions,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.#daemon) {
      const extra: Record<string, unknown> = {};
      if (opts) {
        extra.interactive = opts.interactive ?? false;
        extra.compact = opts.compact ?? false;
        extra.selector = opts.selector ?? "";
        extra.depth = opts.depth ?? 0;
        extra.urls = opts.urls ?? false;
      }
      return await this.#daemonValue<string>("snapshot", extra, signal);
    }
    return await this.#browser!.snapshot(opts, signal);
  }

  async screenshot(
    opts?: ScreenshotOptions,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (this.#daemon) {
      return await this.#daemonScreenshot(opts, signal);
    }
    return await this.#browser!.screenshot(opts, signal);
  }

  async reload(signal?: AbortSignal): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec("reload", undefined, signal);
    }
    return await this.#browser!.reload(signal);
  }

  async back(signal?: AbortSignal): Promise<void> {
    if (this.#daemon) return await this.#daemonExec("back", undefined, signal);
    return await this.#browser!.goBack(signal);
  }

  async forward(signal?: AbortSignal): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec("forward", undefined, signal);
    }
    return await this.#browser!.goForward(signal);
  }

  async waitMs(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.#daemon) return await this.#daemonExec("wait_ms", { ms }, signal);
    return await this.#browser!.waitMs(ms, signal);
  }

  async waitForSelector(
    selector: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec("wait_for_selector", { selector }, signal);
    }
    return await this.#browser!.waitForSelector(selector, 0, signal);
  }

  async waitForText(text: string, signal?: AbortSignal): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec("wait_for_text", { text }, signal);
    }
    return await this.#browser!.waitForText(text, 0, signal);
  }

  async waitForUrl(urlPattern: string, signal?: AbortSignal): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec(
        "wait_for_url",
        { url: urlPattern },
        signal,
      );
    }
    return await this.#browser!.waitForUrl(urlPattern, 0, signal);
  }

  async setViewport(
    width: number,
    height: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec("set_viewport", { width, height }, signal);
    }
    return await this.#browser!.setViewport(width, height, 1.0, signal);
  }

  async setGeolocation(
    lat: number,
    lng: number,
    accuracy: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec(
        "set_geolocation",
        { latitude: lat, longitude: lng, accuracy },
        signal,
      );
    }
    return await this.#browser!.setGeolocation(lat, lng, accuracy, signal);
  }

  async setOffline(offline: boolean, signal?: AbortSignal): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec("set_offline", { offline }, signal);
    }
    return await this.#browser!.setOffline(offline, signal);
  }

  async setHeaders(
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec("set_headers", { headers }, signal);
    }
    return await this.#browser!.setHeaders(headers, signal);
  }

  async getCookies(signal?: AbortSignal): Promise<Cookie[]> {
    if (this.#daemon) {
      return await this.#daemonValue<Cookie[]>(
        "cookies_get",
        undefined,
        signal,
      );
    }
    return await this.#browser!.getCookies(signal);
  }

  async setCookie(cookie: Cookie, signal?: AbortSignal): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec("cookies_set", { cookie }, signal);
    }
    return await this.#browser!.setCookie(cookie, signal);
  }

  async clearCookies(signal?: AbortSignal): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec("cookies_clear", undefined, signal);
    }
    return await this.#browser!.clearCookies(signal);
  }

  async newTab(url: string, signal?: AbortSignal): Promise<string> {
    if (this.#daemon) {
      const result = await this.#daemonCallInto<{ targetId?: string }>(
        "tab_new",
        { url },
        signal,
      );
      return result?.targetId ?? "";
    }
    return await this.#browser!.newTab(url, signal);
  }

  async closeTab(targetId: string, signal?: AbortSignal): Promise<void> {
    if (this.#daemon) {
      return await this.#daemonExec("tab_close", { targetId }, signal);
    }
    return await this.#browser!.closeTab(targetId, signal);
  }

  /** Closes the client connection. */
  close(): void {
    if (this.#daemon) return;
    this.#browser?.close();
    this.#browser = undefined;
  }

  /** Reports whether the connection is alive. */
  async isConnected(): Promise<boolean> {
    if (this.#daemon) {
      try {
        const conn = await dialDaemonTimeout(this.#socketPath, 500);
        conn.close();
        return true;
      } catch {
        return false;
      }
    }
    return this.#browser?.isConnected() ?? false;
  }

  async #daemonExec(
    action: string,
    extra: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#daemonCall(action, extra, signal);
  }

  async #daemonValue<T>(
    action: string,
    extra: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<T> {
    return (await this.#daemonCallInto<T>(action, extra, signal)) as T;
  }

  async #daemonScreenshot(
    opts: ScreenshotOptions | undefined,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const extra: Record<string, unknown> = {};
    if (opts) {
      extra.format = opts.format ?? "";
      extra.quality = opts.quality ?? 0;
      extra.fullPage = opts.fullPage ?? false;
      extra.selector = opts.selector ?? "";
      extra.clipX = opts.clipX ?? 0;
      extra.clipY = opts.clipY ?? 0;
      extra.clipWidth = opts.clipWidth ?? 0;
      extra.clipHeight = opts.clipHeight ?? 0;
    }
    const result = await this.#daemonCallInto<{ data?: string | number[] }>(
      "screenshot",
      extra,
      signal,
    );
    return decodeDaemonBytes(result?.data);
  }

  async #daemonCallInto<T>(
    action: string,
    extra: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    const resp = await this.#daemonCall(action, extra, signal);
    if (resp.data === undefined || resp.data === null) return undefined;
    return resp.data as T;
  }

  async #daemonCall(
    action: string,
    extra: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<ProtocolResponse> {
    if (!this.#daemon || !this.#socketPath) {
      throw new Error("client: not connected to daemon");
    }
    const conn = await dialDaemon(signal, this.#socketPath);
    try {
      const resp = await this.#daemonSend(conn, action, extra, signal);
      if (!resp.success) {
        const msg = resp.error || "daemon command failed";
        throw new Error(`client: daemon ${action}: ${msg}`);
      }
      return resp;
    } finally {
      conn.close();
    }
  }

  async #daemonSend(
    conn: Deno.Conn,
    action: string,
    extra: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<ProtocolResponse> {
    const req: Record<string, unknown> = {
      id: `r${Date.now() % 1000000}`,
      action,
    };
    if (extra) { for (const [k, v] of Object.entries(extra)) req[k] = v; }

    await conn.write(new TextEncoder().encode(JSON.stringify(req) + "\n"));

    const decoder = new TextDecoder();
    let buf = "";
    const reader = conn.readable.getReader();
    try {
      for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const { value, done } = await readWithAbort(reader, signal);
        if (done) {
          if (buf.trim() === "") {
            throw new Error("read response: empty response");
          }
          break;
        }
        buf += decoder.decode(value, { stream: true });
        const idx = buf.indexOf("\n");
        if (idx >= 0) {
          buf = buf.slice(0, idx);
          break;
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }

    const trimmed = buf.trim();
    if (trimmed === "") throw new Error("read response: empty response");
    try {
      return JSON.parse(trimmed) as ProtocolResponse;
    } catch (err) {
      throw new Error(`unmarshal response: ${err}`);
    }
  }
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return await reader.read();
  return await new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then((result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    }, (err) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

function decodeDaemonBytes(data: string | number[] | undefined): Uint8Array {
  if (data === undefined) return new Uint8Array();
  if (typeof data === "string") {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return Uint8Array.from(data);
}

async function dialDaemon(
  signal: AbortSignal | undefined,
  path: string,
): Promise<Deno.Conn> {
  if (!signal) return await Deno.connect({ transport: "unix", path });
  return await new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Deno.connect({ transport: "unix", path }).then((conn) => {
      if (settled) {
        try {
          conn.close();
        } catch {
          // ignore
        }
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(conn);
    }, (err) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

async function dialDaemonTimeout(
  path: string,
  timeoutMs: number,
): Promise<Deno.Conn> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await dialDaemon(controller.signal, path);
  } finally {
    clearTimeout(timer);
  }
}

/** Parses a daemon PID file. */
export function parsePid(data: Uint8Array): number {
  const pid = Number.parseInt(new TextDecoder().decode(data).trim(), 10);
  if (Number.isNaN(pid) || pid <= 0) {
    throw new Error("pid must be positive");
  }
  return pid;
}

/** Returns the default daemon socket directory. */
export function getSocketDir(): string {
  const dir = Deno.env.get("VIBE_BROWSER_SOCKET_DIR");
  if (dir) return dir;
  const tmp = Deno.env.get("TMPDIR") || Deno.env.get("TMP") ||
    Deno.env.get("TEMP") || "/tmp";
  if (Deno.build.os === "windows") return `${tmp}/vibe-browser`;
  const xdg = Deno.env.get("XDG_RUNTIME_DIR");
  if (xdg) return `${xdg}/vibe-browser`;
  const home = Deno.env.get("HOME");
  if (home) return `${home}/.vibe-browser`;
  return `${tmp}/vibe-browser`;
}

/** Checks if a daemon is running for the given session. */
export function isDaemonRunning(
  socketPath: string,
  session: string,
  socketDir: string,
): boolean {
  try {
    Deno.statSync(socketPath);
  } catch {
    return false;
  }
  let pid: number;
  try {
    pid = parsePid(Deno.readFileSync(`${socketDir}/${session}.pid`));
  } catch {
    return false;
  }
  return isProcessAlive(pid);
}

/** Checks if a process with the given PID exists. */
export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  if (Deno.build.os === "windows") return true;
  if (Deno.build.os === "linux") {
    try {
      Deno.statSync(`/proc/${pid}`);
      return true;
    } catch {
      return false;
    }
  }
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
}
