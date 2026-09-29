// Packs the npm packages into tarballs without publishing, so a release can be
// inspected (or installed from a file) before it reaches the registry.
//
// Packing every platform binary produces a large set of tarballs, so they are
// written to `dist/npm/` rather than next to the manifests.

import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { INSTALLER_NAME } from "./build_npm_packages.ts";
import { PLATFORM_TARGETS } from "./platforms.ts";

/** Directory holding packed tarballs, relative to the repo root. */
export const TARBALL_DIR = join("dist", "npm");

/**
 * Packs one package directory and returns the tarball path npm reports. npm
 * names the tarball after the package, so the caller can find it without
 * guessing.
 */
export async function packPackage(
  packageDir: string,
  repoDir: string,
  npm = "npm",
): Promise<string> {
  const tarballDir = join(repoDir, TARBALL_DIR);
  await Deno.mkdir(tarballDir, { recursive: true });
  const output = await new Deno.Command(npm, {
    args: ["pack", "--pack-destination", tarballDir],
    cwd: packageDir,
    stdin: "null",
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!output.success) {
    throw new Error(`npm pack failed for ${packageDir}`);
  }
  const name = new TextDecoder().decode(output.stdout).trim().split("\n").at(-1)
    ?.trim() ?? "";
  if (name === "") {
    throw new Error(`npm pack printed no tarball for ${packageDir}`);
  }
  return join(tarballDir, name);
}

/**
 * Packs every generated platform package plus the entry package. Returns the
 * tarball paths in that order.
 */
export async function packAll(
  repoDir: string,
  npm = "npm",
): Promise<string[]> {
  const npmDir = join(repoDir, "npm");
  const tarballs: string[] = [];
  for (const target of PLATFORM_TARGETS) {
    const packageDir = join(
      npmDir,
      "packages",
      `${INSTALLER_NAME}-${target.npmPlatform}`,
    );
    // Skip platforms that were never built, so a partial build still packs.
    try {
      await Deno.stat(join(packageDir, "package.json"));
    } catch {
      continue;
    }
    tarballs.push(await packPackage(packageDir, repoDir, npm));
  }
  tarballs.push(await packPackage(npmDir, repoDir, npm));
  return tarballs;
}

if (import.meta.main) {
  const repoDir = resolve(dirname(fromFileUrl(import.meta.url)), "..");
  try {
    const tarballs = await packAll(repoDir, Deno.env.get("NPM") ?? "npm");
    console.log(`Packed ${tarballs.length} tarball(s) into ${TARBALL_DIR}/`);
    for (const tarball of tarballs) console.log(`  ${tarball}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
