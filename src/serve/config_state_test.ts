// Focused tests for the #36 serve runtime slice: CLI override projection,
// listen-address classification, and the writable-layer config state
// (channel/full patch persistence, rollback, ephemeral override stripping).

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import * as path from "@std/path";
import {
  applyOverrides,
  applyRuntimeFeatures,
  defaultRunOptions,
  displayListenAddr,
  listenFromPortOverride,
  unsafeListenAddr,
  useEmbeddedWebUI,
} from "./options.ts";
import { defaultServeConfig } from "./config.ts";
import {
  atomicWritePrivateFile,
  cloneServeConfig,
  decodeConfigBytes,
  effectiveChannelConfig,
  parseChannelConfigPatch,
  ServeConfigState,
} from "./config_state.ts";

function withOpensacDir<T>(dir: string, fn: () => T): T {
  const previous = Deno.env.get("OPENSAC_DIR");
  Deno.env.set("OPENSAC_DIR", dir);
  try {
    return fn();
  } finally {
    if (previous === undefined) Deno.env.delete("OPENSAC_DIR");
    else Deno.env.set("OPENSAC_DIR", previous);
  }
}

Deno.test("displayListenAddr and listenFromPortOverride match Go rules", () => {
  assertEquals(displayListenAddr(":7872"), "127.0.0.1:7872");
  assertEquals(displayListenAddr("0.0.0.0:7872"), "0.0.0.0:7872");
  assertEquals(listenFromPortOverride("7872"), ":7872");
  assertEquals(listenFromPortOverride(" :8080 "), ":8080");
  assertEquals(listenFromPortOverride("127.0.0.1:9000"), "127.0.0.1:9000");
  assertEquals(listenFromPortOverride(""), "");
});

Deno.test("unsafeListenAddr binds all interfaces only for loopback/empty", () => {
  assertEquals(unsafeListenAddr(""), "0.0.0.0:7872");
  assertEquals(unsafeListenAddr(":7872"), "0.0.0.0:7872");
  assertEquals(unsafeListenAddr("127.0.0.1:7872"), "0.0.0.0:7872");
  assertEquals(unsafeListenAddr("localhost:7872"), "0.0.0.0:7872");
  assertEquals(unsafeListenAddr("[::1]:7872"), "0.0.0.0:7872");
  assertEquals(unsafeListenAddr("10.0.0.5:7872"), "10.0.0.5:7872");
  assertEquals(unsafeListenAddr("192.168.1.10:80"), "192.168.1.10:80");
});

Deno.test("useEmbeddedWebUI recognizes empty and ui/dist only", () => {
  assert(useEmbeddedWebUI(""));
  assert(useEmbeddedWebUI("ui/dist"));
  assert(useEmbeddedWebUI("ui/../ui/dist"));
  assert(!useEmbeddedWebUI("/srv/webui"));
  assert(!useEmbeddedWebUI("ui/dist2"));
});

Deno.test("applyOverrides maps every RunOptions flag", () => {
  const cfg = defaultServeConfig();
  const opts = defaultRunOptions();
  opts.port = "9999";
  opts.workDir = "/tmp/work";
  opts.unsafe = true;
  opts.provider = "deepseek";
  opts.model = "v4";
  opts.sandbox = true;
  opts.multiAgent = true;
  opts.delegate = true;
  opts.workflows = true;
  opts.webSearch = true;
  opts.browser = true;
  opts.artifact = true;
  opts.a2aMaster = true;
  opts.lobster = true;
  applyOverrides(cfg, opts);
  // unsafe rewrites the :9999 override onto all interfaces
  assertEquals(cfg.api.listen, "0.0.0.0:9999");
  assertEquals(cfg.api.defaultWorkDir, "/tmp/work");
  assertEquals(cfg.api.workingDir, "");
  assertEquals(cfg.api.auth.enabled, false);
  assertEquals(cfg.api.provider, "deepseek");
  assertEquals(cfg.api.model, "v4");
  // lobster forces sandbox off even with the --sandbox flag
  assertEquals(cfg.api.sandbox.enabled, false);
  assertEquals(cfg.api.enableSubAgents, true);
  assertEquals(cfg.features.multiAgent, true);
  assertEquals(cfg.api.enableDelegate, true);
  assertEquals(cfg.api.enableWorkflows, true);
  assertEquals(cfg.api.enableWebSearch, true);
  assertEquals(cfg.api.enableBrowser, true);
  assertEquals(cfg.api.enableArtifact, true);
  assertEquals(cfg.api.enableA2AMaster, true);
  assertEquals(cfg.lobsterMode, true);
  // lobster forces yolo/no-sandbox/subagents during normalize
  assertEquals(cfg.api.defaultMode, "yolo");
});

Deno.test("applyRuntimeFeatures projects features onto subsystems", () => {
  const cfg = defaultServeConfig();
  cfg.features.webUI = false;
  cfg.features.multiAgent = true;
  cfg.features.wechat = true;
  cfg.features.feishu = true;
  cfg.features.cron = true;
  cfg.features.memory = true;
  applyRuntimeFeatures(cfg);
  assertEquals(cfg.webUI.enabled, false);
  assertEquals(cfg.api.enableSubAgents, true);
  assertEquals(cfg.channels.wechat.enabled, true);
  assertEquals(cfg.channels.feishu.enabled, true);
  assertEquals(cfg.cron.enabled, true);
  assertEquals(cfg.memory.enabled, true);
});

Deno.test("config state uses explicit path layer and loads overrides", () => {
  const dir = Deno.makeTempDirSync();
  const explicit = path.join(dir, "custom-serve.json");
  Deno.writeTextFileSync(
    explicit,
    JSON.stringify({ listen: "127.0.0.1:7000", provider: "saved-provider" }),
  );
  const opts = defaultRunOptions();
  opts.configPath = explicit;
  opts.port = "7100";
  const state = withOpensacDir(
    Deno.makeTempDirSync(),
    () => ServeConfigState.load(opts),
  );
  assertEquals(state.writableLayer, "explicit");
  assertEquals(state.writablePath, explicit);
  // CLI override wins in effective config...
  assertEquals(state.effective.api.listen, ":7100");
  // ...but the file keeps the persisted listen.
  const persisted = JSON.parse(Deno.readTextFileSync(explicit));
  assertEquals(persisted.listen, "127.0.0.1:7000");
  assertEquals(state.snapshot().api.listen, ":7100");
});

Deno.test("updateChannel validates whitelist and persists writable layer", async () => {
  const dir = Deno.makeTempDirSync();
  const explicit = path.join(dir, "serve.json");
  Deno.writeTextFileSync(explicit, JSON.stringify({}));
  const opts = defaultRunOptions();
  opts.configPath = explicit;
  const state = withOpensacDir(dir, () => ServeConfigState.load(opts));

  assertThrows(
    () => parseChannelConfigPatch("wechat", JSON.stringify({ bad: 1 })),
    Error,
    "unsupported wechat channel field",
  );
  assertThrows(
    () => parseChannelConfigPatch("discord", JSON.stringify({})),
    Error,
    "unsupported channel",
  );
  assertThrows(
    () => parseChannelConfigPatch("wechat", JSON.stringify({ enabled: "yes" })),
    Error,
    "enabled must be a boolean",
  );

  const response = await state.updateChannel(
    "wechat",
    JSON.stringify({ enabled: true, workDir: "/srv", autoTyping: true }),
  );
  assertEquals(response.layer, "explicit");
  assertEquals(response.platform, "wechat");
  const persisted = JSON.parse(Deno.readTextFileSync(explicit));
  assertEquals(persisted.channels.wechat.workDir, "/srv");
  assertEquals(persisted.channels.wechat.autoTyping, true);
  assertEquals(persisted.features.wechat, true);
  assertEquals(state.effective.features.wechat, true);
  assertEquals(
    (response.effective as Record<string, unknown>)["workDir"],
    "/srv",
  );
});

Deno.test("feishu patch masks appSecret in the effective view", async () => {
  const dir = Deno.makeTempDirSync();
  const explicit = path.join(dir, "serve.json");
  const opts = defaultRunOptions();
  opts.configPath = explicit;
  const state = withOpensacDir(dir, () => ServeConfigState.load(opts));
  await state.updateChannel(
    "feishu",
    JSON.stringify({ appId: "cli-x", appSecret: "s3cr3t" }),
  );
  const view = effectiveChannelConfig(state.effective, "feishu") as Record<
    string,
    unknown
  >;
  assertEquals(view["appId"], "cli-x");
  assertEquals(view["appSecretConfigured"], true);
  assert(!("appSecret" in view));
});

Deno.test("updateChannel rolls the file back when apply fails", async () => {
  const dir = Deno.makeTempDirSync();
  const explicit = path.join(dir, "serve.json");
  const original = JSON.stringify({ listen: "127.0.0.1:7000" });
  Deno.writeTextFileSync(explicit, original);
  const opts = defaultRunOptions();
  opts.configPath = explicit;
  const state = withOpensacDir(dir, () => ServeConfigState.load(opts));
  await assertRejects(
    () =>
      state.updateChannel(
        "wechat",
        JSON.stringify({ workDir: "/x" }),
        () => {
          throw new Error("platform restart failed");
        },
      ),
    Error,
    "apply channel config",
  );
  assertEquals(Deno.readTextFileSync(explicit), original);
});

Deno.test("updateFull persists and strips ephemeral CLI overrides", async () => {
  const dir = Deno.makeTempDirSync();
  const explicit = path.join(dir, "serve.json");
  Deno.writeTextFileSync(
    explicit,
    JSON.stringify({ listen: "127.0.0.1:7000" }),
  );
  const opts = defaultRunOptions();
  opts.configPath = explicit;
  opts.port = "9999";
  const state = withOpensacDir(dir, () => ServeConfigState.load(opts));
  const returned = await state.updateFull(
    JSON.stringify({ listen: ":9999", provider: "p", model: "m" }),
  );
  // Effective memory config carries the CLI port override.
  assertEquals(returned.api.listen, ":9999");
  // Persisted file strips the CLI port back to... base had 7000; the body's
  // own port is an override candidate so it reverts to the base listen.
  const persisted = JSON.parse(Deno.readTextFileSync(explicit));
  assertEquals(persisted.listen, "127.0.0.1:7000");
  assertEquals(persisted.provider, "p");
  assertEquals(persisted.model, "m");
});

Deno.test("updateFull rolls back when apply fails", async () => {
  const dir = Deno.makeTempDirSync();
  const explicit = path.join(dir, "serve.json");
  Deno.writeTextFileSync(explicit, JSON.stringify({ provider: "old" }));
  const opts = defaultRunOptions();
  opts.configPath = explicit;
  const state = withOpensacDir(dir, () => ServeConfigState.load(opts));
  await assertRejects(
    () =>
      state.updateFull(JSON.stringify({ provider: "new" }), () => {
        throw new Error("runtime rejected");
      }),
    Error,
    "apply serve config",
  );
  assertEquals(
    JSON.parse(Deno.readTextFileSync(explicit)).provider,
    "old",
  );
});

Deno.test("cloneServeConfig is isolated and normalized", () => {
  const cfg = decodeConfigBytes(JSON.stringify({
    listen: ":8080",
    features: { multiAgent: true },
  }));
  const copy = cloneServeConfig(cfg);
  copy.api.listen = "1.2.3.4:1";
  copy.api.auth.tokens.push("mutated");
  assert(cfg.api.listen === ":8080");
  assertEquals(cfg.api.auth.tokens.includes("mutated"), false);
  assert(copy.api.enableSubAgents === true);
});

Deno.test("atomicWritePrivateFile creates 0600 files and parent dirs", () => {
  const dir = Deno.makeTempDirSync();
  const target = path.join(dir, "nested", "serve.json");
  atomicWritePrivateFile(target, new TextEncoder().encode("{}\n"));
  const info = Deno.statSync(target);
  assertEquals(Deno.readTextFileSync(target), "{}\n");
  // Permissions are only enforceable on POSIX.
  if (Deno.build.os !== "windows") {
    assertEquals(info.mode! & 0o777, 0o600);
  }
});

Deno.test("reload reapplies overrides after external file change", () => {
  const dir = Deno.makeTempDirSync();
  const explicit = path.join(dir, "serve.json");
  Deno.writeTextFileSync(explicit, JSON.stringify({ provider: "old" }));
  const opts = defaultRunOptions();
  opts.configPath = explicit;
  opts.provider = "flag-provider";
  const state = withOpensacDir(dir, () => ServeConfigState.load(opts));
  Deno.writeTextFileSync(explicit, JSON.stringify({ provider: "new" }));
  state.reload();
  assertEquals(state.effective.api.provider, "flag-provider");
});
