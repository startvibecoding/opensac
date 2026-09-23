// Public surface of src/expert (ported from internal/expert).

export {
  type AgentDef,
  type Bundle,
  createFrontmatter,
  expertSchemaVersion,
  type Frontmatter,
  type LocalizedText,
  type Manifest,
  type MemberMeta,
  roleLead,
  roleMember,
  sourceBuiltin,
  sourceGlobal,
  sourceProject,
  type Summary,
  type TeamInfo,
  typeAgent,
  typeTeam,
} from "./expert.ts";
export {
  cleanSlashPath,
  createMemoryFS,
  type ExpertFS,
  type ExpertFSEntry,
} from "./fs.ts";
export { builtinFS, createBuiltinFS } from "./builtin.ts";
export { builtinFiles } from "./builtin_content.ts";
export {
  agentsDirName,
  applyDisplayNames,
  assignRoles,
  type BundleSource,
  listAgentIDs,
  loadAgentDef,
  loadBundle,
  loadBundleFS,
  manifestFileName,
  normalizeManifest,
  skillsDirName,
  validateManifest,
  validateStructure,
  validModes,
} from "./bundle.ts";
export {
  collectBlockList,
  parseFrontmatter,
  parseFrontmatterFields,
  parseInlineList,
  splitLines,
  unquote,
} from "./frontmatter.ts";
export {
  Center,
  globalExpertsDir,
  listOSLayer,
  summaryFromManifest,
  validateBundleName,
  validateBundleNameOrThrow,
} from "./center.ts";
export {
  type ManagedBundle,
  Manager,
  type Scope,
  SCOPE_GLOBAL,
  SCOPE_PROJECT,
  validateAgentID,
} from "./manage.ts";
