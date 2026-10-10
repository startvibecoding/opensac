//
// Validates the ACP directory-root contract: absolute, cleaned, deterministic
// and duplicate-free paths. `path/filepath` maps to `@std/path`.

import { isAbsolute, normalize } from "../compat/path.ts";

/**
 * Validates the ACP directory-root contract: absolute, cleaned, deterministic
 * and duplicate-free paths.
 */
export function normalizeAdditionalDirectories(
  directories: string[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of directories) {
    let value = raw.trim();
    if (value === "" || !isAbsolute(value)) {
      throw new Error(
        `additional directory must be an absolute path: ${JSON.stringify(raw)}`,
      );
    }
    value = cleanPath(value);
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  result.sort();
  return result;
}

/**
 * Mirrors `filepath.Clean`'s trailing-separator removal; `@std/path.normalize`
 * preserves a trailing slash.
 */
function cleanPath(value: string): string {
  const cleaned = normalize(value);
  if (cleaned.length <= 1) return cleaned;
  const trimmed = cleaned.replace(/[/\\]+$/, "");
  return trimmed === "" ? cleaned : trimmed;
}
