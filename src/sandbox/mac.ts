// Ported from internal/sandbox/mac.go
//
// The Go original tracks temporary Seatbelt profiles in a map keyed by
// *exec.Cmd and removes them from CleanupCommand. Deno has no such handle, so
// the removal is attached to the returned CommandSpec's `cleanup` hook instead.

import * as path from "@std/path";
import { lookPathSync, shellArgs, tempDir } from "../platform/platform.ts";
import type { CommandSpec, ExecOpts, Options, Sandbox } from "./sandbox.ts";
import { Level } from "./sandbox.ts";

/** Implements sandboxing using macOS sandbox-exec (Seatbelt). */
export class MacSandbox implements Sandbox {
  #level: Level;
  #projectDir: string;
  #options: Options;
  #available: boolean | undefined;

  constructor(projectDir: string, level: Level, opts: Options = {}) {
    this.#level = level;
    this.#projectDir = path.resolve(projectDir);
    this.#options = opts;
  }

  /** Checks if sandbox-exec is available on this system. */
  isAvailable(): boolean {
    if (this.#available !== undefined) return this.#available;

    const execPath = lookPathSync("sandbox-exec");
    if (execPath === null) {
      this.#available = false;
      return false;
    }
    // Verify that the host accepts a real profile, rather than only checking
    // that the legacy executable exists.
    try {
      const result = new Deno.Command(execPath, {
        args: ["-p", "(version 1) (allow default)", "/usr/bin/true"],
        stdout: "null",
        stderr: "null",
      }).outputSync();
      this.#available = result.success;
    } catch {
      this.#available = false;
    }
    return this.#available;
  }

  name(): string {
    return "sandbox-exec";
  }

  level(): Level {
    return this.#level;
  }

  /** Wraps a command for execution inside the macOS sandbox. */
  wrapCommand(
    _signal: AbortSignal | undefined,
    shell: string,
    cmd: string,
    opts: ExecOpts,
  ): CommandSpec {
    const profile = this.buildProfile(opts);

    // Create a temporary profile file with a unique name to avoid races.
    let profilePath: string;
    try {
      profilePath = Deno.makeTempFileSync({
        dir: tempDir(),
        prefix: "vibecoding-sandbox-",
        suffix: ".sb",
      });
      Deno.writeTextFileSync(profilePath, profile);
      Deno.chmodSync(profilePath, 0o600);
    } catch {
      // Fallback: a command that will fail, matching the Go implementation.
      return { program: "false", args: [] };
    }

    const spec: CommandSpec = {
      program: "sandbox-exec",
      args: ["-f", profilePath, shell, ...shellArgs(shell, cmd)],
      env: [...envEntries(), ...mapEnv(opts.envVars)],
      cleanup: () => {
        try {
          Deno.removeSync(profilePath);
        } catch {
          // Removing an already-removed profile is a no-op.
        }
      },
    };
    if (opts.workDir) spec.cwd = opts.workDir;
    return spec;
  }

  /** Generates a Seatbelt profile string based on the level and policy. */
  buildProfile(opts: ExecOpts): string {
    let b = "";

    // Default-deny policy; only explicitly allowed operations are permitted.
    b += "(version 1)\n(deny default)\n";

    // Allow process execution for common shells and tools.
    b += "(allow process-exec\n";
    for (
      const bin of ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"]
    ) {
      b += `    (subpath "${bin}")\n`;
    }
    b += ")\n";

    const allowedPaths: string[] = [];
    if (this.#projectDir !== "") allowedPaths.push(this.#projectDir);
    allowedPaths.push(tempDir());

    const home = Deno.env.get("HOME") ?? "";
    if (home !== "") {
      allowedPaths.push(
        path.join(home, ".config"),
        path.join(home, ".cache"),
        path.join(home, ".mothx"),
      );
    }
    allowedPaths.push(...(this.#options.allowedWrite ?? []));
    allowedPaths.push(...(this.#options.allowedRead ?? []));
    allowedPaths.push(...(opts.writablePaths ?? []));
    allowedPaths.push(...(opts.readOnlyPaths ?? []));

    for (let p of allowedPaths) {
      const strictProject = this.#level === Level.Strict &&
        path.normalize(p) === this.#projectDir;
      p = seatbeltQuotePath(p);
      if (p === "") continue;
      if (strictProject) {
        b += `(allow file-read* (subpath "${p}"))\n`;
      } else {
        b += `(allow file-read* file-write* (subpath "${p}"))\n`;
      }
    }
    for (let p of this.#options.deniedPaths ?? []) {
      p = seatbeltQuotePath(p);
      if (p !== "") {
        b += `(deny file-read* file-write* (subpath "${p}"))\n`;
      }
    }

    if (!this.#options.allowNetwork) {
      b += "(deny network*)\n";
    }

    return b;
  }
}

/** Creates a new macOS sandbox with default policy. */
export function newMacSandbox(
  projectDir: string,
  level: Level,
): MacSandbox {
  return new MacSandbox(projectDir, level, {});
}

/** Creates a macOS sandbox with a policy. */
export function newMacSandboxWithOptions(
  projectDir: string,
  level: Level,
  opts: Options,
): MacSandbox {
  return new MacSandbox(projectDir, level, opts);
}

function seatbeltQuotePath(p: string): string {
  const clean = path.normalize(p);
  if (clean === "." || clean === "") return "";
  return clean.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function envEntries(): string[] {
  return Object.entries(Deno.env.toObject()).map(([k, v]) => `${k}=${v}`);
}

function mapEnv(envVars: Record<string, string> | undefined): string[] {
  return Object.entries(envVars ?? {}).map(([k, v]) => `${k}=${v}`);
}
