//
// Go `go:embed` maps to runtime reads of the same files next to this module;
// `deno compile --include src/stats/dashboard.html` (etc.) embeds them so the
// same path resolves in dev and in the binary.

let cachedHTML: string | null = null;
let cachedICO: Uint8Array | null = null;
let cachedPNG: Uint8Array | null = null;

/** The embedded dashboard HTML. */
export function dashboardHTML(): string {
  if (cachedHTML === null) {
    cachedHTML = Deno.readTextFileSync(
      new URL("./dashboard.html", import.meta.url),
    );
  }
  return cachedHTML;
}

/** The embedded small favicon (ICO). */
export function opensacSmallICO(): Uint8Array {
  if (cachedICO === null) {
    cachedICO = Deno.readFileSync(
      new URL("./opensac-small.ico", import.meta.url),
    );
  }
  return cachedICO;
}

/** The embedded dashboard logo (PNG). */
export function opensacPNG(): Uint8Array {
  if (cachedPNG === null) {
    cachedPNG = Deno.readFileSync(new URL("./opensac.png", import.meta.url));
  }
  return cachedPNG;
}
