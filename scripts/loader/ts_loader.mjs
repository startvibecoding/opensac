// ESM loader hooks: compile JSX-bearing TypeScript for the Node toolchain.
//
// Node 22 strips erasable types from `.ts` natively, but it has no JSX support,
// and the Ink TUI is written in `.tsx`. This module registers a `load` hook that
// hands `.tsx` source to esbuild (classic `React.createElement` transform, which
// is what Ink expects) and returns transpiled ESM.
//
// It is registered by `scripts/test/preload.mjs`, so every test child process and
// the CLI entry see the same runtime surface. A published release pre-bundles
// everything with esbuild (`scripts/build_node.ts`), so this hook is a
// development-only convenience and never ships inside the bundle.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

/** Source maps let `node --inspect` map back to `.tsx` line numbers. */
const sourcemap = process.env.OPENSAC_LOADER_SOURCEMAP === "1";

export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:") || !/\.tsx$/.test(url)) {
    return nextLoad(url, context);
  }
  const path = fileURLToPath(url);
  const source = await readFile(path, "utf8");
  const result = await transform(source, {
    loader: "tsx",
    format: "esm",
    target: "node22",
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
    sourcefile: path,
    sourcemap: sourcemap ? "inline" : undefined,
  });
  return { format: "module", source: result.code, shortCircuit: true };
}
