// Ported from internal/a2a/config.go.
import * as path from "@std/path";
import { configDir, projectPath } from "../config/mod.ts";

/** AgentCardCfg holds customizable Agent Card fields. */
export interface AgentCardCfg {
  name?: string;
  description?: string;
  version?: string;
}

/** Config holds A2A server configuration. */
export interface Config {
  enabled: boolean;
  port: number;
  host: string;
  auth_token?: string;
  work_dir?: string;
  agent_card?: AgentCardCfg;
}

/** DefaultConfig returns default A2A configuration. */
export function defaultConfig(): Config {
  return {
    enabled: false,
    port: 8093,
    host: "127.0.0.1",
  };
}

/** ConfigPath returns the path to the global a2a.json. */
export function configPath(): string {
  return path.join(configDir(), "a2a.json");
}

/** ProjectConfigPath returns the path to the project-level .mothx/a2a.json. */
export function projectConfigPath(): string {
  return projectPath("a2a.json");
}

/** GetListenAddr returns the listen address. */
export function getListenAddr(c: Config): string {
  return `${c.host}:${c.port}`;
}

/** GetWorkDir returns the resolved working directory. */
export function getWorkDir(c: Config): string {
  if (c.work_dir !== undefined && c.work_dir !== "" && c.work_dir !== ".") {
    return c.work_dir;
  }
  try {
    return Deno.cwd();
  } catch {
    return ".";
  }
}

/** SaveConfig writes the config to a JSON file. */
export async function saveConfig(p: string, cfg: Config): Promise<void> {
  let dir: string;
  try {
    dir = path.dirname(p);
  } catch {
    dir = ".";
  }
  try {
    await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new Error(`create config directory: ${(err as Error).message}`);
  }
  const data = JSON.stringify(cfg, null, 2);
  await Deno.writeTextFile(p, data, { mode: 0o600 });
}

// InitA2AConfig creates the a2a.json template at the default location.
// Returns the file path. If force is false and the file already exists, throws.
export async function initA2AConfig(force: boolean): Promise<string> {
  const p = configPath();
  if (!force) {
    try {
      await Deno.stat(p);
      throw new Error(`a2a.json already exists: ${p}`);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  const cfg = defaultConfig();
  cfg.auth_token = "change-me-to-a-random-secret";
  let home = "";
  try {
    home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
  } catch {
    home = "";
  }
  if (home === "") home = "/home/user";
  cfg.work_dir = path.join(home, "projects");
  cfg.agent_card = {
    name: "My A2A Agent",
    description: "An AI coding agent accessible via A2A protocol",
  };

  await saveConfig(p, cfg);
  return p;
}
