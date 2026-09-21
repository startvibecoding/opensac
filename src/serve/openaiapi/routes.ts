// Ported from internal/serve/openaiapi/server.go — the HTTP route table
// (registerRoutes), LoggingMiddleware, and apiSecurityWarning, plus a minimal
// ServeMux standing in for http.ServeMux.
//
// Deviations: net/http's Hijack/Flush response-writer plumbing has no Deno
// equivalent (Deno.serve upgrades/handles flushing itself); Go's automatic
// path-clean and subtree-slash redirects are not reproduced because every
// registered pattern is exact or a fixed subtree prefix; the request log goes
// to stderr through console.error like Go's default log.Logger. The
// /v1/chat/completions handler stays an optional slot filled by the assembly
// slice; the /api/runs/ and /api/responses/runs/ handlers are ported and bind
// by default (overridable for tests).
import type { HTTPHandler } from "./auth.ts";
import type { Config } from "./config.ts";
import { handleHealth } from "./handler_health.ts";
import { handleModelCatalog, handleModels } from "./handler_models.ts";
import {
  handleProviderModels,
  handleProviderModelTest,
} from "./handler_provider_tools.ts";
import { handleAttachmentAPI } from "./handler_attachments.ts";
import {
  handleDeliveryFailuresAPI,
  handleDeliveryRetryAPI,
} from "./handler_deliveries.ts";
import { handleResponsesRunAPI } from "./responses_run_api.ts";
import { handleRunAPI } from "./run_api.ts";
import type { Server } from "./server.ts";

/** A handler bound to the Server, matching the ported handler convention. */
export type ServerHandler = (
  server: Server,
  request: Request,
) => Response | Promise<Response>;

interface Route {
  pattern: string;
  handler: HTTPHandler;
}

/**
 * ServeMux is the http.ServeMux replacement: exact patterns match the whole
 * path, patterns ending in "/" match the subtree, and the longest pattern
 * wins. Unmatched paths return Go's plain-text 404.
 */
export class ServeMux {
  #routes: Route[] = [];

  /** Registers a handler for a pattern. */
  handle(pattern: string, handler: HTTPHandler): void {
    this.#routes.push({ pattern, handler });
  }

  /** Resolves the winning handler for a path, or undefined for a 404. */
  handler(pathname: string): HTTPHandler | undefined {
    let best: Route | undefined;
    for (const route of this.#routes) {
      const matches = route.pattern === pathname ||
        (route.pattern.endsWith("/") && pathname.startsWith(route.pattern));
      if (
        matches &&
        (best === undefined || route.pattern.length > best.pattern.length)
      ) {
        best = route;
      }
    }
    return best?.handler;
  }

  /** Dispatches a request through the matched handler. */
  dispatch(request: Request): Response | Promise<Response> {
    const pathname = new URL(request.url).pathname;
    const handler = this.handler(pathname);
    if (!handler) {
      return new Response("404 page not found\n", {
        status: 404,
        headers: new Headers({
          "content-type": "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff",
        }),
      });
    }
    return handler(request);
  }
}

/** RouteOptions carries the run-level route switches and handler slots. */
export interface RouteOptions {
  /** Go RunOptions.DisableAPI: skips the /v1 and /api surface. */
  disableAPI?: boolean;
  /** Filled by the handler_chat server-bound slice. */
  chatCompletions?: ServerHandler;
  /** Optional override; defaults to the ported run API. */
  runAPI?: ServerHandler;
  /** Optional override; defaults to the ported Responses run API. */
  responsesRunAPI?: ServerHandler;
  /** Go RunOptions.ExtraRoutes: channel/runtime extensions of the mux. */
  extraRoutes?: (server: Server, mux: ServeMux) => void;
}

/** registerRoutes ports the Go route table onto the mux. */
export function registerRoutes(
  mux: ServeMux,
  srv: Server,
  opts: RouteOptions,
): void {
  if (!opts.disableAPI) {
    if (opts.chatCompletions) {
      mux.handle(
        "/v1/chat/completions",
        (req) => opts.chatCompletions!(srv, req),
      );
    }
    {
      const runAPI = opts.runAPI ?? handleRunAPI;
      mux.handle("/api/runs/", (req) => runAPI(srv, req));
    }
    {
      const responsesRunAPI = opts.responsesRunAPI ?? handleResponsesRunAPI;
      mux.handle(
        "/api/responses/runs/",
        (req) => responsesRunAPI(srv, req),
      );
    }
    mux.handle("/api/attachments/", (req) => handleAttachmentAPI(srv, req));
    mux.handle(
      "/api/deliveries/failures",
      (req) => handleDeliveryFailuresAPI(srv, req),
    );
    mux.handle(
      "/api/deliveries/retry",
      (req) => handleDeliveryRetryAPI(srv, req),
    );
    mux.handle("/v1/models", (req) => handleModels(srv, req));
    mux.handle("/api/models/catalog", (req) => handleModelCatalog(srv, req));
  }
  mux.handle("/health", (req) => handleHealth(srv, req));
  mux.handle("/api/provider/models", (req) => handleProviderModels(srv, req));
  mux.handle("/api/provider/test", (req) => handleProviderModelTest(srv, req));
  opts.extraRoutes?.(srv, mux);
}

/** LoggingMiddleware logs each request after it completes. */
export function loggingMiddleware(next: HTTPHandler): HTTPHandler {
  return async (request) => {
    const start = Date.now();
    const response = await next(request);
    const elapsedMs = Date.now() - start;
    console.error(
      `${request.method} ${
        new URL(request.url).pathname
      } ${response.status} ${elapsedMs}ms`,
    );
    return response;
  };
}

/**
 * apiSecurityWarning warns when a yolo-mode server with no authentication
 * listens beyond loopback.
 */
export function apiSecurityWarning(cfg: Config): string {
  if (
    cfg.defaultMode !== "yolo" ||
    (cfg.auth?.enabled && (cfg.auth.tokens?.length ?? 0) > 0)
  ) {
    return "";
  }
  const listen = cfg.listen ?? "";
  if (
    listen.startsWith(":") ||
    listen.startsWith("0.0.0.0:") ||
    listen.startsWith("[::]:")
  ) {
    return "API is listening beyond loopback in yolo mode without authentication";
  }
  return "";
}
