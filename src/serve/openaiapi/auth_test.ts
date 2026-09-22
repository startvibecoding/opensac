// Translated from internal/serve/openaiapi/auth_webui_test.go and the
// auth/CORS/concurrency middleware cases of server_test.go.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  authMiddleware,
  authMiddlewareForConfig,
  concurrencyMiddleware,
  corsMiddleware,
  extractBearerToken,
  type HTTPHandler,
  webUIAuthStatusHandler,
  webUILoginHandler,
  webUILogoutHandler,
} from "./auth.ts";
import type { AuthConfig, CORSConfig } from "./config.ts";

const noContent: HTTPHandler = () => new Response(null, { status: 204 });

function getRequest(path: string, headers?: Record<string, string>): Request {
  return new Request(`http://serve.test${path}`, { headers });
}

async function invoke(
  handler: HTTPHandler,
  request: Request,
): Promise<Response> {
  return await handler(request);
}

Deno.test("webUI login uses configured token as password", async () => {
  const cfg: AuthConfig = { enabled: true, tokens: ["auth-token"] };
  const login = webUILoginHandler(cfg);

  const loginResponse = await invoke(
    login,
    new Request("http://serve.test/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password: "auth-token" }),
    }),
  );
  assertEquals(loginResponse.status, 200);
  const setCookie = loginResponse.headers.get("set-cookie") ?? "";
  const cookies = setCookie === "" ? [] : [setCookie];
  assertEquals(cookies.length, 1);
  assertStringIncludes(cookies[0], "opensac_webui_auth=");
  assertStringIncludes(cookies[0], "HttpOnly");
  assertStringIncludes(cookies[0], "SameSite=Strict");
  assertStringIncludes(cookies[0], "Max-Age=");
  const maxAge = Number(/Max-Age=(\d+)/.exec(cookies[0])?.[1] ?? "0");
  assert(maxAge > 0);

  const cookiePair = /opensac_webui_auth=[^;]+/.exec(cookies[0])?.[0] ?? "";
  const protectedResponse = await invoke(
    authMiddleware(cfg, noContent),
    getRequest("/api/status", { cookie: cookiePair }),
  );
  assertEquals(protectedResponse.status, 204);
});

Deno.test("webUI login rejects invalid password", async () => {
  const handler = webUILoginHandler({ enabled: true, tokens: ["auth-token"] });
  const response = await invoke(
    handler,
    new Request("http://serve.test/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password: "wrong" }),
    }),
  );
  assertEquals(response.status, 401);
  assertEquals(response.headers.get("set-cookie"), null);
});

Deno.test("auth middleware allows only WebUI bootstrap assets without credentials", async () => {
  const handler = authMiddleware(
    { enabled: true, tokens: ["auth-token"] },
    noContent,
  );

  for (
    const path of ["/", "/index.html", "/assets/app.js", "/opensac-small.ico"]
  ) {
    const response = await invoke(handler, getRequest(path));
    assertEquals(response.status, 204, path);
  }

  const response = await invoke(handler, getRequest("/api/status"));
  assertEquals(response.status, 401);
});

Deno.test("webUI auth status does not expose tokens", async () => {
  const handler = webUIAuthStatusHandler({
    enabled: true,
    tokens: ["auth-token"],
  });
  const response = await invoke(handler, getRequest("/api/auth/status"));
  assertEquals(response.status, 200);
  const body = await response.text();
  assert(
    !body.includes("auth-token"),
    `status endpoint exposed auth token: ${body}`,
  );
  assertStringIncludes(body, '"authenticated":false');
});

Deno.test("auth middleware for config uses latest config", async () => {
  const cfg: AuthConfig = { enabled: false };
  const handler = authMiddlewareForConfig(() => cfg, noContent);

  const first = await invoke(handler, getRequest("/api/status"));
  assertEquals(first.status, 204);

  cfg.enabled = true;
  cfg.tokens = ["updated-token"];
  const second = await invoke(handler, getRequest("/api/status"));
  assertEquals(second.status, 401);

  const third = await invoke(
    handler,
    getRequest("/api/status", { authorization: "Bearer updated-token" }),
  );
  assertEquals(third.status, 204);
});

Deno.test("auth middleware disabled passes through", async () => {
  const handler = authMiddleware(
    { enabled: false },
    () => new Response(null, { status: 200 }),
  );
  const response = await invoke(handler, getRequest("/test"));
  assertEquals(response.status, 200);
});

Deno.test("auth middleware accepts a valid token", async () => {
  const handler = authMiddleware(
    { enabled: true, tokens: ["sk-test"] },
    () => new Response(null, { status: 200 }),
  );
  const response = await invoke(
    handler,
    getRequest("/test", { authorization: "Bearer sk-test" }),
  );
  assertEquals(response.status, 200);
});

Deno.test("auth middleware rejects an invalid token", async () => {
  const handler = authMiddleware(
    { enabled: true, tokens: ["sk-test"] },
    noContent,
  );
  const response = await invoke(
    handler,
    getRequest("/test", { authorization: "Bearer wrong-token" }),
  );
  assertEquals(response.status, 401);
});

Deno.test("auth middleware rejects a missing header", async () => {
  const handler = authMiddleware(
    { enabled: true, tokens: ["sk-test"] },
    noContent,
  );
  const response = await invoke(handler, getRequest("/test"));
  assertEquals(response.status, 401);
});

Deno.test("auth middleware rejects when enabled without tokens", async () => {
  const handler = authMiddleware({ enabled: true }, noContent);
  const response = await invoke(
    handler,
    getRequest("/test", { authorization: "Bearer anything" }),
  );
  assertEquals(response.status, 401);
});

Deno.test("CORS middleware echoes the configured origin", async () => {
  const handler = corsMiddleware(
    { enabled: true, allowOrigins: ["http://example.com"] },
    () => new Response(null, { status: 200 }),
  );
  const response = await invoke(handler, getRequest("/test"));
  assertEquals(
    response.headers.get("access-control-allow-origin"),
    "http://example.com",
  );
});

Deno.test("CORS middleware with multiple origins echoes the request origin", async () => {
  const cfg: CORSConfig = {
    enabled: true,
    allowOrigins: ["http://a.example", "http://b.example"],
  };
  const handler = corsMiddleware(
    cfg,
    () => new Response(null, { status: 200 }),
  );
  const response = await invoke(
    handler,
    getRequest("/test", { origin: "http://b.example" }),
  );
  assertEquals(
    response.headers.get("access-control-allow-origin"),
    "http://b.example",
  );
});

Deno.test("CORS middleware with multiple origins rejects unknown origin", async () => {
  const cfg: CORSConfig = {
    enabled: true,
    allowOrigins: ["http://a.example", "http://b.example"],
  };
  const handler = corsMiddleware(
    cfg,
    () => new Response(null, { status: 200 }),
  );
  const response = await invoke(
    handler,
    getRequest("/test", { origin: "http://evil.example" }),
  );
  assertEquals(response.headers.get("access-control-allow-origin"), null);
});

Deno.test("CORS middleware preflight", async () => {
  const handler = corsMiddleware({ enabled: true }, noContent);
  const response = await invoke(
    handler,
    new Request("http://serve.test/test", { method: "OPTIONS" }),
  );
  assertEquals(response.status, 204);
});

Deno.test("concurrency middleware without a limit passes through", async () => {
  const handler = concurrencyMiddleware(
    0,
    () => new Response(null, { status: 200 }),
  );
  const response = await invoke(handler, getRequest("/test"));
  assertEquals(response.status, 200);
});

Deno.test("concurrency middleware rejects over capacity", async () => {
  let release: (() => void) | undefined;
  const handler = concurrencyMiddleware(1, () => {
    if (release !== undefined) {
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    return new Promise<Response>((resolve) => {
      release = () => resolve(new Response(null, { status: 200 }));
    });
  });
  const first = handler(getRequest("/first"));
  const second = await handler(getRequest("/second"));
  assertEquals(second.status, 429);
  release?.();
  assertEquals((await first).status, 200);
});

Deno.test("extractBearerToken parses the Authorization header", () => {
  assertEquals(
    extractBearerToken(getRequest("/x", { authorization: "Bearer sk-1" })),
    "sk-1",
  );
  assertEquals(
    extractBearerToken(getRequest("/x", { authorization: "Bearer  padded  " })),
    "padded",
  );
  assertEquals(
    extractBearerToken(getRequest("/x", { authorization: "Basic abc" })),
    "",
  );
  assertEquals(extractBearerToken(getRequest("/x")), "");
});

Deno.test("webUI logout clears the session cookie", async () => {
  const response = await invoke(
    webUILogoutHandler(),
    new Request("http://serve.test/api/auth/logout", { method: "POST" }),
  );
  assertEquals(response.status, 200);
  const setCookie = response.headers.get("set-cookie") ?? "";
  assertStringIncludes(setCookie, "Max-Age=0");
  const body = await response.json();
  assertEquals(body.authenticated, false);
});

Deno.test("webUI handlers reject non-matching methods", async () => {
  assertEquals(
    (await invoke(webUILoginHandler({ enabled: false }), getRequest("/login")))
      .status,
    405,
  );
  assertEquals(
    (await invoke(
      webUIAuthStatusHandler({ enabled: false }),
      new Request("http://serve.test/s", { method: "POST" }),
    )).status,
    405,
  );
  assertEquals(
    (await invoke(webUILogoutHandler(), getRequest("/logout"))).status,
    405,
  );
});
