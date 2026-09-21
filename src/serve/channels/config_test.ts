// Translated from internal/serve/channels/config_test.go.

import { assert, assertEquals } from "@std/assert";
import {
  type Config,
  defaultBackgroundRunMax,
  defaultConfig,
  getDefaultModel,
  getDefaultProvider,
  getRunMaxDurationMS,
  getRunStaleTimeoutMS,
  withConfigMethods,
} from "./config.ts";

Deno.test("defaultConfig", () => {
  const cfg = defaultConfig();
  assert(cfg.wechat.autoTyping, "expected auto_typing=true");
  assert(cfg.security.smartApprovals, "expected smart_approvals=true");
  assertEquals(cfg.agent.maxTurns, 90);
  assert(cfg.cron.enabled, "expected cron enabled by default");
  assert(!cfg.multiAgent, "expected multi_agent disabled by default");
  assert(!cfg.artifact, "expected artifact publishing disabled by default");
});

Deno.test("getDefaultProvider", () => {
  const cfg = withConfigMethods({
    ...defaultConfig(),
    defaultProvider: "openai",
  });
  assertEquals(getDefaultProvider(cfg, "deepseek"), "openai");

  const cfg2 = defaultConfig();
  assertEquals(getDefaultProvider(cfg2, "deepseek"), "deepseek");
});

Deno.test("getDefaultModel", () => {
  const cfg = withConfigMethods({ ...defaultConfig(), defaultModel: "gpt-4o" });
  assertEquals(getDefaultModel(cfg, "deepseek-chat"), "gpt-4o");

  const cfg2 = defaultConfig();
  assertEquals(getDefaultModel(cfg2, "deepseek-chat"), "deepseek-chat");

  const cfg3 = withConfigMethods({
    ...defaultConfig(),
    defaultProvider: "openai",
  });
  assertEquals(
    getDefaultModel(cfg3, "deepseek-chat"),
    "",
    "expected empty string (to fall back to provider's first model) when DefaultProvider is specified",
  );
});

Deno.test("getWorkDir", () => {
  const cfg = withConfigMethods({ ...defaultConfig(), workDir: "/tmp/test" });
  assertEquals(cfg.getWorkDir(), "/tmp/test");

  const cfg2 = withConfigMethods({ ...defaultConfig(), workDir: "." });
  const got = cfg2.getWorkDir();
  assert(got !== "" && got !== ".", `expected resolved path, got ${got}`);
});

Deno.test("getPlatformWorkDir", () => {
  const cfg = withConfigMethods({
    ...defaultConfig(),
    workDir: "/global",
    wechat: { ...defaultConfig().wechat, workDir: "/wechat" },
    feishu: { ...defaultConfig().feishu, workDir: "/feishu" },
  });

  assertEquals(cfg.getPlatformWorkDir("wechat"), "/wechat");
  assertEquals(cfg.getPlatformWorkDir("feishu"), "/feishu");
  assertEquals(cfg.getPlatformWorkDir("ws"), "/global");
});

Deno.test("cronConfig", () => {
  const cfg: Config = {
    ...defaultConfig(),
    cron: { enabled: true, interval: 60 },
  };
  assert(cfg.cron.enabled, "expected cron enabled");
  assertEquals(cfg.cron.interval, 60);
});

Deno.test("watchdog duration defaults and overrides", () => {
  const cfg = defaultConfig();
  assertEquals(getRunStaleTimeoutMS(cfg.agent), 600_000);
  assertEquals(getRunMaxDurationMS(cfg.agent), defaultBackgroundRunMax);

  const custom = { ...cfg.agent, runMaxDurationSecs: 0 };
  assertEquals(getRunMaxDurationMS(custom), defaultBackgroundRunMax);
});
