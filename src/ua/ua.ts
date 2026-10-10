//
// Package ua provides User-Agent string generation for vibecoding.

/** Set at build time. */
import { runtime } from "../platform/runtime.ts";
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
  const override = runtime.env.get("VIBECODING_USER_AGENT");
  if (override) return override;

  return `${DEFAULT_USER_AGENT}/${version} (${runtime.build.os}; ${runtime.build.arch}; node ${runtime.version.node})`;
}

/** Returns the User-Agent string for provider API calls. */
export function providerUserAgent(): string {
  return userAgent();
}
