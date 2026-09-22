// Ported from internal/stats/server.go
//
// `net/http.ServeMux` maps to a small path router over the standard web
// Request/Response API; `http.Server` maps to `Deno.serve`.

import { dashboardHTML, opensacPNG, opensacSmallICO } from "./assets.ts";
import { DB, type Query } from "./stats.ts";

/** Builds a Query from URL query parameters. */
export function parseQueryParams(values: URLSearchParams): Query {
  const q: Query = { groupBy: "day" };

  const fromStr = values.get("from");
  if (fromStr) {
    const d = parseDateOnly(fromStr);
    if (d) q.from = d;
  }

  const toStr = values.get("to");
  if (toStr) {
    const d = parseDateOnly(toStr);
    if (d) q.to = new Date(d.getTime() + 24 * 60 * 60 * 1000);
  }

  const vendor = values.get("vendor");
  if (vendor) q.vendor = vendor;
  const protocol = values.get("protocol");
  if (protocol) q.protocol = protocol;
  const model = values.get("model");
  if (model) q.model = model;
  const groupBy = values.get("groupBy");
  if (groupBy) q.groupBy = groupBy;

  return q;
}

function parseDateOnly(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}

/** The HTTP server for the stats dashboard. */
export class Server {
  #db: DB;
  #addr: string;
  #httpServer: Deno.HttpServer | null = null;

  constructor(db: DB, addr: string) {
    this.#db = db;
    this.#addr = addr;
  }

  /** The configured listen address. */
  get addr(): string {
    return this.#addr;
  }

  /** Handles one dashboard request. Exposed for in-process tests. */
  handle(req: Request): Response {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/") {
      return htmlResponse(dashboardHTML());
    }
    if (p === "/opensac-small.ico") {
      const h = new Headers({
        "Content-Type": "image/x-icon",
        "Cache-Control": "public, max-age=86400",
      });
      return new Response(opensacSmallICO() as unknown as BodyInit, {
        headers: h,
      });
    }
    if (p === "/opensac.png") {
      const h = new Headers({
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400",
      });
      return new Response(opensacPNG() as unknown as BodyInit, { headers: h });
    }
    if (p === "/api/summary") {
      return this.#json(() =>
        this.#db.summary(parseQueryParams(url.searchParams))
      );
    }
    if (p === "/api/timeseries") {
      return this.#json(() =>
        this.#db.timeSeries(parseQueryParams(url.searchParams))
      );
    }
    if (p === "/api/by-provider") {
      return this.#json(() =>
        this.#db.byProvider(parseQueryParams(url.searchParams))
      );
    }
    if (p === "/api/by-model") {
      return this.#json(() =>
        this.#db.byModel(parseQueryParams(url.searchParams))
      );
    }
    if (p === "/api/recent") {
      const q = parseQueryParams(url.searchParams);
      let page = 1;
      let pageSize = 20;
      const pStr = url.searchParams.get("page");
      if (pStr) {
        const n = Number.parseInt(pStr, 10);
        if (!isNaN(n) && n > 0) page = n;
      }
      const psStr = url.searchParams.get("pageSize");
      if (psStr) {
        const n = Number.parseInt(psStr, 10);
        if (!isNaN(n) && n > 0) pageSize = n;
      }
      return this.#json(() => this.#db.recentFiltered(q, page, pageSize));
    }
    return new Response("404 page not found\n", { status: 404 });
  }

  #json(fn: () => unknown): Response {
    try {
      const data = fn();
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: (err as Error).message }), {
        status: 206,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  /** Starts the HTTP server. */
  start(): void {
    const { hostname, port } = splitAddr(this.#addr);
    console.log(`[stats] dashboard listening on http://${this.#addr}`);
    this.#httpServer = Deno.serve(
      { hostname, port },
      (req) => this.handle(req),
    );
  }

  /** Gracefully stops the HTTP server. */
  async shutdown(): Promise<void> {
    if (this.#httpServer) {
      const srv = this.#httpServer;
      this.#httpServer = null;
      await srv.shutdown();
    }
  }

  /** Resolves when the HTTP server terminates. */
  finished(): Promise<void> {
    if (this.#httpServer === null) return Promise.resolve();
    return this.#httpServer.finished;
  }

  /** The bound address, available after {@link start}. */
  boundAddr(): string {
    const addr = this.#httpServer?.addr as
      | { hostname?: string; port?: number }
      | undefined;
    if (
      addr && typeof addr.hostname === "string" && typeof addr.port === "number"
    ) {
      const host = addr.hostname === "0.0.0.0" || addr.hostname === "::"
        ? "127.0.0.1"
        : addr.hostname;
      return `${host}:${addr.port}`;
    }
    return this.#addr;
  }
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function splitAddr(addr: string): { hostname: string; port: number } {
  const idx = addr.lastIndexOf(":");
  if (idx < 0) return { hostname: addr, port: 0 };
  const hostname = addr.slice(0, idx);
  const port = Number.parseInt(addr.slice(idx + 1), 10);
  return {
    hostname: hostname === "" ? "127.0.0.1" : hostname,
    port: isNaN(port) ? 0 : port,
  };
}
