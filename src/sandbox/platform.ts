//
// The dedicated bwrap (Linux), seatbelt (macOS), and Windows backends are
// selected here. Platforms without a dedicated backend fall back to the no-op
// sandbox so commands run without sandbox restrictions.

import { type Options, type Sandbox } from "./sandbox.ts";
import { Level } from "./sandbox.ts";
import { createBwrapSandbox } from "./bwrap.ts";
import { createMacSandbox } from "./mac.ts";
import { createWinSandbox } from "./windows.ts";
import { createNoneSandbox } from "./none.ts";

/**
 * Creates the platform-specific sandbox for the current OS (default policy
 * unless `opts` is given).
 */
export function createPlatformSandbox(
  projectDir: string,
  level: Level,
  opts: Options = {},
): Sandbox {
  switch (Deno.build.os) {
    case "linux":
      return createBwrapSandbox(projectDir, level, opts);
    case "darwin":
      return createMacSandbox(projectDir, level, opts);
    case "windows":
      return createWinSandbox(projectDir, level);
    default:
      // Platforms without a dedicated backend (e.g. FreeBSD) run unsandboxed.
      return createNoneSandbox();
  }
}
