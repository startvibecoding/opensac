// the application-settings cases of acp_manage_test.go. These exercise the
// `opensac/manage/*` families ported into src/acp/manage.ts against an
// in-memory ACP server fixture, mirroring the Go `createManageFixtureServer`.

import {
  assert,
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import * as path from "@std/path";
import { AcpServer, type AcpServerSink, ACPSessionRuntime } from "./server.ts";
import {
  handleManageRequest,
  manageApplicationView,
  manageSettings,
  manageStatsQuery,
} from "./manage.ts";
import type { ACPRPCRequest } from "./wire.ts";
import { RPCError } from "../mcp/rpc.ts";
import {
  defaultSettings,
  getGlobalSkillsDir,
  globalMCPPath,
  globalSettingsPath,
  loadMCPConfig,
  saveGlobalSettings,
  saveMCPConfig,
} from "../config/mod.ts";
import type { ProviderConfig, Settings } from "../config/settings.ts";
import { createManager, projectSkillDirs } from "../skills/mod.ts";
import {
  claimDeliveryOperation,
  createDeliveryPlan,
  createSessionRun,
  type DeliveryPlan,
  getDeliveryOperation,
  type SessionRun,
  updateDeliveryOperation,
} from "../session/mod.ts";

class SyncBuffer implements AcpServerSink {
  #buf = "";
  write(data: string): void {
    this.#buf += data;
  }
  toString(): string {
    return this.#buf;
  }
  reset(): void {
    this.#buf = "";
  }
}

function createManageFixtureServer(sink: SyncBuffer, cwd = ""): AcpServer {
  const server = new AcpServer();
  server.sink = sink;
  server.cwd = cwd;
  return server;
}

function rpc(
  id: number | string,
  method: string,
  params?: unknown,
): ACPRPCRequest {
  return { jsonrpc: "2.0", idRaw: JSON.stringify(id), method, params };
}

function withEnv(name: string, value: string, fn: () => void): void {
  const previous = Deno.env.get(name);
  Deno.env.set(name, value);
  try {
    fn();
  } finally {
    if (previous === undefined) Deno.env.delete(name);
    else Deno.env.set(name, previous);
  }
}

function callManage(
  server: AcpServer,
  output: SyncBuffer,
  id: number,
  method: string,
  params: unknown,
): Record<string, unknown> {
  output.reset();
  handleManageRequest(server, rpc(id, method, params));
  const line = output.toString().trim();
  if (line === "") throw new Error(`method ${method} produced no response`);
  return JSON.parse(line) as Record<string, unknown>;
}

function manageResult(
  message: Record<string, unknown>,
): Record<string, unknown> {
  if (message["error"] !== null && message["error"] !== undefined) {
    throw new Error(
      `unexpected RPC error: ${JSON.stringify(message["error"])}`,
    );
  }
  return message["result"] as Record<string, unknown>;
}

function manageError(message: Record<string, unknown>): {
  code: string;
  data: Record<string, unknown>;
} {
  const errObj = message["error"] as Record<string, unknown> | undefined;
  if (errObj === undefined) {
    throw new Error(`want an RPC error, got ${JSON.stringify(message)}`);
  }
  const data = (errObj["data"] as Record<string, unknown> | undefined) ?? {};
  return { code: (data["code"] as string) ?? "", data };
}

function writeEnvFile(configDir: string, contents: string): void {
  Deno.mkdirSync(configDir, { recursive: true });
  Deno.writeTextFileSync(path.join(configDir, "env.json"), contents);
}

// ─── env ──────────────────────────────────────────────────────────────────────

Deno.test("manage env get never returns values", () => {
  const cwd = Deno.makeTempDirSync();
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, cwd);
    writeEnvFile(
      configDir,
      JSON.stringify({ vars: { SECRET_KEY: "shhh", PLAIN: "ok" } }),
    );

    const result = manageResult(
      callManage(server, output, 1, "opensac/manage/env/get", {}),
    );
    const vars = result["variables"] as Record<string, unknown>[];
    assertEquals(vars.length, 2);
    for (const v of vars) {
      assertStrictEquals(v["valueConfigured"], true);
      assertEquals("value" in v, false);
    }
    assertEquals("vars" in result, false);
  });
});

Deno.test("manage env patch set/replace/unset", () => {
  const cwd = Deno.makeTempDirSync();
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, cwd);
    writeEnvFile(
      configDir,
      JSON.stringify({ vars: { KEEP: "old", REMOVE: "gone" } }),
    );

    const result = manageResult(
      callManage(server, output, 1, "opensac/manage/env/patch", {
        set: [
          { name: "KEEP", value: "new" },
          { name: "ADD", value: "fresh" },
        ],
        unset: ["REMOVE"],
      }),
    );

    const vars = result["variables"] as Record<string, unknown>[];
    const names = vars.map((v) => v["name"] as string).sort();
    assertEquals(names, ["ADD", "KEEP"]);

    const env = JSON.parse(
      Deno.readTextFileSync(path.join(configDir, "env.json")),
    ) as { vars: Record<string, string> };
    assertEquals(env.vars["KEEP"], "new");
    assertEquals(env.vars["ADD"], "fresh");
    assertEquals("REMOVE" in env.vars, false);
  });
});

Deno.test("manage env patch preserves an empty value", () => {
  const cwd = Deno.makeTempDirSync();
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, cwd);

    const result = manageResult(
      callManage(server, output, 1, "opensac/manage/env/patch", {
        set: [{ name: "EMPTY", value: "" }],
      }),
    );
    const vars = result["variables"] as Record<string, unknown>[];
    assertEquals(vars.length, 1);
    assertEquals(vars[0]["name"], "EMPTY");

    const env = JSON.parse(
      Deno.readTextFileSync(path.join(configDir, "env.json")),
    ) as { vars: Record<string, string> };
    assertEquals(env.vars["EMPTY"], "");
  });
});

Deno.test("manage env patch rejects invalid names", () => {
  const cwd = Deno.makeTempDirSync();
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, cwd);
    for (
      const name of ["", "BAD=NAME", "BAD\u0000NAME", "BAD\rNAME", "BAD\nNAME"]
    ) {
      const { code } = manageError(
        callManage(server, output, 1, "opensac/manage/env/patch", {
          set: [{ name, value: "x" }],
        }),
      );
      assertEquals(code, "env_name_invalid");
    }
  });
});

Deno.test("manage env patch rejects duplicates and conflicts", () => {
  const cwd = Deno.makeTempDirSync();
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, cwd);

    assertEquals(
      manageError(
        callManage(server, output, 1, "opensac/manage/env/patch", {
          set: [
            { name: "A", value: "1" },
            { name: "A", value: "2" },
          ],
        }),
      ).code,
      "env_name_duplicate",
    );
    assertEquals(
      manageError(
        callManage(server, output, 2, "opensac/manage/env/patch", {
          set: [{ name: "A", value: "1" }],
          unset: ["A"],
        }),
      ).code,
      "env_name_conflict",
    );
  });
});

Deno.test("manage env patch rejects unknown fields", () => {
  const cwd = Deno.makeTempDirSync();
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, cwd);
    assertEquals(
      manageError(
        callManage(server, output, 1, "opensac/manage/env/patch", {
          set: [{ name: "A", value: "1" }],
          evil: true,
        }),
      ).code,
      "env_field_not_allowed",
    );
  });
});

Deno.test("manage env patch rejects malformed input without writing", () => {
  const cwd = Deno.makeTempDirSync();
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, cwd);
    writeEnvFile(configDir, JSON.stringify({ vars: { KEEP: "old" } }));
    const envPath = path.join(configDir, "env.json");
    const before = Deno.readTextFileSync(envPath);

    const cases: { patch: unknown; want: string }[] = [
      { patch: {}, want: "invalid_params" },
      { patch: { set: null }, want: "env_field_invalid" },
      { patch: { set: [{ name: "NEW" }] }, want: "env_field_invalid" },
      {
        patch: { set: [{ name: "NEW", value: "new", extra: true }] },
        want: "env_field_invalid",
      },
      {
        patch: { set: [{ name: "NEW", value: 1 }] },
        want: "env_field_invalid",
      },
      { patch: { unset: ["KEEP", "KEEP"] }, want: "env_name_duplicate" },
      {
        patch: { set: [{ name: "KEEP", value: "new" }], unset: ["KEEP"] },
        want: "env_name_conflict",
      },
    ];
    cases.forEach((tc, i) => {
      const { code } = manageError(
        callManage(server, output, i + 1, "opensac/manage/env/patch", tc.patch),
      );
      assertEquals(code, tc.want);
      assertStrictEquals(Deno.readTextFileSync(envPath), before);
    });
  });
});

Deno.test("manage env get does not leak secret value or length", () => {
  const cwd = Deno.makeTempDirSync();
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, cwd);
    writeEnvFile(
      configDir,
      JSON.stringify({ vars: { SECRET: "longsecretvaluehere" } }),
    );
    const result = manageResult(
      callManage(server, output, 1, "opensac/manage/env/get", {}),
    );
    const data = JSON.stringify(result);
    assertEquals(data.includes("longsecretvaluehere"), false);
    assertEquals(data.includes("19"), false);
  });
});

Deno.test("manage env patch never echoes the submitted value", () => {
  const cwd = Deno.makeTempDirSync();
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, cwd);
    const result = manageResult(
      callManage(server, output, 1, "opensac/manage/env/patch", {
        set: [{ name: "KEY", value: "supersecret" }],
      }),
    );
    assertEquals(JSON.stringify(result).includes("supersecret"), false);
  });
});

// ─── experts ──────────────────────────────────────────────────────────────────

function manageExpertDraft(name: string): Record<string, unknown> {
  return {
    manifest: {
      schemaVersion: 1,
      name,
      expertType: "agent",
      agentName: "lead",
      displayName: { zh: "桌面主角团", en: "Desktop Team" },
      members: [
        {
          id: "lead",
          name: { zh: "主角", en: "Lead" },
          role: "lead",
        },
      ],
    },
    agents: { lead: "---\nname: lead\n---\nYou are the lead.\n" },
  };
}

Deno.test("manage experts global default and project scope", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const workDir = Deno.makeTempDirSync();
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, workDir);

    const created = manageResult(
      callManage(server, output, 1, "opensac/manage/experts/create", {
        bundle: manageExpertDraft("desktop-global"),
      }),
    );
    assertEquals(created["scope"], "global");
    const globalBundle = created["bundle"] as Record<string, unknown>;
    assertEquals(globalBundle["scope"], "global");

    const project = manageResult(
      callManage(server, output, 2, "opensac/manage/experts/create", {
        scope: "project",
        cwd: workDir,
        bundle: manageExpertDraft("desktop-project"),
      }),
    );
    assertEquals(project["scope"], "project");
    assertEquals(project["cwd"], path.normalize(workDir));

    const listed = manageResult(
      callManage(server, output, 3, "opensac/manage/experts/list", {
        scope: "project",
        cwd: workDir,
      }),
    );
    const items = listed["experts"] as Record<string, unknown>[];
    assertEquals(
      items.some((item) => item["name"] === "desktop-project"),
      true,
    );

    const updatedDraft = manageExpertDraft("desktop-global");
    (updatedDraft["manifest"] as Record<string, unknown>)["displayName"] = {
      zh: "已更新",
      en: "Updated",
    };
    const updated = manageResult(
      callManage(server, output, 4, "opensac/manage/experts/update", {
        bundle: updatedDraft,
      }),
    );
    const updatedBundle = updated["bundle"] as Record<string, unknown>;
    const manifest = updatedBundle["manifest"] as Record<string, unknown>;
    const display = manifest["displayName"] as Record<string, unknown>;
    assertEquals(display["zh"], "已更新");

    const removed = manageResult(
      callManage(server, output, 5, "opensac/manage/experts/delete", {
        name: "desktop-global",
      }),
    );
    assertEquals(removed["deleted"], true);
    assertEquals(removed["scope"], "global");
  });
});

Deno.test("manage experts rejects a builtin scope", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, Deno.makeTempDirSync());
    const { code } = manageError(
      callManage(server, output, 1, "opensac/manage/experts/delete", {
        scope: "builtin",
        name: "software-company",
      }),
    );
    assertEquals(code, "expert_invalid_request");
  });
});

// ─── application ──────────────────────────────────────────────────────────────

Deno.test("manage application get returns the runtime-owned settings view", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, Deno.makeTempDirSync());
    const result = manageResult(
      callManage(server, output, 1, "opensac/manage/application/get", {}),
    );
    const defaults = result["defaults"] as Record<string, unknown>;
    assertStrictEquals(typeof defaults["defaultMode"], "string");
    assertStrictEquals(defaults["defaultMode"], "yolo");
    // The view never carries provider credentials.
    assertEquals(JSON.stringify(result).includes("apiKey"), false);

    // The view matches the shared projection exactly.
    assertEquals(result, manageApplicationView(manageSettings()));
  });
});

Deno.test("manage application patch updates defaults and rejects unknown fields", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, Deno.makeTempDirSync());

    assertEquals(
      manageError(
        callManage(server, output, 1, "opensac/manage/application/patch", {
          patch: { defaults: { defaultMode: "not-a-mode" } },
        }),
      ).code,
      "application_field_invalid",
    );
    assertEquals(
      manageError(
        callManage(server, output, 2, "opensac/manage/application/patch", {
          patch: { nope: {} },
        }),
      ).code,
      "application_section_not_allowed",
    );

    const updated = manageResult(
      callManage(server, output, 3, "opensac/manage/application/patch", {
        patch: { defaults: { defaultMode: "plan" } },
      }),
    );
    const defaults = updated["defaults"] as Record<string, unknown>;
    assertEquals(defaults["defaultMode"], "plan");

    // The nested section merge preserves siblings and writes through the
    // shared settings patch boundary.
    const compaction = manageResult(
      callManage(server, output, 4, "opensac/manage/application/patch", {
        patch: { compaction: { reserveTokens: 4096 } },
      }),
    );
    const compactionView = compaction["compaction"] as Record<string, unknown>;
    assertEquals(compactionView["reserveTokens"], 4096);
  });
});

Deno.test("manage router rejects unknown methods", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, Deno.makeTempDirSync());

    assertEquals(
      manageError(
        callManage(server, output, 2, "opensac/manage/bogus", {}),
      ).code,
      "manage_method_not_found",
    );
  });
});

Deno.test("initialize advertises the manage env/experts/application features", () => {
  const output = new SyncBuffer();
  const server = createManageFixtureServer(output);
  server.handleInitialize(
    rpc(1, "initialize", { protocolVersion: 1, clientCapabilities: {} }),
  );
  const message = JSON.parse(output.toString().trim()) as Record<
    string,
    unknown
  >;
  const result = message["result"] as Record<string, unknown>;
  const meta = result["_meta"] as Record<string, unknown>;
  const opensac = meta["opensac.dev"] as Record<string, unknown>;
  const features = opensac["features"] as string[];
  assertNotStrictEquals(features.indexOf("manageEnv"), -1);
  assertNotStrictEquals(features.indexOf("manageExperts"), -1);
  assertNotStrictEquals(features.indexOf("manageApplicationSettings"), -1);
});
// ─── settings and providers (translated from acp_manage_test.go) ──────────────

function writeManageSettings(
  configDir: string,
  mutate?: (settings: Settings) => void,
): Settings {
  const settings = defaultSettings();
  settings.sessionDir = path.join(configDir, "sessions");
  if (settings.retry) settings.retry.enabled = false;
  settings.defaultProvider = "manage-alpha";
  settings.defaultModel = "alpha-model";
  const providers: Record<string, ProviderConfig> = {
    "manage-alpha": {
      apiKey: "sk-alpha-SUPERSECRET-987654",
      baseUrl: "https://alpha.example.com/v1",
      api: "openai-chat",
      models: [
        { id: "alpha-model", name: "Alpha Model", input: ["text"] },
        { id: "alpha-mini", name: "Alpha Mini", input: ["text"] },
      ],
    },
    "manage-broken": {
      apiKey: "sk-broken-ALSOSECRET-111111",
      baseUrl: "http://127.0.0.1:1/v1",
      api: "openai-chat",
      models: [{ id: "broken-model", name: "Broken Model" }],
    },
  };
  settings.providers = providers;
  if (mutate) mutate(settings);
  saveGlobalSettings(settings);
  return settings;
}

function findProvider(
  result: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const entries = result["providers"] as Record<string, unknown>[];
  for (const view of entries) {
    if (view["name"] === name) return view;
  }
  throw new Error(`provider ${name} missing from view`);
}

function readRawSettings(path: string): Record<string, unknown> {
  return JSON.parse(Deno.readTextFileSync(path)) as Record<string, unknown>;
}

async function callManageAsync(
  server: AcpServer,
  output: SyncBuffer,
  id: number,
  method: string,
  params: unknown,
): Promise<Record<string, unknown>> {
  output.reset();
  handleManageRequest(server, rpc(id, method, params));
  const deadline = Date.now() + 20_000;
  while (output.toString().trim() === "") {
    if (Date.now() > deadline) {
      throw new Error(`method ${method} produced no response`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return JSON.parse(output.toString().trim()) as Record<string, unknown>;
}

Deno.test("manage settings get masks provider keys", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    // Guarantee the built-in env fallbacks resolve to "no key".
    withEnv("ANTHROPIC_API_KEY", "", () => {
      writeManageSettings(configDir);
      const output = new SyncBuffer();
      const server = createManageFixtureServer(output, configDir);
      const result = manageResult(
        callManage(server, output, 1, "opensac/manage/settings/get", {}),
      );
      assertEquals(result["defaultProvider"], "manage-alpha");
      assertEquals(result["defaultModel"], "alpha-model");
      assertEquals(result["defaultMode"], "yolo");

      const alpha = findProvider(result, "manage-alpha");
      assertEquals(alpha["maskedKey"], "sk-***654");
      assertEquals(alpha["apiKeyConfigured"], true);
      assertEquals(alpha["isDefault"], true);
      assertEquals(alpha["baseUrl"], "https://alpha.example.com/v1");
      assertEquals(alpha["modelCount"], 2);

      const broken = findProvider(result, "manage-broken");
      assertEquals(broken["maskedKey"], "sk-***111");

      const anthropic = findProvider(result, "anthropic");
      assertStrictEquals(anthropic["maskedKey"], null);
      assertEquals(anthropic["apiKeyConfigured"], false);

      const encoded = JSON.stringify(result);
      for (
        const secret of [
          "SUPERSECRET",
          "ALSOSECRET",
          "sk-alpha-SUPERSECRET-987654",
          "sk-broken-ALSOSECRET-111111",
        ]
      ) {
        assertStrictEquals(encoded.includes(secret), false);
      }
      assertStrictEquals(typeof result["sandboxEnabled"], "boolean");
      assertStrictEquals(typeof result["webSearchEnabled"], "boolean");
      const disabled = result["skillsDisabled"] as unknown[];
      assertEquals(disabled.length, 0);
    });
  });
});

Deno.test("manage settings patch whitelist round trip", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    writeManageSettings(configDir, (settings) => {
      if (settings.sandbox) settings.sandbox.level = "strict";
    });
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, configDir);

    const result = manageResult(
      callManage(server, output, 1, "opensac/manage/settings/patch", {
        patch: {
          defaultModel: "alpha-mini",
          defaultMode: "agent",
          thinkingLevel: "high",
          sandboxEnabled: true,
          webSearchEnabled: true,
        },
      }),
    );
    assertEquals(result["defaultModel"], "alpha-mini");
    assertEquals(result["defaultMode"], "agent");
    assertEquals(result["thinkingLevel"], "high");
    assertEquals(result["sandboxEnabled"], true);
    assertEquals(result["webSearchEnabled"], true);

    let raw = readRawSettings(globalSettingsPath());
    const sandbox = raw["sandbox"] as Record<string, unknown>;
    assertEquals(sandbox["enabled"], true);
    assertEquals(sandbox["level"], "strict");
    const providers = raw["providers"] as Record<
      string,
      Record<string, unknown>
    >;
    assertEquals(
      providers["manage-alpha"]["apiKey"],
      "sk-alpha-SUPERSECRET-987654",
    );
    assertEquals(raw["defaultThinkingLevel"], "high");

    // providerKey / providerBaseUrl merge into the existing provider entry.
    const rotated = manageResult(
      callManage(server, output, 2, "opensac/manage/settings/patch", {
        patch: {
          providerKey: {
            name: "manage-alpha",
            key: "sk-rotated-NEWSECRET-555",
          },
          providerBaseUrl: {
            name: "manage-alpha",
            url: "https://alpha2.example.com/v1",
          },
        },
      }),
    );
    const alpha = findProvider(rotated, "manage-alpha");
    assertEquals(alpha["maskedKey"], "sk-***555");
    assertEquals(alpha["baseUrl"], "https://alpha2.example.com/v1");
    assertEquals(alpha["modelCount"], 2);

    raw = readRawSettings(globalSettingsPath());
    const entry = (raw["providers"] as Record<string, Record<string, unknown>>)[
      "manage-alpha"
    ];
    assertEquals(entry["apiKey"], "sk-rotated-NEWSECRET-555");
    assertEquals(entry["baseUrl"], "https://alpha2.example.com/v1");
    assertEquals(entry["api"], "openai-chat");
    assertEquals((entry["models"] as unknown[]).length, 2);

    const encoded = JSON.stringify(rotated);
    assertStrictEquals(encoded.includes("NEWSECRET"), false);
    assertStrictEquals(encoded.includes("SUPERSECRET"), false);
  });
});

Deno.test("manage settings patch rejects disallowed and invalid", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    writeManageSettings(configDir);
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, configDir);

    const cases: Array<
      { patch: Record<string, unknown>; code: string; field: string }
    > = [
      {
        patch: { memoryEnabled: true },
        code: "settings_field_not_allowed",
        field: "memoryEnabled",
      },
      {
        patch: { shellPath: "/bin/zsh" },
        code: "settings_field_not_allowed",
        field: "shellPath",
      },
      {
        patch: { defaultMode: "turbo" },
        code: "settings_field_invalid",
        field: "defaultMode",
      },
      {
        patch: { thinkingLevel: "ultra" },
        code: "settings_field_invalid",
        field: "thinkingLevel",
      },
      {
        patch: { providerKey: { name: "ghost", key: "x" } },
        code: "settings_field_invalid",
        field: "providerKey",
      },
      {
        patch: { providerKey: { name: "manage-alpha" } },
        code: "settings_field_invalid",
        field: "providerKey",
      },
      {
        patch: { defaultModel: "  " },
        code: "settings_field_invalid",
        field: "defaultModel",
      },
      {
        patch: { sandboxEnabled: "yes" },
        code: "settings_field_invalid",
        field: "sandboxEnabled",
      },
    ];
    let index = 1;
    for (const testCase of cases) {
      const { code, data } = manageError(
        callManage(server, output, index++, "opensac/manage/settings/patch", {
          patch: testCase.patch,
        }),
      );
      assertEquals(code, testCase.code);
      assertEquals(data["field"], testCase.field);
    }

    assertEquals(
      manageError(
        callManage(server, output, 90, "opensac/manage/settings/patch", {
          patch: {},
        }),
      ).code,
      "invalid_params",
    );

    // Rejections never touch the file.
    const raw = readRawSettings(globalSettingsPath());
    assertEquals("memoryEnabled" in raw, false);
    assertEquals(raw["defaultModel"], "alpha-model");
  });
});

Deno.test("manage providers list projects catalog", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    writeManageSettings(configDir);
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, configDir);

    const result = manageResult(
      callManage(server, output, 1, "opensac/manage/providers/list", {}),
    );
    assertEquals(result["defaultProvider"], "manage-alpha");
    assertEquals(result["defaultModel"], "alpha-model");

    const alpha = findProvider(result, "manage-alpha");
    assertEquals(alpha["modelCount"], 2);
    assertEquals(alpha["maskedKey"], "sk-***654");

    const models = result["models"] as Record<string, unknown>[];
    const byProvider: Record<string, number> = {};
    let foundAlphaModel = false;
    for (const model of models) {
      const provider = model["provider"] as string;
      byProvider[provider] = (byProvider[provider] ?? 0) + 1;
      if (provider === "manage-alpha" && model["id"] === "alpha-model") {
        foundAlphaModel = true;
      }
    }
    assertStrictEquals(foundAlphaModel, true);
    assertEquals(byProvider["manage-alpha"], 2);
    assertEquals(byProvider["manage-broken"], 1);

    const encoded = JSON.stringify(result);
    assertStrictEquals(encoded.includes("SUPERSECRET"), false);
    assertStrictEquals(encoded.includes("ALSOSECRET"), false);
  });
});

Deno.test("manage providers config save delete and discover", async () => {
  const configDir = Deno.makeTempDirSync();
  await withEnvAsync("OPENSAC_DIR", configDir, async () => {
    writeManageSettings(configDir);
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, configDir);

    const initial = manageResult(
      callManage(server, output, 1, "opensac/manage/providers/list", {}),
    );
    const configs = initial["providerConfigs"] as unknown[];
    assertNotStrictEquals(configs.length, 0);
    const encodedInitial = JSON.stringify(initial);
    assertStrictEquals(encodedInitial.includes("SUPERSECRET"), false);
    assertStrictEquals(encodedInitial.includes("ALSOSECRET"), false);

    const created = manageResult(
      callManage(server, output, 2, "opensac/manage/providers/save", {
        id: "desktop-custom",
        apiKey: "sk-desktop-NEWSECRET-444",
        provider: {
          vendor: "custom",
          api: "openai-chat",
          baseUrl: "https://desktop.example.com/v1",
          httpProxy: "http://127.0.0.1:7890",
          headers: { Authorization: "Bearer header-HEADERSECRET" },
          thinkingFormat: "openai",
          models: [{
            id: "desktop-model",
            name: "Desktop Model",
            reasoning: true,
            contextWindow: 123456,
            maxTokens: 4096,
            input: ["text", "image"],
          }],
        },
      }),
    );
    const custom = findProvider(created, "desktop-custom");
    assertEquals(custom["modelCount"], 1);
    assertEquals(custom["maskedKey"], "sk-***444");
    const encodedCreated = JSON.stringify(created);
    assertStrictEquals(encodedCreated.includes("NEWSECRET"), false);
    assertStrictEquals(encodedCreated.includes("HEADERSECRET"), false);

    let raw = readRawSettings(globalSettingsPath());
    let providers = raw["providers"] as Record<string, Record<string, unknown>>;
    assertEquals(
      providers["desktop-custom"]["apiKey"],
      "sk-desktop-NEWSECRET-444",
    );
    assertEquals(providers["desktop-custom"]["api"], "openai-chat");
    assertEquals(
      (providers["desktop-custom"]["headers"] as Record<string, unknown>)[
        "Authorization"
      ],
      "Bearer header-HEADERSECRET",
    );

    // A model or endpoint edit must preserve the existing secret header.
    manageResult(
      callManage(server, output, 3, "opensac/manage/providers/save", {
        id: "desktop-custom",
        provider: { baseUrl: "https://desktop-2.example.com/v1" },
      }),
    );
    raw = readRawSettings(globalSettingsPath());
    providers = raw["providers"] as Record<string, Record<string, unknown>>;
    assertEquals(
      (providers["desktop-custom"]["headers"] as Record<string, unknown>)[
        "Authorization"
      ],
      "Bearer header-HEADERSECRET",
    );

    assertEquals(
      manageError(
        callManage(server, output, 4, "opensac/manage/providers/save", {
          id: "desktop-custom",
          provider: {
            api: "openai-chat",
            baseUrl: "https://desktop.example.com/v1",
            unknown: true,
          },
        }),
      ).code,
      "provider_field_not_allowed",
    );

    const deleted = manageResult(
      callManage(server, output, 5, "opensac/manage/providers/delete", {
        id: "desktop-custom",
      }),
    );
    for (const entry of deleted["providers"] as Record<string, unknown>[]) {
      assertNotStrictEquals(entry["name"], "desktop-custom");
    }

    const modelServer = Deno.serve(
      { hostname: "127.0.0.1", port: 0 },
      (req) => {
        const url = new URL(req.url);
        if (url.pathname !== "/v1/models") {
          return new Response("not found", { status: 404 });
        }
        if (req.headers.get("authorization") !== "Bearer sk-discover-SECRET") {
          return new Response("unauthorized", { status: 401 });
        }
        return new Response(
          JSON.stringify({
            data: [{
              id: "discovered-model",
              name: "Discovered Model",
              context_window: 64000,
              max_tokens: 8192,
            }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    );
    try {
      const discovered = manageResult(
        await callManageAsync(
          server,
          output,
          6,
          "opensac/manage/providers/discover",
          {
            api: "openai-chat",
            baseUrl: `http://127.0.0.1:${modelServer.addr.port}/v1`,
            apiKey: "sk-discover-SECRET",
          },
        ),
      );
      const models = discovered["models"] as Record<string, unknown>[];
      assertEquals(models.length, 1);
      assertEquals(models[0]["id"], "discovered-model");
      assertStrictEquals(
        JSON.stringify(discovered).includes("discover-SECRET"),
        false,
      );
    } finally {
      await modelServer.shutdown();
    }
  });
});

Deno.test("manage providers test structured paths", async () => {
  const configDir = Deno.makeTempDirSync();
  await withEnvAsync("OPENSAC_DIR", configDir, async () => {
    writeManageSettings(configDir);
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, configDir);

    assertEquals(
      manageError(
        callManage(server, output, 1, "opensac/manage/providers/test", {}),
      ).code,
      "invalid_params",
    );
    assertEquals(
      manageError(
        callManage(server, output, 2, "opensac/manage/providers/test", {
          provider: "ghost",
        }),
      ).code,
      "provider_not_found",
    );

    const result = manageResult(
      await callManageAsync(
        server,
        output,
        3,
        "opensac/manage/providers/test",
        {
          provider: "manage-broken",
        },
      ),
    );
    assertEquals(result["ok"], false);
    const message = result["error"] as string;
    assertNotStrictEquals(message.trim(), "");
    assertStrictEquals(message.includes("ALSOSECRET"), false);
    assertStrictEquals(message.includes("sk-broken"), false);
  });
});

async function withEnvAsync(
  name: string,
  value: string,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = Deno.env.get(name);
  Deno.env.set(name, value);
  try {
    await fn();
  } finally {
    if (previous === undefined) Deno.env.delete(name);
    else Deno.env.set(name, previous);
  }
}

// ─── skills / mcp / stats / memory / deliveries ───────────────────────────────
// from manage_delivery_test.go.

function writeManageSkill(
  dir: string,
  name: string,
  description: string,
): void {
  const skillDir = path.join(dir, name);
  Deno.mkdirSync(skillDir, { recursive: true });
  Deno.writeTextFileSync(
    path.join(skillDir, "SKILL.md"),
    `# ${name}\n\n${description}\n`,
  );
}

Deno.test("manage skills list/set round trip", () => {
  const configDir = Deno.makeTempDirSync();
  const workDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const settings = writeManageSettings(configDir);
    writeManageSkill(
      path.join(configDir, "skills"),
      "global-gen",
      "global generator skill",
    );
    writeManageSkill(
      path.join(workDir, ".skills"),
      "proj-skill",
      "project skill",
    );
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, workDir);
    server.skillsMgr = createManager(
      getGlobalSkillsDir(settings),
      projectSkillDirs(workDir),
    );
    server.skillsMgr.load();

    const listed = manageResult(
      callManage(server, output, 1, "opensac/manage/skills/list", {
        cwd: workDir,
      }),
    );
    const byName: Record<string, Record<string, unknown>> = {};
    for (const entry of listed["skills"] as Record<string, unknown>[]) {
      byName[entry["name"] as string] = entry;
    }
    assertEquals(Object.keys(byName).length, 4);
    assertStrictEquals(byName["expert-creater"]["source"], "builtin");
    assertStrictEquals(byName["vibe-browser"]["source"], "builtin");
    assertStrictEquals(byName["global-gen"]["source"], "global");
    assertStrictEquals(byName["proj-skill"]["source"], "project");
    assertStrictEquals(byName["global-gen"]["enabled"], true);
    assertStrictEquals(byName["proj-skill"]["enabled"], true);
    assertStrictEquals(byName["global-gen"]["description"], "global-gen");

    const set = manageResult(
      callManage(server, output, 2, "opensac/manage/skills/set", {
        name: "global-gen",
        enabled: false,
        cwd: workDir,
      }),
    );
    assertEquals(set["name"], "global-gen");
    assertStrictEquals(set["enabled"], false);
    assertEquals(set["skillsDisabled"], ["global-gen"]);
    const raw = readRawSettings(globalSettingsPath());
    const skillsSection = raw["skills"] as Record<string, unknown>;
    assertEquals(skillsSection["disabled"], ["global-gen"]);
    // The live runtime manager picked the toggle up without a reload.
    assertStrictEquals(server.skillsMgr!.isSkillDisabled("global-gen"), true);
    assertStrictEquals(server.skillsMgr!.get("global-gen"), undefined);
    assertEquals(server.skillsMgr!.listAll().length, 4);
    assertEquals(server.skillsMgr!.list().length, 3);

    const relisted = manageResult(
      callManage(server, output, 3, "opensac/manage/skills/list", {
        cwd: workDir,
      }),
    );
    for (const entry of relisted["skills"] as Record<string, unknown>[]) {
      if (entry["name"] === "global-gen") {
        assertStrictEquals(entry["enabled"], false);
      }
    }

    const settingsView = manageResult(
      callManage(server, output, 4, "opensac/manage/settings/get", {}),
    );
    assertEquals(settingsView["skillsDisabled"], ["global-gen"]);

    // Re-enable removes the entry and keeps the sparse file sparse.
    const reenabled = manageResult(
      callManage(server, output, 5, "opensac/manage/skills/set", {
        name: "global-gen",
        enabled: true,
        cwd: workDir,
      }),
    );
    assertStrictEquals(reenabled["enabled"], true);
    const rawAfter = readRawSettings(globalSettingsPath());
    assertStrictEquals("skills" in rawAfter, false);
    assertStrictEquals(server.skillsMgr!.isSkillDisabled("global-gen"), false);
    assertNotStrictEquals(server.skillsMgr!.get("global-gen"), undefined);

    assertEquals(
      manageError(
        callManage(server, output, 6, "opensac/manage/skills/set", {
          name: "missing-skill",
          enabled: false,
          cwd: workDir,
        }),
      ).code,
      "skill_not_found",
    );
    assertEquals(
      manageError(
        callManage(server, output, 7, "opensac/manage/skills/set", {
          name: "global-gen",
          cwd: workDir,
        }),
      ).code,
      "invalid_params",
    );
    assertEquals(
      manageError(
        callManage(server, output, 8, "opensac/manage/skills/list", {
          cwd: "relative/dir",
        }),
      ).code,
      "skills_unavailable",
    );
  });
});

function writeManageMCPFile(): void {
  saveMCPConfig(globalMCPPath(), {
    mcpServers: [
      {
        name: "keeper",
        type: "stdio",
        command: "/bin/keep",
        args: ["--old"],
        env: [{ name: "TOKEN", value: "mcp-super-secret" }],
        headers: [{ name: "Authorization", value: "Bearer hdr-secret" }],
      },
      { name: "goner", type: "stdio", command: "/bin/gone" },
    ],
  });
}

Deno.test("manage mcp list returns complete local config", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    writeManageSettings(configDir);
    writeManageMCPFile();
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, configDir);

    const result = manageResult(
      callManage(server, output, 1, "opensac/manage/mcp/list", {}),
    );
    const servers = result["servers"] as Record<string, unknown>[];
    assertEquals(servers.length, 2);
    const keeper = servers[0];
    assertEquals(keeper["name"], "keeper");
    assertEquals(keeper["command"], "/bin/keep");
    assertStrictEquals(keeper["enabled"], true);
    const env = keeper["env"] as Record<string, unknown>[];
    assertEquals(env.length, 1);
    assertEquals(env[0]["name"], "TOKEN");
    assertEquals(env[0]["value"], "mcp-super-secret");
    const headers = keeper["headers"] as Record<string, unknown>[];
    assertEquals(headers.length, 1);
    assertEquals(headers[0]["name"], "Authorization");
    assertEquals(headers[0]["value"], "Bearer hdr-secret");
  });
});

Deno.test("manage mcp set replaces and merges", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    writeManageSettings(configDir);
    writeManageMCPFile();
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, configDir);

    const result = manageResult(
      callManage(server, output, 1, "opensac/manage/mcp/set", {
        servers: [
          {
            name: "keeper",
            command: "/bin/keep2",
            args: ["--new"],
            enabled: false,
            env: [{ name: "TOKEN", value: "rotated-secret" }],
            headers: [{
              name: "Authorization",
              value: "Bearer rotated-header",
            }],
          },
          { name: "remote", type: "http", url: "https://mcp.example.org/api" },
        ],
      }),
    );
    const servers = result["servers"] as Record<string, unknown>[];
    assertEquals(servers.length, 2);
    const views: Record<string, Record<string, unknown>> = {};
    for (const view of servers) views[view["name"] as string] = view;
    assertStrictEquals("goner" in views, false);
    assertEquals(views["keeper"]["command"], "/bin/keep2");
    assertStrictEquals(views["keeper"]["enabled"], false);
    assertEquals(views["keeper"]["args"], ["--new"]);
    const keeperEnv = views["keeper"]["env"] as Record<string, unknown>[];
    assertEquals(keeperEnv[0]["value"], "rotated-secret");
    assertEquals(views["remote"]["type"], "http");
    assertEquals(views["remote"]["url"], "https://mcp.example.org/api");
    assertStrictEquals(views["remote"]["enabled"], true);

    const saved = loadMCPConfig(globalMCPPath());
    assertEquals(saved.mcpServers!.length, 2);
    const keeperSaved = saved.mcpServers!.find((srv) => srv.name === "keeper")!;
    assertEquals(keeperSaved.env![0].value, "rotated-secret");
    assertEquals(keeperSaved.headers![0].value, "Bearer rotated-header");
    assertStrictEquals(keeperSaved.enabled, false);

    // Schema validation.
    assertEquals(
      manageError(
        callManage(server, output, 2, "opensac/manage/mcp/set", {
          servers: [{
            name: "x",
            command: "/bin/x",
            env: [{ name: "", value: "x" }],
          }],
        }),
      ).code,
      "mcp_server_invalid",
    );
    assertEquals(
      manageError(
        callManage(server, output, 3, "opensac/manage/mcp/set", {
          servers: [{ name: "no-command" }],
        }),
      ).code,
      "mcp_server_invalid",
    );
    assertEquals(
      manageError(
        callManage(server, output, 4, "opensac/manage/mcp/set", {
          servers: [
            { name: "dup", command: "/bin/a" },
            { name: "dup", command: "/bin/b" },
          ],
        }),
      ).code,
      "mcp_server_invalid",
    );
    assertEquals(
      manageError(
        callManage(server, output, 5, "opensac/manage/mcp/set", {
          servers: [{
            name: "bad",
            type: "carrier-pigeon",
            url: "https://x.example",
          }],
        }),
      ).code,
      "mcp_server_invalid",
    );
    assertEquals(
      manageError(
        callManage(server, output, 6, "opensac/manage/mcp/set", {}),
      ).code,
      "invalid_params",
    );
    assertEquals(loadMCPConfig(globalMCPPath()).mcpServers!.length, 2);

    const cleared = manageResult(
      callManage(server, output, 7, "opensac/manage/mcp/set", { servers: [] }),
    );
    assertEquals((cleared["servers"] as unknown[]).length, 0);
  });
});

Deno.test("manage mcp project scope uses active session work dir", () => {
  const configDir = Deno.makeTempDirSync();
  const workDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    writeManageSettings(configDir);
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, workDir);
    const rt = new ACPSessionRuntime();
    rt.id = "project-session";
    rt.runtime = { workDir } as unknown as ACPSessionRuntime["runtime"];
    server.sessions.set("project-session", rt);

    const result = manageResult(
      callManage(server, output, 1, "opensac/manage/mcp/set", {
        scope: "project",
        sessionId: "project-session",
        servers: [{
          name: "project-server",
          type: "stdio",
          command: "/bin/project",
        }],
      }),
    );
    assertEquals(result["scope"], "project");
    assertEquals(result["sessionId"], "project-session");
    const projectPath = path.join(workDir, ".opensac", "mcp.json");
    assertEquals(result["path"], projectPath);
    const project = loadMCPConfig(projectPath);
    assertEquals(project.mcpServers!.length, 1);
    assertEquals(project.mcpServers![0].name, "project-server");
    // A project-scoped set must not write the global mcp.json.
    let globalMissing = false;
    try {
      loadMCPConfig(globalMCPPath());
    } catch (err) {
      globalMissing = err instanceof Deno.errors.NotFound;
    }
    assertStrictEquals(globalMissing, true);

    const listed = manageResult(
      callManage(server, output, 2, "opensac/manage/mcp/list", {
        scope: "project",
        sessionId: "project-session",
      }),
    );
    assertEquals((listed["servers"] as unknown[]).length, 1);

    assertEquals(
      manageError(
        callManage(server, output, 3, "opensac/manage/mcp/list", {
          scope: "project",
          sessionId: "missing-session",
        }),
      ).code,
      "mcp_scope_invalid",
    );
  });
});

Deno.test("manage stats query mapping", () => {
  const def = manageStatsQuery({ from: "", to: "", group: "" });
  assertEquals(def.groupBy, "day");
  assertStrictEquals(def.from, undefined);

  const week = manageStatsQuery({
    from: "2026-01-02",
    to: "2026-01-03",
    group: "week",
  });
  assertEquals(week.groupBy, "week");
  assert(week.from!.toISOString().startsWith("2026-01-02"));
  // Date-only "to" includes the full day, matching the shared parser.
  assert(week.to!.toISOString().startsWith("2026-01-04"));

  const rfc = manageStatsQuery({
    from: "2026-01-02T03:04:05Z",
    to: "",
    group: "",
  });
  assertEquals(rfc.from!.toISOString(), "2026-01-02T03:04:05.000Z");

  let groupErr: RPCError | null = null;
  try {
    manageStatsQuery({ from: "", to: "", group: "year" });
  } catch (err) {
    groupErr = err as RPCError;
  }
  assertEquals(
    (groupErr?.data as Record<string, unknown>)["code"],
    "stats_group_invalid",
  );

  let timeErr: RPCError | null = null;
  try {
    manageStatsQuery({ from: "yesterday", to: "", group: "" });
  } catch (err) {
    timeErr = err as RPCError;
  }
  assertEquals(
    (timeErr?.data as Record<string, unknown>)["code"],
    "stats_time_invalid",
  );
});

Deno.test("manage memory round trip and limit", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    writeManageSettings(configDir);
    const output = new SyncBuffer();
    const server = createManageFixtureServer(output, configDir);

    const empty = manageResult(
      callManage(server, output, 1, "opensac/manage/memory/get", {}),
    );
    assertEquals(empty["content"], "");
    assertEquals(empty["size"], 0);
    const wantPath = path.join(configDir, "memory.md");
    assertEquals(empty["path"], wantPath);
    assertEquals(empty["source"], "explicit");

    const content = "# Memory\n\nhello world";
    const put = manageResult(
      callManage(server, output, 2, "opensac/manage/memory/put", { content }),
    );
    assertEquals(put["size"], content.length);
    assertNotStrictEquals(put["updatedAt"], "");
    assertEquals(Deno.readTextFileSync(wantPath), content);

    const roundTrip = manageResult(
      callManage(server, output, 3, "opensac/manage/memory/get", {}),
    );
    assertEquals(roundTrip["content"], content);

    const maxBytes = 1 << 20;
    const oversize = manageError(
      callManage(server, output, 4, "opensac/manage/memory/put", {
        content: "a".repeat(maxBytes + 1),
      }),
    );
    assertEquals(oversize.code, "memory_too_large");
    assertEquals(oversize.data["maxBytes"], maxBytes);
    assertEquals(oversize.data["size"], maxBytes + 1);

    assertEquals(
      manageError(
        callManage(server, output, 5, "opensac/manage/memory/put", {}),
      ).code,
      "invalid_params",
    );
    // The rejected oversize put left the stored content untouched.
    assertEquals(Deno.readTextFileSync(wantPath), content);
  });
});

function baseDeliveryRun(overrides: Partial<SessionRun>): SessionRun {
  return {
    id: "",
    sessionId: "",
    intentId: "",
    retryOf: "",
    attempt: 0,
    workDir: "",
    source: "",
    model: "",
    mode: "",
    status: "",
    startedAt: new Date(),
    updatedAt: new Date(),
    finishedAt: null,
    error: "",
    errorInfo: undefined,
    progress: undefined,
    usage: undefined,
    contextUsage: undefined,
    inputResourceIds: [],
    submissionKeyHash: "",
    submissionScope: "",
    submissionFingerprint: "",
    userEntryId: "",
    assistantEntryId: "",
    ...overrides,
  };
}

function deliveryManageFixture(
  failureCode: string,
  status: string,
): {
  server: AcpServer;
  output: SyncBuffer;
  sessionDir: string;
  sessionID: string;
  operationID: string;
} {
  const workDir = Deno.makeTempDirSync();
  const sessionDir = path.join(workDir, "sessions");
  const sessionID = "delivery-session";
  const started = new Date();
  // The delivery plan validates that its Run belongs to the session, so the
  // fixture seeds a completed Run exactly like the Go `manage_delivery_test.go`
  // fixture (see the documented legacyTestAllowlist entry).
  createSessionRun(
    sessionDir,
    baseDeliveryRun({
      id: "acp-delivery-run",
      sessionId: sessionID,
      status: "completed",
      startedAt: started,
      updatedAt: started,
      finishedAt: started,
    }),
  );
  const plan: DeliveryPlan = {
    intent: {
      id: "acp-delivery-intent",
      sessionId: sessionID,
      runId: "acp-delivery-run",
      platform: "wechat",
      targetId: "chat",
      replyMessageId: "",
      transportContext: { caption: "hello" },
      status: "pending",
      createdAt: started,
      updatedAt: started,
    },
    operations: [{
      id: "acp-delivery-op",
      intentId: "acp-delivery-intent",
      operationKey: "caption",
      artifactId: "",
      operationKind: "send_text",
      sequence: 1,
      dependsOn: "",
      idempotencyKey: "acp-delivery-op",
      payloadDigest: "sha256:x",
      status: "pending",
      providerAssetId: "",
      providerMessageId: "",
      providerState: undefined,
      attemptCount: 0,
      nextAttemptAt: null,
      failureCode: "",
      retryWindowStartedAt: null,
      leaseOwner: "",
      leaseEpoch: 0,
      createdAt: started,
      updatedAt: started,
    }],
  };
  createDeliveryPlan(sessionDir, plan);
  if (status !== "") {
    const claimed = claimDeliveryOperation(
      sessionDir,
      "acp-delivery-op",
      "acp-worker",
      new Date(),
      60_000,
    );
    updateDeliveryOperation(
      sessionDir,
      "acp-delivery-op",
      "acp-worker",
      claimed.leaseEpoch,
      status,
      "",
      "",
      undefined,
      failureCode,
      null,
    );
  }
  const output = new SyncBuffer();
  const server = createManageFixtureServer(output, workDir);
  const settings = defaultSettings();
  settings.sessionDir = sessionDir;
  server.settings = settings;
  return {
    server,
    output,
    sessionDir,
    sessionID,
    operationID: "acp-delivery-op",
  };
}

Deno.test("manage deliveries list projects failures", () => {
  const { server, output, sessionID } = deliveryManageFixture(
    "delivery_retries_exhausted",
    "failed",
  );
  const result = manageResult(
    callManage(server, output, 1, "opensac/manage/deliveries/list", {
      sessionId: sessionID,
    }),
  );
  const deliveries = result["deliveries"] as Record<string, unknown>[];
  assertEquals(deliveries.length, 1);
  const entry = deliveries[0];
  assertEquals(entry["operationId"], "acp-delivery-op");
  assertEquals(entry["platform"], "wechat");
  assertEquals(entry["failureCode"], "delivery_retries_exhausted");
  assertStrictEquals(entry["retryable"], true);
  for (const forbidden of ["payload", "providerState", "transportContext"]) {
    assertStrictEquals(forbidden in entry, false);
  }
});

Deno.test("manage deliveries retry reopens and clears the failure", () => {
  const { server, output, sessionID } = deliveryManageFixture(
    "delivery_retries_exhausted",
    "failed",
  );
  const retry = manageResult(
    callManage(server, output, 2, "opensac/manage/deliveries/retry", {
      operationId: "acp-delivery-op",
    }),
  );
  assertStrictEquals(retry["retried"], true);

  const after = manageResult(
    callManage(server, output, 3, "opensac/manage/deliveries/list", {
      sessionId: sessionID,
    }),
  );
  assertEquals(after["count"], 0);

  assertEquals(
    manageError(
      callManage(server, output, 4, "opensac/manage/deliveries/retry", {}),
    ).code,
    "invalid_params",
  );
});

Deno.test("manage deliveries retry refuses non-retryable operations", () => {
  const nonRetryable = deliveryManageFixture(
    "unsupported_media_kind",
    "failed",
  );
  assertEquals(
    manageError(
      callManage(
        nonRetryable.server,
        nonRetryable.output,
        1,
        "opensac/manage/deliveries/retry",
        {
          operationId: nonRetryable.operationID,
        },
      ),
    ).code,
    "delivery_not_retryable",
  );
  const preserved = getDeliveryOperation(
    nonRetryable.sessionDir,
    nonRetryable.operationID,
  );
  assertEquals(preserved!.status, "failed");
  assertEquals(preserved!.failureCode, "unsupported_media_kind");

  const pending = deliveryManageFixture("", "");
  assertEquals(
    manageError(
      callManage(
        pending.server,
        pending.output,
        2,
        "opensac/manage/deliveries/retry",
        {
          operationId: pending.operationID,
        },
      ),
    ).code,
    "delivery_not_reopenable",
  );
  assertEquals(
    getDeliveryOperation(pending.sessionDir, pending.operationID)!.status,
    "pending",
  );

  assertEquals(
    manageError(
      callManage(
        nonRetryable.server,
        nonRetryable.output,
        3,
        "opensac/manage/deliveries/retry",
        {
          operationId: "missing-operation",
        },
      ),
    ).code,
    "delivery_not_found",
  );
});
