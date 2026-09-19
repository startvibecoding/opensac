// Ported from internal/config/allow.go

import * as path from "@std/path";
import { configDir } from "./settings.ts";
import { projectPath } from "./paths.ts";

/**
 * Holds runtime auto-approval settings that are persisted separately from
 * settings.json in allow.json.
 *
 *   - autoEdit: when true, write/edit tools auto-approve in agent mode.
 *   - editPaths: glob whitelist of paths whose write/edit auto-approve in agent
 *     mode. Supports "**" (cross-directory) and "*" (single segment).
 *   - bashCommands / bashPrefixes: project-level command allow rules for bash
 *     auto-approval in agent mode.
 *
 * Loading follows the same global->project override order as settings.json:
 * autoEdit is taken from the project file when present, otherwise the global
 * file. editPaths and bash allow rules are project-level only.
 */
export interface AllowConfig {
  autoEdit?: boolean;
  editPaths?: string[];
  bashCommands?: string[];
  bashPrefixes?: string[];
  /** Tracks an explicit project-scoped autoEdit value (never serialized). */
  projectAutoEditSet?: boolean;
}

/** Returns the global allow.json path. */
export function globalAllowPath(): string {
  return path.join(configDir(), "allow.json");
}

/** Returns the project-level allow.json path. */
export function projectAllowPath(): string {
  return projectPath("allow.json");
}

/**
 * Loads allow configuration with global->project override semantics. autoEdit
 * defaults to enabled unless global or project allow.json explicitly sets it;
 * editPaths and bash allow rules are project-level only.
 */
export function loadAllow(): AllowConfig {
  const c: AllowConfig = { autoEdit: true };

  // Global: only autoEdit is honored.
  try {
    const data = Deno.readTextFileSync(globalAllowPath());
    const v = readAllowAutoEdit(data);
    if (v !== undefined) c.autoEdit = v;
  } catch {
    // missing global file
  }

  // Project: overrides autoEdit and is the sole source of editPaths.
  try {
    const data = Deno.readTextFileSync(projectAllowPath());
    let p: AllowConfig | undefined;
    try {
      p = JSON.parse(data) as AllowConfig;
    } catch {
      p = undefined;
    }
    if (p) {
      const v = readAllowAutoEdit(data);
      if (v !== undefined) {
        c.autoEdit = v;
        c.projectAutoEditSet = true;
      }
      c.editPaths = p.editPaths;
      c.bashCommands = p.bashCommands;
      c.bashPrefixes = p.bashPrefixes;
    }
  } catch {
    // missing project file
  }

  return c;
}

/** Updates the in-memory autoEdit flag. */
export function setAutoEdit(c: AllowConfig, v: boolean): void {
  c.autoEdit = v;
}

/**
 * Updates the autoEdit flag and marks it as explicitly set at project scope, so
 * saveProject persists false as an intentional override.
 */
export function setProjectAutoEdit(c: AllowConfig, v: boolean): void {
  c.autoEdit = v;
  c.projectAutoEditSet = true;
}

/**
 * Updates the effective autoEdit flag only when the project file does not
 * explicitly override it. Returns the current effective value.
 */
export function setGlobalAutoEdit(c: AllowConfig, v: boolean): boolean {
  if (!c.projectAutoEditSet) c.autoEdit = v;
  return c.autoEdit ?? false;
}

/** Reports the current autoEdit flag. */
export function getAutoEdit(c: AllowConfig): boolean {
  return c.autoEdit ?? false;
}

/** Returns a copy of the current edit-path whitelist. */
export function editPathList(c: AllowConfig): string[] {
  return [...(c.editPaths ?? [])];
}

/** Appends a glob to the whitelist if not already present. */
export function addEditPath(c: AllowConfig, glob: string): boolean {
  glob = glob.trim();
  if (glob === "") return false;
  const list = c.editPaths ?? [];
  if (list.some((g) => g === glob)) return false;
  list.push(glob);
  c.editPaths = list;
  return true;
}

/** Removes a glob from the whitelist. Returns true when removed. */
export function removeEditPath(c: AllowConfig, glob: string): boolean {
  glob = glob.trim();
  const list = c.editPaths ?? [];
  const idx = list.indexOf(glob);
  if (idx < 0) return false;
  list.splice(idx, 1);
  c.editPaths = list;
  return true;
}

/** Empties the whitelist. */
export function clearEditPaths(c: AllowConfig): void {
  c.editPaths = undefined;
}

/** Appends an exact bash command allow rule if not already present. */
export function addBashCommand(c: AllowConfig, command: string): boolean {
  command = command.trim();
  if (command === "") return false;
  const list = c.bashCommands ?? [];
  if (list.some((existing) => existing === command)) return false;
  list.push(command);
  c.bashCommands = list;
  return true;
}

/** Removes an exact bash command allow rule if present. */
export function removeBashCommand(c: AllowConfig, command: string): boolean {
  command = command.trim();
  const list = c.bashCommands ?? [];
  const idx = list.indexOf(command);
  if (idx < 0) return false;
  list.splice(idx, 1);
  c.bashCommands = list;
  return true;
}

/**
 * Appends a bash command prefix allow rule if not already present. Trailing
 * spaces are preserved because command prefixes are matched literally.
 */
export function addBashPrefix(c: AllowConfig, prefix: string): boolean {
  prefix = prefix.replace(/^[ \t\r\n]+/, "");
  if (prefix.trim() === "") return false;
  const list = c.bashPrefixes ?? [];
  if (list.some((existing) => existing === prefix)) return false;
  list.push(prefix);
  c.bashPrefixes = list;
  return true;
}

/** Removes a bash command prefix allow rule if present. */
export function removeBashPrefix(c: AllowConfig, prefix: string): boolean {
  prefix = prefix.replace(/^[ \t\r\n]+/, "");
  const list = c.bashPrefixes ?? [];
  const idx = list.indexOf(prefix);
  if (idx < 0) return false;
  list.splice(idx, 1);
  c.bashPrefixes = list;
  return true;
}

/** Reports whether command matches any project bash allow rule. */
export function matchBashCommand(c: AllowConfig, command: string): boolean {
  command = command.trim();
  if (command === "") return false;
  for (const exact of c.bashCommands ?? []) {
    if (command === exact) return true;
  }
  for (const prefix of c.bashPrefixes ?? []) {
    if (prefix !== "" && command.startsWith(prefix)) return true;
  }
  return false;
}

/** Reports whether path matches any whitelist glob. */
export function matchEditPath(c: AllowConfig, p: string): boolean {
  const list = c.editPaths ?? [];
  if (list.length === 0) return false;
  const clean = normalizeMatchPath(p);
  return list.some((g) => matchGlob(normalizeMatchPath(g), clean));
}

/**
 * Persists the project config. The project autoEdit key is written only when it
 * was explicitly set at project scope; inherited global state is never copied
 * into .mothx/allow.json as a side effect of editing path rules.
 */
export function saveProject(c: AllowConfig): void {
  writeProjectAllowFile(
    projectAllowPath(),
    c.autoEdit ?? false,
    c.projectAutoEditSet ?? false,
    [...(c.editPaths ?? [])],
    [...(c.bashCommands ?? [])],
    [...(c.bashPrefixes ?? [])],
  );
}

/**
 * Persists only autoEdit to the global file, preserving any other keys that may
 * exist there.
 */
export function saveGlobalAutoEdit(c: AllowConfig): void {
  writeGlobalAllowAutoEdit(c.autoEdit ?? false);
}

/**
 * Persists the provided global autoEdit value without changing project-scoped
 * effective state in memory.
 */
export function saveGlobalAutoEditValue(v: boolean): void {
  writeGlobalAllowAutoEdit(v);
}

function writeGlobalAllowAutoEdit(v: boolean): void {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(Deno.readTextFileSync(globalAllowPath())) as Record<
      string,
      unknown
    >;
  } catch {
    existing = {};
  }
  existing["autoEdit"] = v;
  delete existing["editPaths"]; // editPaths are project-only.
  delete existing["bashCommands"];
  delete existing["bashPrefixes"];
  writeJSONFile(globalAllowPath(), existing);
}

function readAllowAutoEdit(data: string): boolean | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!("autoEdit" in raw)) return undefined;
  const v = raw["autoEdit"];
  if (typeof v !== "boolean") return undefined;
  return v;
}

function writeProjectAllowFile(
  p: string,
  autoEdit: boolean,
  autoEditSet: boolean,
  editPaths: string[],
  bashCommands: string[],
  bashPrefixes: string[],
): void {
  const out: Record<string, unknown> = {};
  if (autoEditSet) out["autoEdit"] = autoEdit;
  if (editPaths.length > 0) out["editPaths"] = editPaths;
  if (bashCommands.length > 0) out["bashCommands"] = bashCommands;
  if (bashPrefixes.length > 0) out["bashPrefixes"] = bashPrefixes;
  writeJSONFile(p, out);
}

function writeJSONFile(p: string, v: unknown): void {
  const dir = path.dirname(p);
  if (dir !== "") Deno.mkdirSync(dir, { recursive: true, mode: 0o700 });
  Deno.writeTextFileSync(p, JSON.stringify(v, null, 2), { mode: 0o600 });
}

/**
 * Cleans a path for matching: forward slashes, trimmed leading "./".
 */
export function normalizeMatchPath(p: string): string {
  let out = p.replaceAll("\\", "/");
  if (out.startsWith("./")) out = out.slice(2);
  return out;
}

/**
 * Matches a glob pattern against a path. It supports:
 *   - "*"  matches any run of characters except "/"
 *   - "**" matches any run of characters including "/"
 *   - "?"  matches a single non-"/" character
 */
export function matchGlob(pattern: string, name: string): boolean {
  return globMatch(pattern, name);
}

/** Implements a recursive glob matcher with ** support. */
export function globMatch(pattern: string, name: string): boolean {
  while (pattern.length > 0) {
    switch (pattern[0]) {
      case "*": {
        // Check for "**".
        if (pattern.length >= 2 && pattern[1] === "*") {
          let rest = pattern.slice(2);
          while (rest.length > 0 && rest[0] === "*") rest = rest.slice(1);
          // "**/" should also match zero directories.
          if (rest.startsWith("/")) {
            if (globMatch(rest.slice(1), name)) return true;
          }
          if (rest === "") return true;
          // Try to match rest at every position (including across "/").
          for (let i = 0; i <= name.length; i++) {
            if (globMatch(rest, name.slice(i))) return true;
          }
          return false;
        }
        // Single "*": match any run not containing "/".
        const rest = pattern.slice(1);
        for (let i = 0; i <= name.length; i++) {
          if (i > 0 && name[i - 1] === "/") break;
          if (globMatch(rest, name.slice(i))) return true;
        }
        return false;
      }
      case "?": {
        if (name.length === 0 || name[0] === "/") return false;
        pattern = pattern.slice(1);
        name = name.slice(1);
        break;
      }
      default: {
        if (name.length === 0 || pattern[0] !== name[0]) return false;
        pattern = pattern.slice(1);
        name = name.slice(1);
      }
    }
  }
  return name.length === 0;
}
