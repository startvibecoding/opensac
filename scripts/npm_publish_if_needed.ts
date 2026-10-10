// Publishes one npm package, skipping it when that version already exists.
//
// A release publishes the single platform-independent package, and often again
// for a pre-release tag. Re-running must not fail on a version that already
// landed, so the package is checked against the registry first.
//
// This script is a release tool: `make node-publish*` is the only intended
// entry point, and it publishes to the configured registry.

import { runtime } from "../src/platform/runtime.ts";
import { join, resolve } from "../src/compat/path.ts";

export interface NpmPackageJson {
  name: string;
  version: string;
}

export interface PublishOptions {
  /** Registry base URL, without a trailing slash. */
  registry: string;
  /** dist-tag to publish under, e.g. `latest` or `next`. */
  tag: string;
  /** Directory holding the package manifest. Defaults to the process cwd. */
  packageDir?: string;
  /** Extra arguments appended to `npm publish`. */
  extraArgs?: readonly string[];
  /** npm executable. */
  npm?: string;
}

/**
 * Registry URL for a package's packument (its version list).
 *
 * The check deliberately does not use the `/{package}/{version}` single-version
 * manifest route. That route exists on registry.npmjs.org but is not
 * implemented by GitHub Packages, which answers it with `405 Method Not
 * Allowed` -- so every `make npm-publish-github` aborted on the first platform
 * package. The packument route is the one both registries implement, and the
 * abbreviated form carries the `versions` map without the full metadata.
 */
export function packumentUrl(registry: string, name: string): string {
  const base = registry.replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(name)}`;
}

/**
 * Auth header for a registry read, when a token is available.
 *
 * The check used to send no credentials, but npm reads `NODE_AUTH_TOKEN` from
 * the environment and the workflow sets it (`secrets.GITHUB_TOKEN` for GitHub
 * Packages, `secrets.NPM_TOKEN` for npmjs). Without it a private package
 * answers 404 to hide its existence, which this script would misread as "not
 * published" and then republish over a live version.
 */
export function authHeader(
  env: { get(key: string): string | undefined } = runtime.env,
): Record<string, string> {
  const token = env.get("NODE_AUTH_TOKEN") ?? env.get("NPM_TOKEN") ?? "";
  return token === "" ? {} : { Authorization: `Bearer ${token}` };
}

/** Reads `name` and `version` from a package manifest. */
export function readPackageJson(packageDir: string): Promise<NpmPackageJson> {
  const manifestPath = join(packageDir, "package.json");
  return runtime.readTextFile(manifestPath).then((text) => {
    const parsed = JSON.parse(text) as Partial<NpmPackageJson>;
    if (!parsed.name || !parsed.version) {
      throw new Error(`${manifestPath} must contain a name and a version`);
    }
    return { name: parsed.name, version: parsed.version };
  });
}

/**
 * Whether `name@version` is already in the registry.
 *
 * A 404 means "not published"; any other status is a real failure and must not
 * be read as "publish it", or a registry hiccup would republish a live version.
 */
export async function isPublished(
  registry: string,
  name: string,
  version: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const response = await fetchImpl(packumentUrl(registry, name), {
    headers: {
      Accept: "application/vnd.npm.install-v1+json",
      ...authHeader(),
    },
  });
  if (response.status === 404) return false;
  if (response.status !== 200) {
    throw new Error(
      `Registry check for ${name}@${version} failed: HTTP ${response.status}`,
    );
  }
  // The packument lists every published version, so membership is the answer.
  // A body that is not the expected shape is a failure, not "not published".
  const body = (await response.json().catch(() => null)) as {
    versions?: Record<string, unknown>;
  } | null;
  const versions = body?.versions;
  if (versions === undefined || versions === null) {
    throw new Error(
      `Registry check for ${name}@${version} failed: packument has no versions`,
    );
  }
  return Object.hasOwn(versions, version);
}

export interface ParsedArgs extends Omit<PublishOptions, "npm"> {}

/**
 * Parses `[--tag <t>] [--registry <url>] [<package-dir>] [-- <npm args>]`.
 * A flag that is missing its value is an error rather than a silent default,
 * because publishing under the wrong tag or registry is not recoverable.
 */
export function parseArgs(
  argv: readonly string[],
  defaults: { registry: string; tag: string },
): ParsedArgs {
  const separator = argv.indexOf("--");
  const flags = separator === -1 ? argv : argv.slice(0, separator);
  const extraArgs = separator === -1 ? [] : argv.slice(separator + 1);

  let registry = defaults.registry;
  let tag = defaults.tag;
  let packageDir: string | undefined;

  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    if (flag === "--tag" || flag === "--registry") {
      const value = flags[i + 1];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      if (flag === "--tag") tag = value;
      else registry = value;
      i += 1;
      continue;
    }
    if (flag.startsWith("--")) throw new Error(`Unknown option: ${flag}`);
    if (packageDir !== undefined) {
      throw new Error(`Unexpected extra package directory: ${flag}`);
    }
    packageDir = flag;
  }

  return { registry, tag, packageDir, extraArgs };
}

export interface PublishResult {
  label: string;
  published: boolean;
  reason?: string;
}

/** Publishes the package unless its version is already on the registry. */
export async function publishIfNeeded(
  options: PublishOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishResult> {
  const packageDir = resolve(options.packageDir ?? runtime.cwd());
  const pkg = await readPackageJson(packageDir);
  const label = `${pkg.name}@${pkg.version}`;

  if (await isPublished(options.registry, pkg.name, pkg.version, fetchImpl)) {
    return { label, published: false, reason: "already published" };
  }

  const npm = options.npm ?? "npm";
  const args = [
    "publish",
    "--tag",
    options.tag,
    "--registry",
    options.registry,
    ...(options.extraArgs ?? []),
  ];
  console.log(`  Publishing ${label} with tag ${options.tag}...`);
  const status = await new runtime.Command(npm, {
    args,
    cwd: packageDir,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) {
    throw new Error(`npm publish failed for ${label}`);
  }
  return { label, published: true };
}

if (import.meta.main) {
  const parsed = parseArgs(runtime.args, {
    registry:
      runtime.env.get("NPM_REGISTRY") ??
      runtime.env.get("npm_config_registry") ??
      "https://registry.npmjs.org",
    tag: "latest",
  });
  try {
    const result = await publishIfNeeded({
      ...parsed,
      npm: runtime.env.get("NPM") ?? "npm",
    });
    if (!result.published) {
      console.log(`  Skipping ${result.label}: ${result.reason}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    runtime.exit(1);
  }
}
