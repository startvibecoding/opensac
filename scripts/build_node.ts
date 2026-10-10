// Builds the platform-independent npm package (a single ESM bundle) from the
// Deno/TypeScript sources with esbuild. Replaces the old dnt pipeline; the
// repository now has no `jsr:` imports, and the published artifact is plain JS
// that runs on Node (>= 22.5, for `node:sqlite`).
//
// esbuild resolves the project's imports natively now that the sources no
// longer use `jsr:` specifiers: `node:` builtins and npm packages are left
// external (declared as dependencies), and the project-owned `@opensac/*`
// modules are aliased to their local files. `Deno` at runtime comes from
// `@deno/shim-deno` plus `src/platform/node_compat.ts`, both bundled/declared.
//
// Run: `deno task build:node` (output: dist/node). This does NOT publish.

import * as esbuild from "npm:esbuild@^0.28.2";
import { dirname, fromFileUrl, join, resolve } from "../src/compat/path.ts";
import { resolveBuildVersion, toPackageVersion } from "./version.ts";
import { isMainModule } from "../src/platform/node_compat.ts";

/**
 * npm package name of the platform-independent package. The bare `opensac` is
 * rejected by npm as too similar to `openai`, so the name stays
 * `opensac-installer`; the installed command is still `opensac` (see `bin`).
 */
export const NODE_PACKAGE_NAME = "opensac-installer";

/** Prefixes a package name with an npm scope (`@owner`), or returns it as-is. */
export function scopedPackageName(name: string, scope?: string): string {
  const trimmed = (scope ?? "").trim();
  if (trimmed === "") return name;
  const withAt = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
  return `${withAt}/${name}`;
}

/** npm packages kept external (installed by the consumer, not bundled). */
const EXTERNAL = [
  "ink",
  "react",
  "react-dom",
  "imagescript",
  "@jsquash/webp",
  "ws",
  "undici",
  "@deno/shim-deno",
];

/** Runtime resources copied beside the bundle; paths are relative to `src/`. */
const ASSETS: readonly string[] = [
  "src/stats/dashboard.html",
  "src/stats/opensac.png",
  "src/stats/opensac-small.ico",
  "src/context/tokenizerdata",
  "src/platform/busybox_assets",
];

const REPO_DIR = resolve(fromFileUrl(new URL("..", import.meta.url)));
const OUT_DIR = join(REPO_DIR, "dist", "node");
const OUT_BIN = join(OUT_DIR, "bin", "opensac.js");

/** Local files the `@opensac/*` import-map aliases resolve to. */
export function aliasMap(repoDir = REPO_DIR): Record<string, string> {
  return {
    "@opensac/path": join(repoDir, "src/compat/path.ts"),
    "@opensac/path/posix": join(repoDir, "src/compat/path_posix.ts"),
    "@opensac/assert": join(repoDir, "src/compat/assert.ts"),
    "@opensac/encoding/base64": join(repoDir, "src/compat/encoding.ts"),
    "@opensac/encoding/base64url": join(repoDir, "src/compat/encoding.ts"),
  };
}

/** Metadata for the generated package manifest. */
export function nodePackageJson(version: string, name = NODE_PACKAGE_NAME) {
  return {
    name,
    version,
    description:
      "AI coding assistant for the terminal. One package, many providers.",
    type: "module",
    license: "MIT",
    repository: {
      type: "git",
      url: "https://gitee.com/startvibecoding/opensac.git",
    },
    keywords: ["ai", "coding", "assistant", "terminal", "cli", "agent", "llm"],
    engines: { node: ">=22.5" },
    bin: { opensac: "bin/opensac.js" },
    files: ["bin/", "stats/", "context/", "platform/", "README.md"],
    dependencies: {
      "@deno/shim-deno": "~0.18.0",
      "@jsquash/webp": "^1",
      imagescript: "^1",
      ink: "^5",
      react: "^18",
      undici: "^6",
      ws: "^8",
    },
  };
}

async function copyResource(src: string, dest: string): Promise<void> {
  const info = await Deno.stat(src).catch(() => null);
  if (info === null) return;
  if (info.isDirectory) {
    await Deno.mkdir(dest, { recursive: true });
    for await (const entry of Deno.readDir(src)) {
      await copyResource(join(src, entry.name), join(dest, entry.name));
    }
  } else {
    await Deno.mkdir(dirname(dest), { recursive: true });
    await Deno.copyFile(src, dest);
  }
}

/** Copies `ASSETS` to the package root (stripping the leading `src/`). */
async function copyAssets(): Promise<void> {
  for (const rel of ASSETS) {
    const relativeToRoot = rel.startsWith("src/")
      ? rel.slice("src/".length)
      : rel;
    await copyResource(join(REPO_DIR, rel), join(OUT_DIR, relativeToRoot));
  }
}

async function main(): Promise<void> {
  let scope = "";
  for (const arg of Deno.args) {
    if (arg.startsWith("--scope=")) scope = arg.slice("--scope=".length);
  }
  const version = toPackageVersion(await resolveBuildVersion(REPO_DIR));
  if (version === "") {
    console.error(
      "Cannot determine a package version: no `v*` git tag and no deno.json version",
    );
    Deno.exit(1);
  }
  const name = scopedPackageName(NODE_PACKAGE_NAME, scope);
  console.error(`Building ${name}@${version} (Node/npm, esbuild) ...`);

  await Deno.remove(OUT_DIR, { recursive: true }).catch(() => {});
  await Deno.mkdir(join(OUT_DIR, "bin"), { recursive: true });

  await esbuild.build({
    entryPoints: [join(REPO_DIR, "src/main.ts")],
    outfile: OUT_BIN,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
    alias: aliasMap(REPO_DIR),
    external: EXTERNAL,
    // The banner embeds the release version as the `OPENSAC_BUILD_VERSION`
    // default, the same value the old binary build baked in. The bundle's main
    // guard uses `isMainModule(import.meta.url)`, which needs no define.
    define: {},
    banner: {
      js: `#!/usr/bin/env node\nprocess.env.OPENSAC_BUILD_VERSION ??= ${
        JSON.stringify(version)
      };`,
    },
    legalComments: "none",
    logLevel: "info",
  });

  await Deno.chmod(OUT_BIN, 0o755);
  await copyAssets();
  await Deno.copyFile(join(REPO_DIR, "README.md"), join(OUT_DIR, "README.md"));
  await Deno.writeTextFile(
    join(OUT_DIR, "package.json"),
    `${JSON.stringify(nodePackageJson(version, name), null, 2)}\n`,
  );
  console.error(`Wrote ${OUT_DIR}`);
}

if (isMainModule(import.meta.url)) await main();
