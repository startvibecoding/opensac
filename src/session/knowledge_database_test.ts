import { assert, assertEquals } from "../compat/assert.ts";
import { closeAll } from "../db/mod.ts";
import { KnowledgeBaseDAO } from "../dao/mod.ts";
import {
  appendKnowledgeFileGraph,
  createKnowledgeBase,
  deleteKnowledgeBase,
  getKnowledgeSnapshot,
  KNOWLEDGE_GRAPH_SCHEMA_VERSION,
  type KnowledgeFile,
  type KnowledgeGraphSnapshot,
  listKnowledgeBases,
  prepareKnowledgeGraphReusePlan,
  queryKnowledgeGraph,
  storeKnowledgeGraphSnapshot,
  updateKnowledgeBase,
} from "./knowledge_bases.ts";
import {
  knowledgeBaseDatabasePath,
  queryKnowledgeBaseDatabase,
} from "./knowledge_database.ts";
import { knowledgeStoreSchema } from "./migrations.ts";
import { openRootDB } from "./root_db.ts";
import { writeRootDatabase } from "./database.ts";
import { test } from "#testing";

test("knowledge base uses dedicated SQLite database", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-session-" });
  const rootDir = Deno.makeTempDirSync({ prefix: "opensac-root-" });
  try {
    const base = createKnowledgeBase(sessionDir, {
      name: "Dedicated",
      rootDir,
      preprocessProfile: "documents",
      provider: "",
      model: "",
      mode: "",
      schedule: "manual",
      enabled: true,
    });
    const dbPath = knowledgeBaseDatabasePath(sessionDir, base.id);
    assert(Deno.statSync(dbPath).isFile);
    assertNoKnowledgeTablesInSessionDatabase(sessionDir);

    const now = new Date();
    const graph: KnowledgeGraphSnapshot = {
      snapshot: {
        id: "snapshot",
        knowledgeBaseId: base.id,
        status: "indexing",
        schemaVersion: 0,
        fileCount: 0,
        chunkCount: 0,
        nodeCount: 0,
        edgeCount: 0,
        startedAt: now,
      },
      files: [{
        id: "file",
        snapshotId: "snapshot",
        relativePath: "architecture.md",
        contentSha256: "hash",
        byteSize: 12,
        mediaType: "",
        status: "indexed",
      }],
      chunks: [{
        id: "chunk",
        snapshotId: "snapshot",
        fileId: "file",
        ordinal: 0,
        text: "Alpha owns the runtime.",
        startLine: 1,
        endLine: 1,
        contentSha256: "hash",
      }],
      nodes: [{
        id: "node",
        snapshotId: "snapshot",
        kind: "section",
        label: "Alpha",
        normalizedLabel: "alpha",
      }],
      edges: [],
      evidence: [{
        id: "evidence",
        snapshotId: "snapshot",
        nodeId: "node",
        chunkId: "chunk",
        startLine: 1,
        endLine: 1,
        confidence: 1,
      }],
    };
    storeKnowledgeGraphSnapshot(sessionDir, graph);
    const query = queryKnowledgeGraph(sessionDir, base.id, "Alpha", 4);
    assertEquals(query.chunks.length, 1);
    assertEquals(query.nodes.length, 1);
    assertNoKnowledgeTablesInSessionDatabase(sessionDir);

    deleteKnowledgeBase(sessionDir, base.id);
    let exists = true;
    try {
      Deno.statSync(dbPath);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) exists = false;
      else throw err;
    }
    assertEquals(exists, false);
  } finally {
    closeAll();
    Deno.removeSync(sessionDir, { recursive: true });
    Deno.removeSync(rootDir, { recursive: true });
  }
});

test("knowledge snapshot retention keeps only active graph", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-session-" });
  const rootDir = Deno.makeTempDirSync({ prefix: "opensac-root-" });
  try {
    const base = createKnowledgeBase(sessionDir, {
      name: "Retention",
      rootDir,
      preprocessProfile: "documents",
      provider: "",
      model: "",
      mode: "",
      schedule: "manual",
      enabled: true,
    });
    storeKnowledgeGraphSnapshot(
      sessionDir,
      knowledgeGraphForRetention(base.id, "first", "First indexed fact."),
    );
    storeKnowledgeGraphSnapshot(
      sessionDir,
      knowledgeGraphForRetention(base.id, "second", "Second indexed fact."),
    );

    let unindexed = false;
    try {
      getKnowledgeSnapshot(sessionDir, "first");
    } catch {
      unindexed = true;
    }
    assertEquals(unindexed, true);

    const query = queryKnowledgeGraph(sessionDir, base.id, "Second", 4);
    assertEquals(query.snapshot.id, "second");
    assertEquals(query.chunks.length, 1);
    assertEquals(query.chunks[0].snapshotId, "second");
    assertKnowledgeGraphRowCounts(sessionDir, base.id, 1, 1, 1, 1);
  } finally {
    closeAll();
    Deno.removeSync(sessionDir, { recursive: true });
    Deno.removeSync(rootDir, { recursive: true });
  }
});

test("knowledge base update invalidates and prunes graph", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-session-" });
  const rootDir = Deno.makeTempDirSync({ prefix: "opensac-root-" });
  try {
    const base = createKnowledgeBase(sessionDir, {
      name: "Reconfigure",
      rootDir,
      preprocessProfile: "documents",
      provider: "",
      model: "",
      mode: "",
      schedule: "manual",
      enabled: true,
    });
    storeKnowledgeGraphSnapshot(
      sessionDir,
      knowledgeGraphForRetention(
        base.id,
        "before-update",
        "Configuration-sensitive fact.",
      ),
    );
    const updated = updateKnowledgeBase(sessionDir, base.id, {
      name: "Reconfigured",
      rootDir,
      preprocessProfile: "documents",
      provider: "",
      model: "",
      mode: "",
      schedule: "manual",
      enabled: true,
    });
    assertEquals(updated.activeSnapshotId, "");
    let unindexed = false;
    try {
      queryKnowledgeGraph(sessionDir, base.id, "Configuration", 4);
    } catch {
      unindexed = true;
    }
    assertEquals(unindexed, true);
    assertKnowledgeGraphRowCounts(sessionDir, base.id, 0, 0, 0, 0);
  } finally {
    closeAll();
    Deno.removeSync(sessionDir, { recursive: true });
    Deno.removeSync(rootDir, { recursive: true });
  }
});

test("knowledge base migrates legacy session store into dedicated database", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-session-" });
  const rootDir = Deno.makeTempDirSync({ prefix: "opensac-root-" });
  try {
    const baseID = "legacybase";
    const baseRecord = {
      id: baseID,
      name: "Legacy",
      rootDir,
      preprocessProfile: "documents",
      provider: "",
      model: "",
      mode: "",
      thinkingLevel: "",
      schedule: "manual",
      enabled: 1,
      activeSnapshotId: "legacy-snapshot",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const root = openRootDB(sessionDir);
    root.db!.exec(knowledgeStoreSchema);
    writeRootDatabase(sessionDir, (tx) => {
      const store = new KnowledgeBaseDAO(null);
      store.insertBase(tx, baseRecord);
      const retired = {
        id: "legacy-retired",
        knowledgeBaseId: baseID,
        runId: "",
        status: "completed",
        schemaVersion: KNOWLEDGE_GRAPH_SCHEMA_VERSION,
        fileCount: 0,
        chunkCount: 0,
        nodeCount: 0,
        edgeCount: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        errorSummary: "",
      };
      store.insertSnapshot(tx, retired);
      const snapshot = {
        id: "legacy-snapshot",
        knowledgeBaseId: baseID,
        runId: "",
        status: "completed",
        schemaVersion: KNOWLEDGE_GRAPH_SCHEMA_VERSION,
        fileCount: 1,
        chunkCount: 1,
        nodeCount: 1,
        edgeCount: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        errorSummary: "",
      };
      store.insertSnapshot(tx, snapshot);
      store.insertFiles(tx, [{
        id: "legacy-file",
        snapshotId: snapshot.id,
        relativePath: "legacy.md",
        contentSha256: "hash",
        byteSize: 10,
        mediaType: "",
        title: "",
        status: "indexed",
      }]);
      store.insertChunks(tx, [{
        id: "legacy-chunk",
        snapshotId: snapshot.id,
        fileId: "legacy-file",
        relativePath: "",
        ordinal: 0,
        text: "Legacy Alpha evidence.",
        startLine: 1,
        endLine: 1,
        contentSha256: "hash",
      }]);
      store.insertNodes(tx, [{
        id: "legacy-node",
        snapshotId: snapshot.id,
        kind: "section",
        label: "Alpha",
        normalizedLabel: "alpha",
        summary: "",
        attributes: "{}",
      }]);
      store.insertEvidence(tx, [{
        id: "legacy-evidence",
        snapshotId: snapshot.id,
        nodeId: "legacy-node",
        edgeId: "",
        chunkId: "legacy-chunk",
        startLine: 1,
        endLine: 1,
        confidence: 1,
      }]);
    });

    const bases = listKnowledgeBases(sessionDir);
    assertEquals(bases.length, 1);
    assertEquals(bases[0].id, baseID);
    const query = queryKnowledgeGraph(sessionDir, baseID, "Alpha", 4);
    assertEquals(query.chunks.length, 1);
    assertEquals(query.snapshot.id, "legacy-snapshot");
    let unindexed = false;
    try {
      getKnowledgeSnapshot(sessionDir, "legacy-retired");
    } catch {
      unindexed = true;
    }
    assertEquals(unindexed, true);
    assertKnowledgeGraphRowCounts(sessionDir, baseID, 1, 1, 1, 1);
    assert(Deno.statSync(knowledgeBaseDatabasePath(sessionDir, baseID)).isFile);
    const remaining = root.db!.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM knowledge_bases`,
    )!;
    assertEquals(remaining.n, 0);
  } finally {
    closeAll();
    Deno.removeSync(sessionDir, { recursive: true });
    Deno.removeSync(rootDir, { recursive: true });
  }
});

test("knowledge graph reuse plan clones only unchanged file subgraph", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-session-" });
  const rootDir = Deno.makeTempDirSync({ prefix: "opensac-root-" });
  try {
    const base = createKnowledgeBase(sessionDir, {
      name: "Incremental",
      rootDir,
      preprocessProfile: "documents",
      provider: "",
      model: "",
      mode: "",
      schedule: "manual",
      enabled: true,
    });
    const now = new Date();
    const stable: KnowledgeFile = {
      id: "stable-file",
      snapshotId: "source",
      relativePath: "stable.md",
      contentSha256: "stable-hash",
      byteSize: 10,
      mediaType: "text/markdown",
      status: "indexed",
    };
    const changed: KnowledgeFile = {
      id: "changed-file",
      snapshotId: "source",
      relativePath: "changed.md",
      contentSha256: "old-hash",
      byteSize: 10,
      mediaType: "text/markdown",
      status: "indexed",
    };
    const graph: KnowledgeGraphSnapshot = {
      snapshot: {
        id: "source",
        knowledgeBaseId: base.id,
        status: "indexing",
        schemaVersion: 0,
        fileCount: 0,
        chunkCount: 0,
        nodeCount: 0,
        edgeCount: 0,
        startedAt: now,
      },
      files: [stable, changed],
      chunks: [
        {
          id: "stable-chunk",
          snapshotId: "source",
          fileId: stable.id,
          ordinal: 0,
          text: "stable evidence",
          startLine: 1,
          endLine: 1,
          contentSha256: "stable-chunk-hash",
        },
        {
          id: "changed-chunk",
          snapshotId: "source",
          fileId: changed.id,
          ordinal: 0,
          text: "old evidence",
          startLine: 1,
          endLine: 1,
          contentSha256: "changed-chunk-hash",
        },
      ],
      nodes: [
        {
          id: "stable-file-node",
          snapshotId: "source",
          kind: "file",
          label: "stable.md",
          normalizedLabel: "stable.md",
        },
        {
          id: "stable-section",
          snapshotId: "source",
          kind: "section",
          label: "Stable",
          normalizedLabel: "stable\u0000stable",
        },
        {
          id: "changed-node",
          snapshotId: "source",
          kind: "file",
          label: "changed.md",
          normalizedLabel: "changed.md",
        },
      ],
      edges: [{
        id: "stable-edge",
        snapshotId: "source",
        fromNodeId: "stable-file-node",
        toNodeId: "stable-section",
        relationType: "contains",
        confidence: 1,
      }],
      evidence: [
        {
          id: "stable-file-evidence",
          snapshotId: "source",
          nodeId: "stable-file-node",
          chunkId: "stable-chunk",
          startLine: 1,
          endLine: 1,
          confidence: 1,
        },
        {
          id: "stable-section-evidence",
          snapshotId: "source",
          nodeId: "stable-section",
          chunkId: "stable-chunk",
          startLine: 1,
          endLine: 1,
          confidence: 1,
        },
        {
          id: "stable-edge-evidence",
          snapshotId: "source",
          edgeId: "stable-edge",
          chunkId: "stable-chunk",
          startLine: 1,
          endLine: 1,
          confidence: 1,
        },
        {
          id: "changed-evidence",
          snapshotId: "source",
          nodeId: "changed-node",
          chunkId: "changed-chunk",
          startLine: 1,
          endLine: 1,
          confidence: 1,
        },
      ],
    };
    storeKnowledgeGraphSnapshot(sessionDir, graph);
    const plan = prepareKnowledgeGraphReusePlan(sessionDir, base.id, [
      {
        id: "",
        snapshotId: "",
        relativePath: stable.relativePath,
        contentSha256: stable.contentSha256,
        byteSize: stable.byteSize,
        mediaType: stable.mediaType,
        status: stable.status,
      },
      {
        id: "",
        snapshotId: "",
        relativePath: changed.relativePath,
        contentSha256: "new-hash",
        byteSize: changed.byteSize,
        mediaType: changed.mediaType,
        status: changed.status,
      },
    ]);
    const reused = plan.files.get(stable.relativePath);
    assert(reused !== undefined);
    assertEquals(plan.files.size, 1);
    assertEquals(reused!.chunks.length, 1);
    assertEquals(reused!.nodes.length, 2);
    assertEquals(reused!.edges.length, 1);
    assertEquals(reused!.evidence.length, 3);
    const target: KnowledgeGraphSnapshot = {
      snapshot: {
        id: "target",
        knowledgeBaseId: base.id,
        status: "",
        schemaVersion: 0,
        fileCount: 0,
        chunkCount: 0,
        nodeCount: 0,
        edgeCount: 0,
        startedAt: new Date(),
      },
      files: [],
      chunks: [],
      nodes: [],
      edges: [],
      evidence: [],
    };
    appendKnowledgeFileGraph(target, reused!);
    assertEquals(target.files.length, 1);
    assertEquals(target.chunks.length, 1);
    assertEquals(target.nodes.length, 2);
    assertEquals(target.edges.length, 1);
    assertEquals(target.evidence.length, 3);
    assert(target.files[0].id !== stable.id);
    assert(target.chunks[0].id !== "stable-chunk");
    assertEquals(target.nodes[0].snapshotId, "target");
    assertEquals(target.edges[0].snapshotId, "target");
    assertEquals(target.evidence[0].snapshotId, "target");
  } finally {
    closeAll();
    Deno.removeSync(sessionDir, { recursive: true });
    Deno.removeSync(rootDir, { recursive: true });
  }
});

function knowledgeGraphForRetention(
  baseID: string,
  snapshotID: string,
  text: string,
): KnowledgeGraphSnapshot {
  const now = new Date();
  const fileID = `file-${snapshotID}`;
  const chunkID = `chunk-${snapshotID}`;
  const nodeID = `node-${snapshotID}`;
  return {
    snapshot: {
      id: snapshotID,
      knowledgeBaseId: baseID,
      status: "indexing",
      schemaVersion: 0,
      fileCount: 0,
      chunkCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      startedAt: now,
    },
    files: [{
      id: fileID,
      snapshotId: snapshotID,
      relativePath: `${snapshotID}.md`,
      contentSha256: `hash-${snapshotID}`,
      byteSize: text.length,
      mediaType: "",
      status: "indexed",
    }],
    chunks: [{
      id: chunkID,
      snapshotId: snapshotID,
      fileId: fileID,
      ordinal: 0,
      text,
      startLine: 1,
      endLine: 1,
      contentSha256: `chunk-hash-${snapshotID}`,
    }],
    nodes: [{
      id: nodeID,
      snapshotId: snapshotID,
      kind: "section",
      label: snapshotID,
      normalizedLabel: snapshotID,
    }],
    edges: [],
    evidence: [{
      id: `evidence-${snapshotID}`,
      snapshotId: snapshotID,
      nodeId: nodeID,
      chunkId: chunkID,
      startLine: 1,
      endLine: 1,
      confidence: 1,
    }],
  };
}

function assertNoKnowledgeTablesInSessionDatabase(sessionDir: string): void {
  const row = openRootDB(sessionDir).db!.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE 'knowledge_%'`,
  )!;
  assertEquals(row.n, 0);
}

function assertKnowledgeGraphRowCounts(
  sessionDir: string,
  baseID: string,
  snapshots: number,
  chunks: number,
  fts: number,
  evidence: number,
): void {
  let gotSnapshots = 0;
  let gotChunks = 0;
  let gotFTS = 0;
  let gotEvidence = 0;
  queryKnowledgeBaseDatabase(sessionDir, baseID, (db) => {
    gotSnapshots = db.db!.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM knowledge_index_snapshots`,
    )!.n;
    gotChunks = db.db!.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM knowledge_chunks`,
    )!.n;
    gotFTS = db.db!.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM knowledge_chunk_fts`,
    )!.n;
    gotEvidence = db.db!.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM knowledge_evidence`,
    )!.n;
  });
  assertEquals(
    [gotSnapshots, gotChunks, gotFTS, gotEvidence],
    [snapshots, chunks, fts, evidence],
  );
}
