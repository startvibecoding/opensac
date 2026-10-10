import { assert, assertEquals } from "../compat/assert.ts";
import * as path from "../compat/path.ts";
import {
  defaultMCPConfig,
  fullMCPConfigTemplate,
  globalMCPPath,
  loadMCPConfig,
  type MCPConfig,
  type MCPServer,
  mcpServerEnabled,
  normalizeMCPConfig,
  projectDirName,
  projectMCPPath,
  saveMCPConfig,
} from "./mod.ts";
import { test } from "#testing";

test("MCP path helpers", () => {
  const prevWd = Deno.cwd();
  const tmp = Deno.makeTempDirSync({ prefix: "mcp-" });
  Deno.chdir(tmp);
  try {
    assertEquals(path.basename(globalMCPPath()), "mcp.json");
    assertEquals(projectMCPPath(), path.join(projectDirName, "mcp.json"));
  } finally {
    Deno.chdir(prevWd);
  }
});

test("save/load MCP config", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "mcp-" });
  const p = path.join(tmp, "mcp.json");
  const cfg: MCPConfig = {
    mcpServers: [{ name: "s1", type: "stdio", command: "/tmp/mcp" }],
  };
  saveMCPConfig(p, cfg);
  const got = loadMCPConfig(p);
  assertEquals(got.mcpServers!.length, 1);
  assertEquals(got.mcpServers![0].name, "s1");
  assertEquals(Deno.statSync(p).mode! & 0o777, 0o600);

  cfg.mcpServers![0].name = "updated";
  saveMCPConfig(p, cfg);
  assertEquals(loadMCPConfig(p).mcpServers![0].name, "updated");
});

test("normalize MCP config", () => {
  const cfg: MCPConfig = { mcpServers: [{ name: " a ", type: "" }] };
  normalizeMCPConfig(cfg);
  assertEquals(cfg.mcpServers![0].name, "a");
  assertEquals(cfg.mcpServers![0].type, "stdio");
});

test("full MCP config template", () => {
  const cfg = fullMCPConfigTemplate();
  assert(cfg.mcpServers && cfg.mcpServers.length >= 3);
  const types = new Set(cfg.mcpServers.map((s) => s.type));
  assert(types.has("stdio") && types.has("http") && types.has("sse"));
  assert(defaultMCPConfig().mcpServers!.length === 1);
});

test("load MCP config not found", () => {
  let threw = false;
  try {
    loadMCPConfig(
      path.join(Deno.makeTempDirSync({ prefix: "mcp-" }), "missing.json"),
    );
  } catch (err) {
    threw = true;
    assert(err instanceof Deno.errors.NotFound);
  }
  assert(threw);
});

test("MCP server enabled additive field", () => {
  const legacy: MCPServer = {
    name: "legacy",
    type: "stdio",
    command: "/bin/legacy",
  };
  assert(mcpServerEnabled(legacy));
  // Legacy entries must not grow an enabled key.
  const tmp = Deno.makeTempDirSync({ prefix: "mcp-" });
  const p = path.join(tmp, "mcp.json");
  saveMCPConfig(p, { mcpServers: [legacy] });
  assert(!Deno.readTextFileSync(p).includes('"enabled"'));

  assert(!mcpServerEnabled({ name: "off", enabled: false }));
  assert(mcpServerEnabled({ name: "on", enabled: true }));

  const cfg: MCPConfig = {
    mcpServers: [
      { name: "off", type: "stdio", command: "/bin/off", enabled: false },
      { name: "on", type: "stdio", command: "/bin/on" },
    ],
  };
  saveMCPConfig(p, cfg);
  const loaded = loadMCPConfig(p);
  assertEquals(loaded.mcpServers!.length, 2);
  const byName: Record<string, MCPServer> = {};
  for (const srv of loaded.mcpServers!) byName[srv.name] = srv;
  assertEquals(byName["off"].enabled, false);
  assertEquals(byName["on"].enabled, undefined);

  normalizeMCPConfig(loaded);
  assert(!mcpServerEnabled(byName["off"]) && mcpServerEnabled(byName["on"]));
});
