//
// `BuildRegistry` is the only registry-construction API for non-test adapters:
// it creates the base registry and applies explicit adapter tool policy while
// the Runtime owns sandbox, workdir, and lifecycle. `MCPPolicy` describes
// adapter-specific MCP transport behavior while the Runtime owns client
// connection and release (the `connectMCP` methods live on SessionRuntime).

import { registerTool as registerBrowserTool } from "../browser/mod.ts";
import { type MCPServer, mcpServerEnabled } from "../config/mcp.ts";
import { isPlanToolEnabled, type Settings } from "../config/settings.ts";
import { type Callbacks, type Client, closeClients } from "../mcp/mcp.ts";
import type { Manager as SandboxManager } from "../sandbox/sandbox.ts";
import type { Manager as SkillsManager } from "../skills/mod.ts";
import { createRegistry, type Registry } from "../tools/tool.ts";
import { SkillRefTool } from "../tools/skill_ref.ts";

/** An adapter policy callback for tools not yet expressible as capabilities. */
export type RegistryMutator = (registry: Registry) => void;

/** Controls shared registry construction without letting adapters own it. */
export interface RegistryPolicy {
  registerDefaults: boolean;
  enablePlanTool?: boolean;
  skillsMgr?: SkillsManager;
  browser: boolean;
  mutators?: RegistryMutator[];
}

/**
 * Creates the base registry and applies explicit adapter tool policy. It is the
 * only registry construction API for non-test adapters.
 */
export function buildRegistry(
  workDir: string,
  sandboxMgr: SandboxManager | null | undefined,
  _settings: Settings | null | undefined,
  policy: RegistryPolicy,
): Registry {
  if ((workDir ?? "").trim() === "") {
    throw new Error("registry work directory is required");
  }
  const active =
    sandboxMgr === null || sandboxMgr === undefined
      ? undefined
      : sandboxMgr.getActive();
  const registry = createRegistry(workDir, active);
  if (policy.registerDefaults) {
    if (policy.enablePlanTool === undefined) {
      registry.registerDefaults();
    } else {
      registry.registerDefaultsWithPlanTool(policy.enablePlanTool);
    }
  }
  if (policy.skillsMgr !== null && policy.skillsMgr !== undefined) {
    registry.register(new SkillRefTool(policy.skillsMgr));
  }
  if (policy.browser) {
    registerBrowserTool(registry);
  }
  for (const mutate of policy.mutators ?? []) {
    if (mutate === null || mutate === undefined) continue;
    mutate(registry);
  }
  return registry;
}

/** Describes adapter-specific MCP transport behavior. */
export interface MCPPolicy {
  servers: MCPServer[];
  callbacks?: Callbacks;
  optional: boolean;
  onError?: (err: unknown) => void;
}

/** Returns the configured plan-tool setting, or undefined when unset. */
export function defaultPlanToolPolicy(
  settings: Settings | null | undefined,
): boolean | undefined {
  if (settings === null || settings === undefined) {
    return undefined;
  }
  return isPlanToolEnabled(settings);
}

/** Releases clients held by legacy adapter aliases during migration. */
export function closeMCPClients(clients: Client[]): void {
  closeClients(clients);
}

/** Reports whether a configured MCP server is enabled (re-export shim). */
export function isMCPServerEnabled(server: MCPServer): boolean {
  return mcpServerEnabled(server);
}
