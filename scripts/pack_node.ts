// Packs the generated platform-independent Node package (dist/node) into a
// tarball under dist/npm/ for inspection. Publishes nothing; the published
// artifact is the same directory, so `npm publish dist/node` matches what this
// packs.
//
// Run `deno task build:node` first. Run: `deno task pack:node`.

import { dirname, fromFileUrl, join, resolve } from "@opensac/path";

const repoDir = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const nodeDir = join(repoDir, "dist", "node");
const outDir = join(repoDir, "dist", "npm");

try {
  const info = await Deno.stat(join(nodeDir, "package.json"));
  if (!info.isFile) throw new Error("not a file");
} catch {
  console.error(
    "dist/node/package.json is missing. Run `deno task build:node` first.",
  );
  Deno.exit(1);
}

await Deno.mkdir(outDir, { recursive: true });
console.error(`Packing ${nodeDir} into ${outDir} ...`);
const status = await new Deno.Command("npm", {
  args: ["pack", "--pack-destination", outDir],
  cwd: nodeDir,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn().status;
Deno.exit(status.code);
