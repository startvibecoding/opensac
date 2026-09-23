import * as path from "@std/path";
import { shellArgs } from "../platform/platform.ts";
import type { CommandSpec, ExecOpts, Sandbox } from "./sandbox.ts";
import { Level } from "./sandbox.ts";

/**
 * Implements a basic sandbox for Windows.
 *
 * Full Windows sandboxing requires AppContainers or similar, which is complex;
 * this backend therefore refuses to advertise itself as available and only
 * provides env filtering for callers that explicitly wrap a command.
 */
export class WinSandbox implements Sandbox {
  #level: Level;
  #projectDir: string;

  constructor(projectDir: string, level: Level) {
    this.#level = level;
    this.#projectDir = path.resolve(projectDir);
  }

  /** Returns the resolved project directory. */
  projectDir(): string {
    return this.#projectDir;
  }

  /**
   * Reports false until a Windows backend can enforce the complete filesystem,
   * deny-path, and network profile. Restricting environment variables alone is
   * not a security sandbox.
   */
  isAvailable(): boolean {
    return false;
  }

  /** Explains why this backend is unavailable. */
  availabilityError(): Error {
    return new Error(
      "Windows sandbox backend is not configured; refusing env-only isolation",
    );
  }

  name(): string {
    return "windows-sandbox";
  }

  level(): Level {
    return this.#level;
  }

  /** Wraps a command for execution inside the Windows sandbox. */
  wrapCommand(
    _signal: AbortSignal | undefined,
    shell: string,
    cmd: string,
    opts: ExecOpts,
  ): CommandSpec {
    if (shell === "") shell = "cmd.exe";
    const spec: CommandSpec = {
      program: shell,
      args: shell.toLowerCase().includes("busybox")
        ? ["sh", "-c", cmd]
        : shellArgs(shell, cmd),
      env: this.buildEnv(opts),
    };
    if (opts.workDir) spec.cwd = opts.workDir;
    return spec;
  }

  /** Constructs a restricted environment for Windows. */
  buildEnv(opts: ExecOpts): string[] {
    const essential = new Set([
      "PATH",
      "SystemRoot",
      "SYSTEMROOT",
      "windir",
      "COMSPEC",
      "PATHEXT",
      "TEMP",
      "TMP",
      "HOME",
      "USERPROFILE",
      "USERNAME",
      "APPDATA",
      "LOCALAPPDATA",
      "ProgramFiles",
      "ProgramFiles(x86)",
      "CommonProgramFiles",
      "CommonProgramFiles(x86)",
      "NUMBER_OF_PROCESSORS",
      "PROCESSOR_ARCHITECTURE",
      "PROCESSOR_IDENTIFIER",
      "OS",
      "COMPUTERNAME",
    ]);

    const env: string[] = [];
    for (const entry of envEntries()) {
      const [name] = splitEnvVar(entry);
      if (essential.has(name)) env.push(entry);
    }
    for (const [k, v] of Object.entries(opts.envVars ?? {})) {
      env.push(`${k}=${v}`);
    }
    return env;
  }
}

/** Creates a new Windows sandbox. */
export function newWinSandbox(projectDir: string, level: Level): WinSandbox {
  return new WinSandbox(projectDir, level);
}

function splitEnvVar(s: string): [string, string | undefined] {
  const idx = s.indexOf("=");
  return idx < 0 ? [s, undefined] : [s.slice(0, idx), s.slice(idx + 1)];
}

function envEntries(): string[] {
  return Object.entries(Deno.env.toObject()).map(([k, v]) => `${k}=${v}`);
}
