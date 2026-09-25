import type { ResolvedCoreConfig } from "./config.ts";
import type { CoreRegistration } from "./registry.ts";

/** Returns a normalized host without URL brackets. */
export function normalizeCoreHost(value: string): string {
  let host = value.trim();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  return host.toLowerCase();
}

/** True for an IPv4 or IPv6 wildcard bind address. */
export function isWildcardCoreHost(value: string): boolean {
  const host = normalizeCoreHost(value);
  return host === "0.0.0.0" || isIPv6Wildcard(host);
}

function isIPv6Wildcard(host: string): boolean {
  return host === "::" || /^0(?::0)*$/.test(host);
}

/** True for a local-only address or hostname. */
export function isLoopbackCoreHost(value: string): boolean {
  const host = normalizeCoreHost(value);
  return isLocalhost(host) ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host);
}

function isLocalhost(value: string): boolean {
  const host = normalizeCoreHost(value);
  return host === "localhost" || host.endsWith(".localhost");
}

/** Formats a host for use in an HTTP URL. */
export function formatCoreHostForUrl(value: string): string {
  const host = normalizeCoreHost(value);
  return host.includes(":") ? `[${host}]` : host;
}

/**
 * Chooses a loopback address for a local client of a wildcard listener.
 * IPv6 and IPv4 wildcard binds deliberately do not cross-connect.
 */
export function localCoreConnectHost(bindHost: string): string {
  return isIPv6Wildcard(normalizeCoreHost(bindHost)) ? "::1" : "127.0.0.1";
}

/** Returns the concrete host a registration should advertise to local clients. */
export function registrationConnectHost(bindHost: string): string {
  const host = normalizeCoreHost(bindHost);
  return isWildcardCoreHost(host) ? localCoreConnectHost(host) : host;
}

/**
 * Chooses the host a client should connect to. A non-wildcard client setting
 * is an explicit network endpoint and therefore wins over a wildcard bind.
 * This lets a remote client use its configured address while local clients
 * use the corresponding loopback address.
 */
export function connectHostForRegistration(
  registration: CoreRegistration,
  config: ResolvedCoreConfig,
): string {
  const bind = normalizeCoreHost(registration.host);
  const configured = normalizeCoreHost(config.host);
  const advertised = registration.connectHost?.trim();
  const hasAdvertisedHost = advertised !== undefined &&
    advertised !== "" &&
    !isWildcardCoreHost(advertised);

  if (configured !== "" && !isWildcardCoreHost(configured)) {
    if (isWildcardCoreHost(bind)) {
      // An explicit client address is a connect preference, not a request to
      // reinterpret the listener's wildcard bind. Keep IPv4 and IPv6
      // listeners on their own reachable loopback family when necessary.
      if (isLocalhost(configured)) return localCoreConnectHost(bind);
      if (isLoopbackCoreHost(configured)) {
        if (isIPv6Wildcard(bind) && !isIPv6Host(configured)) return "::1";
        if (!isIPv6Wildcard(bind) && isIPv6Host(configured)) {
          return "127.0.0.1";
        }
      }
      if (hostFamily(bind) !== hostFamily(configured)) {
        return localCoreConnectHost(bind);
      }
      return configured;
    }
    if (hasAdvertisedHost) return normalizeCoreHost(advertised!);
    return configured;
  }

  if (hasAdvertisedHost) return normalizeCoreHost(advertised!);
  if (!isWildcardCoreHost(bind)) return bind;
  return localCoreConnectHost(bind);
}

/** Returns the selected port, enforcing an explicitly configured fixed port. */
export function connectPortForRegistration(
  registration: CoreRegistration,
  config: ResolvedCoreConfig,
): number {
  if (registration.port <= 0) {
    throw new TypeError("registered Core port must be greater than zero");
  }
  if (config.port !== 0 && registration.port !== config.port) {
    throw new TypeError(
      `registered Core port ${registration.port} does not match configured fixed port ${config.port}`,
    );
  }
  return registration.port;
}

/** Builds a validated local/client endpoint URL for a registration. */
export function registrationUrl(
  registration: CoreRegistration,
  config: ResolvedCoreConfig,
): string {
  const host = connectHostForRegistration(registration, config);
  const port = connectPortForRegistration(registration, config);
  if (host === "" || /[/?#@\s]/.test(host) || host.includes("://")) {
    throw new TypeError("registered Core host is invalid");
  }
  const url = new URL(
    `http://${formatCoreHostForUrl(host)}:${port}/`,
  );
  if (url.username !== "" || url.password !== "" || url.pathname !== "/") {
    throw new TypeError("registered Core endpoint is invalid");
  }
  return url.toString().replace(/\/$/, "");
}

/** True when a registration is compatible with an explicitly configured bind. */
export function registrationMatchesConfiguredEndpoint(
  registration: CoreRegistration,
  config: ResolvedCoreConfig,
): boolean {
  if (config.port !== 0 && registration.port !== config.port) return false;
  const bind = normalizeCoreHost(registration.host);
  const configured = normalizeCoreHost(config.host);
  const bindWildcard = isWildcardCoreHost(bind);
  const configuredWildcard = isWildcardCoreHost(configured);

  if (bind === configured) return true;

  // A configured wildcard is a request to expose the Core on that address
  // family, not merely a client-side loopback hint. Reusing a Core that binds
  // only one concrete address would silently leave the requested interfaces
  // unbound, so reject that direction even when the port matches.
  if (configuredWildcard && !bindWildcard) return false;

  if (bindWildcard && configuredWildcard) {
    return hostFamily(bind) === hostFamily(configured);
  }

  if (bindWildcard) {
    // A wildcard listener can satisfy a concrete request only within the same
    // address family. `localhost` is family-neutral and follows the bind.
    if (isLocalhost(configured)) return true;
    return hostFamily(bind) === hostFamily(configured);
  }

  if (isLoopbackCoreHost(bind) && isLoopbackCoreHost(configured)) {
    return (isIPv6Host(bind) && isIPv6Host(configured)) ||
      (!isIPv6Host(bind) && !isIPv6Host(configured));
  }
  return false;
}

function isIPv6Host(host: string): boolean {
  return normalizeCoreHost(host).includes(":");
}

function hostFamily(host: string): 4 | 6 | undefined {
  const normalized = normalizeCoreHost(host);
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return undefined;
  }
  return normalized.includes(":") ? 6 : 4;
}
