// Ported from internal/agentruntime/knowledgebase.go plus the
// `KnowledgeBaseService` methods of knowledge_index_job.go /
// knowledge_indexer.go / knowledge_librarian.go (TypeScript requires one class
// body per module, so every service method is collected here while the free
// helpers stay in their own modules).
//
// KnowledgeBaseService is Runtime-owned indexing and graph-query plumbing for
// Desktop-configured directory knowledge bases. It contains no Desktop UI, ACP
// protocol or provider-message construction, and the source directory is
// always read-only.
//
// The model Indexer/Librarian enrichment paths (`enrichGraphWithIndexer`,
// `librarianCapsule`, `runLibrarian`, and the free `withKnowledgeContext`/
// `prepareKnowledgeContextWithLibrarian` entry points) construct and run an
// ordinary Agent through the shared `SessionRuntime` resource assembly. A base
// without a provider/model binding remains on the deterministic graph path.
//
// Deviations: `context.Context` maps to an optional `AbortSignal`; `[]byte`
// maps to `Uint8Array`; `time.Time` maps to `Date`; SHA-256 uses `node:crypto`;
// `os`/`filepath` map to Deno and `@std/path`; `filepath.WalkDir` maps to a
// sorted recursive `Deno.readDirSync` walk; `mime.TypeByExtension` falls back to
// a fixed extension table.

import { createHash } from "node:crypto";
import * as path from "@std/path";
import type { Settings } from "../config/settings.ts";
import type { Provider } from "../provider/provider.ts";
import type { Model, ThinkingLevel } from "../provider/types.ts";
import { create as createProvider } from "../provider/factory/factory.ts";
import {
  appendKnowledgeFileGraph,
  generateID,
  getKnowledgeBase,
  type KnowledgeBase,
  type KnowledgeChunk,
  type KnowledgeFile,
  type KnowledgeGraphQuery,
  type KnowledgeGraphReusePlan,
  KnowledgeGraphSchemaVersion,
  type KnowledgeGraphSnapshot,
  type KnowledgeSnapshot,
  prepareKnowledgeGraphReusePlan,
  queryKnowledgeGraph,
  reuseKnowledgeSnapshotIfFilesMatch,
  storeKnowledgeGraphSnapshot,
} from "../session/mod.ts";
import {
  type KnowledgeBaseReference,
  type KnowledgeCapsule,
  type KnowledgeCitation,
  maxKnowledgeBaseReferences,
  maxKnowledgeCapsuleChars,
  maxKnowledgeExcerptChars,
  truncateKnowledgeText,
} from "./knowledge_context.ts";
import {
  knowledgeBaseDisabledError,
  KnowledgeIndexJob,
  KnowledgeIndexPhaseCommitting,
  KnowledgeIndexPhaseEnriching,
  KnowledgeIndexPhaseIndexing,
  KnowledgeIndexPhaseScanning,
  type KnowledgeIndexProgress,
  newKnowledgeIndexJob,
} from "./knowledge_index_job.ts";
import {
  appendVerifiedCoMentionEdges,
  indexerPrompt,
  indexerRoleInstructions,
  type KnowledgeIndexerBinding,
  parseIndexerLinks,
} from "./knowledge_indexer.ts";
import {
  librarianPrompt,
  librarianRoleInstructions,
  makeLibrarianKnowledgeCapsule,
  maxKnowledgeLibrarianChars,
  openKnowledgeLibrarianSession,
} from "./knowledge_librarian.ts";
import {
  ModeYolo,
  resolvePolicy,
  resolveUnattendedMode,
  SourceACP,
  SourceUnknown,
} from "./source.ts";
import { validateThinkingLevel } from "./session_options.ts";
import { acquireExecutionAdmission } from "./execution_admission.ts";
import { type DurableRun, RunStore } from "./run_store.ts";
import { type RunEvent, SessionRunEventSink } from "./run_event.ts";
import { ExecutionRuntime } from "./execution.ts";
import {
  type RunState,
  RunStateCompleted,
  RunStateFailed,
} from "./run_state.ts";
import { attachSessionResources } from "./attach.ts";
import { displayErrorMessage } from "./error_info.ts";
import type { InputSubmission } from "./input_materializer.ts";
import type { SessionRuntime } from "./session_runtime.ts";
import type { Manager as SessionManager } from "../session/manager.ts";
import { runUserEntryID } from "../session/run_user_message.ts";
import { newRegistryWithConfig } from "../tools/tool.ts";
import { newUserMessage } from "../provider/types.ts";
import {
  EventError,
  EventRunFinished,
  EventTextDelta,
  taskStatusIsSuccessful,
} from "../agent/events.ts";

/** The deterministic index policy. LLM enrichment is a later Runtime step. */
export interface KnowledgeBaseIndexPolicy {
  maxFiles: number;
  maxFileBytes: number;
  maxChunkBytes: number;
}

export function defaultKnowledgeBaseIndexPolicy(): KnowledgeBaseIndexPolicy {
  return { maxFiles: 5000, maxFileBytes: 2 << 20, maxChunkBytes: 6000 };
}

/**
 * Creates the configured provider/model for the optional Indexer role. It keeps
 * provider construction in Runtime and makes the graph-enrichment path
 * deterministic to test without an adapter-owned provider builder.
 */
export type KnowledgeBaseProviderFactory = (
  settings: Settings,
  providerName: string,
  modelID: string,
) => { provider: Provider; model: Model };

const defaultKnowledgeProviderFactory: KnowledgeBaseProviderFactory = (
  settings,
  providerName,
  modelID,
) => {
  const result = createProvider(settings, providerName, modelID);
  return { provider: result.provider, model: result.model };
};

export class KnowledgeBaseService {
  private readonly sessionDirValue: string;
  private readonly policy: KnowledgeBaseIndexPolicy;
  private settingsValue: Settings | null;
  private readonly providerFactory: KnowledgeBaseProviderFactory | null;
  private indexJobs = new Map<string, KnowledgeIndexJob>();

  constructor(
    sessionDir: string,
    policy: KnowledgeBaseIndexPolicy,
    settings: Settings | null,
    providerFactory: KnowledgeBaseProviderFactory | null,
  ) {
    this.sessionDirValue = path.normalize(sessionDir);
    this.policy = policy;
    this.settingsValue = settings === null ? null : { ...settings };
    this.providerFactory = providerFactory;
  }

  get sessionDir(): string {
    return this.sessionDirValue;
  }

  /**
   * Replaces the settings snapshot used to resolve the optional Indexer role.
   * A management surface that caches one service for the process calls it when
   * settings.json changes, so a later scan uses the new provider/model without
   * losing the in-flight background job registry. The stored value is a private
   * copy and the previous copy is never mutated.
   */
  setSettings(settings: Settings | null): void {
    this.settingsValue = settings === null ? null : { ...settings };
  }

  currentSettings(): Settings | null {
    return this.settingsValue;
  }

  /** Performs one scan/index pass under the canonical durable Run lifecycle. */
  index(
    ctx: AbortSignal | undefined,
    knowledgeBaseID: string,
  ): Promise<KnowledgeSnapshot> {
    return this.indexDurable(ctx, knowledgeBaseID, SourceACP);
  }

  indexDurable(
    ctx: AbortSignal | undefined,
    knowledgeBaseID: string,
    source: string,
  ): Promise<KnowledgeSnapshot> {
    return this.runIndexDurable(ctx, knowledgeBaseID, source, null);
  }

  indexDurableWithProgress(
    ctx: AbortSignal | undefined,
    knowledgeBaseID: string,
    source: string,
    job: KnowledgeIndexJob,
  ): Promise<KnowledgeSnapshot> {
    return this.runIndexDurable(ctx, knowledgeBaseID, source, job);
  }

  private async runIndexDurable(
    ctx: AbortSignal | undefined,
    knowledgeBaseID: string,
    source: string,
    job: KnowledgeIndexJob | null,
  ): Promise<KnowledgeSnapshot> {
    const base = getKnowledgeBase(this.sessionDirValue, knowledgeBaseID);
    if (!base.enabled) throw knowledgeBaseDisabledError(base.id);
    if (source === SourceUnknown) source = SourceACP;
    const policyResult = resolvePolicy(
      { requested: source },
      "",
      base.mode,
      ModeYolo,
    );
    if (policyResult.error !== null) {
      throw new Error(
        `resolve knowledge indexing policy: ${policyResult.error.message}`,
      );
    }
    source = policyResult.resolution.source;
    const mode = resolveUnattendedMode(policyResult.mode);
    // Do not construct a provider only to discover that a full deterministic
    // scan matches the active snapshot. The configured model name remains
    // useful durable-run provenance even when no Indexer request is needed.
    const modelID = base.model.trim();
    const manager = openKnowledgeLibrarianSession(this.sessionDirValue, base);
    const sessionID = manager.getHeader()?.id ?? "";
    const guard = await acquireExecutionAdmission(
      ctx,
      this.sessionDirValue,
      sessionID,
      {
        wait: true,
      },
    );
    try {
      const runID = "knowledge_index_" + generateID();
      job?.update((p) => {
        p.runId = runID;
      });
      const execution = new ExecutionRuntime();
      execution.setRunStore(new RunStore(this.sessionDirValue));
      execution.setEventSink(new SessionRunEventSink(this.sessionDirValue));
      const startedAt = new Date();
      const data = {
        knowledgeBaseId: base.id,
        operation: "index",
        role: "indexer",
      };
      execution.beginDurable(
        ctx,
        makeDurableRun({
          id: runID,
          sessionId: sessionID,
          workDir: base.rootDir,
          source: String(source),
          model: modelID,
          mode,
          status: "running",
          startedAt,
        }),
        makeRunEvent({
          sessionId: sessionID,
          runId: runID,
          eventType: "started",
          source: String(source),
          status: "running",
          model: modelID,
          mode,
          timestamp: startedAt,
          data,
        }),
      );
      let result: KnowledgeSnapshot | null = null;
      let bodyErr: Error | null = null;
      try {
        result = await this.runIndexBody(
          ctx,
          execution,
          manager,
          base,
          source,
          mode,
          modelID,
          runID,
          sessionID,
          job,
        );
      } catch (err) {
        bodyErr = toError(err);
      }
      const state: RunState = bodyErr !== null
        ? RunStateFailed
        : RunStateCompleted;
      const message = bodyErr?.message ?? "";
      let finishErr: Error | null = null;
      try {
        await execution.finishDurableWithRetry(
          undefined,
          runID,
          state,
          message,
          makeRunEvent({
            sessionId: sessionID,
            runId: runID,
            eventType: "finished",
            source: String(source),
            status: state,
            model: modelID,
            mode,
            timestamp: new Date(),
            data,
          }),
        );
      } catch (err) {
        finishErr = toError(err);
      }
      if (bodyErr !== null) throw bodyErr;
      if (finishErr !== null) {
        throw new Error(`finish knowledge indexing run: ${finishErr.message}`);
      }
      return result!;
    } finally {
      guard.release();
    }
  }

  private async runIndexBody(
    ctx: AbortSignal | undefined,
    execution: ExecutionRuntime,
    manager: SessionManager,
    base: KnowledgeBase,
    source: string,
    mode: string,
    modelID: string,
    runID: string,
    sessionID: string,
    job: KnowledgeIndexJob | null,
  ): Promise<KnowledgeSnapshot> {
    const files = this.scanFileManifest(ctx, base, job);
    const reuse = reuseKnowledgeSnapshotIfFilesMatch(
      this.sessionDirValue,
      base.id,
      files,
    );
    if (reuse.reusable) {
      execution.recordEvent(
        makeRunEvent({
          sessionId: sessionID,
          runId: runID,
          eventType: "knowledge_snapshot_reused",
          source: String(source),
          status: "completed",
          model: modelID,
          mode,
          timestamp: new Date(),
          data: {
            knowledgeBaseId: base.id,
            snapshotId: reuse.snapshot.id,
            operation: "index_reused",
          },
        }),
      );
      return reuse.snapshot;
    }
    const reusePlan = prepareKnowledgeGraphReusePlan(
      this.sessionDirValue,
      base.id,
      files,
    );
    job?.update((p) => {
      p.phase = KnowledgeIndexPhaseIndexing;
      p.filesTotal = files.length;
      p.filesDone = 0;
    });
    const graph = this.buildGraph(ctx, base.id, runID, reusePlan, job);
    job?.update((p) => {
      p.phase = KnowledgeIndexPhaseEnriching;
      p.chunks = graph.chunks.length;
    });
    const indexer = this.resolveKnowledgeIndexer(graph.knowledgeBase);
    await this.enrichGraphWithIndexer(
      ctx,
      execution,
      manager,
      graph.knowledgeBase,
      graph,
      mode,
      indexer,
    );
    job?.update((p) => {
      p.phase = KnowledgeIndexPhaseCommitting;
    });
    return storeKnowledgeGraphSnapshot(this.sessionDirValue, graph);
  }

  /**
   * Builds and commits the deterministic graph baseline. The durable
   * `indexDurable` path may enrich that graph with separately verified
   * Agent-selected links before committing it.
   */
  indexWithRun(
    ctx: AbortSignal | undefined,
    knowledgeBaseID: string,
    runID: string,
  ): KnowledgeSnapshot {
    const base = getKnowledgeBase(this.sessionDirValue, knowledgeBaseID);
    const files = this.scanFileManifest(ctx, base, null);
    const reuse = reuseKnowledgeSnapshotIfFilesMatch(
      this.sessionDirValue,
      base.id,
      files,
    );
    if (reuse.reusable) return reuse.snapshot;
    const reusePlan = prepareKnowledgeGraphReusePlan(
      this.sessionDirValue,
      base.id,
      files,
    );
    const graph = this.buildGraph(ctx, knowledgeBaseID, runID, reusePlan, null);
    return storeKnowledgeGraphSnapshot(this.sessionDirValue, graph);
  }

  /**
   * Performs the inexpensive half of indexing: validates every eligible source
   * file and calculates its content hash, but avoids chunk construction, marker
   * extraction, graph allocation, provider calls and SQLite writes.
   */
  private scanFileManifest(
    ctx: AbortSignal | undefined,
    base: KnowledgeBase,
    job: KnowledgeIndexJob | null,
  ): KnowledgeFile[] {
    if (!base.enabled) throw knowledgeBaseDisabledError(base.id);
    const root = resolveKnowledgeBaseRoot(base);
    const files: KnowledgeFile[] = [];
    let fileCount = 0;
    for (const full of walkKnowledgeTree(root, ctx)) {
      if (!knowledgeBaseAllowedFile(base.preprocessProfile, full)) continue;
      fileCount++;
      if (fileCount > this.policy.maxFiles) {
        throw new Error(
          `knowledge base exceeds ${this.policy.maxFiles} indexable files`,
        );
      }
      const source = this.readIndexableKnowledgeFile(ctx, root, full);
      if (source === null) continue;
      files.push({
        id: "",
        snapshotId: "",
        relativePath: source.relativePath,
        contentSha256: knowledgeSHA256(source.data),
        byteSize: source.data.length,
        mediaType: source.mediaType,
        title: "",
        status: "indexed",
      });
      job?.update((p) => {
        p.phase = KnowledgeIndexPhaseScanning;
        p.filesDone++;
      });
    }
    return files;
  }

  private buildGraph(
    ctx: AbortSignal | undefined,
    knowledgeBaseID: string,
    runID: string,
    reusePlan: KnowledgeGraphReusePlan,
    job: KnowledgeIndexJob | null,
  ): KnowledgeGraphSnapshot & { knowledgeBase: KnowledgeBase } {
    const base = getKnowledgeBase(this.sessionDirValue, knowledgeBaseID);
    if (!base.enabled) throw knowledgeBaseDisabledError(base.id);
    const root = resolveKnowledgeBaseRoot(base);
    const graph: KnowledgeGraphSnapshot & { knowledgeBase: KnowledgeBase } = {
      snapshot: {
        id: generateID(),
        knowledgeBaseId: base.id,
        runId: runID.trim(),
        status: "indexing",
        schemaVersion: KnowledgeGraphSchemaVersion,
        fileCount: 0,
        chunkCount: 0,
        nodeCount: 0,
        edgeCount: 0,
        startedAt: new Date(),
        finishedAt: undefined,
        errorSummary: "",
      },
      files: [],
      chunks: [],
      nodes: [],
      edges: [],
      evidence: [],
      knowledgeBase: base,
    };
    let fileCount = 0;
    for (const full of walkKnowledgeTree(root, ctx)) {
      if (!knowledgeBaseAllowedFile(base.preprocessProfile, full)) continue;
      fileCount++;
      if (fileCount > this.policy.maxFiles) {
        throw new Error(
          `knowledge base exceeds ${this.policy.maxFiles} indexable files`,
        );
      }
      const relativePath = knowledgeRelativePath(root, full);
      const reusable = reusePlan.files.get(relativePath);
      if (reusable !== undefined) {
        appendKnowledgeFileGraph(graph, reusable);
        job?.update((p) => {
          p.phase = KnowledgeIndexPhaseIndexing;
          p.filesDone++;
        });
        continue;
      }
      this.indexFile(ctx, root, full, graph);
      job?.update((p) => {
        p.phase = KnowledgeIndexPhaseIndexing;
        p.filesDone++;
      });
    }
    return graph;
  }

  private indexFile(
    ctx: AbortSignal | undefined,
    root: string,
    full: string,
    graph: KnowledgeGraphSnapshot,
  ): void {
    const source = this.readIndexableKnowledgeFile(ctx, root, full);
    if (source === null) return;
    const fileID = generateID();
    const file: KnowledgeFile = {
      id: fileID,
      snapshotId: graph.snapshot.id,
      relativePath: source.relativePath,
      contentSha256: knowledgeSHA256(source.data),
      byteSize: source.data.length,
      mediaType: source.mediaType,
      title: knowledgeFileTitle(source.relativePath, source.text),
      status: "indexed",
    };
    graph.files.push(file);
    const chunks = knowledgeChunks(
      graph.snapshot.id,
      fileID,
      source.text,
      this.policy.maxChunkBytes,
    );
    if (chunks.length === 0) return;
    graph.chunks.push(...chunks);
    const fileNode = {
      id: generateID(),
      snapshotId: graph.snapshot.id,
      kind: "file",
      label: source.relativePath,
      normalizedLabel: normalizeKnowledgeLabel(source.relativePath),
      summary: file.title,
    };
    graph.nodes.push(fileNode);
    graph.evidence.push({
      id: generateID(),
      snapshotId: graph.snapshot.id,
      nodeId: fileNode.id,
      chunkId: chunks[0].id,
      startLine: chunks[0].startLine,
      endLine: chunks[0].endLine,
      confidence: 1,
    });
    for (const marker of knowledgeMarkers(source.relativePath, source.text)) {
      const chunk = knowledgeChunkForLine(chunks, marker.line);
      if (chunk === null) continue;
      const node = {
        id: generateID(),
        snapshotId: graph.snapshot.id,
        kind: marker.kind,
        label: marker.label,
        normalizedLabel: normalizeKnowledgeLabel(
          source.relativePath + "\x00" + marker.label,
        ),
        summary: marker.label,
      };
      const edge = {
        id: generateID(),
        snapshotId: graph.snapshot.id,
        fromNodeId: fileNode.id,
        toNodeId: node.id,
        relationType: "contains",
        confidence: 1,
      };
      graph.nodes.push(node);
      graph.edges.push(edge);
      graph.evidence.push(
        {
          id: generateID(),
          snapshotId: graph.snapshot.id,
          nodeId: node.id,
          chunkId: chunk.id,
          startLine: marker.line,
          endLine: marker.line,
          confidence: 1,
        },
        {
          id: generateID(),
          snapshotId: graph.snapshot.id,
          edgeId: edge.id,
          chunkId: chunk.id,
          startLine: marker.line,
          endLine: marker.line,
          confidence: 1,
        },
      );
    }
  }

  private readIndexableKnowledgeFile(
    ctx: AbortSignal | undefined,
    root: string,
    full: string,
  ): KnowledgeSourceFile | null {
    throwIfAborted(ctx);
    const stat = Deno.statSync(full);
    if (stat.size > this.policy.maxFileBytes) return null;
    const resolved = Deno.realPathSync(full);
    const rel = knowledgeRelativeResolved(root, resolved);
    const data = Deno.readFileSync(resolved);
    const text = decodeIndexableUtf8(data);
    if (text === null) return null;
    const normalized = text.replaceAll("\r\n", "\n").replace(/^\ufeff/, "");
    if (normalized.trim() === "") return null;
    return {
      relativePath: knowledgeToSlash(rel),
      data,
      text: normalized,
      mediaType: knowledgeMediaType(full),
    };
  }

  /** Reports the live progress of a running scan, if any. */
  indexProgress(
    knowledgeBaseID: string,
  ): { progress: KnowledgeIndexProgress; running: boolean } {
    const job = this.indexJobs.get(knowledgeBaseID);
    if (job === undefined) {
      return { progress: emptyProgress(), running: false };
    }
    const progress = job.viewProgress();
    if (!progress.running) {
      return { progress: emptyProgress(), running: false };
    }
    return { progress, running: true };
  }

  indexJob(knowledgeBaseID: string): KnowledgeIndexJob | null {
    return this.indexJobs.get(knowledgeBaseID) ?? null;
  }

  /**
   * Launches (or reuses) the background index job for one knowledge base and
   * returns immediately. Validation of the base happens synchronously because
   * it is inexpensive; the scan itself never runs on the caller's task.
   * Concurrent starts for the same base share one job.
   */
  startIndex(
    ctx: AbortSignal | undefined,
    knowledgeBaseID: string,
    source: string,
  ): KnowledgeIndexJob {
    const base = getKnowledgeBase(this.sessionDirValue, knowledgeBaseID);
    if (!base.enabled) throw knowledgeBaseDisabledError(base.id);
    const existing = this.indexJobs.get(knowledgeBaseID);
    if (existing !== undefined && !existing.finished) return existing;
    const job = newKnowledgeIndexJob();
    this.indexJobs.set(knowledgeBaseID, job);
    void (async () => {
      try {
        const snapshot = await this.indexDurableWithProgress(
          undefined,
          knowledgeBaseID,
          source,
          job,
        );
        job.finish(snapshot, null);
      } catch (err) {
        job.finish(emptyKnowledgeSnapshot(), toError(err));
      }
    })();
    void ctx;
    return job;
  }

  /** Resolves graph-backed evidence from the active immutable snapshot. */
  query(
    ctx: AbortSignal | undefined,
    knowledgeBaseID: string,
    text: string,
    limit: number,
  ): KnowledgeGraphQuery {
    throwIfAborted(ctx);
    return queryKnowledgeGraph(
      this.sessionDirValue,
      knowledgeBaseID,
      text,
      limit,
    );
  }

  /**
   * Resolves the optional Indexer provider/model binding. It returns null when
   * no provider factory or settings are configured, preserving the
   * deterministic path for knowledge bases created before the role existed.
   */
  resolveKnowledgeIndexer(
    base: KnowledgeBase,
  ): KnowledgeIndexerBinding | null {
    const settings = this.currentSettings();
    if (settings === null || this.providerFactory === null) return null;
    if (base.provider.trim() === "" && base.model.trim() === "") return null;
    if (base.provider.trim() === "" || base.model.trim() === "") {
      throw new Error(
        `knowledge base ${
          JSON.stringify(base.name)
        } must configure provider and model together`,
      );
    }
    const { provider, model } = this.providerFactory(
      { ...settings },
      base.provider,
      base.model,
    );
    const thinking = validateThinkingLevel(base.thinkingLevel ?? "");
    return { provider, providerName: base.provider, model, thinking };
  }

  /**
   * Asks the configured ordinary Agent to select useful relationships from
   * deterministic graph evidence. The first enriched edge is deliberately only
   * `co_mentions`: both existing node labels must appear in the cited source
   * chunk and the line span must sit inside it, making the persisted relation
   * locally verifiable rather than a model's semantic assertion.
   */
  async enrichGraphWithIndexer(
    ctx: AbortSignal | undefined,
    execution: ExecutionRuntime | null,
    manager: SessionManager | null,
    base: KnowledgeBase,
    graph: KnowledgeGraphSnapshot | null,
    mode: string,
    binding: KnowledgeIndexerBinding | null,
  ): Promise<void> {
    if (graph === null || binding === null) return;
    if (
      execution === null || manager === null || manager.getHeader() === null
    ) {
      throw new Error("knowledge indexer execution session is unavailable");
    }
    const registry = newRegistryWithConfig({
      workDir: base.rootDir,
      toolFilter: ["read", "ls", "grep", "find"],
    });
    const runtime = await attachSessionResources({
      id: manager.getHeader()!.id,
      source: SourceACP,
      entrySource: SourceACP,
      workDir: base.rootDir,
      manager,
      registry,
      providers: { [binding.providerName]: binding.provider },
    });
    try {
      runtime.configureSession(
        binding.provider,
        binding.providerName,
        binding.model,
        mode,
        binding.thinking,
      );
      const agentInstance = runtime.buildTransientAgent(registry, {
        provider: binding.provider,
        providerName: binding.providerName,
        model: binding.model,
        settings: cloneKnowledgeSettings(this.currentSettings()) ?? undefined,
        mode,
        thinkingLevel: binding.thinking,
        extraContext: indexerRoleInstructions(base.name),
        maxIterations: 4,
      });
      execution.setAgent(agentInstance);
      const response: string[] = [];
      let terminal = false;
      let runErr: Error | null = null;
      for await (const event of agentInstance.run(indexerPrompt(graph), ctx)) {
        // The Index Run has no conversation turn. Avoid staging the model's raw
        // JSON response as a transcript entry while still recording provider and
        // tool failures through the canonical ExecutionRuntime.
        if (event.type !== EventRunFinished) {
          const observation = execution.observeAgentEvent(event);
          if (observation.error !== undefined && runErr === null) {
            runErr = new Error(displayErrorMessage(observation.error));
          }
          if (runErr !== null) break;
        }
        if (event.type === EventTextDelta) {
          response.push(event.textDelta ?? "");
        } else if (event.type === EventRunFinished) {
          terminal = true;
          if (!taskStatusIsSuccessful(event.status ?? "")) {
            runErr = event.error ??
              new Error(
                `knowledge indexer finished with status ${event.status}`,
              );
          }
        } else if (event.type === EventError) {
          if (event.error !== undefined) runErr = event.error;
        }
      }
      if (runErr !== null) throw runErr;
      if (!terminal) {
        throw new Error(
          "knowledge indexer event stream closed without a terminal result",
        );
      }
      const links = parseIndexerLinks(response.join(""));
      appendVerifiedCoMentionEdges(graph, links);
    } finally {
      runtime.close();
    }
  }

  /**
   * Asks the knowledge base's configured ordinary Agent role to distill indexed
   * evidence for one caller question. The Agent receives its own durable Run and
   * a dedicated session rooted at the knowledge base directory; it never shares
   * the caller's conversation or execution lease. A base without a provider/model
   * remains on the deterministic graph capsule path.
   */
  async librarianCapsule(
    ctx: AbortSignal | undefined,
    caller: SessionRuntime,
    base: KnowledgeBase,
    graph: KnowledgeGraphQuery,
    question: string,
    budget: number,
  ): Promise<KnowledgeCapsule> {
    if (graph.chunks.length === 0) return emptyKnowledgeCapsule();
    if (base.provider.trim() === "" && base.model.trim() === "") {
      return makeKnowledgeCapsule(graph, budget);
    }
    if (base.provider.trim() === "" || base.model.trim() === "") {
      throw new Error(
        `knowledge base ${
          JSON.stringify(base.name)
        } must configure provider and model together`,
      );
    }
    const { provider, providerName, model } = caller.resolveProviderModel(
      base.provider,
      base.model,
    );
    const { mode } = caller.resolvePolicy("", base.mode, ModeYolo);
    const thinking = validateThinkingLevel(base.thinkingLevel ?? "");
    const text = await this.runLibrarian(
      ctx,
      base,
      graph,
      question,
      provider,
      providerName,
      model,
      mode,
      thinking,
      caller.settingsSnapshot(),
    );
    return makeLibrarianKnowledgeCapsule(graph, text, budget);
  }

  private async runLibrarian(
    ctx: AbortSignal | undefined,
    base: KnowledgeBase,
    graph: KnowledgeGraphQuery,
    question: string,
    p: Provider | null,
    providerName: string,
    model: Model | null,
    mode: string,
    thinking: ThinkingLevel,
    settings: Settings | null,
  ): Promise<string> {
    if (p === null || model === null) {
      throw new Error("librarian provider and model are required");
    }
    const manager = openKnowledgeLibrarianSession(this.sessionDirValue, base);
    const sessionID = manager.getHeader()?.id ?? "";
    const registry = newRegistryWithConfig({
      workDir: base.rootDir,
      toolFilter: ["read", "ls", "grep", "find"],
    });
    const runtime = await attachSessionResources({
      id: sessionID,
      source: SourceACP,
      entrySource: SourceACP,
      workDir: base.rootDir,
      manager,
      registry,
      providers: { [providerName]: p },
    });
    try {
      runtime.configureSession(p, providerName, model, mode, thinking);
      const guard = await acquireExecutionAdmission(
        ctx,
        this.sessionDirValue,
        sessionID,
        { wait: true },
      );
      try {
        const runID = "knowledge_" + generateID();
        const execution = new ExecutionRuntime();
        execution.setRunStore(new RunStore(this.sessionDirValue));
        execution.setEventSink(new SessionRunEventSink(this.sessionDirValue));
        runtime.setExecution(execution);
        const startedAt = new Date();
        const prompt = librarianPrompt(graph, question);
        const userMessage = newUserMessage(prompt);
        const data = {
          knowledgeBaseId: base.id,
          snapshotId: graph.snapshot.id,
          role: "librarian",
        };
        const runSignal = execution.beginDurable(
          ctx,
          makeDurableRun({
            id: runID,
            sessionId: sessionID,
            workDir: base.rootDir,
            source: String(SourceACP),
            model: model.id,
            mode,
            status: "running",
            startedAt,
            userEntryId: runUserEntryID(runID),
            userMessage,
            conversationTurnId: "turn-" + runID,
            conversationTurn: true,
          }),
          makeRunEvent({
            sessionId: sessionID,
            runId: runID,
            eventType: "started",
            source: String(SourceACP),
            status: "running",
            model: model.id,
            mode,
            timestamp: startedAt,
            data,
          }),
        );
        let state: RunState = RunStateCompleted;
        let message = "";
        let bodyErr: Error | null = null;
        let text = "";
        try {
          const a = runtime.buildAgent({
            provider: p,
            providerName,
            model,
            settings: cloneKnowledgeSettings(settings) ?? undefined,
            mode,
            thinkingLevel: thinking,
            extraContext: librarianRoleInstructions(base),
            maxIterations: 8,
            conversationTurnId: "turn-" + runID,
            runId: runID,
            conversationTurn: true,
            runtimeOwnsTurnEnd: true,
            // The librarian is a query bridge, not the session's lead: it must
            // not wait for the session's expert-team members.
            auxiliaryRole: true,
          });
          execution.setAgent(a);
          const response: string[] = [];
          let terminal = false;
          for await (
            const event of a.runWithUserMessage(userMessage, runSignal)
          ) {
            const observation = execution.observeAgentEvent(event);
            if (observation.error !== undefined && bodyErr === null) {
              bodyErr = new Error(displayErrorMessage(observation.error));
            }
            if (event.type === EventTextDelta) {
              response.push(event.textDelta ?? "");
            } else if (event.type === EventRunFinished) {
              terminal = true;
              if (
                !taskStatusIsSuccessful(event.status ?? "") && bodyErr === null
              ) {
                bodyErr = event.error ??
                  new Error(
                    `librarian run finished with status ${event.status}`,
                  );
              }
            } else if (event.type === EventError) {
              if (event.error !== undefined && bodyErr === null) {
                bodyErr = event.error;
              }
            }
          }
          if (bodyErr === null && !terminal) {
            bodyErr = new Error(
              "librarian event stream closed without a terminal result",
            );
          }
          text = response.join("").trim();
          if (bodyErr === null && text === "") {
            bodyErr = new Error("librarian returned no answer");
          }
        } catch (err) {
          bodyErr = toError(err);
        }
        if (bodyErr !== null) {
          state = RunStateFailed;
          message = bodyErr.message;
        }
        let finishErr: Error | null = null;
        try {
          await execution.finishDurableWithRetry(
            undefined,
            runID,
            state,
            message,
            makeRunEvent({
              sessionId: sessionID,
              runId: runID,
              eventType: "finished",
              source: String(SourceACP),
              status: state,
              model: model.id,
              mode,
              timestamp: new Date(),
              data,
            }),
          );
        } catch (err) {
          finishErr = toError(err);
        }
        if (bodyErr !== null) throw bodyErr;
        if (finishErr !== null) {
          throw new Error(`finish librarian run: ${finishErr.message}`);
        }
        return truncateKnowledgeText(text, maxKnowledgeLibrarianChars);
      } finally {
        guard.release();
      }
    } finally {
      runtime.close();
    }
  }
}

/** Creates the deterministic service without the configured Indexer role. */
export function newKnowledgeBaseService(
  sessionDir: string,
  policy: KnowledgeBaseIndexPolicy,
): KnowledgeBaseService {
  return newKnowledgeBaseServiceWithProviderFactory(
    sessionDir,
    policy,
    null,
    null,
  );
}

/** Enables the configured Indexer Agent role on top of the deterministic scan. */
export function newKnowledgeBaseServiceWithSettings(
  sessionDir: string,
  policy: KnowledgeBaseIndexPolicy,
  settings: Settings,
): KnowledgeBaseService {
  return newKnowledgeBaseServiceWithProviderFactory(
    sessionDir,
    policy,
    settings,
    defaultKnowledgeProviderFactory,
  );
}

/** The testable constructor for Runtime-owned provider selection. */
export function newKnowledgeBaseServiceWithProviderFactory(
  sessionDir: string,
  policy: KnowledgeBaseIndexPolicy,
  settings: Settings | null,
  factory: KnowledgeBaseProviderFactory | null,
): KnowledgeBaseService {
  if (sessionDir.trim() === "") {
    throw new Error("knowledge base session directory is required");
  }
  if (
    policy.maxFiles <= 0 || policy.maxFileBytes <= 0 ||
    policy.maxChunkBytes <= 0
  ) {
    throw new Error("knowledge base index limits must be positive");
  }
  return new KnowledgeBaseService(sessionDir, policy, settings, factory);
}

/**
 * Resolves graph-backed capsules from an immutable active snapshot. It reads no
 * source file and runs no provider directly; callers get the same Runtime input
 * shape regardless of their transport.
 */
export function prepareKnowledgeContext(
  sessionDir: string,
  query: string,
  refs: KnowledgeBaseReference[],
): KnowledgeCapsule[] {
  if (refs.length === 0) return [];
  if (refs.length > maxKnowledgeBaseReferences) {
    throw new Error(
      `at most ${maxKnowledgeBaseReferences} knowledge bases may be referenced by one request`,
    );
  }
  const service = newKnowledgeBaseService(
    sessionDir,
    defaultKnowledgeBaseIndexPolicy(),
  );
  const seen = new Set<string>();
  const capsules: KnowledgeCapsule[] = [];
  let remaining = maxKnowledgeCapsuleChars;
  for (const reference of refs) {
    const id = reference.knowledgeBaseId.trim();
    if (id === "") throw new Error("knowledge base ID is required");
    if (seen.has(id)) continue;
    seen.add(id);
    let base: KnowledgeBase;
    try {
      base = getKnowledgeBase(sessionDir, id);
    } catch (err) {
      if (reference.required) throw err;
      continue;
    }
    if (!base.enabled) {
      if (reference.required) {
        throw new Error(
          `knowledge base ${JSON.stringify(base.name)} is disabled`,
        );
      }
      continue;
    }
    let graph: KnowledgeGraphQuery;
    try {
      graph = service.query(undefined, id, query, 4);
    } catch (err) {
      if (reference.required) throw err;
      continue;
    }
    if (graph.chunks.length === 0) {
      if (reference.required) {
        throw new Error(
          `knowledge base ${
            JSON.stringify(base.name)
          } has no matching indexed evidence`,
        );
      }
      continue;
    }
    const capsule = makeKnowledgeCapsule(graph, remaining);
    if (capsule.text === "") continue;
    remaining -= capsule.text.length;
    capsules.push(capsule);
    if (remaining <= 0) break;
  }
  return capsules;
}

/**
 * Resolves capsules through each base's configured Librarian Agent, falling back
 * to the immutable graph baseline for an optional reference whose model step
 * fails. Required references surface the error. This is the Runtime-owned input
 * enrichment that adapters call before `buildUserMessage`.
 */
export async function prepareKnowledgeContextWithLibrarian(
  ctx: AbortSignal | undefined,
  service: KnowledgeBaseService,
  caller: SessionRuntime,
  query: string,
  refs: KnowledgeBaseReference[],
): Promise<KnowledgeCapsule[]> {
  if (refs.length > maxKnowledgeBaseReferences) {
    throw new Error(
      `at most ${maxKnowledgeBaseReferences} knowledge bases may be referenced by one request`,
    );
  }
  const seen = new Set<string>();
  const capsules: KnowledgeCapsule[] = [];
  let remaining = maxKnowledgeCapsuleChars;
  for (const reference of refs) {
    const id = reference.knowledgeBaseId.trim();
    if (id === "") throw new Error("knowledge base ID is required");
    if (seen.has(id)) continue;
    seen.add(id);
    let base: KnowledgeBase;
    try {
      base = getKnowledgeBase(service.sessionDir, id);
    } catch (err) {
      if (reference.required) throw err;
      continue;
    }
    if (!base.enabled) {
      if (reference.required) {
        throw new Error(
          `knowledge base ${JSON.stringify(base.name)} is disabled`,
        );
      }
      continue;
    }
    let graph: KnowledgeGraphQuery;
    try {
      graph = service.query(ctx, id, query, 6);
    } catch (err) {
      if (reference.required) throw err;
      continue;
    }
    if (graph.chunks.length === 0) {
      if (reference.required) {
        throw new Error(
          `knowledge base ${
            JSON.stringify(base.name)
          } has no matching indexed evidence`,
        );
      }
      continue;
    }
    let capsule: KnowledgeCapsule;
    try {
      capsule = await service.librarianCapsule(
        ctx,
        caller,
        base,
        graph,
        query,
        remaining,
      );
    } catch (err) {
      if (reference.required) throw err;
      // Optional references should not make a normal prompt unavailable. Fall
      // back to immutable graph evidence, not a second provider path.
      capsule = makeKnowledgeCapsule(graph, remaining);
    }
    if (capsule.text === "") continue;
    remaining -= capsule.text.length;
    capsules.push(capsule);
    if (remaining <= 0) break;
  }
  return capsules;
}

/**
 * Attaches Runtime-owned reference results to a prepared submission. It must be
 * called before `buildUserMessage` so adapters cannot construct provider
 * messages or retain a parallel text-only path.
 */
export async function withKnowledgeContext(
  runtime: SessionRuntime,
  ctx: AbortSignal | undefined,
  input: InputSubmission,
  refs: KnowledgeBaseReference[],
): Promise<InputSubmission> {
  runtime.ensureOpen();
  if (refs.length === 0) return input;
  const manager = runtime.manager;
  const sessionDir = manager?.getSessionDir() ?? "";
  if (manager === undefined || sessionDir.trim() === "") {
    throw new Error("knowledge base session directory is unavailable");
  }
  const service = newKnowledgeBaseService(
    sessionDir,
    defaultKnowledgeBaseIndexPolicy(),
  );
  const capsules = await prepareKnowledgeContextWithLibrarian(
    ctx,
    service,
    runtime,
    input.text,
    refs,
  );
  input.knowledgeBaseReferences = refs.slice();
  input.knowledgeCapsules = capsules;
  return input;
}

function emptyKnowledgeCapsule(): KnowledgeCapsule {
  return {
    knowledgeBaseId: "",
    knowledgeBaseName: "",
    snapshotId: "",
    text: "",
    citations: [],
  };
}

function cloneKnowledgeSettings(settings: Settings | null): Settings | null {
  return settings === null ? null : { ...settings };
}

/** Builds a bounded graph-baseline capsule. */
export function makeKnowledgeCapsule(
  graph: KnowledgeGraphQuery,
  budget: number,
): KnowledgeCapsule {
  if (budget <= 0) return emptyCapsule();
  const limit = Math.min(budget, maxKnowledgeCapsuleChars);
  const parts: string[] = [];
  let length = 0;
  for (const chunk of graph.chunks) {
    if (length >= limit) break;
    let relativePath = (chunk.relativePath ?? "").trim();
    if (relativePath === "") relativePath = "unknown";
    let excerpt = chunk.text.trim();
    if (byteLength(excerpt) > maxKnowledgeExcerptChars) {
      excerpt =
        truncateKnowledgeText(excerpt, maxKnowledgeExcerptChars).trim() +
        "…";
    }
    let entry =
      `Source: ${relativePath} (lines ${chunk.startLine}-${chunk.endLine})\n${excerpt}\n`;
    if (length + byteLength(entry) > limit) {
      const space = limit - length;
      if (space <= 0) break;
      entry = truncateKnowledgeText(entry, space);
    }
    parts.push(entry);
    length += byteLength(entry);
  }
  const text = parts.join("").trim();
  if (text === "") return emptyCapsule();
  const citations: KnowledgeCitation[] = graph.chunks.map((chunk) => ({
    chunkId: chunk.id,
    relativePath: chunk.relativePath ?? "",
    startLine: chunk.startLine,
    endLine: chunk.endLine,
  }));
  return {
    knowledgeBaseId: graph.knowledgeBase.id,
    knowledgeBaseName: graph.knowledgeBase.name,
    snapshotId: graph.snapshot.id,
    text,
    citations,
  };
}

interface KnowledgeSourceFile {
  relativePath: string;
  data: Uint8Array;
  text: string;
  mediaType: string;
}

interface KnowledgeMarker {
  kind: string;
  label: string;
  line: number;
}

const knowledgeCodeDeclaration =
  /^(?:func|type|var|const|class|interface|struct|enum|function)\s+([A-Za-z_][A-Za-z0-9_]*)/;

const knowledgeTextEncoder = new TextEncoder();
const knowledgeTextDecoder = new TextDecoder("utf-8", { fatal: true });

function knowledgeBaseIgnoredDirectory(name: string): boolean {
  switch (name.toLowerCase()) {
    case ".git":
    case ".hg":
    case ".svn":
    case ".opensac":
    case "node_modules":
    case "vendor":
    case "dist":
    case "build":
    case "coverage":
    case ".next":
    case ".vite":
      return true;
    default:
      return false;
  }
}

function knowledgeBaseAllowedFile(profile: string, full: string): boolean {
  const extension = path.extname(full).toLowerCase();
  const text: Record<string, boolean> = {
    ".md": true,
    ".mdx": true,
    ".txt": true,
    ".rst": true,
    ".adoc": true,
    ".html": true,
    ".htm": true,
  };
  const code: Record<string, boolean> = {
    ".go": true,
    ".ts": true,
    ".tsx": true,
    ".js": true,
    ".jsx": true,
    ".py": true,
    ".java": true,
    ".rs": true,
    ".c": true,
    ".h": true,
    ".cpp": true,
    ".hpp": true,
    ".cs": true,
    ".rb": true,
    ".php": true,
    ".swift": true,
    ".kt": true,
    ".sql": true,
    ".json": true,
    ".yaml": true,
    ".yml": true,
    ".toml": true,
    ".xml": true,
    ".graphql": true,
    ".gql": true,
    ".sh": true,
  };
  switch (profile) {
    case "documents":
      return text[extension] === true;
    case "code":
      return code[extension] === true || extension === ".md";
    case "notes":
      return extension === ".md" || extension === ".txt";
    case "mixed":
      return text[extension] === true || code[extension] === true;
    default:
      return false;
  }
}

const knowledgeMediaTypes: Record<string, string> = {
  ".md": "text/markdown",
  ".mdx": "text/markdown",
  ".txt": "text/plain",
  ".rst": "text/plain",
  ".adoc": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".graphql": "application/graphql",
  ".gql": "application/graphql",
};

function knowledgeMediaType(full: string): string {
  const extension = path.extname(full).toLowerCase();
  return knowledgeMediaTypes[extension] ?? "text/plain";
}

function knowledgeFileTitle(relativePath: string, text: string): string {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      const title = line.replace(/^#+/, "").trim();
      if (title !== "") return title;
    }
  }
  return path.basename(relativePath);
}

function knowledgeSHA256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function knowledgeChunks(
  snapshotID: string,
  fileID: string,
  text: string,
  maxBytes: number,
): KnowledgeChunk[] {
  const lines = text.split("\n");
  const chunks: KnowledgeChunk[] = [];
  let start = 1;
  let size = 0;
  let ordinal = 0;
  let buffer: string[] = [];
  const flush = (end: number) => {
    const value = buffer.join("").trim();
    if (value === "") return;
    chunks.push({
      id: generateID(),
      snapshotId: snapshotID,
      fileId: fileID,
      ordinal,
      text: value,
      startLine: start,
      endLine: end,
      contentSha256: knowledgeSHA256(knowledgeTextEncoder.encode(value)),
    });
    ordinal++;
    buffer = [];
    size = 0;
  };
  for (let index = 0; index < lines.length; index++) {
    const lineBytes = byteLength(lines[index]) + 1;
    if (size > 0 && size + lineBytes > maxBytes) {
      flush(index);
      start = index + 1;
    }
    buffer.push(lines[index]);
    buffer.push("\n");
    size += lineBytes;
  }
  flush(lines.length);
  return chunks;
}

function knowledgeMarkers(
  relativePath: string,
  text: string,
): KnowledgeMarker[] {
  const markers: KnowledgeMarker[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith("#")) {
      const label = trimmed.replace(/^#+/, "").trim();
      if (label !== "") {
        markers.push({ kind: "section", label, line: index + 1 });
      }
      continue;
    }
    const match = knowledgeCodeDeclaration.exec(trimmed);
    if (match !== null) {
      markers.push({ kind: "symbol", label: match[1], line: index + 1 });
    }
  }
  markers.sort((a, b) => a.line - b.line);
  void relativePath;
  return markers;
}

function knowledgeChunkForLine(
  chunks: KnowledgeChunk[],
  line: number,
): KnowledgeChunk | null {
  for (const chunk of chunks) {
    if (line >= chunk.startLine && line <= chunk.endLine) return chunk;
  }
  return null;
}

function normalizeKnowledgeLabel(value: string): string {
  return value.trim().split(/\s+/).join(" ").toLowerCase();
}

function resolveKnowledgeBaseRoot(base: KnowledgeBase): string {
  let root: string;
  try {
    root = Deno.realPathSync(base.rootDir);
  } catch (err) {
    throw new Error(`resolve knowledge base root: ${toError(err).message}`);
  }
  let stat: Deno.FileInfo;
  try {
    stat = Deno.statSync(root);
  } catch (err) {
    throw new Error(`stat knowledge base root: ${toError(err).message}`);
  }
  if (!stat.isDirectory) {
    throw new Error("knowledge base root is not a directory");
  }
  return root;
}

function knowledgeRelativePath(root: string, full: string): string {
  const resolved = Deno.realPathSync(full);
  return knowledgeRelativeResolved(root, resolved);
}

function knowledgeRelativeResolved(root: string, resolved: string): string {
  const relative = path.relative(root, resolved);
  if (
    relative === ".." ||
    relative.startsWith(".." + path.SEPARATOR) ||
    relative === ""
  ) {
    throw new Error("knowledge base path escaped root");
  }
  return relative;
}

function knowledgeToSlash(value: string): string {
  return value.split(path.SEPARATOR).join("/");
}

/**
 * Walks a knowledge-base root in lexical order, skipping symlinks (files and
 * directories) and ignored directories, yielding only regular files. It mirrors
 * `filepath.WalkDir`'s directory-entry semantics.
 */
function* walkKnowledgeTree(
  root: string,
  ctx: AbortSignal | undefined,
): Generator<string> {
  const entries = [...Deno.readDirSync(root)].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  for (const entry of entries) {
    throwIfAborted(ctx);
    if (entry.isSymlink) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory) {
      if (knowledgeBaseIgnoredDirectory(entry.name)) continue;
      yield* walkKnowledgeTree(full, ctx);
      continue;
    }
    if (!entry.isFile) continue;
    yield full;
  }
}

function decodeIndexableUtf8(data: Uint8Array): string | null {
  if (data.includes(0)) return null;
  try {
    return knowledgeTextDecoder.decode(data);
  } catch {
    return null;
  }
}

function byteLength(value: string): number {
  return knowledgeTextEncoder.encode(value).length;
}

function emptyCapsule(): KnowledgeCapsule {
  return {
    knowledgeBaseId: "",
    knowledgeBaseName: "",
    snapshotId: "",
    text: "",
    citations: [],
  };
}

function emptyProgress(): KnowledgeIndexProgress {
  return { running: false, filesTotal: 0, filesDone: 0, chunks: 0 };
}

export function emptyKnowledgeSnapshot(): KnowledgeSnapshot {
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
    startedAt: new Date(0),
    finishedAt: undefined,
    errorSummary: "",
  };
}

function makeDurableRun(partial: Partial<DurableRun>): DurableRun {
  return {
    id: "",
    sessionId: "",
    intentId: "",
    retryOf: "",
    attempt: 0,
    workDir: "",
    source: "",
    model: "",
    mode: "",
    status: "",
    startedAt: new Date(0),
    finishedAt: null,
    error: "",
    errorInfo: {},
    progress: {},
    usage: undefined,
    contextUsage: undefined,
    inputResourceIds: [],
    submissionKeyHash: "",
    submissionScope: "",
    submissionFingerprint: "",
    userEntryId: "",
    userMessage: undefined,
    assistantEntryId: "",
    assistantMessage: undefined,
    conversationTurnId: "",
    conversationTurn: false,
    ...partial,
  };
}

function makeRunEvent(
  partial: Partial<RunEvent> & {
    sessionId: string;
    runId: string;
    eventType: string;
  },
): RunEvent {
  return {
    source: "",
    status: "",
    model: "",
    mode: "",
    ...partial,
  };
}

function throwIfAborted(ctx: AbortSignal | undefined): void {
  if (ctx?.aborted) {
    const reason = ctx.reason;
    if (reason instanceof Error) throw reason;
    throw new DOMException("knowledge operation aborted", "AbortError");
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
