// Public surface of src/sandbox (ported from internal/sandbox).

export {
  type AvailabilityErrorProvider,
  type CommandCleanupProvider,
  type CommandSpec,
  type ExecOpts,
  formatSandboxInfo,
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
  normalizeTmpSize,
  parseTmpSize,
  pathsOverlap,
} from "./policy.ts";
export {
  contextWithGitAccess,
  gitAccessFromContext,
  gitAccessRequired,
  isGitDeniedPath,
} from "./git.ts";
export { protectedGitPaths, uniquePaths } from "./git_paths.ts";
export { newNoneSandbox, NoneSandbox } from "./none.ts";
export {
  type BwrapCapabilities,
  bwrapCapabilitiesComplete,
  BwrapSandbox,
  findBwrap,
  newBwrapSandbox,
  newBwrapSandboxWithOptions,
  probeBwrapCapabilities,
} from "./bwrap.ts";
export { MacSandbox, newMacSandbox, newMacSandboxWithOptions } from "./mac.ts";
export { newWinSandbox, WinSandbox } from "./windows.ts";
export {
  newPlatformSandbox,
  newPlatformSandboxWithOptions,
} from "./platform.ts";
