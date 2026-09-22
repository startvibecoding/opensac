// Public surface of src/tools (ported from internal/tools).

export {
  BashTool,
  isValidShell,
  newBashTool,
  newBashToolWithJobManager,
} from "./bash.ts";
export { EditTool } from "./edit.ts";
export {
  defaultFileLockManager,
  FileLockManager,
  newFileLockManager,
} from "./file_lock.ts";
export { FindTool } from "./find.ts";
export {
  type Glob,
  globMatch,
  GlobSet,
  globToRegex,
  newGlob,
} from "./globset.ts";
export { GrepTool } from "./grep.ts";
export { ImageGenerationTool } from "./image_generation.ts";
export { type IgnoreLevel, IgnoreStack, parseIgnoreFile } from "./ignore.ts";
export { InsertTool } from "./insert.ts";
export {
  buildFileDiff,
  type FileDiff,
  formatFileDiffSummary,
  formatWriteDiffSummary,
  writeFileAtomic,
  writeFileAtomicWithMode,
} from "./io_helpers.ts";
export {
  BackgroundJob,
  formatGoDuration,
  JobManager,
  newJobManager,
} from "./jobmanager.ts";
export { JobsTool } from "./jobstool.ts";
export { KillTool } from "./killtool.ts";
export { LsTool } from "./ls.ts";
export { PlanTool } from "./plan.ts";
export { type QuestionAsker, QuestionTool } from "./question.ts";
export { ReadTool } from "./read.ts";
export { SkillRefTool } from "./skill_ref.ts";
export {
  contextWithOperationID,
  contextWithQuestionAsker,
  type ExecutionTimeoutProvider,
  type InsertResult,
  newDiffToolResult,
  newImageToolResult,
  newImageToolResultWithContent,
  newInsertToolResult,
  newPlanToolResult,
  newRegistry,
  newRegistryWithConfig,
  newTextToolResult,
  operationIDFromContext,
  type PlanStep,
  questionAskerFromContext,
  Registry,
  type RegistryConfig,
  type TaskPlan,
  type Tool,
  type ToolContext,
  toolDefinition,
  type ToolResult,
} from "./tool.ts";
export { WriteTool } from "./write.ts";
