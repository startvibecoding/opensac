// Public surface of src/skills (ported from internal/skills).

export { builtinFS, createBuiltinFS } from "./builtin.ts";
export { builtinFiles } from "./builtin_content.ts";
export {
  createProjectSkillsDir,
  expertCreaterSkillName,
  extractDescription,
  Manager,
  newManager,
  newManagerWithProjectDirs,
  parseReferences,
  projectSkillDirs,
  type Skill,
  type SkillFS,
  type SkillFSEntry,
  type SkillReference,
} from "./skills.ts";
