// Resolves bundled runtime resources (the stats dashboard, the DeepSeek
// tokenizer data, and the Windows BusyBox binaries) relative to either the
// source tree or the published npm package layout.
//
// Under Deno the sources run in place, so a resource lives under `src/`. In the
// published esbuild bundle the modules are inlined into `bin/opensac.js`, while
// `scripts/build_node.ts` copies resources to the package root. The latter is
// recognized by its sibling manifest so installed resources resolve beside
// `dist/node/` rather than beneath an absent `dist/src/` directory.
export function resourceUrl(relativePath: string): URL {
  const moduleDir = new URL(".", import.meta.url);
  try {
    Deno.statSync(new URL("../package.json", moduleDir));
    return new URL(`../${relativePath}`, moduleDir);
  } catch {
    return new URL(`../../${relativePath}`, moduleDir);
  }
}
