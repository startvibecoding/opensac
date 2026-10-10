// Test-only helpers for spawning the CLI in a real child process.
//
// Several guards (ACP stdio framing, Core host lifecycle, launcher resolution)
// are only meaningful across a process boundary, so they spawn this repository's
// entry point again. The toolchain is Node, so the equivalent of the old Node
// invocation is `node <entry>` — Node needs no permission flags, and TypeScript
// sources run directly via type stripping.
//
// The helper keeps the shape the tests already use (`nodeRuntime.Command`-like args,
// piped stdout/stderr, exit status) so migrating a call site is a one-line swap.

import { runtime as nodeRuntime } from "../platform/runtime.ts";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Repository root, resolved from this module's location. */
export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Absolute path of the CLI entry point (`src/main.ts`). */
export const cliEntry = fileURLToPath(
  new URL("../../src/main.ts", import.meta.url),
);

/** Absolute path of the test preload that installs the `Node` global. */
export const preloadEntry = fileURLToPath(
  new URL("../../scripts/test/preload.mjs", import.meta.url),
);

/** Result of a completed child process run. */
export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True when the process exited with code 0. */
  success: boolean;
}

/** Options accepted by {@link runCli} and {@link runScript}. */
export interface RunOptions {
  /** Extra arguments placed before the entry point's own argv. */
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string | null;
  /** Milliseconds to wait before killing the child. Default: 120000. */
  timeoutMs?: number;
}

/**
 * Spawns the CLI entry (`src/main.ts`) with the given arguments in a fresh Node
 * process, with the `Node` compat global preloaded.
 */
export function runCli(
  args: string[],
  options: Omit<RunOptions, "args"> = {},
): Promise<SpawnResult> {
  return runScript(cliEntry, args, options);
}

/**
 * Spawns an arbitrary script/module with the given arguments, preloading the
 * `Node` compat global so the child sees the same runtime surface as the parent.
 */
export function runScript(
  scriptPath: string,
  args: string[] = [],
  options: RunOptions = {},
): Promise<SpawnResult> {
  const nodeArgs = [
    "--import",
    preloadEntry,
    ...(options.args ?? []),
    scriptPath,
    ...args,
  ];
  return spawnCaptured(process.execPath, nodeArgs, options);
}

/** Captures a spawned child's output and resolves when it exits. */
export function spawnCaptured(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<SpawnResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  return new Promise<SpawnResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: buildEnv(options.env),
      stdio: [options.stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr, success: code === 0 });
    });

    if (options.stdin != null) {
      child.stdin!.end(options.stdin);
    }
  });
}

/** Merges an override map onto `process.env`, dropping undefined values. */
export function buildEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}
