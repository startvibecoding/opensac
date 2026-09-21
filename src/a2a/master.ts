// Ported from internal/a2a/master.go.
import * as path from "@std/path";
import { configDir, projectPath } from "../config/mod.ts";
import { newClient } from "./client.ts";
import type { Task } from "./task.ts";

/** AgentEntry describes a remote A2A agent in a2a-list.json. */
export interface AgentEntry {
  name: string;
  url: string;
  auth_token?: string;
}

/** AgentListConfig is the top-level structure of a2a-list.json. */
export interface AgentListConfig {
  agents: AgentEntry[];
}

/** AgentListConfigPath returns the path to the global a2a-list.json. */
export function agentListConfigPath(): string {
  return path.join(configDir(), "a2a-list.json");
}

/** ProjectAgentListConfigPath returns the project-level .opensac/a2a-list.json. */
export function projectAgentListConfigPath(): string {
  return projectPath("a2a-list.json");
}

/** LoadAgentList loads a2a-list.json from the given path. */
export async function loadAgentList(p: string): Promise<AgentListConfig> {
  let data: string;
  try {
    data = await Deno.readTextFile(p);
  } catch (err) {
    throw new Error(`read a2a-list.json: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(data) as AgentListConfig;
  } catch (err) {
    throw new Error(`parse a2a-list.json: ${(err as Error).message}`);
  }
}

/** SaveAgentList writes the agent list config to a JSON file. */
export async function saveAgentList(
  p: string,
  cfg: AgentListConfig,
): Promise<void> {
  try {
    await Deno.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new Error(`create config directory: ${(err as Error).message}`);
  }
  const data = JSON.stringify(cfg, null, 2);
  await Deno.writeTextFile(p, data, { mode: 0o600 });
}

// InitA2AMasterConfig creates a sample a2a-list.json at the default location.
// Returns the file path. If force is false and the file already exists, throws.
export async function initA2AMasterConfig(force: boolean): Promise<string> {
  const p = agentListConfigPath();
  if (!force) {
    try {
      await Deno.stat(p);
      throw new Error(`a2a-list.json already exists: ${p}`);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  const cfg: AgentListConfig = {
    agents: [
      {
        name: "code-reviewer",
        url: "http://localhost:8093",
        auth_token: "",
      },
      {
        name: "ci-agent",
        url: "http://ci-server:8093",
        auth_token: "change-me-to-a-random-secret",
      },
    ],
  };
  await saveAgentList(p, cfg);
  return p;
}

/** A2AManager manages a list of remote A2A agents and provides dispatch. */
export class A2AManager {
  private entries = new Map<string, AgentEntry>();
  private order: string[] = [];

  constructor(cfg?: AgentListConfig) {
    if (cfg !== undefined && cfg !== null) {
      for (const e of cfg.agents ?? []) {
        this.entries.set(e.name, e);
        this.order.push(e.name);
      }
    }
  }

  /** List returns all registered agent entries in order. */
  list(): AgentEntry[] {
    const result: AgentEntry[] = [];
    for (const name of this.order) {
      const e = this.entries.get(name);
      if (e !== undefined) result.push(e);
    }
    return result;
  }

  /** Get returns an agent entry by name. */
  get(name: string): [AgentEntry, boolean] {
    const e = this.entries.get(name);
    return [e as AgentEntry, e !== undefined];
  }

  /** Dispatch sends a message to the named remote A2A agent. */
  async dispatch(
    ctx: AbortSignal,
    name: string,
    message: string,
  ): Promise<string> {
    const entry = this.entries.get(name);
    if (entry === undefined) {
      throw new Error(`agent '${name}' not found in a2a-list`);
    }

    const client = newClient(entry.url, entry.auth_token ?? "");
    let task: Task;
    try {
      task = await client.sendMessage(ctx, "", {
        role: "user",
        parts: [{ type: "text", text: message }],
      });
    } catch (err) {
      throw new Error(`dispatch to '${name}': ${(err as Error).message}`);
    }

    if (task.artifacts !== undefined && task.artifacts.length > 0) {
      const texts: string[] = [];
      for (const a of task.artifacts) {
        for (const p of a.parts) {
          if (p.type === "text" && p.text !== undefined && p.text !== "") {
            texts.push(p.text);
          }
        }
      }
      if (texts.length > 0) return joinTexts(texts);
    }
    if (task.message !== undefined && task.message !== null) {
      const texts: string[] = [];
      for (const p of task.message.parts) {
        if (p.type === "text" && p.text !== undefined && p.text !== "") {
          texts.push(p.text);
        }
      }
      if (texts.length > 0) return joinTexts(texts);
    }

    return "(no text response from agent)";
  }
}

/** NewA2AManager creates a new A2A manager from a config. */
export function newA2AManager(cfg?: AgentListConfig): A2AManager {
  return new A2AManager(cfg);
}

function joinTexts(texts: string[]): string {
  return texts.join("\n");
}
