//
// Package version contains the product version shared by every entry point.
// Release builds replace `version` through a build-time constant; source builds
// use embedded VCS information when available and always expose a non-empty
// value.

/** Replaced in release builds. Empty is intentional. */
export let version = "";

/** Sets the build version (mirrors assigning the Go package var in tests). */
export function setVersion(value: string): void {
  version = value;
}

export function current(): string {
  const value = version.trim();
  if (value !== "") return value;

  const buildVersion = Deno.env.get("OPENSAC_BUILD_VERSION")?.trim() ?? "";
  if (buildVersion !== "" && buildVersion !== "(devel)") return buildVersion;

  const revision = Deno.env.get("OPENSAC_VCS_REVISION")?.trim() ?? "";
  const modified = Deno.env.get("OPENSAC_VCS_MODIFIED")?.trim() ?? "";
  if (revision !== "") {
    return modified === "true" ? `${revision}-dirty` : revision;
  }
  return "unknown";
}
