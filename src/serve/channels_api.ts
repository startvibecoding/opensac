// Ported from internal/serve/channels_api.go: the WeChat QR-login HTTP surface
// (wechatLoginSession state machine, login/QR handlers, QR fetch/proxy/decode
// helpers), the wechat credential-path resolution, and the post-login config
// enablement transaction. syncPlatformRuntime lives in channel_runtime.ts with
// the rest of the channelRuntime lifecycle.
//
// Deviations: Go's golang.org/x/net/html parser maps to a targeted tag
// scanner — the QR extraction contract only needs img/source/meta/link
// candidate attributes, and Deno ships no HTML parser. Go's net/http cookie
// jar + auto-redirect client maps to a manual-redirect fetch that forwards
// accumulated Set-Cookie headers. `http.DetectContentType` maps to a minimal
// magic-byte sniff over the content types the QR path can produce.

import { join } from "@std/path";
import type { ServeConfigState } from "./config_state.ts";
import type { ChannelRuntime } from "./channel_runtime.ts";
import { writeJson } from "./http.ts";
import { configDir } from "../config/settings.ts";
import {
  Client,
  commonHeaders,
  DefaultBaseURL,
} from "../messaging/wechat/protocol.ts";
import { loadCredentials, login } from "../messaging/wechat/auth.ts";
import type { LoginOptions } from "../messaging/wechat/auth.ts";
import type { Credentials } from "../messaging/wechat/types.ts";

const QR_FETCH_TIMEOUT_MS = 20_000;
const QR_MAX_BYTES = 4 << 20;

/** errorString ports run.go's helper over unknown values. */
export function errorString(err: unknown): string {
  if (err === null || err === undefined) return "";
  return err instanceof Error ? err.message : String(err);
}

// --- wechatLoginSession --------------------------------------------------------

export interface WechatLoginStatus {
  state: string;
  qrUrl?: string;
  qrOpenUrl?: string;
  error?: string;
  userId?: string;
  startedAt?: string;
  updatedAt?: string;
  enabled: boolean;
  loggedIn: boolean;
}

export interface WechatLoginQRResponse {
  dataUrl: string;
  base64: string;
  contentType: string;
}

/**
 * WechatLoginSession tracks one QR login attempt for the Web UI: its QR
 * payload, phase transitions, and cancellation. Go's mutex maps to the Deno
 * event loop; the abort controller replaces context cancellation.
 */
export class WechatLoginSession {
  readonly cancel: () => void;
  state = "starting";
  qrURL = "";
  err = "";
  userID = "";
  startedAt = new Date();
  updatedAt = new Date();

  constructor() {
    const controller = new AbortController();
    this.cancel = () => controller.abort();
    this.signal = controller.signal;
  }

  readonly signal: AbortSignal;

  update(state: string, fn?: () => void): void {
    if (state !== "") this.state = state;
    fn?.();
    this.updatedAt = new Date();
  }

  snapshot(enabled: boolean): WechatLoginStatus {
    const out: WechatLoginStatus = {
      state: this.state,
      error: this.err || undefined,
      userId: this.userID || undefined,
      enabled,
      loggedIn: this.state === "confirmed",
    };
    if (this.qrURL !== "") {
      const proxyURL =
        `/api/channels/wechat/login/qr?ts=${this.updatedAt.getTime()}000`;
      out.qrUrl = proxyURL;
      out.qrOpenUrl = qrOpenURL(this.qrURL, proxyURL);
    }
    out.startedAt = this.startedAt.toISOString();
    out.updatedAt = this.updatedAt.toISOString();
    return out;
  }

  static idle(enabled: boolean): WechatLoginStatus {
    return { state: "idle", enabled, loggedIn: false };
  }

  active(): boolean {
    switch (this.state) {
      case "confirmed":
      case "error":
      case "cancelled":
        return false;
      default:
        return true;
    }
  }

  /** cancelLogin aborts the flow and marks the session cancelled. */
  cancelLogin(): void {
    this.cancel();
    this.update("cancelled");
  }
}

// --- handlers --------------------------------------------------------------------

export function handleWechatLogin(
  rt: ChannelRuntime | null,
  configPath: string,
): (request: Request) => Response {
  return (request) => {
    switch (request.method) {
      case "GET":
        return writeJson(() => {}, 200, wechatLoginSnapshot(rt));
      case "POST": {
        const cfg = rt?.configSnapshot() ?? null;
        if (rt === null || cfg === null) {
          return writeJson(() => {}, 503, {
            error: "channel runtime unavailable",
          });
        }
        const current = rt.wechatLogin;
        if (current !== null && current.active()) current.cancelLogin();
        const sess = new WechatLoginSession();
        rt.wechatLogin = sess;
        const credPath = wechatCredPath(rt);
        void runWechatLogin(rt, sess, configPath, credPath);
        return writeJson(
          () => {},
          202,
          sess.snapshot(cfg.channels.wechat.enabled),
        );
      }
      case "DELETE": {
        const current = rt?.wechatLogin ?? null;
        if (current !== null) current.cancelLogin();
        return writeJson(() => {}, 200, wechatLoginSnapshot(rt));
      }
      default:
        return new Response(null, { status: 405 });
    }
  };
}

export function handleWechatLoginQR(
  rt: ChannelRuntime | null,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "GET") {
      return new Response(null, { status: 405 });
    }
    const current = rt?.wechatLogin ?? null;
    let source = current?.qrURL ?? "";
    source = source.trim();
    if (source === "") {
      return writeJson(() => {}, 404, { error: "QR code is not available" });
    }
    if (source.startsWith("//")) source = "https:" + source;
    const format = new URL(request.url).searchParams.get("format");
    if (format === "base64") {
      return await serveWechatQRBase64(source);
    }
    if (source.startsWith("http://") || source.startsWith("https://")) {
      return await proxyWechatQR(source);
    }
    return serveInlineQR(source);
  };
}

export async function serveWechatQRBase64(
  source: string,
): Promise<Response> {
  let data: Uint8Array;
  let contentType: string;
  try {
    if (source.startsWith("http://") || source.startsWith("https://")) {
      [data, contentType] = await fetchWechatQRImage(source);
    } else {
      [data, contentType] = decodeInlineQR(source);
    }
  } catch (err) {
    return writeJson(() => {}, 502, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (contentType === "") contentType = detectContentType(data);
  if (startsWithSVGLike(data)) contentType = "image/svg+xml";
  const encoded = base64Encode(data);
  return writeJson(
    () => {},
    200,
    {
      dataUrl: `data:${contentType};base64,${encoded}`,
      base64: encoded,
      contentType,
    } satisfies WechatLoginQRResponse,
  );
}

export async function proxyWechatQR(source: string): Promise<Response> {
  let data: Uint8Array;
  let contentType: string;
  try {
    [data, contentType] = await fetchWechatQRImage(source);
  } catch (err) {
    return writeJson(() => {}, 502, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (contentType === "") contentType = detectContentType(data);
  if (startsWithSVGLike(data)) contentType = "image/svg+xml";
  return new Response(data.slice(), {
    status: 200,
    headers: new Headers({
      "content-type": contentType,
      "cache-control": "no-store",
    }),
  });
}

export async function fetchWechatQRImage(
  source: string,
): Promise<[Uint8Array, string]> {
  const jar = new CookieJar();
  const [data, contentType, finalURL] = await fetchWechatQRURL(
    jar,
    source,
    DefaultBaseURL + "/",
  );
  if (!isHTMLResponse(contentType, data)) return [data, contentType];
  const imageURL = extractQRCodeImageURL(data, finalURL);
  if (imageURL.startsWith("data:image/")) {
    return decodeQRDataURL(imageURL);
  }
  const [image, imageType] = await fetchWechatQRURL(jar, imageURL, finalURL);
  return [image, imageType];
}

/**
 * fetchWechatQRURL ports channels_api.go's cookie-jar client: fetch with the
 * transport's common headers, follow redirects forwarding accumulated
 * cookies, and bound the body at 4 MiB.
 */
export async function fetchWechatQRURL(
  jar: CookieJar,
  source: string,
  referer: string,
): Promise<[Uint8Array, string, string]> {
  let url = source;
  let currentReferer = referer;
  for (let redirects = 0; redirects <= 10; redirects++) {
    const response = await fetchWithTimeout(url, {
      redirect: "manual",
      headers: mergeHeaders(
        commonHeaders(),
        new Headers({
          "accept":
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,text/html,*/*;q=0.8",
          referer: currentReferer,
          "user-agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) MothX-Serve Safari/537.36",
          cookie: jar.cookiesFor(url),
        }),
      ),
    });
    jar.storeFrom(response, url);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location !== null) {
        currentReferer = url;
        url = new URL(location, url).toString();
        continue;
      }
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `QR upstream returned ${response.status} ${response.statusText}`,
      );
    }
    const buffer = await response.arrayBuffer();
    const data = buffer.byteLength > QR_MAX_BYTES
      ? new Uint8Array(buffer.slice(0, QR_MAX_BYTES))
      : new Uint8Array(buffer);
    const contentType = (response.headers.get("content-type") ?? "").split(
      ";",
    )[0].trim();
    return [data, contentType, url];
  }
  throw new Error("QR upstream returned too many redirects");
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  return await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(QR_FETCH_TIMEOUT_MS),
  });
}

function mergeHeaders(...sources: Headers[]): Headers {
  const out = new Headers();
  for (const source of sources) {
    source.forEach((value, key) => {
      if (value !== "") out.set(key, value);
    });
  }
  return out;
}

/** CookieJar ports the minimal cookie-jar behavior the QR flow relies on. */
export class CookieJar {
  readonly #cookies = new Map<string, string>();

  storeFrom(response: Response, requestURL: string): void {
    const setCookies = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
    for (const raw of setCookies) {
      const pair = raw.split(";", 1)[0];
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || value.toLowerCase() === "deleted") {
        this.#cookies.delete(name);
        continue;
      }
      this.#cookies.set(name, value);
    }
    void requestURL;
  }

  cookiesFor(_url: string): string {
    const parts: string[] = [];
    for (const [name, value] of this.#cookies) {
      parts.push(`${name}=${value}`);
    }
    return parts.join("; ");
  }
}

export function isHTMLResponse(contentType: string, data: Uint8Array): boolean {
  const base = contentType.split(";")[0].trim().toLowerCase();
  if (base === "text/html" || base === "application/xhtml+xml") return true;
  const sample = new TextDecoder().decode(
    data.slice(0, Math.min(data.length, 512)),
  ).trim().toLowerCase();
  return sample.startsWith("<!doctype html") || sample.startsWith("<html");
}

/**
 * extractQRCodeImageURL ports the x/net/html walk: collect candidate image
 * URLs from img/source src-like attributes, og:image/twitter:image meta tags,
 * and image rel links, then resolve the first one against the page URL.
 */
export function extractQRCodeImageURL(
  data: Uint8Array,
  baseURL: string,
): string {
  const html = new TextDecoder().decode(data);
  const candidates: string[] = [];
  const tagPattern = /<(img|source|meta|link)\b([^>]*)>/gi;
  for (const match of html.matchAll(tagPattern)) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    if (tag === "img" || tag === "source") {
      for (const key of ["src", "data-src", "data-original", "data-url"]) {
        const value = attrValue(attrs, key);
        if (value !== "") candidates.push(value);
      }
    } else if (tag === "meta") {
      const property = attrValue(attrs, "property").toLowerCase();
      const name = attrValue(attrs, "name").toLowerCase();
      if (property === "og:image" || name === "twitter:image") {
        const value = attrValue(attrs, "content");
        if (value !== "") candidates.push(value);
      }
    } else if (tag === "link") {
      if (attrValue(attrs, "rel").toLowerCase().includes("image")) {
        const value = attrValue(attrs, "href");
        if (value !== "") candidates.push(value);
      }
    }
  }
  for (const candidate of candidates) {
    const resolved = resolveQRCodeImageURL(candidate, baseURL);
    if (resolved !== null) return resolved;
  }
  throw new Error("no QR image found");
}

/** attrValue scans one attribute string case-insensitively. */
function attrValue(attrs: string, key: string): string {
  const pattern = new RegExp(
    `${
      key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    "i",
  );
  const match = pattern.exec(attrs);
  if (match === null) return "";
  return (match[2] ?? match[3] ?? match[4] ?? "").trim();
}

export function resolveQRCodeImageURL(
  raw: string,
  baseURL: string,
): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.toLowerCase().startsWith("javascript:")) {
    return null;
  }
  if (trimmed.startsWith("data:image/")) return trimmed;
  try {
    return new URL(trimmed, baseURL).toString();
  } catch {
    return null;
  }
}

export function decodeQRDataURL(source: string): [Uint8Array, string] {
  const comma = source.indexOf(",");
  if (comma < 0) throw new Error("invalid QR data URL");
  const header = source.slice(0, comma);
  const body = source.slice(comma + 1);
  let contentType = header.split(";")[0].replace(/^data:/, "");
  if (contentType === "") contentType = "image/png";
  return [base64Decode(body), contentType];
}

export function serveInlineQR(source: string): Response {
  let data: Uint8Array;
  let contentType: string;
  try {
    [data, contentType] = decodeInlineQR(source);
  } catch {
    data = new TextEncoder().encode(source);
    contentType = detectContentType(data);
    if (source.trim().startsWith("<svg")) contentType = "image/svg+xml";
  }
  return new Response(data.slice(), {
    status: 200,
    headers: new Headers({
      "content-type": contentType,
      "cache-control": "no-store",
    }),
  });
}

export function decodeInlineQR(source: string): [Uint8Array, string] {
  let contentType = "image/png";
  let payload = source;
  if (source.startsWith("data:")) {
    const comma = source.indexOf(",");
    if (comma < 0) throw new Error("invalid QR data URL");
    const header = source.slice(0, comma);
    payload = source.slice(comma + 1);
    const media = header.split(";")[0].replace(/^data:/, "");
    if (media !== "") contentType = media;
  }
  return [base64Decode(payload), contentType];
}

export function qrOpenURL(source: string, fallback: string): string {
  const trimmed = source.trim();
  if (trimmed === "") return fallback;
  if (trimmed.startsWith("//")) return "https:" + trimmed;
  if (
    trimmed.startsWith("http://") || trimmed.startsWith("https://") ||
    trimmed.startsWith("data:")
  ) {
    return trimmed;
  }
  try {
    base64Decode(trimmed);
    return "data:image/png;base64," + trimmed;
  } catch {
    return fallback;
  }
}

// --- runtime projections ----------------------------------------------------------

export function wechatLoginSnapshot(
  rt: ChannelRuntime | null,
): WechatLoginStatus {
  const cfg = rt?.configSnapshot() ?? null;
  const enabled = cfg !== null && cfg.channels.wechat.enabled;
  const current = rt?.wechatLogin ?? null;
  if (current !== null) return current.snapshot(enabled);
  const credPath = rt === null ? "" : wechatCredPath(rt);
  if (credPath !== "") {
    let creds: ReturnType<typeof loadCredentials> = null;
    try {
      creds = loadCredentials(credPath);
    } catch {
      creds = null;
    }
    if (creds !== null) {
      return {
        state: "confirmed",
        userId: creds.userId,
        enabled,
        loggedIn: true,
      };
    }
  }
  return WechatLoginSession.idle(enabled);
}

/** runWechatLogin drives the login flow and mirrors its phases to the UI. */
export async function runWechatLogin(
  rt: ChannelRuntime,
  sess: WechatLoginSession,
  configPath: string,
  credPath: string,
): Promise<void> {
  const client = new Client();
  const opts: LoginOptions = {
    baseURL: DefaultBaseURL,
    credPath,
    force: true,
    onQRURL: (url) => {
      sess.update("pending", () => {
        sess.qrURL = url;
        sess.err = "";
      });
    },
    onScanned: () => sess.update("scanned"),
    onExpired: () => sess.update("expired"),
  };
  let creds: Credentials | null = null;
  try {
    creds = await login(sess.signal, client, opts);
  } catch (err) {
    const state = sess.signal.aborted ? "cancelled" : "error";
    sess.update(state, () => {
      sess.err = err instanceof Error ? err.message : String(err);
    });
    return;
  }
  if (creds === null) {
    sess.update("error", () => {
      sess.err = "login returned empty credentials";
    });
    return;
  }
  try {
    await enableWechatAfterLogin(rt, configPath, credPath);
  } catch (err) {
    sess.update("error", () => {
      sess.userID = creds!.userId;
      sess.err = err instanceof Error ? err.message : String(err);
    });
    return;
  }
  sess.update("confirmed", () => {
    sess.userID = creds!.userId;
    sess.err = "";
  });
}

/** enableWechatAfterLogin persists the wechat enablement in one transaction. */
export async function enableWechatAfterLogin(
  rt: ChannelRuntime,
  configPath: string,
  credPath: string,
): Promise<void> {
  const cfg = rt.configSnapshot();
  if (cfg === null) return;
  const state = rt.configState ?? await loadFallbackConfigState(configPath);
  if (rt.configState === null) rt.configState = state;
  let configuredCredPath = cfg.channels.wechat.credPath;
  if (configuredCredPath === "" && credPath !== defaultWechatCredPath()) {
    configuredCredPath = credPath;
  }
  const body = JSON.stringify({
    enabled: true,
    credPath: configuredCredPath,
    workDir: cfg.channels.wechat.workDir,
    autoTyping: cfg.channels.wechat.autoTyping,
  });
  try {
    const result = await state.updateChannel(
      "wechat",
      body,
      (next) => rt.applyConfigUpdate(next),
    );
    rt.publishManagementEvent("channel_config_changed", {
      platform: "wechat",
      layer: result.layer,
      path: result.path,
      source: "wechat_login",
      restart: result.restart,
    });
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * loadFallbackConfigState reproduces Go's lazily constructed
 * ServeConfigState{WritablePath: path, WritableLayer: explicit} when the run
 * assembly has not installed the runtime state yet.
 */
async function loadFallbackConfigState(
  configPath: string,
): Promise<ServeConfigState> {
  const { ServeConfigState } = await import("./config_state.ts");
  const { defaultRunOptions } = await import("./options.ts");
  const opts = defaultRunOptions();
  opts.configPath = configPath;
  return ServeConfigState.load(opts);
}

export function wechatCredPath(rt: ChannelRuntime | null): string {
  const cfg = rt?.configSnapshot() ?? null;
  if (cfg !== null && cfg.channels.wechat.credPath !== "") {
    return cfg.channels.wechat.credPath;
  }
  return defaultWechatCredPath();
}

export function defaultWechatCredPath(): string {
  return join(configDir(), "wechat-credentials.json");
}

// --- small helpers -----------------------------------------------------------------

function startsWithSVGLike(data: Uint8Array): boolean {
  const sample = new TextDecoder().decode(
    data.slice(0, Math.min(data.length, 64)),
  ).trimStart();
  return sample.startsWith("<svg") || sample.startsWith("<?xml");
}

/**
 * detectContentType ports the slice of Go's http.DetectContentType the QR
 * path can produce: common image magic bytes, HTML, and SVG fallthrough.
 */
export function detectContentType(data: Uint8Array): string {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8) {
    return "image/jpeg";
  }
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49) {
    return "image/gif";
  }
  if (
    data.length >= 12 && data[0] === 0x52 && data[1] === 0x49 &&
    data[8] === 0x57 && data[9] === 0x45
  ) {
    return "image/webp";
  }
  const head = new TextDecoder().decode(
    data.slice(0, Math.min(data.length, 512)),
  ).trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
    return "text/html; charset=utf-8";
  }
  if (head.startsWith("<svg") || head.startsWith("<?xml")) {
    return "image/svg+xml";
  }
  return "application/octet-stream";
}

function base64Encode(data: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64Decode(text: string): Uint8Array {
  const cleaned = text.replace(/\s+/g, "");
  const binary = atob(cleaned);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
