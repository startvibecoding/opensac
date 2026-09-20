// Translated from internal/acp/manage_serve_test.go: the secret-free serve
// config GET, the patch round-trip that keeps secrets, unsafe/invalid field
// rejection, and the api.session projection/validation table.

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import { AcpServer, type AcpServerSink } from "./server.ts";
import { handleManageRequest } from "./manage.ts";
import type { ACPRPCRequest } from "./wire.ts";
import { configPath } from "../serve/config.ts";

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

function rpc(
  id: number,
  method: string,
  params?: unknown,
): ACPRPCRequest {
  return { jsonrpc: "2.0", idRaw: JSON.stringify(id), method, params };
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

function result(message: Record<string, unknown>): Record<string, unknown> {
  if (message["error"] !== null && message["error"] !== undefined) {
    throw new Error(
      `unexpected RPC error: ${JSON.stringify(message["error"])}`,
    );
  }
  return message["result"] as Record<string, unknown>;
}

function errorCode(message: Record<string, unknown>): string {
  const errObj = message["error"] as Record<string, unknown> | undefined;
  assert(
    errObj !== undefined,
    `want an RPC error, got ${JSON.stringify(message)}`,
  );
  const data = (errObj["data"] as Record<string, unknown> | undefined) ?? {};
  return (data["code"] as string) ?? "";
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

function writeServeConfig(configDir: string, data: string): void {
  Deno.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  Deno.writeTextFileSync(path.join(configDir, "serve.json"), data, {
    mode: 0o600,
  });
}

function readServeConfig(): Record<string, unknown> {
  return JSON.parse(Deno.readTextFileSync(configPath())) as Record<
    string,
    unknown
  >;
}

Deno.test("manage serve config get is secret free", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("MOTHX_DIR", configDir, () => {
    writeServeConfig(
      configDir,
      JSON.stringify({
        api: {
          listen: "0.0.0.0:7872",
          auth: { enabled: true, tokens: ["sk-secret-token"] },
          cors: {
            enabled: true,
            allowOrigins: ["https://example.com"],
          },
        },
        channels: {
          wechat: { enabled: true, cred_path: "/secret/cred.json" },
          feishu: { enabled: false, app_id: "id", app_secret: "secret" },
        },
        features: {
          webUI: true,
          openAIAPI: true,
          cron: true,
          memory: true,
        },
      }),
    );
    const output = new SyncBuffer();
    const server = new AcpServer();
    server.sink = output;
    const view = result(
      callManage(server, output, 1, "mothx/manage/serve/get", {}),
    );
    const api = view["api"] as Record<string, unknown>;
    assertEquals(api["listen"], "0.0.0.0:7872");
    assert(!Object.hasOwn(api, "auth"), "auth must not be projected");
    assert(!Object.hasOwn(api, "cors"), "cors must not be projected");
    assert(!Object.hasOwn(view, "channels"), "channels must not be projected");
    const features = view["features"] as Record<string, unknown>;
    assertEquals(features["webUI"], true);
    assertEquals(features["openAIAPI"], true);
    assertEquals(features["cron"], true);
    assertEquals(features["memory"], true);
    for (
      const secret of [
        "sk-secret-token",
        "/secret/cred.json",
        "allowOrigins",
        "https://example.com",
      ]
    ) {
      assert(
        !JSON.stringify(view).includes(secret),
        `view leaks ${secret}`,
      );
    }
  });
});

Deno.test("manage serve config patch round trip keeps secrets", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("MOTHX_DIR", configDir, () => {
    writeServeConfig(
      configDir,
      JSON.stringify({
        api: {
          listen: "127.0.0.1:7872",
          auth: { enabled: true, tokens: ["sk-keep-me"] },
        },
        features: {
          webUI: true,
          openAIAPI: true,
          cron: true,
          memory: true,
        },
      }),
    );
    const output = new SyncBuffer();
    const server = new AcpServer();
    server.sink = output;
    const view = result(
      callManage(server, output, 1, "mothx/manage/serve/patch", {
        patch: {
          api: {
            listen: "127.0.0.1:7873",
            defaultMode: "agent",
            defaultThinkingLevel: "high",
            enableSubAgents: true,
            enableDelegate: true,
            enableWorkflows: true,
            enableWebSearch: true,
            enableBrowser: true,
            enableArtifact: true,
            enableA2AMaster: true,
            toolVisibility: { mode: "sse_event", detail: "expanded" },
            systemPromptMode: "ignore",
            requestTimeoutSeconds: 3600,
            maxConcurrentRequests: 16,
            logLevel: "debug",
          },
          features: {
            webUI: false,
            openAIAPI: false,
            multiAgent: true,
            cron: false,
            memory: true,
          },
          webUI: { enabled: false, dir: "ui/dist-new" },
          cron: { enabled: false, interval: 60 },
          memory: { enabled: true, path: "/tmp/memory.md" },
          security: { smartApprovals: false },
          agent: {
            maxTurns: 50,
            budgetPressure: false,
            contextPressure: false,
            budgetPressureThreshold: 0.3,
            contextPressureThreshold: 0.6,
            runStaleTimeoutSeconds: 300,
            runMaxDurationSeconds: 7200,
            backgroundRunMaxSecs: 18000,
          },
          lobsterMode: true,
        },
      }),
    );
    const api = view["api"] as Record<string, unknown>;
    assertEquals(api["listen"], "127.0.0.1:7873");
    assertEquals((view["features"] as Record<string, unknown>)["webUI"], false);
    assertEquals(
      (view["webUI"] as Record<string, unknown>)["enabled"],
      false,
    );
    assertEquals(
      (view["features"] as Record<string, unknown>)["multiAgent"],
      true,
    );
    assertEquals(api["enableSubAgents"], true);
    assertEquals(api["enableArtifact"], true);
    assertEquals((view["cron"] as Record<string, unknown>)["interval"], 60);

    const onDisk = readServeConfig();
    assertEquals(onDisk["listen"], "127.0.0.1:7873");
    assertEquals(onDisk["artifact"], true);
    const auth = onDisk["auth"] as Record<string, unknown>;
    assertEquals(auth["tokens"], ["sk-keep-me"]);

    output.reset();
    const again = result(
      callManage(server, output, 2, "mothx/manage/serve/get", {}),
    );
    assertEquals(
      (again["api"] as Record<string, unknown>)["listen"],
      "127.0.0.1:7873",
    );
  });
});

Deno.test("manage serve config patch rejects unsafe and invalid fields", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("MOTHX_DIR", configDir, () => {
    writeServeConfig(configDir, `{"api":{"listen":"127.0.0.1:7872"}}`);
    const cases: Array<{ name: string; patch: unknown; want: string }> = [
      {
        name: "api.auth.tokens",
        patch: { api: { auth: { tokens: ["x"] } } },
        want: "serve_field_not_allowed",
      },
      {
        name: "api.cors.allowOrigins",
        patch: { api: { cors: { allowOrigins: ["*"] } } },
        want: "serve_field_not_allowed",
      },
      {
        name: "channels.wechat.credPath",
        patch: { channels: { wechat: { credPath: "x" } } },
        want: "serve_field_not_allowed",
      },
      {
        name: "unknown top-level",
        patch: { unknown: true },
        want: "serve_field_not_allowed",
      },
      {
        name: "null nested section",
        patch: { api: null },
        want: "serve_field_invalid",
      },
      {
        name: "empty nested section",
        patch: { features: {} },
        want: "serve_field_invalid",
      },
      {
        name: "features.wechat",
        patch: { features: { wechat: true } },
        want: "serve_field_not_allowed",
      },
      {
        name: "invalid defaultMode",
        patch: { api: { defaultMode: "turbo" } },
        want: "serve_field_invalid",
      },
      {
        name: "invalid thinkingLevel",
        patch: { api: { defaultThinkingLevel: "mega" } },
        want: "serve_field_invalid",
      },
      {
        name: "invalid toolVisibility.mode",
        patch: { api: { toolVisibility: { mode: "unknown" } } },
        want: "serve_field_invalid",
      },
      {
        name: "invalid logLevel",
        patch: { api: { logLevel: "verbose" } },
        want: "serve_field_invalid",
      },
      {
        name: "negative maxConcurrentRequests",
        patch: { api: { maxConcurrentRequests: -1 } },
        want: "serve_field_invalid",
      },
      {
        name: "threshold out of range",
        patch: { agent: { budgetPressureThreshold: 1.5 } },
        want: "serve_field_invalid",
      },
      {
        name: "zero maxTurns",
        patch: { agent: { maxTurns: 0 } },
        want: "serve_field_invalid",
      },
      {
        name: "missing patch envelope",
        patch: undefined,
        want: "invalid_params",
      },
    ];
    for (const tc of cases) {
      const output = new SyncBuffer();
      const server = new AcpServer();
      server.sink = output;
      const code = errorCode(
        callManage(server, output, 1, "mothx/manage/serve/patch", {
          patch: tc.patch,
        }),
      );
      assertEquals(code, tc.want, tc.name);
      const raw = JSON.stringify(readServeConfig());
      assert(!raw.includes("7873"), `${tc.name} modified serve.json`);
    }
  });
});

Deno.test("manage serve api.session projection and validation", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("MOTHX_DIR", configDir, () => {
    writeServeConfig(
      configDir,
      JSON.stringify({
        api: {
          listen: "127.0.0.1:7872",
          session: { idleTimeoutSeconds: 600, maxSessions: 5 },
        },
      }),
    );
    const output = new SyncBuffer();
    const server = new AcpServer();
    server.sink = output;
    const view = result(
      callManage(server, output, 1, "mothx/manage/serve/get", {}),
    );
    const session =
      (view["api"] as Record<string, unknown>)["session"] as Record<
        string,
        unknown
      >;
    assertEquals(session["idleTimeoutSeconds"], 600);
    assertEquals(session["maxSessions"], 5);

    const patched = result(
      callManage(server, output, 2, "mothx/manage/serve/patch", {
        patch: {
          api: {
            session: { idleTimeoutSeconds: 1200, maxSessions: 0 },
          },
        },
      }),
    );
    const patchedSession =
      ((patched["api"] as Record<string, unknown>)["session"]) as Record<
        string,
        unknown
      >;
    assertEquals(patchedSession["idleTimeoutSeconds"], 1200);
    assertEquals(patchedSession["maxSessions"], 0);

    const onDisk = readServeConfig()["session"] as Record<
      string,
      unknown
    >;
    assertEquals(onDisk["idleTimeoutSeconds"], 1200);
    assertEquals(onDisk["maxSessions"], 0);

    const invalidCases: Array<{ name: string; patch: unknown }> = [
      {
        name: "null session section",
        patch: { api: { session: null } },
      },
      {
        name: "empty session object",
        patch: { api: { session: {} } },
      },
      {
        name: "unknown session field",
        patch: { api: { session: { idleTimeoutSeconds: 1, unknown: 1 } } },
      },
      {
        name: "idleTimeoutSeconds zero",
        patch: {
          api: { session: { idleTimeoutSeconds: 0 } },
        },
      },
      {
        name: "idleTimeoutSeconds negative",
        patch: {
          api: { session: { idleTimeoutSeconds: -1 } },
        },
      },
      {
        name: "maxSessions negative",
        patch: {
          api: { session: { maxSessions: -1 } },
        },
      },
      {
        name: "idleTimeoutSeconds float",
        patch: {
          api: { session: { idleTimeoutSeconds: 1.5 } },
        },
      },
      {
        name: "idleTimeoutSeconds string",
        patch: {
          api: { session: { idleTimeoutSeconds: "fast" } },
        },
      },
      {
        name: "maxSessions null",
        patch: {
          api: { session: { maxSessions: null } },
        },
      },
    ];
    const expectedCodes = [
      "serve_field_invalid",
      "serve_field_invalid",
      "serve_field_not_allowed",
      "serve_field_invalid",
      "serve_field_invalid",
      "serve_field_invalid",
      "serve_field_invalid",
      "serve_field_invalid",
      "serve_field_invalid",
    ];
    for (let i = 0; i < invalidCases.length; i++) {
      const tc = invalidCases[i];
      const code = errorCode(
        callManage(server, output, i + 3, "mothx/manage/serve/patch", {
          patch: tc.patch,
        }),
      );
      assertEquals(code, expectedCodes[i], tc.name);
      const raw = readServeConfig()["session"] as Record<
        string,
        unknown
      >;
      assertEquals(raw["idleTimeoutSeconds"], 1200, tc.name);
      assertEquals(raw["maxSessions"], 0, tc.name);
    }
  });
});

Deno.test("manage channels get is credential safe and patch projects", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("MOTHX_DIR", configDir, () => {
    writeServeConfig(
      configDir,
      JSON.stringify({
        channels: {
          artifact: false,
          wechat: {
            enabled: true,
            cred_path: "/secret/cred.json",
            work_dir: "/tmp/wx",
            auto_typing: true,
          },
          feishu: { enabled: true, app_id: "app", app_secret: "shh" },
        },
      }),
    );
    const output = new SyncBuffer();
    const server = new AcpServer();
    server.sink = output;
    const view = result(
      callManage(server, output, 1, "mothx/manage/channels/get", {}),
    );
    const wechat = view["wechat"] as Record<string, unknown>;
    assertEquals(wechat["enabled"], true);
    assertEquals(wechat["workDir"], "/tmp/wx");
    assertEquals(wechat["credentialConfigured"], true);
    assert(!JSON.stringify(view).includes("/secret/cred.json"));
    const feishu = view["feishu"] as Record<string, unknown>;
    assertEquals(feishu["appIDConfigured"], true);
    assertEquals(feishu["appSecretConfigured"], true);
    assert(!JSON.stringify(view).includes("shh"));

    const patched = result(
      callManage(server, output, 2, "mothx/manage/channels/patch", {
        patch: {
          artifact: true,
          wechat: { enabled: false, clearCredPath: true, autoTyping: false },
          feishu: {
            enabled: false,
            appId: "new-app",
            appSecret: "new-secret",
          },
        },
      }),
    );
    assertEquals(patched["artifact"], true);
    const patchedWechat = patched["wechat"] as Record<string, unknown>;
    assertEquals(patchedWechat["enabled"], false);
    assertEquals(patchedWechat["credentialConfigured"], false);
    assertEquals(patchedWechat["autoTyping"], false);
    const patchedFeishu = patched["feishu"] as Record<string, unknown>;
    assertEquals(patchedFeishu["appIDConfigured"], true);
    assert(!JSON.stringify(patched).includes("new-secret"));

    // Rejected patch: both credPath and clearCredPath.
    assertEquals(
      errorCode(
        callManage(server, output, 3, "mothx/manage/channels/patch", {
          patch: {
            wechat: { credPath: "/x", clearCredPath: true },
          },
        }),
      ),
      "serve_field_invalid",
    );
    // Top-level section whitelist.
    assertEquals(
      errorCode(
        callManage(server, output, 4, "mothx/manage/channels/patch", {
          patch: { hooks: {} },
        }),
      ),
      "serve_field_not_allowed",
    );
  });
});
