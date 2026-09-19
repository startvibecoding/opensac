// Public surface of src/dao (ported from internal/dao).
//
// DAOs own table names, column mappings, and query construction. Domain code
// depends on these methods instead of issuing SQL directly.

export {
  Database,
  ErrNoRows,
  execChanges,
  execReturning,
  type Executor,
  inList,
  isNoRows,
  nullable,
  type Param,
  queryAll,
  queryOne,
  queryOptional,
  type Row,
  sqlBool,
  type Tx,
  wrapDatabase,
  wrapStandaloneDatabase,
} from "./database.ts";

export {
  AttachmentDAO,
  type AttachmentRecord,
  type AttachmentStorageReference,
  isNoRowsAttachment,
} from "./attachments.ts";

export {
  BindingDAO,
  type BindingRecord,
  type ChannelToolGenerationRecord,
  type ChannelToolRecord,
} from "./bindings.ts";

export {
  ConversationTurnDAO,
  type ConversationTurnRecord,
  type ConversationTurnState,
  type EntryRecord,
} from "./conversation_turn.ts";

export { CronDAO, type CronJobRecord } from "./cron.ts";

export {
  DeliveryDAO,
  deliveryFailureLimitMax,
  type DeliveryFailureRecord,
  type DeliveryIntentRecord,
  type DeliveryOperationRecord,
  isTransientDeliveryFailure,
} from "./delivery.ts";

export { ESMDAO, type ESMObjectiveRecord } from "./esm.ts";

export {
  ESMGuidanceDAO,
  type ESMGuidanceRecord,
  isNoRowsGuidance,
} from "./esm_guidance.ts";

export {
  ForkDAO,
  type ForkEntryRecord,
  type ForkFingerprintRecord,
  type ForkRequestRecord,
  type ForkRunWindowRecord,
  type ForkSessionRecord,
} from "./fork.ts";

export {
  InputResourceDAO,
  type InputResourceEventRecord,
  type InputResourceRecord,
  isNoRowsInput,
} from "./input_resources.ts";

export {
  KnowledgeBaseDAO,
  type KnowledgeBaseRecord,
  type KnowledgeChunkRecord,
  type KnowledgeEdgeRecord,
  type KnowledgeEvidenceRecord,
  type KnowledgeFileRecord,
  knowledgeFTSHasTokenRune,
  KnowledgeFTSIndexText,
  knowledgeFTSIndexText,
  knowledgeFTSQuery,
  type KnowledgeGraphProjection,
  knowledgeIsFTSCJK,
  type KnowledgeNodeRecord,
  type KnowledgeSnapshotRecord,
} from "./knowledge_bases.ts";

export {
  ProjectDAO,
  type ProjectRecord,
  type SessionMetadataRecord,
} from "./projects.ts";

export {
  type OpenTurnRecord,
  RecoveryDAO,
  type RecoveryRecord,
} from "./recovery.ts";

export {
  isNoRowsResponse,
  ResponseDAO,
  type ResponseItemRecord,
  type ResponseReplayItemRecord,
  type ResponseRunRecord,
  type ResponseSessionStateRecord,
  type ResponseTurnRecord,
  type ToolExecutionRecord,
} from "./response.ts";

export {
  type ExecutionIntentRecord,
  isNoRowsRun,
  RunDAO,
  type SessionRunEventRecord,
  type SessionRunRecord,
} from "./run.ts";

export {
  isNoRows as isNoRowsRuntimeSubmission,
  RuntimeSubmissionDAO,
  type RuntimeSubmissionRecord,
} from "./runtime_submission.ts";

export { RuntimeLeaseDAO, type RuntimeLeaseRecord } from "./runtime_lease.ts";

export {
  isNoRowsSession,
  type SessionCapabilityEventRecord,
  type SessionCapabilityRecord,
  SessionDAO,
  type SessionDetailAggregates,
  type SessionListFilter,
  type SessionRecord,
} from "./session.ts";

export {
  type StatsAggregateRecord,
  statsBucketExpr,
  StatsDAO,
  type StatsFilter,
  type StatsRecord,
  type StatsSummaryRecord,
} from "./stats.ts";
