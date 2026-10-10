// Regenerates the inlined worker-source modules from their `.js` sources:
//
//   src/util/regex_worker.js    -> src/util/regex_worker_source.ts
//   src/workflow/js_worker.js   -> src/workflow/js_worker_source.ts
//
// esbuild and Node cannot bundle `import ... with { type: "text" }`.
// Inlining the source as a plain string module keeps one code path that the
// source run and the esbuild bundle share. Run: `npm run gen:worker-sources`.

const PAIRS: ReadonlyArray<readonly [string, string, string]> = [
  [
    "src/util/regex_worker.js",
    "src/util/regex_worker_source.ts",
    "regexWorkerSource",
  ],
  [
    "src/workflow/js_worker.js",
    "src/workflow/js_worker_source.ts",
    "jsWorkerSource",
  ],
];

/** Renders the generated module text for one worker pair. */
export function workerSourceModule(
  js: string,
  baseName: string,
  exportName: string,
): string {
  const header =
    `// Generated from ${baseName} (embedded worker source). Do not edit by hand.\n` +
    "//\n" +
    '// esbuild/Node cannot bundle `import ... with { type: "text" }`, so\n' +
    "// the worker source is inlined as a string here. The source run and the\n" +
    "// esbuild bundle share it. Regenerate with: npm run gen:worker-sources\n\n";
  return header + `export const ${exportName} = ${JSON.stringify(js)};\n`;
}

import { runtime } from "../src/platform/runtime.ts";
if (import.meta.main) {
  const repoDir = new URL("..", import.meta.url);
  for (const [src, out, name] of PAIRS) {
    const js = await runtime.readTextFile(new URL(src, repoDir));
    const base = src.split("/").pop()!;
    await runtime.writeTextFile(
      new URL(out, repoDir),
      workerSourceModule(js, base, name),
    );
    console.error(`wrote ${out} (${js.length} chars)`);
  }
}
