// Resolves bundled runtime resources (the stats dashboard, the DeepSeek
// tokenizer data, and the Windows BusyBox binaries) relative to either the
// source tree or the published npm package layout.
//
// Under Deno the sources run in place, so a resource lives under `src/`. In the
// published esbuild bundle every module is inlined into `bin/opensac.js`, so
// `import.meta.url` is the bin file itself and resources live at the package
// root beside it. The two layouts are told apart by the package manifest:
// only the published package has one next to the entry, so an in-repo
// `deno.json` checkout can never be mistaken for it and resolve one level
// too high.
export function resourceUrl(relativePath: string): URL {
  const moduleDir = new URL(".", import.meta.url);
  try {
    Deno.statSync(new URL("package.json", moduleDir));
    return new URL(relativePath, moduleDir);
  } catch {
    return new URL(`../${relativePath}`, moduleDir);
  }
}
