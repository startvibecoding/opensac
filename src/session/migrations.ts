//
// Schema migration owner. Migrations are applied in ascending version order
// regardless of their position in this list; new migrations must always append
// a fresh, monotonically increasing version at the end.

import type { SQLInputValue } from "node:sqlite";
import { type DB, runInTx } from "../db/mod.ts";
import { knowledgeFTSIndexText } from "../dao/knowledge_bases.ts";
import { nonTerminalSessionRunStatusSQL } from "./run_status.ts";

export const CURRENT_SCHEMA_VERSION = 43;

interface SchemaMigration {
  version: number;
  name: string;
  apply: (conn: DB) => void;
}

const schemaMigrations: SchemaMigration[] = [
  {
    version: 35,
    name: "create_input_resource_events",
    apply: (conn) => {
      conn.exec(`CREATE TABLE IF NOT EXISTS input_resource_events (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			resource_id TEXT NOT NULL REFERENCES input_resources(id) ON DELETE CASCADE,
			run_id TEXT NOT NULL DEFAULT '',
			event_type TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT '',
			timestamp TEXT NOT NULL,
			data TEXT NOT NULL DEFAULT '{}'
		)`);
      conn.exec(
        `CREATE INDEX IF NOT EXISTS idx_input_resource_events_resource
			ON input_resource_events(resource_id, timestamp)`,
      );
      conn.exec(
        `CREATE INDEX IF NOT EXISTS idx_input_resource_events_session
			ON input_resource_events(session_id, timestamp)`,
      );
    },
  },
  {
    version: 34,
    name: "create_delivery_intents_and_operations",
    apply: (conn) => {
      conn.exec(`CREATE TABLE IF NOT EXISTS delivery_intents (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			run_id TEXT NOT NULL REFERENCES session_runs(id) ON DELETE CASCADE,
			platform TEXT NOT NULL,
			target_id TEXT NOT NULL DEFAULT '',
			reply_message_id TEXT NOT NULL DEFAULT '',
			transport_context TEXT NOT NULL DEFAULT '{}',
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE(run_id, platform, target_id)
		)`);
      conn.exec(
        `CREATE INDEX IF NOT EXISTS idx_delivery_intents_session_status
			ON delivery_intents(session_id, status, updated_at)`,
      );
      conn.exec(`CREATE TABLE IF NOT EXISTS delivery_operations (
			id TEXT PRIMARY KEY,
			intent_id TEXT NOT NULL REFERENCES delivery_intents(id) ON DELETE CASCADE,
			operation_key TEXT NOT NULL,
			artifact_id TEXT REFERENCES session_attachments(id) ON DELETE RESTRICT,
			operation_kind TEXT NOT NULL,
			sequence INTEGER NOT NULL,
			depends_on TEXT REFERENCES delivery_operations(id) ON DELETE RESTRICT,
			idempotency_key TEXT NOT NULL,
			payload_digest TEXT NOT NULL,
			status TEXT NOT NULL,
			provider_asset_id TEXT NOT NULL DEFAULT '',
			provider_message_id TEXT NOT NULL DEFAULT '',
			provider_state TEXT NOT NULL DEFAULT '{}',
			attempt_count INTEGER NOT NULL DEFAULT 0,
			next_attempt_at INTEGER,
			failure_code TEXT NOT NULL DEFAULT '',
			lease_owner TEXT NOT NULL DEFAULT '',
			lease_epoch INTEGER NOT NULL DEFAULT 0,
			lease_expires_at INTEGER,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE(intent_id, operation_key),
			UNIQUE(intent_id, sequence)
		)`);
      conn.exec(
        `CREATE INDEX IF NOT EXISTS idx_delivery_operations_claim
			ON delivery_operations(status, next_attempt_at, lease_expires_at, sequence)`,
      );
    },
  },
  {
    version: 33,
    name: "create_runtime_submissions",
    apply: (conn) => {
      conn.exec(`CREATE TABLE IF NOT EXISTS runtime_submissions (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			scope TEXT NOT NULL,
			key_hash TEXT NOT NULL,
			request_fingerprint TEXT NOT NULL DEFAULT '',
			intent_id TEXT NOT NULL REFERENCES session_execution_intents(id) ON DELETE CASCADE,
			run_id TEXT NOT NULL REFERENCES session_runs(id) ON DELETE CASCADE,
			created_at TEXT NOT NULL,
			UNIQUE(session_id, scope, key_hash)
		)`);
      conn.exec(
        `CREATE INDEX IF NOT EXISTS idx_runtime_submissions_run
			ON runtime_submissions(run_id)`,
      );
      conn.exec(
        `CREATE INDEX IF NOT EXISTS idx_runtime_submissions_intent
			ON runtime_submissions(intent_id)`,
      );
    },
  },
  {
    version: 32,
    name: "create_input_resources",
    apply: (conn) => {
      conn.exec(`CREATE TABLE IF NOT EXISTS input_resources (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			run_id TEXT NOT NULL DEFAULT '',
			origin TEXT NOT NULL DEFAULT '',
			event_id TEXT NOT NULL DEFAULT '',
			item_index INTEGER NOT NULL DEFAULT 0,
			item_key TEXT NOT NULL DEFAULT '',
			kind TEXT NOT NULL,
			filename TEXT NOT NULL DEFAULT '',
			media_type TEXT NOT NULL DEFAULT '',
			byte_size INTEGER NOT NULL DEFAULT 0,
			sha256 TEXT NOT NULL DEFAULT '',
			relative_path TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			metadata TEXT NOT NULL DEFAULT '{}'
		)`);
      conn.exec(
        `CREATE INDEX IF NOT EXISTS idx_input_resources_session
			ON input_resources(session_id, created_at)`,
      );
      conn.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_input_resources_item_key
			ON input_resources(session_id, item_key) WHERE item_key <> ''`,
      );
    },
  },
  {
    version: 31,
    name: "create_session_run_recoveries",
    apply: (conn) => {
      conn.exec(`CREATE TABLE IF NOT EXISTS session_run_recoveries (
			run_id TEXT PRIMARY KEY REFERENCES session_runs(id) ON DELETE CASCADE,
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			state TEXT NOT NULL,
			trigger_source TEXT NOT NULL DEFAULT '',
			reason_code TEXT NOT NULL DEFAULT '',
			attempt INTEGER NOT NULL DEFAULT 0,
			previous_lease_epoch INTEGER NOT NULL DEFAULT 0,
			last_error TEXT NOT NULL DEFAULT '',
			next_retry_at INTEGER,
			started_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			completed_at INTEGER
		)`);
      conn.exec(
        `CREATE INDEX IF NOT EXISTS idx_session_run_recoveries_due
			ON session_run_recoveries(state, next_retry_at)`,
      );
    },
  },
  {
    version: 30,
    name: "create_session_attachments_and_deliveries",
    apply: (conn) => {
      conn.exec(`CREATE TABLE IF NOT EXISTS session_attachments (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			run_id TEXT NOT NULL DEFAULT '',
			origin TEXT NOT NULL DEFAULT '',
			kind TEXT NOT NULL,
			filename TEXT NOT NULL DEFAULT '',
			media_type TEXT NOT NULL DEFAULT '',
			byte_size INTEGER NOT NULL DEFAULT 0,
			sha256 TEXT NOT NULL DEFAULT '',
			storage_key TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			metadata TEXT NOT NULL DEFAULT '{}'
		)`);
      conn.exec(
        `CREATE INDEX IF NOT EXISTS idx_session_attachments_session
			ON session_attachments(session_id, created_at)`,
      );
      conn.exec(`CREATE TABLE IF NOT EXISTS attachment_deliveries (
			id TEXT PRIMARY KEY,
			attachment_id TEXT NOT NULL REFERENCES session_attachments(id) ON DELETE CASCADE,
			run_id TEXT NOT NULL DEFAULT '',
			platform TEXT NOT NULL,
			target_id TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL,
			provider_message_id TEXT NOT NULL DEFAULT '',
			failure_code TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`);
      conn.exec(
        `CREATE INDEX IF NOT EXISTS idx_attachment_deliveries_attachment
			ON attachment_deliveries(attachment_id, updated_at)`,
      );
    },
  },
  {
    version: 29,
    name: "add_session_fork_and_runtime_lease_state",
    apply: (conn) => {
      if (tableExists(conn, "sessions")) {
        for (
          const column of [
            {
              name: "fork_boundary_seq",
              definition: "INTEGER NOT NULL DEFAULT 0",
            },
            { name: "seed_length", definition: "INTEGER NOT NULL DEFAULT 0" },
            { name: "fork_kind", definition: "TEXT NOT NULL DEFAULT ''" },
          ]
        ) {
          addColumnIfMissing(conn, "sessions", column.name, column.definition);
        }
      }
      if (tableExists(conn, "sub_session")) {
        for (
          const column of ["fork_boundary_seq", "seed_length", "fork_kind"]
        ) {
          const definition = column !== "fork_kind"
            ? "INTEGER NOT NULL DEFAULT 0"
            : "TEXT NOT NULL DEFAULT ''";
          addColumnIfMissing(conn, "sub_session", column, definition);
        }
      }
      if (tableExists(conn, "session_capabilities")) {
        addColumnIfMissing(
          conn,
          "session_capabilities",
          "display_mode",
          "TEXT NOT NULL DEFAULT 'work'",
        );
      }
      conn.exec(`CREATE TABLE IF NOT EXISTS conversation_turns (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			intent_id TEXT NOT NULL DEFAULT '',
			kind TEXT NOT NULL DEFAULT 'conversation',
			status TEXT NOT NULL,
			start_seq INTEGER NOT NULL,
			end_seq INTEGER,
			started_at TEXT NOT NULL,
			ended_at TEXT
		)`);
      conn.exec(
        `CREATE INDEX IF NOT EXISTS idx_conversation_turns_session ON conversation_turns(session_id, start_seq)`,
      );
      conn.exec(
        `CREATE INDEX IF NOT EXISTS idx_conversation_turns_open ON conversation_turns(session_id, status)`,
      );
      conn.exec(`CREATE TABLE IF NOT EXISTS session_fork_requests (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			request_key_hash TEXT NOT NULL,
			request_fingerprint TEXT NOT NULL,
			source_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			child_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			created_at TEXT NOT NULL,
			UNIQUE(request_key_hash, source_session_id)
		)`);
      conn.exec(`CREATE TABLE IF NOT EXISTS session_runtime_leases (
			session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
			owner_instance_id TEXT NOT NULL,
			owner_pid INTEGER NOT NULL,
			owner_kind TEXT NOT NULL,
			lease_token_hash TEXT NOT NULL,
			epoch INTEGER NOT NULL,
			run_id TEXT NOT NULL DEFAULT '',
			purpose TEXT NOT NULL,
			state TEXT NOT NULL,
			acquired_at INTEGER NOT NULL,
			heartbeat_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`);
      conn.exec(
        `CREATE INDEX IF NOT EXISTS idx_session_runtime_leases_expiry ON session_runtime_leases(expires_at)`,
      );
    },
  },
  {
    version: 28,
    name: "add_run_context_usage",
    apply: (conn) => {
      if (!tableExists(conn, "session_runs")) return;
      addColumnIfMissing(
        conn,
        "session_runs",
        "context_usage_json",
        "TEXT NOT NULL DEFAULT '{}'",
      );
    },
  },
  {
    version: 27,
    name: "add_run_retry_metadata",
    apply: (conn) => {
      if (!tableExists(conn, "session_runs")) {
        conn.exec(`CREATE TABLE session_runs (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				intent_id TEXT NOT NULL DEFAULT '',
				retry_of TEXT NOT NULL DEFAULT '',
				attempt INTEGER NOT NULL DEFAULT 1,
				work_dir TEXT NOT NULL DEFAULT '',
				source TEXT NOT NULL DEFAULT '',
				model TEXT NOT NULL DEFAULT '',
				mode TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL,
				started_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				finished_at TEXT,
				error TEXT NOT NULL DEFAULT '',
				error_info_json TEXT NOT NULL DEFAULT '{}',
				progress_json TEXT NOT NULL DEFAULT '{}',
				usage_json TEXT NOT NULL DEFAULT '{}',
				context_usage_json TEXT NOT NULL DEFAULT '{}'
			)`);
      }
      for (
        const column of [
          { name: "intent_id", definition: "TEXT NOT NULL DEFAULT ''" },
          { name: "retry_of", definition: "TEXT NOT NULL DEFAULT ''" },
          { name: "attempt", definition: "INTEGER NOT NULL DEFAULT 1" },
          { name: "error_info_json", definition: "TEXT NOT NULL DEFAULT '{}'" },
          { name: "progress_json", definition: "TEXT NOT NULL DEFAULT '{}'" },
          {
            name: "context_usage_json",
            definition: "TEXT NOT NULL DEFAULT '{}'",
          },
        ]
      ) {
        addColumnIfMissing(
          conn,
          "session_runs",
          column.name,
          column.definition,
        );
      }
      conn.exec(
        `CREATE INDEX IF NOT EXISTS idx_session_runs_intent ON session_runs(session_id, intent_id, attempt)`,
      );
      conn.exec(`DROP INDEX IF EXISTS idx_session_runs_active_session`);
      conn.exec(
        `CREATE UNIQUE INDEX idx_session_runs_active_session ON session_runs(session_id) WHERE status IN (${nonTerminalSessionRunStatusSQL()})`,
      );
      conn.exec(`CREATE TABLE IF NOT EXISTS session_execution_intents (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			source TEXT NOT NULL DEFAULT '',
			model TEXT NOT NULL DEFAULT '',
			mode TEXT NOT NULL DEFAULT '',
			work_dir TEXT NOT NULL DEFAULT '',
			request_fingerprint TEXT NOT NULL DEFAULT '',
			request_json TEXT NOT NULL DEFAULT '{}',
			policy_json TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL
		)`);
      conn.exec(
        `CREATE INDEX IF NOT EXISTS idx_session_execution_intents_session_id ON session_execution_intents(session_id, created_at)`,
      );
    },
  },
  {
    version: 26,
    name: "add_session_display_mode",
    apply: (conn) => {
      if (!tableExists(conn, "session_capabilities")) return;
      addColumnIfMissing(
        conn,
        "session_capabilities",
        "display_mode",
        "TEXT NOT NULL DEFAULT 'work'",
      );
    },
  },
  {
    version: 25,
    name: "create_projects_and_session_metadata",
    apply: (conn) => {
      conn.exec(`CREATE TABLE IF NOT EXISTS projects (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`);
      conn.exec(`CREATE TABLE IF NOT EXISTS session_metadata (
			session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
			project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
						pinned INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL
		)`);
      conn.exec(
        `CREATE INDEX IF NOT EXISTS idx_session_metadata_project ON session_metadata(project_id, pinned, updated_at)`,
      );
    },
  },
  {
    version: 24,
    name: "index_entries_session_type",
    apply: (conn) => {
      conn.exec(
        `CREATE INDEX IF NOT EXISTS idx_entries_session_type ON entries(session_id, type)`,
      );
    },
  },
  {
    version: 23,
    name: "create_esm_guidance",
    apply: (conn) => {
      conn.exec(`CREATE TABLE IF NOT EXISTS session_esm_guidance (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			objective_version TEXT NOT NULL DEFAULT '',
			guidance TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			created_at TEXT NOT NULL,
			consumed_at TEXT
		)`);
      conn.exec(
        `CREATE INDEX IF NOT EXISTS idx_esm_guidance_session_status ON session_esm_guidance(session_id, status, created_at)`,
      );
    },
  },
  {
    version: 16,
    name: "add_channel_binding_columns",
    apply: (conn) => {
      for (const table of ["sessions", "sub_session"]) {
        if (!tableExists(conn, table)) continue;
        addColumnIfMissing(
          conn,
          table,
          "channel_type",
          "TEXT NOT NULL DEFAULT 'local'",
        );
        addColumnIfMissing(
          conn,
          table,
          "channel_id",
          "TEXT NOT NULL DEFAULT ''",
        );
      }
      conn.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_wechat_binding ON sessions(channel_type, channel_id) WHERE channel_type = 'wechat' AND channel_id <> ''`,
      );
      conn.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_feishu_binding ON sessions(channel_type, channel_id) WHERE channel_type = 'feishu' AND channel_id <> ''`,
      );
    },
  },
  {
    version: 17,
    name: "create_session_channel_tools",
    apply: (conn) => {
      conn.exec(`CREATE TABLE IF NOT EXISTS session_channel_tools (
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				tool_name TEXT NOT NULL,
				enabled INTEGER NOT NULL DEFAULT 1,
				updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				PRIMARY KEY (session_id, tool_name)
			)`);
      conn.exec(
        `CREATE INDEX IF NOT EXISTS idx_session_channel_tools_session_id ON session_channel_tools(session_id)`,
      );
    },
  },
  {
    version: 18,
    name: "create_session_runs",
    apply: (conn) => {
      conn.exec(`CREATE TABLE IF NOT EXISTS session_runs (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			work_dir TEXT NOT NULL DEFAULT '',
			source TEXT NOT NULL DEFAULT '',
			model TEXT NOT NULL DEFAULT '',
			mode TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL,
			started_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			finished_at TEXT,
			error TEXT NOT NULL DEFAULT '',
			usage_json TEXT NOT NULL DEFAULT '{}'
		)`);
      conn.exec(
        `CREATE INDEX IF NOT EXISTS idx_session_runs_session_id ON session_runs(session_id)`,
      );
      conn.exec(
        `CREATE INDEX IF NOT EXISTS idx_session_runs_status ON session_runs(status)`,
      );
      conn.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_session_runs_active_session ON session_runs(session_id) WHERE status IN (${nonTerminalSessionRunStatusSQL()})`,
      );
    },
  },
  {
    version: 19,
    name: "create_response_runtime_tables",
    apply: (conn) => {
      createResponseRuntimeTables(conn);
    },
  },
  {
    version: 20,
    name: "harden_response_runtime_identity",
    apply: (conn) => {
      addColumnIfMissing(
        conn,
        "response_items",
        "item_key",
        "TEXT NOT NULL DEFAULT ''",
      );
      addColumnIfMissing(conn, "response_items", "updated_at", "DATETIME");
      addColumnIfMissing(
        conn,
        "response_runs",
        "local_turn_id",
        "TEXT NOT NULL DEFAULT ''",
      );
      addColumnIfMissing(conn, "response_runs", "message_id", "INTEGER");

      conn.exec(`UPDATE response_items
			SET item_key = CASE
				WHEN item_id IS NOT NULL AND item_id <> '' THEN item_id || ':' || output_index
				ELSE 'output:' || output_index
			END,
			updated_at = COALESCE(updated_at, created_at)`);
      conn.exec(`DELETE FROM response_items
			WHERE id NOT IN (
				SELECT MAX(id) FROM response_items
				GROUP BY session_id, local_turn_id, item_key
			)`);
      conn.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_response_items_identity
			ON response_items(session_id, local_turn_id, item_key)`,
      );
      conn.exec(`CREATE TABLE IF NOT EXISTS response_session_state (
			session_id TEXT PRIMARY KEY,
			state_mode TEXT NOT NULL DEFAULT 'replay',
			previous_response_id TEXT,
			conversation_id TEXT,
			provider TEXT NOT NULL DEFAULT '',
			api TEXT NOT NULL DEFAULT '',
			model TEXT NOT NULL DEFAULT '',
			version INTEGER NOT NULL DEFAULT 0,
			updated_at DATETIME NOT NULL
		)`);
      conn.exec(
        `CREATE INDEX IF NOT EXISTS idx_response_runs_session_turn
			ON response_runs(session_id, local_turn_id)`,
      );
    },
  },
  {
    version: 21,
    name: "cleanup_orphan_channel_tools",
    apply: (conn) => {
      conn.exec(`DELETE FROM session_channel_tools
			WHERE session_id NOT IN (SELECT id FROM sessions)`);
    },
  },
  {
    version: 22,
    name: "create_channel_tool_generations",
    apply: (conn) => {
      conn.exec(`CREATE TABLE session_channel_tool_generations (
				session_id TEXT PRIMARY KEY,
				generation INTEGER NOT NULL DEFAULT 0,
				updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`);
      conn.exec(`DELETE FROM session_channel_tool_generations
			WHERE session_id NOT IN (SELECT id FROM sessions)`);
      conn.exec(
        `CREATE INDEX idx_channel_tool_generations_updated_at
			ON session_channel_tool_generations(updated_at)`,
      );
    },
  },
  // Versions 36-40 were used by the historical numbered migration records
  // present in released session databases. Never reuse that range.
  {
    version: 41,
    name: "add_sessions_expert_id",
    apply: (conn) => {
      if (tableExists(conn, "sessions")) {
        addColumnIfMissing(
          conn,
          "sessions",
          "expert_id",
          "TEXT NOT NULL DEFAULT ''",
        );
      }
      if (tableExists(conn, "sub_session")) {
        addColumnIfMissing(
          conn,
          "sub_session",
          "expert_id",
          "TEXT NOT NULL DEFAULT ''",
        );
      }
    },
  },
  // Version 42 is retained for databases that already recorded the former
  // session-database knowledge graph migration.
  {
    version: 42,
    name: "create_desktop_knowledge_base_graph",
    apply: () => {},
  },
  {
    version: 43,
    name: "add_delivery_operations_retry_window_started_at",
    apply: (conn) => {
      if (!tableExists(conn, "delivery_operations")) return;
      addColumnIfMissing(
        conn,
        "delivery_operations",
        "retry_window_started_at",
        "TEXT",
      );
    },
  },
];

function createResponseRuntimeTables(conn: DB): void {
  const statements: { name: string; sql: string }[] = [
    {
      name: "response_turns",
      sql: `CREATE TABLE IF NOT EXISTS response_turns (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			local_turn_id TEXT NOT NULL,
			message_id INTEGER,
			request_id TEXT,
			response_id TEXT,
			previous_response_id TEXT,
			conversation_id TEXT,
			provider TEXT NOT NULL,
			api TEXT NOT NULL,
			model TEXT NOT NULL,
			state_mode TEXT NOT NULL,
			status TEXT NOT NULL,
			incomplete_reason TEXT,
			request_summary_json BLOB,
			response_summary_json BLOB,
			created_at DATETIME NOT NULL,
			completed_at DATETIME,
			UNIQUE(session_id, local_turn_id)
		)`,
    },
    {
      name: "idx_response_turns_session_id",
      sql:
        `CREATE INDEX IF NOT EXISTS idx_response_turns_session_id ON response_turns(session_id)`,
    },
    {
      name: "idx_response_turns_response_id",
      sql:
        `CREATE INDEX IF NOT EXISTS idx_response_turns_response_id ON response_turns(response_id)`,
    },
    {
      name: "response_items",
      sql: `CREATE TABLE IF NOT EXISTS response_items (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			local_turn_id TEXT NOT NULL,
			response_id TEXT,
			item_id TEXT,
			output_index INTEGER NOT NULL,
			item_type TEXT NOT NULL,
			item_status TEXT,
			sanitized_json BLOB NOT NULL,
			created_at DATETIME NOT NULL
		)`,
    },
    {
      name: "idx_response_items_session_turn",
      sql:
        `CREATE INDEX IF NOT EXISTS idx_response_items_session_turn ON response_items(session_id, local_turn_id)`,
    },
    {
      name: "idx_response_items_response_id",
      sql:
        `CREATE INDEX IF NOT EXISTS idx_response_items_response_id ON response_items(response_id)`,
    },
    {
      name: "tool_execution_records",
      sql: `CREATE TABLE IF NOT EXISTS tool_execution_records (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			local_turn_id TEXT NOT NULL,
			execution_key TEXT NOT NULL,
			provider TEXT NOT NULL,
			api TEXT NOT NULL,
			response_id TEXT,
			provider_call_id TEXT,
			tool_kind TEXT NOT NULL,
			tool_name TEXT NOT NULL,
			args_hash TEXT NOT NULL,
			execution_state TEXT NOT NULL,
			result_summary_json BLOB,
			provider_metadata_json BLOB,
			side_effecting BOOLEAN NOT NULL,
			created_at DATETIME NOT NULL,
			completed_at DATETIME,
			UNIQUE(execution_key)
		)`,
    },
    {
      name: "idx_tool_execution_records_session_turn",
      sql:
        `CREATE INDEX IF NOT EXISTS idx_tool_execution_records_session_turn ON tool_execution_records(session_id, local_turn_id)`,
    },
    {
      name: "idx_tool_execution_records_provider_call",
      sql:
        `CREATE INDEX IF NOT EXISTS idx_tool_execution_records_provider_call ON tool_execution_records(provider, api, provider_call_id)`,
    },
    {
      name: "response_runs",
      sql: `CREATE TABLE IF NOT EXISTS response_runs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			local_run_id TEXT NOT NULL,
			response_id TEXT,
			provider TEXT NOT NULL,
			api TEXT NOT NULL,
			state TEXT NOT NULL,
			polling_url TEXT,
			last_event_sequence INTEGER,
			cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
			created_at DATETIME NOT NULL,
			updated_at DATETIME NOT NULL,
			UNIQUE(session_id, local_run_id)
		)`,
    },
    {
      name: "idx_response_runs_session_id",
      sql:
        `CREATE INDEX IF NOT EXISTS idx_response_runs_session_id ON response_runs(session_id)`,
    },
    {
      name: "idx_response_runs_state",
      sql:
        `CREATE INDEX IF NOT EXISTS idx_response_runs_state ON response_runs(state)`,
    },
  ];
  for (const stmt of statements) stmt.sql && conn.exec(stmt.sql);
}

function tableExists(conn: DB, table: string): boolean {
  const row = conn.get<Record<string, unknown>>(
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`,
    table,
  );
  return Number(row ? Object.values(row)[0] : 0) !== 0;
}

function addColumnIfMissing(
  conn: DB,
  table: string,
  column: string,
  definition: string,
): void {
  const rows = conn.query<Record<string, unknown>>(
    `PRAGMA table_info(${table})`,
  );
  for (const row of rows) {
    if (String(row["name"]) === column) return;
  }
  conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function tableColumns(conn: DB, table: string): Set<string> {
  const rows = conn.query<Record<string, unknown>>(
    `PRAGMA table_info(${table})`,
  );
  return new Set(rows.map((row) => String(row["name"])));
}

function ensureSchemaMigrationsTable(db: DB): void {
  runInTx(db, (tx) => {
    const exists = tableExists(tx, "schema_migrations");
    if (exists) {
      const columns = tableColumns(tx, "schema_migrations");
      if (
        columns.has("name") && columns.has("applied_at") &&
        !columns.has("version")
      ) {
        tx.exec(`ALTER TABLE schema_migrations ADD COLUMN version INTEGER`);
      } else if (
        !columns.has("version") || !columns.has("name") ||
        !columns.has("applied_at")
      ) {
        const legacy = `schema_migrations_legacy_${Date.now() * 1_000_000}`;
        tx.exec(`ALTER TABLE schema_migrations RENAME TO ${legacy}`);
      }
    }
    tx.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    );
  });
}

/**
 * Applies every schema migration in ascending version order. Each migration
 * runs in its own transaction; an already-applied version or name is skipped.
 */
export function applySchemaMigrations(db: DB): void {
  ensureSchemaMigrationsTable(db);
  const migrations = [...schemaMigrations].sort((a, b) =>
    a.version - b.version
  );
  for (const migration of migrations) {
    runInTx(db, (tx) => {
      const byVersion = countRows(
        tx,
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?",
        migration.version,
      );
      const byName = countRows(
        tx,
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?",
        migration.name,
      );
      if (byVersion !== 0 || byName !== 0) {
        if (byVersion === 0) {
          tx.run(
            `UPDATE schema_migrations SET version = ? WHERE name = ? AND version IS NULL`,
            migration.version,
            migration.name,
          );
        }
        return;
      }
      try {
        migration.apply(tx);
      } catch (err) {
        throw new Error(
          `apply schema migration ${migration.version} (${migration.name}): ${
            message(err)
          }`,
          { cause: err },
        );
      }
      tx.run(
        `INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
        migration.version,
        migration.name,
      );
    });
  }
}

function countRows(conn: DB, sql: string, ...params: SQLInputValue[]): number {
  const row = conn.get<Record<string, unknown>>(sql, ...params);
  return Number(row ? Object.values(row)[0] : 0);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// knowledgeStoreSchema is deliberately separate from the session schema: a
// knowledge base can grow to millions of chunks, so every base gets its own
// SQLite file rather than sharing sessions.db.
export const knowledgeStoreSchema = `
CREATE TABLE knowledge_bases (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	root_dir TEXT NOT NULL,
	preprocess_profile TEXT NOT NULL,
	provider TEXT NOT NULL DEFAULT '',
	model TEXT NOT NULL DEFAULT '',
	mode TEXT NOT NULL DEFAULT 'yolo',
	thinking_level TEXT NOT NULL DEFAULT '',
	schedule TEXT NOT NULL DEFAULT 'manual',
	enabled INTEGER NOT NULL DEFAULT 1,
	active_snapshot_id TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX idx_knowledge_bases_updated ON knowledge_bases(updated_at, name);
CREATE TABLE knowledge_index_snapshots (
	id TEXT PRIMARY KEY,
	knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
	run_id TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL,
	schema_version INTEGER NOT NULL,
	file_count INTEGER NOT NULL DEFAULT 0,
	chunk_count INTEGER NOT NULL DEFAULT 0,
	node_count INTEGER NOT NULL DEFAULT 0,
	edge_count INTEGER NOT NULL DEFAULT 0,
	started_at TEXT NOT NULL,
	finished_at TEXT NOT NULL DEFAULT '',
	error_summary TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_knowledge_snapshots_base ON knowledge_index_snapshots(knowledge_base_id, finished_at);
CREATE TABLE knowledge_files (
	id TEXT PRIMARY KEY,
	snapshot_id TEXT NOT NULL REFERENCES knowledge_index_snapshots(id) ON DELETE CASCADE,
	relative_path TEXT NOT NULL,
	content_sha256 TEXT NOT NULL,
	byte_size INTEGER NOT NULL,
	media_type TEXT NOT NULL DEFAULT '',
	title TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'indexed',
	UNIQUE(snapshot_id, relative_path)
);
CREATE TABLE knowledge_chunks (
	id TEXT PRIMARY KEY,
	snapshot_id TEXT NOT NULL REFERENCES knowledge_index_snapshots(id) ON DELETE CASCADE,
	file_id TEXT NOT NULL REFERENCES knowledge_files(id) ON DELETE CASCADE,
	ordinal INTEGER NOT NULL,
	text TEXT NOT NULL,
	start_line INTEGER NOT NULL,
	end_line INTEGER NOT NULL,
	content_sha256 TEXT NOT NULL,
	UNIQUE(file_id, ordinal)
);
CREATE INDEX idx_knowledge_chunks_snapshot ON knowledge_chunks(snapshot_id, file_id, ordinal);
CREATE VIRTUAL TABLE knowledge_chunk_fts USING fts5(chunk_id UNINDEXED, snapshot_id UNINDEXED, text);
CREATE TABLE knowledge_nodes (
	id TEXT PRIMARY KEY,
	snapshot_id TEXT NOT NULL REFERENCES knowledge_index_snapshots(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	label TEXT NOT NULL,
	normalized_label TEXT NOT NULL,
	summary TEXT NOT NULL DEFAULT '',
	attributes TEXT NOT NULL DEFAULT '{}',
	UNIQUE(snapshot_id, kind, normalized_label)
);
CREATE INDEX idx_knowledge_nodes_label ON knowledge_nodes(snapshot_id, normalized_label, kind);
CREATE TABLE knowledge_edges (
	id TEXT PRIMARY KEY,
	snapshot_id TEXT NOT NULL REFERENCES knowledge_index_snapshots(id) ON DELETE CASCADE,
	from_node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
	to_node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
	relation_type TEXT NOT NULL,
	confidence REAL NOT NULL DEFAULT 1,
	UNIQUE(snapshot_id, from_node_id, to_node_id, relation_type)
);
CREATE INDEX idx_knowledge_edges_from ON knowledge_edges(snapshot_id, from_node_id, relation_type);
CREATE INDEX idx_knowledge_edges_to ON knowledge_edges(snapshot_id, to_node_id, relation_type);
CREATE TABLE knowledge_evidence (
	id TEXT PRIMARY KEY,
	snapshot_id TEXT NOT NULL REFERENCES knowledge_index_snapshots(id) ON DELETE CASCADE,
	node_id TEXT NOT NULL DEFAULT '',
	edge_id TEXT NOT NULL DEFAULT '',
	chunk_id TEXT NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
	start_line INTEGER NOT NULL,
	end_line INTEGER NOT NULL,
	confidence REAL NOT NULL DEFAULT 1,
	CHECK(node_id <> '' OR edge_id <> '')
);
CREATE INDEX idx_knowledge_evidence_chunk ON knowledge_evidence(snapshot_id, chunk_id, node_id, edge_id);
`;

const knowledgeStoreSchemaVersion = 2;

/**
 * Migrates one dedicated knowledge-base SQLite database. It intentionally does
 * not invoke `ensureCurrentSchema`, which owns the unrelated session/run schema.
 */
export function ensureKnowledgeBaseSchema(db: DB): void {
  runInTx(db, (tx) => {
    tx.exec(`CREATE TABLE IF NOT EXISTS knowledge_store_schema (
		version INTEGER PRIMARY KEY,
		applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`);
    const version = countRows(
      tx,
      `SELECT COALESCE(MAX(version), 0) AS v FROM knowledge_store_schema`,
    );
    if (version > knowledgeStoreSchemaVersion) {
      throw new Error(
        `knowledge store schema version ${version} is newer than supported version ${knowledgeStoreSchemaVersion}`,
      );
    }
    if (version < 1) {
      tx.exec(knowledgeStoreSchema);
      tx.run(`INSERT INTO knowledge_store_schema(version) VALUES (?)`, 1);
    }
    if (version < 2) {
      reindexKnowledgeChunkFTS(tx);
      tx.run(`INSERT INTO knowledge_store_schema(version) VALUES (?)`, 2);
    }
  });
}

function reindexKnowledgeChunkFTS(tx: DB): void {
  const rows = tx.query<{ id: string; snapshot_id: string; text: string }>(
    `SELECT id, snapshot_id, text FROM knowledge_chunks`,
  );
  const pending = rows.map((row) => ({
    id: row.id,
    snapshotID: row.snapshot_id,
    text: knowledgeFTSIndexText(row.text),
  }));
  tx.exec(`DELETE FROM knowledge_chunk_fts`);
  for (const row of pending) {
    tx.run(
      `INSERT INTO knowledge_chunk_fts(chunk_id, snapshot_id, text) VALUES (?, ?, ?)`,
      row.id,
      row.snapshotID,
      row.text,
    );
  }
}
