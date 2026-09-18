// Ported from internal/sandbox/platform_{linux,darwin,windows,other}.go
//
// The dedicated bwrap (Linux), seatbelt (macOS), and Windows backends are not
// ported yet. To avoid silently running unsandboxed, this dispatch returns a
// backend that reports itself unavailable, so strict mode fails loudly and
// standard mode falls back to direct execution exactly as the Go manager does.

import type { Options, Sandbox } from "./sandbox.ts";
import { Level } from "./sandbox.ts";
import { newNoneSandbox } from "./none.ts";

/** A backend that is not yet ported; reports itself unavailable. */
class PendingSandbox implements Sandbox {
  #name: string;
  constructor(name: string) {
    this.#name = name;
  }
  wrapCommand(): never {
    throw new Error(`sandbox backend ${this.#name} is not available`);
  }
  isAvailable(): boolean {
    return false;
  }
  availabilityError(): Error {
    return new Error(`sandbox backend ${this.#name} is not yet ported to Deno`);
  }
  name(): string {
    return this.#name;
  }
  level(): Level {
    return Level.Standard;
  }
}

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
  void projectDir;
  void level;
  void opts;
  switch (Deno.build.os) {
    case "linux":
      return new PendingSandbox("bwrap");
    case "darwin":
      return new PendingSandbox("seatbelt");
    case "windows":
      return new PendingSandbox("windows");
    default:
      // Platforms without a dedicated backend fall back to the no-op sandbox.
      return newNoneSandbox();
  }
}
