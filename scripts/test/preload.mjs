// Preload hook for the Node test runner (`node --test`) and the CLI entry.
//
// Two things must happen before any application module loads:
//   1. The Node runtime modules are loaded by `src/platform/runtime.ts`, which
//      also installs the Web `Worker` and fetch globals. Importing it here keeps
//      every child process the test runner spawns consistent.
//   2. JSX-bearing `.tsx` sources (the Ink TUI) are transpiled, since Node has
//      no built-in JSX support. Plain `.ts` needs no hook: Node strips erasable
//      types itself.
//
// Registering this file with `--import` guarantees both in every child process
// the test runner spawns and in `npm start`.

import { register } from "node:module";
import { fileURLToPath } from "node:url";

register(
  new URL("../loader/ts_loader.mjs", import.meta.url),
  fileURLToPath(new URL("../../", import.meta.url)),
);

await import(new URL("../../src/platform/runtime.ts", import.meta.url));
