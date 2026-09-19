// Ported from internal/debugpprof/pprof.go
//
// Go's `net/http/pprof` and `expvar` have no direct Deno equivalents. This port
// keeps the same local-only debug server contract:
//   - `/debug/vars` renders the process expvar map (the SQLite contention
//     metrics from `src/db` under `mothx_sqlite`).
//   - `/debug/pprof/` serves an index listing the (non-Go) runtime endpoints.
//
// The Go CPU/heap `pprof` profiles and execution traces are Go-runtime specific
// and are not available under Deno; those endpoints report 501 rather than
// fabricating a profile. This is a documented deviation.

import { SQLITE_EXPVAR_KEY, sqliteStatsSnapshot } from "../db/mod.ts";

/** Keeps debug profiling local-only by default. */
export const DEFAULT_ADDR = "127.0.0.1:6060";

/** Overrides the debug pprof listen address. */
export const ADDR_ENV = "VIBECODING_PPROF_ADDR";

let started = false;
let startedAddr = "";

function listenAddr(): string {
  const addr = (Deno.env.get(ADDR_ENV) ?? "").trim();
  return addr === "" ? DEFAULT_ADDR : addr;
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

/**
 * Handles one debug request. Exposed so tests can exercise the routes without a
 * real listener.
 */
export function newHandler(): (req: Request) => Response {
  return (req: Request): Response => {
    const p = new URL(req.url).pathname;
    if (p === "/debug/vars") {
      const body = JSON.stringify({
        [SQLITE_EXPVAR_KEY]: sqliteStatsSnapshot(),
      });
      return new Response(body, {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (p === "/debug/pprof/") {
      const body = [
        "<html><head><title>/debug/pprof/</title></head>",
        "<body>",
        "<h1>/debug/pprof/</h1>",
        "<p>Deno runtime debug endpoints:</p>",
        '<ul><li><a href="/debug/vars">/debug/vars</a></li></ul>',
        "<p>Go CPU/heap profiles and execution traces are not available under Deno.</p>",
        "</body></html>",
      ].join("\n");
      return new Response(body, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (
      p === "/debug/pprof/cmdline" || p === "/debug/pprof/symbol" ||
      p === "/debug/pprof/profile" || p === "/debug/pprof/trace"
    ) {
      const url = new URL(req.url);
      if (p === "/debug/pprof/cmdline") {
        return new Response(Deno.args.join("\u0000"), {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      if (p === "/debug/pprof/symbol") {
        return new Response(`num_symbols: 0\n`, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      void url;
      return new Response(
        "Go pprof profiles/traces are not available under Deno\n",
        {
          status: 501,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        },
      );
    }
    return new Response("404 page not found\n", { status: 404 });
  };
}

/**
 * Starts the pprof HTTP server once per process. Returns the bound address and
 * whether this call started it.
 */
export function start(
  logWriter?: (msg: string) => void,
): { addr: string; startedNow: boolean; error?: Error } {
  void logWriter;
  if (started) {
    return { addr: startedAddr, startedNow: false };
  }

  const addr = listenAddr();
  const { hostname, port } = splitAddr(addr);
  let server: Deno.HttpServer;
  try {
    server = Deno.serve({ hostname, port }, newHandler());
  } catch (err) {
    return {
      addr: "",
      startedNow: false,
      error: new Error(`listen ${addr}: ${(err as Error).message}`),
    };
  }
  const bound = server.addr as { hostname?: string; port?: number };
  if (
    bound && typeof bound.hostname === "string" &&
    typeof bound.port === "number"
  ) {
    const host = bound.hostname === "0.0.0.0" || bound.hostname === "::"
      ? "127.0.0.1"
      : bound.hostname;
    startedAddr = `${host}:${bound.port}`;
  } else {
    startedAddr = addr;
  }
  // Do not keep the event loop alive solely for the debug server.
  server.unref();
  started = true;
  return { addr: startedAddr, startedNow: true };
}

/** Starts pprof, mirroring the Go convenience wrapper. */
export function startForDebug(w?: (msg: string) => void): void {
  const write = w ?? (() => {});
  const { addr, startedNow, error } = start(write);
  if (error) {
    write(`[DEBUG] pprof unavailable: ${error.message}\n`);
    return;
  }
  if (startedNow) {
    write(`[DEBUG] pprof listening on http://${addr}/debug/pprof/\n`);
  }
}

/** Resets the once-per-process state. Exposed for tests only. */
export function resetForTest(): void {
  started = false;
  startedAddr = "";
}

export { listenAddr as listenAddrForTest };
