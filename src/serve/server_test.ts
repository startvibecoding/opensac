// Integration tests for the minimal serve HTTP bootstrap: real Deno.serve on
// an ephemeral port for /api/status, Web UI static serving, 405, and 404 when
// the Web UI feature is disabled.

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import { defaultServeConfig } from "./config.ts";
import {
  createServeRouter,
  parseListenAddr,
  startServeHttp,
} from "./server.ts";

Deno.test("parseListenAddr handles the listen variants", () => {
  // Go-style `:port` binds all interfaces in net/http.
  assertEquals(parseListenAddr(":7872"), {
    hostname: "0.0.0.0",
    port: 7872,
  });
  assertEquals(parseListenAddr("127.0.0.1:9000"), {
    hostname: "127.0.0.1",
    port: 9000,
  });
  assertEquals(parseListenAddr("[::1]:80"), { hostname: "::1", port: 80 });
  assertEquals(parseListenAddr(""), { hostname: "127.0.0.1", port: 7872 });
});

Deno.test("router returns status JSON and 405 on POST", async () => {
  const cfg = defaultServeConfig();
  cfg.features.webUI = false;
  cfg.webUI.enabled = false;
  const router = createServeRouter(cfg);
  const response = await router(new Request("http://local/api/status"));
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "application/json");
  const body = await response.json();
  assertEquals(body.status, "ok");
  assertEquals(body.listen, "127.0.0.1:7872");

  const post = await router(
    new Request("http://local/api/status", {
      method: "POST",
    }),
  );
  assertEquals(post.status, 405);

  const missing = await router(new Request("http://local/nope"));
  assertEquals(missing.status, 404);
});

Deno.test("router serves the Web UI when enabled", async () => {
  const dir = Deno.makeTempDirSync();
  Deno.writeTextFileSync(path.join(dir, "index.html"), "<html></html>");
  const cfg = defaultServeConfig();
  cfg.features.webUI = true;
  cfg.webUI.enabled = true;
  cfg.webUI.dir = dir;
  const router = createServeRouter(cfg);
  const response = await router(new Request("http://local/"));
  assertEquals(response.status, 200);
  assertEquals(await response.text(), "<html></html>");
});

Deno.test("startServeHttp serves /api/status over a real port", async () => {
  const cfg = defaultServeConfig();
  cfg.api.listen = "127.0.0.1:0";
  cfg.features.webUI = false;
  cfg.webUI.enabled = false;
  const controller = new AbortController();
  let boundPort = 0;
  const handle = startServeHttp({
    config: cfg,
    signal: controller.signal,
    channels: [{ name: "wechat", enabled: true, connected: false }],
    sessions: 2,
    onListen: ({ port }) => void (boundPort = port),
  });
  try {
    assert(boundPort > 0);
    const response = await fetch(
      `http://127.0.0.1:${boundPort}/api/status`,
    );
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.status, "ok");
    assertEquals(body.sessions, 2);
    assertEquals(body.channels[0].name, "wechat");
  } finally {
    controller.abort();
    await handle.shutdown();
  }
});
