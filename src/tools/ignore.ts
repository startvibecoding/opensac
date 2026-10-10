//
// The nested ignore stack used by the grep/find traversal to honor
// `.gitignore`, `.ignore`, and `.rgignore` files (plus the global gitignore)
// and hidden-file rules. Deviations: Go's `regexp`-based globs map to the
// `globset.ts` `GlobSet`; the optional `git config --global core.excludesfile`
// probe runs through `Deno.Command` and silently falls back to the well-known
// paths when git is unavailable.

import * as path from "../compat/path.ts";
import { GlobSet } from "./globset.ts";

/** The compiled ignore patterns for a single directory. */
export interface IgnoreLevel {
  dirPath: string;
  gitIgnore?: GlobSet;
  ignore?: GlobSet;
  rgIgnore?: GlobSet;
}

/** Manages nested ignore levels. */
export class IgnoreStack {
  levels: IgnoreLevel[];
  noIgnore: boolean;
  hidden: boolean;
  maxDepth: number;

  constructor(noIgnore = false, hidden = false, maxDepth = 0) {
    this.levels = [];
    this.noIgnore = noIgnore;
    this.hidden = hidden;
    this.maxDepth = maxDepth;
  }

  /** Loads global ignore files and climbs parent directories to pre-populate. */
  loadBaseRules(startPath: string): void {
    if (this.noIgnore) return;

    const globalPath = getGlobalGitIgnorePath();
    if (globalPath !== "") {
      const patterns = parseIgnoreFile(globalPath);
      if (patterns !== null) {
        this.levels.push({
          dirPath: path.dirname(globalPath),
          gitIgnore: GlobSet.newGlobSet(patterns),
        });
      }
    }

    const abs = path.resolve(startPath);
    const dirs: string[] = [];
    let curr = path.dirname(abs);
    // Climb at most 64 levels to avoid unbounded traversal.
    for (let i = 0; i < 64; i++) {
      dirs.push(curr);
      const parent = path.dirname(curr);
      if (parent === curr) break;
      try {
        Deno.statSync(path.join(curr, ".git"));
        break; // hit a .git boundary
      } catch {
        // keep climbing
      }
      curr = parent;
    }

    for (let i = dirs.length - 1; i >= 0; i--) {
      const dir = dirs[i];
      const level: IgnoreLevel = { dirPath: dir };
      let hasRules = false;

      const gitPatterns = parseIgnoreFile(path.join(dir, ".gitignore"));
      if (gitPatterns !== null) {
        level.gitIgnore = GlobSet.newGlobSet(gitPatterns);
        hasRules = true;
      }
      const ignorePatterns = parseIgnoreFile(path.join(dir, ".ignore"));
      if (ignorePatterns !== null) {
        level.ignore = GlobSet.newGlobSet(ignorePatterns);
        hasRules = true;
      }
      const rgPatterns = parseIgnoreFile(path.join(dir, ".rgignore"));
      if (rgPatterns !== null) {
        level.rgIgnore = GlobSet.newGlobSet(rgPatterns);
        hasRules = true;
      }

      if (hasRules) {
        this.levels.push(level);
      }
    }
  }

  /** Creates a copy of the stack. */
  clone(): IgnoreStack {
    const s = new IgnoreStack(this.noIgnore, this.hidden, this.maxDepth);
    s.levels = this.levels.slice();
    return s;
  }

  /** Adds ignore rules for a directory to the stack. */
  push(dirPath: string): void {
    if (this.noIgnore) return;
    const level: IgnoreLevel = { dirPath };
    const gitPatterns = parseIgnoreFile(path.join(dirPath, ".gitignore"));
    if (gitPatterns !== null) level.gitIgnore = GlobSet.newGlobSet(gitPatterns);
    const ignorePatterns = parseIgnoreFile(path.join(dirPath, ".ignore"));
    if (ignorePatterns !== null) {
      level.ignore = GlobSet.newGlobSet(ignorePatterns);
    }
    const rgPatterns = parseIgnoreFile(path.join(dirPath, ".rgignore"));
    if (rgPatterns !== null) level.rgIgnore = GlobSet.newGlobSet(rgPatterns);
    this.levels.push(level);
  }

  /** Removes the deepest ignore level. */
  pop(): void {
    if (this.levels.length > 0) this.levels.pop();
  }

  /** Checks if the given path should be ignored, deepest level first. */
  isIgnored(p: string, isDir: boolean): boolean {
    const filename = path.basename(p);

    if (
      !this.hidden && filename.startsWith(".") && filename !== "." &&
      filename !== ".."
    ) {
      return true;
    }

    if (this.noIgnore) return false;

    for (let i = this.levels.length - 1; i >= 0; i--) {
      const level = this.levels[i];
      let rel: string;
      try {
        rel = path.relative(path.resolve(level.dirPath), path.resolve(p));
      } catch {
        continue;
      }
      rel = rel.replaceAll("\\", "/");
      if (isDir) rel = rel + "/";

      if (level.rgIgnore) {
        const m = level.rgIgnore.matchPath(rel);
        if (m.matched) return m.isIgnored;
      }
      if (level.ignore) {
        const m = level.ignore.matchPath(rel);
        if (m.matched) return m.isIgnored;
      }
      if (level.gitIgnore) {
        const m = level.gitIgnore.matchPath(rel);
        if (m.matched) return m.isIgnored;
      }
    }

    return false;
  }
}

function getGlobalGitIgnorePath(): string {
  try {
    const out = new Deno.Command("git", {
      args: ["config", "--global", "core.excludesfile"],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (out.success) {
      const decoded = new TextDecoder().decode(out.stdout).trim();
      if (decoded !== "") {
        if (decoded.startsWith("~")) {
          return path.join(homeDirSafe(), decoded.slice(1));
        }
        return decoded;
      }
    }
  } catch {
    // git unavailable; fall through to defaults
  }

  const home = homeDirSafe();
  if (home === "") return "";

  let p = path.join(home, ".config", "git", "ignore");
  if (exists(p)) return p;
  p = path.join(home, ".gitignore");
  if (exists(p)) return p;
  return "";
}

function homeDirSafe(): string {
  try {
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
    return home ?? "";
  } catch {
    return "";
  }
}

function exists(p: string): boolean {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Reads an ignore file and returns valid patterns, or null if unreadable. */
export function parseIgnoreFile(p: string): string[] | null {
  let text: string;
  try {
    text = Deno.readTextFileSync(p);
  } catch {
    return null;
  }
  const patterns: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    patterns.push(line.replace(/\r$/, ""));
  }
  return patterns;
}
