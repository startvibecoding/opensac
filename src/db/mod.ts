// Public surface of src/db (ported from internal/db).

export {
  attemptWhileBusy,
  BUSY_TIMEOUT_MS,
  canonicalPath,
  close,
  closeAll,
  DB,
  MigrationFailedError,
  type Migrator,
  open,
  openReadOnlyStandalone,
  openStandalone,
  openWithOptions,
  type Options,
  query,
  runInTx,
  write,
} from "./db.ts";
export {
  beginWaitStats,
  busyRetryStats,
  isSQLiteBusy,
  isSQLiteReadOnly,
  recordBeginWait,
  sqliteResultCode,
} from "./busy.ts";
export {
  describeIndexRepair,
  type IndexRepair,
  recordIndexRepair,
  takeIndexRepairs,
} from "./repair.ts";
export {
  describeMigrationRecovery,
  isSchemaIncompatible,
  migrationRecoveries,
  type MigrationRecovery,
  recoverFromMigrationFailure,
  removeDatabaseFiles,
  schemaIncompatible,
  setMigrationRecoveryNotifier,
  takeMigrationRecoveries,
} from "./recovery.ts";
export { SQLITE_EXPVAR_KEY, sqliteStatsSnapshot } from "./stats.ts";
export {
  queryStats,
  recordQueryTiming,
  resetQueryStats,
  slowQueryThresholdMs,
} from "./query_stats.ts";
