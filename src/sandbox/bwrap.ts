import { runtime as nodeRuntime } from "../platform/runtime.ts";
import * as path from "../compat/path.ts";
import { lookPathSync } from "../platform/platform.ts";
import { normalizeTmpSize, pathsOverlap } from "./policy.ts";
import { protectedGitPaths, uniquePaths } from "./git_paths.ts";
import {
  type CommandSpec,
  type ExecOpts,
  type GitAccessSandbox,
  type Options,
} from "./sandbox.ts";
import { Level } from "./sandbox.ts";

/** Default tmpfs size used when no policy value is supplied. */
const DEFAULT_TMP_SIZE = "100000000";

/** Describes the flags and runtime features required by OpenSAC. */
export interface BwrapCapabilities {
  unshareUser: boolean;
  unsharePid: boolean;
  unshareIpc: boolean;
  unshareUts: boolean;
  newSession: boolean;
  dieWithParent: boolean;
  mountProc: boolean;
  mountDev: boolean;
  mountTmpfs: boolean;
  tmpfsSize: boolean;
  mountBind: boolean;
  changeDir: boolean;
  hostname: boolean;
}

/** Reports whether every capability OpenSAC relies on is present. */
export function bwrapCapabilitiesComplete(caps: BwrapCapabilities): boolean {
  return (
    caps.unshareUser &&
    caps.unsharePid &&
    caps.unshareIpc &&
    caps.unshareUts &&
    caps.newSession &&
    caps.dieWithParent &&
    caps.mountProc &&
    caps.mountDev &&
    caps.mountTmpfs &&
    caps.tmpfsSize &&
    caps.mountBind &&
    caps.changeDir &&
    caps.hostname
  );
}

/** Locates the bwrap binary, preferring well-known install locations. */
export function findBwrap(): string {
  for (const c of ["/usr/bin/bwrap", "/usr/local/bin/bwrap"]) {
    if (existsSync(c)) return c;
  }
  return lookPathSync("bwrap") ?? "";
}

/** Probes the flags advertised by the bwrap at `p`. */
export function probeBwrapCapabilities(
  p: string,
): BwrapCapabilities | undefined {
  if (p === "") return undefined;

  let output = "";
  try {
    const result = new nodeRuntime.Command(p, {
      args: ["--help"],
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    if (!result.success) return undefined;
    output =
      new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr);
  } catch {
    return undefined;
  }

  const has = (flag: string) => output.includes(flag);
  return {
    unshareUser: has("--unshare-user"),
    unsharePid: has("--unshare-pid"),
    unshareIpc: has("--unshare-ipc"),
    unshareUts: has("--unshare-uts"),
    newSession: has("--new-session"),
    dieWithParent: has("--die-with-parent"),
    mountProc: has("--proc"),
    mountDev: has("--dev"),
    mountTmpfs: has("--tmpfs"),
    tmpfsSize: has("--size"),
    mountBind: has("--bind") && has("--ro-bind"),
    changeDir: has("--chdir"),
    hostname: has("--hostname"),
  };
}

/** Implements sandboxing using bubblewrap (bwrap). */
export class BwrapSandbox implements GitAccessSandbox {
  #level: Level;
  #projectDir: string;
  #bwrapPath: string;
  #available: boolean | undefined;
  #availabilityErr: Error | undefined;
  #capabilities: BwrapCapabilities | undefined;
  #options: Options;
  #gitPaths: string[];

  constructor(projectDir: string, level: Level, opts: Options = {}) {
    const absDir = path.resolve(projectDir);
    const bwrapPath = opts.bwrapPath || findBwrap();
    // .git is intentionally visible to sandboxed commands. Keep resolving its
    // paths for one-shot Git access handling, but do not deny them.
    const gitPaths = opts.protectGit ? protectedGitPaths(absDir) : [];

    const effective: Options = { ...opts };
    if (effective.tmpSize) {
      // NewBwrapSandboxWithOptions is also used directly by tests and platform
      // integrations, outside Manager's NormalizeOptions path. Keep bwrap's wire
      // format valid: --size accepts decimal bytes only.
      try {
        effective.tmpSize = normalizeTmpSize(effective.tmpSize);
      } catch {
        effective.tmpSize = DEFAULT_TMP_SIZE;
      }
    }

    this.#level = level;
    this.#projectDir = absDir;
    this.#bwrapPath = bwrapPath;
    this.#options = effective;
    this.#gitPaths = uniquePaths(gitPaths);
  }

  /** Checks if bwrap is available on this system. */
  isAvailable(): boolean {
    if (this.#available !== undefined) return this.#available;

    // bwrap is Linux only.
    if (nodeRuntime.build.os !== "linux") {
      return this.#markUnavailable("bubblewrap is only supported on Linux");
    }
    if (this.#bwrapPath === "") {
      return this.#markUnavailable("bwrap binary not found in PATH");
    }

    const caps = probeBwrapCapabilities(this.#bwrapPath);
    if (caps === undefined) {
      return this.#markUnavailable("failed to query bwrap capabilities");
    }
    this.#capabilities = caps;
    if (!bwrapCapabilitiesComplete(caps)) {
      return this.#markUnavailable("bwrap is missing required capabilities");
    }

    // Verify the exact profile used for commands, rather than a minimal
    // invocation, so host policies that reject a required flag are caught.
    const shell = lookPathSync("sh");
    if (shell === null) {
      return this.#markUnavailable(`shell not found: sh`);
    }
    const args = this.buildBwrapArgs(
      this.#options,
      { workDir: this.#projectDir },
      shell,
      "test -r /proc/self/status && test -d /tmp && test -w /tmp",
    );
    try {
      const result = new nodeRuntime.Command(this.#bwrapPath, {
        args,
        stdout: "piped",
        stderr: "piped",
      }).outputSync();
      if (!result.success) {
        let reason = (
          new TextDecoder().decode(result.stdout) +
          new TextDecoder().decode(result.stderr)
        ).trim();
        if (reason === "") reason = "bwrap probe failed";
        return this.#markUnavailable(`bwrap probe failed: ${reason}`);
      }
    } catch (err) {
      return this.#markUnavailable(`bwrap probe failed: ${String(err)}`);
    }

    this.#available = true;
    return true;
  }

  #markUnavailable(reason: string): false {
    this.#available = false;
    this.#availabilityErr = new Error(reason);
    return false;
  }

  /** Explains why bwrap could not be used. */
  availabilityError(): Error | undefined {
    return this.#availabilityErr;
  }

  /** Returns an advisory description of the last probe. */
  capabilities(): BwrapCapabilities | undefined {
    return this.#capabilities;
  }

  /** Returns the effective (normalized) sandbox policy. */
  get options(): Options {
    return this.#options;
  }

  name(): string {
    return "bwrap";
  }

  level(): Level {
    return this.#level;
  }

  /** Wraps a command for execution inside bubblewrap. */
  wrapCommand(
    _signal: AbortSignal | undefined,
    shell: string,
    cmd: string,
    opts: ExecOpts,
  ): CommandSpec {
    return this.#spec(this.#options, shell, cmd, opts);
  }

  /**
   * Runs one command with the protected `.git` deny carveout removed. The
   * sandbox instance itself is immutable; only this command receives the
   * temporary transform.
   */
  wrapCommandWithGitAccess(
    _signal: AbortSignal | undefined,
    shell: string,
    cmd: string,
    opts: ExecOpts,
  ): CommandSpec {
    const gitPaths = this.#gitPaths;
    const deniedPaths = (this.#options.deniedPaths ?? []).filter(
      (p) => !containsPath(gitPaths, p),
    );
    const allowedWrite = [...(this.#options.allowedWrite ?? [])];
    for (const p of gitPaths) {
      if (existsSync(p, true) && !containsPath(deniedPaths, p)) {
        allowedWrite.push(p);
      }
    }
    const effective: Options = {
      ...this.#options,
      deniedPaths,
      allowedWrite,
    };
    return this.#spec(effective, shell, cmd, opts);
  }

  #spec(
    options: Options,
    shell: string,
    cmd: string,
    opts: ExecOpts,
  ): CommandSpec {
    const spec: CommandSpec = {
      program: this.#bwrapPath,
      args: this.buildBwrapArgs(options, opts, shell, cmd),
      env: this.buildEnv(options, opts),
    };
    if (opts.workDir) spec.cwd = opts.workDir;
    return spec;
  }

  /** Constructs the bwrap command arguments. */
  buildBwrapArgs(
    options: Options,
    opts: ExecOpts,
    shell: string,
    cmd: string,
  ): string[] {
    const args: string[] = [
      // Explicit user namespace avoids relying on bwrap's implicit behavior,
      // especially when invoked by uid 0 inside a container.
      "--unshare-user",
      "--new-session",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts", // Required for --hostname

      // Die when parent dies.
      "--die-with-parent",

      // Proc filesystem. bwrap must initialize PID entries before any remount;
      // forcing remount-ro here breaks /proc/<pid> creation.
      "--proc",
      "/proc",

      // Dev filesystem (minimal - null, zero, urandom).
      "--dev",
      "/dev",
      // Network access is intentionally preserved: the sandbox isolates process
      // and filesystem state, but does not create a network namespace.
    ];

    // Tmp filesystem with size limit. --size must immediately precede --tmpfs.
    const tmpSize = options.tmpSize || DEFAULT_TMP_SIZE;
    args.push("--size", tmpSize, "--tmpfs", "/tmp");

    // System libraries (read-only).
    for (const p of ["/usr", "/lib", "/lib64", "/bin", "/sbin"]) {
      if (existsSync(p)) args.push("--ro-bind", p, p);
    }

    // Additional system paths.
    for (const p of [
      "/etc/ld.so.cache",
      "/etc/ssl",
      "/etc/ca-certificates",
      "/etc/resolv.conf",
      "/etc/hosts",
      "/etc/nsswitch.conf",
    ]) {
      if (existsSync(p)) args.push("--ro-bind", p, p);
    }

    // Home directory: tmpfs prevents access to the real home. This must be set
    // BEFORE the project bind if the project is under home.
    const home = nodeRuntime.env.get("HOME") ?? "";
    if (home !== "") args.push("--tmpfs", home);

    // Project directory binding (after the home tmpfs when nested under home).
    if (this.#projectDir !== "") {
      if (this.#level === Level.Strict) {
        args.push("--ro-bind", this.#projectDir, this.#projectDir);
      } else {
        args.push("--bind", this.#projectDir, this.#projectDir);
      }
    }

    // Configured paths are applied after the project bind. A denied path is
    // never bound.
    for (const p of options.allowedRead ?? []) {
      // /proc is created by --proc and /dev by --dev; rebinding host entries is
      // invalid after --unshare-pid or can turn device nodes into plain files.
      if (isProcPath(p) || isDevPath(p)) continue;
      if (!denied(options, p) && existsSync(p)) args.push("--ro-bind", p, p);
    }
    for (const p of options.allowedWrite ?? []) {
      if (!denied(options, p) && existsSync(p)) args.push("--bind", p, p);
    }

    // Additional read-only / writable paths from the per-call options.
    for (const p of opts.readOnlyPaths ?? []) {
      if (isProcPath(p) || isDevPath(p)) continue;
      if (!denied(options, p) && existsSync(p)) args.push("--ro-bind", p, p);
    }
    for (const p of opts.writablePaths ?? []) {
      if (!denied(options, p) && existsSync(p)) args.push("--bind", p, p);
    }

    // Denied paths are masked after every broad bind. bwrap cannot express a
    // deny rule directly; an empty tmpfs hides the directory and its children.
    for (const p of options.deniedPaths ?? []) {
      // The home tmpfs already hides a denied ancestor of the project. Masking
      // it after binding the project would also hide the project mount.
      if (pathContains(p, this.#projectDir)) continue;
      let isDir = false;
      let exists = true;
      try {
        isDir = nodeRuntime.lstatSync(p).isDirectory;
      } catch {
        exists = false;
      }
      if (!exists) {
        args.push("--dir", p, "--tmpfs", p);
      } else if (isDir) {
        args.push("--tmpfs", p);
      } else {
        args.push("--ro-bind", "/dev/null", p);
      }
    }

    args.push("--hostname", "sandbox");

    if (opts.workDir) {
      args.push("--chdir", opts.workDir);
    } else if (this.#projectDir !== "") {
      args.push("--chdir", this.#projectDir);
    }

    for (const [k, v] of Object.entries(opts.envVars ?? {})) {
      args.push("--setenv", k, v);
    }

    args.push(shell, "-c", cmd);
    return args;
  }

  /** Constructs the environment for the sandboxed process. */
  buildEnv(options: Options, opts: ExecOpts): string[] {
    const defaultPass = [
      "PATH",
      "LANG",
      "LC_ALL",
      "TERM",
      "GOPATH",
      "GOROOT",
      "GOPROXY",
      "GOMODCACHE",
      "NODE_PATH",
      "NPM_CONFIG_PREFIX",
      "HOME",
      "USER",
      "SHELL",
      ...(options.passEnv ?? []),
    ];
    const passVars = new Set(defaultPass);

    const explicit = nodeRuntime.env.get("VIBECODING_SANDBOX_PASS_ENV") ?? "";
    if (explicit !== "") {
      for (const name of explicit.split(",")) passVars.add(name.trim());
    }

    const env: string[] = [];
    for (const [name, value] of Object.entries(nodeRuntime.env.toObject())) {
      if (passVars.has(name)) env.push(`${name}=${value}`);
    }

    for (const [k, v] of Object.entries(opts.envVars ?? {})) {
      replaceEnv(env, k, v);
    }

    // Point HOME at the sandbox-isolated home (tmpfs over the real home) unless
    // the caller explicitly set it.
    if (!("HOME" in (opts.envVars ?? {}))) {
      const home = nodeRuntime.env.get("HOME") ?? "";
      env.push(home !== "" ? `HOME=${home}` : "HOME=/tmp");
    }

    return env;
  }
}

/** Creates a bubblewrap sandbox (default policy unless `opts` is given). */
export function createBwrapSandbox(
  projectDir: string,
  level: Level,
  opts: Options = {},
): BwrapSandbox {
  return new BwrapSandbox(projectDir, level, opts);
}

function existsSync(p: string, lstat = false): boolean {
  try {
    if (lstat) nodeRuntime.lstatSync(p);
    else nodeRuntime.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function isProcPath(p: string): boolean {
  const clean = path.normalize(p);
  return clean === "/proc" || clean.startsWith(`/proc${path.SEPARATOR}`);
}

function isDevPath(p: string): boolean {
  const clean = path.normalize(p);
  return clean === "/dev" || clean.startsWith(`/dev${path.SEPARATOR}`);
}

function containsPath(paths: string[], target: string): boolean {
  const clean = path.normalize(target);
  return paths.some((p) => path.normalize(p) === clean);
}

function denied(options: Options, p: string): boolean {
  const clean = path.normalize(p);
  return (options.deniedPaths ?? []).some((d) => pathsOverlap(clean, d));
}

function pathContains(parent: string, child: string): boolean {
  return parent === child || child.startsWith(parent + path.SEPARATOR);
}

function replaceEnv(env: string[], key: string, value: string): void {
  const prefix = `${key}=`;
  const idx = env.findIndex((e) => e.startsWith(prefix));
  if (idx >= 0) env[idx] = prefix + value;
  else env.push(prefix + value);
}
