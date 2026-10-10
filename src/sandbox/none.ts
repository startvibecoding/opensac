import { runtime } from "../platform/runtime.ts";
import { shellArgs } from "../platform/platform.ts";
import { type CommandSpec, type ExecOpts, type Sandbox } from "./sandbox.ts";
import { Level } from "./sandbox.ts";

/** Executes commands without any sandbox restrictions. */
export class NoneSandbox implements Sandbox {
  /**
   * Returns a plain command without any sandbox restrictions. It inherits the
   * full parent environment and overlays `opts.envVars` on top.
   */
  wrapCommand(
    _signal: AbortSignal | undefined,
    shell: string,
    cmd: string,
    opts: ExecOpts,
  ): CommandSpec {
    const spec: CommandSpec = {
      program: shell,
      args: shellArgs(shell, cmd),
    };
    if (opts.workDir) spec.cwd = opts.workDir;

    // Inherit full parent environment, then overlay opts.envVars.
    const env = Object.entries(runtime.env.toObject()).map(
      ([k, v]) => `${k}=${v}`,
    );
    for (const [k, v] of Object.entries(opts.envVars ?? {})) {
      const prefix = `${k}=`;
      const idx = env.findIndex((e) => e.startsWith(prefix));
      if (idx >= 0) env[idx] = `${k}=${v}`;
      else env.push(`${k}=${v}`);
    }
    spec.env = env;
    return spec;
  }

  isAvailable(): boolean {
    return true;
  }

  name(): string {
    return "none";
  }

  level(): Level {
    return Level.None;
  }
}

/** Creates a new no-op sandbox. */
export function createNoneSandbox(): NoneSandbox {
  return new NoneSandbox();
}
