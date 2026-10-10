//
// Runtime-owned persistence and orchestration for Desktop-managed knowledge
// bases. Each base is a user-selected directory indexed into one private,
// rebuildable graph/FTS SQLite store (see knowledge_database.ts); the source
// directory is read-only and canonical Runs remain in sessions.db.

import { runtime } from "../platform/runtime.ts";
import type { FileInfo } from "../platform/runtime.ts";
import * as path from "../compat/path.ts";
import {
  KnowledgeBaseDAO,
  type KnowledgeBaseRecord,
  type KnowledgeChunkRecord,
  type KnowledgeEdgeRecord,
  type KnowledgeEvidenceRecord,
  type KnowledgeFileRecord,
  type KnowledgeNodeRecord,
  type KnowledgeSnapshotRecord,
} from "../dao/mod.ts";
import { queryRootDatabase, writeRootDatabase } from "./database.ts";
import { generateID } from "./entry.ts";
import { boolToInt, parseProjectTime } from "./projects.ts";
import {
  deleteKnowledgeBaseDatabase,
  KnowledgeBaseNotFoundError,
  listKnowledgeBaseDatabaseIDs,
  queryKnowledgeBaseDatabase,
  readKnowledgeBaseDatabase,
  writeKnowledgeBaseDatabase,
} from "./knowledge_database.ts";

/** The knowledge-store schema version of a completed graph snapshot. */
export const KNOWLEDGE_GRAPH_SCHEMA_VERSION = 1;

/** Thrown when a knowledge base has no completed active index. */
export class KnowledgeBaseUnindexedError extends Error {
  override name = "KnowledgeBaseUnindexedError";
  constructor() {
    super("knowledge base has no completed index");
  }
}

export { KnowledgeBaseNotFoundError };

/**
 * The editable Desktop configuration. It deliberately stores provider/model/
 * mode as references, not copied provider credentials.
 */
export interface KnowledgeBaseSpec {
  name: string;
  rootDir: string;
  preprocessProfile: string;
  provider: string;
  model: string;
  mode: string;
  thinkingLevel?: string;
  schedule: string;
  enabled: boolean;
}

/** A persisted knowledge base: identity plus its embedded spec. */
export interface KnowledgeBase extends KnowledgeBaseSpec {
  id: string;
  activeSnapshotId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** One immutable index attempt for a knowledge base. */
export interface KnowledgeSnapshot {
  id: string;
  knowledgeBaseId: string;
  runId?: string;
  status: string;
  schemaVersion: number;
  fileCount: number;
  chunkCount: number;
  nodeCount: number;
  edgeCount: number;
  startedAt: Date;
  finishedAt?: Date;
  errorSummary?: string;
}

export interface KnowledgeFile {
  id: string;
  snapshotId: string;
  relativePath: string;
  contentSha256: string;
  byteSize: number;
  mediaType: string;
  title?: string;
  status: string;
}

export interface KnowledgeChunk {
  id: string;
  snapshotId: string;
  fileId: string;
  relativePath?: string;
  ordinal: number;
  text: string;
  startLine: number;
  endLine: number;
  contentSha256: string;
}

export interface KnowledgeNode {
  id: string;
  snapshotId: string;
  kind: string;
  label: string;
  normalizedLabel: string;
  summary?: string;
}

export interface KnowledgeEdge {
  id: string;
  snapshotId: string;
  fromNodeId: string;
  toNodeId: string;
  relationType: string;
  confidence: number;
}

export interface KnowledgeEvidence {
  id: string;
  snapshotId: string;
  nodeId?: string;
  edgeId?: string;
  chunkId: string;
  startLine: number;
  endLine: number;
  confidence: number;
}

/**
 * The immutable payload committed by a successful indexer. The session layer
 * stores it atomically and switches the active snapshot only after all graph
 * rows are durable.
 */
export interface KnowledgeGraphSnapshot {
  snapshot: KnowledgeSnapshot;
  files: KnowledgeFile[];
  chunks: KnowledgeChunk[];
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  evidence: KnowledgeEvidence[];
}

export interface KnowledgeGraphQuery {
  knowledgeBase: KnowledgeBase;
  snapshot: KnowledgeSnapshot;
  chunks: KnowledgeChunk[];
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
}

/** Creates one knowledge base under its own private database. */
export function createKnowledgeBase(
  sessionDir: string,
  spec: KnowledgeBaseSpec,
): KnowledgeBase {
  migrateLegacyKnowledgeBaseStorage(sessionDir);
  validateKnowledgeBaseSpec(spec);
  const now = new Date();
  const base: KnowledgeBase = {
    ...spec,
    id: generateID(),
    activeSnapshotId: "",
    createdAt: now,
    updatedAt: now,
  };
  writeKnowledgeBaseDatabase(sessionDir, base.id, true, (tx) => {
    new KnowledgeBaseDAO(null).insertBase(tx, knowledgeBaseRecord(base));
  });
  return base;
}

/** Lists every knowledge base, most recently updated first. */
export function listKnowledgeBases(sessionDir: string): KnowledgeBase[] {
  migrateLegacyKnowledgeBaseStorage(sessionDir);
  const ids = listKnowledgeBaseDatabaseIDs(sessionDir);
  const bases: KnowledgeBase[] = [];
  for (const id of ids) {
    let record: KnowledgeBaseRecord | undefined;
    try {
      queryKnowledgeBaseDatabase(sessionDir, id, (db) => {
        record = new KnowledgeBaseDAO(db.db).findBase(id);
      });
    } catch (err) {
      if (err instanceof KnowledgeBaseNotFoundError) continue;
      throw err;
    }
    if (record === undefined) continue;
    bases.push(knowledgeBaseFromRecord(record));
  }
  bases.sort((a, b) => {
    if (a.updatedAt.getTime() === b.updatedAt.getTime()) {
      return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
    }
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });
  return bases;
}

/** Loads one knowledge base, or throws `KnowledgeBaseNotFoundError`. */
export function getKnowledgeBase(
  sessionDir: string,
  id: string,
): KnowledgeBase {
  id = id.trim();
  if (id === "") throw new KnowledgeBaseNotFoundError();
  migrateLegacyKnowledgeBaseStorage(sessionDir);
  let record: KnowledgeBaseRecord | undefined;
  queryKnowledgeBaseDatabase(sessionDir, id, (db) => {
    record = new KnowledgeBaseDAO(db.db).findBase(id);
  });
  if (record === undefined) throw new KnowledgeBaseNotFoundError();
  return knowledgeBaseFromRecord(record);
}

/**
 * Replaces a knowledge base's configuration. A snapshot is only authoritative
 * for the exact directory/profile that produced it, so configuration edits
 * clear the active snapshot and prune every historical graph row.
 */
export function updateKnowledgeBase(
  sessionDir: string,
  id: string,
  spec: KnowledgeBaseSpec,
): KnowledgeBase {
  id = id.trim();
  if (id === "") throw new KnowledgeBaseNotFoundError();
  validateKnowledgeBaseSpec(spec);
  const base = getKnowledgeBase(sessionDir, id);
  const updated: KnowledgeBase = {
    ...base,
    ...spec,
    activeSnapshotId: "",
    updatedAt: new Date(),
  };
  writeKnowledgeBaseDatabase(sessionDir, id, false, (tx) => {
    const store = new KnowledgeBaseDAO(null);
    const changed = store.updateBase(tx, knowledgeBaseRecord(updated));
    if (changed !== 1) throw new KnowledgeBaseNotFoundError();
    store.pruneSnapshotsExcept(tx, id, "");
  });
  return updated;
}

/** Deletes a knowledge base and its private database file. */
export function deleteKnowledgeBase(sessionDir: string, id: string): void {
  id = id.trim();
  if (id === "") throw new KnowledgeBaseNotFoundError();
  migrateLegacyKnowledgeBaseStorage(sessionDir);
  getKnowledgeBase(sessionDir, id);
  writeKnowledgeBaseDatabase(sessionDir, id, false, (tx) => {
    const changed = new KnowledgeBaseDAO(null).deleteBase(tx, id);
    if (changed !== 1) throw new KnowledgeBaseNotFoundError();
  });
  deleteKnowledgeBaseDatabase(sessionDir, id);
}

/** Finds one snapshot by ID across every knowledge base. */
export function getKnowledgeSnapshot(
  sessionDir: string,
  id: string,
): KnowledgeSnapshot {
  migrateLegacyKnowledgeBaseStorage(sessionDir);
  id = id.trim();
  const bases = listKnowledgeBaseDatabaseIDs(sessionDir);
  for (const base of bases) {
    let record: KnowledgeSnapshotRecord | undefined;
    queryKnowledgeBaseDatabase(sessionDir, base, (db) => {
      record = new KnowledgeBaseDAO(db.db).findSnapshot(id);
    });
    if (record === undefined) continue;
    return knowledgeSnapshotFromRecord(record);
  }
  throw new KnowledgeBaseUnindexedError();
}

/** Atomically stores a completed graph and makes it the active snapshot. */
export function storeKnowledgeGraphSnapshot(
  sessionDir: string,
  graph: KnowledgeGraphSnapshot,
): KnowledgeSnapshot {
  validateKnowledgeGraphSnapshot(graph);
  migrateLegacyKnowledgeBaseStorage(sessionDir);
  const now = new Date();
  graph.snapshot.status = "completed";
  graph.snapshot.schemaVersion = KNOWLEDGE_GRAPH_SCHEMA_VERSION;
  graph.snapshot.fileCount = graph.files.length;
  graph.snapshot.chunkCount = graph.chunks.length;
  graph.snapshot.nodeCount = graph.nodes.length;
  graph.snapshot.edgeCount = graph.edges.length;
  if (!graph.snapshot.startedAt) graph.snapshot.startedAt = now;
  graph.snapshot.finishedAt = now;
  writeKnowledgeBaseDatabase(
    sessionDir,
    graph.snapshot.knowledgeBaseId,
    false,
    (tx) => {
      const store = new KnowledgeBaseDAO(null);
      store.insertSnapshot(tx, knowledgeSnapshotRecord(graph.snapshot));
      store.insertFiles(tx, knowledgeFileRecords(graph.files));
      store.insertChunks(tx, knowledgeChunkRecords(graph.chunks));
      store.insertNodes(tx, knowledgeNodeRecords(graph.nodes));
      store.insertEdges(tx, knowledgeEdgeRecords(graph.edges));
      store.insertEvidence(tx, knowledgeEvidenceRecords(graph.evidence));
      const changed = store.activateSnapshot(
        tx,
        graph.snapshot.knowledgeBaseId,
        graph.snapshot.id,
        now.toISOString(),
      );
      if (changed !== 1) throw new KnowledgeBaseNotFoundError();
      store.pruneSnapshotsExcept(
        tx,
        graph.snapshot.knowledgeBaseId,
        graph.snapshot.id,
      );
    },
  );
  return graph.snapshot;
}

/**
 * Returns the active immutable snapshot when the deterministic scan produced
 * the exact same indexable file set. It deliberately compares content hashes
 * rather than timestamps so a caller cannot serve stale knowledge merely
 * because a tool preserved mtimes.
 */
export function reuseKnowledgeSnapshotIfFilesMatch(
  sessionDir: string,
  baseID: string,
  files: KnowledgeFile[],
): { snapshot: KnowledgeSnapshot; reusable: boolean } {
  migrateLegacyKnowledgeBaseStorage(sessionDir);
  baseID = baseID.trim();
  let matched: KnowledgeSnapshot | undefined;
  let reusable = false;
  try {
    queryKnowledgeBaseDatabase(sessionDir, baseID, (db) => {
      const store = new KnowledgeBaseDAO(db.db);
      const baseRecord = store.findBase(baseID);
      if (baseRecord === undefined) return;
      if (baseRecord.activeSnapshotId.trim() === "") return;
      const snapshotRecord = store.findSnapshot(baseRecord.activeSnapshotId);
      if (snapshotRecord === undefined) return;
      const snapshot = knowledgeSnapshotFromRecord(snapshotRecord);
      if (
        snapshot.status !== "completed" ||
        snapshot.schemaVersion !== KNOWLEDGE_GRAPH_SCHEMA_VERSION
      ) {
        return;
      }
      const storedFiles = store.listFilesForSnapshot(snapshot.id);
      if (!knowledgeFilesMatch(files, storedFiles)) return;
      matched = snapshot;
      reusable = true;
    });
  } catch (err) {
    if (err instanceof KnowledgeBaseNotFoundError) {
      return { snapshot: emptySnapshot(), reusable: false };
    }
    throw err;
  }
  if (matched === undefined) return { snapshot: emptySnapshot(), reusable };
  return { snapshot: matched, reusable };
}

function knowledgeFilesMatch(
  files: KnowledgeFile[],
  records: KnowledgeFileRecord[],
): boolean {
  if (files.length !== records.length) return false;
  const byPath = new Map<string, KnowledgeFile>();
  for (const file of files) {
    if (file.relativePath === "") return false;
    if (byPath.has(file.relativePath)) return false;
    byPath.set(file.relativePath, file);
  }
  for (const record of records) {
    const file = byPath.get(record.relativePath);
    if (
      !file ||
      file.contentSha256 !== record.contentSha256 ||
      file.byteSize !== record.byteSize ||
      file.mediaType !== record.mediaType ||
      file.status !== record.status
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The self-contained, evidence-backed subgraph owned by one source file. It is
 * used to carry unchanged file work from an immutable snapshot into its
 * successor without re-running extractors or an Indexer.
 */
export interface KnowledgeFileGraph {
  file: KnowledgeFile;
  chunks: KnowledgeChunk[];
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  evidence: KnowledgeEvidence[];
}

/**
 * Source-file subgraphs that still match the current directory manifest. The
 * caller must clone them into a new snapshot; no row, node, chunk or edge
 * identity is shared between snapshots.
 */
export interface KnowledgeGraphReusePlan {
  sourceSnapshotId: string;
  /** Keyed by normalized relative path. */
  files: Map<string, KnowledgeFileGraph>;
}

/**
 * Loads unchanged per-file graph work from the active snapshot. It is
 * deliberately all-or-nothing per file: an edge whose endpoint or evidence
 * escapes the file is omitted rather than claiming an unverified cross-file
 * relationship in the successor snapshot.
 */
export function prepareKnowledgeGraphReusePlan(
  sessionDir: string,
  baseID: string,
  manifest: KnowledgeFile[],
): KnowledgeGraphReusePlan {
  migrateLegacyKnowledgeBaseStorage(sessionDir);
  baseID = baseID.trim();
  const plan: KnowledgeGraphReusePlan = {
    sourceSnapshotId: "",
    files: new Map(),
  };
  try {
    queryKnowledgeBaseDatabase(sessionDir, baseID, (db) => {
      const store = new KnowledgeBaseDAO(db.db);
      const base = store.findBase(baseID);
      if (base === undefined) return;
      if (base.activeSnapshotId.trim() === "") return;
      const snapshot = store.findSnapshot(base.activeSnapshotId);
      if (snapshot === undefined) return;
      if (
        snapshot.status !== "completed" ||
        snapshot.schemaVersion !== KNOWLEDGE_GRAPH_SCHEMA_VERSION
      ) {
        return;
      }
      const storedFiles = store.listFilesForSnapshot(snapshot.id);
      const matching = matchingKnowledgeFileRecords(manifest, storedFiles);
      if (matching.size === 0) return;
      const chunks = store.listChunksForSnapshot(snapshot.id);
      const nodes = store.listNodesForSnapshot(snapshot.id);
      const edges = store.listEdgesForSnapshot(snapshot.id);
      const evidence = store.listEvidenceForSnapshot(snapshot.id);
      plan.sourceSnapshotId = snapshot.id;
      plan.files = partitionKnowledgeFileGraphs(
        matching,
        chunks,
        nodes,
        edges,
        evidence,
      );
    });
  } catch (err) {
    if (err instanceof KnowledgeBaseNotFoundError) {
      return { sourceSnapshotId: "", files: new Map() };
    }
    throw err;
  }
  return plan;
}

function matchingKnowledgeFileRecords(
  manifest: KnowledgeFile[],
  records: KnowledgeFileRecord[],
): Map<string, KnowledgeFileRecord> {
  const byPath = new Map<string, KnowledgeFile>();
  for (const file of manifest) {
    if (file.relativePath !== "") byPath.set(file.relativePath, file);
  }
  const matching = new Map<string, KnowledgeFileRecord>();
  for (const record of records) {
    const file = byPath.get(record.relativePath);
    if (
      file &&
      file.contentSha256 === record.contentSha256 &&
      file.byteSize === record.byteSize &&
      file.mediaType === record.mediaType &&
      file.status === record.status
    ) {
      matching.set(record.id, record);
    }
  }
  return matching;
}

function partitionKnowledgeFileGraphs(
  files: Map<string, KnowledgeFileRecord>,
  chunks: KnowledgeChunkRecord[],
  nodes: KnowledgeNodeRecord[],
  edges: KnowledgeEdgeRecord[],
  evidence: KnowledgeEvidenceRecord[],
): Map<string, KnowledgeFileGraph> {
  const result = new Map<string, KnowledgeFileGraph>();
  const byChunk = new Map<string, string>();
  for (const record of files.values()) {
    result.set(record.relativePath, {
      file: {
        id: record.id,
        snapshotId: record.snapshotId,
        relativePath: record.relativePath,
        contentSha256: record.contentSha256,
        byteSize: record.byteSize,
        mediaType: record.mediaType,
        title: record.title,
        status: record.status,
      },
      chunks: [],
      nodes: [],
      edges: [],
      evidence: [],
    });
  }
  for (const chunk of chunks) {
    const file = files.get(chunk.fileId);
    if (!file) continue;
    const graph = result.get(file.relativePath)!;
    graph.chunks.push({
      id: chunk.id,
      snapshotId: chunk.snapshotId,
      fileId: chunk.fileId,
      ordinal: chunk.ordinal,
      relativePath: chunk.relativePath,
      text: chunk.text,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      contentSha256: chunk.contentSha256,
    });
    byChunk.set(chunk.id, file.relativePath);
  }

  const nodePath = new Map<string, string>();
  const edgePath = new Map<string, string>();
  for (const item of evidence) {
    const p = byChunk.get(item.chunkId);
    if (p === undefined) continue;
    if (item.nodeId !== "") {
      const prev = nodePath.get(item.nodeId);
      if (prev === undefined || p < prev) nodePath.set(item.nodeId, p);
    }
    if (item.edgeId !== "") {
      const prev = edgePath.get(item.edgeId);
      if (prev === undefined || p < prev) edgePath.set(item.edgeId, p);
    }
  }
  for (const node of nodes) {
    const p = nodePath.get(node.id);
    if (p === undefined) continue;
    const graph = result.get(p)!;
    graph.nodes.push({
      id: node.id,
      snapshotId: node.snapshotId,
      kind: node.kind,
      label: node.label,
      normalizedLabel: node.normalizedLabel,
      summary: node.summary,
    });
  }
  for (const edge of edges) {
    const p = edgePath.get(edge.id);
    const fromPath = nodePath.get(edge.fromNodeId);
    const toPath = nodePath.get(edge.toNodeId);
    if (
      p === undefined ||
      fromPath === undefined ||
      toPath === undefined ||
      fromPath !== p ||
      toPath !== p
    ) {
      continue;
    }
    const graph = result.get(p)!;
    graph.edges.push({
      id: edge.id,
      snapshotId: edge.snapshotId,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      relationType: edge.relationType,
      confidence: edge.confidence,
    });
  }
  const retainedEdges = new Set<string>();
  for (const graph of result.values()) {
    for (const edge of graph.edges) retainedEdges.add(edge.id);
  }
  for (const item of evidence) {
    const p = byChunk.get(item.chunkId);
    if (p === undefined) continue;
    if (item.nodeId !== "") {
      if (nodePath.get(item.nodeId) !== p) continue;
    } else if (
      !retainedEdges.has(item.edgeId) ||
      edgePath.get(item.edgeId) !== p
    ) {
      continue;
    }
    const graph = result.get(p)!;
    graph.evidence.push({
      id: item.id,
      snapshotId: item.snapshotId,
      nodeId: item.nodeId,
      edgeId: item.edgeId,
      chunkId: item.chunkId,
      startLine: item.startLine,
      endLine: item.endLine,
      confidence: item.confidence,
    });
  }
  return result;
}

/**
 * Clones a file subgraph into `graph`. New IDs prevent a successor snapshot
 * from sharing mutable identity with its source.
 */
export function appendKnowledgeFileGraph(
  graph: KnowledgeGraphSnapshot | undefined,
  source: KnowledgeFileGraph,
): void {
  if (!graph || graph.snapshot.id === "" || source.file.id === "") return;
  const fileIDs = new Map<string, string>([[source.file.id, generateID()]]);
  const file = { ...source.file };
  file.id = fileIDs.get(source.file.id)!;
  file.snapshotId = graph.snapshot.id;
  graph.files.push(file);

  const chunkIDs = new Map<string, string>();
  for (const sourceChunk of source.chunks) {
    const chunk = { ...sourceChunk };
    chunk.id = generateID();
    chunk.snapshotId = graph.snapshot.id;
    chunk.fileId = file.id;
    chunkIDs.set(sourceChunk.id, chunk.id);
    graph.chunks.push(chunk);
  }
  const nodeIDs = new Map<string, string>();
  for (const sourceNode of source.nodes) {
    const node = { ...sourceNode };
    node.id = generateID();
    node.snapshotId = graph.snapshot.id;
    nodeIDs.set(sourceNode.id, node.id);
    graph.nodes.push(node);
  }
  const edgeIDs = new Map<string, string>();
  for (const sourceEdge of source.edges) {
    const from = nodeIDs.get(sourceEdge.fromNodeId);
    const to = nodeIDs.get(sourceEdge.toNodeId);
    if (from === undefined || to === undefined) continue;
    const edge = { ...sourceEdge };
    edge.id = generateID();
    edge.snapshotId = graph.snapshot.id;
    edge.fromNodeId = from;
    edge.toNodeId = to;
    edgeIDs.set(sourceEdge.id, edge.id);
    graph.edges.push(edge);
  }
  for (const sourceEvidence of source.evidence) {
    const chunkID = chunkIDs.get(sourceEvidence.chunkId);
    if (chunkID === undefined) continue;
    const evidence = { ...sourceEvidence };
    evidence.id = generateID();
    evidence.snapshotId = graph.snapshot.id;
    evidence.chunkId = chunkID;
    if ((sourceEvidence.nodeId ?? "") !== "") {
      const mapped = nodeIDs.get(sourceEvidence.nodeId!);
      if (mapped === undefined) continue;
      evidence.nodeId = mapped;
      evidence.edgeId = "";
    } else {
      const mapped = edgeIDs.get(sourceEvidence.edgeId!);
      if (mapped === undefined) continue;
      evidence.nodeId = "";
      evidence.edgeId = mapped;
    }
    graph.evidence.push(evidence);
  }
}

/**
 * Executes the local FTS seed lookup followed by a bounded graph projection. It
 * never reads the source directory itself; the active completed snapshot is the
 * sole query authority.
 */
export function queryKnowledgeGraph(
  sessionDir: string,
  baseID: string,
  query: string,
  limit: number,
): KnowledgeGraphQuery {
  migrateLegacyKnowledgeBaseStorage(sessionDir);
  baseID = baseID.trim();
  const result: KnowledgeGraphQuery = {
    knowledgeBase: {} as KnowledgeBase,
    snapshot: emptySnapshot(),
    chunks: [],
    nodes: [],
    edges: [],
  };
  try {
    readKnowledgeBaseDatabase(sessionDir, baseID, (tx) => {
      const active = new KnowledgeBaseDAO(tx).activeGraphProjection(
        tx,
        baseID,
        query,
        limit,
      );
      if (active === undefined) throw new KnowledgeBaseNotFoundError();
      const { projection, indexed } = active;
      if (!indexed) throw new KnowledgeBaseUnindexedError();
      result.knowledgeBase = knowledgeBaseFromRecord(projection.base);
      result.snapshot = knowledgeSnapshotFromRecord(projection.snapshot);
      result.chunks = knowledgeChunksFromRecords(projection.chunks);
      result.nodes = knowledgeNodesFromRecords(projection.nodes);
      result.edges = knowledgeEdgesFromRecords(projection.edges);
    });
  } catch (err) {
    if (err instanceof KnowledgeBaseNotFoundError) {
      throw new KnowledgeBaseNotFoundError();
    }
    throw err;
  }
  return result;
}

interface LegacyKnowledgeSnapshotData {
  snapshot: KnowledgeSnapshotRecord;
  files: KnowledgeFileRecord[];
  chunks: KnowledgeChunkRecord[];
  nodes: KnowledgeNodeRecord[];
  edges: KnowledgeEdgeRecord[];
  evidence: KnowledgeEvidenceRecord[];
}

interface LegacyKnowledgeBaseData {
  base: KnowledgeBaseRecord;
  snapshots: LegacyKnowledgeSnapshotData[];
}

/**
 * Moves the short-lived shared-store layout into one private database per
 * knowledge base. The destination commit happens before the source rows are
 * removed, so an interrupted migration is safe to retry; source material and
 * canonical session/Run records are never touched.
 */
export function migrateLegacyKnowledgeBaseStorage(sessionDir: string): void {
  let bases: KnowledgeBaseRecord[] = [];
  queryRootDatabase(sessionDir, (db) => {
    const store = new KnowledgeBaseDAO(db.db);
    if (!store.hasStorage()) return;
    bases = store.listBases();
  });
  if (bases.length === 0) return;
  for (const base of bases) {
    const legacy = readLegacyKnowledgeBase(sessionDir, base);
    writeLegacyKnowledgeBaseToDedicatedStore(sessionDir, legacy);
    writeRootDatabase(sessionDir, (tx) => {
      const changed = new KnowledgeBaseDAO(null).deleteBase(tx, base.id);
      if (changed !== 1) throw new KnowledgeBaseNotFoundError();
    });
  }
}

function readLegacyKnowledgeBase(
  sessionDir: string,
  base: KnowledgeBaseRecord,
): LegacyKnowledgeBaseData {
  const data: LegacyKnowledgeBaseData = { base, snapshots: [] };
  queryRootDatabase(sessionDir, (db) => {
    const store = new KnowledgeBaseDAO(db.db);
    const snapshots = store.listSnapshotsForBase(base.id);
    for (const snapshot of snapshots) {
      data.snapshots.push({
        snapshot,
        files: store.listFilesForSnapshot(snapshot.id),
        chunks: store.listChunksForSnapshot(snapshot.id),
        nodes: store.listNodesForSnapshot(snapshot.id),
        edges: store.listEdgesForSnapshot(snapshot.id),
        evidence: store.listEvidenceForSnapshot(snapshot.id),
      });
    }
  });
  return data;
}

function writeLegacyKnowledgeBaseToDedicatedStore(
  sessionDir: string,
  legacy: LegacyKnowledgeBaseData,
): void {
  writeKnowledgeBaseDatabase(sessionDir, legacy.base.id, true, (tx) => {
    const store = new KnowledgeBaseDAO(null);
    // If a prior migration attempt committed the destination before a crash,
    // replace that complete private copy with the still-authoritative source.
    store.deleteBase(tx, legacy.base.id);
    store.insertBase(tx, legacy.base);
    for (const item of legacy.snapshots) {
      store.insertSnapshot(tx, item.snapshot);
      store.insertFiles(tx, item.files);
      store.insertChunks(tx, item.chunks);
      store.insertNodes(tx, item.nodes);
      store.insertEdges(tx, item.edges);
      store.insertEvidence(tx, item.evidence);
    }
    store.pruneSnapshotsExcept(
      tx,
      legacy.base.id,
      legacy.base.activeSnapshotId,
    );
  });
}

/** Normalizes and validates a knowledge-base spec in place. */
export function validateKnowledgeBaseSpec(spec: KnowledgeBaseSpec): void {
  if (spec === null || spec === undefined) {
    throw new Error("knowledge base configuration is required");
  }
  spec.name = spec.name.trim();
  spec.rootDir = path.normalize(spec.rootDir.trim());
  spec.preprocessProfile = spec.preprocessProfile.trim().toLowerCase();
  spec.provider = spec.provider.trim();
  spec.model = spec.model.trim();
  spec.mode = spec.mode.trim();
  spec.thinkingLevel = (spec.thinkingLevel ?? "").trim();
  spec.schedule = spec.schedule.trim();
  if (spec.name === "") throw new Error("knowledge base name is required");
  if (!path.isAbsolute(spec.rootDir)) {
    throw new Error("knowledge base root directory must be absolute");
  }
  let info: FileInfo;
  try {
    info = runtime.statSync(spec.rootDir);
  } catch (err) {
    throw new Error(`knowledge base root directory: ${err}`);
  }
  if (!info.isDirectory) {
    throw new Error("knowledge base root directory is not a directory");
  }
  switch (spec.preprocessProfile) {
    case "documents":
    case "code":
    case "notes":
    case "mixed":
      break;
    default:
      throw new Error(
        `unsupported knowledge base preprocess profile ${JSON.stringify(
          spec.preprocessProfile,
        )}`,
      );
  }
  if (spec.mode === "") spec.mode = "yolo";
  if (spec.schedule === "") spec.schedule = "manual";
  if (spec.schedule.length > 128 || /[\r\n]/.test(spec.schedule)) {
    throw new Error("invalid knowledge base schedule");
  }
}

/** Normalizes and validates a graph snapshot in place. */
export function validateKnowledgeGraphSnapshot(
  graph: KnowledgeGraphSnapshot,
): void {
  if (graph === null || graph === undefined) {
    throw new Error("knowledge graph snapshot is required");
  }
  graph.snapshot.id = graph.snapshot.id.trim();
  graph.snapshot.knowledgeBaseId = graph.snapshot.knowledgeBaseId.trim();
  if (graph.snapshot.id === "" || graph.snapshot.knowledgeBaseId === "") {
    throw new Error("knowledge graph snapshot and base IDs are required");
  }
  for (const file of graph.files) {
    if (
      file.id === "" ||
      file.snapshotId !== graph.snapshot.id ||
      file.relativePath === ""
    ) {
      throw new Error("invalid knowledge graph file");
    }
  }
  for (const chunk of graph.chunks) {
    if (
      chunk.id === "" ||
      chunk.snapshotId !== graph.snapshot.id ||
      chunk.fileId === "" ||
      chunk.startLine <= 0 ||
      chunk.endLine < chunk.startLine
    ) {
      throw new Error("invalid knowledge graph chunk");
    }
  }
  for (const node of graph.nodes) {
    if (
      node.id === "" ||
      node.snapshotId !== graph.snapshot.id ||
      node.kind === "" ||
      node.normalizedLabel === ""
    ) {
      throw new Error("invalid knowledge graph node");
    }
  }
  for (const edge of graph.edges) {
    if (
      edge.id === "" ||
      edge.snapshotId !== graph.snapshot.id ||
      edge.fromNodeId === "" ||
      edge.toNodeId === "" ||
      edge.relationType === ""
    ) {
      throw new Error("invalid knowledge graph edge");
    }
  }
  for (const evidence of graph.evidence) {
    if (
      evidence.id === "" ||
      evidence.snapshotId !== graph.snapshot.id ||
      evidence.chunkId === "" ||
      ((evidence.nodeId ?? "") === "" && (evidence.edgeId ?? "") === "")
    ) {
      throw new Error("invalid knowledge graph evidence");
    }
  }
}

function knowledgeBaseRecord(base: KnowledgeBase): KnowledgeBaseRecord {
  return {
    id: base.id,
    name: base.name,
    rootDir: base.rootDir,
    preprocessProfile: base.preprocessProfile,
    provider: base.provider,
    model: base.model,
    mode: base.mode,
    thinkingLevel: base.thinkingLevel ?? "",
    schedule: base.schedule,
    enabled: boolToInt(base.enabled),
    activeSnapshotId: base.activeSnapshotId,
    createdAt: base.createdAt.toISOString(),
    updatedAt: base.updatedAt.toISOString(),
  };
}

function knowledgeBaseFromRecord(record: KnowledgeBaseRecord): KnowledgeBase {
  return {
    id: record.id,
    name: record.name,
    rootDir: record.rootDir,
    preprocessProfile: record.preprocessProfile,
    provider: record.provider,
    model: record.model,
    mode: record.mode,
    thinkingLevel: record.thinkingLevel,
    schedule: record.schedule,
    enabled: record.enabled !== 0,
    activeSnapshotId: record.activeSnapshotId,
    createdAt: parseProjectTime(record.createdAt),
    updatedAt: parseProjectTime(record.updatedAt),
  };
}

function knowledgeSnapshotRecord(
  snapshot: KnowledgeSnapshot,
): KnowledgeSnapshotRecord {
  return {
    id: snapshot.id,
    knowledgeBaseId: snapshot.knowledgeBaseId,
    runId: snapshot.runId ?? "",
    status: snapshot.status,
    schemaVersion: snapshot.schemaVersion,
    fileCount: snapshot.fileCount,
    chunkCount: snapshot.chunkCount,
    nodeCount: snapshot.nodeCount,
    edgeCount: snapshot.edgeCount,
    startedAt: timestampString(snapshot.startedAt, false),
    finishedAt: timestampString(snapshot.finishedAt, true),
    errorSummary: snapshot.errorSummary ?? "",
  };
}

function knowledgeSnapshotFromRecord(
  record: KnowledgeSnapshotRecord,
): KnowledgeSnapshot {
  return {
    id: record.id,
    knowledgeBaseId: record.knowledgeBaseId,
    runId: record.runId,
    status: record.status,
    schemaVersion: record.schemaVersion,
    fileCount: record.fileCount,
    chunkCount: record.chunkCount,
    nodeCount: record.nodeCount,
    edgeCount: record.edgeCount,
    startedAt: parseProjectTime(record.startedAt),
    finishedAt:
      record.finishedAt === ""
        ? undefined
        : parseProjectTime(record.finishedAt),
    errorSummary: record.errorSummary,
  };
}

function timestampString(
  value: Date | undefined,
  emptyWhenMissing: boolean,
): string {
  if (value === undefined || Number.isNaN(value.getTime())) {
    return emptyWhenMissing ? "" : "";
  }
  return value.toISOString();
}

function knowledgeFileRecords(files: KnowledgeFile[]): KnowledgeFileRecord[] {
  return files.map((file) => ({
    id: file.id,
    snapshotId: file.snapshotId,
    relativePath: file.relativePath,
    contentSha256: file.contentSha256,
    byteSize: file.byteSize,
    mediaType: file.mediaType,
    title: file.title ?? "",
    status: file.status,
  }));
}

function knowledgeChunkRecords(
  chunks: KnowledgeChunk[],
): KnowledgeChunkRecord[] {
  return chunks.map((chunk) => ({
    id: chunk.id,
    snapshotId: chunk.snapshotId,
    fileId: chunk.fileId,
    relativePath: chunk.relativePath ?? "",
    ordinal: chunk.ordinal,
    text: chunk.text,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    contentSha256: chunk.contentSha256,
  }));
}

function knowledgeNodeRecords(nodes: KnowledgeNode[]): KnowledgeNodeRecord[] {
  return nodes.map((node) => ({
    id: node.id,
    snapshotId: node.snapshotId,
    kind: node.kind,
    label: node.label,
    normalizedLabel: node.normalizedLabel,
    summary: node.summary ?? "",
    attributes: "{}",
  }));
}

function knowledgeEdgeRecords(edges: KnowledgeEdge[]): KnowledgeEdgeRecord[] {
  return edges.map((edge) => ({
    id: edge.id,
    snapshotId: edge.snapshotId,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    relationType: edge.relationType,
    confidence: edge.confidence,
  }));
}

function knowledgeEvidenceRecords(
  evidence: KnowledgeEvidence[],
): KnowledgeEvidenceRecord[] {
  return evidence.map((item) => ({
    id: item.id,
    snapshotId: item.snapshotId,
    nodeId: item.nodeId ?? "",
    edgeId: item.edgeId ?? "",
    chunkId: item.chunkId,
    startLine: item.startLine,
    endLine: item.endLine,
    confidence: item.confidence,
  }));
}

function knowledgeChunksFromRecords(
  records: KnowledgeChunkRecord[],
): KnowledgeChunk[] {
  return records.map((record) => ({
    id: record.id,
    snapshotId: record.snapshotId,
    fileId: record.fileId,
    ordinal: record.ordinal,
    relativePath: record.relativePath,
    text: record.text,
    startLine: record.startLine,
    endLine: record.endLine,
    contentSha256: record.contentSha256,
  }));
}

function knowledgeNodesFromRecords(
  records: KnowledgeNodeRecord[],
): KnowledgeNode[] {
  return records.map((record) => ({
    id: record.id,
    snapshotId: record.snapshotId,
    kind: record.kind,
    label: record.label,
    normalizedLabel: record.normalizedLabel,
    summary: record.summary,
  }));
}

function knowledgeEdgesFromRecords(
  records: KnowledgeEdgeRecord[],
): KnowledgeEdge[] {
  return records.map((record) => ({
    id: record.id,
    snapshotId: record.snapshotId,
    fromNodeId: record.fromNodeId,
    toNodeId: record.toNodeId,
    relationType: record.relationType,
    confidence: record.confidence,
  }));
}

function emptySnapshot(): KnowledgeSnapshot {
  return {
    id: "",
    knowledgeBaseId: "",
    runId: "",
    status: "",
    schemaVersion: 0,
    fileCount: 0,
    chunkCount: 0,
    nodeCount: 0,
    edgeCount: 0,
    startedAt: new Date(NaN),
    finishedAt: undefined,
    errorSummary: "",
  };
}
