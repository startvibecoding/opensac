// Translated from internal/serve/run.go's handler tests (lifecycle_http_test.go,
// browse_roots_test.go, channel_tools_http_test.go) plus focused table tests for
// the route table and the pure helpers. Full-stack HTTP integration against a
// live openaiapi.Server lands with the process-boundary slices.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ChannelRuntime } from "./channel_runtime.ts";
import { decodeConfigBytes, ServeConfigState } from "./config_state.ts";
import type { ServeConfig } from "./config.ts";
import { ServeMux } from "./openaiapi/routes.ts";
import {
  channelLabel,
  envViewFromConfig,
  filterActiveSessions,
  handleBrowse,
  handleCapabilities,
  handleChannelConfigPatch,
  handleChannels,
  handleEnv,
  handleMemory,
  handleProjectByID,
  handleProjects,
  handleSelectDirectory,
  handleServeConfig,
  handleSessionBindings,
  handleSessionByID,
  handleSessionID,
  handleSessions,
  handleSessionToolCatalog,
  handleStatus,
  handleWebUI,
  nearestExistingBrowseDir,
  parsePositiveInt,
  pathWithinAnyRoot,
  serveRoutes,
  statusSnapshot,
  writeExpertHTTPError,
} from "./run_handlers.ts";
import { ErrExpertSwitchRequiresFork } from "../agentruntime/expert.ts";
import { ForkSessionNotFoundError } from "../session/fork.ts";

function minimalConfig(): ServeConfig {
  return decodeConfigBytes(JSON.stringify({
    features: { cron: true, webUI: true, memory: true },
    channels: { wechat: { enabled: false }, feishu: { enabled: false } },
  }));
}

function newRuntime(
  cfg: ServeConfig | null = minimalConfig(),
  sessionDir = Deno.makeTempDirSync(),
): ChannelRuntime {
  return new ChannelRuntime({
    cfg,
    version: "test",
    dispatcher: null,
    sessionDir,
    identityMux: { withLock: () => Promise.resolve(() => {}) } as never,
    cronStore: null,
  });
}

function jsonRequest(
  url: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined
      ? undefined
      : typeof body === "string"
      ? body
      : JSON.stringify(body),
  });
}

Deno.test("parsePositiveInt keeps only positive integers", () => {
  assertEquals(parsePositiveInt("", 7), 7);
  assertEquals(parsePositiveInt("abc", 7), 7);
  assertEquals(parsePositiveInt("0", 7), 7);
  assertEquals(parsePositiveInt("-2", 7), 7);
  assertEquals(parsePositiveInt("12", 7), 12);
});

Deno.test("channelLabel maps channel types", () => {
  assertEquals(channelLabel("wechat", "u1"), "WeChat");
  assertEquals(channelLabel("feishu", "u1"), "Feishu");
  assertEquals(channelLabel("", "u1"), "Local");
});

Deno.test("filterActiveSessions keeps only active entries", () => {
  const list = [
    { id: "a", active: true },
    { id: "b", active: false },
    { id: "c", active: true },
  ] as never[];
  const filtered = filterActiveSessions(list);
  assertEquals(filtered.length, 2);
  assertEquals((filtered[0] as { id: string }).id, "a");
});

Deno.test("pathWithinAnyRoot containment semantics", () => {
  assert(pathWithinAnyRoot("/a", ["/a", "/b"]));
  assert(pathWithinAnyRoot("/a/child", ["/a"]));
  assert(!pathWithinAnyRoot("/a/child", ["/b"]));
  // Sibling prefixes are not within the root.
  assert(!pathWithinAnyRoot("/a2", ["/a"]));
});

Deno.test("nearestExistingBrowseDir falls back to the nearest ancestor", () => {
  const base = Deno.makeTempDirSync();
  const missing = join(base, "no", "such", "dir");
  assertEquals(nearestExistingBrowseDir(missing), base);
  assertEquals(nearestExistingBrowseDir(base), base);
});

Deno.test("envViewFromConfig is secret-safe and sorted", () => {
  const view = envViewFromConfig({ B_TOKEN: "x", A_NAME: "y" });
  assertEquals(view, {
    variables: [
      { name: "A_NAME", valueConfigured: true },
      { name: "B_TOKEN", valueConfigured: true },
    ],
  });
});

Deno.test("handleEnv rejects invalid names without echoing values", async () => {
  const rt = newRuntime();
  const res = await handleEnv(rt)(
    jsonRequest("http://s/api/env", "PATCH", {
      set: [{ name: "A=B", value: "secret" }],
    }),
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, `invalid name ${JSON.stringify("A=B")}`);
  assert(!JSON.stringify(body).includes("secret"));
});

Deno.test("handleMemory disabled config: GET empty, PUT forbidden", async () => {
  const cfg = decodeConfigBytes(JSON.stringify({ memory: { enabled: false } }));
  const rt = newRuntime(cfg);
  const getRes = await handleMemory(rt)(jsonRequest("http://s/api/memory"));
  assertEquals(getRes.status, 200);
  assertEquals(await getRes.json(), { enabled: false, content: "" });
  const putRes = await handleMemory(rt)(
    jsonRequest("http://s/api/memory", "PUT", { content: "x" }),
  );
  assertEquals(putRes.status, 403);
});

Deno.test("handleWebUI serves 404 when the web UI is disabled", () => {
  const cfg = decodeConfigBytes(JSON.stringify({ webUI: { enabled: false } }));
  const rt = newRuntime(cfg);
  const res = handleWebUI(rt)(jsonRequest("http://s/anything"));
  assertEquals(res.status, 404);
  assertEquals(res.headers.get("content-type"), "text/plain; charset=utf-8");
});

Deno.test("handleStatus/handleChannels project the config snapshot", async () => {
  const rt = newRuntime();
  const statusRes = handleStatus(rt, null)(jsonRequest("http://s/api/status"));
  assertEquals(statusRes.status, 200);
  const status = await statusRes.json();
  assertEquals(status.status, "ok");
  assertEquals(status.channels.length, 2);
  assertEquals(status.webUI.enabled, true);
  const channelsRes = handleChannels(rt)(jsonRequest("http://s/api/channels"));
  assertEquals(channelsRes.status, 200);
  assertEquals((await channelsRes.json())[0].name, "wechat");
  assertEquals(
    handleStatus(rt, null)(jsonRequest("http://s/api/status", "POST")).status,
    405,
  );
});

Deno.test("statusSnapshot counts sessions via CountAll then the live pool", () => {
  const rt = newRuntime();
  const empty = statusSnapshot(rt, null);
  assertEquals(empty.sessions, 0);
  assertEquals(empty.features.webUI, true);
});

Deno.test("handleProjects CRUD round-trips over the session directory", async () => {
  const rt = newRuntime();
  const created = await handleProjects(rt)(
    jsonRequest("http://s/api/projects", "POST", { name: "demo" }),
  );
  assertEquals(created.status, 201);
  const project = await created.json();
  const listRes = await handleProjects(rt)(
    jsonRequest("http://s/api/projects"),
  );
  assertEquals(listRes.status, 200);
  assertEquals((await listRes.json()).projects.length, 1);

  const renamed = await handleProjectByID(
    rt,
    jsonRequest(`http://s/api/projects/${project.id}`, "PATCH", {
      name: "demo2",
    }),
  );
  assertEquals(renamed.status, 200);
  const deleted = await handleProjectByID(
    rt,
    jsonRequest(`http://s/api/projects/${project.id}`, "DELETE"),
  );
  assertEquals(deleted.status, 204);
  const missing = await handleProjectByID(
    rt,
    jsonRequest("http://s/api/projects/", "DELETE"),
  );
  assertEquals(missing.status, 400);
});

Deno.test("handleSessionBindings lists an empty set", async () => {
  const rt = newRuntime();
  const res = await handleSessionBindings(rt)(
    jsonRequest("http://s/api/session-bindings"),
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { bindings: [] });
});

Deno.test("handleSessionToolCatalog requires a dispatcher and platform", async () => {
  const rt = newRuntime();
  const res = await handleSessionToolCatalog(rt)(
    jsonRequest("http://s/api/session-tools/catalog?platform=wechat"),
  );
  assertEquals(res.status, 405);
});

Deno.test("session managers degrade to 503 without an API server", async () => {
  const rt = newRuntime();
  assertEquals(
    (await handleSessions(rt, null)(jsonRequest("http://s/api/sessions")))
      .status,
    503,
  );
  assertEquals(
    (await handleCapabilities(rt, null)(
      jsonRequest("http://s/api/capabilities"),
    )).status,
    503,
  );
  assertEquals(
    (await handleSessionID(rt, null)(
      jsonRequest("http://s/api/session-id", "POST"),
    )).status,
    503,
  );
});

Deno.test("handleServeConfig GET returns the snapshot and PUT applies", async () => {
  const dir = Deno.makeTempDirSync();
  const writable = join(dir, "serve.json");
  const rt = newRuntime(minimalConfig());
  const getRes = await handleServeConfig(rt, writable, null)(
    jsonRequest("http://s/api/serve/config"),
  );
  assertEquals(getRes.status, 200);
  assert((await getRes.json()).features.webUI);

  const next = decodeConfigBytes(JSON.stringify({
    features: { cron: false, webUI: false },
    channels: { wechat: { enabled: false }, feishu: { enabled: false } },
  }));
  const putRes = await handleServeConfig(rt, writable, null)(
    jsonRequest("http://s/api/serve/config", "PUT", next),
  );
  assertEquals(putRes.status, 200);
  const body = await putRes.json();
  assertEquals(body.features.webUI, false);
  // The lazy state is now pinned on the runtime for later handlers.
  assert(rt.configState instanceof ServeConfigState);
  assertEquals(rt.configState.writablePath, writable);
});

Deno.test("handleChannelConfigPatch validates platform and applies the patch", async () => {
  const dir = Deno.makeTempDirSync();
  const writable = join(dir, "serve.json");
  const rt = newRuntime();

  const bad = await handleChannelConfigPatch(rt, writable, null)(
    jsonRequest("http://s/api/serve/config/channels/slack", "PATCH", {}),
  );
  assertEquals(bad.status, 404);

  const res = await handleChannelConfigPatch(rt, writable, null)(
    jsonRequest("http://s/api/serve/config/channels/wechat", "PATCH", {
      enabled: true,
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.platform, "wechat");
  assertEquals(body.restart, { platform: "wechat", required: true });
});

Deno.test("browse handlers allow the working root and reject foreign paths", async () => {
  const cwd = Deno.makeTempDirSync();
  Deno.mkdirSync(join(cwd, "sub"));
  Deno.writeTextFileSync(join(cwd, "file.txt"), "x");
  const rt = newRuntime(
    decodeConfigBytes(JSON.stringify({
      security: { allowedWorkDirs: [cwd] },
    })),
    Deno.makeTempDirSync(),
  );

  const res = await handleBrowse(rt)(
    jsonRequest(`http://s/api/browse?path=${encodeURIComponent(cwd)}`),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.path, cwd);
  assertEquals(body.parent, cwd);
  assertEquals(body.entries, [
    { name: "sub", path: join(cwd, "sub"), isDir: true },
  ]);
  assertEquals(body.selectable, true);

  const outside = await handleBrowse(rt)(
    jsonRequest("http://s/api/browse?path=/nonexistent-opensac-root-xyz"),
  );
  // Resolves to the filesystem root, which is outside the configured roots.
  assertEquals(outside.status, 403);

  const other = Deno.makeTempDirSync();
  const foreign = await handleBrowse(rt)(
    jsonRequest(`http://s/api/browse?path=${encodeURIComponent(other)}`),
  );
  assertEquals(foreign.status, 403);
});

Deno.test("handleSelectDirectory projects the injected picker", async () => {
  const cwd = Deno.makeTempDirSync();
  const rt = newRuntime();
  rt.nativeDirectoryPicker = () => Promise.resolve("");
  const canceled = await handleSelectDirectory(rt)(
    jsonRequest("http://s/api/select-directory", "POST", {}),
  );
  assertEquals(await canceled.json(), { canceled: true, path: "" });

  rt.nativeDirectoryPicker = () => Promise.resolve(cwd);
  const picked = await handleSelectDirectory(rt)(
    jsonRequest("http://s/api/select-directory", "POST", { defaultPath: cwd }),
  );
  assertEquals(await picked.json(), { canceled: false, path: cwd });

  rt.nativeDirectoryPicker = () =>
    Promise.reject(new DOMException("no display", "NotSupportedError"));
  const failed = await handleSelectDirectory(rt)(
    jsonRequest("http://s/api/select-directory", "POST", {}),
  );
  assertEquals(failed.status, 500);
});

Deno.test("handleSessionByID validates routes and the fork contract", async () => {
  const rt = newRuntime();

  const notFound = await handleSessionByID(rt, null)(
    jsonRequest("http://s/api/sessions/abc/tail"),
  );
  assertEquals(notFound.status, 404);

  const badRoute = await handleSessionByID(rt, null)(
    jsonRequest("http://s/api/sessions//metadata", "POST", {}),
  );
  assertEquals(badRoute.status, 400);

  const noKey = await handleSessionByID(rt, null)(
    jsonRequest("http://s/api/sessions/abc/fork", "POST", {}),
  );
  assertEquals(noKey.status, 400);
  assertEquals((await noKey.json()).code, "idempotency_key_required");

  const longKey = await handleSessionByID(rt, null)(
    jsonRequest("http://s/api/sessions/abc/fork", "POST", {}, {
      "Idempotency-Key": "k".repeat(257),
    }),
  );
  assertEquals(longKey.status, 400);
  assertEquals((await longKey.json()).code, "idempotency_key_too_long");

  const active = await handleSessionByID(rt, null)(
    jsonRequest("http://s/api/sessions/active"),
  );
  assertEquals(active.status, 503);

  const deleteNoServer = await handleSessionByID(rt, null)(
    jsonRequest("http://s/api/sessions/abc", "DELETE"),
  );
  assertEquals(deleteNoServer.status, 503);
});

Deno.test("writeExpertHTTPError maps the canonical error set", () => {
  const notFound = writeExpertHTTPError(new ForkSessionNotFoundError());
  assertEquals(notFound.status, 404);
  assertEquals((notFound.body as unknown) !== null, true);
  const switchFork = writeExpertHTTPError(ErrExpertSwitchRequiresFork);
  assertEquals(switchFork.status, 409);
  const fallback = writeExpertHTTPError(new Error("invalid"));
  assertEquals(fallback.status, 400);
});

Deno.test("serveRoutes registers the management route table", async () => {
  const rt = newRuntime();
  const mux = new ServeMux();
  serveRoutes(rt, join(Deno.makeTempDirSync(), "serve.json"))(
    null as never,
    mux,
  );
  assertEquals(mux.handler("/api/status") !== undefined, true);
  assertEquals(mux.handler("/api/sessions/") !== undefined, true);
  assertEquals(mux.handler("/api/cron") !== undefined, true);
  assertEquals(mux.handler("/api/channels/wechat/login") !== undefined, true);
  assertEquals(mux.handler("/api/browse") !== undefined, true);
  assertEquals(mux.handler("/") !== undefined, true);
  // Go's "/" catch-all serves the Web UI projection for unknown paths.
  assertEquals(mux.handler("/api/unknown") !== undefined, true);
  const res = await mux.dispatch(jsonRequest("http://s/api/channels"));
  assertEquals(res.status, 200);
});
