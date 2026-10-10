import { runtime } from "../platform/runtime.ts";
import * as path from "../compat/path.ts";
import { isGitDeniedPath } from "./git.ts";
import { type Options } from "./sandbox.ts";

/**
 * Resolves sandbox path rules against `projectDir` and rejects ambiguous
 * allow/deny overlaps before a backend constructs any mounts.
 */
export function normalizeOptions(projectDir: string, opts: Options): Options {
  const base = canonicalSandboxPath(projectDir);
  if (base === "") {
    throw new Error("sandbox project directory is required");
  }

  const normalize = (paths: string[] | undefined, field: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (let p of paths ?? []) {
      if (!path.isAbsolute(p)) p = path.join(base, p);
      let canonical: string;
      try {
        canonical = canonicalSandboxPath(p);
      } catch (err) {
        throw new Error(
          `normalize sandbox.${field} path ${JSON.stringify(p)}: ${err}`,
        );
      }
      if (canonical === "") continue;
      if (!seen.has(canonical)) {
        seen.add(canonical);
        out.push(canonical);
      }
    }
    return out;
  };

  const result: Options = { ...opts };
  result.allowedRead = normalize(opts.allowedRead, "allowedRead");
  result.allowedWrite = normalize(opts.allowedWrite, "allowedWrite");
  result.deniedPaths = normalize(opts.deniedPaths, "deniedPaths");
  result.tmpSize = normalizeTmpSize(opts.tmpSize);

  if (runtime.build.os === "linux") {
    const filtered: string[] = [];
    for (const deny of result.deniedPaths) {
      // Git metadata is part of the project and must remain visible.
      if (isGitDeniedPath(deny)) continue;
      // Bubblewrap already replaces the real user home with an isolated tmpfs.
      if (deny === "/home" && pathContains(deny, base)) continue;
      filtered.push(deny);
    }
    result.deniedPaths = filtered;
  }

  for (const deny of result.deniedPaths) {
    if (pathContains(deny, base)) {
      throw new Error(
        `sandbox denied path ${JSON.stringify(
          deny,
        )} contains project directory ${JSON.stringify(base)}`,
      );
    }
    for (const allow of [...result.allowedRead, ...result.allowedWrite]) {
      if (pathsOverlap(deny, allow)) {
        throw new Error(
          `sandbox denied path ${JSON.stringify(deny)} overlaps allowed path ${JSON.stringify(
            allow,
          )}`,
        );
      }
    }
  }
  return result;
}

export function normalizeTmpSize(value: string | undefined): string {
  if (!value || value.trim() === "") return "100000000";
  const bytes = parseTmpSize(value);
  if (bytes === 0) {
    throw new Error(
      `invalid sandbox tmpSize ${JSON.stringify(
        value,
      )}: size must be greater than zero`,
    );
  }
  return bytes.toString();
}

const TMP_SIZE_SUFFIXES: Array<[string, number]> = [
  ["gb", 1024 ** 3],
  ["mb", 1024 ** 2],
  ["kb", 1024],
  ["g", 1024 ** 3],
  ["m", 1024 ** 2],
  ["k", 1024],
];

export function parseTmpSize(value: string): number {
  let v = value.trim().toLowerCase();
  let multiplier = 1;
  for (const [suffix, factor] of TMP_SIZE_SUFFIXES) {
    if (v.endsWith(suffix)) {
      v = v.slice(0, -suffix.length).trim();
      multiplier = factor;
      break;
    }
  }
  if (!/^\d+$/.test(v)) {
    throw new Error(`invalid size ${JSON.stringify(value)}`);
  }
  const n = Number(v);
  if (!Number.isSafeInteger(n * multiplier)) {
    throw new Error("size overflows bytes");
  }
  return n * multiplier;
}

/** Resolves a path to an absolute, symlink-resolved form. */
export function canonicalSandboxPath(p: string): string {
  if (p === "") return "";
  try {
    return runtime.realPathSync(path.resolve(path.normalize(p)));
  } catch (err) {
    if (!(err instanceof runtime.errors.NotFound)) throw err;
  }
  // Canonicalize the longest existing parent, then append the missing suffix.
  const abs = path.resolve(path.normalize(p));
  const suffix: string[] = [];
  let parent = abs;
  for (;;) {
    try {
      let resolved = runtime.realPathSync(parent);
      for (let i = suffix.length - 1; i >= 0; i--) {
        resolved = path.join(resolved, suffix[i]);
      }
      return resolved;
    } catch (err) {
      if (!(err instanceof runtime.errors.NotFound)) throw err;
    }
    const next = path.dirname(parent);
    if (next === parent) throw new Error("no existing parent");
    suffix.push(path.basename(parent));
    parent = next;
  }
}

export function pathsOverlap(a: string, b: string): boolean {
  const sep = path.SEPARATOR;
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}

/** Reports whether `child` is `parent` itself or nested below it. */
function pathContains(parent: string, child: string): boolean {
  const sep = path.SEPARATOR;
  return parent === child || child.startsWith(parent + sep);
}
