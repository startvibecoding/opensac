import { type ResolvedCoreConfig } from "./config.ts";

/** The HTTP header carrying the Core password. */
export const CORE_AUTH_HEADER = "Authorization" as const;

/**
 * The HTTP header identifying one Core client across RPC and event sockets.
 *
 * It is owned here rather than in `client.ts` because both the client that sets
 * it and the server that reads it already depend on this module, and the server
 * must not import the client (the client already imports the server).
 */
export const CORE_CLIENT_ID_HEADER = "x-opensac-client-id" as const;

/** Extracts a password from the Core Bearer authentication header. */
export function extractCorePassword(request: Request): string {
  const value = request.headers.get(CORE_AUTH_HEADER)?.trim() ?? "";
  if (value === "") return "";

  // The authentication scheme is case-insensitive. Keep the value itself
  // opaque: a password is never interpreted as a URL or a protocol value.
  const separator = value.search(/[\t ]/);
  if (separator < 0) return "";
  const scheme = value.slice(0, separator);
  if (scheme.toLowerCase() !== "bearer") return "";

  const password = value.slice(separator).trim();
  return password;
}

/**
 * Authenticates a request against the resolved Core configuration.
 *
 * Passwords are accepted only from the Authorization header. In particular,
 * query parameters and request/JSON-RPC parameters are never consulted.
 */
export class CoreAuth {
  static authenticate(
    request: Request,
    config: ResolvedCoreConfig,
  ): boolean {
    if (!config.auth) return true;

    const password = extractCorePassword(request);
    if (password === "") return false;

    // Compare every configured value and combine the results without an
    // early return. This avoids making the number or position of a matching
    // password observable through an application-level short circuit.
    const encoder = new TextEncoder();
    const candidate = encoder.encode(password);
    let matched = 0;
    for (const configured of config.passwords) {
      if (
        typeof configured !== "string" ||
        configured === "" ||
        configured !== configured.trim()
      ) {
        continue;
      }
      const equal = constantTimeEqual(encoder.encode(configured), candidate);
      matched |= equal ? 1 : 0;
    }
    return matched === 1;
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  // Include the length difference in the accumulator and visit the longer
  // input in full. This is a Web-API-only comparison suitable for a local
  // password boundary; it intentionally does not log either value.
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
