import * as path from "../compat/path.ts";

/**
 * Filesystem locations owned by the Core discovery/lock subsystem.
 *
 * Constructing this value is intentionally side-effect free. In particular,
 * callers can discover whether a state root exists before deciding to create
 * it for a write or a lock acquisition.
 */
export class CorePaths {
  readonly stateDir: string;
  readonly registrationFile: string;
  readonly lockFile: string;

  private constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.registrationFile = path.join(stateDir, "core.json");
    this.lockFile = path.join(stateDir, "core.lock");
  }

  /** Creates the Core paths for a state directory without touching disk. */
  static fromStateDir(stateDir: string): CorePaths {
    if (typeof stateDir !== "string" || stateDir.trim() === "") {
      throw new TypeError("Core state directory is required");
    }
    return new CorePaths(path.normalize(stateDir));
  }
}
