//
// Go embeds the builtin expert bundles (software-company, frontend-developer)
// with go:embed. Deno has no equivalent embed API, so the bundle files are
// inlined into `builtin_content.ts` (generated from src/expert/builtin) and
// served through an in-memory ExpertFS. Regenerate it whenever the builtin
// bundles change.

import { builtinFiles } from "./builtin_content.ts";
import { createMemoryFS, type ExpertFS } from "./fs.ts";

/** Builds an in-memory ExpertFS over the embedded builtin expert bundles. */
export function createBuiltinFS(): ExpertFS {
  return createMemoryFS(builtinFiles);
}

/** The built-in expert bundle filesystem (seed packages compiled into every runtime). */
export const builtinFS: ExpertFS = createBuiltinFS();
