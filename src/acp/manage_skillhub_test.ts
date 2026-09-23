// case of acp_manage_test.go. These exercise the `opensac/manage/skillhub/*`
// family ported into src/acp/manage_skillhub.ts against an in-memory ACP server
// fixture, mirroring the Go `newManageFixtureServer`.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import * as path from "@std/path";
import { AcpServer, type AcpServerSink, ACPSessionRuntime } from "./server.ts";
import { handleManageRequest, manageRedactSecrets } from "./manage.ts";
import { manageSkillHubDefaultMarket } from "./manage_skillhub.ts";
import type { ACPRPCRequest } from "./wire.ts";
import {
  defaultSettings,
  getGlobalSkillsDir,
  globalSettingsPath,
  saveGlobalSettings,
  type Settings,
} from "../config/mod.ts";
import { SessionRuntime } from "../agentruntime/session_runtime.ts";

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

function newManageFixtureServer(sink: SyncBuffer, cwd = ""): AcpServer {
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

function readManageRawFile(): Record<string, unknown> {
  return JSON.parse(Deno.readTextFileSync(globalSettingsPath())) as Record<
    string,
    unknown
  >;
}

function findSkillHubMarket(
  result: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  const markets = result["markets"] as Record<string, unknown>[];
  for (const market of markets) {
    if (market["id"] === id) return market;
  }
  throw new Error(`market ${id} missing from view: ${JSON.stringify(markets)}`);
}

// ─── SkillHub settings ────────────────────────────────────────────────────────

Deno.test("manage skillhub get is token-free", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const settings = defaultSettings();
    settings.skillHub!.markets = [
      {
        id: "skillhub.cn",
        name: "SkillHub CN",
        siteURL: "https://skillhub.cn",
        apiURL: "https://api.skillhub.cn",
        enabled: true,
        apiToken: "sh-secret-123456",
      },
      {
        id: "clawhub.ai",
        name: "ClawHub",
        siteURL: "https://clawhub.ai",
        enabled: false,
        apiToken: "",
      },
    ];
    saveGlobalSettings(settings);
    const output = new SyncBuffer();
    const srv = newManageFixtureServer(output, configDir);

    const result = manageResult(
      callManage(srv, output, 1, "opensac/manage/skillhub/get", {}),
    );
    assertEquals(result["defaultMarket"], "skillhub.cn");
    assertEquals(result["defaultInstallScope"], "project");
    const handles = result["officialHandles"] as unknown[];
    assert(handles.length > 0);
    const markets = result["markets"] as unknown[];
    assertEquals(markets.length, 2);
    const encoded = JSON.stringify(result);
    assert(!encoded.includes("sh-secret-123456"));
    assertStrictEquals(
      findSkillHubMarket(result, "skillhub.cn")["apiTokenConfigured"],
      true,
    );
    assertStrictEquals(
      findSkillHubMarket(result, "clawhub.ai")["apiTokenConfigured"],
      false,
    );
  });
});

Deno.test("manage skillhub patch round trip", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const settings = defaultSettings();
    settings.skillHub!.markets = [{
      id: "skillhub.cn",
      name: "SkillHub CN",
      siteURL: "https://skillhub.cn",
      apiURL: "https://api.skillhub.cn",
      enabled: true,
      apiToken: "sh-secret-123456",
    }];
    saveGlobalSettings(settings);
    const output = new SyncBuffer();
    const srv = newManageFixtureServer(output, configDir);

    const patch = {
      defaultMarket: "clawhub.ai",
      defaultInstallScope: "global",
      officialHandles: ["user_new"],
      markets: [
        {
          id: "skillhub.cn",
          name: "SkillHub CN Updated",
          siteURL: "https://skillhub.cn",
          apiURL: "https://api.skillhub.cn",
          enabled: true,
        },
        {
          id: "clawhub.ai",
          name: "ClawHub",
          siteURL: "https://clawhub.ai",
          apiURL: "https://api.clawhub.ai",
          enabled: true,
          apiToken: "claw-secret-789",
        },
      ],
    };
    const result = manageResult(
      callManage(srv, output, 1, "opensac/manage/skillhub/patch", { patch }),
    );
    assertEquals(result["defaultMarket"], "clawhub.ai");
    assertEquals(result["defaultInstallScope"], "global");
    const encoded = JSON.stringify(result);
    assert(!encoded.includes("sh-secret-123456"));
    assert(!encoded.includes("claw-secret-789"));

    const raw = readManageRawFile();
    const skillHub = raw["skillHub"] as Record<string, unknown>;
    const markets = skillHub["markets"] as Record<string, unknown>[];
    assertEquals(markets.length, 2);
    assertEquals(markets[0]["apiToken"], "sh-secret-123456");
    assertEquals(markets[1]["apiToken"], "claw-secret-789");
  });
});

Deno.test("manage skillhub patch clears token", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const settings = defaultSettings();
    settings.skillHub!.markets = [{
      id: "skillhub.cn",
      name: "SkillHub CN",
      enabled: true,
      apiToken: "sh-secret-123456",
    }];
    saveGlobalSettings(settings);
    const output = new SyncBuffer();
    const srv = newManageFixtureServer(output, configDir);

    const patch = {
      markets: [{
        id: "skillhub.cn",
        name: "SkillHub CN",
        enabled: true,
        clearApiToken: true,
      }],
    };
    manageResult(
      callManage(srv, output, 1, "opensac/manage/skillhub/patch", { patch }),
    );
    const raw = readManageRawFile();
    const skillHub = raw["skillHub"] as Record<string, unknown>;
    const markets = skillHub["markets"] as Record<string, unknown>[];
    assertEquals(markets.length, 1);
    assertEquals("apiToken" in markets[0], false);
  });
});

Deno.test("manage skillhub patch validation", () => {
  const cases: {
    name: string;
    patch: Record<string, unknown>;
    code: string;
    field?: string;
  }[] = [
    {
      name: "empty market id",
      patch: { markets: [{ id: "   ", name: "x" }] },
      code: "skillhub_field_invalid",
    },
    {
      name: "duplicate market id",
      patch: { markets: [{ id: "a", name: "A" }, { id: "a", name: "B" }] },
      code: "skillhub_field_invalid",
    },
    {
      name: "unknown top-level field",
      patch: { unknownField: "x" },
      code: "skillhub_field_not_allowed",
    },
    {
      name: "unknown market field",
      patch: { markets: [{ id: "a", unknown: "x" }] },
      code: "skillhub_market_field_not_allowed",
      field: "markets[0]",
    },
    {
      name: "invalid install scope",
      patch: { defaultInstallScope: "workspace" },
      code: "skillhub_field_invalid",
    },
    {
      name: "invalid token type",
      patch: { markets: [{ id: "a", apiToken: true }] },
      code: "skillhub_field_invalid",
    },
    {
      name: "conflicting token directives",
      patch: {
        markets: [{ id: "a", apiToken: "secret", clearApiToken: true }],
      },
      code: "skillhub_field_invalid",
    },
  ];
  for (const tc of cases) {
    const configDir = Deno.makeTempDirSync();
    withEnv("OPENSAC_DIR", configDir, () => {
      saveGlobalSettings(defaultSettings());
      const output = new SyncBuffer();
      const srv = newManageFixtureServer(output, configDir);
      const message = callManage(
        srv,
        output,
        1,
        "opensac/manage/skillhub/patch",
        {
          patch: tc.patch,
        },
      );
      const { code, data } = manageError(message);
      assertEquals(code, tc.code, `case ${tc.name}`);
      if (tc.field !== undefined) {
        assertEquals(data["field"], tc.field, `case ${tc.name}`);
      }
    });
  }
});

Deno.test("manage skillhub redaction masks market tokens", () => {
  const settings = {
    skillHub: {
      markets: [{ id: "skillhub.cn", apiToken: "sh-secret-abcdef" }],
    },
  } as unknown as Settings;
  const message = manageRedactSecrets(
    "upstream rejected sh-secret-abcdef after 1s",
    settings,
  );
  assert(!message.includes("sh-secret-abcdef"));
  assert(message.includes("***"));
});

Deno.test("manage skillhub preserves unknown fields", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const settingsPath = globalSettingsPath();
    Deno.writeTextFileSync(
      settingsPath,
      JSON.stringify({
        skillHub: {
          defaultMarket: "skillhub.cn",
          customSibling: "kept",
          markets: [{
            id: "skillhub.cn",
            name: "SkillHub CN",
            enabled: true,
            apiToken: "sh-secret-123",
            customField: "preserved",
          }],
        },
      }),
    );
    const output = new SyncBuffer();
    const srv = newManageFixtureServer(output, configDir);
    const patch = {
      markets: [{
        id: "skillhub.cn",
        name: "SkillHub CN Updated",
        enabled: true,
      }],
    };
    manageResult(
      callManage(srv, output, 1, "opensac/manage/skillhub/patch", { patch }),
    );

    const raw = readManageRawFile();
    const skillHub = raw["skillHub"] as Record<string, unknown>;
    assertEquals(skillHub["customSibling"], "kept");
    const markets = skillHub["markets"] as Record<string, unknown>[];
    assertEquals(markets.length, 1);
    assertEquals(markets[0]["customField"], "preserved");
    assertEquals(markets[0]["apiToken"], "sh-secret-123");
  });
});

Deno.test("manage skillhub default market falls back to product default", () => {
  assertEquals(manageSkillHubDefaultMarket(null), "skillhub.cn");
  const blank = defaultSettings();
  blank.skillHub!.defaultMarket = "  ";
  assertEquals(manageSkillHubDefaultMarket(blank), "skillhub.cn");
  const custom = defaultSettings();
  custom.skillHub!.defaultMarket = "clawhub.ai";
  assertEquals(manageSkillHubDefaultMarket(custom), "clawhub.ai");
});

// ─── SkillHub catalog ─────────────────────────────────────────────────────────

Deno.test("manage skillhub catalog projects runtime-owned targets", () => {
  const configDir = Deno.makeTempDirSync();
  const workDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const settings = defaultSettings();
    settings.skillHub!.defaultMarket = "skillhub.cn";
    settings.skillHub!.defaultInstallScope = "project";
    saveGlobalSettings(settings);
    const output = new SyncBuffer();
    const srv = newManageFixtureServer(output, workDir);
    const rt = new ACPSessionRuntime();
    rt.id = "catalog-session";
    rt.runtime = new SessionRuntime({ workDir });
    srv.sessions.set(rt.id, rt);

    const targets = manageResult(
      callManage(srv, output, 1, "opensac/manage/skillhub/targets", {
        sessionId: rt.id,
      }),
    );
    const items = targets["targets"] as Record<string, unknown>[];
    assert(Array.isArray(items) && items.length > 0);
    const firstPath = items[0]["path"] as string;
    assert(path.isAbsolute(firstPath));
    assert(firstPath.startsWith(workDir + path.SEPARATOR));

    const markets = manageResult(
      callManage(srv, output, 2, "opensac/manage/skillhub/markets", {
        sessionId: rt.id,
      }),
    );
    const marketList = markets["markets"] as unknown[];
    assert(Array.isArray(marketList) && marketList.length > 0);
    assertEquals(markets["defaultMarket"], "skillhub.cn");

    const message = callManage(
      srv,
      output,
      3,
      "opensac/manage/skillhub/targets",
      {},
    );
    assertEquals(manageError(message).code, "skillhub_invalid_request");

    const installMessage = callManage(
      srv,
      output,
      4,
      "opensac/manage/skillhub/install",
      {
        sessionId: rt.id,
        market: "skillhub.cn",
        id: "demo",
        scope: "project",
        targetDir: "relative",
      },
    );
    assertEquals(manageError(installMessage).code, "skillhub_invalid_request");

    assertEquals(getGlobalSkillsDir(defaultSettings()) !== "", true);
  });
});
