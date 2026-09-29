// Verifies that every platform package an entry manifest depends on is
// actually published, at the same version.
//
// This runs between publishing the platform packages and publishing the entry
// package. npm resolves an `optionalDependencies` entry that does not exist by
// silently skipping it, so an entry package published ahead of its platforms
// installs and then fails at first run with no clear cause. Checking here turns
// that into a failed release step instead.
//
// This script is a release tool: `make npm-publish*` is the only intended entry
// point.

import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { isPublished } from "./npm_publish_if_needed.ts";

/** One dependency that is missing from the registry. */
export interface MissingPlatform {
  name: string;
  version: string;
  reason: string;
}

/** npm registry default, overridable the same way npm itself reads it. */
export function defaultRegistry(): string {
  return Deno.env.get("NPM_REGISTRY") ??
    Deno.env.get("npm_config_registry") ??
    "https://registry.npmjs.org";
}

async function readText(path: string): Promise<string> {
  return await Deno.readTextFile(path);
}

/**
 * Confirms every `optionalDependencies` entry in `manifestPath` exists on the
 * registry. Returns the missing ones; an empty list means the entry package is
 * safe to publish.
 */
export async function verifyPlatformPackages(
  manifestPath: string,
  registry = defaultRegistry(),
  fetchImpl: typeof fetch = fetch,
): Promise<MissingPlatform[]> {
  const manifest = JSON.parse(await readText(manifestPath)) as {
    name?: string;
    optionalDependencies?: Record<string, string>;
  };
  const deps = manifest.optionalDependencies ?? {};
  const entries = Object.entries(deps).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    throw new Error(
      `${manifestPath} has no optionalDependencies; run \`make npm-packages\` first`,
    );
  }

  const results = await Promise.all(
    entries.map(async ([name, version]) => {
      try {
        const published = await isPublished(
          registry,
          name,
          version,
          fetchImpl,
        );
        return published ? null : { name, version, reason: "not published" };
      } catch (error) {
        return {
          name,
          version,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  const missing = results.filter((result): result is MissingPlatform =>
    result !== null
  );
  if (missing.length === 0) {
    console.log(
      `Verified ${entries.length} platform package(s) for ${
        manifest.name ?? "entry package"
      }`,
    );
  }
  return missing;
}

if (import.meta.main) {
  const repoDir = resolve(dirname(fromFileUrl(import.meta.url)), "..");
  const manifestPath = resolve(
    Deno.args[0] ?? join(repoDir, "npm", "package.json"),
  );
  try {
    const missing = await verifyPlatformPackages(manifestPath);
    if (missing.length > 0) {
      console.error(
        `Missing platform packages required by ${manifestPath}:`,
      );
      for (const item of missing) {
        console.error(`  - ${item.name}@${item.version}: ${item.reason}`);
      }
      Deno.exit(1);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
