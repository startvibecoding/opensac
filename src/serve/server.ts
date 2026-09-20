// Minimal serve HTTP bootstrap (first #36 runtime slice). Owns the Deno.serve
// listener, the startup banner, and the route table that exists without the
// OpenAI-compatible API server: `/api/status` and the Web UI SPA. The chat
// completions API, sessions, channels, cron, and management routes arrive in
// later slices by extending `createServeRouter`; this module deliberately has
// no agent/DAO dependencies.

import {
  applyOverrides,
  applyRuntimeFeatures,
  defaultRunOptions,
  type RunOptions,
} from "./options.ts";
import {
  configPath,
  decodeConfigBytesInto,
  loadConfigFrom,
  projectConfigPath,
  type ServeConfig,
} from "./config.ts";
import {
  buildServeStatus,
  type ChannelStatusView,
  createWebUIHandler,
} from "./http.ts";

export interface ServeHttpHandle {
  server: Deno.HttpServer;
  port: number;
  hostname: string;
  shutdown: () => Promise<void>;
}

export interface StartServeHttpOptions {
  config: ServeConfig;
  channels?: ChannelStatusView[];
  sessions?: number;
  /** Inject for tests; defaults to the real Deno.serve. */
  listen?: Deno.ServeTcpOptions;
  signal?: AbortSignal;
  onListen?: (params: { hostname: string; port: number }) => void;
}

function loadServeRuntimeConfig(opts: RunOptions): ServeConfig {
  const cfg = opts.configPath !== ""
    ? loadConfigFrom(opts.configPath)
    : loadLayeredConfig();
  applyOverrides(cfg, opts);
  applyRuntimeFeatures(cfg);
  return cfg;
}

function loadLayeredConfig(): ServeConfig {
  // Global seeds defaults; the project layer overlays when present.
  const cfg = loadConfigFrom(configPath());
  try {
    const text = Deno.readTextFileSync(projectConfigPath());
    decodeConfigBytesInto(cfg, text);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return cfg;
}

/** Splits a `[host]:port` / `:port` listen value for Deno.serve. */
export function parseListenAddr(listen: string): {
  hostname: string;
  port: number;
} {
  const value = listen.trim() || "127.0.0.1:7872";
  if (value.startsWith(":")) {
    return { hostname: "0.0.0.0", port: Number(value.slice(1)) };
  }
  const lastColon = value.lastIndexOf(":");
  if (lastColon === -1) {
    return { hostname: "0.0.0.0", port: Number(value) };
  }
  const hostname = value.slice(0, lastColon).replace(/^\[|\]$/g, "");
  return { hostname, port: Number(value.slice(lastColon + 1)) };
}

/** Builds the request router available before the OpenAI API slice lands. */
export function createServeRouter(
  config: ServeConfig,
  options: { channels?: ChannelStatusView[]; sessions?: number } = {},
): (request: Request) => Response | Promise<Response> {
  const webUI = createWebUIHandler({ dir: config.webUI.dir });
  return (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/status") {
      if (request.method !== "GET") {
        return new Response(null, { status: 405 });
      }
      return Response.json(
        buildServeStatus({
          config,
          channels: options.channels,
          sessions: options.sessions,
        }),
      );
    }
    if (config.webUI.enabled) {
      return webUI(request);
    }
    return new Response("Not Found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  };
}

/** Starts the serve HTTP listener. */
export function startServeHttp(opts: StartServeHttpOptions): ServeHttpHandle {
  const { hostname, port } = parseListenAddr(opts.config.api.listen);
  const router = createServeRouter(opts.config, {
    channels: opts.channels,
    sessions: opts.sessions,
  });
  const controller = new AbortController();
  opts.signal?.addEventListener("abort", () => controller.abort(), {
    once: true,
  });
  const server = Deno.serve({
    hostname,
    port,
    signal: controller.signal,
    onListen: opts.onListen,
    ...(opts.listen ?? {}),
  }, router);
  return {
    server,
    hostname,
    port,
    shutdown: async () => {
      controller.abort();
      await server.finished;
    },
  };
}

/** CLI entry: load config, print the banner, and serve until signal/EOF. */
export async function runServe(
  partial: Partial<RunOptions> = {},
): Promise<void> {
  const opts = { ...defaultRunOptions(), ...partial };
  const cfg = loadServeRuntimeConfig(opts);
  console.error(`MothX Serve starting`);
  const handle = startServeHttp({
    config: cfg,
    onListen: ({ hostname, port }) => {
      const display = hostname === "0.0.0.0"
        ? `127.0.0.1:${port}`
        : `${hostname}:${port}`;
      console.error(`  Listen: http://${display}`);
      console.error(
        cfg.features.openAIAPI
          ? `  OpenAI API: http://${display}/v1/chat/completions (runtime pending in this slice)`
          : `  OpenAI API: disabled`,
      );
      console.error(
        cfg.webUI.enabled
          ? `  Web UI: http://${display}/`
          : `  Web UI: disabled`,
      );
    },
  });
  await handle.server.finished;
}
