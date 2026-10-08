//
// Go `go:embed` maps to runtime reads of the same files under `src/`;
// `scripts/build_node.ts` copies them beside the bundle so the same path
// resolves in dev and in the published package.

import { resourceUrl } from "../platform/resources.ts";

let cachedHTML: string | null = null;
let cachedICO: Uint8Array | null = null;
let cachedPNG: Uint8Array | null = null;

/** The embedded dashboard HTML. */
export function dashboardHTML(): string {
  if (cachedHTML === null) {
    cachedHTML = Deno.readTextFileSync(
      resourceUrl("stats/dashboard.html"),
    );
  }
  return cachedHTML;
}

/** The embedded small favicon (ICO). */
export function opensacSmallICO(): Uint8Array {
  if (cachedICO === null) {
    cachedICO = Deno.readFileSync(
      resourceUrl("stats/opensac-small.ico"),
    );
  }
  return cachedICO;
}

/** The embedded dashboard logo (PNG). */
export function opensacPNG(): Uint8Array {
  if (cachedPNG === null) {
    cachedPNG = Deno.readFileSync(resourceUrl("stats/opensac.png"));
  }
  return cachedPNG;
}
