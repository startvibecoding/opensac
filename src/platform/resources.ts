// Resolves bundled runtime resources (the stats dashboard, the DeepSeek
// tokenizer data, and the Windows BusyBox binaries) relative to the module
// directory instead of a hard-coded `./name` next to each caller.
//
// Under Deno the sources run in place, so a resource lives under `src/`. In the
// published esbuild bundle the modules are inlined into one file under
// `bin/`, and `scripts/build_node.ts` copies the resources to the package root,
// so `../` from the bundle reaches them. `resourceUrl` accepts a path relative
// to `src/` and resolves correctly in both layouts.
export function resourceUrl(relativePath: string): URL {
  return new URL(`../${relativePath}`, import.meta.url);
}
