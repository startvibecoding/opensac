// Ported from internal/sandbox/sandbox.go
//
// The Go original wraps commands as `*exec.Cmd`; Deno has no such type, so a
// `CommandSpec` descriptor is returned instead and the caller spawns it.

/** Defines the sandbox restriction level. */
export enum Level {
  /** Required sandbox: read-only project. */
  Strict = 0,
  /** Best-effort sandbox: read-write project. */
  Standard = 1,
  /** Direct execution. */
  None = 2,
}

/** Returns the string representation of a Level. */
export function levelString(level: Level): string {
  switch (level) {
    case Level.Strict:
      return "strict";
    case Level.Standard:
      return "standard";
    case Level.None:
      return "none";
    default:
      return "unknown";
  }
}

/** Parses a string into a Level. */
export function parseLevel(s: string): Level {
  switch (s) {
    case "strict":
      return Level.Strict;
    case "standard":
      return Level.Standard;
    case "none":
      return Level.None;
    default:
      throw new Error(`unknown sandbox level: ${s}`);
  }
}

/** A description of a command to execute, replacing Go's `*exec.Cmd`. */
export interface CommandSpec {
  program: string;
  args: string[];
  cwd?: string;
  /** Environment as "KEY=VALUE" entries; undefined means inherit the parent. */
  env?: string[];
  /** Removes any temporary resources created while building the command. */
  cleanup?: () => void;
}

/** Contains options for executing a command in a sandbox. */
export interface ExecOpts {
  /** Additional writable paths. */
  writablePaths?: string[];
  /** Additional read-only paths (for standard mode). */
  readOnlyPaths?: string[];
  /** Deprecated: sandbox preserves host network access. */
  networkAccess?: boolean;
  /** Additional environment variables. */
  envVars?: Record<string, string>;
  /** Working directory. */
  workDir?: string;
  /** Command timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * Controls sandbox backends. It deliberately uses primitive values so callers
 * from every runtime can share the same policy without importing config.
 */
export interface Options {
  bwrapPath?: string;
  /** Deprecated: sandbox always preserves host network access. */
  allowNetwork?: boolean;
  allowedRead?: string[];
  allowedWrite?: string[];
  deniedPaths?: string[];
  passEnv?: string[];
  tmpSize?: string;
  protectGit?: boolean;
}

/** The interface for sandbox implementations. */
export interface Sandbox {
  /** Wraps a command for execution inside the sandbox. */
  wrapCommand(
    signal: AbortSignal | undefined,
    shell: string,
    cmd: string,
    opts: ExecOpts,
  ): CommandSpec;
  /** Checks if the sandbox can be used on this system. */
  isAvailable(): boolean;
  /** Returns the sandbox implementation name. */
  name(): string;
  /** Returns the sandbox level. */
  level(): Level;
}

/** Implemented by backends that can temporarily remove the Git deny rule. */
export interface GitAccessSandbox extends Sandbox {
  wrapCommandWithGitAccess(
    signal: AbortSignal | undefined,
    shell: string,
    cmd: string,
    opts: ExecOpts,
  ): CommandSpec;
}

export interface CommandCleanupProvider {
  cleanupCommand(spec: CommandSpec): void;
}

export interface AvailabilityErrorProvider {
  availabilityError(): Error | undefined;
}

/** Manages sandbox selection based on mode and availability. */
export class Manager {
  #sandboxes = new Map<Level, Sandbox>();
  #active: Sandbox | undefined;
  #initErr: Error | undefined;
  #fallbackErr: Error | undefined;

  constructor(projectDir: string, opts: Options = {}) {
    let effective = opts;
    let normalizeErr: Error | undefined;
    try {
      effective = normalizeOptions(projectDir, opts);
    } catch (err) {
      normalizeErr = err instanceof Error ? err : new Error(String(err));
    }
    this.#initErr = normalizeErr;

    this.#sandboxes.set(Level.None, newNoneSandbox());
    this.#sandboxes.set(
      Level.Standard,
      newPlatformSandboxWithOptions(projectDir, Level.Standard, effective),
    );
    this.#sandboxes.set(
      Level.Strict,
      newPlatformSandboxWithOptions(projectDir, Level.Strict, effective),
    );
  }

  /**
   * Activates the requested execution policy. Standard sandboxing is
   * best-effort and falls back to direct execution when the platform backend is
   * unavailable. Strict sandboxing is required and never silently degrades.
   */
  setLevel(level: Level): void {
    this.#fallbackErr = undefined;
    if (this.#initErr && level !== Level.None) {
      if (level === Level.Standard) {
        this.#active = this.#sandboxes.get(Level.None);
        this.#fallbackErr = new Error(
          `invalid sandbox policy: ${this.#initErr.message}`,
        );
        return;
      }
      throw new Error(`invalid sandbox policy: ${this.#initErr.message}`);
    }
    const sb = this.#sandboxes.get(level);
    if (!sb) throw new Error(`no sandbox for level ${levelString(level)}`);
    if (!sb.isAvailable()) {
      let reason = new Error(`sandbox ${levelString(level)} not available`);
      const provider = sb as unknown as AvailabilityErrorProvider;
      if (typeof provider.availabilityError === "function") {
        const diag = provider.availabilityError();
        if (diag) {
          reason = new Error(
            `sandbox ${levelString(level)} not available: ${diag.message}`,
          );
        }
      }
      if (level === Level.Standard) {
        this.#active = this.#sandboxes.get(Level.None);
        this.#fallbackErr = reason;
        return;
      }
      throw reason;
    }
    this.#active = sb;
  }

  /** Reports why a best-effort sandbox fell back to direct execution. */
  fallbackError(): Error | undefined {
    return this.#fallbackErr;
  }

  /** Returns the active sandbox. */
  getActive(): Sandbox {
    return this.#active ?? this.#sandboxes.get(Level.None)!;
  }

  /** Returns the sandbox for a specific level, checking availability. */
  getForLevel(level: Level): Sandbox {
    if (this.#initErr && level !== Level.None) {
      throw new Error(`invalid sandbox policy: ${this.#initErr.message}`);
    }
    const sb = this.#sandboxes.get(level);
    if (!sb) throw new Error(`no sandbox for level ${levelString(level)}`);
    if (!sb.isAvailable()) {
      throw new Error(`sandbox ${levelString(level)} not available`);
    }
    return sb;
  }
}

/** Creates a manager with the default sandbox policy. */
export function newManager(projectDir: string): Manager {
  return new Manager(projectDir, {});
}

/** Creates a manager using the supplied sandbox policy. */
export function newManagerWithOptions(
  projectDir: string,
  opts: Options,
): Manager {
  return new Manager(projectDir, opts);
}

/** Returns a human-readable description of the sandbox state. */
export function formatSandboxInfo(s: Sandbox | undefined): string {
  if (!s || s.level() === Level.None) return "🔓 No sandbox";

  const available = s.isAvailable() ? "✓" : "✗";
  const name = s.name();
  switch (s.level()) {
    case Level.Strict:
      return `🔒 Strict sandbox [${name}: ${available}] - read-only project, host network`;
    case Level.Standard:
      return `🔒 Standard sandbox [${name}: ${available}] - read-write project, host network`;
    default:
      return "🔓 No sandbox";
  }
}

// Forward declarations resolved by ./platform.ts and ./none.ts to avoid an
// import cycle between the manager and its backends.
import { newNoneSandbox } from "./none.ts";
import { newPlatformSandboxWithOptions } from "./platform.ts";
import { normalizeOptions } from "./policy.ts";
