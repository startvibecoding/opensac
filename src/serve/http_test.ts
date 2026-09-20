// Tests for the #36 HTTP projection slice: status feature matrix, path
// traversal guarding, the SPA fallback, disk asset serving, and 503 when the
// frontend has not been built.

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import {
  buildServeStatus,
  createWebUIHandler,
  safeRelativePath,
  writeJson,
} from "./http.ts";
import { decodeConfigBytes } from "./config_state.ts";

Deno.test("buildServeStatus projects the config feature matrix", () => {
  const cfg = decodeConfigBytes(JSON.stringify({
    listen: "127.0.0.1:8080",
    features: {
      webUI: true,
      openAIAPI: false,
      wechat: true,
      feishu: false,
      multiAgent: true,
      cron: true,
      memory: false,
    },
    webSearch: true,
    browser: true,
    a2aMaster: true,
  }));
  // enableWorkflows is an API-private toggle under api.* / rawConfig mapping
  cfg.api.enableWorkflows = true;
  const status = buildServeStatus({
    config: cfg,
    channels: [{ name: "wechat", enabled: true, connected: false }],
    sessions: 3,
  });
  assertEquals(status.status, "ok");
  assertEquals(status.listen, "127.0.0.1:8080");
  assertEquals(status.sessions, 3);
  assertEquals(status.features.webUI, true);
  assertEquals(status.features.openAIAPI, false);
  assertEquals(status.features.wechat, true);
  assertEquals(status.features.multiAgent, true);
  assertEquals(status.features.webSearch, true);
  assertEquals(status.features.browser, true);
  assertEquals(status.features.a2aMaster, true);
  assertEquals(status.features.workflows, true);
  assertEquals(status.channels.length, 1);
});

Deno.test("buildServeStatus defaults and settings webSearch OR", () => {
  const empty = buildServeStatus({});
  assertEquals(empty.status, "ok");
  assertEquals(empty.features.webSearch, false);
  const cfg = decodeConfigBytes(JSON.stringify({}));
  const withSettings = buildServeStatus({
    config: cfg,
    webSearchAvailable: true,
  });
  assertEquals(withSettings.features.webSearch, true);
});

Deno.test("writeJson emits JSON envelope + newline", () => {
  const response = writeJson(() => {}, 201, { ok: true });
  assertEquals(response.status, 201);
  assertEquals(response.headers.get("content-type"), "application/json");
});

Deno.test("safeRelativePath blocks traversal and normalizes", () => {
  assertEquals(safeRelativePath("/assets/app.js"), "assets/app.js");
  assertEquals(safeRelativePath("/"), "");
  assertEquals(safeRelativePath("/index.html"), "index.html");
  // posix.normalize resolves root escapes to absolute names; guard them
  assertEquals(safeRelativePath("/../etc/passwd"), "");
  assertEquals(safeRelativePath("/assets/../secret"), "secret");
  assertEquals(safeRelativePath("/assets/../../secret"), "");
  assertEquals(safeRelativePath("/a/b/./c"), "a/b/c");
  assertEquals(safeRelativePath("/a%2Fb"), "a/b");
});

Deno.test("WebUI handler serves disk assets with content types", async () => {
  const dir = Deno.makeTempDirSync();
  Deno.mkdirSync(path.join(dir, "assets"), { recursive: true });
  Deno.writeTextFileSync(path.join(dir, "index.html"), "<html>app</html>");
  Deno.writeTextFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");
  Deno.writeTextFileSync(path.join(dir, "assets", "style.css"), "body{}");
  const handler = createWebUIHandler({ dir });

  const index = await handler(new Request("http://local/"));
  assertEquals(index.status, 200);
  assertEquals(index.headers.get("content-type"), "text/html; charset=utf-8");
  assertEquals(await index.text(), "<html>app</html>");

  const js = await handler(new Request("http://local/assets/app.js"));
  assertEquals(js.status, 200);
  assertEquals(
    js.headers.get("content-type"),
    "text/javascript; charset=utf-8",
  );

  const css = await handler(new Request("http://local/assets/style.css"));
  assertEquals(css.headers.get("content-type"), "text/css; charset=utf-8");

  // SPA fallback for an unknown client-side route
  const route = await handler(new Request("http://local/sessions/abc"));
  assertEquals(route.status, 200);
  assertEquals(await route.text(), "<html>app</html>");
});

Deno.test("WebUI handler returns 503 when assets are missing", async () => {
  const dir = path.join(Deno.makeTempDirSync(), "never-built");
  const handler = createWebUIHandler({ dir });
  const response = await handler(new Request("http://local/"));
  assertEquals(response.status, 503);
  assert((await response.text()).includes("Web UI assets not found"));
});

Deno.test("WebUI handler supports injected embedded assets", async () => {
  const assets = new Map<string, Uint8Array>([
    ["index.html", new TextEncoder().encode("<!doctype html>")],
    ["logo.svg", new TextEncoder().encode("<svg/>")],
  ]);
  const handler = createWebUIHandler({
    dir: "ui/dist",
    readFile: (relative) => assets.get(relative)?.slice(),
    exists: (relative) => assets.has(relative),
  });
  const svg = await handler(new Request("http://local/logo.svg"));
  assertEquals(svg.status, 200);
  assertEquals(svg.headers.get("content-type"), "image/svg+xml");
  const spa = await handler(new Request("http://local/any/route"));
  assertEquals(spa.status, 200);
  assertEquals(await spa.text(), "<!doctype html>");
});
