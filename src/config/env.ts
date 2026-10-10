import { runtime } from "../platform/runtime.ts";
import * as path from "../compat/path.ts";
import { optStringMap, parseJsonRecord } from "../util/json.ts";
import { configDir } from "./settings.ts";

/** Environment variables injected into bash and skill tools. */
export interface EnvConfig {
  vars: Record<string, string>;
}

/** Returns the global env.json path. */
export function globalEnvPath(): string {
  return path.join(configDir(), "env.json");
}

/** Loads the global env.json, returning an empty config when it is missing. */
export function loadEnv(): EnvConfig {
  const c: EnvConfig = { vars: {} };
  try {
    const data = runtime.readTextFileSync(globalEnvPath());
    const vars = optStringMap(parseJsonRecord(data), "vars");
    if (vars !== undefined) c.vars = vars;
  } catch {
    // Missing or invalid file: keep the empty default.
  }
  if (c.vars === null || c.vars === undefined) c.vars = {};
  return c;
}

/** Returns a shallow copy of the configured variables. */
export function envList(c: EnvConfig): Record<string, string> {
  return { ...c.vars };
}

/**
 * Checks whether a name is acceptable for a global environment variable. It
 * mirrors the rules enforced by setEnv.
 */
export function validateEnvName(name: string): void {
  const trimmed = name.trim();
  const hasBadChar =
    name.includes("=") ||
    name.includes("\u0000") ||
    name.includes("\r") ||
    name.includes("\n");
  if (trimmed === "" || hasBadChar) {
    throw new Error("invalid environment variable name");
  }
}

/**
 * Atomically applies a set of variable assignments and a set of deletions. It
 * validates every name, rejects duplicates or conflicts, and writes the result
 * once. Values are preserved as-is, including empty strings.
 */
export function applyEnvPatch(
  c: EnvConfig,
  set: Record<string, string>,
  unset: string[],
): void {
  if (!c.vars) c.vars = {};
  const seen = new Set<string>();
  for (const rawName of Object.keys(set)) {
    const name = rawName.trim();
    validateEnvName(name);
    if (seen.has(name)) {
      throw new Error(
        `duplicate environment variable name ${JSON.stringify(name)}`,
      );
    }
    seen.add(name);
  }
  for (const rawName of unset) {
    const name = rawName.trim();
    validateEnvName(name);
    if (seen.has(name)) {
      throw new Error(
        `environment variable ${JSON.stringify(
          name,
        )} cannot be both set and unset`,
      );
    }
    seen.add(name);
  }
  for (const [rawName, value] of Object.entries(set)) {
    c.vars[rawName.trim()] = value;
  }
  for (const rawName of unset) {
    delete c.vars[rawName.trim()];
  }
  saveEnv(c);
}

/** Sets one variable and persists the file. */
export function setEnv(c: EnvConfig, key: string, value: string): void {
  key = key.trim();
  validateEnvName(key);
  if (!c.vars) c.vars = {};
  c.vars[key] = value;
  saveEnv(c);
}

/** Deletes one variable and persists the file. */
export function unsetEnv(c: EnvConfig, key: string): void {
  delete c.vars[key.trim()];
  saveEnv(c);
}

/** Removes every variable and persists the file. */
export function clearEnv(c: EnvConfig): void {
  c.vars = {};
  saveEnv(c);
}

/** Persists env.json with sorted keys and private permissions. */
export function saveEnv(c: EnvConfig): void {
  runtime.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const keys = Object.keys(c.vars).sort();
  const ordered: Record<string, string> = {};
  for (const k of keys) ordered[k] = c.vars[k];
  const data = JSON.stringify({ vars: ordered }, null, 2) + "\n";
  const tmp = globalEnvPath() + ".tmp";
  runtime.writeTextFileSync(tmp, data, { mode: 0o600 });
  runtime.renameSync(tmp, globalEnvPath());
}
