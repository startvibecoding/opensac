// Build helper for `deno task build`.
//
// The product version of a compiled binary comes from the newest `v`-prefixed
// git tag in this repository. The tag is written to a temporary env file and
// embedded through `deno compile --env-file`, so `src/version/version.ts`
// reports it through `OPENSAC_BUILD_VERSION` at runtime without mutating any
// tracked source file.

import { resolve } from "@std/path";
import {
  npmPlatformFor,
  PLATFORM_TARGETS,
  type PlatformTarget,
} from "./platforms.ts";

/** Directories and files embedded into the compiled binary. */
const INCLUDES = [
  "src/platform/busybox_assets",
  "src/context/tokenizerdata",
  "src/stats/dashboard.html",
  "src/stats/opensac.png",
  "src/stats/opensac-small.ico",
  "src/stats/stats_worker.ts",
  "src/skills/builtin",
];

const OUTPUT = "bin/opensac";
const ENTRY = "src/main.ts";

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
    const text = await Deno.readTextFile(resolve(repoDir, "deno.json"));
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

/** Env file payload embedded into the compiled binary. */
export function buildEnvFile(version: string): string {
  return `OPENSAC_BUILD_VERSION=${version}\n`;
}

/** Assembles the `deno compile` argument list for the embedded env file. */
export function compileArgs(envFile: string): string[] {
  const args = ["compile", "-A", `--env-file=${envFile}`];
  for (const path of INCLUDES) args.push("--include", path);
  args.push("-o", OUTPUT, ENTRY);
  return args;
}

/**
 * `compileArgs` for one named release target. The output is the platform's
 * binary name from the shared platform table, so `bin/` holds exactly the
 * artifacts the npm packager later looks for.
 */
export function compileArgsForTarget(
  envFile: string,
  target: PlatformTarget,
): string[] {
  const args = [
    "compile",
    "-A",
    `--env-file=${envFile}`,
    `--target=${target.denoTarget}`,
  ];
  for (const path of INCLUDES) args.push("--include", path);
  args.push("-o", `bin/${target.binary}`, ENTRY);
  return args;
}

/** Compiles one platform and waits for it to finish. Returns the exit code. */
async function compileTarget(
  repoDir: string,
  envFile: string,
  target: PlatformTarget,
): Promise<number> {
  console.error(`Building ${target.npmPlatform} (${target.denoTarget})`);
  const status = await new Deno.Command(Deno.execPath(), {
    args: compileArgsForTarget(envFile, target),
    cwd: repoDir,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) {
    console.error(`Build failed for ${target.npmPlatform}`);
  }
  return status.code;
}

/**
 * Compiles every platform in the shared table. Stops at the first failure so a
 * partial `bin/` is never mistaken for a complete release.
 */
export async function buildAllTargets(
  repoDir: string,
  envFile: string,
  targets: readonly PlatformTarget[] = PLATFORM_TARGETS,
): Promise<void> {
  await Deno.mkdir(resolve(repoDir, "bin"), { recursive: true });
  for (const target of targets) {
    const code = await compileTarget(repoDir, envFile, target);
    if (code !== 0) Deno.exit(code);
  }
}

/** Resolves `--target=<npm-platform>` to a release target, or undefined. */
export function selectedTargets(
  flag: string | undefined,
): readonly PlatformTarget[] {
  if (flag === undefined) return [hostTarget()];
  const npmPlatform = flag.startsWith("--target=")
    ? flag.slice("--target=".length)
    : flag;
  const target = PLATFORM_TARGETS.find((t) => t.npmPlatform === npmPlatform);
  if (target === undefined) {
    const known = PLATFORM_TARGETS.map((t) => t.npmPlatform).join(", ");
    console.error(`Unknown --target=${npmPlatform}. Known platforms: ${known}`);
    Deno.exit(1);
  }
  return [target];
}

/** The release target matching the current host, for a plain `deno task build`. */
function hostTarget(): PlatformTarget {
  const npmPlatform = npmPlatformFor(Deno.build.os, Deno.build.arch);
  const target = npmPlatform === undefined
    ? undefined
    : PLATFORM_TARGETS.find((t) => t.npmPlatform === npmPlatform);
  if (target === undefined) {
    console.error(
      `No release target for ${Deno.build.os}-${Deno.build.arch}`,
    );
    Deno.exit(1);
  }
  return target;
}

if (import.meta.main) {
  const repoDir = resolve(import.meta.dirname ?? ".", "..");
  const version = await resolveBuildVersion(repoDir);
  if (Deno.args.includes("--version")) {
    // Print the version that would be embedded, without compiling.
    console.log(version);
    Deno.exit(0);
  }
  if (version === "") {
    console.error(
      "warning: no `v*` git tag and no deno.json version; " +
        "the binary will report an unknown version",
    );
  } else {
    console.error(`Building opensac ${version}`);
  }

  const envFile = await Deno.makeTempFile({
    prefix: "opensac-build-",
    suffix: ".env",
  });
  try {
    await Deno.writeTextFile(envFile, buildEnvFile(version));
    if (Deno.args.includes("--all")) {
      await buildAllTargets(repoDir, envFile);
    } else {
      const targets = selectedTargets(
        Deno.args.find((arg) => arg.startsWith("--target=")),
      );
      for (const target of targets) {
        const code = await compileTarget(repoDir, envFile, target);
        if (code !== 0) Deno.exit(code);
      }
    }
  } finally {
    await Deno.remove(envFile).catch(() => {});
  }
}
