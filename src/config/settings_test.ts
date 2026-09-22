// Ported from internal/config/settings_test.go, settings_zero_test.go,
// settings_sparse_test.go, settings_maintenance_test.go, manage_additions_test.go.

import { assert, assertEquals, assertThrows } from "@std/assert";
import * as path from "@std/path";
import {
  defaultProviderConfig,
  defaultSettings,
  effectiveImageGeneration,
  getGlobalSkillsDir,
  getModelConfig,
  getProviderConfig,
  getSessionDir,
  getShell,
  globalSettingsPath,
  isACPArtifactEnabled,
  isArtifactEnabled,
  isAttachmentStorageReclaimEnabled,
  isPlanToolEnabled,
  isProjectDir,
  isUpdateCheckEnabled,
  isWebSearchEnabled,
  loadGlobalSettingsOrDefault,
  loadGlobalSettingsSparse,
  loadSettings,
  loadSettingsFor,
  loadSettingsWithMeta,
  marshalSettings,
  mergeModelConfigs,
  type ModelConfig,
  modelMaxTokensWasSet,
  normalizeSamplingPtr,
  parseSettings,
  projectSettingsPath,
  resolveKey,
  resolveKeyValue,
  resolveModelConfig,
  resolveProviderHeaders,
  saveGlobalSettingsPatch,
  setModelMaxTokens,
  skillsDisabled,
  toolExecutionEffectiveMaxConcurrency,
  toolExecutionEffectiveMode,
} from "./mod.ts";

const SAVED_ENV = [
  "OPENSAC_DIR",
  "VIBECODING_PROVIDER",
  "VIBECODING_MODEL",
  "VIBECODING_MODE",
  "VIBECODING_THINKING",
];

function withConfigDir(fn: (tmp: string) => void): void {
  const tmp = Deno.makeTempDirSync({ prefix: "cfg-" });
  const prevWd = Deno.cwd();
  const saved = SAVED_ENV.map((k) => [k, Deno.env.get(k)] as const);
  Deno.env.set("OPENSAC_DIR", path.join(tmp, "config"));
  for (
    const k of [
      "VIBECODING_PROVIDER",
      "VIBECODING_MODEL",
      "VIBECODING_MODE",
      "VIBECODING_THINKING",
    ]
  ) {
    Deno.env.delete(k);
  }
  try {
    fn(tmp);
  } finally {
    Deno.chdir(prevWd);
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

Deno.test("defaultSettings", () => {
  const s = defaultSettings();
  assertEquals(s.defaultProvider, "deepseek-openai");
  assertEquals(s.defaultModel, "deepseek-v4-flash");
  assertEquals(s.defaultMode, "yolo");
  assertEquals(s.authored, false);
  assert(!isArtifactEnabled(s) && !isACPArtifactEnabled(s));
  s.enableArtifact = true;
  assert(isArtifactEnabled(s) && !isACPArtifactEnabled(s));
  s.enableArtifact = false;
  s.enableACPArtifact = true;
  assert(!isArtifactEnabled(s) && isACPArtifactEnabled(s));

  assert(Object.keys(s.providers!).length >= 35);
  assertEquals(s.providers!.openai.maxImagesPerRequest, 1500);
  for (
    const name of [
      "openai",
      "anthropic",
      "xiaomi",
      "google-gemini",
      "google-vertex",
      "openrouter",
      "openrouter-free-models",
      "minimax",
      "zai",
      "modelscope",
      "alibaba-standard",
      "alibaba-coding-plan",
      "alibaba-token-plan",
      "moark",
      "groq",
      "moonshotai",
      "xai",
      "together",
      "fireworks",
      "kimi-coding",
      "xiaomi-token-plan-cn",
    ]
  ) {
    assert(s.providers![name], `missing provider ${name}`);
  }
  assertEquals(
    s.providers!["kimi-coding"].headers!["User-Agent"],
    "opencode/1.17.18",
  );
  for (const name of ["openai", "codeok", "yescode"]) {
    assertEquals(
      s.providers![name].headers!["User-Agent"],
      "codex_cli_rs/0.144.4",
    );
  }
  const kimi = s.providers!["kimi-coding"];
  assertEquals(kimi.baseUrl, "https://api.kimi.com/coding/v1");
  assertEquals(kimi.api, "openai-chat");
  assertEquals(kimi.thinkingFormat, "kimi");
  const k3 = kimi.models.find((m) => m.id === "k3");
  assert(k3 && k3.reasoning && k3.contextWindow === 1000000);
  const k3256 = kimi.models.find((m) => m.id === "k3-256k");
  assert(
    k3256 && k3256.reasoning && k3256.contextWindow === 262144 &&
      k3256.maxTokens === undefined,
  );

  assertEquals(s.defaultThinkingLevel, "medium");
  assertEquals(s.statusLine!.enabled, false);
  assertEquals(s.statusLine!.type, "command");
  assertEquals(s.statusLine!.timeoutMs, 800);
  assertEquals(s.statusLine!.fallback, "builtin");
  assertEquals(s.webSearch!.enabled, false);
  assertEquals(s.webSearch!.provider, "openai");
  assertEquals(s.webSearch!.providerType, "openai-responses");
  assertEquals(s.webSearch!.model, undefined);
  assertEquals(s.retry, { enabled: true, maxRetries: 5, baseDelayMs: 3000 });
});

Deno.test("default settings confirmBeforeWrite and plan tool", () => {
  const s = defaultSettings();
  assertEquals(s.approval!.confirmBeforeWrite, true);
  assert(isPlanToolEnabled(s));
  assert(isUpdateCheckEnabled(s));
});

Deno.test("default skillHub settings", () => {
  const s = defaultSettings();
  assertEquals(s.skillHub!.defaultMarket, "skillhub.cn");
  assertEquals(s.skillHub!.defaultInstallScope, "project");
  assertEquals(s.skillHub!.officialHandles, ["user_0064faa7"]);
});

Deno.test("getProviderConfig and getModelConfig", () => {
  const s = defaultSettings();
  assertEquals(getProviderConfig(s, "deepseek-openai")!.api, "openai-chat");
  assertEquals(getProviderConfig(s, "nonexistent"), undefined);
  const mc = getModelConfig(s, "deepseek-openai", "deepseek-v4-flash");
  assertEquals(mc!.name, "DeepSeek V4 Flash");
  assertEquals(getModelConfig(s, "deepseek-openai", "nonexistent"), undefined);
  assertEquals(getModelConfig(s, "nonexistent", "model"), undefined);
});

Deno.test("moark/gitee model maxTokens table", () => {
  const s = defaultSettings();
  const want: Record<string, number> = {
    "glm-5.1": 131072,
    "qwen3.5-flash": 65536,
    "qwen3.6-flash": 65536,
    "qwen3.6-plus": 65536,
    "deepseek-v4-pro": 384000,
    "deepseek-v4-pro-0813": 0,
    "qwen3.7-max": 65536,
    "qwen3.8-max": 0,
    "qwen3.8-max-0902": 131072,
    "qwen3.8-27b": 0,
    "glm-5.3": 131072,
    "glm-5.3-flash": 131072,
    "ernie-5.0-thinking": 65536,
    "kimi-k2.5": 262144,
    "kimi-k2.6": 262144,
    "kimi-k2.7-code": 262144,
    "kimi-k3": 262144,
    "glm-5": 32768,
    "qwen3.7-plus": 65536,
    "minimax-m2.7": 131072,
    "minimax-m3": 128000,
    "mimo-v2.5-pro": 131072,
    "gemma-4-26b-a4b-it": 32768,
    "deepseek-v4-flash": 384000,
    "deepseek-v4-flash-0731": 0,
    "deepseek-v4.1-flash": 0,
    "step-3.7-flash": 16384,
    "qwen3.8-flash": 0,
  };
  const moark = s.providers!["moark"];
  assertEquals(moark.maxImagesPerRequest, 5);
  assertEquals(s.providers!["gitee"].maxImagesPerRequest, 5);
  assertEquals(moark.models.length, Object.keys(want).length);
  for (const model of moark.models) {
    assert(model.id in want, `unexpected moark model ${model.id}`);
    assertEquals(model.maxTokens ?? 0, want[model.id], `moark ${model.id}`);
  }
});

Deno.test("gitee/moark qwen3.8-27b defaults", () => {
  const s = defaultSettings();
  for (const providerName of ["gitee", "moark"]) {
    const model = getModelConfig(s, providerName, "qwen3.8-27b");
    assert(model, `${providerName} missing qwen3.8-27b`);
    assert(model.reasoning && model.contextWindow === 1000000);
    assertEquals(model.input, ["text", "image", "video"]);
    assertEquals(model.maxTokens, undefined);
    assert(!modelMaxTokensWasSet(model));
  }
});

Deno.test("volcengine plan models use shared maxTokens", () => {
  const s = defaultSettings();
  for (
    const providerName of ["volcengine-agentplan", "volcengine-codingplan"]
  ) {
    const p = s.providers![providerName];
    assert(p, `missing ${providerName}`);
    for (const model of p.models) {
      if (model.id === "glm-5.3" || model.id === "glm-5.3-flash") {
        assertEquals(model.maxTokens ?? 0, 0, `${providerName} ${model.id}`);
        continue;
      }
      assertEquals(model.maxTokens ?? 0, 100000, `${providerName} ${model.id}`);
    }
  }
});

Deno.test("authored setting round trip", () => {
  const data = marshalSettings({ authored: true });
  assert(data !== "{}");
  JSON.parse(data);
  assert(parseSettings({}, data).authored === true);

  const disabled = marshalSettings({});
  assert(!disabled.includes('"authored"'));
  assert(!disabled.includes('"maintenance"'));
  assert(!disabled.includes('"skills"'));
});

Deno.test("resolveKey and resolveKeyValue", () => {
  const s = defaultSettings();
  Deno.env.set("OPENSAC_TEST_KEY", "secret-value");
  try {
    const derived = {
      ...s,
      providers: {
        test: { api: "openai-chat", models: [], apiKey: "${OPENSAC_TEST_KEY}" },
      },
    };
    assertEquals(resolveKey(derived, "test"), "secret-value");

    // provider name derivation: "my-provider" -> MY_PROVIDER_API_KEY
    Deno.env.set("MY_PROVIDER_API_KEY", "derived-key");
    assertEquals(resolveKey({ providers: {} }, "my-provider"), "derived-key");
    Deno.env.delete("MY_PROVIDER_API_KEY");

    assertEquals(resolveKeyValue("${NOPE_UNSET}"), "${NOPE_UNSET}");
    assertEquals(resolveKeyValue("plain"), "plain");
    assertEquals(resolveKeyValue("!echo hi"), "!echo hi"); // shell opt-in disabled
  } finally {
    Deno.env.delete("OPENSAC_TEST_KEY");
  }
});

Deno.test("resolveProviderHeaders falls back to built-in preset", () => {
  const s = defaultSettings();
  const headers = resolveProviderHeaders(s, "kimi-coding");
  assertEquals(headers!["User-Agent"], "opencode/1.17.18");
});

Deno.test("normalizeSamplingPtr", () => {
  assertEquals(normalizeSamplingPtr(undefined), undefined);
  assertEquals(normalizeSamplingPtr(0), undefined);
  assertEquals(normalizeSamplingPtr(0.5), 0.5);
});

Deno.test("getShell/getSessionDir/getGlobalSkillsDir", () => {
  const s = defaultSettings();
  assertEquals(getShell({ ...s, shellPath: "/bin/custom" }), "/bin/custom");
  assertEquals(
    getSessionDir({ ...s, sessionDir: "/tmp/sessions" }),
    "/tmp/sessions",
  );
  assertEquals(
    getGlobalSkillsDir({ ...s, skillsDir: "/tmp/skills" }),
    "/tmp/skills",
  );
});

Deno.test("toolExecution defaults and effective values", () => {
  const s = defaultSettings();
  assertEquals(s.toolExecution, { mode: "parallel", maxConcurrency: 10 });
  assertEquals(toolExecutionEffectiveMode({}), "parallel");
  assertEquals(
    toolExecutionEffectiveMode({ mode: "sequential" }),
    "sequential",
  );
  assertEquals(toolExecutionEffectiveMaxConcurrency({}), 10);
  assertEquals(toolExecutionEffectiveMaxConcurrency({ maxConcurrency: 4 }), 4);
});

Deno.test("skillsDisabled is null-safe and copies", () => {
  assertEquals(skillsDisabled(undefined), undefined);
  assertEquals(skillsDisabled({}), undefined);
  const s = { skills: { disabled: ["gen-skill"] } };
  const got = skillsDisabled(s)!;
  got[0] = "mutated";
  assertEquals(s.skills.disabled[0], "gen-skill");
});

Deno.test("mergeModelConfigs keeps builtin-only models", () => {
  const builtin: ModelConfig[] = [
    { id: "a", name: "A", contextWindow: 100 },
    { id: "b", name: "B" },
  ];
  const runtime: ModelConfig[] = [{ id: "b", name: "B-runtime" }];
  const merged = mergeModelConfigs(builtin, runtime);
  assertEquals(merged.map((m) => m.id), ["b", "a"]);
  assertEquals(merged[0].name, "B-runtime");
});

Deno.test("resolveModelConfig tracks explicit zero maxTokens", () => {
  const s = defaultSettings();
  // Explicit zero in project overrides the built-in maxTokens.
  const runtime = parseSettings(s, {
    providers: {
      "deepseek-openai": {
        models: [{ id: "deepseek-v4-flash", maxTokens: 0 }],
      },
    },
  });
  const resolved = resolveModelConfig(
    "deepseek-openai",
    "deepseek-v4-flash",
    runtime,
  )!;
  assertEquals(resolved.maxTokens, 0);
  assert(modelMaxTokensWasSet(resolved));

  const mc: ModelConfig = { id: "x", name: "X" };
  setModelMaxTokens(mc, 123);
  assert(modelMaxTokensWasSet(mc));
  assertEquals(mc.maxTokens, 123);
});

// ── file-level behavior ──────────────────────────────────────────────────────

Deno.test("loadGlobalSettingsSparse does not expand defaults", () => {
  withConfigDir((tmp) => {
    const p = path.join(tmp, "config", "settings.json");
    Deno.mkdirSync(path.dirname(p), { recursive: true });
    Deno.writeTextFileSync(
      p,
      JSON.stringify({
        providers: {
          xiaomi: {
            api: "openai-chat",
            baseUrl: "https://x.test",
            models: [{ id: "m" }],
          },
        },
        defaultProvider: "xiaomi",
        defaultModel: "m",
      }),
    );
    const s = loadGlobalSettingsSparse();
    assertEquals(Object.keys(s.providers!), ["xiaomi"]);
    assert(!s.providers!["openai"]);
    assert(!s.providers!["deepseek-openai"]);
  });
});

Deno.test("saveGlobalSettingsPatch preserves sparse file", () => {
  withConfigDir((tmp) => {
    const p = path.join(tmp, "config", "settings.json");
    Deno.mkdirSync(path.dirname(p), { recursive: true });
    Deno.writeTextFileSync(
      p,
      JSON.stringify({
        providers: {
          xiaomi: {
            api: "openai-chat",
            baseUrl: "https://x.test",
            models: [{ id: "m" }],
          },
        },
        defaultProvider: "xiaomi",
        maxOutputTokens: 4096,
      }),
    );
    saveGlobalSettingsPatch({ defaultMode: "yolo" });
    const text = Deno.readTextFileSync(p);
    for (
      const want of [
        `"defaultMode": "yolo"`,
        `"defaultProvider": "xiaomi"`,
        `"xiaomi"`,
      ]
    ) {
      assert(text.includes(want), `missing ${want}`);
    }
    for (
      const unexpected of [
        `"deepseek-openai"`,
        `"statusLine"`,
        `"contextFiles"`,
        `"compaction"`,
        `"sandbox"`,
        `"maxOutputTokens"`,
      ]
    ) {
      assert(!text.includes(unexpected), `unexpected ${unexpected}`);
    }
  });
});

Deno.test("loadSettingsWithMeta creates sparse default file", () => {
  withConfigDir((tmp) => {
    const project = path.join(tmp, "project");
    Deno.mkdirSync(project, { recursive: true });
    Deno.chdir(project);
    const { settings, meta } = loadSettingsWithMeta();
    assert(meta.createdGlobalConfig);
    assert(settings.providers!["deepseek-openai"]);
    const text = Deno.readTextFileSync(globalSettingsPath());
    for (
      const unexpected of [
        `"providers"`,
        `"anthropic"`,
        `"google-gemini"`,
        `"xiaomi"`,
      ]
    ) {
      assert(!text.includes(unexpected), `unexpected ${unexpected}`);
    }
    for (
      const want of [
        `"defaultProvider": "deepseek-openai"`,
        `"defaultModel": "deepseek-v4-flash"`,
        `"defaultMode": "yolo"`,
        `"statusLine"`,
        `"webSearch"`,
        `"contextFiles"`,
        `"compaction"`,
        `"sandbox"`,
        `"sessionDir"`,
        `"theme": "dark"`,
        `"retry"`,
        `"maxRetries": 5`,
        `"baseDelayMs": 3000`,
        `"approval"`,
        `"confirmBeforeWrite": true`,
      ]
    ) {
      assert(text.includes(want), `missing ${want}`);
    }
  });
});

Deno.test("maintenance defaults and sparse patch", () => {
  const zero = marshalSettings({});
  assert(!zero.includes("maintenance"));

  const absent = parseSettings({}, "{}");
  assert(isAttachmentStorageReclaimEnabled(absent));

  const configured = parseSettings(
    {},
    `{"maintenance":{"reclaimAttachmentStorage":false,"storageReconcileSchedule":"  @every 6h  "}}`,
  );
  assert(!isAttachmentStorageReclaimEnabled(configured));
  assertEquals(
    configured.maintenance!.storageReconcileSchedule,
    "  @every 6h  ",
  );

  withConfigDir(() => {
    saveGlobalSettingsPatch({
      theme: "dark",
      maintenance: { reclaimAttachmentStorage: false },
    });
    const settings = loadGlobalSettingsOrDefault();
    assert(!isAttachmentStorageReclaimEnabled(settings));
    assertEquals(settings.theme, "dark");
    assertEquals(settings.maintenance!.storageReconcileSchedule, undefined);
  });
});

Deno.test("loadSettings project supports false and zero overrides", () => {
  withConfigDir((tmp) => {
    const project = path.join(tmp, "project");
    Deno.mkdirSync(project, { recursive: true });
    Deno.chdir(project);
    Deno.env.set("OPENSAC_DIR", path.join(tmp, "config2"));
    Deno.mkdirSync(path.dirname(projectSettingsPath()), { recursive: true });
    Deno.writeTextFileSync(
      projectSettingsPath(),
      JSON.stringify({
        maxContextTokens: 0,
        webSearch: { model: "search-model" },
        contextFiles: { enabled: false },
        compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
        retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
      }),
    );
    const s = loadSettings();
    assertEquals(s.maxContextTokens, 0);
    assertEquals(s.webSearch!.model, "search-model");
    assertEquals(s.contextFiles!.enabled, false);
    assertEquals(s.compaction, {
      enabled: false,
      reserveTokens: 0,
      keepRecentTokens: 0,
    });
    assertEquals(s.retry, { enabled: false, maxRetries: 0, baseDelayMs: 0 });
  });
});

Deno.test("skills sparse round trip", () => {
  withConfigDir(() => {
    assert(!marshalSettings({}).includes("skills"));
    assertEquals(skillsDisabled(undefined), undefined);
    assertEquals(skillsDisabled({}), undefined);

    saveGlobalSettingsPatch({ skills: { disabled: ["gen-skill"] } });
    const sparse = loadGlobalSettingsSparse();
    assertEquals(skillsDisabled(sparse), ["gen-skill"]);
    const effective = loadSettings();
    assertEquals(skillsDisabled(effective), ["gen-skill"]);

    saveGlobalSettingsPatch({ skills: null });
    const raw = JSON.parse(Deno.readTextFileSync(globalSettingsPath()));
    assert(!("skills" in raw));
  });
});

Deno.test("loadSettingsFor applies env overrides and project settings", () => {
  withConfigDir((tmp) => {
    const project = path.join(tmp, "proj");
    Deno.mkdirSync(path.join(project, ".opensac"), { recursive: true });
    Deno.writeTextFileSync(
      path.join(project, ".opensac", "settings.json"),
      JSON.stringify({ theme: "light", defaultModel: "proj-model" }),
    );
    Deno.env.set("VIBECODING_PROVIDER", "proj-provider");
    try {
      const s = loadSettingsFor(project);
      assertEquals(s.theme, "light");
      assertEquals(s.defaultModel, "proj-model");
      assertEquals(s.defaultProvider, "proj-provider");
    } finally {
      Deno.env.delete("VIBECODING_PROVIDER");
    }
  });
});

Deno.test("isProjectDir", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "proj-" });
  assertEquals(isProjectDir(""), false);
  assertEquals(isProjectDir(path.join(tmp, "missing")), false);
  assertEquals(isProjectDir(tmp), false);
  Deno.mkdirSync(path.join(tmp, "go.mod"));
  assertEquals(isProjectDir(tmp), true);
});

Deno.test("effective image generation fills provider defaults", () => {
  const s = defaultSettings();
  const cfg = effectiveImageGeneration(s);
  assertEquals(cfg.provider, "openai");
  assertEquals(cfg.model, "gpt-image-1");
  assert(isWebSearchEnabled({ webSearch: { enabled: true } }));
  assert(!isWebSearchEnabled(s));
});

Deno.test("defaultProviderConfig returns a copy", () => {
  const a = defaultProviderConfig("openai")!;
  a.baseUrl = "mutated";
  const b = defaultProviderConfig("openai")!;
  assertEquals(b.baseUrl, "https://api.openai.com/v1");
  assertEquals(defaultProviderConfig("nope"), undefined);
});

Deno.test("parseSettings merges nested objects field-by-field", () => {
  const base = defaultSettings();
  const merged = parseSettings(base, `{"webSearch":{"model":"m"}}`);
  assertEquals(merged.webSearch!.model, "m");
  assertEquals(merged.webSearch!.provider, "openai");
  assertEquals(merged.webSearch!.providerType, "openai-responses");
});

Deno.test("saveGlobalSettingsPatch rejects invalid existing json", () => {
  withConfigDir((tmp) => {
    const p = path.join(tmp, "config", "settings.json");
    Deno.mkdirSync(path.dirname(p), { recursive: true });
    Deno.writeTextFileSync(p, "{not json");
    assertThrows(() => saveGlobalSettingsPatch({ theme: "dark" }));
  });
});
