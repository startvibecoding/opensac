// Public surface of src/skills (ported from internal/skills).

export { builtinFS, createBuiltinFS } from "./builtin.ts";
export { builtinFiles } from "./builtin_content.ts";
export {
  createManager,
  createManagerWithProjectDirs,
  createProjectSkillsDir,
  expertCreaterSkillName,
  extractDescription,
  Manager,
  parseReferences,
  projectSkillDirs,
  type Skill,
  type SkillFS,
  type SkillFSEntry,
  type SkillReference,
} from "./skills.ts";
