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
  htmlOptionsFromParams,
  isToolRegistered,
  newTool,
  registerTool,
  removeTool,
  SkillName,
  ToolName,
} from "./tool.ts";
export { Client, type Options } from "./client.ts";
export { Browser } from "./ops.ts";
export {
  BrowserBrave,
  BrowserChrome,
  BrowserChromeCanary,
  BrowserChromium,
  BrowserEdge,
  type BrowserType,
  type ClickOptions,
  type Cookie,
  DefaultHTMLMaxBytes,
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
