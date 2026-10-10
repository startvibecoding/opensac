//
// The opensac `browser` tool: it controls a Chromium-family browser through the
// ported vibe-browser SDK. Registration helpers mirror the Go package.
//
// Deviations from Go: `context.Context` maps to the `ToolContext` `AbortSignal`;
// `sync.Mutex` is dropped (Node is single-threaded); `panic`-based `requireString`
// throws instead; `os.WriteFile`/`os.MkdirAll` map to `runtime.mkdirSync`/
// `runtime.writeFileSync`; `encoding/json` maps to `JSON`.

import { runtime } from "../platform/runtime.ts";
import {
  defaultPolicy,
  type Mode,
  normalizeMode,
  type Policy,
  prepareBytes,
  type Result as ImageResult,
} from "../imageproc/mod.ts";
import { type ImageContent } from "../provider/types.ts";
import {
  createImageToolResult,
  createTextToolResult,
  type Registry,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "../tools/tool.ts";
import { Client, type Options } from "./client.ts";
import {
  type Cookie,
  type HTMLOptions,
  type ScreenshotOptions,
} from "./protocol.ts";

/** The tool name registered with the shared registry. */
export const TOOL_NAME = "browser";
/** The built-in skill that documents the tool. */
export const SKILL_NAME = "vibe-browser";
const defaultViewportWidth = 1920;
const defaultViewportHeight = 1080;

/** Registers the browser tool on a registry. */
export function registerTool(registry: Registry | undefined): void {
  if (!registry) return;
  registry.register(createTool(registry));
}

/** Removes the browser tool from a registry. */
export function removeTool(registry: Registry | undefined): void {
  if (!registry) return;
  registry.remove(TOOL_NAME);
}

/** Reports whether the browser tool is registered. */
export function isToolRegistered(registry: Registry | undefined): boolean {
  if (!registry) return false;
  return registry.get(TOOL_NAME) !== undefined;
}

/** The browser tool. */
export class BrowserTool implements Tool {
  #registry: Registry | undefined;
  #client: Client | undefined;

  constructor(registry: Registry | undefined) {
    this.#registry = registry;
  }

  name(): string {
    return TOOL_NAME;
  }

  description(): string {
    return "Control a Chromium-family browser through the vibe-browser SDK. Use action=open/navigate/snapshot/click/fill/type/press/screenshot/etc.";
  }

  promptSnippet(): string {
    return "Control a browser through vibe-browser when browser support is enabled";
  }

  promptGuidelines(): string[] {
    return [
      "Use browser snapshot before interacting so selectors/refs are grounded in the current page",
      "After click/fill/press/navigation, wait for a selector/text/url or take another snapshot before reporting success",
      "Use screenshot with outputPath for visual verification artifacts",
    ];
  }

  parameters(): unknown {
    return JSON.parse(PARAMETERS_JSON);
  }

  executionTimeout(_params: Record<string, unknown>): {
    durationMs: number;
    provided: boolean;
  } {
    return { durationMs: 2 * 60 * 1000, provided: true };
  }

  async execute(
    ctx: ToolContext,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    const signal = ctx.signal;
    const action = stringParam(params, "action").trim().toLowerCase();
    if (action === "") throw new Error("action is required");
    if (action === "close") {
      if (this.#client) {
        this.#client.close();
        this.#client = undefined;
      }
      return createTextToolResult("browser closed");
    }

    const c = await this.#ensureClient(params, signal);

    switch (action) {
      case "open": {
        const url = stringParam(params, "url");
        if (url !== "") {
          const waitUntil = stringParam(params, "waitUntil");
          await c.navigate(url, waitUntil ? { waitUntil } : undefined, signal);
        }
        return await pageSummary(c, "browser opened", signal);
      }
      case "navigate": {
        const url = requireString(params, "url");
        const waitUntil = stringParam(params, "waitUntil");
        await c.navigate(url, waitUntil ? { waitUntil } : undefined, signal);
        return await pageSummary(c, "navigated", signal);
      }
      case "back":
        await c.back(signal);
        return createTextToolResult("went back");
      case "forward":
        await c.forward(signal);
        return createTextToolResult("went forward");
      case "reload":
        await c.reload(signal);
        return createTextToolResult("reloaded");
      case "snapshot": {
        const s = await c.snapshot(
          {
            selector: stringParam(params, "selector"),
            interactive: boolParam(params, "interactive"),
            compact: boolParam(params, "compact"),
            depth: intParam(params, "depth"),
            urls: boolParam(params, "urls"),
          },
          signal,
        );
        return createTextToolResult(s);
      }
      case "click":
        await c.click(requireString(params, "selector"), signal);
        return createTextToolResult("clicked");
      case "dblclick":
        await c.doubleClick(requireString(params, "selector"), signal);
        return createTextToolResult("double-clicked");
      case "hover":
        await c.hover(requireString(params, "selector"), signal);
        return createTextToolResult("hovered");
      case "focus":
        await c.focus(requireString(params, "selector"), signal);
        return createTextToolResult("focused");
      case "fill":
        await c.fill(
          requireString(params, "selector"),
          requireString(params, "value"),
          signal,
        );
        return createTextToolResult("filled");
      case "type":
        await c.type(
          requireString(params, "selector"),
          requireString(params, "text"),
          signal,
        );
        return createTextToolResult("typed");
      case "press":
        await c.press(requireString(params, "key"), signal);
        return createTextToolResult("pressed");
      case "scroll": {
        const x = floatParamOK(params, "x");
        if (x !== undefined) {
          const y = floatParamOK(params, "y") ?? 0;
          await c.scrollAt(
            x,
            y,
            floatParam(params, "deltaX"),
            floatParam(params, "deltaY"),
            signal,
          );
          return createTextToolResult("scrolled at");
        }
        await c.scroll(
          floatParam(params, "deltaX"),
          floatParam(params, "deltaY"),
          signal,
        );
        return createTextToolResult("scrolled");
      }
      case "click_at":
        await c.clickAt(
          floatParam(params, "x"),
          floatParam(params, "y"),
          signal,
        );
        return createTextToolResult("clicked at");
      case "dblclick_at":
        await c.doubleClickAt(
          floatParam(params, "x"),
          floatParam(params, "y"),
          signal,
        );
        return createTextToolResult("double-clicked at");
      case "move_mouse":
        await c.moveMouse(
          floatParam(params, "x"),
          floatParam(params, "y"),
          signal,
        );
        return createTextToolResult("moved mouse");
      case "drag":
        await c.drag(
          floatParam(params, "startX"),
          floatParam(params, "startY"),
          floatParam(params, "endX"),
          floatParam(params, "endY"),
          intParam(params, "steps"),
          signal,
        );
        return createTextToolResult("dragged");
      case "set_cookie":
        await c.setCookie(cookieFromParams(params), signal);
        return createTextToolResult("cookie set");
      case "check":
        await c.check(requireString(params, "selector"), signal);
        return createTextToolResult("checked");
      case "uncheck":
        await c.uncheck(requireString(params, "selector"), signal);
        return createTextToolResult("unchecked");
      case "select":
        await c.select(
          requireString(params, "selector"),
          requireString(params, "value"),
          signal,
        );
        return createTextToolResult("selected");
      case "get_text":
        return valueResult(
          await c.getText(requireString(params, "selector"), signal),
        );
      case "get_html": {
        const selector = requireString(params, "selector");
        const opts = htmlOptionsFromParams(params);
        return valueResult(
          await c.getHtml(selector, opts ?? undefined, signal),
        );
      }
      case "get_value":
        return valueResult(
          await c.getValue(requireString(params, "selector"), signal),
        );
      case "get_attr":
        return valueResult(
          await c.getAttr(
            requireString(params, "selector"),
            requireString(params, "attr"),
            signal,
          ),
        );
      case "get_url":
        return valueResult(await c.url(signal));
      case "get_title":
        return valueResult(await c.title(signal));
      case "is_visible":
        return valueResult(
          await c.isVisible(requireString(params, "selector"), signal),
        );
      case "is_enabled":
        return valueResult(
          await c.isEnabled(requireString(params, "selector"), signal),
        );
      case "is_checked":
        return valueResult(
          await c.isChecked(requireString(params, "selector"), signal),
        );
      case "eval":
        return valueResult(
          await c.eval(requireString(params, "expression"), signal),
        );
      case "wait_ms":
        await c.waitMs(intParam(params, "ms"), signal);
        return createTextToolResult("waited");
      case "wait_for_selector":
        await c.waitForSelector(requireString(params, "selector"), signal);
        return createTextToolResult("selector appeared");
      case "wait_for_text":
        await c.waitForText(requireString(params, "text"), signal);
        return createTextToolResult("text appeared");
      case "wait_for_url":
        await c.waitForUrl(requireString(params, "url"), signal);
        return createTextToolResult("url matched");
      case "screenshot":
        return await this.#screenshot(c, params, signal);
      case "set_viewport":
        await c.setViewport(
          intParam(params, "width"),
          intParam(params, "height"),
          signal,
        );
        return createTextToolResult("viewport set");
      case "set_geolocation":
        await c.setGeolocation(
          floatParam(params, "latitude"),
          floatParam(params, "longitude"),
          floatParam(params, "accuracy"),
          signal,
        );
        return createTextToolResult("geolocation set");
      case "set_offline":
        await c.setOffline(boolParam(params, "offline"), signal);
        return createTextToolResult("offline state set");
      case "set_headers":
        await c.setHeaders(stringMapParam(params, "headers"), signal);
        return createTextToolResult("headers set");
      case "cookies_get":
        return valueResult(await c.getCookies(signal));
      case "cookies_clear":
        await c.clearCookies(signal);
        return createTextToolResult("cookies cleared");
      case "tab_new":
        return valueResult(await c.newTab(stringParam(params, "url"), signal));
      case "tab_close":
        await c.closeTab(requireString(params, "targetId"), signal);
        return createTextToolResult("tab closed");
      default:
        throw new Error(`unknown browser action: ${action}`);
    }
  }

  async #ensureClient(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Client> {
    if (this.#client && (await this.#client.isConnected())) return this.#client;
    const opts = clientOptions(params);
    const c = boolParam(params, "daemon")
      ? await Client.connect(opts)
      : await Client.open(opts, signal);
    this.#client = c;
    return c;
  }

  async #screenshot(
    c: Client,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const format = stringParam(params, "format") || "png";
    const opts: ScreenshotOptions = {
      format,
      quality: intParam(params, "quality"),
      fullPage: boolParam(params, "fullPage"),
      selector: stringParam(params, "selector"),
      clipX: floatParam(params, "clipX"),
      clipY: floatParam(params, "clipY"),
      clipWidth: floatParam(params, "clipWidth"),
      clipHeight: floatParam(params, "clipHeight"),
    };
    const data = await c.screenshot(opts, signal);
    const outputPath = stringParam(params, "outputPath");
    if (outputPath !== "") {
      const resolved = this.#resolvePath(outputPath);
      const dir = resolved.slice(0, resolved.lastIndexOf("/"));
      if (dir) runtime.mkdirSync(dir, { recursive: true });
      runtime.writeFileSync(resolved, data);
      return createTextToolResult(`screenshot saved: ${resolved}`);
    }
    return await this.#screenshotToolResult(data, params);
  }

  #resolvePath(p: string): string {
    if (!this.#registry) throw new Error("registry is required");
    return this.#registry.resolvePath(p);
  }

  /** Processes screenshot bytes into a text + image tool result. */
  async screenshotToolResult(
    data: Uint8Array,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    return await this.#screenshotToolResult(data, params);
  }

  async #screenshotToolResult(
    data: Uint8Array,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    const policy = this.#screenshotImagePolicy(params);
    let result;
    try {
      result = await prepareBytes(data, policy);
    } catch (err) {
      throw new Error(`process screenshot: ${err}`);
    }
    const image: ImageContent = {
      data: base64Encode(result.data),
      mimeType: result.mimeType,
      width: result.meta.width,
      height: result.meta.height,
      bytes: result.meta.bytes,
      originalWidth: result.meta.originalWidth,
      originalHeight: result.meta.originalHeight,
      originalBytes: result.meta.originalBytes,
      detail: result.meta.detail,
      scale: result.meta.scale,
    };
    return createImageToolResult(browserScreenshotDescription(result), image);
  }

  #screenshotImagePolicy(params: Record<string, unknown>): Policy {
    let mode: Mode = "detail";
    const v = stringParam(params, "imageMode");
    if (v !== "") mode = normalizeMode(v);
    let policy = defaultPolicy(mode);
    if (this.#registry) policy = this.#registry.imagePolicy(mode);
    const maxLongEdge = intParam(params, "maxLongEdge");
    if (maxLongEdge > 0) policy = { ...policy, maxLongEdge };
    return policy;
  }
}

/** Creates a new browser tool. */
export function createTool(registry: Registry | undefined): BrowserTool {
  return new BrowserTool(registry);
}

function browserScreenshotDescription(result: ImageResult): string {
  const m = result.meta;
  const original = `${m.originalWidth}x${m.originalHeight} ${formatBytes(
    m.originalBytes,
  )}`;
  const sent = `${m.width}x${m.height} ${formatBytes(
    m.bytes,
  )} ${result.mimeType}`;
  if (m.resized || m.transcoded || m.originalBytes !== m.bytes) {
    return `[Browser screenshot, original: ${original}, sent: ${sent}, mode: ${m.detail}]`;
  }
  return `[Browser screenshot, ${sent}, mode: ${m.detail}]`;
}

function formatBytes(n: number): string {
  const unit = 1024;
  if (n < unit) return `${n}B`;
  const kb = n / unit;
  if (kb < unit) return `${kb.toFixed(1)}KB`;
  return `${(kb / unit).toFixed(1)}MB`;
}

async function pageSummary(
  c: Client,
  prefix: string,
  signal?: AbortSignal,
): Promise<ToolResult> {
  let title = "";
  let url = "";
  try {
    title = await c.title(signal);
  } catch {
    // ignore
  }
  try {
    url = await c.url(signal);
  } catch {
    // ignore
  }
  return createTextToolResult(`${prefix}\nTitle: ${title}\nURL: ${url}`.trim());
}

function valueResult(v: unknown): ToolResult {
  if (typeof v === "string") return createTextToolResult(v);
  if (typeof v === "boolean") return createTextToolResult(String(v));
  try {
    return createTextToolResult(JSON.stringify(v, null, 2));
  } catch {
    return createTextToolResult(String(v));
  }
}

function requireString(params: Record<string, unknown>, key: string): string {
  const v = stringParam(params, key);
  if (v === "") throw new Error(`${key} is required`);
  return v;
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  return typeof v === "string" ? v : "";
}

function boolParam(params: Record<string, unknown>, key: string): boolean {
  return boolParamOK(params, key) ?? false;
}

function boolParamOK(
  params: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const v = params[key];
  if (typeof v === "boolean") return v;
  return undefined;
}

function intParam(params: Record<string, unknown>, key: string): number {
  return intParamOK(params, key) ?? 0;
}

function intParamOK(
  params: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = params[key];
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

function floatParam(params: Record<string, unknown>, key: string): number {
  return floatParamOK(params, key) ?? 0;
}

function floatParamOK(
  params: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = params[key];
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

function stringMapParam(
  params: Record<string, unknown>,
  key: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = params[key];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

/**
 * Builds vibe-browser HTMLOptions from tool params. Returns undefined when
 * neither maxBytes nor maxChars is present, so the library default applies.
 */
export function htmlOptionsFromParams(
  params: Record<string, unknown>,
): HTMLOptions | undefined {
  const hasBytes = "maxBytes" in params;
  const hasChars = "maxChars" in params;
  if (!hasBytes && !hasChars) return undefined;
  return {
    maxBytes: intParam(params, "maxBytes"),
    maxChars: intParam(params, "maxChars"),
  };
}

/** Builds a protocol.Cookie from flat tool params. */
export function cookieFromParams(params: Record<string, unknown>): Cookie {
  return {
    name: stringParam(params, "name"),
    value: stringParam(params, "value"),
    domain: stringParam(params, "domain"),
    path: stringParam(params, "path"),
    expires: floatParam(params, "expires"),
    httpOnly: boolParam(params, "httpOnly"),
    secure: boolParam(params, "secure"),
    sameSite: stringParam(params, "sameSite"),
  };
}

/** Builds client options from flat tool params. */
export function clientOptions(params: Record<string, unknown>): Options {
  const browserName = firstNonEmpty(
    stringParam(params, "browser"),
    runtime.env.get("VIBE_BROWSER_BROWSER") ?? "",
  );
  const opts: Options = {
    cdpUrl: firstNonEmpty(
      stringParam(params, "cdpUrl"),
      runtime.env.get("VIBE_BROWSER_CDP_URL") ?? "",
    ),
    session: firstNonEmpty(
      stringParam(params, "session"),
      runtime.env.get("VIBE_BROWSER_SESSION") ?? "",
    ),
    executablePath: firstNonEmpty(
      stringParam(params, "executablePath"),
      runtime.env.get("CHROME_PATH") ?? "",
    ),
    daemonSocketDir: runtime.env.get("VIBE_BROWSER_SOCKET_DIR") ?? "",
    launch: {
      headless: true,
      viewportWidth: intParamDefault(
        params,
        "viewportWidth",
        defaultViewportWidth,
      ),
      viewportHeight: intParamDefault(
        params,
        "viewportHeight",
        defaultViewportHeight,
      ),
    },
  };
  if (browserName !== "") {
    opts.browser = browserName as Options["browser"];
    opts.launch!.browser = opts.browser;
  }
  opts.launch!.executablePath = opts.executablePath;
  const headless = boolParamOK(params, "headless");
  if (headless !== undefined) opts.launch!.headless = headless;
  return opts;
}

function intParamDefault(
  params: Record<string, unknown>,
  key: string,
  defaultValue: number,
): number {
  const value = intParam(params, key);
  return value > 0 ? value : defaultValue;
}

function firstNonEmpty(...values: string[]): string {
  for (const v of values) {
    if (v !== "") return v;
  }
  return "";
}

function base64Encode(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

const PARAMETERS_JSON = `{
  "type": "object",
  "properties": {
    "action": {"type": "string", "description": "Browser action: open, navigate, back, forward, reload, snapshot, click, dblclick, hover, focus, fill, type, press, scroll, click_at, dblclick_at, move_mouse, drag, check, uncheck, select, get_text, get_html, get_value, get_attr, get_url, get_title, is_visible, is_enabled, is_checked, eval, wait_ms, wait_for_selector, wait_for_text, wait_for_url, screenshot, set_viewport, set_geolocation, set_offline, set_headers, cookies_get, cookies_clear, set_cookie, tab_new, tab_close, close"},
    "url": {"type": "string"},
    "selector": {"type": "string", "description": "CSS selector or ref from snapshot"},
    "value": {"type": "string"},
    "text": {"type": "string"},
    "key": {"type": "string"},
    "attr": {"type": "string"},
    "maxBytes": {"type": "integer", "description": "Max bytes for get_html output. 0 disables truncation and returns the full document. Omitted: library default (~50KB cap)."},
    "maxChars": {"type": "integer", "description": "Max characters for get_html output. 0 means no character limit. Only meaningful for get_html."},
    "expression": {"type": "string"},
    "outputPath": {"type": "string", "description": "Project-relative path for screenshot output"},
    "format": {"type": "string", "enum": ["png", "jpeg", "webp"]},
    "quality": {"type": "integer"},
    "imageMode": {"type": "string", "enum": ["auto", "fast", "detail", "raw"], "description": "Image processing mode for returned screenshots. Defaults to detail."},
    "maxLongEdge": {"type": "integer", "description": "Optional maximum long edge in pixels for returned screenshot resizing"},
    "fullPage": {"type": "boolean"},
    "interactive": {"type": "boolean"},
    "compact": {"type": "boolean"},
    "depth": {"type": "integer"},
    "urls": {"type": "boolean"},
    "width": {"type": "integer"},
    "height": {"type": "integer"},
    "viewportWidth": {"type": "integer", "description": "Initial browser viewport width. Defaults to 1920."},
    "viewportHeight": {"type": "integer", "description": "Initial browser viewport height. Defaults to 1080."},
    "ms": {"type": "integer"},
    "deltaX": {"type": "number"},
    "deltaY": {"type": "number"},
    "x": {"type": "number", "description": "Viewport x coordinate in CSS pixels (click_at, dblclick_at, move_mouse, scroll with coords)."},
    "y": {"type": "number", "description": "Viewport y coordinate in CSS pixels (click_at, dblclick_at, move_mouse, scroll with coords)."},
    "startX": {"type": "number", "description": "Drag start x (drag)."},
    "startY": {"type": "number", "description": "Drag start y (drag)."},
    "endX": {"type": "number", "description": "Drag end x (drag)."},
    "endY": {"type": "number", "description": "Drag end y (drag)."},
    "steps": {"type": "integer", "description": "Number of intermediate steps for drag (0 = instant)."},
    "waitUntil": {"type": "string", "description": "Navigation load state to wait for: load, domcontentloaded, networkidle (open, navigate)."},
    "clipX": {"type": "number", "description": "Screenshot clip origin x (screenshot)."},
    "clipY": {"type": "number", "description": "Screenshot clip origin y (screenshot)."},
    "clipWidth": {"type": "number", "description": "Screenshot clip width (screenshot)."},
    "clipHeight": {"type": "number", "description": "Screenshot clip height (screenshot)."},
    "name": {"type": "string", "description": "Cookie name (set_cookie)."},
    "domain": {"type": "string", "description": "Cookie domain (set_cookie)."},
    "path": {"type": "string", "description": "Cookie path (set_cookie)."},
    "httpOnly": {"type": "boolean", "description": "Cookie httpOnly flag (set_cookie)."},
    "secure": {"type": "boolean", "description": "Cookie secure flag (set_cookie)."},
    "sameSite": {"type": "string", "description": "Cookie sameSite policy: Strict, Lax, None (set_cookie)."},
    "expires": {"type": "number", "description": "Cookie expiry as epoch seconds (set_cookie)."},
    "latitude": {"type": "number"},
    "longitude": {"type": "number"},
    "accuracy": {"type": "number"},
    "offline": {"type": "boolean"},
    "headers": {"type": "object", "additionalProperties": {"type": "string"}},
    "targetId": {"type": "string"},
    "headless": {"type": "boolean"},
    "browser": {"type": "string", "enum": ["chrome", "chromium", "brave", "edge", "chrome-canary"]},
    "cdpUrl": {"type": "string"},
    "executablePath": {"type": "string"},
    "daemon": {"type": "boolean"},
    "session": {"type": "string"}
  },
  "required": ["action"]
}`;
