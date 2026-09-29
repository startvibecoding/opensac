// (+ bash_unix.go / bash_windows.go).
//
// Executes shell commands, optionally in a sandbox, with sync and background
// (`async=true`) modes. Go's `os/exec` maps to `Deno.Command`; `context.Context`
// maps to an `AbortSignal`; sync-run timeouts map to `AbortSignal.timeout`
// combined with the parent signal.
//
// Deviations: Deno has no `SysProcAttr.Setsid`, so cancellation kills the direct
// child rather than the whole process group (`killCommandProcess`); the 100 ms
// `WaitDelay` after the shell exits is not modeled (stdio is read to EOF); the
// Windows embedded-BusyBox path is not reproduced.

import { envList, loadEnv } from "../config/env.ts";
import {
  isWindows,
  resolveBashShell,
  shellArgs,
} from "../platform/platform.ts";
// Shell identity and validation now live with the rest of the shell resolution
// in platform.ts, but stay re-exported here because the tools surface is
// public.
export { isValidShell } from "../platform/platform.ts";
import {
  type CommandCleanupProvider,
  type CommandSpec,
  type ExecOpts,
  gitAccessFromContext,
  type GitAccessSandbox,
  Level,
} from "../sandbox/mod.ts";
import { truncateString } from "../util/truncate.ts";
import type { JobManager } from "./jobmanager.ts";
import { createJobManager } from "./jobmanager.ts";
import {
  createTextToolResult,
  type ExecutionTimeoutProvider,
  type Registry,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./tool.ts";

/**
 * Upper bound on a synchronous bash result (UTF-16 units). The result is a
 * sectioned block, so truncation must never cut away the trailing
 * `[exit_code]` marker.
 */
export const MAX_BASH_RESULT_CHARS = 50_000;

/** Wraps a byte buffer with a max size limit, mirroring Go's `limitedBuffer`. */
class LimitedBuffer {
  #chunks: Uint8Array[] = [];
  #size = 0;
  #dropped = 0;
  #maxSize: number;

  constructor(maxSize: number) {
    this.#maxSize = maxSize;
  }

  write(p: Uint8Array): void {
    if (this.#size + p.length > this.#maxSize) {
      const keep = this.#maxSize - this.#size;
      if (keep > 0) {
        this.#chunks.push(p.subarray(0, keep));
        this.#size += keep;
      }
      this.#dropped += p.length - keep;
      return;
    }
    this.#chunks.push(p);
    this.#size += p.length;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.#size);
    let off = 0;
    for (const c of this.#chunks) {
      out.set(c, off);
      off += c.length;
    }
    if (this.#dropped > 0) {
      const trail = new TextEncoder().encode(
        `\n... (truncated ${this.#dropped} bytes)`,
      );
      const merged = new Uint8Array(out.length + trail.length);
      merged.set(out, 0);
      merged.set(trail, out.length);
      this.#dropped = 0;
      return merged;
    }
    return out;
  }
}

interface SpawnSpec {
  program: string;
  args: string[];
  cwd?: string;
  env?: string[];
  cleanup?: () => void;
}

/** Executes shell commands. */
export class BashTool implements Tool, ExecutionTimeoutProvider {
  #registry: Registry;
  #jobManager: JobManager;

  constructor(r: Registry, jm: JobManager) {
    this.#registry = r;
    this.#jobManager = jm;
  }

  /** Returns the job manager for background processes. */
  getJobManager(): JobManager {
    return this.#jobManager;
  }

  name(): string {
    return "bash";
  }

  description(): string {
    if (isWindows()) {
      return "Execute a shell command (BusyBox first, PowerShell fallback). Use this for short commands, validation, and builds. The command runs in the current working directory. Sync runs default to 45s, max 600s. For long-running services like servers and watchers, use async=true.";
    }
    return "Execute a bash command. Use this for short commands, validation, and builds. The command runs in the current working directory. Sync runs default to 45s, max 600s. For long-running services like servers and watchers, use async=true.";
  }

  promptSnippet(): string {
    return "Execute shell commands when dedicated tools are insufficient";
  }

  promptGuidelines(): string[] {
    const guidelines = [
      "Prefer read/ls/grep/find tools over bash for file inspection and exploration",
      "Use bash for short commands, validation, and builds; use async=true for long-running services like servers, watchers, and dev servers",
      "For network probes and commands that may hang, set timeout explicitly",
      "Examples that often need explicit timeout: curl, wget, npm install, go test, docker logs",
    ];
    if (isWindows()) {
      guidelines.push(
        "On Windows, bash uses embedded BusyBox first and falls back to PowerShell if BusyBox is unavailable",
      );
    }
    return guidelines;
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        timeout: {
          type: "integer",
          description:
            "Timeout in seconds (default 45, max 600). Set to 0 for no tool-level deadline.",
        },
        async: {
          type: "boolean",
          description:
            "Run command in background (for long-running services like servers). Returns immediately with a job ID. Use 'jobs' tool to check status.",
        },
      },
      required: ["command"],
    };
  }

  async execute(
    ctx: ToolContext,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    let command = typeof params["command"] === "string"
      ? params["command"] as string
      : "";
    if (command === "") {
      throw new Error("command is required");
    }

    let async = params["async"] === true;

    command = command.trim();
    if (command.endsWith("&") && !async) {
      async = true;
      command = command.slice(0, -1).trim();
    }

    const timeoutMs = this.defaultTimeout(params);

    const shell = this.resolveShell();
    const workDir = this.#registry.getWorkDir();

    const env = this.baseEnv();

    const sb = this.#registry.getSandbox();
    const additionalDirs = this.#registry.getAdditionalDirectories();

    if (sb && sb.isAvailable()) {
      const opts: ExecOpts = {
        workDir,
        timeoutMs,
        envVars: this.executionEnvVars(),
      };
      if (sb.level() === Level.Strict) {
        opts.readOnlyPaths = additionalDirs;
      } else {
        opts.writablePaths = additionalDirs;
      }
      let spec: CommandSpec;
      if (gitAccessFromContext(ctx.signal)) {
        const gitSB = sb as unknown as GitAccessSandbox;
        if (typeof gitSB.wrapCommandWithGitAccess !== "function") {
          throw new Error(
            "sandbox backend cannot grant one-shot Git access",
          );
        }
        spec = gitSB.wrapCommandWithGitAccess(ctx.signal, shell, command, opts);
      } else {
        spec = sb.wrapCommand(ctx.signal, shell, command, opts);
      }
      const cleanupProvider = sb as unknown as CommandCleanupProvider;
      const cleanup = typeof cleanupProvider.cleanupCommand === "function"
        ? () => cleanupProvider.cleanupCommand(spec)
        : undefined;
      const spawn: SpawnSpec = {
        program: spec.program,
        args: spec.args,
        cwd: spec.cwd ?? workDir,
        env: spec.env ?? env,
        cleanup: spec.cleanup ?? cleanup,
      };
      return await this.runCommand(
        spawn,
        command,
        workDir,
        async,
        runtimeForShell(shell),
        ctx.signal,
        timeoutMs,
      );
    }

    const spawn = this.buildCommand(shell, command, workDir, env);
    return await this.runCommand(
      spawn,
      command,
      workDir,
      async,
      runtimeForShell(shell),
      ctx.signal,
      timeoutMs,
    );
  }

  /** Aligns the agent-level tool deadline with `execute`. */
  executionTimeout(
    params: Record<string, unknown>,
  ): { durationMs: number; provided: boolean } {
    return { durationMs: this.defaultTimeout(params), provided: true };
  }

  #executionEnvVarsCache: Record<string, string> | null = null;

  executionEnvVars(): Record<string, string> {
    if (this.#executionEnvVarsCache) return this.#executionEnvVarsCache;
    const vars = this.#registry.envVars();
    for (const [k, v] of Object.entries(envList(loadEnv()))) {
      vars[k] = v;
    }
    this.#executionEnvVarsCache = vars;
    return vars;
  }

  baseEnv(): string[] {
    const obj = Deno.env.toObject();
    for (const [k, v] of Object.entries(this.executionEnvVars())) {
      obj[k] = v;
    }
    return nonInteractiveEnv(
      Object.entries(obj).map(([k, v]) => `${k}=${v}`),
    );
  }

  resolveShell(): string {
    return resolveBashShell(this.#registry.shellPath());
  }

  buildCommand(
    shell: string,
    command: string,
    workDir: string,
    env: string[],
  ): SpawnSpec {
    const args = shellArgs(shell, command);
    return { program: shell, args, cwd: workDir, env };
  }

  async runCommand(
    spec: SpawnSpec,
    command: string,
    workDir: string,
    async: boolean,
    runtimeLabel: string,
    parentSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<ToolResult> {
    const cleanup = spec.cleanup;
    if (async) {
      const maxJobOutput = 1000000;
      return await this.#runAsync(
        spec,
        command,
        runtimeLabel,
        cleanup,
        maxJobOutput,
        parentSignal,
        timeoutMs,
      );
    }

    const maxSyncOutput = 1 << 20;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(
        () => controller.abort(new Error("timeout")),
        timeoutMs,
      );
    }
    const signal = combineSignals(parentSignal, controller.signal);
    let child: Deno.ChildProcess;
    try {
      child = spawnChild(spec, signal);
    } catch (err) {
      if (timer !== undefined) clearTimeout(timer);
      cleanup?.();
      throw err;
    }

    const stdoutBuf = new LimitedBuffer(maxSyncOutput);
    const stderrBuf = new LimitedBuffer(maxSyncOutput);
    const stdoutDone = readCapped(child.stdout, stdoutBuf);
    const stderrDone = readCapped(child.stderr, stderrBuf);

    let status: Deno.CommandStatus;
    try {
      [status] = await Promise.all([child.status, stdoutDone, stderrDone]);
    } catch (err) {
      // A timeout/abort kills the process; report the captured partial output.
      const errWithOutput = err as Error;
      if (
        errWithOutput.name === "AbortError" ||
        errWithOutput.name === "TimeoutError"
      ) {
        status = {
          success: false,
          code: null,
          signal: null,
        } as unknown as Deno.CommandStatus;
      } else {
        if (timer !== undefined) clearTimeout(timer);
        cleanup?.();
        throw err;
      }
    }
    if (timer !== undefined) clearTimeout(timer);
    cleanup?.();

    const stdoutStr = trimTrailingNewline(decode(stdoutBuf.bytes()));
    const stderrStr = trimTrailingNewline(decode(stderrBuf.bytes()));
    const exitCode = status.code ?? 0;

    const result = buildBashResult(
      runtimeLabel,
      command,
      workDir,
      stdoutStr,
      stderrStr,
      exitCode,
    );

    return createTextToolResult(result);
  }

  #runAsync(
    spec: SpawnSpec,
    command: string,
    runtimeLabel: string,
    cleanup: (() => void) | undefined,
    maxJobOutput: number,
    parentSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): ToolResult {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(
        () => controller.abort(new Error("timeout")),
        timeoutMs,
      );
    }
    const signal = combineSignals(parentSignal, controller.signal);
    let child: Deno.ChildProcess;
    try {
      child = spawnChild(spec, signal);
    } catch (err) {
      if (timer !== undefined) clearTimeout(timer);
      cleanup?.();
      throw err;
    }

    const pid = child.pid;
    let childDone = false;
    const job = this.#jobManager.addJob(command, pid, () => {
      if (childDone) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
    });

    void (async () => {
      const stdoutBuf = new LimitedBuffer(maxJobOutput);
      const stderrBuf = new LimitedBuffer(maxJobOutput);
      const stdoutDone = readCapped(child.stdout, stdoutBuf);
      const stderrDone = readCapped(child.stderr, stderrBuf);
      let err: Error | null = null;
      let status: Deno.CommandStatus;
      try {
        [status] = await Promise.all([child.status, stdoutDone, stderrDone]);
      } catch (e) {
        err = e instanceof Error ? e : new Error(String(e));
        status = {
          success: false,
          code: null,
          signal: null,
        } as unknown as Deno.CommandStatus;
      }
      if (timer !== undefined) clearTimeout(timer);
      childDone = true;
      cleanup?.();
      job.exitCode = status.code ?? 0;
      job.markDone(stdoutBuf.bytes(), stderrBuf.bytes(), err);
    })();

    return createTextToolResult(
      `[runtime]\n${runtimeLabel}\n[command]\n${command}\nUse 'jobs' tool to check status or 'kill' to stop.`,
    );
  }

  defaultTimeout(params: Record<string, unknown>): number {
    const async = params["async"] === true;
    const v = timeoutSecondsParam(params);
    if (async) {
      if (v !== undefined) return clampTimeout(v);
      return 0;
    }
    if (v !== undefined) return clampTimeout(v);
    return 45000;
  }
}

/**
 * Assembles the canonical sync bash result: section markers first, then the
 * captured streams and the exit code.
 *
 * Over the cap only the captured streams shrink (stdout gets three quarters
 * of the budget, stderr the rest). The section markers and `[exit_code]`
 * always survive, because a truncation that dropped them would make a failed
 * command read as a success; the whole result is truncated only when the
 * surrounding metadata itself is oversized.
 */
export function buildBashResult(
  runtimeLabel: string,
  command: string,
  workDir: string,
  stdout: string,
  stderr: string,
  exitCode: number,
): string {
  const out = stdout === "" ? "(no output)" : stdout;
  const err = stderr === "" ? "(no output)" : stderr;
  const build = (outBody: string, errBody: string) =>
    "[runtime]\n" + runtimeLabel + "\n[command]\n" + command + "\n[cwd]\n" +
    workDir + "\n[stdout]\n" + outBody + "\n[stderr]\n" + errBody +
    "\n[exit_code]\n" + exitCode;

  const result = build(out, err);
  if (result.length <= MAX_BASH_RESULT_CHARS) return result;

  const note = "... (truncated)";
  // Everything but the two captured streams (markers, command, cwd, exit
  // code) is fixed and never truncated.
  const budget = MAX_BASH_RESULT_CHARS -
    (result.length - out.length - err.length);
  // Each share must be able to hold the truncation note plus one kept byte.
  if (budget >= 4 * (note.length + 2)) {
    // A truncated stream keeps its trailing note inside its own share, so
    // the two shares always add up to the budget.
    const errShare = Math.min(err.length, Math.floor(budget / 4));
    const outShare = budget - errShare;
    const shrink = (body: string, share: number) => {
      if (body.length <= share) return body;
      return truncateString(body, share - note.length - 1) + "\n" + note;
    };
    return build(shrink(out, outShare), shrink(err, errShare));
  }

  // The metadata alone is oversized (e.g. a huge command): keep the hard cap
  // even though the trailing sections are lost.
  const prefix = truncateString(result, MAX_BASH_RESULT_CHARS);
  return prefix + `\n... (truncated ${result.length - prefix.length} bytes)`;
}

function spawnChild(
  spec: SpawnSpec,
  signal: AbortSignal | undefined,
): Deno.ChildProcess {
  const cmd = new Deno.Command(spec.program, {
    args: spec.args,
    cwd: spec.cwd,
    env: spec.env ? envRecord(spec.env) : undefined,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal,
  });
  return cmd.spawn();
}

function envRecord(entries: string[]): Record<string, string> {
  const rec: Record<string, string> = {};
  for (const entry of entries) {
    const idx = entry.indexOf("=");
    if (idx >= 0) rec[entry.slice(0, idx)] = entry.slice(idx + 1);
  }
  return rec;
}

function combineSignals(
  parent: AbortSignal | undefined,
  controllerSignal: AbortSignal,
): AbortSignal {
  if (parent) return AbortSignal.any([parent, controllerSignal]);
  return controllerSignal;
}

async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  buf: LimitedBuffer,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) buf.write(value);
    }
  } catch {
    // stream closed on kill
  }
}

function trimTrailingNewline(s: string): string {
  return s.replace(/\n+$/, "");
}

function decode(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

function timeoutSecondsParam(
  params: Record<string, unknown>,
): number | undefined {
  const v = params["timeout"];
  return typeof v === "number" ? v : undefined;
}

function clampTimeout(seconds: number): number {
  if (seconds < 0) return 45000;
  if (seconds > 600) seconds = 600;
  return seconds * 1000;
}

function nonInteractiveEnv(env: string[]): string[] {
  let out = env;
  out = setEnvDefault(out, "GIT_TERMINAL_PROMPT", "0");
  out = setEnvDefault(out, "GIT_ASKPASS", "true");
  out = setEnvDefault(out, "SSH_ASKPASS", "true");
  out = setEnvDefault(out, "SSH_ASKPASS_REQUIRE", "never");
  out = setEnvDefault(out, "SUDO_ASKPASS", "true");
  return out;
}

function setEnvDefault(env: string[], key: string, value: string): string[] {
  const prefix = key + "=";
  for (const entry of env) {
    if (entry.startsWith(prefix)) return env;
  }
  return [...env, prefix + value];
}

function runtimeForShell(shell: string): string {
  const lower = shell.toLowerCase();
  if (lower.includes("busybox")) return "busybox";
  if (lower.includes("powershell")) return "powershell";
  if (lower.includes("cmd")) return "cmd";
  return basename(shell);
}

function basename(p: string): string {
  return p.replaceAll("\\", "/").split("/").pop() ?? p;
}

/** Creates a new bash tool (a fresh JobManager unless one is supplied). */
export function createBashTool(
  r: Registry,
  jm: JobManager = createJobManager(),
): BashTool {
  return new BashTool(r, jm);
}
