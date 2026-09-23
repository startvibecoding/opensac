// Public surface of src/esm (ported from internal/esm).
//
// Enable Supervisor Mode (ESM): the durable per-session objective store, the
// canonical role-report parsing/application semantics, the steering source, the
// model-facing tools, and the front-end-neutral Supervisor runtime.

export {
  blockedAuditLimit,
  canAutoRun,
  hasObjective,
  isRunnableStatus,
  isUnfinishedStatus,
  type Objective,
  type Phase,
  phaseAudit,
  phaseComplete,
  phaseCritic,
  phaseWorker,
  type Status,
  statusActive,
  statusBlocked,
  statusComplete,
  statusCompleteCandidate,
  statusPaused,
  statusUsageLimited,
} from "./state.ts";

export {
  type AuditReport,
  auditVerdictFail,
  auditVerdictPass,
  extractJSONObject,
  parseAuditReport,
  parseRecoveryReport,
  parseWorkerReport,
  recoveryDecisionBlocked,
  recoveryDecisionResume,
  type RecoveryReport,
  trimStringSlice,
  type WorkerReport,
  workerStatusBlockedCandidate,
  workerStatusCompleteCandidate,
  workerStatusContinue,
} from "./report.ts";

export {
  EsmInvalidObjectiveError,
  EsmInvalidTransitionError,
  EsmObjectiveExistsError,
  EsmObjectiveNotFoundError,
  formatTime,
  isUsageLimitError,
  type Store,
} from "./store.ts";
export { Store as ESMStore } from "./store.ts";
export { formatGuidanceSuffix } from "./guidance.ts";
export { EvidenceTracker, finalAssistantResponse } from "./evidence.ts";
export {
  SteeringSource,
  SteeringSource as ESMSteeringSource,
} from "./steering.ts";
export {
  auditTaskPrompt,
  continuationMessage,
  continuationPrompt,
  criticTaskPrompt,
  escapeXMLText,
  recoveryObserverTaskPrompt,
  steeringMessage,
  steeringPrompt,
  workerTaskPrompt,
} from "./prompt.ts";
export {
  createGetTool,
  createUpdateTool,
  formatObjective,
  type RunIDFunc,
  type SessionIDFunc,
} from "./tools.ts";
export {
  type ApplyResult,
  applyReviewResult,
  applyWorkerResult,
  formatAuditReview,
  formatItemDetail,
  formatReportParts,
  formatWorkerBlocker,
  formatWorkerCompletion,
  invalidSupervisorPassReason,
  invalidWorkerCandidateReason,
  type Outcome,
  type RoleResult,
  titleESMRole,
  workerContinueMessage,
  workerOutstandingWork,
} from "./supervisor.ts";
export {
  compactESMError,
  createRoleIncompleteError,
  EsmCanceledError,
  EsmDeadlineExceededError,
  EsmRoleIncompleteError,
  isCanceled,
  isDeadlineExceeded,
  isRoleIncomplete,
  longTaskMaxIterations,
  recoveryObserverTimeout,
  type Role,
  roleAudit,
  roleContext,
  roleCritic,
  RoleIncompleteError,
  roleRecovery,
  type RoleRequest,
  type RoleScope,
  roleTimeout,
  roleWorker,
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeEventSink,
  Supervisor,
  type SupervisorResult,
} from "./runtime_core.ts";
