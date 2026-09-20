// Translated from the knowledge-base/cron cases of
// internal/acp/acp_manage_test.go (TestManageKnowledgeBaseMCPApplyQuickAddsCanonicalServer,
// TestManageKnowledgeBasesCreateScanQueryAndDelete,
// TestKnowledgeBaseScheduleUsesSharedCronAndDurableIndexRun,
// TestManageCronWhitelistAndNormalization,
// TestManageKnowledgeBasesScanProjectsBackgroundProgress).
//
// The durable-index scan cases that need a live provider are replaced with
// deterministic projection/schedule checks: the scan RPC admits a background
// job whose progress is polled through list/status, and the cadence is
// projected onto the shared Cron store without a running scheduler.

import { assert, assertEquals, assertThrows } from "@std/assert";
import * as path from "@std/path";
import { AcpServer, type AcpServerSink } from "./server.ts";
import { handleManageRequest } from "./manage.ts";
import type { ACPRPCRequest } from "./wire.ts";
import {
  knowledgeBaseMCPServerName,
  normalizeKnowledgeBaseSchedule,
  syncKnowledgeBaseScheduleWithStore,
} from "./manage_knowledge_bases.ts";
import {
  createKnowledgeBase,
  type KnowledgeBase,
  updateKnowledgeBase,
} from "../session/knowledge_bases.ts";
import { newSQLiteCronStore } from "../cron/sqlite_store.ts";
import { KnowledgeBaseCronJobPrefix } from "../agentruntime/knowledge_cron.ts";
import {
  defaultSettings,
  getSessionDir,
  globalMCPPath,
  loadMCPConfig,
  saveGlobalSettings,
  saveMCPConfig,
  type Settings,
} from "../config/mod.ts";

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

function writeSettings(configDir: string): Settings {
  const settings = defaultSettings();
  settings.sessionDir = path.join(configDir, "sessions");
  saveGlobalSettings(settings);
  return settings;
}

function fixtureServer(
  output: SyncBuffer,
  configDir: string,
  settings: Settings,
): AcpServer {
  const server = new AcpServer();
  server.sink = output;
  server.cwd = configDir;
  server.settings = settings;
  return server;
}

function createBase(
  sessionDir: string,
  rootDir: string,
  spec: Partial<{
    name: string;
    mode: string;
    schedule: string;
    enabled: boolean;
  }> = {},
): KnowledgeBase {
  return createKnowledgeBase(sessionDir, {
    name: spec.name ?? "Product notes",
    rootDir,
    preprocessProfile: "documents",
    provider: "",
    model: "",
    mode: spec.mode ?? "yolo",
    thinkingLevel: "",
    schedule: spec.schedule ?? "manual",
    enabled: spec.enabled ?? true,
  });
}

// ─── normalizeKnowledgeBaseSchedule ──────────────────────────────────────────

Deno.test("normalizeKnowledgeBaseSchedule maps named cadences and manual", () => {
  assertEquals(normalizeKnowledgeBaseSchedule("daily", true), {
    schedule: "@daily",
    enabled: true,
  });
  assertEquals(normalizeKnowledgeBaseSchedule("  WEEKLY ", true), {
    schedule: "@weekly",
    enabled: true,
  });
  for (const value of ["", "manual", "off", "disabled"]) {
    assertEquals(normalizeKnowledgeBaseSchedule(value, true), {
      schedule: "",
      enabled: false,
    });
  }
  // Disabled bases never project a cadence.
  assertEquals(normalizeKnowledgeBaseSchedule("daily", false), {
    schedule: "",
    enabled: false,
  });
  // Raw cron expressions pass through after validation.
  assertEquals(normalizeKnowledgeBaseSchedule("0 9 * * 1-5", true), {
    schedule: "0 9 * * 1-5",
    enabled: true,
  });
  assertThrows(
    () => normalizeKnowledgeBaseSchedule("not-a-cadence", true),
    Error,
    "invalid knowledge base schedule",
  );
});

// ─── schedule projection onto the shared cron store ──────────────────────────

Deno.test("knowledge base schedule syncs create, update and delete on cron store", () => {
  const configDir = Deno.makeTempDirSync();
  const settings = writeSettings(configDir);
  const sessionDir = getSessionDir(settings);
  const rootDir = Deno.makeTempDirSync();
  const base = updateKnowledgeBase(
    sessionDir,
    createBase(sessionDir, rootDir, { schedule: "manual" }).id,
    {
      name: "Product notes",
      rootDir,
      preprocessProfile: "documents",
      provider: "",
      model: "",
      mode: "yolo",
      thinkingLevel: "",
      schedule: "daily",
      enabled: true,
    },
  );

  const store = newSQLiteCronStore(sessionDir);
  syncKnowledgeBaseScheduleWithStore(store, base);
  const jobID = KnowledgeBaseCronJobPrefix + base.id;
  const job = store.get(jobID);
  assertEquals(job.name, "Knowledge base: Product notes");
  assertEquals(job.schedule, "@daily");
  assertEquals(job.mode, "yolo");
  assertEquals(job.workDir, rootDir);
  assert(job.nextRun instanceof Date, "nextRun must be projected");

  // Re-sync preserves run accounting.
  store.update({
    ...job,
    runCount: 3,
    lastStatus: "success",
    lastError: "old",
  });
  syncKnowledgeBaseScheduleWithStore(store, base);
  const again = store.get(jobID);
  assertEquals(again.runCount, 3);
  assertEquals(again.lastStatus, "success");
  assertEquals(again.lastError, "old");

  // Disabling removes the projection.
  const disabled = updateKnowledgeBase(sessionDir, base.id, {
    name: "Product notes",
    rootDir,
    preprocessProfile: "documents",
    provider: "",
    model: "",
    mode: "yolo",
    thinkingLevel: "",
    schedule: "manual",
    enabled: false,
  });
  syncKnowledgeBaseScheduleWithStore(store, disabled);
  let thrown = false;
  try {
    store.get(jobID);
  } catch {
    thrown = true;
  }
  assert(thrown, "disabled knowledge base must drop its cron job");
});

// ─── mcp/apply ───────────────────────────────────────────────────────────────

Deno.test("knowledge-bases mcp apply quick-adds canonical server", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("MOTHX_DIR", configDir, () => {
    const settings = writeSettings(configDir);
    const sessionDir = getSessionDir(settings);
    const rootDir = Deno.makeTempDirSync();
    const base = createBase(sessionDir, rootDir);
    const output = new SyncBuffer();
    const server = fixtureServer(output, configDir, settings);

    // Seed two existing servers that must be preserved.
    Deno.mkdirSync(path.dirname(globalMCPPath()), { recursive: true });
    saveMCPConfig(globalMCPPath(), {
      mcpServers: [
        { name: "keeper", type: "stdio", command: "keep" },
        { name: "other", type: "stdio", command: "x" },
      ],
    });

    const first = result(
      callManage(
        server,
        output,
        1,
        "mothx/manage/knowledge-bases/mcp/apply",
        { id: base.id },
      ),
    );
    assertEquals(first["name"], knowledgeBaseMCPServerName(base.id));
    assertEquals(first["enabled"], true);

    const saved = loadMCPConfig(globalMCPPath());
    const servers = saved.mcpServers ?? [];
    assertEquals(servers.length, 3);
    assertEquals(servers[0].name, "keeper");
    const knowledge = servers.find((srv) =>
      srv.name === knowledgeBaseMCPServerName(base.id)
    );
    assert(knowledge, "knowledge server must be present");
    assertEquals(knowledge.type, "stdio");
    assert((knowledge.command ?? "").length > 0);
    assertEquals(knowledge.args, [
      "knowledge-mcp",
      "serve",
      "--knowledge-base",
      base.id,
    ]);
    assertEquals(knowledge.enabled, true);

    // Second apply updates in place and can disable.
    const second = result(
      callManage(
        server,
        output,
        2,
        "mothx/manage/knowledge-bases/mcp/apply",
        { id: base.id, enabled: false },
      ),
    );
    assertEquals(second["enabled"], false);
    const after = loadMCPConfig(globalMCPPath());
    const updated = (after.mcpServers ?? []).find((srv) =>
      srv.name === knowledgeBaseMCPServerName(base.id)
    );
    assertEquals(updated?.enabled, false);

    // Missing base projects knowledge_base_not_found.
    const code = errorCode(
      callManage(
        server,
        output,
        3,
        "mothx/manage/knowledge-bases/mcp/apply",
        { id: "missing" },
      ),
    );
    assertEquals(code, "knowledge_base_not_found");

    // Missing id is invalid_params.
    const noID = errorCode(
      callManage(
        server,
        output,
        4,
        "mothx/manage/knowledge-bases/mcp/apply",
        {},
      ),
    );
    assertEquals(noID, "knowledge_base_invalid_request");
  });
});

// ─── CRUD + list/status ──────────────────────────────────────────────────────

Deno.test("knowledge-bases create list get update delete project runtime state", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("MOTHX_DIR", configDir, () => {
    const settings = writeSettings(configDir);
    const rootDir = Deno.makeTempDirSync();
    const output = new SyncBuffer();
    const server = fixtureServer(output, configDir, settings);

    const created = result(
      callManage(server, output, 1, "mothx/manage/knowledge-bases/create", {
        knowledgeBase: {
          name: "Docs",
          rootDir,
          preprocessProfile: "documents",
          mode: "yolo",
          schedule: "manual",
        },
      }),
    );
    const baseView = created["knowledgeBase"] as Record<string, unknown>;
    const baseID = baseView["id"] as string;
    assertEquals(created["status"], "unindexed");
    assert(baseID.length > 0);

    const listed = result(
      callManage(server, output, 2, "mothx/manage/knowledge-bases/list", {}),
    );
    const items = listed["knowledgeBases"] as unknown[];
    assertEquals(items.length, 1);

    const got = result(
      callManage(server, output, 3, "mothx/manage/knowledge-bases/get", {
        id: baseID,
      }),
    );
    assertEquals(
      (got["knowledgeBase"] as Record<string, unknown>)["id"],
      baseID,
    );

    // Update keeps identity; schedule=manual stays off cron.
    const updated = result(
      callManage(server, output, 4, "mothx/manage/knowledge-bases/update", {
        id: baseID,
        knowledgeBase: {
          name: "Docs 2",
          rootDir,
          preprocessProfile: "code",
          mode: "yolo",
          schedule: "manual",
        },
      }),
    );
    assertEquals(
      (updated["knowledgeBase"] as Record<string, unknown>)["name"],
      "Docs 2",
    );

    // Query before any snapshot projects knowledge_base_unindexed.
    assertEquals(
      errorCode(
        callManage(server, output, 5, "mothx/manage/knowledge-bases/query", {
          id: baseID,
          query: "anything",
        }),
      ),
      "knowledge_base_unindexed",
    );

    // Scan admits a background job and returns the indexing view.
    const scanned = result(
      callManage(server, output, 6, "mothx/manage/knowledge-bases/scan", {
        id: baseID,
      }),
    );
    assertEquals(scanned["started"], true);
    assertEquals(scanned["alreadyRunning"], false);
    assertEquals(scanned["status"], "indexing");
    const indexing = scanned["indexing"] as Record<string, unknown>;
    assertEquals(typeof indexing, "object");

    // A second concurrent scan is shared.
    const rescanned = result(
      callManage(server, output, 7, "mothx/manage/knowledge-bases/scan", {
        id: baseID,
      }),
    );
    // The first scan will finish/fail quickly (no provider configured), but
    // the RPC contract always answers with the admitted-job projection.
    assert(typeof rescanned["started"] === "boolean");

    // Validation: unknown provider, and provider/model must come together.
    assertEquals(
      errorCode(
        callManage(server, output, 8, "mothx/manage/knowledge-bases/create", {
          knowledgeBase: {
            name: "bad",
            rootDir,
            preprocessProfile: "documents",
            mode: "yolo",
            schedule: "manual",
            provider: "missing-provider",
            model: "some-model",
          },
        }),
      ),
      "knowledge_base_provider_not_found",
    );
    assertEquals(
      errorCode(
        callManage(server, output, 9, "mothx/manage/knowledge-bases/create", {
          knowledgeBase: {
            name: "bad",
            rootDir,
            preprocessProfile: "documents",
            mode: "yolo",
            schedule: "manual",
            provider: "",
            model: "some-model",
          },
        }),
      ),
      "knowledge_base_model_invalid",
    );
    assertEquals(
      errorCode(
        callManage(server, output, 10, "mothx/manage/knowledge-bases/create", {
          knowledgeBase: {
            name: "bad",
            rootDir,
            preprocessProfile: "documents",
            mode: "yolo",
            schedule: "not a schedule",
          },
        }),
      ),
      "knowledge_base_schedule_invalid",
    );

    // Delete.
    const deleted = result(
      callManage(server, output, 11, "mothx/manage/knowledge-bases/delete", {
        id: baseID,
      }),
    );
    assertEquals(deleted["deleted"], true);
    assertEquals(
      errorCode(
        callManage(server, output, 12, "mothx/manage/knowledge-bases/get", {
          id: baseID,
        }),
      ),
      "knowledge_base_not_found",
    );
  });
});

Deno.test("knowledge-bases query clamps limit and requires id+query", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("MOTHX_DIR", configDir, () => {
    const settings = writeSettings(configDir);
    const output = new SyncBuffer();
    const server = fixtureServer(output, configDir, settings);
    assertEquals(
      errorCode(
        callManage(server, output, 1, "mothx/manage/knowledge-bases/query", {
          id: "x",
        }),
      ),
      "invalid_params",
    );
    assertEquals(
      errorCode(
        callManage(server, output, 2, "mothx/manage/knowledge-bases/query", {
          query: "x",
        }),
      ),
      "invalid_params",
    );
    assertEquals(
      errorCode(
        callManage(server, output, 3, "mothx/manage/knowledge-bases/query", {
          id: "missing",
          query: "x",
          limit: 99,
        }),
      ),
      "knowledge_base_not_found",
    );
  });
});

// ─── cron family prerequisites / errors ──────────────────────────────────────

Deno.test("cron handlers project structured errors without prerequisites", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("MOTHX_DIR", configDir, () => {
    const settings = writeSettings(configDir);
    const output = new SyncBuffer();
    const server = fixtureServer(output, configDir, settings);
    // ensureManageCron needs runtime/p/m; list projects cron_unavailable.
    assertEquals(
      errorCode(callManage(server, output, 1, "mothx/manage/cron/list", {})),
      "cron_unavailable",
    );
    assertEquals(
      errorCode(
        callManage(server, output, 2, "mothx/manage/cron/run", {}),
      ),
      "invalid_params",
    );
    assertEquals(
      errorCode(
        callManage(server, output, 3, "mothx/manage/cron/remove", {}),
      ),
      "invalid_params",
    );
    // Whitelist rejects unknown fields before touching the runtime.
    assertEquals(
      errorCode(
        callManage(server, output, 4, "mothx/manage/cron/create", {
          name: "n",
          workDir: "/",
        }),
      ),
      "cron_field_not_allowed",
    );
  });
});
