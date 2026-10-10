// Packs the generated platform-independent Node package (dist/node) into a
// tarball under dist/npm/ for inspection. Publishes nothing; the published
// artifact is the same directory, so `npm publish dist/node` matches what this
// packs.
//
// Run `npm run build:node` first. Run: `npm run pack:node`.

import { runtime } from "../src/platform/runtime.ts";
import { dirname, fromFileUrl, join, resolve } from "../src/compat/path.ts";

const repoDir = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const nodeDir = join(repoDir, "dist", "node");
const outDir = join(repoDir, "dist", "npm");

try {
  const info = await runtime.stat(join(nodeDir, "package.json"));
  if (!info.isFile) throw new Error("not a file");
} catch {
  console.error(
    "dist/node/package.json is missing. Run `npm run build:node` first.",
  );
  runtime.exit(1);
}

await runtime.mkdir(outDir, { recursive: true });
console.error(`Packing ${nodeDir} into ${outDir} ...`);
const status = await new runtime.Command("npm", {
  args: ["pack", "--pack-destination", outDir],
  cwd: nodeDir,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn().status;
runtime.exit(status.code);
