//
// Includes the model Indexer/Librarian enrichment cases now that the
// `SessionRuntime` resource assembly is ported: the verified co-mention edge
// projection and the dedicated durable Librarian session.

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertThrows,
} from "@std/assert";
import * as path from "@std/path";
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  getKnowledgeBase,
  getSessionRun,
  KnowledgeBaseNotFoundError,
  type KnowledgeGraphSnapshot,
  listSessionRunEvents,
  listSessionRuns,
} from "../session/mod.ts";
import { defaultSettings, type Settings } from "../config/settings.ts";
import { closeDatabases } from "../session/root_db.ts";
import { createManager } from "../session/manager.ts";
import { createRegistry } from "../tools/tool.ts";
import { createMockProvider } from "../provider/mock.ts";
import type { Provider } from "../provider/provider.ts";
import {
  type ChatParams,
  type Model,
  streamDone,
  type StreamEvent,
  streamStart,
  streamTextDelta,
} from "../provider/types.ts";
import {
  appendVerifiedCoMentionEdges,
  type KnowledgeIndexerBinding,
} from "./knowledge_indexer.ts";
import { knowledgeLibrarianSessionIDForBase } from "./knowledge_librarian.ts";
import { maxKnowledgeCapsuleChars } from "./knowledge_context.ts";
import { attachSessionResources } from "./attach.ts";
import { RUN_STATE_COMPLETED } from "./run_state.ts";
import { MODE_YOLO, SOURCE_ACP } from "./source.ts";
import {
  createKnowledgeBaseService,
  defaultKnowledgeBaseIndexPolicy,
  type KnowledgeBaseProviderFactory,
  makeKnowledgeCapsule,
  prepareKnowledgeContext,
} from "./knowledgebase.ts";

function tempDir(): string {
  return Deno.makeTempDirSync({ dir: Deno.env.get("TMPDIR") });
}

function testModel(id: string, name: string): Model {
  return {
    id,
    name,
    provider: "test-provider",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

function writeFile(root: string, relative: string, body: string): void {
  const full = path.join(root, relative);
  Deno.mkdirSync(path.dirname(full), { recursive: true });
  Deno.writeTextFileSync(full, body);
}

Deno.test("knowledge base indexer stores queryable graph snapshot", async () => {
  const root = tempDir();
  const source = tempDir();
  writeFile(
    source,
    "docs/auth.md",
    "# Authentication Guide\n\nUse bearer tokens for API requests.\n\n## Rotation\n\nRotate tokens every ninety days.\n",
  );
  const base = createKnowledgeBase(root, {
    name: "Product docs",
    rootDir: source,
    preprocessProfile: "documents",
    provider: "test",
    model: "test-model",
    mode: "yolo",
    schedule: "manual",
    enabled: true,
  });
  const service = createKnowledgeBaseService(
    root,
    defaultKnowledgeBaseIndexPolicy(),
  );
  const snapshot = await service.index(undefined, base.id);
  assert(snapshot !== null);
  assertEquals(snapshot.status, "completed");
  assertEquals(snapshot.fileCount, 1);
  assert(snapshot.chunkCount > 0);
  assert(snapshot.nodeCount >= 2);
  assert(snapshot.edgeCount >= 1);

  const stored = getKnowledgeBase(root, base.id);
  assertEquals(stored.activeSnapshotId, snapshot.id);

  const result = service.query(undefined, base.id, "bearer token rotation", 4);
  assert(result.chunks.length > 0);
  assert(result.nodes.length > 0);
  assert(result.edges.length > 0);
  assertEquals(result.chunks[0].relativePath, "docs/auth.md");

  deleteKnowledgeBase(root, base.id);
  let missingErr: unknown = null;
  try {
    service.query(undefined, base.id, "bearer", 4);
  } catch (err) {
    missingErr = err;
  }
  assertInstanceOf(missingErr, KnowledgeBaseNotFoundError);
  assert(Deno.statSync(path.join(source, "docs", "auth.md")).isFile);
});

Deno.test("prepare knowledge context builds bounded cited reference", async () => {
  const sessionDir = tempDir();
  const source = tempDir();
  writeFile(
    source,
    "runtime.md",
    "# Runtime\n\nThe shared runtime owns durable run lifecycle and graph evidence.\n",
  );
  const base = createKnowledgeBase(sessionDir, {
    name: "Runtime docs",
    rootDir: source,
    preprocessProfile: "documents",
    provider: "",
    model: "",
    mode: "",
    schedule: "manual",
    enabled: true,
  });
  const service = createKnowledgeBaseService(
    sessionDir,
    defaultKnowledgeBaseIndexPolicy(),
  );
  await service.index(undefined, base.id);

  const capsules = prepareKnowledgeContext(
    sessionDir,
    "durable graph evidence",
    [
      { knowledgeBaseId: base.id, required: true },
    ],
  );
  assertEquals(capsules.length, 1);
  assert(capsules[0].snapshotId !== "");
  assert(capsules[0].citations.length > 0);
  assertEquals(capsules[0].citations[0].relativePath, "runtime.md");

  assertThrows(
    () =>
      prepareKnowledgeContext(sessionDir, "durable", [
        { knowledgeBaseId: "missing", required: true },
      ]),
    Error,
  );
});

Deno.test("knowledge base indexer ignores symlink and build output", async () => {
  const root = tempDir();
  const source = tempDir();
  const outside = path.join(tempDir(), "secret.md");
  Deno.writeTextFileSync(outside, "# Secret\nnot indexable");
  writeFile(source, "dist/generated.md", "# Generated\nignore me");
  writeFile(source, "notes.md", "# Included\nkeep me");
  Deno.symlinkSync(outside, path.join(source, "linked.md"));

  const base = createKnowledgeBase(root, {
    name: "Notes",
    rootDir: source,
    preprocessProfile: "mixed",
    provider: "",
    model: "",
    mode: "",
    schedule: "manual",
    enabled: true,
  });
  const service = createKnowledgeBaseService(
    root,
    defaultKnowledgeBaseIndexPolicy(),
  );
  const snapshot = await service.index(undefined, base.id);
  assertEquals(snapshot.fileCount, 1);
});

Deno.test("knowledge indexer rejects unsupported model links", () => {
  const graph: KnowledgeGraphSnapshot = {
    snapshot: {
      id: "snapshot",
      knowledgeBaseId: "",
      runId: "",
      status: "",
      schemaVersion: 1,
      fileCount: 0,
      chunkCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      startedAt: new Date(0),
      finishedAt: undefined,
      errorSummary: "",
    },
    files: [],
    chunks: [{
      id: "chunk",
      snapshotId: "snapshot",
      fileId: "",
      ordinal: 0,
      text: "Alpha is documented here.",
      startLine: 4,
      endLine: 5,
      contentSha256: "",
    }],
    nodes: [
      {
        id: "alpha",
        snapshotId: "snapshot",
        kind: "section",
        label: "Alpha",
        normalizedLabel: "",
        summary: "",
      },
      {
        id: "beta",
        snapshotId: "snapshot",
        kind: "section",
        label: "Beta",
        normalizedLabel: "",
        summary: "",
      },
    ],
    edges: [],
    evidence: [],
  };
  appendVerifiedCoMentionEdges(graph, [
    {
      fromNodeId: "alpha",
      toNodeId: "beta",
      chunkId: "chunk",
      startLine: 4,
      endLine: 5,
    },
    {
      fromNodeId: "alpha",
      toNodeId: "missing",
      chunkId: "chunk",
      startLine: 4,
      endLine: 5,
    },
    {
      fromNodeId: "alpha",
      toNodeId: "beta",
      chunkId: "chunk",
      startLine: 2,
      endLine: 5,
    },
  ]);
  assertEquals(graph.edges.length, 0);
  assertEquals(graph.evidence.length, 0);
});

Deno.test("knowledge indexer clones unchanged file graph when another file changes", async () => {
  const sessionDir = tempDir();
  const source = tempDir();
  writeFile(
    source,
    "stable.md",
    "# Stable\n\nStable evidence remains available.\n",
  );
  writeFile(source, "changed.md", "# Changed\n\nFirst revision.\n");
  const base = createKnowledgeBase(sessionDir, {
    name: "Incremental docs",
    rootDir: source,
    preprocessProfile: "documents",
    provider: "",
    model: "",
    mode: "",
    schedule: "manual",
    enabled: true,
  });
  const service = createKnowledgeBaseService(
    sessionDir,
    defaultKnowledgeBaseIndexPolicy(),
  );
  const first = await service.index(undefined, base.id);
  writeFile(
    source,
    "changed.md",
    "# Changed\n\nSecond revision adds new material.\n",
  );
  const second = await service.index(undefined, base.id);
  assert(second.id !== first.id);
  assertEquals(second.fileCount, 2);
  const stable = service.query(undefined, base.id, "Stable evidence", 4);
  assert(stable.chunks.length > 0);
  assertEquals(stable.chunks[0].relativePath, "stable.md");
  assert(stable.nodes.length > 0);
});

Deno.test("knowledge base query matches chinese evidence", async () => {
  const root = tempDir();
  const source = tempDir();
  writeFile(
    source,
    "架构.md",
    "# 架构说明\n\n知识库是一个可重建的图谱索引系统。\n\n## 调度\n\n定时扫描复用 canonical Run 生命周期。\n",
  );
  const base = createKnowledgeBase(root, {
    name: "产品文档",
    rootDir: source,
    preprocessProfile: "documents",
    provider: "",
    model: "",
    mode: "yolo",
    schedule: "manual",
    enabled: true,
  });
  const service = createKnowledgeBaseService(
    root,
    defaultKnowledgeBaseIndexPolicy(),
  );
  const snapshot = await service.index(undefined, base.id);
  assertEquals(snapshot.status, "completed");
  assertEquals(snapshot.fileCount, 1);
  for (const query of ["知识库", "图谱索引", "索引系统", "定时扫描"]) {
    const result = service.query(undefined, base.id, query, 4);
    assert(result.chunks.length > 0, `query ${query} returned no chunks`);
    assertEquals(result.chunks[0].relativePath, "架构.md");
    assert(result.chunks[0].text.includes("知识库"));
  }
  const heading = service.query(undefined, base.id, "架构说明", 4);
  assert(heading.chunks.length > 0);
  const absent = service.query(undefined, base.id, "向量数据库", 4);
  assertEquals(absent.chunks.length, 0);
});

Deno.test("knowledge base service set settings refreshes indexer factory", () => {
  const sessionDir = tempDir();
  const source = tempDir();
  writeFile(source, "notes.md", "# Notes\n\nAlpha is documented here.\n");
  const seen: string[] = [];
  const factory: KnowledgeBaseProviderFactory = (
    settings: Settings,
  ) => {
    seen.push(settings.defaultModel ?? "");
    return {
      provider: {} as unknown as Provider,
      model: { id: "indexer-model", name: "Indexer model" } as unknown as Model,
    };
  };
  const service = createKnowledgeBaseService(
    sessionDir,
    defaultKnowledgeBaseIndexPolicy(),
    { sessionDir, defaultModel: "first" } as Settings,
    factory,
  );
  const base = createKnowledgeBase(sessionDir, {
    name: "Notes",
    rootDir: source,
    preprocessProfile: "documents",
    provider: "indexer",
    model: "indexer-model",
    mode: "yolo",
    schedule: "manual",
    enabled: true,
  });
  const first: KnowledgeIndexerBinding | null = service.resolveKnowledgeIndexer(
    base,
  );
  assert(first !== null);
  service.setSettings({ sessionDir, defaultModel: "second" } as Settings);
  const second: KnowledgeIndexerBinding | null = service
    .resolveKnowledgeIndexer(base);
  assert(second !== null);
  assertEquals(seen, ["first", "second"]);
});

Deno.test("make knowledge capsule enforces a zero budget", () => {
  const capsule = makeKnowledgeCapsule({
    knowledgeBase: {} as never,
    snapshot: {} as never,
    chunks: [],
    nodes: [],
    edges: [],
  }, 0);
  assertEquals(capsule.text, "");
  assertEquals(capsule.citations.length, 0);
});

/**
 * A deterministic Indexer provider: it echoes a single evidence-backed
 * co-mention link when the prompt carries at least two nodes and one chunk,
 * and records the enabled tools so the test can pin the read-only surface.
 */
class KnowledgeIndexerTestProvider implements Provider {
  readonly model: Model;
  calls = 0;
  toolNames: string[] = [];

  constructor(model: Model) {
    this.model = model;
  }

  name(): string {
    return "indexer";
  }

  api(): string {
    return "openai-chat";
  }

  models(): Model[] {
    return [this.model];
  }

  getModel(id: string): Model | undefined {
    return this.model.id === id ? this.model : undefined;
  }

  async *chat(params: ChatParams): AsyncGenerator<StreamEvent> {
    this.calls++;
    this.toolNames = (params.tools ?? []).map((tool) => tool.name);
    let input: {
      nodes?: { id: string }[];
      chunks?: { id: string; startLine: number; endLine: number }[];
    } = {};
    for (const message of params.messages) {
      let content = message.content ?? "";
      for (const block of message.contents ?? []) {
        if (block.type === "text") content += block.text ?? "";
      }
      const marker = "<untrusted-index-input>\n";
      const start = content.indexOf(marker);
      const end = content.indexOf("\n</untrusted-index-input>");
      if (start < 0 || end < 0 || end <= start) continue;
      try {
        input = JSON.parse(content.slice(start + marker.length, end));
      } catch {
        // Non-JSON prompt fragments are ignored, as in the Go fixture.
      }
    }
    let response = '{"links":[]}';
    const nodes = input.nodes ?? [];
    const chunks = input.chunks ?? [];
    if (nodes.length >= 2 && chunks.length > 0) {
      const chunk = chunks[0];
      response = JSON.stringify({
        links: [{
          fromNodeId: nodes[0].id,
          toNodeId: nodes[1].id,
          chunkId: chunk.id,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
        }],
      });
    }
    yield { type: streamStart };
    yield { type: streamTextDelta, textDelta: response };
    yield { type: streamDone, stopReason: "stop" };
  }
}

Deno.test(
  "knowledge indexer adds only evidence-verified co-mention edges",
  async () => {
    const sessionDir = tempDir();
    const source = tempDir();
    const content =
      "# Alpha\n\nAlpha and Beta are both discussed in this architecture note.\n\n## Beta\n\nBeta is documented alongside Alpha.\n";
    writeFile(source, "architecture.md", content);
    const model = testModel("indexer-model", "Indexer model");
    const indexer = new KnowledgeIndexerTestProvider(model);
    const base = createKnowledgeBase(sessionDir, {
      name: "Architecture",
      rootDir: source,
      preprocessProfile: "documents",
      provider: "indexer",
      model: model.id,
      mode: MODE_YOLO,
      schedule: "manual",
      enabled: true,
    });
    const settings = defaultSettings();
    settings.sessionDir = sessionDir;
    const service = createKnowledgeBaseService(
      sessionDir,
      defaultKnowledgeBaseIndexPolicy(),
      settings,
      () => ({ provider: indexer, model }),
    );
    try {
      const snapshot = await service.index(undefined, base.id);
      assertEquals(indexer.calls, 1);
      assert(
        snapshot.edgeCount >= 3,
        `edge count ${snapshot.edgeCount} is below 3`,
      );
      for (const name of indexer.toolNames) {
        assert(
          ["read", "ls", "grep", "find"].includes(name),
          `indexer received non-read-only tool ${name}`,
        );
      }
      const graph = service.query(undefined, base.id, "Alpha Beta", 8);
      let found = false;
      for (const edge of graph.edges) {
        if (edge.relationType === "co_mentions") {
          found = true;
          assertEquals(edge.confidence, 1);
        }
      }
      assert(found, "want a verified co_mentions edge");

      const run = getSessionRun(sessionDir, snapshot.runId ?? "");
      assert(run !== null, "index Run missing");
      assertEquals(run!.model, model.id);
      assertEquals(run!.status, RUN_STATE_COMPLETED);

      const reused = await service.index(undefined, base.id);
      assertEquals(reused.id, snapshot.id);
      assertEquals(indexer.calls, 1, "reuse must not call the model again");

      const events = listSessionRunEvents(
        sessionDir,
        knowledgeLibrarianSessionIDForBase(base),
      );
      let reusedEvent = false;
      for (const event of events) {
        if (
          event.eventType === "knowledge_snapshot_reused" &&
          event.runId !== snapshot.runId
        ) {
          reusedEvent = true;
        }
      }
      assert(reusedEvent, "reuse event missing");

      writeFile(
        source,
        "architecture.md",
        content + "\n## Gamma\n\nGamma is a new indexed section.\n",
      );
      const changed = await service.index(undefined, base.id);
      assert(changed.id !== snapshot.id, "changed scan must create a snapshot");
      assertEquals(indexer.calls, 2);
    } finally {
      closeDatabases();
    }
  },
);

Deno.test(
  "knowledge librarian uses dedicated agent session and durable run",
  async () => {
    const sessionDir = tempDir();
    const source = tempDir();
    writeFile(
      source,
      "runtime.md",
      "# Runtime\n\nThe runtime owns durable Runs and controls graph evidence.\n",
    );
    const model = testModel("librarian-model", "Librarian model");
    const mock = createMockProvider("librarian", [model], [
      { type: streamStart },
      {
        type: streamTextDelta,
        textDelta:
          "The shared runtime owns durable Runs. See runtime.md lines 1-3.",
      },
      { type: streamDone, stopReason: "stop" },
    ]);
    const base = createKnowledgeBase(sessionDir, {
      name: "Runtime docs",
      rootDir: source,
      preprocessProfile: "documents",
      provider: "librarian",
      model: model.id,
      mode: MODE_YOLO,
      schedule: "manual",
      enabled: true,
    });
    const service = createKnowledgeBaseService(
      sessionDir,
      defaultKnowledgeBaseIndexPolicy(),
    );
    await service.index(undefined, base.id);
    const graph = service.query(undefined, base.id, "who owns durable run", 6);

    const callerWorkDir = tempDir();
    const callerManager = createManager(callerWorkDir, sessionDir);
    callerManager.init();
    const caller = await attachSessionResources({
      id: callerManager.getHeader()!.id,
      source: SOURCE_ACP,
      entrySource: SOURCE_ACP,
      workDir: callerWorkDir,
      manager: callerManager,
      registry: createRegistry(callerWorkDir, undefined),
      providers: { librarian: mock },
      settings: { ...defaultSettings(), sessionDir },
    });
    try {
      caller.configureSession(mock, "librarian", model, MODE_YOLO, "");
      const capsule = await service.librarianCapsule(
        undefined,
        caller,
        getKnowledgeBase(sessionDir, base.id),
        graph,
        "who owns durable run",
        maxKnowledgeCapsuleChars,
      );
      assert(
        capsule.text.includes("owns durable Runs"),
        `librarian capsule = ${JSON.stringify(capsule)}`,
      );
      assert(capsule.citations.length > 0, "capsule has no citations");
      assertEquals(mock.getCallCount(), 1);

      const librarianSessionID = knowledgeLibrarianSessionIDForBase(base);
      const runs = listSessionRuns(sessionDir, librarianSessionID, 10);
      let librarianRunFound = false;
      for (const run of runs) {
        assert(
          run.id !== "" && run.sessionId !== callerManager.getHeader()!.id,
          "librarian Run incorrectly used caller session or has no identity",
        );
        if (run.model === model.id) {
          librarianRunFound = run.status === RUN_STATE_COMPLETED;
        }
      }
      assert(
        librarianRunFound,
        `librarian durable Run missing from ${JSON.stringify(runs)}`,
      );
    } finally {
      caller.close();
      closeDatabases();
    }
  },
);
