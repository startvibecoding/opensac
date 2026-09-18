// Ported from internal/ua/ua.go
//
// Package ua provides User-Agent string generation for vibecoding.

/** Set at build time. */
export let version = "dev";

/** Sets the build version (mirrors assigning the Go package var in tests). */
export function setVersion(value: string): void {
  version = value;
}

/** The default User-Agent prefix. */
export const DEFAULT_USER_AGENT = "Vibecoding Client";

/**
 * Returns the User-Agent string for vibecoding. Can be overridden by the
 * `VIBECODING_USER_AGENT` environment variable.
 */
export function userAgent(): string {
  const override = Deno.env.get("VIBECODING_USER_AGENT");
  if (override) return override;

  return `${DEFAULT_USER_AGENT}/${version} (${Deno.build.os}; ${Deno.build.arch}; deno ${Deno.version.deno})`;
}

/** Returns the User-Agent string for provider API calls. */
export function providerUserAgent(): string {
  return userAgent();
}
