import * as path from "@opensac/path";
import {
  asJsonRecord,
  optBoolean,
  optString,
  optStringArray,
} from "../util/json.ts";
import { configDir } from "./settings.ts";
import { projectPath } from "./paths.ts";

/** A name/value pair used by MCP headers and env entries. */
export interface MCPKeyValue {
  name: string;
  value: string;
}

/** Defines one MCP server entry in mcp.json. */
export interface MCPServer {
  name: string;
  type?: string;
  command?: string;
  url?: string;
  messageUrl?: string;
  args?: string[];
  // Additive management toggle. undefined keeps every pre-existing mcp.json
  // entry enabled so older files and writers behave unchanged.
  enabled?: boolean;
  headers?: MCPKeyValue[];
  env?: MCPKeyValue[];
}

/** The standalone MCP configuration file schema. */
export interface MCPConfig {
  mcpServers?: MCPServer[];
}

/** Returns the global mcp.json path. */
export function globalMCPPath(): string {
  return path.join(configDir(), "mcp.json");
}

/** Returns the project-local mcp.json path. */
export function projectMCPPath(): string {
  return projectPath("mcp.json");
}

function serverToJSON(srv: MCPServer): Record<string, unknown> {
  const o: Record<string, unknown> = { name: srv.name };
  if (srv.type) o.type = srv.type;
  if (srv.command) o.command = srv.command;
  if (srv.url) o.url = srv.url;
  if (srv.messageUrl) o.messageUrl = srv.messageUrl;
  if (srv.args && srv.args.length) o.args = srv.args;
  if (srv.enabled !== undefined) o.enabled = srv.enabled;
  if (srv.headers && srv.headers.length) o.headers = srv.headers;
  if (srv.env && srv.env.length) o.env = srv.env;
  return o;
}

function configToJSON(cfg: MCPConfig): Record<string, unknown> {
  const servers = cfg.mcpServers ?? [];
  const o: Record<string, unknown> = {};
  if (servers.length) o.mcpServers = servers.map(serverToJSON);
  return o;
}

function keyValuesFromJSON(value: unknown): MCPKeyValue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: MCPKeyValue[] = [];
  for (const rec of value) {
    const name = optString(rec, "name");
    const val = optString(rec, "value");
    if (name === undefined || val === undefined) continue;
    out.push({ name, value: val });
  }
  return out;
}

function serverFromJSON(value: unknown): MCPServer | undefined {
  const rec = asJsonRecord(value);
  if (rec === undefined) return undefined;
  const name = optString(rec, "name");
  if (name === undefined) return undefined;
  const srv: MCPServer = { name };
  const type = optString(rec, "type");
  if (type !== undefined) srv.type = type;
  const command = optString(rec, "command");
  if (command !== undefined) srv.command = command;
  const url = optString(rec, "url");
  if (url !== undefined) srv.url = url;
  const messageUrl = optString(rec, "messageUrl");
  if (messageUrl !== undefined) srv.messageUrl = messageUrl;
  const args = optStringArray(rec, "args");
  if (args !== undefined) srv.args = args;
  const enabled = optBoolean(rec, "enabled");
  if (enabled !== undefined) srv.enabled = enabled;
  const headers = keyValuesFromJSON(rec["headers"]);
  if (headers !== undefined) srv.headers = headers;
  const env = keyValuesFromJSON(rec["env"]);
  if (env !== undefined) srv.env = env;
  return srv;
}

/** Decodes an mcp.json document into the config schema, skipping bad entries. */
export function mcpConfigFromJSON(value: unknown): MCPConfig {
  const rec = asJsonRecord(value);
  if (rec === undefined) return {};
  const rawServers = rec["mcpServers"];
  if (!Array.isArray(rawServers)) return {};
  const mcpServers: MCPServer[] = [];
  for (const entry of rawServers) {
    const srv = serverFromJSON(entry);
    if (srv !== undefined) mcpServers.push(srv);
  }
  return { mcpServers };
}

/** Reads and parses mcp.json from `p`. */
export function loadMCPConfig(p: string): MCPConfig {
  const data = Deno.readTextFileSync(p);
  try {
    return mcpConfigFromJSON(JSON.parse(data));
  } catch (err) {
    throw new Error(`parse MCP config: ${(err as Error).message}`);
  }
}

/** Writes mcp.json to `p` atomically with private permissions. */
export function saveMCPConfig(p: string, cfg: MCPConfig | undefined): void {
  const effective = cfg ?? {};
  const dir = path.dirname(p);
  Deno.mkdirSync(dir, { recursive: true });
  const data = JSON.stringify(configToJSON(effective), null, 2) + "\n";

  const tmpPath = Deno.makeTempFileSync({
    dir,
    prefix: ".mcp-",
    suffix: ".tmp",
  });
  try {
    Deno.writeTextFileSync(tmpPath, data);
    Deno.chmodSync(tmpPath, 0o600);
    Deno.renameSync(tmpPath, p);
  } catch (err) {
    try {
      Deno.removeSync(tmpPath);
    } catch {
      // already gone
    }
    throw err;
  }
}

/** Returns a starter mcp.json template. */
export function defaultMCPConfig(): MCPConfig {
  return {
    mcpServers: [
      {
        name: "example-stdio",
        type: "stdio",
        command: "/absolute/path/to/mcp-server",
      },
    ],
  };
}

/** Returns a comprehensive multi-transport template. */
export function fullMCPConfigTemplate(): MCPConfig {
  return {
    mcpServers: [
      {
        name: "local-stdio",
        type: "stdio",
        command: "/absolute/path/to/mcp-server",
        args: ["--port", "8080"],
        env: [{ name: "API_KEY", value: "replace-me" }],
      },
      {
        name: "remote-http",
        type: "http",
        url: "https://mcp.example.com",
        headers: [{ name: "Authorization", value: "Bearer replace-me" }],
      },
      {
        name: "legacy-sse",
        type: "sse",
        url: "https://legacy.example.com/sse",
        messageUrl: "https://legacy.example.com/messages",
        headers: [{ name: "Authorization", value: "Bearer replace-me" }],
      },
    ],
  };
}

/**
 * Reports whether a configured server entry is enabled. An undefined `enabled`
 * value means enabled, preserving backwards compatibility with mcp.json files
 * written before the management toggle existed.
 */
export function mcpServerEnabled(srv: MCPServer): boolean {
  return srv.enabled === undefined || srv.enabled;
}

/** Applies basic defaults. */
export function normalizeMCPConfig(cfg: MCPConfig | undefined): void {
  if (!cfg) return;
  for (const srv of cfg.mcpServers ?? []) {
    srv.name = srv.name.trim();
    srv.type = (srv.type ?? "").trim();
    if (srv.type === "") srv.type = "stdio";
  }
}
