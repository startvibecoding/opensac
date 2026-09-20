// Ported from internal/serve/run.go (HTTP projection helpers that do not
// depend on the OpenAI-compatible API server): JSON responses, the
// `/api/status` snapshot, and the Web UI static-file/SPA handler. The route
// table and channel/session managers land with later #36 slices.

import {
  extname,
  fromFileUrl,
  isAbsolute,
  join,
  normalize,
  resolve,
} from "@std/path";
import type { ServeConfig } from "./config.ts";
import { displayListenAddr } from "./options.ts";

export interface ChannelStatusView {
  name: string;
  enabled: boolean;
  connected: boolean;
}

export interface FeatureStatus {
  webUI: boolean;
  openAIAPI: boolean;
  wechat: boolean;
  feishu: boolean;
  multiAgent: boolean;
  delegate: boolean;
  webSearch: boolean;
  browser: boolean;
  a2aMaster: boolean;
  workflows: boolean;
  cron: boolean;
  memory: boolean;
}

export interface ServeStatus {
  status: string;
  listen: string;
  features: FeatureStatus;
  webUI: { enabled: boolean; dir: string };
  channels: ChannelStatusView[];
  sessions: number;
}

/** Projects effective config into the status endpoint's feature matrix. */
export function featureStatusFromConfig(cfg: ServeConfig): FeatureStatus {
  return {
    webUI: cfg.features.webUI,
    openAIAPI: cfg.features.openAIAPI,
    wechat: cfg.features.wechat,
    feishu: cfg.features.feishu,
    multiAgent: cfg.features.multiAgent,
    delegate: cfg.api.enableDelegate,
    webSearch: cfg.api.enableWebSearch,
    browser: cfg.api.enableBrowser,
    a2aMaster: cfg.api.enableA2AMaster,
    workflows: cfg.api.enableWorkflows,
    cron: cfg.features.cron,
    memory: cfg.features.memory,
  };
}

export interface StatusSnapshotOptions {
  config?: ServeConfig;
  channels?: ChannelStatusView[];
  sessions?: number;
  /** settings.json-level web search availability (OR-ed into the feature). */
  webSearchAvailable?: boolean;
}

/** Builds the `/api/status` payload without touching live runtimes. */
export function buildServeStatus(opts: StatusSnapshotOptions): ServeStatus {
  const status: ServeStatus = {
    status: "ok",
    listen: "",
    features: {
      webUI: false,
      openAIAPI: false,
      wechat: false,
      feishu: false,
      multiAgent: false,
      delegate: false,
      webSearch: false,
      browser: false,
      a2aMaster: false,
      workflows: false,
      cron: false,
      memory: false,
    },
    webUI: { enabled: false, dir: "" },
    channels: opts.channels ?? [],
    sessions: opts.sessions ?? 0,
  };
  const cfg = opts.config;
  if (cfg !== undefined) {
    status.listen = displayListenAddr(cfg.api.listen);
    status.features = featureStatusFromConfig(cfg);
    status.webUI = { enabled: cfg.webUI.enabled, dir: cfg.webUI.dir };
  }
  if (opts.webSearchAvailable) status.features.webSearch = true;
  return status;
}

/** JSON response helper with the same Content-Type/encoding as writeJSON. */
export function writeJson(
  responseInit: (init: ResponseInit) => void,
  status: number,
  body: unknown,
): Response {
  const init: ResponseInit = {
    status,
    headers: new Headers({ "content-type": "application/json" }),
  };
  responseInit(init);
  return new Response(JSON.stringify(body) + "\n", init);
}

const WEB_UI_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const MISSING_WEB_UI_MESSAGE =
  "Web UI assets not found. Build ui/dist or set webUI.dir to a built frontend directory.";

export interface WebUIHandlerOptions {
  /** Built asset directory; "" selects the embedded default resolution. */
  dir: string;
  /** Overrides disk reads (compiled binary embedding in later slices). */
  readFile?: (relative: string) => Uint8Array | undefined;
  /** Overrides file existence checks when readFile is supplied. */
  exists?: (relative: string) => boolean;
}

/**
 * Serves the built SPA: real assets from disk/embed, index.html for unknown
 * routes, 503 when the frontend has not been built. Ports `uiHandler`/
 * `uiFSHandler`/`serveUIIndex` without net/http's FileServer.
 */
export function createWebUIHandler(
  options: WebUIHandlerOptions,
): (request: Request) => Response {
  const root = resolveWebUIDir(options.dir);
  const read = (relative: string): Uint8Array | undefined => {
    if (options.readFile !== undefined) {
      return options.readFile!(relative);
    }
    try {
      return Deno.readFileSync(join(root, relative));
    } catch {
      return undefined;
    }
  };
  const exists = (relative: string): boolean => {
    if (options.exists !== undefined) return options.exists!(relative);
    try {
      return Deno.statSync(join(root, relative)).isFile;
    } catch {
      return false;
    }
  };

  return (request: Request) => {
    const url = new URL(request.url);
    let name = safeRelativePath(url.pathname);
    if (name === "") name = "index.html";
    if (name !== "index.html" && exists(name)) {
      const fileData = read(name);
      if (fileData !== undefined) return assetResponse(name, fileData.slice());
    }
    if (exists("index.html")) {
      const index = read("index.html");
      if (index !== undefined) {
        return new Response(index.slice(), {
          status: 200,
          headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        });
      }
    }
    return new Response(MISSING_WEB_UI_MESSAGE, { status: 503 });
  };
}

function assetResponse(name: string, data: Uint8Array): Response {
  const type = WEB_UI_CONTENT_TYPES[extname(name).toLowerCase()] ??
    "application/octet-stream";
  return new Response(data.slice(), {
    status: 200,
    headers: new Headers({ "content-type": type }),
  });
}

/** Prevents path traversal above the asset root (ports path.Clean + prefix). */
export function safeRelativePath(urlPath: string): string {
  const decoded = decodeURIComponent(urlPath);
  // Walk segments with a depth counter so any escape above the asset root
  // (`../x`, `/a/../../b`) is rejected while in-root `a/../b` resolves.
  const resolved: string[] = [];
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (resolved.length === 0) return "";
      resolved.pop();
    } else {
      resolved.push(segment);
    }
  }
  return resolved.join("/");
}

const DEFAULT_WEB_UI_DIR = "ui/dist";

/** Reports whether the dir selects compiled-in assets ("" or ui/dist). */
export function useEmbeddedWebUIDir(dir: string): boolean {
  return dir === "" ||
    normalize(dir).replaceAll("\\", "/") === DEFAULT_WEB_UI_DIR;
}

export function hasUIIndex(dir: string): boolean {
  try {
    return Deno.statSync(join(dir, "index.html")).isFile;
  } catch {
    return false;
  }
}

/**
 * Resolves a webUI.dir value to a filesystem directory. Ports
 * resolveWebUIDir: cwd-relative first, then executable-adjacent/share paths.
 */
export function resolveWebUIDir(dir: string): string {
  if (dir === "") dir = DEFAULT_WEB_UI_DIR;
  if (isAbsolute(dir)) return dir;
  const cwdCandidate = resolve(Deno.cwd(), dir);
  if (hasUIIndex(cwdCandidate)) return cwdCandidate;
  try {
    const exePath = fromFileUrl(Deno.execPath());
    const exeDir = resolve(exePath, "..");
    for (
      const candidate of [
        join(exeDir, dir),
        join(exeDir, "..", "share", "mothx", dir),
      ]
    ) {
      if (hasUIIndex(candidate)) return candidate;
    }
  } catch {
    // exec path unavailable (restricted runtime): fall through
  }
  return cwdCandidate;
}
