import { runtime } from "../platform/runtime.ts";
import { type Settings } from "../config/settings.ts";

/** User-configurable settings for the shared Core process. */
export interface CoreSettings {
  host?: string;
  port?: number;
  auth?: boolean;
  passwords?: string[];
}

/** Fully resolved configuration used by the Core host and its clients. */
export interface ResolvedCoreConfig {
  host: string;
  port: number;
  auth: boolean;
  passwords: string[];
}

/** Returns a fresh Core configuration with the product defaults. */
export const defaultCoreConfig = (): ResolvedCoreConfig => ({
  host: "127.0.0.1",
  // Deliberately uncommon: 4096 collides with other tools. 27183 is unassigned
  // in IANA's service list and sits below the usual ephemeral range.
  port: 27183,
  auth: false,
  passwords: [],
});

/**
 * Resolves and validates the Core portion of the existing Settings value.
 * Missing fields inherit the product defaults; explicitly supplied values are
 * validated before they can be used by a Core host.
 */
export function resolveCoreConfig(settings: Settings): ResolvedCoreConfig {
  const defaults = defaultCoreConfig();
  const core = settings.core;

  if (
    core !== undefined &&
    (core === null || typeof core !== "object" || Array.isArray(core))
  ) {
    throw new Error("core configuration must be an object");
  }

  const host = core?.host === undefined ? defaults.host : core.host;
  if (typeof host !== "string") {
    throw new Error("core.host must be a string");
  }
  validateCoreHost(host);

  const port = core?.port === undefined ? defaults.port : core.port;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  ) {
    throw new Error("core.port must be an integer from 0 to 65535");
  }

  const auth = core?.auth === undefined ? defaults.auth : core.auth;
  if (typeof auth !== "boolean") {
    throw new Error("core.auth must be a boolean");
  }

  const passwords =
    core?.passwords === undefined ? defaults.passwords : core.passwords;
  if (!Array.isArray(passwords)) {
    throw new Error("core.passwords must be an array of strings");
  }
  for (let i = 0; i < passwords.length; i++) {
    if (typeof passwords[i] !== "string") {
      throw new Error("core.passwords must contain only strings");
    }
    validateCorePassword(passwords[i]);
  }
  if (auth && !passwords.some((password) => password.length > 0)) {
    throw new Error("core.auth=true requires at least one non-empty password");
  }

  return {
    host,
    port,
    auth,
    passwords: [...passwords],
  };
}

/** Rejects passwords that cannot survive HTTP Bearer field normalization. */
export function validateCorePassword(password: string): void {
  if (password !== password.trim()) {
    throw new Error(
      "core passwords must not contain leading or trailing whitespace",
    );
  }
  if (
    [...password].some((character) => {
      const code = character.charCodeAt(0);
      return code === 0 || code === 10 || code === 13;
    })
  ) {
    throw new Error("core passwords must not contain control characters");
  }
}

/** Rejects invalid listener host values before they reach runtime.serve. */
export function validateCoreHost(host: string): void {
  const normalized = host.trim();
  if (
    host !== normalized ||
    normalized === "" ||
    /[\s/?#@]/.test(normalized) ||
    normalized.includes("://")
  ) {
    throw new Error("core.host must be a valid host or IP address");
  }
}

/** Validates a resolved object supplied directly by an embedding caller. */
export function assertResolvedCoreConfig(config: ResolvedCoreConfig): void {
  if (config === null || typeof config !== "object") {
    throw new TypeError("Core configuration is required");
  }
  validateCoreHost(config.host);
  if (
    !Number.isInteger(config.port) ||
    config.port < 0 ||
    config.port > 65535
  ) {
    throw new Error("core.port must be an integer from 0 to 65535");
  }
  if (typeof config.auth !== "boolean") {
    throw new Error("core.auth must be a boolean");
  }
  if (!Array.isArray(config.passwords)) {
    throw new Error("core.passwords must be an array of strings");
  }
  for (const password of config.passwords) {
    if (typeof password !== "string") {
      throw new Error("core.passwords must contain only strings");
    }
    validateCorePassword(password);
  }
  if (
    config.auth &&
    !config.passwords.some((password) => password.length > 0)
  ) {
    throw new Error("core.auth=true requires at least one non-empty password");
  }
}
