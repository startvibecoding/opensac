// Ported from vibe-browser pkg/protocol/types.go (v0.1.5).
//
// The protocol defines the core types and message format for the external
// vibe-browser SDK. The wire format is JSON-RPC style over Unix domain sockets
// (daemon mode) or direct in-process calls (SDK mode). Every command carries
// an action name and arbitrary extra fields; every response carries success,
// optional data, and an optional error string.
//
// Deviations from Go: `json.RawMessage` fields map to decoded `unknown` /
// plain JSON values; `time.Time` maps to `Date`; Go struct tags are preserved
// as the canonical camelCase wire keys, so the buckets below use those keys
// directly rather than a tag-mapping helper.

/** Request is the wire format for a command sent to the daemon. */
export interface Request {
  id: string;
  action: string;
  extra?: unknown;
}

/** Response is the wire format for a result returned by the daemon. */
export interface Response {
  success: boolean;
  data?: unknown;
  error?: string;
  warning?: string;
}

/** NavigationOptions configure page navigation. */
export interface NavigationOptions {
  /** load, domcontentloaded, networkidle */
  waitUntil?: string;
  /** milliseconds */
  timeout?: number;
}

/** ClickOptions configure a click action. */
export interface ClickOptions {
  /** left, right, middle */
  button?: string;
  clickCount?: number;
  /** ms between down and up */
  delay?: number;
}

/** FillOptions configure a fill action. */
export interface FillOptions {
  timeout?: number;
}

/** ScreenshotOptions configure screenshot capture. */
export interface ScreenshotOptions {
  /** png, jpeg, webp */
  format?: string;
  quality?: number;
  fullPage?: boolean;
  selector?: string;
  clipX?: number;
  clipY?: number;
  clipWidth?: number;
  clipHeight?: number;
}

/** SnapshotOptions configure accessibility tree snapshot. */
export interface SnapshotOptions {
  selector?: string;
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  urls?: boolean;
}

/**
 * DefaultHTMLMaxBytes is the soft cap applied to GetHTML results when no
 * explicit maxBytes is requested.
 */
export const DefaultHTMLMaxBytes = 50 * 1024;

/**
 * HTMLOptions configures GetHTML output. It is the size-control counterpart to
 * SnapshotOptions. See the Go source for the exact truncation semantics.
 */
export interface HTMLOptions {
  maxBytes?: number;
  maxChars?: number;
}

/** WaitOptions configure wait actions. */
export interface WaitOptions {
  /** milliseconds */
  timeout?: number;
  selector?: string;
  text?: string;
  url?: string;
  /** load, domcontentloaded, networkidle */
  loadState?: string;
  function?: string;
}

/** BrowserType identifies a Chromium-family browser to launch. */
export type BrowserType =
  | "chrome"
  | "chromium"
  | "brave"
  | "edge"
  | "chrome-canary"
  | "";

export const BrowserChrome: BrowserType = "chrome";
export const BrowserChromium: BrowserType = "chromium";
export const BrowserBrave: BrowserType = "brave";
export const BrowserEdge: BrowserType = "edge";
export const BrowserChromeCanary: BrowserType = "chrome-canary";

/** LaunchOptions configure browser launch. */
export interface LaunchOptions {
  browser?: BrowserType;
  headless?: boolean;
  executablePath?: string;
  args?: string[];
  proxy?: string;
  userDataDir?: string;
  viewportWidth?: number;
  viewportHeight?: number;
  deviceScaleFactor?: number;
  ignoreHttpsErrors?: boolean;
  /** light, dark, no-preference */
  colorScheme?: string;
  locale?: string;
  timezone?: string;
  geolocation?: Geolocation;
  offline?: boolean;
  extensions?: string[];
  profile?: string;
}

/** Geolocation represents geographic coordinates. */
export interface Geolocation {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

/** SessionInfo holds metadata about a daemon session. */
export interface SessionInfo {
  name: string;
  pid: number;
  version?: string;
  engine?: string;
  provider?: string;
  startTime?: Date;
}

/** TabInfo describes a browser tab. */
export interface TabInfo {
  id: string;
  title: string;
  url: string;
  isActive: boolean;
  isAttached: boolean;
}

/** NetworkRequest describes a captured network request. */
export interface NetworkRequest {
  requestId: string;
  url: string;
  method: string;
  headers?: Record<string, string>;
  postData?: string;
  resourceType: string;
  timestamp: number;
  status?: number;
  responseHeaders?: Record<string, string>;
  mimeType?: string;
}

/** Cookie represents a browser cookie. */
export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

/** StorageEntry represents a localStorage/sessionStorage entry. */
export interface StorageEntry {
  key: string;
  value: string;
}

/** NodeRef is a reference to a DOM node via accessibility tree ref ID. */
export interface NodeRef {
  refId: string;
  role: string;
  name: string;
}

/** ActionResult is the generic result of an action command. */
export interface ActionResult {
  success: boolean;
  message?: string;
  data?: unknown;
}
