// Translated from internal/serve/openaiapi/server_test.go — the route-table
// and middleware cases (TestRegisterRoutes serves the health/provider
// surface, the DisableAPI switch, ExtraRoutes, LoggingMiddleware passthrough,
// and apiSecurityWarning) plus the ServeMux matching semantics that replace
// http.ServeMux.
import { assert, assertEquals } from "@std/assert";
import {
  apiSecurityWarning,
  loggingMiddleware,
  registerRoutes,
  ServeMux,
} from "./routes.ts";
import { Server } from "./server.ts";
import type { Config } from "./config.ts";

function getRequest(path: string): Request {
  return new Request(`http://127.0.0.1:7872${path}`);
}

Deno.test("serveMuxMatchesExactSubtreeAndLongestPattern", async () => {
  const mux = new ServeMux();
  mux.handle("/health", () => new Response("health"));
  mux.handle("/api/runs/", () => new Response("runs-subtree"));
  mux.handle("/api/runs/special", () => new Response("special"));

  assertEquals(
    await (await mux.dispatch(getRequest("/health"))).text(),
    "health",
  );
  assertEquals(
    await (await mux.dispatch(getRequest("/api/runs/abc"))).text(),
    "runs-subtree",
  );
  assertEquals(
    await (await mux.dispatch(getRequest("/api/runs/special"))).text(),
    "special",
  );
  assertEquals(mux.handler("/api/unknown"), undefined);
});

Deno.test("serveMuxReturnsGoNotFoundBody", async () => {
  const mux = new ServeMux();
  const res = await mux.dispatch(getRequest("/missing"));
  assertEquals(res.status, 404);
  assertEquals(await res.text(), "404 page not found\n");
});

Deno.test("registerRoutesServesHealthAndProviderSurface", async () => {
  const srv = new Server({ version: "test" });
  const mux = new ServeMux();
  registerRoutes(mux, srv, {});

  const health = await mux.dispatch(getRequest("/health"));
  assertEquals(health.status, 200);
  const body = await health.json();
  assertEquals(body.status, "ok");
  assertEquals(body.version, "test");
  assertEquals(body.sessions, 0);

  assertEquals((await mux.dispatch(getRequest("/v1/models"))).status, 200);
  assertEquals(
    (await mux.dispatch(getRequest("/api/models/catalog"))).status,
    200,
  );
  assertEquals(
    (await mux.dispatch(getRequest("/api/provider/models"))).status,
    405,
  );
  assertEquals(
    (await mux.dispatch(getRequest("/api/provider/test"))).status,
    405,
  );
});

Deno.test("registerRoutesDisableAPISkipsTheAPISurface", async () => {
  const srv = new Server({ version: "test" });
  const mux = new ServeMux();
  registerRoutes(mux, srv, { disableAPI: true });

  assertEquals((await mux.dispatch(getRequest("/health"))).status, 200);
  assertEquals((await mux.dispatch(getRequest("/v1/models"))).status, 404);
  assertEquals(
    (await mux.dispatch(getRequest("/api/attachments/x"))).status,
    404,
  );
  assertEquals(
    (await mux.dispatch(getRequest("/api/deliveries/failures"))).status,
    404,
  );
});

Deno.test("registerRoutesBindsHandlerSlotsAndExtraRoutes", async () => {
  const srv = new Server({ version: "test" });
  const mux = new ServeMux();
  let extraSeen: Server | undefined;
  registerRoutes(mux, srv, {
    chatCompletions: (server) => {
      assert(server === srv);
      return new Response("chat");
    },
    extraRoutes: (server, m) => {
      extraSeen = server;
      m.handle("/extra", () => new Response("extra"));
    },
  });
  assertEquals(extraSeen, srv);
  assertEquals(
    (await mux.dispatch(getRequest("/v1/chat/completions"))).status,
    200,
  );
  assertEquals(
    await (await mux.dispatch(getRequest("/v1/chat/completions"))).text(),
    "chat",
  );
  assertEquals(
    await (await mux.dispatch(getRequest("/extra"))).text(),
    "extra",
  );
});

Deno.test("loggingMiddlewareLogsAndPassesThrough", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (msg: string) => lines.push(msg);
  try {
    const handler = loggingMiddleware(() =>
      new Response("ok", { status: 201 })
    );
    const res = await handler(getRequest("/v1/models"));
    assertEquals(res.status, 201);
    assertEquals(await res.text(), "ok");
  } finally {
    console.error = original;
  }
  assertEquals(lines.length, 1);
  assert(lines[0].startsWith("GET /v1/models 201 "));
  assert(lines[0].endsWith("ms"));
});

Deno.test("apiSecurityWarningCases", () => {
  const yoloOpen: Config = { defaultMode: "yolo", listen: ":7872" };
  assertEquals(
    apiSecurityWarning(yoloOpen),
    "API is listening beyond loopback in yolo mode without authentication",
  );
  assertEquals(
    apiSecurityWarning({ defaultMode: "yolo", listen: "0.0.0.0:7872" }),
    "API is listening beyond loopback in yolo mode without authentication",
  );
  assertEquals(
    apiSecurityWarning({ defaultMode: "yolo", listen: "[::]:7872" }),
    "API is listening beyond loopback in yolo mode without authentication",
  );
  assertEquals(
    apiSecurityWarning({ defaultMode: "yolo", listen: "127.0.0.1:7872" }),
    "",
  );
  assertEquals(
    apiSecurityWarning({
      defaultMode: "yolo",
      listen: ":7872",
      auth: { enabled: true, tokens: ["t"] },
    }),
    "",
  );
  assertEquals(
    apiSecurityWarning({ defaultMode: "agent", listen: ":7872" }),
    "",
  );
});
