// Translated from internal/serve/openaiapi/server_test.go — the Server
// lifecycle cases (SettingsSkillHub copy, SessionDir, SetRunCompleteObserver,
// ApplyServeConfig sandbox re-apply, ApplySettings provider swap) plus the
// loadRunConfig/applyRunOverrides assembly and buildWorkDirContext.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { closeAll } from "../../db/mod.ts";
import { Level } from "../../sandbox/sandbox.ts";
import { newRegistry } from "../../tools/tool.ts";
import type { Settings } from "../../config/settings.ts";
import {
  buildWorkDirContext,
  listenFromPortOverride,
  loadRunConfig,
  type RunOptions,
} from "./lifecycle.ts";
import { Server } from "./server.ts";
import { APISession, SessionPool } from "./session_mgr.ts";
import type { Config } from "./config.ts";

function tempDir(prefix: string): string {
  return Deno.makeTempDirSync({ prefix });
}

const chatSettings = {
  providers: {
    "test-provider": {
      apiKey: "test-key",
      baseUrl: "https://example.invalid/v1",
      api: "openai-chat",
      models: [{ id: "m1", name: "M1" }],
    },
    "resp-provider": {
      apiKey: "test-key",
      baseUrl: "https://example.invalid/v1",
      api: "openai-responses",
      models: [{ id: "r1", name: "R1" }],
    },
  },
} as unknown as Settings;

Deno.test("settingsSkillHubReturnsADeepCopy", () => {
  const server = new Server({
    settings: {
      skillHub: {
        officialHandles: ["a"],
        markets: [{ id: "m", name: "market", enabled: true }],
      },
    } as never,
  });
  const copy = server.settingsSkillHub();
  copy.officialHandles!.push("b");
  copy.markets![0].name = "changed";
  assertEquals(server.settings!.skillHub!.officialHandles, ["a"]);
  assertEquals(server.settings!.skillHub!.markets![0].name, "market");
});

Deno.test("settingsSkillHubWithoutSettingsIsZero", () => {
  const server = new Server();
  assertEquals(server.settingsSkillHub(), {});
});

Deno.test("sessionDirResolvesFromSettings", () => {
  const tmp = tempDir("openaiapi-sessiondir-");
  const server = new Server({ settings: { sessionDir: tmp } as never });
  assertEquals(server.sessionDir(), tmp);
  assertEquals(new Server().sessionDir(), "");
});

Deno.test("setRunCompleteObserverReplacesTheCallback", () => {
  const server = new Server();
  const seen: string[] = [];
  server.setRunCompleteObserver((sessionId, runId, status) => {
    seen.push(`${sessionId}/${runId}/${status}`);
  });
  server.runComplete!("s", "r", "completed", "");
  assertEquals(seen, ["s/r/completed"]);
  server.setRunCompleteObserver(() => {});
  server.runComplete!("s2", "r", "failed", "boom");
  assertEquals(seen, ["s/r/completed"]);
});

Deno.test("applyServeConfigClonesConfigWithoutSettings", () => {
  const server = new Server();
  const next: Config = { sandbox: { enabled: true }, defaultMode: "yolo" };
  server.applyServeConfig(next);
  assertEquals(server.cfg?.sandbox?.enabled, true);
  assertEquals(server.cfg?.defaultMode, "yolo");
});

Deno.test("applyServeConfigReappliesSandboxToPooledSessions", () => {
  const tmp = tempDir("openaiapi-applycfg-");
  const server = new Server({ settings: { sessionDir: tmp } as never });
  const pool = new SessionPool(0, 0);
  const sess = new APISession();
  sess.id = "s1";
  sess.workDir = tmp;
  sess.registry = newRegistry(tmp, undefined);
  pool.put(sess);
  server.pool = pool;

  const next: Config = {
    sandbox: { enabled: false },
    enableArtifact: true,
    defaultWorkDir: tmp,
  };
  server.applyServeConfig(next);

  assertEquals(server.cfg?.sandbox?.enabled, false);
  assert(server.sandboxMgr !== undefined);
  assertEquals(server.sandboxMgr!.getActive().level(), Level.None);
  assert(sess.sandboxMgr !== undefined);
  assertEquals(sess.sandboxMgr!.getActive().level(), Level.None);
  assertEquals(sess.registry!.getSandbox(), sess.sandboxMgr!.getActive());

  // A second apply with sandboxing disabled again refreshes the managers.
  server.applyServeConfig({ sandbox: { enabled: false }, defaultWorkDir: tmp });
  assertEquals(sess.registry!.getSandbox(), sess.sandboxMgr!.getActive());
});

Deno.test("applySettingsSwapsProviderAndModel", async () => {
  const tmp = tempDir("openaiapi-settings-");
  const server = new Server({
    cfg: { provider: "test-provider", defaultWorkDir: tmp },
  });
  await server.applySettings(chatSettings);
  assertEquals(server.providerName, "test-provider");
  assertEquals(server.model?.id, "m1");
  assertEquals(server.responsesRuns, undefined);
  assertEquals(
    server.settings?.providers?.["test-provider"] !== undefined,
    true,
  );
});

Deno.test("applySettingsOverridesWinOverServeConfig", async () => {
  const tmp = tempDir("openaiapi-settings-");
  const server = new Server({
    cfg: { provider: "test-provider", model: "m1", defaultWorkDir: tmp },
    providerOverride: "resp-provider",
    modelOverride: "r1",
  });
  await server.applySettings(chatSettings);
  assertEquals(server.providerName, "resp-provider");
  assertEquals(server.model?.id, "r1");
  // An openai-responses provider installs its background-run driver.
  assert(server.responsesRuns !== undefined);
});

Deno.test("applySettingsClearsTheDriverForChatProviders", async () => {
  const tmp = tempDir("openaiapi-settings-");
  const server = new Server({
    cfg: { provider: "resp-provider", defaultWorkDir: tmp },
  });
  await server.applySettings(chatSettings);
  assert(server.responsesRuns !== undefined);
  server.providerOverride = "test-provider";
  server.modelOverride = "";
  await server.applySettings(chatSettings);
  assertEquals(server.responsesRuns, undefined);
});

Deno.test("applySettingsWrapsProviderCreationFailures", async () => {
  const tmp = tempDir("openaiapi-settings-");
  const server = new Server({
    cfg: { provider: "definitely-not-a-provider", defaultWorkDir: tmp },
  });
  let message = "";
  try {
    await server.applySettings(chatSettings);
  } catch (err) {
    message = (err as Error).message;
  }
  assert(message.startsWith("create provider: unknown provider:"));
});

Deno.test("loadRunConfigAppliesOverrides", () => {
  const base: Config = {
    listen: "127.0.0.1:7872",
    defaultMode: "agent",
    workingDir: "/old",
  };
  const opts: RunOptions = {
    config: base,
    port: "9000",
    unsafe: true,
    multiAgent: true,
    delegate: true,
    workflows: true,
    webSearch: true,
    browser: true,
    artifact: true,
    a2aMaster: true,
    sandbox: true,
    workDir: "/tmp/work",
  };
  const cfg = loadRunConfig(opts);
  // The input config is cloned, not mutated.
  assertEquals(base.listen, "127.0.0.1:7872");
  assertEquals(base.defaultMode, "agent");
  assertEquals(base.workingDir, "/old");
  assertEquals(cfg.listen, "0.0.0.0:9000");
  assertEquals(cfg.enableSubAgents, true);
  assertEquals(cfg.enableDelegate, true);
  assertEquals(cfg.enableWorkflows, true);
  assertEquals(cfg.enableWebSearch, true);
  assertEquals(cfg.enableBrowser, true);
  assertEquals(cfg.enableArtifact, true);
  assertEquals(cfg.enableA2AMaster, true);
  assertEquals(cfg.sandbox?.enabled, true);
  assertEquals(cfg.defaultWorkDir, "/tmp/work");
  assertEquals(cfg.workingDir, "");
});

Deno.test("loadRunConfigDefaultsWhenNoConfigGiven", () => {
  const cfg = loadRunConfig({ port: "7872" });
  assertEquals(cfg.listen, ":7872");
  assertEquals(cfg.defaultMode, "yolo");
});

Deno.test("listenFromPortOverrideNormalizesPorts", () => {
  assertEquals(listenFromPortOverride("7872"), ":7872");
  assertEquals(listenFromPortOverride(":7872"), ":7872");
  assertEquals(listenFromPortOverride("127.0.0.1:7872"), "127.0.0.1:7872");
  assertEquals(listenFromPortOverride("  "), "");
});

Deno.test("buildWorkDirContextLoadsSkillsAndContextFiles", async () => {
  const tmp = tempDir("openaiapi-workdir-");
  await Deno.writeTextFile(
    join(tmp, "AGENTS.md"),
    "# project context marker\n",
  );
  const { extraContext } = await buildWorkDirContext(
    { contextFiles: { enabled: true } } as never,
    tmp,
    true,
    true,
  );
  assert(extraContext.includes("workflow-javascript"));
  assert(extraContext.includes("vibe-browser"));
  assert(extraContext.includes("project context marker"));
  // ensureProjectSkill wrote the workflow skill into the project tree.
  const stat = await Deno.stat(join(tmp, ".skills", "workflow-javascript"));
  assert(stat.isDirectory);
});

Deno.test("buildWorkDirContextWithoutFeaturesIsSkillContextOnly", async () => {
  const tmp = tempDir("openaiapi-workdir-");
  const { extraContext } = await buildWorkDirContext(
    {
      skillsDir: join(tmp, "global-skills"),
      contextFiles: { enabled: false },
    } as never,
    tmp,
    false,
    false,
  );
  // The workflow skill page is only appended when workflows are enabled.
  assertEquals(extraContext.includes("## Core rules"), false);
  assertEquals(extraContext.includes("project context marker"), false);
});

await closeAll();
