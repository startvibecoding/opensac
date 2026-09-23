// (v0.1.5).
//
// High-level browser automation operations wrapping the CDP client: navigation,
// interaction, accessibility snapshots, screenshots, cookies, and waits.
//
// Deviations from Go: `context.Context` maps to `AbortSignal`; Go's
// `waitCtx.Err()` timeouts map to `withTimeout` derived signals; `[]byte`
// maps to `Uint8Array`; `encoding/base64` maps to `atob`/`btoa` helpers;
// `log/slog` logging is dropped.

import { CdpClient, CdpError, type CdpMessage } from "./cdp.ts";
import { extractHostPort, listTargets } from "./chrome.ts";
import {
  type ClickOptions,
  type Cookie,
  DEFAULT_HTML_MAX_BYTES,
  type HTMLOptions,
  type NavigationOptions,
  type ScreenshotOptions,
  type SnapshotOptions,
} from "./protocol.ts";

/** Target represents a browser target (page, background_page, etc.). */
export interface Target {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl: string;
}

interface RuntimeEvalResult {
  result?: { value?: unknown; type?: string };
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string };
  };
}

interface AxValue {
  type?: string;
  value?: unknown;
}

interface AxProperty {
  name: string;
  value: AxValue;
}

interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  description?: AxValue;
  value?: AxValue;
  properties?: AxProperty[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

/** interactiveRoles is the single source of truth for interactive AX roles. */
const interactiveRoles = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "menuitem",
  "switch",
  "tab",
  "slider",
  "spinbutton",
  "searchbox",
]);

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
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

function withTimeout(
  parent: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; cancel: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  const onParent = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", onParent, { once: true });
  }
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
    timedOut: () => timedOut,
  };
}

function base64Decode(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Browser represents a connected browser instance. */
export class Browser {
  #browserUrl: string;
  #pageCdp: CdpClient | undefined;
  #pageTarget: Target | undefined;
  #processKiller: (() => void) | undefined;

  private constructor(browserUrl: string) {
    this.#browserUrl = browserUrl;
  }

  /** Connects to a browser's CDP WebSocket URL and returns a Browser. */
  static async connectToCdp(
    wsUrl: string,
    signal?: AbortSignal,
  ): Promise<Browser> {
    const b = new Browser(wsUrl);
    await b.connectToPage(signal);
    return b;
  }

  async connectToPage(signal?: AbortSignal): Promise<void> {
    const { host, port } = extractHostPort(this.#browserUrl);
    const targets = await listTargets(host, port);
    let pageTarget: Target | undefined;
    for (const t of targets) {
      if (t.type === "page") {
        pageTarget = targetFrom(t);
        break;
      }
    }
    if (!pageTarget) {
      pageTarget = await createTarget(host, port);
    }
    this.#pageTarget = pageTarget;
    this.#pageCdp = await CdpClient.connect(
      pageTarget.webSocketDebuggerUrl,
      signal,
    );
  }

  /** Sets a function that will be called to kill the browser process. */
  setProcessKiller(killer: (() => void) | undefined): void {
    this.#processKiller = killer;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  /** Closes the CDP connection and kills the browser process. */
  close(): void {
    this.#pageCdp?.close();
    this.#pageCdp = undefined;
    if (this.#processKiller) {
      this.#processKiller();
      this.#processKiller = undefined;
    }
  }

  /** Reports whether the CDP connection is alive. */
  isConnected(): boolean {
    return this.#pageCdp !== undefined && this.#pageCdp.isConnected();
  }

  #getClient(): CdpClient {
    if (!this.#pageCdp) throw new Error("browser: not connected");
    return this.#pageCdp;
  }

  async #eval(
    expression: string,
    signal?: AbortSignal,
  ): Promise<RuntimeEvalResult> {
    const msg = await this.#getClient().send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      signal,
    );
    const result = (msg.result ?? {}) as RuntimeEvalResult;
    if (result.exceptionDetails) {
      let text = result.exceptionDetails.text ?? "";
      if (
        result.exceptionDetails.exception &&
        result.exceptionDetails.exception.description
      ) {
        text = result.exceptionDetails.exception.description;
      }
      throw new Error(`runtime exception: ${text}`);
    }
    return result;
  }

  /** Navigates the browser to a URL. */
  async navigate(
    url: string,
    opts?: NavigationOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    const client = this.#getClient();
    await client.send("Page.enable", undefined, signal);
    const params: Record<string, unknown> = { url };
    if (opts) {
      if (opts.waitUntil) params.waitUntil = opts.waitUntil;
      if (opts.timeout && opts.timeout > 0) params.timeout = opts.timeout;
    }
    const msg = await client.send("Page.navigate", params, signal);
    const result = (msg.result ?? {}) as { errorText?: string };
    if (result.errorText) throw new Error(`navigate: ${result.errorText}`);
    if (opts && opts.waitUntil) {
      await this.waitForLoad(opts.waitUntil, opts.timeout ?? 0, signal);
    }
  }

  async waitForLoad(
    state: string,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const client = this.#getClient();
    const ms = timeout === 0 ? 30000 : timeout;
    const { signal: waitSignal, cancel, timedOut } = withTimeout(signal, ms);
    try {
      switch (state) {
        case "load":
          await client.send("Page.enable", undefined, waitSignal);
          await this.#waitForEvent("Page.loadEventFired", waitSignal, timedOut);
          return;
        case "domcontentloaded":
          await client.send("Page.enable", undefined, waitSignal);
          await this.#waitForEvent(
            "Page.domContentEventFired",
            waitSignal,
            timedOut,
          );
          return;
        case "networkidle":
          await this.waitForNetworkIdle(ms, waitSignal, timedOut);
          return;
        default:
          return;
      }
    } finally {
      cancel();
    }
  }

  async #waitForEvent(
    method: string,
    signal: AbortSignal,
    timedOut: () => boolean,
  ): Promise<void> {
    const client = this.#getClient();
    for (;;) {
      const evt = await client.nextEvent(signal);
      if (evt === null) throw new Error("cdp: connection closed");
      if (evt.method === method) return;
      if (timedOut()) {
        throw new Error(`waitForLoad: timeout waiting for ${method}`);
      }
    }
  }

  async waitForNetworkIdle(
    _timeout: number,
    signal?: AbortSignal,
    timedOut?: () => boolean,
  ): Promise<void> {
    const client = this.#getClient();
    await client.send("Network.enable", undefined, signal);
    let pending = 0;
    let lastActivity = Date.now();
    for (;;) {
      if (timedOut?.() || (signal?.aborted ?? false)) {
        if (timedOut?.()) {
          throw new Error("waitForNetworkIdle: timeout");
        }
        throw new DOMException("Aborted", "AbortError");
      }
      const remaining = 500 - (Date.now() - lastActivity);
      if (pending === 0 && remaining <= 0) return;
      const evt = await client.nextEvent(signal);
      if (evt === null) throw new Error("cdp: connection closed");
      switch (evt.method) {
        case "Network.requestWillBeSent":
          pending++;
          lastActivity = Date.now();
          break;
        case "Network.loadingFinished":
        case "Network.loadingFailed":
          pending = Math.max(0, pending - 1);
          lastActivity = Date.now();
          break;
      }
    }
  }

  async reload(signal?: AbortSignal): Promise<void> {
    await this.#getClient().send("Page.reload", undefined, signal);
  }

  async goBack(signal?: AbortSignal): Promise<void> {
    await this.#getClient().send("Page.goBack", undefined, signal);
  }

  async goForward(signal?: AbortSignal): Promise<void> {
    await this.#getClient().send("Page.goForward", undefined, signal);
  }

  async getUrl(signal?: AbortSignal): Promise<string> {
    return resultString(await this.#eval("window.location.href", signal));
  }

  async getTitle(signal?: AbortSignal): Promise<string> {
    return resultString(await this.#eval("document.title", signal));
  }

  async click(
    selector: string,
    opts?: ClickOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    const [x, y] = await this.resolveElementCenter(selector, signal);
    await this.clickAt(x, y, opts, signal);
  }

  async clickAt(
    x: number,
    y: number,
    opts?: ClickOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    const button = opts?.button || "left";
    const clickCount = opts?.clickCount && opts.clickCount > 0
      ? opts.clickCount
      : 1;
    const client = this.#getClient();
    await client.send(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x, y, button, clickCount },
      signal,
    );
    if (opts?.delay && opts.delay > 0) await delay(opts.delay, signal);
    await client.send(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x, y, button, clickCount },
      signal,
    );
  }

  async doubleClick(selector: string, signal?: AbortSignal): Promise<void> {
    const [x, y] = await this.resolveElementCenter(selector, signal);
    await this.doubleClickAt(x, y, signal);
  }

  async doubleClickAt(
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.clickAt(x, y, { clickCount: 2 }, signal);
  }

  async fill(
    selector: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#eval(focusExpression(selector), signal);
    const client = this.#getClient();
    await client.send(
      "Input.dispatchKeyEvent",
      { type: "keyDown", key: "a", code: "KeyA", commands: ["selectAll"] },
      signal,
    );
    await client.send("Input.insertText", { text: value }, signal);
  }

  async type(
    selector: string,
    text: string,
    delayMs = 50,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#eval(focusExpression(selector), signal);
    const client = this.#getClient();
    const wait = delayMs === 0 ? 50 : delayMs;
    for (const ch of Array.from(text)) {
      await client.send(
        "Input.dispatchKeyEvent",
        { type: "keyDown", text: ch },
        signal,
      );
      await client.send(
        "Input.dispatchKeyEvent",
        { type: "keyUp", text: ch },
        signal,
      );
      if (wait > 0) await delay(wait, signal);
    }
  }

  async press(key: string, signal?: AbortSignal): Promise<void> {
    const client = this.#getClient();
    await client.send(
      "Input.dispatchKeyEvent",
      { type: "keyDown", key },
      signal,
    );
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key }, signal);
  }

  async hover(selector: string, signal?: AbortSignal): Promise<void> {
    const [x, y] = await this.resolveElementCenter(selector, signal);
    await this.moveMouse(x, y, signal);
  }

  async moveMouse(x: number, y: number, signal?: AbortSignal): Promise<void> {
    await this.#getClient().send(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x, y },
      signal,
    );
  }

  async drag(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    steps: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const n = steps < 1 ? 1 : steps;
    const client = this.#getClient();
    await client.send(
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        x: startX,
        y: startY,
        button: "left",
        clickCount: 1,
      },
      signal,
    );
    for (let i = 1; i <= n; i++) {
      const progress = i / n;
      await client.send(
        "Input.dispatchMouseEvent",
        {
          type: "mouseMoved",
          x: startX + (endX - startX) * progress,
          y: startY + (endY - startY) * progress,
          button: "left",
          buttons: 1,
        },
        signal,
      );
    }
    await client.send(
      "Input.dispatchMouseEvent",
      {
        type: "mouseReleased",
        x: endX,
        y: endY,
        button: "left",
        clickCount: 1,
      },
      signal,
    );
  }

  async scroll(
    deltaX: number,
    deltaY: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.scrollAt(0, 0, deltaX, deltaY, signal);
  }

  async scrollAt(
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#getClient().send(
      "Input.dispatchMouseEvent",
      { type: "mouseWheel", x, y, deltaX, deltaY },
      signal,
    );
  }

  async focus(selector: string, signal?: AbortSignal): Promise<void> {
    await this.#eval(focusExpression(selector), signal);
  }

  async check(selector: string, signal?: AbortSignal): Promise<void> {
    await this.#eval(
      `(function() {
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Element not found: ${selector}');
        if (!el.checked) el.click();
        return true;
      })()`,
      signal,
    );
  }

  async uncheck(selector: string, signal?: AbortSignal): Promise<void> {
    await this.#eval(
      `(function() {
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Element not found: ${selector}');
        if (el.checked) el.click();
        return true;
      })()`,
      signal,
    );
  }

  async select(
    selector: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#eval(
      `(function() {
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Element not found: ${selector}');
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
      signal,
    );
  }

  async evalJs(expression: string, signal?: AbortSignal): Promise<unknown> {
    const result = await this.#eval(expression, signal);
    return result.result?.value ?? null;
  }

  async getText(selector: string, signal?: AbortSignal): Promise<string> {
    const result = await this.#eval(
      `(function() {
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Element not found: ${selector}');
        return el.innerText || el.textContent || '';
      })()`,
      signal,
    );
    return resultString(result);
  }

  async getHtml(selector: string, signal?: AbortSignal): Promise<string> {
    return await this.getHtmlWithOptions(selector, undefined, signal);
  }

  async getHtmlWithOptions(
    selector: string,
    opts?: HTMLOptions,
    signal?: AbortSignal,
  ): Promise<string> {
    let expr = "document.documentElement.outerHTML";
    if (selector !== "") {
      expr = `(function() {
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Element not found: ${selector}');
        return el.outerHTML;
      })()`;
    }
    const result = await this.#eval(expr, signal);
    return truncateHtml(resultString(result), opts);
  }

  async getValue(selector: string, signal?: AbortSignal): Promise<string> {
    const result = await this.#eval(
      `(function() {
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Element not found: ${selector}');
        return el.value || '';
      })()`,
      signal,
    );
    return resultString(result);
  }

  async getAttr(
    selector: string,
    attr: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.#eval(
      `(function() {
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Element not found: ${selector}');
        return el.getAttribute(${JSON.stringify(attr)}) || '';
      })()`,
      signal,
    );
    return resultString(result);
  }

  async isVisible(selector: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.#eval(
      `(function() {
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        var rect = el.getBoundingClientRect();
        var style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 &&
               style.visibility !== 'hidden' && style.display !== 'none';
      })()`,
      signal,
    );
    return resultBool(result);
  }

  async isEnabled(selector: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.#eval(
      `(function() {
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        return !el.disabled;
      })()`,
      signal,
    );
    return resultBool(result);
  }

  async isChecked(selector: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.#eval(
      `(function() {
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        return !!el.checked;
      })()`,
      signal,
    );
    return resultBool(result);
  }

  async screenshot(
    opts?: ScreenshotOptions,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const client = this.#getClient();
    const params: Record<string, unknown> = {};
    if (opts) {
      params.format = opts.format || "png";
      if (opts.quality && opts.quality > 0) params.quality = opts.quality;
      if (opts.fullPage) params.captureBeyondViewport = true;
      if (opts.selector) {
        const [x, y, width, height] = await this.resolveElementBox(
          opts.selector,
          signal,
        );
        params.clip = { x, y, width, height, scale: 1 };
      }
      if (
        opts.clipWidth && opts.clipWidth > 0 && opts.clipHeight &&
        opts.clipHeight > 0
      ) {
        params.clip = {
          x: opts.clipX ?? 0,
          y: opts.clipY ?? 0,
          width: opts.clipWidth,
          height: opts.clipHeight,
          scale: 1,
        };
      }
    } else {
      params.format = "png";
    }
    const msg = await client.send("Page.captureScreenshot", params, signal);
    const result = (msg.result ?? {}) as { data?: string };
    return base64Decode(result.data ?? "");
  }

  async snapshot(
    opts?: SnapshotOptions,
    signal?: AbortSignal,
  ): Promise<string> {
    const client = this.#getClient();
    await client.send("DOM.enable", undefined, signal);
    await client.send("Accessibility.enable", undefined, signal);
    const msg = await client.send(
      "Accessibility.getFullAXTree",
      undefined,
      signal,
    );
    const result = (msg.result ?? {}) as { nodes?: AxNode[] };
    return formatAxTree(result.nodes ?? [], opts);
  }

  async resolveElementCenter(
    selector: string,
    signal?: AbortSignal,
  ): Promise<[number, number]> {
    const [x, y, width, height] = await this.resolveElementBox(
      selector,
      signal,
    );
    return [x + width / 2, y + height / 2];
  }

  async resolveElementBox(
    selector: string,
    signal?: AbortSignal,
  ): Promise<[number, number, number, number]> {
    const result = await this.#eval(
      `(function() {
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Element not found: ${selector}');
        var rect = el.getBoundingClientRect();
        return {
          x: rect.x + window.scrollX,
          y: rect.y + window.scrollY,
          width: rect.width,
          height: rect.height
        };
      })()`,
      signal,
    );
    const value = (result.result?.value ?? {}) as {
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    };
    const x = value.x ?? 0;
    const y = value.y ?? 0;
    const width = value.width ?? 0;
    const height = value.height ?? 0;
    if (width <= 0 || height <= 0) {
      throw new Error(`element has empty bounding box: ${selector}`);
    }
    return [x, y, width, height];
  }

  async resolveNodeId(selector: string, signal?: AbortSignal): Promise<number> {
    const client = this.#getClient();
    const docMsg = await client.send("DOM.getDocument", undefined, signal);
    const docResult = (docMsg.result ?? {}) as { root?: { nodeId?: number } };
    const nodeMsg = await client.send(
      "DOM.querySelector",
      { nodeId: docResult.root?.nodeId ?? 0, selector },
      signal,
    );
    const nodeResult = (nodeMsg.result ?? {}) as { nodeId?: number };
    const nodeId = nodeResult.nodeId ?? 0;
    if (nodeId === 0) throw new Error(`element not found: ${selector}`);
    return nodeId;
  }

  async setViewport(
    width: number,
    height: number,
    deviceScaleFactor = 1,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#getClient().send(
      "Emulation.setDeviceMetricsOverride",
      { width, height, deviceScaleFactor, mobile: false },
      signal,
    );
  }

  async setGeolocation(
    lat: number,
    lng: number,
    accuracy: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#getClient().send(
      "Emulation.setGeolocationOverride",
      { latitude: lat, longitude: lng, accuracy },
      signal,
    );
  }

  async setOffline(offline: boolean, signal?: AbortSignal): Promise<void> {
    await this.#getClient().send(
      "Network.emulateNetworkConditions",
      { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
      signal,
    );
  }

  async setHeaders(
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#getClient().send(
      "Network.setExtraHTTPHeaders",
      { headers },
      signal,
    );
  }

  async getCookies(signal?: AbortSignal): Promise<Cookie[]> {
    const msg = await this.#getClient().send(
      "Network.getCookies",
      undefined,
      signal,
    );
    const result = (msg.result ?? {}) as { cookies?: Cookie[] };
    return result.cookies ?? [];
  }

  async setCookie(cookie: Cookie, signal?: AbortSignal): Promise<void> {
    const params: Record<string, unknown> = {
      name: cookie.name,
      value: cookie.value,
    };
    if (cookie.domain) params.domain = cookie.domain;
    if (cookie.path) params.path = cookie.path;
    if (cookie.expires && cookie.expires > 0) params.expires = cookie.expires;
    if (cookie.httpOnly) params.httpOnly = true;
    if (cookie.secure) params.secure = true;
    if (cookie.sameSite) params.sameSite = cookie.sameSite;
    await this.#getClient().send("Network.setCookie", params, signal);
  }

  async clearCookies(signal?: AbortSignal): Promise<void> {
    await this.#getClient().send(
      "Network.clearBrowserCookies",
      undefined,
      signal,
    );
  }

  async waitMs(ms: number, signal?: AbortSignal): Promise<void> {
    await delay(ms, signal);
  }

  async waitForSelector(
    selector: string,
    timeout = 0,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#poll(timeout, signal, async () => {
      const msg = await this.#getClient().send(
        "Runtime.evaluate",
        {
          expression: `document.querySelector(${
            JSON.stringify(selector)
          }) !== null`,
          returnByValue: true,
        },
        signal,
      );
      const result = (msg.result ?? {}) as { result?: { value?: boolean } };
      return result.result?.value === true;
    }, () => `waitForSelector: timeout waiting for ${selector}`);
  }

  async waitForText(
    text: string,
    timeout = 0,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#poll(timeout, signal, async () => {
      const msg = await this.#getClient().send(
        "Runtime.evaluate",
        { expression: "document.body.innerText", returnByValue: true },
        signal,
      );
      const result = (msg.result ?? {}) as { result?: { value?: string } };
      return (result.result?.value ?? "").includes(text);
    }, () => `waitForText: timeout waiting for "${text}"`);
  }

  async waitForUrl(
    urlPattern: string,
    timeout = 0,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#poll(timeout, signal, async () => {
      try {
        const current = await this.getUrl(signal);
        return current.includes(urlPattern);
      } catch {
        return false;
      }
    }, () => `waitForURL: timeout waiting for ${urlPattern}`);
  }

  async #poll(
    timeout: number,
    signal: AbortSignal | undefined,
    check: () => Promise<boolean>,
    timeoutMessage: () => string,
  ): Promise<void> {
    const ms = timeout === 0 ? 30000 : timeout;
    const deadline = Date.now() + ms;
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      let matched = false;
      try {
        matched = await check();
      } catch {
        matched = false;
      }
      if (matched) return;
      if (Date.now() >= deadline) throw new Error(timeoutMessage());
      await delay(100, signal);
    }
  }

  async newTab(url: string, signal?: AbortSignal): Promise<string> {
    const msg = await this.#getClient().send(
      "Target.createTarget",
      { url },
      signal,
    );
    const result = (msg.result ?? {}) as { targetId?: string };
    return result.targetId ?? "";
  }

  async closeTab(targetId: string, signal?: AbortSignal): Promise<void> {
    await this.#getClient().send("Target.closeTarget", { targetId }, signal);
  }

  /** Returns the underlying CDP client for advanced usage. */
  cdpClient(): CdpClient {
    return this.#getClient();
  }
}

function focusExpression(selector: string): string {
  return `(function() {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('Element not found: ${selector}');
    el.focus();
    return true;
  })()`;
}

function resultString(result: RuntimeEvalResult | undefined): string {
  const value = result?.result?.value;
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return String(value);
}

function resultBool(result: RuntimeEvalResult | undefined): boolean {
  const value = result?.result?.value;
  return value === true;
}

/** Applies the byte/character caps described by opts. */
export function truncateHtml(html: string, opts?: HTMLOptions): string {
  let maxBytes = DEFAULT_HTML_MAX_BYTES;
  let maxChars = 0;
  if (opts) {
    if (opts.maxBytes !== 0) maxBytes = opts.maxBytes ?? maxBytes;
    maxChars = opts.maxChars ?? 0;
  }

  const bytes = new TextEncoder().encode(html);
  const totalBytes = bytes.length;
  const totalChars = Array.from(html).length;

  const charCut = maxChars > 0 && totalChars > maxChars;
  const byteCut = maxBytes > 0 && totalBytes > maxBytes;
  if (!charCut && !byteCut) return html;

  const notice =
    `[truncated: ${totalBytes} bytes total, ${totalChars} chars total, use a narrower selector or GetText]`;

  let prefix = html;
  if (charCut) {
    const runes = Array.from(html);
    if (runes.length > maxChars) prefix = runes.slice(0, maxChars).join("");
  }

  if (!byteCut) return prefix + notice;

  const shortNotice = "[truncated]";
  if (maxBytes >= byteLength(prefix) + byteLength(notice)) {
    return prefix + notice;
  }
  if (maxBytes >= byteLength(notice)) {
    return runeAlignedPrefix(prefix, maxBytes - byteLength(notice)) + notice;
  }
  if (maxBytes >= byteLength(shortNotice)) {
    return runeAlignedPrefix(prefix, maxBytes - byteLength(shortNotice)) +
      shortNotice;
  }
  return runeAlignedPrefix(prefix, maxBytes);
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Returns the longest prefix of s whose byte length is <= n. */
export function runeAlignedPrefix(s: string, n: number): string {
  if (n < 0) n = 0;
  if (byteLength(s) <= n) return s;
  const runes = Array.from(s);
  let end = 0;
  let bytes = 0;
  for (const r of runes) {
    const size = byteLength(r);
    if (bytes + size > n) break;
    bytes += size;
    end++;
  }
  return runes.slice(0, end).join("");
}

function editableState(node: AxNode): string {
  for (const prop of node.properties ?? []) {
    if (prop.name !== "editable") continue;
    const v = prop.value.value;
    if (typeof v === "string") {
      if (v !== "" && v !== "false") return v;
    } else if (v === true) {
      return "editable";
    }
  }
  return "";
}

function isInteractiveNode(node: AxNode, role: string): boolean {
  return interactiveRoles.has(role) || editableState(node) !== "";
}

/** Formats the accessibility tree into a readable string. */
export function formatAxTree(nodes: AxNode[], opts?: SnapshotOptions): string {
  if (nodes.length === 0) return "(empty page)";
  const nodeMap = new Map<string, AxNode>();
  for (const n of nodes) nodeMap.set(n.nodeId, n);
  const interactive = opts?.interactive === true;

  const lines: string[] = [];
  let refCounter = 0;

  const walk = (nodeId: string, depth: number): void => {
    const node = nodeMap.get(nodeId);
    if (!node || node.ignored) return;
    const role = node.role ? String(node.role.value ?? "") : "";
    const name = node.name ? String(node.name.value ?? "") : "";
    const interactiveNode = isInteractiveNode(node, role);

    if (interactive && !interactiveNode) {
      for (const childId of node.childIds ?? []) walk(childId, depth);
      return;
    }

    const indent = "  ".repeat(depth);
    let refId = "";
    if (interactiveNode) {
      refCounter++;
      refId = `[${refCounter}]`;
    }

    let displayRole = role;
    const editable = editableState(node);
    if (editable !== "" && !interactiveRoles.has(role)) displayRole = "editor";

    let line = indent;
    if (refId !== "") line += refId + " ";
    line += displayRole;
    if (name !== "") line += " " + name;

    for (const prop of node.properties ?? []) {
      switch (prop.name) {
        case "checked": {
          const v = String(prop.value.value ?? "");
          if (v !== "") line += ` [${v}]`;
          break;
        }
        case "expanded": {
          const v = String(prop.value.value ?? "");
          if (v !== "") line += ` [expanded:${v}]`;
          break;
        }
        case "disabled": {
          if (String(prop.value.value ?? "") === "true") line += " [disabled]";
          break;
        }
      }
    }
    if (editable !== "") line += ` [editable:${editable}]`;

    lines.push(line);
    for (const childId of node.childIds ?? []) walk(childId, depth + 1);
  };

  const childSet = new Set<string>();
  for (const node of nodes) {
    for (const childId of node.childIds ?? []) childSet.add(childId);
  }
  const roots: string[] = [];
  for (const node of nodes) {
    if (!childSet.has(node.nodeId)) roots.push(node.nodeId);
  }
  for (const rootId of roots) walk(rootId, 0);

  if (interactive && lines.length === 0) {
    const rootCount = roots.length === 0 ? nodes.length : roots.length;
    return `(no interactive elements found; page has ${rootCount} top-level nodes, retry without interactive=true)`;
  }
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

async function createTarget(host: string, port: number): Promise<Target> {
  const resp = await fetch(`http://${host}:${port}/json/new?about:blank`);
  return targetFrom(await resp.json() as Partial<Target>);
}

function targetFrom(t: Partial<Target>): Target {
  return {
    id: t.id ?? "",
    title: t.title ?? "",
    url: t.url ?? "",
    type: t.type ?? "",
    webSocketDebuggerUrl: t.webSocketDebuggerUrl ?? "",
  };
}

/** Re-exported so callers can detect CDP protocol errors. */
export { CdpError };
export type { CdpMessage };
