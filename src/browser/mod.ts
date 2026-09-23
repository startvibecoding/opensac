// Public surface of src/browser (ported from internal/browser + the vibe-browser
// SDK packages it depends on).
//
// The opensac `browser` tool controls a Chromium-family browser through the
// ported vibe-browser client, which supports direct CDP mode (`Client.open`)
// and daemon mode (`Client.connect`).

export {
  BrowserTool,
  clientOptions,
  cookieFromParams,
  createTool,
  htmlOptionsFromParams,
  isToolRegistered,
  registerTool,
  removeTool,
  SKILL_NAME,
  TOOL_NAME,
} from "./tool.ts";
export { Client, type Options } from "./client.ts";
export { Browser } from "./ops.ts";
export {
  BROWSER_BRAVE,
  BROWSER_CHROME,
  BROWSER_CHROME_CANARY,
  BROWSER_CHROMIUM,
  BROWSER_EDGE,
  type BrowserType,
  type ClickOptions,
  type Cookie,
  DEFAULT_HTML_MAX_BYTES,
  type Geolocation,
  type HTMLOptions,
  type LaunchOptions,
  type NavigationOptions,
  type NetworkRequest,
  type NodeRef,
  type Response,
  type ScreenshotOptions,
  type SessionInfo,
  type SnapshotOptions,
  type StorageEntry,
  type TabInfo,
  type WaitOptions,
} from "./protocol.ts";
