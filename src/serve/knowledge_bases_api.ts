// Ported from internal/serve/knowledge_bases.go
//
// The WebUI knowledge-base management HTTP surface under
// /api/knowledge-bases. The Go `*channelRuntime` receiver maps to the
// `ServeKnowledgeBaseState` component: it owns the cached Runtime
// KnowledgeBaseService (the process-wide background index-job registry) and
// carries every handler; the run.go slice composes it instead of
// reimplementing them.
//
// Deviations: `context.Context` maps to the Request's AbortSignal; `writeJSON`
// maps to the shared `writeJson` helper; `time.Time{}` maps to `undefined`;
// Go's `json.Decode` without DisallowUnknownFields maps to a bounded
// `Request.json` parse (unknown fields are ignored, as in Go); `job.Progress()`
// maps to `job.viewProgress()`.

import {
  KnowledgeBaseIDFromCronJobID,
  RunKnowledgeBaseCronJob,
} from "../agentruntime/knowledge_cron.ts";
import {
  defaultKnowledgeBaseIndexPolicy,
  type KnowledgeBaseService,
  newKnowledgeBaseServiceWithSettings,
} from "../agentruntime/knowledgebase.ts";
import {
  type KnowledgeIndexJob,
  type KnowledgeIndexProgress,
} from "../agentruntime/knowledge_index_job.ts";
import { SourceWebUI } from "../agentruntime/source.ts";
import { loadSettings, type Settings } from "../config/settings.ts";
import type { CronJob } from "../cron/mod.ts";
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  ErrKnowledgeBaseNotFound,
  ErrKnowledgeBaseUnindexed,
  getKnowledgeBase,
  getKnowledgeSnapshot,
  type KnowledgeBase,
  type KnowledgeBaseSpec,
  type KnowledgeSnapshot,
  listKnowledgeBases,
  updateKnowledgeBase,
} from "../session/knowledge_bases.ts";
import { writeJson } from "./http.ts";

const KNOWLEDGE_BODY_LIMIT = 1 << 20; // 1 MiB, Go's io.LimitReader bound

/** knowledgeBaseMutation is the WebUI projection of the Runtime-owned config. */
export interface KnowledgeBaseMutation {
  name?: string;
  rootDir?: string;
  preprocessProfile?: string;
  provider?: string;
  model?: string;
  mode?: string;
  thinkingLevel?: string;
  schedule?: string;
  enabled?: boolean;
}

/** Ports the Go `knowledgeBaseMutation.spec()` method. */
export function knowledgeBaseMutationSpec(
  mutation: KnowledgeBaseMutation,
): KnowledgeBaseSpec {
  const enabled = mutation.enabled ?? true;
  return {
    name: mutation.name ?? "",
    rootDir: mutation.rootDir ?? "",
    preprocessProfile: mutation.preprocessProfile ?? "",
    provider: mutation.provider ?? "",
    model: mutation.model ?? "",
    mode: mutation.mode ?? "",
    thinkingLevel: mutation.thinkingLevel,
    schedule: mutation.schedule ?? "",
    enabled,
  };
}

/**
 * validateWebKnowledgeBaseSpec keeps this thin HTTP projection honest about
 * the capabilities it actually exposes. Provider-backed enrichment remains
 * optional, but its two identifiers are one Runtime configuration unit. WebUI
 * does not own a scheduler yet, so accepting a non-manual cadence here would
 * create persisted configuration with no corresponding Serve lifecycle.
 */
export function validateWebKnowledgeBaseSpec(spec: KnowledgeBaseSpec): void {
  const providerID = (spec.provider ?? "").trim();
  const modelID = (spec.model ?? "").trim();
  if ((providerID === "") !== (modelID === "")) {
    throw new Error("provider and model must be configured together");
  }
  const schedule = (spec.schedule ?? "").trim().toLowerCase();
  if (schedule !== "" && schedule !== "manual") {
    throw new Error(
      "scheduled knowledge base indexing is not available in WebUI",
    );
  }
}

/** knowledgeIndexView projects the live background scan progress. */
export interface KnowledgeIndexView {
  running: boolean;
  phase?: string;
  filesTotal: number;
  filesDone: number;
  chunks: number;
  startedAt?: Date;
  runId?: string;
  error?: string;
}

/** Ports the Go `knowledgeIndexViewFrom` helper. */
export function knowledgeIndexViewFrom(
  progress: KnowledgeIndexProgress,
): KnowledgeIndexView {
  return {
    running: progress.running,
    phase: progress.phase,
    filesTotal: progress.filesTotal,
    filesDone: progress.filesDone,
    chunks: progress.chunks,
    startedAt: progress.startedAt,
    runId: progress.runId,
    error: progress.error,
  };
}

/**
 * knowledgeBaseView is intentionally the same bounded management projection
 * used by ACP: configuration plus aggregate snapshot metadata, never source
 * contents. Query has its own bounded endpoint below.
 */
export interface KnowledgeBaseView {
  knowledgeBase: KnowledgeBase;
  snapshot: KnowledgeSnapshot | null;
  status: string;
  indexing?: KnowledgeIndexView;
}

/** Owns the knowledge half of the Go `channelRuntime` struct. */
export class ServeKnowledgeBaseState {
  readonly sessionDir: string;
  private knowledgeService: KnowledgeBaseService | null = null;

  constructor(sessionDir: string) {
    this.sessionDir = sessionDir;
  }

  /**
   * knowledgeBaseService returns the process-wide cached Runtime service.
   * Caching is required because the service owns the background index-job
   * registry: a fresh instance per request would hide a running scan from
   * progress polling on reload and let repeated scan requests start parallel
   * jobs.
   */
  knowledgeBaseService(): KnowledgeBaseService {
    if (this.knowledgeService !== null) {
      return this.knowledgeService;
    }
    const settings = loadSettings();
    const service = newKnowledgeBaseServiceWithSettings(
      this.sessionDir,
      defaultKnowledgeBaseIndexPolicy(),
      settings,
    );
    this.knowledgeService = service;
    return service;
  }

  /**
   * runKnowledgeBaseCronJob routes namespaced knowledge-base reindex jobs
   * through the shared Runtime handler. The cron store is shared by
   * sessionDir, so schedules persisted by Desktop/ACP are also claimed by this
   * scheduler; without this handler they would execute as ordinary agent
   * prompts inside the knowledge source directory.
   */
  async runKnowledgeBaseCronJob(
    ctx: AbortSignal | undefined,
    job: CronJob,
  ): Promise<{ handled: boolean; response: string }> {
    const jobID = job.id ?? "";
    const { ok } = KnowledgeBaseIDFromCronJobID(jobID);
    if (!ok) {
      return { handled: false, response: "" };
    }
    if (this.sessionDir.trim() === "") {
      throw new Error("knowledge base runtime is unavailable");
    }
    const service = this.knowledgeBaseService();
    const outcome = await RunKnowledgeBaseCronJob(ctx, service, jobID);
    return { handled: outcome.handled, response: outcome.response };
  }

  /**
   * refreshKnowledgeServiceSettings updates the cached Runtime service's
   * settings snapshot so a later scan resolves the new Indexer provider/model.
   * It never creates the service (a process that has not touched knowledge
   * bases pays nothing) and never rebuilds it, because the cached instance owns
   * the in-flight background index-job registry that progress polling depends
   * on.
   */
  refreshKnowledgeServiceSettings(settings: Settings | null): void {
    if (this.knowledgeService !== null) {
      this.knowledgeService.setSettings(settings);
    }
  }

  knowledgeBaseView(
    _ctx: AbortSignal | undefined,
    base: KnowledgeBase,
  ): KnowledgeBaseView {
    const view: KnowledgeBaseView = {
      knowledgeBase: base,
      snapshot: null,
      status: "unindexed",
    };
    if ((base.activeSnapshotId ?? "").trim() !== "") {
      const snapshot = getKnowledgeSnapshot(
        this.sessionDir,
        base.activeSnapshotId ?? "",
      );
      view.snapshot = snapshot;
      view.status = snapshot.status;
    }
    // Project live progress even without an active snapshot: the first scan of
    // a new base is exactly when the WebUI needs the running-job view to poll.
    this.attachKnowledgeIndexProgress(view, base.id);
    return view;
  }

  /**
   * attachKnowledgeIndexProgress adds the live scan progress (when a background
   * index job is running) so the WebUI can render and poll an in-flight scan.
   */
  attachKnowledgeIndexProgress(
    view: KnowledgeBaseView,
    baseID: string,
  ): void {
    let service: KnowledgeBaseService;
    try {
      service = this.knowledgeBaseService();
    } catch {
      return;
    }
    const { progress, running } = service.indexProgress(baseID);
    if (!running) {
      return;
    }
    view.indexing = knowledgeIndexViewFrom(progress);
  }

  /** handleKnowledgeBases ports the Go route dispatcher of the same name. */
  async handleKnowledgeBases(
    request: Request,
  ): Promise<Response> {
    if (this.sessionDir.trim() === "") {
      return writeJson(() => {}, 503, {
        error: "knowledge base runtime is unavailable",
      });
    }
    const url = new URL(request.url);
    const relative = url.pathname
      .replace(/^\/api\/knowledge-bases\/?/, "")
      .replace(/^\/+|\/+$/g, "");
    if (relative === "") {
      switch (request.method) {
        case "GET":
          return await this.listKnowledgeBases(request);
        case "POST":
          return await this.createKnowledgeBase(request);
        default:
          return new Response(null, { status: 405 });
      }
    }
    const parts = relative.split("/");
    if (parts.length > 2 || parts[0] === "") {
      return writeJson(() => {}, 400, {
        error: "invalid knowledge base path",
      });
    }
    let id: string;
    try {
      id = decodeURIComponent(parts[0]);
    } catch {
      id = "";
    }
    if (id === "" || id.includes("/")) {
      return writeJson(() => {}, 400, {
        error: "invalid knowledge base ID",
      });
    }
    if (parts.length === 2) {
      switch (parts[1]) {
        case "scan":
          if (request.method === "POST") {
            return await this.scanKnowledgeBase(request, id);
          }
          break;
        case "query":
          if (request.method === "POST") {
            return await this.queryKnowledgeBase(request, id);
          }
          break;
      }
      return new Response(null, { status: 405 });
    }
    switch (request.method) {
      case "GET":
        return await this.getKnowledgeBase(request, id);
      case "PATCH":
        return await this.updateKnowledgeBase(request, id);
      case "DELETE":
        return await this.deleteKnowledgeBase(request, id);
      default:
        return new Response(null, { status: 405 });
    }
  }

  private async listKnowledgeBases(request: Request): Promise<Response> {
    let bases: KnowledgeBase[];
    try {
      bases = listKnowledgeBases(this.sessionDir);
    } catch (err) {
      return knowledgeBaseErrorResponse(err);
    }
    const views: KnowledgeBaseView[] = [];
    for (const base of bases) {
      try {
        views.push(await this.knowledgeBaseView(request.signal, base));
      } catch (err) {
        return knowledgeBaseErrorResponse(err);
      }
    }
    return writeJson(() => {}, 200, { knowledgeBases: views });
  }

  private async getKnowledgeBase(
    _request: Request,
    id: string,
  ): Promise<Response> {
    try {
      const base = getKnowledgeBase(this.sessionDir, id);
      const view = await this.knowledgeBaseView(_request.signal, base);
      return writeJson(() => {}, 200, view);
    } catch (err) {
      return knowledgeBaseErrorResponse(err);
    }
  }

  private async createKnowledgeBase(request: Request): Promise<Response> {
    const body = await this.decodeMutationBody(request);
    if (typeof body !== "object" || body === null) {
      return writeJson(() => {}, 400, {
        error: "invalid knowledge base JSON",
      });
    }
    const spec = knowledgeBaseMutationSpec(
      (body as { knowledgeBase?: KnowledgeBaseMutation }).knowledgeBase ?? {},
    );
    try {
      validateWebKnowledgeBaseSpec(spec);
      const base = createKnowledgeBase(this.sessionDir, spec);
      const view = await this.knowledgeBaseView(request.signal, base);
      return writeJson(() => {}, 201, view);
    } catch (err) {
      return knowledgeBaseErrorResponse(err);
    }
  }

  private async updateKnowledgeBase(
    request: Request,
    id: string,
  ): Promise<Response> {
    const body = await this.decodeMutationBody(request);
    if (typeof body !== "object" || body === null) {
      return writeJson(() => {}, 400, {
        error: "invalid knowledge base JSON",
      });
    }
    const spec = knowledgeBaseMutationSpec(
      (body as { knowledgeBase?: KnowledgeBaseMutation }).knowledgeBase ?? {},
    );
    try {
      validateWebKnowledgeBaseSpec(spec);
      const base = updateKnowledgeBase(this.sessionDir, id, spec);
      const view = await this.knowledgeBaseView(request.signal, base);
      return writeJson(() => {}, 200, view);
    } catch (err) {
      return knowledgeBaseErrorResponse(err);
    }
  }

  private deleteKnowledgeBase(
    _request: Request,
    id: string,
  ): Response {
    try {
      deleteKnowledgeBase(this.sessionDir, id);
    } catch (err) {
      return knowledgeBaseErrorResponse(err);
    }
    return writeJson(() => {}, 200, { deleted: true, id });
  }

  private async scanKnowledgeBase(
    request: Request,
    id: string,
  ): Promise<Response> {
    let service: KnowledgeBaseService;
    try {
      service = this.knowledgeBaseService();
    } catch (err) {
      return knowledgeBaseErrorResponse(err);
    }
    // Scans always run in the background so the HTTP handler never blocks on a
    // long index and a page reload can still observe the running job. The WebUI
    // polls list/status while indexing.running is true and refreshes to the
    // terminal snapshot state afterwards. Concurrent scans of the same base
    // share one job.
    let job: KnowledgeIndexJob;
    try {
      job = service.startIndex(request.signal, id, SourceWebUI);
    } catch (err) {
      return knowledgeBaseErrorResponse(err);
    }
    let view: KnowledgeBaseView;
    try {
      const base = getKnowledgeBase(this.sessionDir, id);
      view = await this.knowledgeBaseView(request.signal, base);
    } catch (err) {
      return knowledgeBaseErrorResponse(err);
    }
    // Prefer the admitted job's progress over a possible race where the job
    // finished (or was replaced) between admission and this read.
    if (view.indexing === undefined && job.viewProgress().running) {
      view.indexing = knowledgeIndexViewFrom(job.viewProgress());
    }
    return writeJson(() => {}, 200, view);
  }

  private async queryKnowledgeBase(
    request: Request,
    id: string,
  ): Promise<Response> {
    let body: { query?: unknown; limit?: unknown } = {};
    try {
      const raw = await request.arrayBuffer();
      if (raw.byteLength > KNOWLEDGE_BODY_LIMIT) {
        throw new Error("too large");
      }
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return writeJson(() => {}, 400, { error: "query is required" });
    }
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (query === "") {
      return writeJson(() => {}, 400, { error: "query is required" });
    }
    let limit = typeof body.limit === "number" ? body.limit : 0;
    if (limit <= 0) {
      limit = 8;
    } else if (limit > 20) {
      limit = 20;
    }
    let service: KnowledgeBaseService;
    try {
      service = this.knowledgeBaseService();
    } catch (err) {
      return knowledgeBaseErrorResponse(err);
    }
    try {
      const result = service.query(request.signal, id, query, limit);
      return writeJson(() => {}, 200, { query: result });
    } catch (err) {
      return knowledgeBaseErrorResponse(err);
    }
  }

  /**
   * decodeMutationBody is the bounded body read shared by create/update. Go
   * decodes into a struct without DisallowUnknownFields, so unknown fields are
   * ignored; any malformed payload maps to the generic invalid-JSON error.
   */
  private async decodeMutationBody(request: Request): Promise<unknown> {
    let parsed: unknown;
    try {
      const raw = await request.arrayBuffer();
      if (raw.byteLength > KNOWLEDGE_BODY_LIMIT) {
        return null;
      }
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return null;
    }
    return parsed;
  }
}

/** writeKnowledgeBaseError ports the Go helper's status mapping. */
export function knowledgeBaseErrorStatus(err: unknown): number {
  const message = err instanceof Error ? err.message : String(err);
  if (
    err === ErrKnowledgeBaseNotFound ||
    message === ErrKnowledgeBaseNotFound.message ||
    (err instanceof Error && message.includes(ErrKnowledgeBaseNotFound.message))
  ) {
    return 404;
  }
  if (
    err === ErrKnowledgeBaseUnindexed ||
    message === ErrKnowledgeBaseUnindexed.message ||
    message.includes("is disabled")
  ) {
    return 409;
  }
  return 400;
}

export function knowledgeBaseErrorResponse(err: unknown): Response {
  return writeJson(() => {}, knowledgeBaseErrorStatus(err), {
    error: err instanceof Error ? err.message : String(err),
  });
}
