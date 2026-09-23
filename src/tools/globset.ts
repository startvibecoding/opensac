//
// A faithful translation of the small gitignore-style glob compiler and matcher
// the tools package uses for ignore handling and the `include` filter. Go's
// `regexp` maps to `RegExp`; the generated patterns are anchored the same way.

import { compileGeneratedRegExp } from "../util/regex.ts";

/** A single compiled glob pattern. */
export interface Glob {
  original: string;
  regexp: RegExp;
  isNegated: boolean;
}

/** Compiles a glob pattern into a {@link Glob}. */
export function createGlob(patternIn: string): Glob {
  let pattern = patternIn;
  let isNegated = false;
  if (pattern.startsWith("!")) {
    isNegated = true;
    pattern = pattern.slice(1);
  }

  // Normalize windows separators.
  pattern = pattern.replaceAll("\\", "/");

  const regexStr = globToRegex(pattern);
  const regexp = compileGeneratedRegExp(regexStr);

  return { original: pattern, regexp, isNegated };
}

/** Checks if a path matches the glob pattern. */
export function globMatch(g: Glob, path: string): boolean {
  return g.regexp.test(path.replaceAll("\\", "/"));
}

/** Translates a gitignore-style glob pattern into a regular expression. */
export function globToRegex(patternIn: string): string {
  let pattern = patternIn;
  let isAnchored = pattern.startsWith("/");
  let trimmed = pattern;
  if (isAnchored) {
    trimmed = pattern.slice(1);
    pattern = trimmed;
  }
  if (trimmed.replace(/\/$/, "").includes("/")) {
    isAnchored = true;
  }

  let sb = "";
  if (!isAnchored) {
    sb += "(?:^|/)";
  } else {
    sb += "^";
  }

  const runes = Array.from(pattern);
  const n = runes.length;
  let inBracket = false;
  for (let i = 0; i < n; i++) {
    const r = runes[i];
    switch (r) {
      case "*":
        if (i + 1 < n && runes[i + 1] === "*") {
          i++;
          if (i + 1 < n && runes[i + 1] === "/") {
            i++;
            sb += "(?:.*/)?";
          } else {
            sb += ".*";
          }
        } else {
          sb += "[^/]*";
        }
        break;
      case "?":
        sb += "[^/]";
        break;
      case "[":
        inBracket = true;
        sb += "[";
        if (i + 1 < n && runes[i + 1] === "!") {
          sb += "^";
          i++;
        }
        break;
      case "]":
        inBracket = false;
        sb += "]";
        break;
      case "\\":
        if (i + 1 < n) {
          i++;
          sb += regexpQuoteMeta(runes[i]);
        } else {
          sb += "\\\\";
        }
        break;
      case ".":
      case "+":
      case "$":
      case "^":
      case "(":
      case ")":
      case "|":
      case "{":
      case "}":
        // eslint-disable-next-line no-useless-escape
        if (inBracket) {
          sb += r;
        } else {
          sb += "\\" + r;
        }
        break;
      default:
        sb += r;
    }
  }
  sb += "$";
  return sb;
}

function regexpQuoteMeta(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A collection of compiled {@link Glob} patterns. */
export class GlobSet {
  #globs: Glob[];

  constructor(globs: Glob[]) {
    this.#globs = globs;
  }

  /** Compiles a list of glob patterns. */
  static newGlobSet(patterns: string[]): GlobSet {
    const globs: Glob[] = [];
    for (const pat of patterns) {
      if (pat === "" || pat.startsWith("#")) {
        continue;
      }
      globs.push(createGlob(pat));
    }
    return new GlobSet(globs);
  }

  /**
   * Checks the path against all glob patterns in the set. A negated pattern
   * overrides normal matches; the last matching pattern takes precedence.
   */
  match(path: string): { matched: boolean; isIgnored: boolean } {
    for (let i = this.#globs.length - 1; i >= 0; i--) {
      const g = this.#globs[i];
      if (globMatch(g, path)) {
        if (g.isNegated) {
          return { matched: true, isIgnored: false };
        }
        return { matched: true, isIgnored: true };
      }
    }
    return { matched: false, isIgnored: false };
  }

  /**
   * Checks if a path is matched, including all of its parent directories, so
   * directory-level patterns work.
   */
  matchPath(path: string): { matched: boolean; isIgnored: boolean } {
    const parts = path.replaceAll("\\", "/").split("/");
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] === "") continue;
      current = current === "" ? parts[i] : current + "/" + parts[i];
      let m = this.match(current + "/");
      if (m.matched && m.isIgnored) return { matched: true, isIgnored: true };
      m = this.match(current);
      if (m.matched && m.isIgnored) return { matched: true, isIgnored: true };
    }
    return this.match(path);
  }

  /** Checks if a path should be ignored according to ripgrep's -g/--glob rules. */
  matchGlobFilter(path: string): boolean {
    if (this.#globs.length === 0) return false;
    const p = path.replaceAll("\\", "/");

    let hasPositive = false;
    for (const g of this.#globs) {
      if (!g.isNegated) {
        hasPositive = true;
        break;
      }
    }

    for (const g of this.#globs) {
      if (g.isNegated && globMatch(g, p)) return true;
    }

    if (hasPositive) {
      let matchedPositive = false;
      for (const g of this.#globs) {
        if (!g.isNegated && globMatch(g, p)) {
          matchedPositive = true;
          break;
        }
      }
      if (!matchedPositive) return true;
    }

    return false;
  }

  /**
   * Checks whether a directory should be excluded during traversal. Positive
   * globs do not exclude directories by themselves.
   */
  matchGlobFilterDir(path: string): boolean {
    if (this.#globs.length === 0) return false;
    const p = path.replaceAll("\\", "/");
    for (const g of this.#globs) {
      if (g.isNegated && globMatch(g, p)) return true;
    }
    return false;
  }
}
