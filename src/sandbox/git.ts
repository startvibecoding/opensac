import * as path from "@opensac/path";

const gitAccessStore = new WeakMap<AbortSignal, boolean>();

export function contextWithGitAccess(
  signal: AbortSignal,
  allowed: boolean,
): AbortSignal {
  gitAccessStore.set(signal, allowed);
  return signal;
}

export function gitAccessFromContext(signal: AbortSignal | undefined): boolean {
  if (!signal) return false;
  return gitAccessStore.get(signal) ?? false;
}

const GIT_PATH_PATTERN =
  /(?:^|[^0-9A-Za-z_])(git(?:\s|$)|\.git([/\\]|$)|--git-dir(?:[=:]|\s)|GIT_DIR=)/i;

/**
 * Conservatively identifies commands that may access Git metadata. It is only an
 * approval hint; the sandbox deny rule remains the actual enforcement boundary.
 */
export function gitAccessRequired(command: string, workDir: string): boolean {
  if (!GIT_PATH_PATTERN.test(command)) return false;
  if (workDir === "") return true;
  const gitPath = path.join(path.normalize(workDir), ".git");
  const lower = command.toLowerCase();
  return lower.includes(gitPath.toLowerCase()) || lower.includes(".git");
}

export function isGitDeniedPath(p: string): boolean {
  const clean = path.normalize(p).replaceAll("\\", "/");
  return clean.endsWith("/.git") || clean.includes("/.git/");
}
