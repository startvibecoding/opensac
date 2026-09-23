//
// Loads usable MCP servers from global and project mcp.json. Missing config
// files are ignored. Obvious template placeholders are skipped so creating a
// starter config does not break normal startup.

import {
  globalMCPPath,
  loadMCPConfig,
  type MCPServer,
  mcpServerEnabled,
  normalizeMCPConfig,
} from "../config/mcp.ts";
import { projectPathFor } from "../config/paths.ts";

/** Loads usable MCP servers from global and project mcp.json. */
export function loadConfiguredServers(cwd: string): MCPServer[] {
  const paths = [globalMCPPath(), projectPathFor(cwd, "mcp.json")];
  const servers: MCPServer[] = [];
  for (const p of paths) {
    let cfg;
    try {
      cfg = loadMCPConfig(p);
    } catch (err) {
      if ((err as Error).name === "NotFound") continue;
      throw new Error(`load MCP config ${p}: ${(err as Error).message}`);
    }
    normalizeMCPConfig(cfg);
    for (const srv of cfg.mcpServers ?? []) {
      if (!mcpServerEnabled(srv) || isTemplateServer(srv)) continue;
      servers.push(srv);
    }
  }
  return servers;
}

/** Reports whether a configured server entry is an untouched template. */
export function isTemplateServer(srv: MCPServer): boolean {
  if ((srv.name ?? "").trim() === "") return true;
  if ((srv.command ?? "").includes("/absolute/path/to/mcp-server")) return true;
  if (
    (srv.url ?? "").includes("example.com") ||
    (srv.messageUrl ?? "").includes("example.com")
  ) {
    return true;
  }
  for (const header of srv.headers ?? []) {
    const value = (header.value ?? "").trim();
    if (value === "replace-me" || value.includes("Bearer replace-me")) {
      return true;
    }
  }
  for (const env of srv.env ?? []) {
    if ((env.value ?? "").trim() === "replace-me") return true;
  }
  return false;
}
