import type { DB } from "../db/mod.ts";
import { execChanges, inList, queryAll, queryOptional } from "./database.ts";

/** Durable Desktop-managed configuration for one directory-backed base. */
export interface KnowledgeBaseRecord {
  id: string;
  name: string;
  rootDir: string;
  preprocessProfile: string;
  provider: string;
  model: string;
  mode: string;
  thinkingLevel: string;
  schedule: string;
  enabled: number;
  activeSnapshotId: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeSnapshotRecord {
  id: string;
  knowledgeBaseId: string;
  runId: string;
  status: string;
  schemaVersion: number;
  fileCount: number;
  chunkCount: number;
  nodeCount: number;
  edgeCount: number;
  startedAt: string;
  finishedAt: string;
  errorSummary: string;
}

export interface KnowledgeFileRecord {
  id: string;
  snapshotId: string;
  relativePath: string;
  contentSha256: string;
  byteSize: number;
  mediaType: string;
  title: string;
  status: string;
}

export interface KnowledgeChunkRecord {
  id: string;
  snapshotId: string;
  fileId: string;
  relativePath: string;
  ordinal: number;
  text: string;
  startLine: number;
  endLine: number;
  contentSha256: string;
}

export interface KnowledgeNodeRecord {
  id: string;
  snapshotId: string;
  kind: string;
  label: string;
  normalizedLabel: string;
  summary: string;
  attributes: string;
}

export interface KnowledgeEdgeRecord {
  id: string;
  snapshotId: string;
  fromNodeId: string;
  toNodeId: string;
  relationType: string;
  confidence: number;
}

export interface KnowledgeEvidenceRecord {
  id: string;
  snapshotId: string;
  nodeId: string;
  edgeId: string;
  chunkId: string;
  startLine: number;
  endLine: number;
  confidence: number;
}

/** Bounded graph data needed to answer one local knowledge query. */
export interface KnowledgeGraphProjection {
  base: KnowledgeBaseRecord;
  snapshot: KnowledgeSnapshotRecord;
  chunks: KnowledgeChunkRecord[];
  nodes: KnowledgeNodeRecord[];
  edges: KnowledgeEdgeRecord[];
}

const baseColumns = `id, name, root_dir AS rootDir,
  preprocess_profile AS preprocessProfile, provider, model, mode,
  thinking_level AS thinkingLevel, schedule, enabled,
  active_snapshot_id AS activeSnapshotId, created_at AS createdAt,
  updated_at AS updatedAt`;

const snapshotColumns = `id, knowledge_base_id AS knowledgeBaseId,
  run_id AS runId, status, schema_version AS schemaVersion,
  file_count AS fileCount, chunk_count AS chunkCount,
  node_count AS nodeCount, edge_count AS edgeCount, started_at AS startedAt,
  finished_at AS finishedAt, error_summary AS errorSummary`;

const fileColumns = `id, snapshot_id AS snapshotId,
  relative_path AS relativePath, content_sha256 AS contentSha256,
  byte_size AS byteSize, media_type AS mediaType, title, status`;

const chunkColumns =
  `c.id AS id, c.snapshot_id AS snapshotId, c.file_id AS fileId,
  kf.relative_path AS relativePath, c.ordinal AS ordinal, c.text AS text,
  c.start_line AS startLine, c.end_line AS endLine,
  c.content_sha256 AS contentSha256`;

const nodeColumns = `id, snapshot_id AS snapshotId, kind, label,
  normalized_label AS normalizedLabel, summary, attributes`;

const edgeColumns = `id, snapshot_id AS snapshotId, from_node_id AS fromNodeId,
  to_node_id AS toNodeId, relation_type AS relationType, confidence`;

const evidenceColumns = `id, snapshot_id AS snapshotId, node_id AS nodeId,
  edge_id AS edgeId, chunk_id AS chunkId, start_line AS startLine,
  end_line AS endLine, confidence`;

/** The only owner of SQL for the knowledge-base configuration/hraph store. */
export class KnowledgeBaseDAO {
    private readonly db: DB | null;

  constructor(db: DB | null) {
    this.db = db;
  }

  listBases(): KnowledgeBaseRecord[] {
    return queryAll<KnowledgeBaseRecord>(
      this.requireDb(),
      `SELECT ${baseColumns} FROM knowledge_bases
       ORDER BY updated_at DESC, name COLLATE NOCASE`,
    );
  }

  findBase(id: string): KnowledgeBaseRecord | undefined {
    return queryOptional<KnowledgeBaseRecord>(
      this.requireDb(),
      `SELECT ${baseColumns} FROM knowledge_bases WHERE id = ? LIMIT 1`,
      [id],
    );
  }

  /** Reports whether this database still contains the former shared tables. */
  hasStorage(): boolean {
    return queryOptional<{ n: number }>(
      this.requireDb(),
      `SELECT COUNT(*) AS n FROM sqlite_master
       WHERE type = 'table' AND name = 'knowledge_bases'`,
    )?.n !== 0;
  }

  insertBase(executor: DB, record: KnowledgeBaseRecord): void {
    execChanges(
      executor,
      `INSERT INTO knowledge_bases
        (id, name, root_dir, preprocess_profile, provider, model, mode,
         thinking_level, schedule, enabled, active_snapshot_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.name,
        record.rootDir,
        record.preprocessProfile,
        record.provider,
        record.model,
        record.mode,
        record.thinkingLevel,
        record.schedule,
        record.enabled,
        record.activeSnapshotId,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  updateBase(executor: DB, record: KnowledgeBaseRecord): number {
    return execChanges(
      executor,
      `UPDATE knowledge_bases SET
         name = ?, root_dir = ?, preprocess_profile = ?, provider = ?, model = ?,
         mode = ?, thinking_level = ?, schedule = ?, enabled = ?,
         active_snapshot_id = ?, updated_at = ?
       WHERE id = ?`,
      [
        record.name,
        record.rootDir,
        record.preprocessProfile,
        record.provider,
        record.model,
        record.mode,
        record.thinkingLevel,
        record.schedule,
        record.enabled,
        record.activeSnapshotId,
        record.updatedAt,
        record.id,
      ],
    );
  }

  deleteBase(executor: DB, id: string): number {
    execChanges(
      executor,
      `DELETE FROM knowledge_chunk_fts
       WHERE snapshot_id IN (
         SELECT id FROM knowledge_index_snapshots WHERE knowledge_base_id = ?)`,
      [id],
    );
    return execChanges(
      executor,
      `DELETE FROM knowledge_bases WHERE id = ?`,
      [id],
    );
  }

  insertSnapshot(executor: DB, record: KnowledgeSnapshotRecord): void {
    execChanges(
      executor,
      `INSERT INTO knowledge_index_snapshots
        (id, knowledge_base_id, run_id, status, schema_version, file_count,
         chunk_count, node_count, edge_count, started_at, finished_at, error_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.knowledgeBaseId,
        record.runId,
        record.status,
        record.schemaVersion,
        record.fileCount,
        record.chunkCount,
        record.nodeCount,
        record.edgeCount,
        record.startedAt,
        record.finishedAt,
        record.errorSummary,
      ],
    );
  }

  insertFiles(executor: DB, records: KnowledgeFileRecord[]): void {
    if (records.length === 0) return;
    for (const record of records) {
      execChanges(
        executor,
        `INSERT INTO knowledge_files
          (id, snapshot_id, relative_path, content_sha256, byte_size, media_type, title, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.snapshotId,
          record.relativePath,
          record.contentSha256,
          record.byteSize,
          record.mediaType,
          record.title,
          record.status,
        ],
      );
    }
  }

  insertChunks(executor: DB, records: KnowledgeChunkRecord[]): void {
    if (records.length === 0) return;
    for (const record of records) {
      execChanges(
        executor,
        `INSERT INTO knowledge_chunks
          (id, snapshot_id, file_id, ordinal, text, start_line, end_line, content_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.snapshotId,
          record.fileId,
          record.ordinal,
          record.text,
          record.startLine,
          record.endLine,
          record.contentSha256,
        ],
      );
      execChanges(
        executor,
        `INSERT INTO knowledge_chunk_fts(chunk_id, snapshot_id, text) VALUES (?, ?, ?)`,
        [record.id, record.snapshotId, knowledgeFTSIndexText(record.text)],
      );
    }
  }

  insertNodes(executor: DB, records: KnowledgeNodeRecord[]): void {
    if (records.length === 0) return;
    for (const record of records) {
      execChanges(
        executor,
        `INSERT INTO knowledge_nodes
          (id, snapshot_id, kind, label, normalized_label, summary, attributes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.snapshotId,
          record.kind,
          record.label,
          record.normalizedLabel,
          record.summary,
          record.attributes,
        ],
      );
    }
  }

  insertEdges(executor: DB, records: KnowledgeEdgeRecord[]): void {
    if (records.length === 0) return;
    for (const record of records) {
      execChanges(
        executor,
        `INSERT INTO knowledge_edges
          (id, snapshot_id, from_node_id, to_node_id, relation_type, confidence)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.snapshotId,
          record.fromNodeId,
          record.toNodeId,
          record.relationType,
          record.confidence,
        ],
      );
    }
  }

  insertEvidence(executor: DB, records: KnowledgeEvidenceRecord[]): void {
    if (records.length === 0) return;
    for (const record of records) {
      execChanges(
        executor,
        `INSERT INTO knowledge_evidence
          (id, snapshot_id, node_id, edge_id, chunk_id, start_line, end_line, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.snapshotId,
          record.nodeId,
          record.edgeId,
          record.chunkId,
          record.startLine,
          record.endLine,
          record.confidence,
        ],
      );
    }
  }

  activateSnapshot(
    executor: DB,
    baseId: string,
    snapshotId: string,
    updatedAt: string,
  ): number {
    return execChanges(
      executor,
      `UPDATE knowledge_bases SET active_snapshot_id = ?, updated_at = ?
       WHERE id = ?`,
      [snapshotId, updatedAt, baseId],
    );
  }

  /**
   * Removes every non-retained snapshot for one knowledge base. An empty
   * retainedSnapshotID clears every snapshot.
   */
  pruneSnapshotsExcept(
    executor: DB,
    baseId: string,
    retainedSnapshotId: string,
  ): void {
    if (retainedSnapshotId !== "") {
      execChanges(
        executor,
        `DELETE FROM knowledge_chunk_fts
         WHERE snapshot_id IN (
           SELECT id FROM knowledge_index_snapshots WHERE knowledge_base_id = ?)
           AND snapshot_id <> ?`,
        [baseId, retainedSnapshotId],
      );
      execChanges(
        executor,
        `DELETE FROM knowledge_index_snapshots
         WHERE knowledge_base_id = ? AND id <> ?`,
        [baseId, retainedSnapshotId],
      );
      return;
    }
    execChanges(
      executor,
      `DELETE FROM knowledge_chunk_fts
       WHERE snapshot_id IN (
         SELECT id FROM knowledge_index_snapshots WHERE knowledge_base_id = ?)`,
      [baseId],
    );
    execChanges(
      executor,
      `DELETE FROM knowledge_index_snapshots WHERE knowledge_base_id = ?`,
      [baseId],
    );
  }

  findSnapshot(id: string): KnowledgeSnapshotRecord | undefined {
    return queryOptional<KnowledgeSnapshotRecord>(
      this.requireDb(),
      `SELECT ${snapshotColumns} FROM knowledge_index_snapshots WHERE id = ? LIMIT 1`,
      [id],
    );
  }

  listSnapshotsForBase(baseId: string): KnowledgeSnapshotRecord[] {
    return queryAll<KnowledgeSnapshotRecord>(
      this.requireDb(),
      `SELECT ${snapshotColumns} FROM knowledge_index_snapshots
       WHERE knowledge_base_id = ? ORDER BY started_at, id`,
      [baseId],
    );
  }

  listFilesForSnapshot(snapshotId: string): KnowledgeFileRecord[] {
    return queryAll<KnowledgeFileRecord>(
      this.requireDb(),
      `SELECT ${fileColumns} FROM knowledge_files
       WHERE snapshot_id = ? ORDER BY relative_path, id`,
      [snapshotId],
    );
  }

  listChunksForSnapshot(snapshotId: string): KnowledgeChunkRecord[] {
    return queryAll<KnowledgeChunkRecord>(
      this.requireDb(),
      `SELECT c.id AS id, c.snapshot_id AS snapshotId, c.file_id AS fileId,
              kf.relative_path AS relativePath, c.ordinal AS ordinal, c.text AS text,
              c.start_line AS startLine, c.end_line AS endLine,
              c.content_sha256 AS contentSha256
       FROM knowledge_chunks AS c
       JOIN knowledge_files AS kf ON kf.id = c.file_id
       WHERE c.snapshot_id = ? ORDER BY c.file_id, c.ordinal`,
      [snapshotId],
    );
  }

  listNodesForSnapshot(snapshotId: string): KnowledgeNodeRecord[] {
    return queryAll<KnowledgeNodeRecord>(
      this.requireDb(),
      `SELECT ${nodeColumns} FROM knowledge_nodes WHERE snapshot_id = ?
       ORDER BY kind, normalized_label, id`,
      [snapshotId],
    );
  }

  listEdgesForSnapshot(snapshotId: string): KnowledgeEdgeRecord[] {
    return queryAll<KnowledgeEdgeRecord>(
      this.requireDb(),
      `SELECT ${edgeColumns} FROM knowledge_edges WHERE snapshot_id = ?
       ORDER BY relation_type, id`,
      [snapshotId],
    );
  }

  listEvidenceForSnapshot(snapshotId: string): KnowledgeEvidenceRecord[] {
    return queryAll<KnowledgeEvidenceRecord>(
      this.requireDb(),
      `SELECT ${evidenceColumns} FROM knowledge_evidence WHERE snapshot_id = ?
       ORDER BY id`,
      [snapshotId],
    );
  }

  searchChunks(
    snapshotId: string,
    query: string,
    limit: number,
  ): KnowledgeChunkRecord[] {
    if (limit <= 0) limit = 8;
    const terms = knowledgeFTSQuery(query);
    if (terms === "") return [];
    return queryAll<KnowledgeChunkRecord>(
      this.requireDb(),
      `SELECT ${chunkColumns}
       FROM knowledge_chunk_fts AS f
       JOIN knowledge_chunks AS c ON c.id = f.chunk_id
       JOIN knowledge_files AS kf ON kf.id = c.file_id
       WHERE f.snapshot_id = ? AND knowledge_chunk_fts MATCH ?
       ORDER BY bm25(knowledge_chunk_fts), c.ordinal ASC LIMIT ?`,
      [snapshotId, terms, limit],
    );
  }

  nodesForChunks(
    snapshotId: string,
    chunkIds: string[],
  ): KnowledgeNodeRecord[] {
    if (chunkIds.length === 0) return [];
    const { sql, params } = inList(chunkIds);
    return queryAll<KnowledgeNodeRecord>(
      this.requireDb(),
      `SELECT kn.id AS id, kn.snapshot_id AS snapshotId, kn.kind AS kind,
              kn.label AS label, kn.normalized_label AS normalizedLabel,
              kn.summary AS summary, kn.attributes AS attributes
       FROM knowledge_nodes AS kn
       JOIN knowledge_evidence AS e ON e.node_id = kn.id
       WHERE kn.snapshot_id = ? AND e.chunk_id IN (${sql})
       ORDER BY kn.kind, kn.label COLLATE NOCASE`,
      [snapshotId, ...params],
    );
  }

  edgesForNodes(snapshotId: string, nodeIds: string[]): KnowledgeEdgeRecord[] {
    if (nodeIds.length === 0) return [];
    const { sql, params } = inList(nodeIds);
    return queryAll<KnowledgeEdgeRecord>(
      this.requireDb(),
      `SELECT ${edgeColumns} FROM knowledge_edges
       WHERE snapshot_id = ? AND (from_node_id IN (${sql}) OR to_node_id IN (${sql}))
       ORDER BY relation_type, id`,
      [snapshotId, ...params, ...params],
    );
  }

  /**
   * Reads the active completed graph for a base through one caller-owned
   * transaction. `indexed` is false when the base exists but has no completed
   * active snapshot; `undefined` means the base does not exist.
   */
  activeGraphProjection(
    executor: DB,
    baseId: string,
    query: string,
    limit: number,
  ): { projection: KnowledgeGraphProjection; indexed: boolean } | undefined {
    const base = queryOptional<KnowledgeBaseRecord>(
      executor,
      `SELECT ${baseColumns} FROM knowledge_bases WHERE id = ? LIMIT 1`,
      [baseId],
    );
    if (base === undefined) return undefined;
    if (base.activeSnapshotId.trim() === "") {
      return { projection: emptyProjection(base), indexed: false };
    }
    const snapshot = queryOptional<KnowledgeSnapshotRecord>(
      executor,
      `SELECT ${snapshotColumns} FROM knowledge_index_snapshots WHERE id = ? LIMIT 1`,
      [base.activeSnapshotId],
    );
    if (snapshot === undefined || snapshot.status !== "completed") {
      return { projection: emptyProjection(base), indexed: false };
    }
    const projection: KnowledgeGraphProjection = {
      base,
      snapshot,
      chunks: [],
      nodes: [],
      edges: [],
    };
    if (limit <= 0) limit = 8;
    const terms = knowledgeFTSQuery(query);
    if (terms === "") return { projection, indexed: true };
    projection.chunks = queryAll<KnowledgeChunkRecord>(
      executor,
      `SELECT ${chunkColumns}
       FROM knowledge_chunk_fts AS f
       JOIN knowledge_chunks AS c ON c.id = f.chunk_id
       JOIN knowledge_files AS kf ON kf.id = c.file_id
       WHERE f.snapshot_id = ? AND knowledge_chunk_fts MATCH ?
       ORDER BY bm25(knowledge_chunk_fts), c.ordinal ASC LIMIT ?`,
      [snapshot.id, terms, limit],
    );
    const chunkIds = projection.chunks.map((c) => c.id);
    if (chunkIds.length === 0) return { projection, indexed: true };
    projection.nodes = this.nodesForChunks(snapshot.id, chunkIds);
    const nodeIds = projection.nodes.map((n) => n.id);
    if (nodeIds.length === 0) return { projection, indexed: true };
    projection.edges = this.edgesForNodes(snapshot.id, nodeIds);
    return { projection, indexed: true };
  }

  private requireDb(): DB {
    if (this.db === null) throw new Error("knowledge database is not open");
    return this.db;
  }
}

function emptyProjection(base: KnowledgeBaseRecord): KnowledgeGraphProjection {
  return {
    base,
    snapshot: {
      id: "",
      knowledgeBaseId: "",
      runId: "",
      status: "",
      schemaVersion: 0,
      fileCount: 0,
      chunkCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      startedAt: "",
      finishedAt: "",
      errorSummary: "",
    },
    chunks: [],
    nodes: [],
    edges: [],
  };
}

export function knowledgeFTSQuery(query: string): string {
  const terms = splitFTSQueryTerms(query.toLowerCase());
  const quoted: string[] = [];
  for (let term of terms) {
    term = term.trim().replaceAll(`"`, "");
    if (term === "" || !knowledgeFTSHasTokenRune(term)) continue;
    quoted.push(`"${knowledgeFTSIndexText(term).trim()}"`);
  }
  return quoted.join(" OR ");
}

function splitFTSQueryTerms(value: string): string[] {
  const terms: string[] = [];
  let current = "";
  for (const ch of Array.from(value)) {
    if (isFTSQueryChar(ch)) {
      current += ch;
    } else if (current !== "") {
      terms.push(current);
      current = "";
    }
  }
  if (current !== "") terms.push(current);
  return terms;
}

function isFTSQueryChar(ch: string): boolean {
  const code = ch.codePointAt(0)!;
  return ch === "_" || ch === "-" || ch === "." || ch === "/" ||
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) || knowledgeIsFTSCJK(code);
}

/** Reports whether a code point is in the CJK range preserved by the FTS path. */
export function knowledgeIsFTSCJK(code: number): boolean {
  return code >= 0x4e00 && code <= 0x9fff;
}

/** Reports whether a query term contains a rune unicode61 can index. */
export function knowledgeFTSHasTokenRune(term: string): boolean {
  for (const ch of Array.from(term)) {
    const code = ch.codePointAt(0)!;
    if (
      ch === "_" || (code >= 0x30 && code <= 0x39) ||
      (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) ||
      knowledgeIsFTSCJK(code)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Rewrites chunk text for the knowledge_chunk_fts mirror column. Every CJK run
 * is split into overlapping bigrams (an isolated character is kept as-is) and
 * padded with spaces.
 */
export function knowledgeFTSIndexText(text: string): string {
  const runes = Array.from(text);
  if (!runes.some((ch) => knowledgeIsFTSCJK(ch.codePointAt(0)!))) return text;
  let builder = "";
  for (let i = 0; i < runes.length;) {
    if (!knowledgeIsFTSCJK(runes[i].codePointAt(0)!)) {
      builder += runes[i];
      i++;
      continue;
    }
    const start = i;
    while (i < runes.length && knowledgeIsFTSCJK(runes[i].codePointAt(0)!)) {
      i++;
    }
    const run = runes.slice(start, i);
    builder += " ";
    if (run.length === 1) {
      builder += run[0];
    } else {
      for (let j = 0; j + 1 < run.length; j++) {
        if (j > 0) builder += " ";
        builder += run[j] + run[j + 1];
      }
    }
    builder += " ";
  }
  return builder;
}
