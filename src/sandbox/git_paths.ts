// Ported from internal/sandbox/git_paths.go

import * as path from "@std/path";
import { canonicalSandboxPath } from "./policy.ts";

/**
 * Resolves the project Git metadata directory. A worktree's `.git` is often a
 * file containing `gitdir: <path>` rather than a directory.
 */
export function protectedGitPaths(projectDir: string): string[] {
  const gitEntry = path.join(projectDir, ".git");
  const paths: string[] = [gitEntry];

  let text = "";
  try {
    text = Deno.readTextFileSync(gitEntry).trim();
  } catch {
    return paths;
  }
  if (!text.toLowerCase().startsWith("gitdir:")) {
    return paths;
  }
  let gitDir = text.slice("gitdir:".length).trim();
  if (!path.isAbsolute(gitDir)) {
    gitDir = path.join(projectDir, gitDir);
  }
  try {
    paths.push(canonicalSandboxPath(gitDir));
  } catch {
    // Keep the unresolved entry when the target cannot be canonicalized.
  }
  return uniquePaths(paths);
}

/** Removes duplicate (after cleaning) paths while preserving order. */
export function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const clean = path.normalize(p);
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}
