// Public surface of src/sandbox (ported from internal/sandbox).

export {
  type AvailabilityErrorProvider,
  type CommandCleanupProvider,
  type CommandSpec,
  type ExecOpts,
  type GitAccessSandbox,
  Level,
  levelString,
  Manager,
  newManager,
  newManagerWithOptions,
  type Options,
  parseLevel,
  type Sandbox,
} from "./sandbox.ts";
export {
  canonicalSandboxPath,
  normalizeOptions,
  parseTmpSize,
  pathsOverlap,
} from "./policy.ts";
export {
  contextWithGitAccess,
  gitAccessFromContext,
  gitAccessRequired,
  isGitDeniedPath,
} from "./git.ts";
export { newNoneSandbox, NoneSandbox } from "./none.ts";
export {
  newPlatformSandbox,
  newPlatformSandboxWithOptions,
} from "./platform.ts";
