//
// Proves the v1 -> v2 knowledge-store migration: an existing store whose
// knowledge_chunk_fts mirror holds raw (unicode61-uncut) CJK text must be
// reindexed in place so Chinese phrase queries match afterwards, without
// touching graph rows or the active snapshot.

import { assert, assertEquals } from "@opensac/assert";
import { closeAll, openStandalone } from "../db/mod.ts";
import {
  KNOWLEDGE_GRAPH_SCHEMA_VERSION,
  queryKnowledgeGraph,
} from "./knowledge_bases.ts";
import {
  knowledgeBaseDatabasePath,
  queryKnowledgeBaseDatabase,
} from "./knowledge_database.ts";
import { knowledgeStoreSchema } from "./migrations.ts";

const knowledgeStoreSchemaVersion = 2;

Deno.test("knowledge store migrates legacy fts to bigram index", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-session-" });
  const rootDir = Deno.makeTempDirSync({ prefix: "opensac-root-" });
  try {
    const baseID = "kb-legacy-fts";
    const dbPath = knowledgeBaseDatabasePath(sessionDir, baseID);

    const raw = openStandalone(dbPath);
    try {
      raw.exec(`CREATE TABLE knowledge_store_schema (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      raw.exec(knowledgeStoreSchema);
      raw.run(`INSERT INTO knowledge_store_schema(version) VALUES (?)`, 1);
      raw.run(
        `INSERT INTO knowledge_bases
          (id, name, root_dir, preprocess_profile, provider, model, mode, thinking_level, schedule, enabled, active_snapshot_id, created_at, updated_at)
         VALUES (?, 'Legacy', ?, 'documents', '', '', 'yolo', '', 'manual', 1, 'snap1', '2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z')`,
        baseID,
        rootDir,
      );
      raw.run(
        `INSERT INTO knowledge_index_snapshots
          (id, knowledge_base_id, run_id, status, schema_version, file_count, chunk_count, node_count, edge_count, started_at, finished_at, error_summary)
         VALUES ('snap1', ?, '', 'completed', ?, 1, 1, 0, 0, '2026-09-07T00:00:00Z', '2026-09-07T00:00:01Z', '')`,
        baseID,
        KNOWLEDGE_GRAPH_SCHEMA_VERSION,
      );
      raw.run(
        `INSERT INTO knowledge_files
          (id, snapshot_id, relative_path, content_sha256, byte_size, media_type, title, status)
         VALUES ('file1', 'snap1', '架构.md', 'hash', 12, 'text/markdown', '', 'indexed')`,
      );
      raw.run(
        `INSERT INTO knowledge_chunks
          (id, snapshot_id, file_id, ordinal, text, start_line, end_line, content_sha256)
         VALUES ('chunk1', 'snap1', 'file1', 0, '知识库是一个可重建的图谱索引系统', 1, 1, 'hash')`,
      );
      // v1 wrote the raw chunk text into the FTS mirror.
      raw.run(
        `INSERT INTO knowledge_chunk_fts(chunk_id, snapshot_id, text) VALUES ('chunk1', 'snap1', '知识库是一个可重建的图谱索引系统')`,
      );
    } finally {
      raw.close();
    }

    // The first managed open runs ensureKnowledgeBaseSchema and must migrate.
    const query = queryKnowledgeGraph(sessionDir, baseID, "图谱索引", 4);
    assertEquals(query.chunks.length, 1);
    assertEquals(query.chunks[0].id, "chunk1");
    assertEquals(query.chunks[0].text, "知识库是一个可重建的图谱索引系统");
    assertEquals(query.snapshot.id, "snap1");
    assertEquals(query.knowledgeBase.activeSnapshotId, "snap1");

    let version = 0;
    let ftsText = "";
    queryKnowledgeBaseDatabase(sessionDir, baseID, (db) => {
      version = db.db!.get<{ v: number }>(
        `SELECT COALESCE(MAX(version), 0) AS v FROM knowledge_store_schema`,
      )!.v;
      ftsText = db.db!.get<{ text: string }>(
        `SELECT text FROM knowledge_chunk_fts WHERE chunk_id = 'chunk1'`,
      )!.text;
    });
    assertEquals(version, knowledgeStoreSchemaVersion);
    assert(version >= 2);
    assert(ftsText !== "知识库是一个可重建的图谱索引系统");
  } finally {
    closeAll();
    Deno.removeSync(sessionDir, { recursive: true });
    Deno.removeSync(rootDir, { recursive: true });
  }
});
