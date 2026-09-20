// Ported from internal/serve/config.go.
//
// Initial slice of backlog #36: the serve.json path helpers. The full serve
// Config schema, load/normalize chain, and runtime wiring land with the rest of
// the serve package; doctor (backlog #32) only needs these paths so the
// diagnostic result renders the same serve config locations as the Go CLI/ACP.

import { configDir, projectPath } from "../config/mod.ts";
import path from "node:path";

/** Returns the global `serve.json` path. */
export function configPath(): string {
  return path.join(configDir(), "serve.json");
}

/** Returns the project-level `serve.json` path. */
export function projectConfigPath(): string {
  return projectPath("serve.json");
}

/**
 * The subset of `serve.json` this slice understands. The full serve Config
 * schema, load/normalize chain, and runtime wiring land with the rest of
 * backlog #36; only the memory feature/path are needed to project the
 * `memoryEnabled` field of `mothx/manage/settings/get` and the memory manage
 * family, exactly like `serve.Config.Features.Memory` / `Memory.Path`.
 */
export interface ServeMemoryConfig {
  enabled?: boolean;
  path?: string;
}

/** The minimal, memory-focused view of the serve config. */
export interface ServeConfigView {
  memory: ServeMemoryConfig;
}

/**
 * Returns the default serve memory config. Default channels config enables
 * memory (`MemoryConfig{Enabled: true}`), and the default `serve.json` has no
 * explicit memory section, so an absent config keeps memory enabled.
 */
export function defaultServeConfig(): ServeConfigView {
  return { memory: { enabled: true } };
}

function readServeMemorySection(filePath: string): ServeMemoryConfig | null {
  let data: string;
  try {
    data = Deno.readTextFileSync(filePath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
  if (data.trim() === "") return null;
  const parsed = JSON.parse(data) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("serve config must be a JSON object");
  }
  const memory = (parsed as Record<string, unknown>)["memory"];
  if (
    memory === undefined || memory === null || typeof memory !== "object" ||
    Array.isArray(memory)
  ) {
    return null;
  }
  const record = memory as Record<string, unknown>;
  const out: ServeMemoryConfig = {};
  if (typeof record["enabled"] === "boolean") out.enabled = record["enabled"];
  if (typeof record["path"] === "string") out.path = record["path"];
  return out;
}

/**
 * Loads the effective serve config view. The global `serve.json` seeds the
 * defaults, then the project `serve.json` overlays present fields, matching the
 * Go `LoadConfig` order without the unported sections.
 */
export function loadConfig(): ServeConfigView {
  const cfg = defaultServeConfig();
  const global = readServeMemorySection(configPath());
  if (global !== null) Object.assign(cfg.memory, global);
  const project = readServeMemorySection(projectConfigPath());
  if (project !== null) Object.assign(cfg.memory, project);
  return cfg;
}

/**
 * Reports whether serve memory is enabled. Matches `cfg.Features.Memory` after
 * normalization (`normalize` copies `Memory.Enabled` into `Features.Memory`).
 */
export function memoryEnabled(): boolean {
  const cfg = loadConfig();
  return cfg.memory.enabled !== false;
}
