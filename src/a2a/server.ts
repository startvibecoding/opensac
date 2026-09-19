// Ported from internal/a2a/server.go.
//
// `net/http` servers map to `Deno.serve`; routing is a pathname switch over
// standard `Request`/`Response`. Graceful shutdown maps the Go context timeout
// to aborting the `Deno.serve` signal.

import type { AgentCard } from "./agent_card.ts";
import { defaultAgentCard, handleAgentCard } from "./agent_card.ts";
import type { AgentCardCfg, Config } from "./config.ts";
import { getListenAddr, getWorkDir } from "./config.ts";
import type { AgentExecutor, JSONRPCRequest } from "./handler.ts";
import { Handler, newHandler } from "./handler.ts";
import type { Message } from "./task.ts";

/** Server is the A2A HTTP server. */
export class Server {
  private cfg: Config;
  private version: string;
  private handler: Handler;
  private card: AgentCard;
  private httpSrv: Deno.HttpServer | undefined;
  private ac: AbortController | undefined;

  constructor(cfg: Config, version: string, executor: AgentExecutor) {
    this.cfg = cfg;
    this.version = version;
    this.handler = newHandler(executor);

    const serverURL = `http://${getListenAddr(cfg)}`;
    const card = defaultAgentCard(version, serverURL);
    const override: AgentCardCfg | undefined = cfg.agent_card;
    if (override !== undefined) {
      if (override.name !== undefined && override.name !== "") {
        card.name = override.name;
      }
      if (override.description !== undefined && override.description !== "") {
        card.description = override.description;
      }
      if (override.version !== undefined && override.version !== "") {
        card.version = override.version;
      }
    }
    this.card = card;
  }

  /** GetHandler returns the A2A handler (for integration mode). */
  getHandler(): Handler {
    return this.handler;
  }

  /** GetCard returns the Agent Card. */
  getCard(): AgentCard {
    return this.card;
  }

  /** handleRequest routes one request (the TS analogue of mux.ServeHTTP). */
  async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/.well-known/agent.json") {
      return handleAgentCard(this.card)(req);
    }
    if (path === "/a2a") {
      if (!this.authorized(req)) return unauthorized();
      return await this.handler.serveHTTP(req);
    }
    if (path === "/a2a/events") {
      if (!this.authorized(req)) return unauthorized();
      return this.handler.subscribeSSE(req);
    }
    if (path === "/a2a/send") {
      if (!this.authorized(req)) return unauthorized();
      return await this.handleRESTSend(req, url);
    }
    if (path === "/a2a/task") {
      if (!this.authorized(req)) return unauthorized();
      return this.handleRESTGetTask(req, url);
    }
    if (path === "/a2a/task/cancel") {
      if (!this.authorized(req)) return unauthorized();
      return await this.handleRESTCancel(req);
    }
    return new Response("not found", { status: 404 });
  }

  private async handleRESTSend(req: Request, url: URL): Promise<Response> {
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    const isSSE = (req.headers.get("Accept") ?? "") === "text/event-stream";
    let body: { task_id?: string; message?: Message };
    try {
      body = (await req.json()) as { task_id?: string; message?: Message };
    } catch {
      return new Response("invalid request body", { status: 400 });
    }
    if (body.message === undefined || body.message === null) {
      return new Response("message is required", { status: 400 });
    }
    void url;
    return await this.handler.sendMessage(
      { task_id: body.task_id, message: body.message },
      req.signal,
      isSSE,
      null,
    );
  }

  private handleRESTGetTask(req: Request, url: URL): Response {
    if (req.method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }
    const taskID = url.searchParams.get("task_id") ?? "";
    if (taskID === "") {
      return new Response("task_id required", { status: 400 });
    }
    const task = this.handler.getTaskStore().get(taskID);
    if (task === undefined) {
      return new Response("task not found", { status: 404 });
    }
    return new Response(JSON.stringify(task), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleRESTCancel(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    let body: { task_id?: string };
    try {
      body = (await req.json()) as { task_id?: string };
    } catch {
      return new Response("invalid request body", { status: 400 });
    }
    const store = this.handler.getTaskStore();
    const task = store.get(body.task_id ?? "");
    if (task === undefined) {
      return new Response("task not found", { status: 404 });
    }
    if (task.state !== "working" && task.state !== "submitted") {
      return new Response("cannot cancel task in state: " + task.state, {
        status: 409,
      });
    }
    const rpc: JSONRPCRequest = {
      jsonrpc: "2.0",
      method: "task/cancel",
      params: { task_id: body.task_id },
      id: null,
    };
    this.handler.handleCancelTask(rpc);
    const canceled = store.get(body.task_id ?? "");
    return new Response(JSON.stringify(canceled), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private authorized(req: Request): boolean {
    if (this.cfg.auth_token === undefined || this.cfg.auth_token === "") {
      return true;
    }
    return validBearerToken(req, this.cfg.auth_token);
  }

  /** Start starts the A2A server in standalone mode. Resolves when stopped. */
  async start(): Promise<void> {
    this.ac = new AbortController();
    this.httpSrv = Deno.serve({
      hostname: this.cfg.host,
      port: this.cfg.port,
      signal: this.ac.signal,
      onListen: (addr) => {
        console.error(
          `A2A server listening on ${
            (addr as { hostname?: string }).hostname ?? this.cfg.host
          }:${(addr as { port?: number }).port ?? this.cfg.port}`,
        );
      },
    }, (req) => this.handleRequest(req));
    await this.httpSrv.finished;
  }

  /** Stop gracefully shuts down the server. */
  async stop(_timeoutMs: number): Promise<void> {
    if (this.httpSrv === undefined) return;
    this.ac?.abort();
    await this.httpSrv.finished;
  }
}

/** NewServer creates a new A2A server. */
export function newServer(
  cfg: Config,
  version: string,
  executor: AgentExecutor,
): Server {
  return new Server(cfg, version, executor);
}

/** Run starts the A2A server in standalone mode with signal handling. */
export async function run(
  cfg: Config,
  version: string,
  executor: AgentExecutor,
): Promise<void> {
  const srv = newServer(cfg, version, executor);

  const errCh = Promise.withResolvers<Error>();
  const started = srv.start().catch((err) => {
    const e = err as Error;
    if (!(e instanceof Deno.errors.BadResource)) errCh.resolve(e);
  });
  void started;

  console.error(`VibeCoding A2A Server ${version} starting`);
  console.error(`  Endpoint: http://${getListenAddr(cfg)}/a2a`);
  console.error(
    `  Agent Card: http://${getListenAddr(cfg)}/.well-known/agent.json`,
  );
  console.error(`  WorkDir: ${getWorkDir(cfg)}`);
  console.error("");
  console.error("Ready to serve.");

  const signal = Promise.withResolvers<"SIGINT" | "SIGTERM">();
  const onSigint = () => signal.resolve("SIGINT");
  const onSigterm = () => signal.resolve("SIGTERM");
  Deno.addSignalListener("SIGINT", onSigint);
  Deno.addSignalListener("SIGTERM", onSigterm);

  try {
    const result = await Promise.race([
      errCh.promise.then((e) => ({ err: e })),
      signal.promise.then((sig) => ({ sig })),
    ]);
    if ("err" in result && result.err !== undefined) {
      throw new Error(`a2a server error: ${result.err.message}`);
    }
    if ("sig" in result && result.sig !== undefined) {
      console.error(`\nReceived ${result.sig}, shutting down...`);
      await srv.stop(10_000);
    }
  } finally {
    Deno.removeSignalListener("SIGINT", onSigint);
    Deno.removeSignalListener("SIGTERM", onSigterm);
  }
}

function unauthorized(): Response {
  return new Response("unauthorized", { status: 401 });
}

const bearerPrefix = "Bearer ";

/** Constant-time bearer-token comparison (the Go subtle.ConstantTimeCompare). */
export function validBearerToken(req: Request, want: string): boolean {
  const auth = req.headers.get("Authorization") ?? "";
  if (auth.length <= bearerPrefix.length) return false;
  if (auth.slice(0, bearerPrefix.length) !== bearerPrefix) return false;
  const got = auth.slice(bearerPrefix.length);
  const a = new TextEncoder().encode(got);
  const b = new TextEncoder().encode(want);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
