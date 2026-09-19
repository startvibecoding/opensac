// Ported from internal/sandbox/platform_{linux,darwin,windows,other}.go
//
// The dedicated bwrap (Linux), seatbelt (macOS), and Windows backends are
// selected here. Platforms without a dedicated backend fall back to the no-op
// sandbox so commands run without sandbox restrictions.

import type { Options, Sandbox } from "./sandbox.ts";
import { Level } from "./sandbox.ts";
import { newBwrapSandboxWithOptions } from "./bwrap.ts";
import { newMacSandboxWithOptions } from "./mac.ts";
import { newWinSandbox } from "./windows.ts";
import { newNoneSandbox } from "./none.ts";

/** Creates the platform-specific sandbox for the current OS. */
export function newPlatformSandbox(
  projectDir: string,
  level: Level,
): Sandbox {
  return newPlatformSandboxWithOptions(projectDir, level, {});
}

export function newPlatformSandboxWithOptions(
  projectDir: string,
  level: Level,
  opts: Options,
): Sandbox {
  switch (Deno.build.os) {
    case "linux":
      return newBwrapSandboxWithOptions(projectDir, level, opts);
    case "darwin":
      return newMacSandboxWithOptions(projectDir, level, opts);
    case "windows":
      return newWinSandbox(projectDir, level);
    default:
      // Platforms without a dedicated backend (e.g. FreeBSD) run unsandboxed.
      return newNoneSandbox();
  }
}
