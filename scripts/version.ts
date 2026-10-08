// Release-version resolution shared by the Node build (`build_node.ts`) and the
// Makefile. The product version follows the newest `v*` git tag, falling back to
// the `deno.json` version for a source tree without tags, so the published npm
// package and any local build agree.
//
// Prints the resolved version with `deno task version` / `deno run scripts/version.ts`.

import { fromFileUrl, join, resolve } from "@opensac/path";

/**
 * Picks the newest tag from `git tag --list 'v*' --sort=-v:refname` output.
 * Returns "" when there is no `v`-prefixed tag.
 */
export function pickLatestVersionTag(listOutput: string): string {
  for (const line of listOutput.split("\n")) {
    const tag = line.trim();
    if (tag !== "") return tag;
  }
  return "";
}

/** Reads the newest `v*` tag, or "" when git or the tags are unavailable. */
export async function latestVersionTag(repoDir: string): Promise<string> {
  try {
    const output = await new Deno.Command("git", {
      args: ["tag", "--list", "v*", "--sort=-v:refname"],
      cwd: repoDir,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!output.success) return "";
    return pickLatestVersionTag(new TextDecoder().decode(output.stdout));
  } catch {
    return "";
  }
}

/** Reads the `version` field of the repository `deno.json`, if present. */
export async function packageVersion(repoDir: string): Promise<string> {
  try {
    const text = await Deno.readTextFile(join(repoDir, "deno.json"));
    const parsed = JSON.parse(text) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Resolves the version to embed: the newest `v*` git tag, falling back to the
 * `deno.json` version for builds from a source tree without tags.
 */
export async function resolveBuildVersion(
  repoDir: string,
  latestTag: (dir: string) => Promise<string> = latestVersionTag,
): Promise<string> {
  const tag = (await latestTag(repoDir)).trim();
  if (tag !== "") return tag;
  return await packageVersion(repoDir);
}

/** Strips the `v` prefix and any `-dirty` suffix from a build version. */
export function toPackageVersion(buildVersion: string): string {
  return buildVersion.trim()
    .replace(/^v/, "")
    .replace(/-dirty$/, "");
}

if (import.meta.main) {
  const repoDir = resolve(fromFileUrl(new URL("..", import.meta.url)));
  console.log(await resolveBuildVersion(repoDir));
}
