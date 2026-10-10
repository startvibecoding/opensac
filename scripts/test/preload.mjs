// Preload hook for the Node test runner (`node --test`) and the CLI entry.
//
// Two things must happen before any application module loads:
//   1. The `Deno.*` global vocabulary is installed by
//      `src/platform/node_compat.ts`. Application entry points import it
//      explicitly; a test file must not, because a top-level statement could
//      touch the filesystem before the side-effect import is evaluated.
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

await import(new URL("../../src/platform/node_compat.ts", import.meta.url));
