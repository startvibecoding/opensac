// Public surface of src/sandbox (ported from internal/sandbox).

export {
  type AvailabilityErrorProvider,
  type CommandCleanupProvider,
  type CommandSpec,
  createManager,
  type ExecOpts,
  formatSandboxInfo,
  type GitAccessSandbox,
  Level,
  levelString,
  Manager,
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
export { createNoneSandbox, NoneSandbox } from "./none.ts";
export {
  type BwrapCapabilities,
  bwrapCapabilitiesComplete,
  BwrapSandbox,
  createBwrapSandbox,
  findBwrap,
  probeBwrapCapabilities,
} from "./bwrap.ts";
export { createMacSandbox, MacSandbox } from "./mac.ts";
export { createWinSandbox, WinSandbox } from "./windows.ts";
export { createPlatformSandbox } from "./platform.ts";
