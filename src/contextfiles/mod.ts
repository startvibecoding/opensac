// Public surface of src/contextfiles (ported from internal/contextfiles).

export {
  buildContextString,
  defaultRuleContent,
  ensureRuleFile,
  type FileContent,
  loadContextFiles,
  type LoadResult,
  loadRuleFile,
  ruleFile,
  ruleFilePath,
  safeContextFilePath,
  wellKnownFiles,
} from "./contextfiles.ts";
