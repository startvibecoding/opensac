// Ported from internal/serve/run.go — the `channelRuntime` management-handler
// cluster plus the routes() registration table. These are the HTTP projections
// of the shared runtime state owned by ChannelRuntime (channel_runtime.ts) and
// the openaiapi Server; every handler delegates to the same runtime and session
// APIs instead of reimplementing semantics.
//
// Deviations: Go's `http.ResponseWriter`/`*http.Request` maps to the fetch
// `Request` → `Response` convention used by every ported serve handler; the
// `activeSessionManager` interface-assertion ladder maps to the concrete
// `Server` (all Go assertions are against *openaiapi.Server); JSON decode uses
// `Request.json`/`arrayBuffer`; `io.LimitReader(1<<20)` maps to a 1 MiB body
// cap enforced before decoding where Go relies on the reader; Windows drive
// enumeration is ported but inert on non-Windows builds (Deno.build.os).

import {
  dirname,
  join,
  normalize,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import { DB, type Query } from "../stats/stats.ts";
import { parseQueryParams } from "../stats/server.ts";
import {
  fork as runtimeFork,
  type ForkOptions,
  type ForkResult,
} from "../agentruntime/fork.ts";
import { ErrExpertSwitchRequiresFork } from "../agentruntime/expert.ts";
import { inspectSessionExecution } from "../agentruntime/execution.ts";
import {
  SessionStopAccepted,
  type SessionStopCode,
  SessionStopRecoveryFailed,
  SessionStopRecoveryStarted,
  SessionStopRemoteAccepted,
  SessionStopRemoteFailed,
  SessionStopStateUnavailable,
} from "../agentruntime/execution_stop.ts";
import {
  ForkIdempotencyConflictError,
  ForkIdempotencyRequiredError,
  ForkIdempotencyTooLongError,
  ForkInvalidBoundaryError,
  ForkNoCompletedTurnError,
  ForkSessionActiveError,
  ForkSessionNotFoundError,
  ForkUnavailableError,
  ForkUnsupportedEntryError,
} from "../session/fork.ts";
import { SessionModifiedError } from "../session/session_errors.ts";
import { RuntimeLeaseLostError } from "../session/runtime_lock.ts";
import { lockSessionData } from "../session/runtime_lock.ts";
import {
  countAll,
  countWithMessages,
  listAllDetailed,
  withLimit,
  withMessagesOnly,
  withOffset,
  withSearch,
} from "../session/manager.ts";
import {
  createProject,
  deleteProject,
  getSessionMetadata,
  listProjects,
  renameProject,
} from "../session/projects.ts";
import { listBindings } from "../session/bindings.ts";
import {
  type ChannelToolConfig,
  setChannelTools,
} from "../session/bindings.ts";
import { findBindingBySessionId } from "../session/bindings.ts";
import {
  applyEnvPatch,
  loadEnv,
  saveEnv,
  validateEnvName,
} from "../config/env.ts";
import { loadSettings, saveGlobalSettings } from "../config/settings.ts";
import { Store as MemoryStore } from "../memory/store.ts";
import { handleWechatLogin, handleWechatLoginQR } from "./channels_api.ts";
import {
  cloneServeConfig,
  type ConfigLayer,
  ServeConfigState,
} from "./config_state.ts";
import { defaultConfig, type ServeConfig } from "./config.ts";
import type { ToolCatalogItem } from "./channels/mod.ts";
import { platformTransportChanged } from "./channel_runtime.ts";
import type { ChannelRuntime } from "./channel_runtime.ts";
import {
  errNativeDirectoryPickerUnavailable,
  openNativeDirectoryPicker,
} from "./directory_picker.ts";
import { buildServeStatus, createWebUIHandler, writeJson } from "./http.ts";
import {
  type ActiveSessionInfo,
  ErrActiveSessionIDAmbiguous,
  ErrSessionNotFound,
  ErrSessionToolResultNotFound,
  ErrSubAgentNotFound,
  type SessionApprovalResponse,
} from "./openaiapi/session_mgr.ts";
import {
  capabilityOverview,
  getSessionCapabilities,
  getSessionCapabilityEvents,
  getSessionMessages,
  getSessionMessagesBefore,
  getSessionMessagesLatest,
  getSessionRunEvents,
  getSessionSubAgentMessages,
  getSessionSubAgents,
  getSessionToolResult,
  listServerSessionRuns,
  setSessionMetadata,
  setSessionTitle,
} from "./openaiapi/session_read.ts";
import {
  patchSessionCapabilities,
  patchSessionRuntime,
} from "./openaiapi/session_patch.ts";
import { getSessionRuntime } from "./openaiapi/session_runtime_snapshot.ts";
import { streamSession } from "./openaiapi/session_stream.ts";
import { requestSessionStop } from "./openaiapi/session_stop.ts";
import {
  forkSessionWithExpert,
  getSessionExpert,
  inspectExpert,
  isSessionExpertMutationBusy,
  listExperts,
} from "./openaiapi/expert_api.ts";
import { allocateSessionID } from "./openaiapi/handler_chat_session.ts";
import {
  getSessionTrajectory,
  handleSessionExport,
} from "./openaiapi/handler_session_trajectory.ts";
import type { SessionQuestionResponse } from "./openaiapi/types.ts";
import { handleSubmitRun } from "./openaiapi/handler_run_submit.ts";
import { handleESMAPI } from "./openaiapi/esm_handler.ts";
import { ErrInvalidTrajectoryCursor } from "./openaiapi/handler_session_trajectory.ts";
import {
  resolveSessionApproval,
  resolveSessionQuestion,
} from "./openaiapi/approval.ts";
import { handleMCPConfig, handleSessionMCPConfig } from "./mcp_api.ts";
import { runWebSocketHandler } from "./openaiapi/websocket.ts";
import type { ServeMux } from "./openaiapi/routes.ts";
import type { Server } from "./openaiapi/server.ts";
import { createLogsWebSocketHandler } from "./logs.ts";
import {
  LifecycleConflict,
  SessionLifecycleService,
} from "./session_lifecycle.ts";
import { deleteActiveSession } from "./openaiapi/session_patch.ts";
import { handleSkillHub } from "./skillhub_api.ts";
import type { SessionExecutionSnapshot } from "../agentruntime/execution.ts";

// ---------------------------------------------------------------------------
// activeSessionManager seam
// ---------------------------------------------------------------------------

/**
 * Go's activeSessionManager is the interface *openaiapi.Server satisfies and
 * every handler assertion below tests against the concrete server; the port
 * keeps the seam as the nullable Server type so tests can inject null.
 */
export type ActiveSessionManager = Server | null;

export function activeSessionManagerFromAPI(
  srv: Server | null | undefined,
): ActiveSessionManager {
  return srv ?? null;
}

// ---------------------------------------------------------------------------
// shared response helpers
// ---------------------------------------------------------------------------

/** writeJSON ports run.go's helper over the shared writeJson projection. */
function writeJSON(status: number, body: unknown): Response {
  return writeJson(() => {}, status, body);
}

function errorBody(err: unknown): { error: string } {
  return { error: err instanceof Error ? err.message : String(err) };
}

/** parsePositiveInt ports run.go's helper. */
export function parsePositiveInt(value: string, fallback: number): number {
  if (value === "") return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) return fallback;
  return n;
}

function methodNotAllowed(): Response {
  return new Response(null, { status: 405 });
}

/** filterActiveSessions ports run.go's helper. */
export function filterActiveSessions(
  list: ActiveSessionInfo[],
): ActiveSessionInfo[] {
  return list.filter((sess) => sess.active);
}

/** channelLabel ports run.go's helper. */
export function channelLabel(channelType: string, _channelID: string): string {
  switch (channelType) {
    case "wechat":
      return "WeChat";
    case "feishu":
      return "Feishu";
    default:
      return "Local";
  }
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

/** handleStats ports run.go's receiver over the shared stats DB. */
export function handleStats(
  rt: ChannelRuntime,
): (request: Request) => Response {
  return (request) => {
    if (request.method !== "GET") return methodNotAllowed();
    const url = new URL(request.url);
    let endpoint = url.pathname.startsWith("/api/stats/")
      ? url.pathname.slice("/api/stats/".length)
      : url.pathname;
    if (endpoint === "") endpoint = "summary";
    const sessionDir = rt.sessionDir;
    if (sessionDir === "") return writeEmptyStatsResponse(endpoint);
    const dbPath = join(sessionDir, "sessions.db");
    try {
      Deno.statSync(dbPath);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        return writeEmptyStatsResponse(endpoint);
      }
      return writeJSON(500, errorBody(err));
    }
    let db: DB;
    try {
      db = DB.open(dbPath);
    } catch (err) {
      return writeJSON(500, errorBody(err));
    }
    try {
      const q: Query = parseQueryParams(url.searchParams);
      switch (endpoint) {
        case "summary":
          return writeJSON(200, db.summary(q));
        case "timeseries":
          return writeJSON(200, db.timeSeries(q));
        case "by-provider":
          return writeJSON(200, db.byProvider(q));
        case "by-model":
          return writeJSON(200, db.byModel(q));
        case "recent": {
          const page = parsePositiveInt(
            url.searchParams.get("page") ?? "",
            1,
          );
          const pageSize = parsePositiveInt(
            url.searchParams.get("pageSize") ?? "",
            20,
          );
          return writeJSON(200, db.recentFiltered(q, page, pageSize));
        }
        default:
          return writeJSON(404, { error: "unknown stats endpoint" });
      }
    } finally {
      db.close();
    }
  };
}

function writeEmptyStatsResponse(endpoint: string): Response {
  switch (endpoint) {
    case "summary":
    case "":
      return writeJSON(200, {
        totalRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      });
    case "timeseries":
    case "by-provider":
    case "by-model":
      return writeJSON(200, []);
    case "recent":
      return writeJSON(200, { items: [], total: 0, page: 1, pageSize: 20 });
    default:
      return writeJSON(404, { error: "unknown stats endpoint" });
  }
}

// ---------------------------------------------------------------------------
// serve config
// ---------------------------------------------------------------------------

/**
 * configStateSnapshot ports run.go's receiver: the loaded state wins; the lazy
 * fallback pins the effective snapshot and the given writable identity.
 */
function configStateSnapshot(
  rt: ChannelRuntime,
  path: string,
  layer: ConfigLayer,
): ServeConfigState {
  if (rt.configState !== null) return rt.configState;
  const state = ServeConfigState.lazy(
    rt.configSnapshot() ?? cloneServeConfig(defaultConfig()),
    path,
    layer,
  );
  rt.setConfigState(state);
  return state;
}

/** handleServeConfig ports run.go's receiver. */
export function handleServeConfig(
  rt: ChannelRuntime,
  path: string,
  srv: Server | null,
): (request: Request) => Promise<Response> {
  return async (request) => {
    switch (request.method) {
      case "GET":
        return writeJSON(200, rt.configSnapshot());
      case "PUT": {
        let body: Uint8Array;
        try {
          body = new Uint8Array(await request.arrayBuffer());
        } catch (err) {
          return writeJSON(400, errorBody(err));
        }
        const state = configStateSnapshot(rt, path, "explicit");
        const previous = rt.configSnapshot();
        let next: ServeConfig;
        try {
          next = await state.updateFull(body, async (candidate) => {
            await rt.applyConfigUpdate(candidate);
            if (srv !== null) {
              try {
                srv.applyServeConfig(candidate.api);
              } catch (err) {
                if (previous !== null) {
                  await rt.applyConfigUpdate(previous).catch(() => {});
                }
                throw err;
              }
            }
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const status = message.startsWith("decode ") ? 400 : 500;
          return writeJSON(status, { error: message });
        }
        if (rt.logHub !== null) {
          rt.logHub.publish({
            type: "config_changed",
            timestamp: new Date().toISOString(),
            status: statusSnapshot(rt, srv),
            data: { scope: "serve" },
          });
        }
        return writeJSON(200, next);
      }
      default:
        return methodNotAllowed();
    }
  };
}

/** handleChannelConfigPatch ports run.go's receiver. */
export function handleChannelConfigPatch(
  rt: ChannelRuntime,
  fallbackPath: string,
  srv: Server | null,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "PATCH") return methodNotAllowed();
    const url = new URL(request.url);
    const platform = url.pathname
      .slice("/api/serve/config/channels/".length)
      .replace(/^\/+|\/+$/g, "");
    if (platform !== "wechat" && platform !== "feishu") {
      return writeJSON(404, { error: "channel must be wechat or feishu" });
    }
    let body: Uint8Array;
    try {
      const buf = await request.arrayBuffer();
      if (buf.byteLength > 1 << 20) {
        return writeJSON(400, { error: "request body too large" });
      }
      body = new Uint8Array(buf);
    } catch (err) {
      return writeJSON(400, errorBody(err));
    }
    let path = fallbackPath;
    let layer: ConfigLayer = "explicit";
    const state = configStateSnapshot(rt, path, layer);
    if (state !== null) {
      path = state.writablePath;
      layer = state.writableLayer;
    }
    const old = rt.configSnapshot();
    let result;
    try {
      result = await state.updateChannel(
        platform,
        body,
        (candidate) => rt.applyConfigUpdate(candidate),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith("decode ") ||
          message.includes("unsupported") || message.includes("must be")
        ? 400
        : 500;
      return writeJSON(status, { error: message });
    }
    result.layer = layer;
    result.path = path;
    result.restart = {
      platform,
      required: platformTransportChanged(old, rt.configSnapshot(), platform),
    };
    if (rt.logHub !== null) {
      rt.logHub.publish({
        type: "channel_config_changed",
        timestamp: new Date().toISOString(),
        status: statusSnapshot(rt, srv),
        data: {
          platform,
          layer: result.layer,
          path: result.path,
          restart: result.restart,
        },
      });
    }
    return writeJSON(200, result);
  };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/** handleStatus ports run.go's receiver. */
export function handleStatus(
  rt: ChannelRuntime,
  sessions: ActiveSessionManager,
): (request: Request) => Response {
  return (request) => {
    if (request.method !== "GET") return methodNotAllowed();
    return writeJSON(200, statusSnapshot(rt, sessions));
  };
}

/** statusSnapshot ports run.go's receiver over the shared buildServeStatus. */
export function statusSnapshot(
  rt: ChannelRuntime,
  sessions: ActiveSessionManager,
): ReturnType<typeof buildServeStatus> {
  let sessionCount = 0;
  if (sessions !== null) {
    // CountAll instead of loading all sessions to avoid the expensive list.
    const dir = sessions.sessionDir();
    if (dir !== "") {
      try {
        sessionCount = countAll(dir);
      } catch {
        sessionCount = 0;
      }
    }
    if (sessionCount === 0) {
      sessionCount = listActiveSessionsOf(sessions).length;
    }
  }
  return buildServeStatus({
    config: rt.configSnapshot() ?? undefined,
    channels: rt.channelStatuses(),
    sessions: sessionCount,
    webSearchAvailable: sessions?.isWebSearchAvailable() ?? false,
  });
}

function listActiveSessionsOf(server: Server): ActiveSessionInfo[] {
  return listActiveSessions(server);
}

// ---------------------------------------------------------------------------
// session tool catalog / channel tools
// ---------------------------------------------------------------------------

/** handleSessionToolCatalog ports run.go's receiver. */
export function handleSessionToolCatalog(
  rt: ChannelRuntime,
): (request: Request) => Response {
  return (request) => {
    if (request.method !== "GET" || rt.dispatcher === null) {
      return methodNotAllowed();
    }
    const platform = new URL(request.url).searchParams.get("platform") ?? "";
    if (platform !== "wechat" && platform !== "feishu") {
      return writeJSON(400, { error: "platform must be wechat or feishu" });
    }
    return writeJSON(200, {
      platform,
      tools: rt.dispatcher.toolCatalog(platform),
    });
  };
}

/** channelToolsAppliesTo ports run.go's receiver. */
export function channelToolsAppliesTo(
  rt: ChannelRuntime,
  sessionID: string,
): string {
  if (sessionID === "") return "current";
  let snapshot: SessionExecutionSnapshot;
  try {
    snapshot = inspectSessionExecution(rt.sessionDir, sessionID);
  } catch {
    return "next_run";
  }
  if (!snapshot.canSubmit) return "next_run";
  return "current";
}

interface ChannelToolsResponse {
  sessionId: string;
  platform: string;
  generation: number;
  appliesTo: string;
  tools: unknown[];
}

/** handleChannelToolsBySession ports run.go's receiver. */
export function handleChannelToolsBySession(
  rt: ChannelRuntime,
  request: Request,
  sessionID: string,
): Promise<Response> {
  if (rt.dispatcher === null) {
    return Promise.resolve(
      writeJSON(503, { error: "channel dispatcher unavailable" }),
    );
  }
  switch (request.method) {
    case "GET": {
      const [response, status, err] = channelToolsStateSync(rt, sessionID);
      if (err !== null) {
        return Promise.resolve(writeJSON(status, errorBody(err)));
      }
      return Promise.resolve(writeJSON(200, response));
    }
    case "PUT":
      return handleChannelToolsPut(rt, request, sessionID);
    default:
      return Promise.resolve(methodNotAllowed());
  }
}

async function handleChannelToolsPut(
  rt: ChannelRuntime,
  request: Request,
  sessionID: string,
): Promise<Response> {
  let body: { tools?: ChannelToolSelection[] };
  try {
    body = await request.json() as { tools?: ChannelToolSelection[] };
  } catch (err) {
    return writeJSON(400, { error: `invalid JSON: ${errString(err)}` });
  }
  const [response, status, err] = await replaceChannelTools(
    rt,
    sessionID,
    body.tools ?? [],
  );
  if (err !== null) return writeJSON(status, errorBody(err));
  return writeJSON(200, response);
}

/** Go's channelToolSelection JSON body item. */
interface ChannelToolSelection {
  name: string;
  enabled: boolean;
}

function errString(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function channelToolsStateSync(
  rt: ChannelRuntime,
  sessionID: string,
): [ChannelToolsResponse, number, Error | null] {
  let binding;
  try {
    binding = findBindingBySessionId(rt.sessionDir, sessionID);
  } catch (err) {
    return [null!, 500, err instanceof Error ? err : new Error(String(err))];
  }
  if (binding === null) {
    return [
      null!,
      409,
      new Error("session is not bound to wechat or feishu"),
    ];
  }
  const { states, generation } = rt.dispatcher!.sessionToolStates(
    sessionID,
    binding.channelType,
  );
  return [
    {
      sessionId: sessionID,
      platform: binding.channelType,
      generation,
      appliesTo: channelToolsAppliesTo(rt, sessionID),
      tools: states,
    },
    200,
    null,
  ];
}

async function replaceChannelTools(
  rt: ChannelRuntime,
  sessionID: string,
  selections: ChannelToolSelection[],
): Promise<[ChannelToolsResponse, number, Error | null]> {
  let releaseData: (() => void) | null = null;
  try {
    releaseData = await lockSessionData(rt.sessionDir, sessionID);
  } catch {
    // Go ignores lock acquisition failures here (defer release pattern only
    // wraps the happy path); proceed with the same binding checks.
  }
  try {
    let binding;
    try {
      binding = findBindingBySessionId(rt.sessionDir, sessionID);
    } catch (err) {
      return [null!, 500, err instanceof Error ? err : new Error(String(err))];
    }
    if (binding === null) {
      return [
        null!,
        409,
        new Error("session is not bound to wechat or feishu"),
      ];
    }
    const catalog: ToolCatalogItem[] = rt.dispatcher!.toolCatalog(
      binding.channelType,
    );
    if (selections.length !== catalog.length) {
      return [
        null!,
        400,
        new Error(
          `tools must contain the complete catalog (${catalog.length} entries)`,
        ),
      ];
    }
    const definitions = new Map<string, ToolCatalogItem>();
    for (const item of catalog) definitions.set(item.name, item);
    const seen = new Set<string>();
    const configured: ChannelToolConfig[] = [];
    for (const item of selections) {
      const name = item.name.trim();
      const definition = definitions.get(name);
      if (definition === undefined) {
        return [
          null!,
          400,
          new Error(`unknown channel tool ${JSON.stringify(name)}`),
        ];
      }
      if (seen.has(name)) {
        return [
          null!,
          400,
          new Error(`duplicate channel tool ${JSON.stringify(name)}`),
        ];
      }
      seen.add(name);
      if (item.enabled && !definition.available) {
        const reason = definition.unavailableReason !== ""
          ? definition.unavailableReason
          : "tool is unavailable";
        return [
          null!,
          409,
          new Error(`tool ${JSON.stringify(name)} is unavailable: ${reason}`),
        ];
      }
      configured.push({ toolName: name, enabled: item.enabled });
    }
    try {
      setChannelTools(rt.sessionDir, sessionID, configured);
    } catch (err) {
      const message = errString(err);
      if (message.includes("not found")) {
        return [null!, 404, err instanceof Error ? err : new Error(message)];
      }
      return [null!, 500, err instanceof Error ? err : new Error(message)];
    }
    rt.dispatcher!.refreshSessionTools(sessionID);
    const [response, status, err] = channelToolsStateSync(rt, sessionID);
    if (err !== null) return [null!, status, err];
    rt.publishManagementEvent("channel_tools_changed", {
      sessionId: sessionID,
      platform: binding.channelType,
      generation: response.generation,
      appliesTo: response.appliesTo,
    });
    return [response, status, null];
  } finally {
    releaseData?.();
  }
}

// ---------------------------------------------------------------------------
// projects / bindings
// ---------------------------------------------------------------------------

/** handleProjects ports run.go's receiver. */
export function handleProjects(
  rt: ChannelRuntime,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method === "GET") {
      let projects;
      try {
        projects = listProjects(rt.sessionDir);
      } catch (err) {
        return writeJSON(500, errorBody(err));
      }
      return writeJSON(200, { projects });
    }
    if (request.method !== "POST") return methodNotAllowed();
    let body: { name?: string };
    try {
      body = await request.json() as { name?: string };
    } catch {
      return writeJSON(400, { error: "invalid JSON" });
    }
    try {
      const project = createProject(rt.sessionDir, body.name ?? "");
      return writeJSON(201, project);
    } catch (err) {
      return writeJSON(400, errorBody(err));
    }
  };
}

/** handleProjectByID ports run.go's receiver. */
export function handleProjectByID(
  rt: ChannelRuntime,
  request: Request,
): Promise<Response> {
  const id = new URL(request.url).pathname
    .slice("/api/projects/".length)
    .replace(/^\/+|\/+$/g, "");
  if (id === "") {
    return Promise.resolve(writeJSON(400, { error: "project ID required" }));
  }
  if (request.method === "PATCH") {
    return (async () => {
      let body: { name?: string };
      try {
        body = await request.json() as { name?: string };
      } catch {
        return writeJSON(400, { error: "invalid JSON" });
      }
      try {
        const project = renameProject(rt.sessionDir, id, body.name ?? "");
        return writeJSON(200, project);
      } catch (err) {
        return writeJSON(400, errorBody(err));
      }
    })();
  }
  if (request.method !== "DELETE") return Promise.resolve(methodNotAllowed());
  try {
    deleteProject(rt.sessionDir, id);
  } catch (err) {
    return Promise.resolve(writeJSON(500, errorBody(err)));
  }
  return Promise.resolve(new Response(null, { status: 204 }));
}

/** handleSessionBindings ports run.go's receiver. */
export function handleSessionBindings(
  rt: ChannelRuntime,
): (request: Request) => Response {
  return (request) => {
    if (request.method !== "GET") return methodNotAllowed();
    let bindings;
    try {
      bindings = listBindings(rt.sessionDir);
    } catch (err) {
      return writeJSON(500, errorBody(err));
    }
    return writeJSON(200, { bindings });
  };
}

// ---------------------------------------------------------------------------
// session management (title/metadata)
// ---------------------------------------------------------------------------

/** handleSessionManagementUpdate ports run.go's receiver. */
export function handleSessionManagementUpdate(
  rt: ChannelRuntime,
  sessions: ActiveSessionManager,
  request: Request,
): Promise<Response> {
  return (async () => {
    const parts = new URL(request.url).pathname
      .slice("/api/sessions/".length)
      .replace(/^\/+|\/+$/g, "")
      .split("/");
    if (parts.length !== 2 || parts[0] === "") {
      return writeJSON(400, { error: "invalid session route" });
    }
    if (sessions === null) {
      return writeJSON(503, { error: "server not ready" });
    }
    const id = parts[0];
    if (parts[1] === "title") {
      if (request.method !== "POST") return methodNotAllowed();
      let body: { title?: string };
      try {
        body = await request.json() as { title?: string };
      } catch {
        return writeJSON(400, { error: "invalid JSON" });
      }
      try {
        const item = setSessionTitle(sessions, id, body.title ?? "");
        return writeJSON(200, item);
      } catch (err) {
        return writeJSON(400, errorBody(err));
      }
    }
    if (parts[1] !== "metadata" || request.method !== "PATCH") {
      return methodNotAllowed();
    }
    let body: { projectId?: string | null; pinned?: boolean | null };
    try {
      body = await request.json() as {
        projectId?: string | null;
        pinned?: boolean | null;
      };
    } catch {
      return writeJSON(400, { error: "invalid JSON" });
    }
    let metadata;
    try {
      metadata = getSessionMetadata(rt.sessionDir, id);
    } catch (err) {
      return writeJSON(500, errorBody(err));
    }
    if (body.projectId !== undefined && body.projectId !== null) {
      metadata.projectId = body.projectId;
    }
    if (body.pinned !== undefined && body.pinned !== null) {
      metadata.pinned = body.pinned;
    }
    try {
      const item = setSessionMetadata(sessions, id, metadata);
      return writeJSON(200, item);
    } catch (err) {
      return writeJSON(400, errorBody(err));
    }
  })();
}

// ---------------------------------------------------------------------------
// experts
// ---------------------------------------------------------------------------

/** writeExpertHTTPError ports run.go's helper. */
export function writeExpertHTTPError(err: unknown): Response {
  let status = 400;
  let code = "expert_invalid";
  if (
    err === ErrSessionNotFound || err instanceof ForkSessionNotFoundError
  ) {
    status = 404;
    code = "session_not_found";
  } else if (err === ErrExpertSwitchRequiresFork) {
    status = 409;
    code = "expert_switch_requires_fork";
  } else if (
    isSessionExpertMutationBusy(err) || err instanceof ForkSessionActiveError
  ) {
    status = 409;
    code = "session_active";
  }
  return writeJSON(status, { error: code, code });
}

/** handleExperts ports run.go's receiver (the WebUI expert projection). */
export function handleExperts(
  _rt: ChannelRuntime,
  sessions: ActiveSessionManager,
): (request: Request) => Response {
  return (request) => {
    if (request.method !== "GET") return methodNotAllowed();
    if (sessions === null) {
      return writeJSON(503, { error: "server not ready" });
    }
    const url = new URL(request.url);
    let sessionID = (url.searchParams.get("sessionId") ?? "").trim();
    if (sessionID === "") {
      sessionID = (url.searchParams.get("session_id") ?? "").trim();
    }
    const relative = url.pathname
      .slice("/api/experts".length)
      .replace(/^\/+|\/+$/g, "");
    if (relative === "") {
      try {
        const experts = listExperts(sessions, sessionID);
        return writeJSON(200, { experts });
      } catch (err) {
        return writeExpertHTTPError(err);
      }
    }
    let id: string;
    try {
      id = decodeURIComponent(relative);
    } catch {
      return writeJSON(400, { error: "invalid expert ID" });
    }
    if (id.includes("/")) {
      return writeJSON(400, { error: "invalid expert ID" });
    }
    try {
      const detail = inspectExpert(sessions, sessionID, id);
      return writeJSON(200, detail);
    } catch (err) {
      return writeExpertHTTPError(err);
    }
  };
}

/**
 * handleSessionExpert is the session-scoped identity projection; mutations
 * delegate to Server.setSessionExpert (Go's SetSessionExpert hook).
 */
export function handleSessionExpert(
  _rt: ChannelRuntime,
  srv: Server | null,
  id: string,
  parts: string[],
  request: Request,
): Promise<Response> {
  if (srv === null) {
    return Promise.resolve(writeJSON(503, { error: "server not ready" }));
  }
  if (parts.length === 2) {
    switch (request.method) {
      case "GET":
        return getSessionExpert(srv, id).then(
          (state) => writeJSON(200, state),
          (err) => writeExpertHTTPError(err),
        );
      case "PATCH":
        return (async () => {
          let body: { expertId?: string };
          try {
            const text = await limitBody(request);
            body = JSON.parse(text) as { expertId?: string };
          } catch {
            return writeJSON(400, { error: "expertId is required" });
          }
          if (body.expertId === undefined) {
            return writeJSON(400, { error: "expertId is required" });
          }
          try {
            const state = await srv.setSessionExpert?.(
              request.signal,
              id,
              body.expertId,
            );
            if (state === undefined && srv.setSessionExpert === undefined) {
              return writeJSON(503, { error: "server not ready" });
            }
            return writeJSON(200, state);
          } catch (err) {
            return writeExpertHTTPError(err);
          }
        })();
      default:
        return Promise.resolve(methodNotAllowed());
    }
  }
  if (parts.length === 3 && request.method === "GET") {
    let expertID: string;
    try {
      expertID = decodeURIComponent(parts[2]);
    } catch {
      return Promise.resolve(writeJSON(400, { error: "invalid expert ID" }));
    }
    if (expertID === "") {
      return Promise.resolve(writeJSON(400, { error: "invalid expert ID" }));
    }
    try {
      const detail = inspectExpert(srv, id, expertID);
      return Promise.resolve(writeJSON(200, detail));
    } catch (err) {
      return Promise.resolve(writeExpertHTTPError(err));
    }
  }
  return Promise.resolve(methodNotAllowed());
}

/** limitBody reads at most 1 MiB of the body, Go's io.LimitReader bound. */
async function limitBody(request: Request): Promise<string> {
  const buf = await request.arrayBuffer();
  if (buf.byteLength > 1 << 20) {
    return new TextDecoder().decode(buf.slice(0, 1 << 20));
  }
  return new TextDecoder().decode(buf);
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

/** handleSessionID allocates a deferred WebUI session ID. */
export function handleSessionID(
  _rt: ChannelRuntime,
  sessions: ActiveSessionManager,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "POST") return methodNotAllowed();
    if (sessions === null) {
      return writeJSON(503, { error: "session allocator is not ready" });
    }
    try {
      const id = await allocateSessionID(sessions);
      return writeJSON(200, { sessionId: id });
    } catch (err) {
      return writeJSON(500, errorBody(err));
    }
  };
}

/** handleCapabilities ports run.go's receiver. */
export function handleCapabilities(
  _rt: ChannelRuntime,
  sessions: ActiveSessionManager,
): (request: Request) => Response {
  return (request) => {
    if (request.method !== "GET") return methodNotAllowed();
    if (sessions === null) {
      return writeJSON(503, { error: "API server not ready" });
    }
    return writeJSON(200, capabilityOverview(sessions));
  };
}

/** handleSessions ports run.go's receiver. */
export function handleSessions(
  rt: ChannelRuntime,
  sessions: ActiveSessionManager,
): (request: Request) => Response {
  return (request) => {
    if (request.method !== "GET") return methodNotAllowed();
    if (sessions === null) {
      return writeJSON(503, { error: "API server not ready" });
    }
    const url = new URL(request.url);
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    const offset = Number.parseInt(url.searchParams.get("offset") ?? "", 10);

    // Paginated path: query the DB directly with LIMIT/OFFSET.
    if (!Number.isNaN(limit) && limit > 0) {
      const dir = sessions.sessionDir();
      const search = (url.searchParams.get("search") ?? "").trim();
      let details;
      try {
        details = listAllDetailed(rt.sessionDir !== "" ? rt.sessionDir : dir, [
          withLimit(limit),
          withOffset(Number.isNaN(offset) ? 0 : offset),
          withMessagesOnly(),
          withSearch(search),
        ]);
      } catch (err) {
        return writeJSON(500, errorBody(err));
      }
      let total: number;
      try {
        total = countWithMessages(rt.sessionDir !== "" ? rt.sessionDir : dir, [
          withSearch(search),
        ]);
      } catch (err) {
        return writeJSON(500, errorBody(err));
      }
      const result: ActiveSessionInfo[] = [];
      for (const d of details) {
        const item: ActiveSessionInfo = {
          id: d.id,
          workDir: d.cwd,
          lastUsed: d.modTime,
          messageCount: d.messageCount,
          preview: d.preview,
          title: d.name,
          channelType: d.channelType,
          channelId: d.channelId,
          channelLabel: channelLabel(d.channelType, d.channelId),
          bound: d.channelType === "wechat" || d.channelType === "feishu",
          parentSessionId: d.parentSession,
          forkBoundarySeq: d.forkBoundarySeq,
          seedLength: d.seedLength,
          forkKind: d.forkKind,
          active: false,
        };
        try {
          const metadata = getSessionMetadata(rt.sessionDir, item.id);
          item.projectId = metadata.projectId;
          item.pinned = metadata.pinned;
        } catch {
          // Go ignores the metadata error (`if err == nil`).
        }
        let execution: SessionExecutionSnapshot;
        try {
          execution = inspectSessionExecution(rt.sessionDir, item.id);
        } catch (inspectErr) {
          console.error(
            `[serve] inspect execution for session ${
              JSON.stringify(item.id)
            }: ${errString(inspectErr)}`,
          );
          execution = inspectSessionExecution("", item.id);
        }
        item.execution = execution;
        item.running = execution.running;
        if (item.channelType === "") {
          item.channelType = "local";
          item.channelLabel = channelLabel(
            item.channelType,
            item.channelId ?? "",
          );
        }
        result.push(item);
      }
      return writeJSON(200, { sessions: result, total });
    }

    let scope = url.searchParams.get("scope") ?? "";
    if (scope === "") scope = "all";
    let list = listActiveSessions(sessions);
    switch (scope) {
      case "all":
        break;
      case "active":
        list = filterActiveSessions(list);
        break;
      default:
        return writeJSON(400, {
          error: "invalid scope: expected all or active",
        });
    }
    return writeJSON(200, { sessions: list });
  };
}

function listActiveSessions(server: Server): ActiveSessionInfo[] {
  return listActiveSessionsOf(server);
}

// ---------------------------------------------------------------------------
// handleSessionByID — the /api/sessions/{id}/… dispatcher
// ---------------------------------------------------------------------------

/** handleSessionByID ports run.go's receiver in full. */
export function handleSessionByID(
  rt: ChannelRuntime,
  sessions: ActiveSessionManager,
): (request: Request) => Promise<Response> {
  return (request) => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");
    if (
      path.endsWith("/metadata") || path.endsWith("/title")
    ) {
      return handleSessionManagementUpdate(rt, sessions, request);
    }
    if (url.pathname.slice("/api/sessions/".length).includes("/esm")) {
      if (sessions !== null) {
        return handleESMAPI(sessions, request);
      }
    }
    const lifecycle = newLifecycle(rt, sessions);
    const parts = url.pathname
      .slice("/api/sessions/".length)
      .replace(/^\/+|\/+$/g, "")
      .split("/");
    if (parts.length === 0) {
      return Promise.resolve(writeJSON(400, { error: "session ID required" }));
    }
    let id: string;
    try {
      id = decodeURIComponent(parts[0]);
    } catch {
      return Promise.resolve(writeJSON(400, { error: "invalid session ID" }));
    }
    if (id === "") {
      return Promise.resolve(
        writeJSON(400, { error: "session ID required" }),
      );
    }
    if (parts.length >= 2 && parts[1] === "expert") {
      if (sessions === null) {
        return Promise.resolve(
          writeJSON(503, { error: "server not ready" }),
        );
      }
      return handleSessionExpert(rt, sessions, id, parts, request);
    }
    if (parts.length === 2 && parts[1] === "fork") {
      if (request.method !== "POST") {
        return Promise.resolve(methodNotAllowed());
      }
      return handleSessionFork(rt, sessions, id, request);
    }
    if (parts.length === 1 && id === "active" && request.method === "GET") {
      if (sessions === null) {
        return Promise.resolve(
          writeJSON(503, { error: "API server not ready" }),
        );
      }
      return Promise.resolve(
        writeJSON(200, {
          sessions: filterActiveSessions(listActiveSessions(sessions)),
        }),
      );
    }
    if (
      parts.length === 3 && parts[1] === "approvals" &&
      request.method === "POST"
    ) {
      if (sessions === null) {
        return Promise.resolve(
          writeJSON(501, {
            error: "approval responses are not supported",
          }),
        );
      }
      return (async () => {
        let response: SessionApprovalResponse;
        try {
          response = JSON.parse(
            await limitBody(request),
          ) as SessionApprovalResponse;
        } catch (err) {
          return writeJSON(400, {
            error: `invalid JSON: ${errString(err)}`,
          });
        }
        try {
          const { resolution, err } = resolveSessionApproval(
            sessions,
            id,
            parts[2],
            response,
          );
          if (err !== null || resolution === null) {
            return writeJSON(409, errorBody(err));
          }
          return writeJSON(200, resolution);
        } catch (err) {
          return writeJSON(409, errorBody(err));
        }
      })();
    }
    if (
      parts.length === 3 && parts[1] === "questions" &&
      request.method === "POST"
    ) {
      if (sessions === null) {
        return Promise.resolve(
          writeJSON(501, {
            error: "question responses are not supported",
          }),
        );
      }
      return (async () => {
        let response: SessionQuestionResponse;
        try {
          response = JSON.parse(
            await limitBody(request),
          ) as SessionQuestionResponse;
        } catch (err) {
          return writeJSON(400, {
            error: `invalid JSON: ${errString(err)}`,
          });
        }
        try {
          const { resolution, err } = resolveSessionQuestion(
            sessions,
            id,
            parts[2],
            response,
          );
          if (err !== null || resolution === null) {
            return writeJSON(409, errorBody(err));
          }
          return writeJSON(200, resolution);
        } catch (err) {
          return writeJSON(409, errorBody(err));
        }
      })();
    }
    if (parts.length >= 2 && parts[1] === "esm") {
      if (sessions === null) {
        return Promise.resolve(
          writeJSON(501, { error: "ESM controls are not supported" }),
        );
      }
      return handleESMAPI(sessions, request);
    }
    if (parts.length === 2 && parts[1] === "channel-tools") {
      return handleChannelToolsBySession(rt, request, id);
    }
    if (parts.length === 2 && parts[1] === "trajectory") {
      if (request.method !== "GET") {
        return Promise.resolve(methodNotAllowed());
      }
      if (sessions === null) {
        return Promise.resolve(
          writeJSON(501, { error: "trajectory is not supported" }),
        );
      }
      const limit = parsePositiveInt(url.searchParams.get("limit") ?? "", 200);
      try {
        const response = getSessionTrajectory(
          sessions,
          id,
          url.searchParams.get("before") ?? "",
          limit,
        );
        return Promise.resolve(writeJSON(200, response));
      } catch (err) {
        if (err === ErrSessionNotFound) {
          return Promise.resolve(writeJSON(404, errorBody(err)));
        }
        if (err === ErrInvalidTrajectoryCursor) {
          return Promise.resolve(
            writeJSON(400, { error: (err as Error).message }),
          );
        }
        return Promise.resolve(
          writeJSON(500, { error: "trajectory unavailable" }),
        );
      }
    }
    if (parts.length === 2 && parts[1] === "export") {
      if (sessions === null) {
        return Promise.resolve(
          writeJSON(501, { error: "session export is not supported" }),
        );
      }
      return Promise.resolve(handleSessionExport(sessions, request, id));
    }
    if (parts.length === 2 && parts[1] === "mcp") {
      return handleSessionMCPConfig(
        request,
        sessions === null
          ? null
          : { listActiveSessions: () => listActiveSessions(sessions) },
        id,
      );
    }
    if (parts.length === 2 && parts[1] === "bindings") {
      return handleSessionBindingsByID(rt, lifecycle, id, request);
    }
    if (parts.length === 2 && parts[1] === "runs") {
      if (request.method === "GET") {
        if (sessions === null) {
          return Promise.resolve(
            writeJSON(501, { error: "run listing is not supported" }),
          );
        }
        const limit = parsePositiveInt(
          url.searchParams.get("limit") ?? "",
          100,
        );
        try {
          const runs = listServerSessionRuns(sessions, id, limit);
          return Promise.resolve(writeJSON(200, { sessionId: id, runs }));
        } catch (err) {
          return Promise.resolve(writeJSON(500, errorBody(err)));
        }
      }
      if (request.method === "POST") {
        if (sessions === null) {
          return Promise.resolve(
            writeJSON(501, { error: "run submission is not supported" }),
          );
        }
        return handleSubmitRun(sessions, request);
      }
      return Promise.resolve(methodNotAllowed());
    }
    if (
      parts.length === 2 && parts[1] === "stop" && request.method === "POST"
    ) {
      if (sessions === null) {
        return Promise.resolve(
          writeJSON(501, { error: "run cancellation is not supported" }),
        );
      }
      return (async () => {
        const { result, err } = await requestSessionStop(sessions, id);
        let status = 409;
        const code: SessionStopCode = result.code;
        if (
          code === SessionStopAccepted ||
          code === SessionStopRemoteAccepted ||
          code === SessionStopRecoveryStarted
        ) {
          status = 202;
        } else if (
          code === SessionStopRecoveryFailed ||
          code === SessionStopStateUnavailable
        ) {
          status = 503;
        } else if (code === SessionStopRemoteFailed) {
          status = 502;
        }
        const response: Record<string, unknown> = {
          status: code,
          code,
          sessionId: id,
          execution: result.execution,
        };
        if (err !== null) response.error = errString(err);
        return writeJSON(status, response);
      })();
    }
    if (parts.length === 2 && parts[1] === "runtime") {
      if (sessions === null) {
        return Promise.resolve(
          writeJSON(503, { error: "API server not ready" }),
        );
      }
      return handleSessionRuntime(sessions, id, request);
    }
    if (parts.length === 2 && parts[1] === "capabilities") {
      if (sessions === null) {
        return Promise.resolve(
          writeJSON(503, { error: "API server not ready" }),
        );
      }
      return handleSessionCapabilities(sessions, id, request);
    }
    if (parts.length === 2 && parts[1] === "stream") {
      if (request.method !== "GET") {
        return Promise.resolve(methodNotAllowed());
      }
      if (sessions === null) {
        return Promise.resolve(
          writeJSON(503, { error: "API server not ready" }),
        );
      }
      return Promise.resolve(streamSession(sessions, request, id)).then(
        (response) =>
          response instanceof Response
            ? response
            : Promise.resolve(response).then((r) => r as Response),
      );
    }
    if (parts.length === 2 && parts[1] === "messages") {
      if (request.method !== "GET") {
        return Promise.resolve(methodNotAllowed());
      }
      if (sessions === null) {
        return Promise.resolve(
          writeJSON(503, { error: "API server not ready" }),
        );
      }
      return Promise.resolve(handleSessionMessages(sessions, id, url));
    }
    if (parts.length === 2 && parts[1] === "subagents") {
      if (request.method !== "GET") {
        return Promise.resolve(methodNotAllowed());
      }
      if (sessions === null) {
        return Promise.resolve(
          writeJSON(503, { error: "API server not ready" }),
        );
      }
      try {
        const agents = getSessionSubAgents(sessions, id);
        return Promise.resolve(writeJSON(200, { subagents: agents }));
      } catch (err) {
        if (err === ErrSessionNotFound) {
          return Promise.resolve(writeJSON(404, errorBody(err)));
        }
        return Promise.resolve(writeJSON(500, errorBody(err)));
      }
    }
    if (
      parts.length === 4 && parts[1] === "subagents" && parts[3] === "messages"
    ) {
      if (request.method !== "GET") {
        return Promise.resolve(methodNotAllowed());
      }
      if (sessions === null) {
        return Promise.resolve(
          writeJSON(503, { error: "API server not ready" }),
        );
      }
      let agentID: string;
      try {
        agentID = decodeURIComponent(parts[2]);
      } catch {
        agentID = "";
      }
      if (agentID === "") {
        return Promise.resolve(
          writeJSON(400, { error: "invalid sub-agent ID" }),
        );
      }
      try {
        const msgs = getSessionSubAgentMessages(sessions, id, agentID);
        return Promise.resolve(writeJSON(200, { messages: msgs }));
      } catch (err) {
        if (err === ErrSessionNotFound || err === ErrSubAgentNotFound) {
          return Promise.resolve(writeJSON(404, errorBody(err)));
        }
        return Promise.resolve(writeJSON(500, errorBody(err)));
      }
    }
    if (parts.length === 2 && parts[1] === "run-events") {
      if (request.method !== "GET") {
        return Promise.resolve(methodNotAllowed());
      }
      if (sessions === null) {
        return Promise.resolve(
          writeJSON(503, { error: "API server not ready" }),
        );
      }
      try {
        const events = getSessionRunEvents(sessions, id);
        return Promise.resolve(writeJSON(200, { events }));
      } catch (err) {
        if (err === ErrSessionNotFound) {
          return Promise.resolve(writeJSON(404, errorBody(err)));
        }
        return Promise.resolve(writeJSON(500, errorBody(err)));
      }
    }
    if (parts.length === 2 && parts[1] === "capability-events") {
      if (request.method !== "GET") {
        return Promise.resolve(methodNotAllowed());
      }
      if (sessions === null) {
        return Promise.resolve(
          writeJSON(503, { error: "API server not ready" }),
        );
      }
      try {
        const events = getSessionCapabilityEvents(sessions, id);
        return Promise.resolve(writeJSON(200, { events }));
      } catch (err) {
        if (err === ErrSessionNotFound) {
          return Promise.resolve(writeJSON(404, errorBody(err)));
        }
        return Promise.resolve(writeJSON(500, errorBody(err)));
      }
    }
    if (parts.length === 3 && parts[1] === "tool-results") {
      if (request.method !== "GET") {
        return Promise.resolve(methodNotAllowed());
      }
      if (sessions === null) {
        return Promise.resolve(
          writeJSON(503, { error: "API server not ready" }),
        );
      }
      let toolCallID: string;
      try {
        toolCallID = decodeURIComponent(parts[2]);
      } catch {
        toolCallID = "";
      }
      if (toolCallID === "") {
        return Promise.resolve(
          writeJSON(400, { error: "invalid tool call ID" }),
        );
      }
      try {
        const detail = getSessionToolResult(sessions, id, toolCallID);
        if (detail === undefined || detail === null) {
          return Promise.resolve(
            writeJSON(404, { error: ErrSessionToolResultNotFound.message }),
          );
        }
        return Promise.resolve(writeJSON(200, detail));
      } catch (err) {
        if (err === ErrSessionToolResultNotFound) {
          return Promise.resolve(writeJSON(404, errorBody(err)));
        }
        return Promise.resolve(writeJSON(500, errorBody(err)));
      }
    }
    if (parts.length !== 1) {
      return Promise.resolve(writeJSON(404, { error: "not found" }));
    }
    if (request.method !== "DELETE") {
      return Promise.resolve(methodNotAllowed());
    }
    if (sessions === null || lifecycle === null) {
      return Promise.resolve(
        writeJSON(503, { error: "session lifecycle service unavailable" }),
      );
    }
    return (async () => {
      let deleted: boolean;
      try {
        deleted = await lifecycle.delete(request.signal, id);
      } catch (err) {
        if (err instanceof LifecycleConflict) {
          return writeConflict(err.code, err.message);
        }
        if (err === ErrActiveSessionIDAmbiguous) {
          return writeJSON(409, errorBody(err));
        }
        return writeJSON(500, errorBody(err));
      }
      if (!deleted) {
        return writeJSON(404, { error: "session not found" });
      }
      return writeJSON(200, { id, deleted: true });
    })();
  };
}

function newLifecycle(
  rt: ChannelRuntime,
  sessions: ActiveSessionManager,
): SessionLifecycleService {
  // Go passes the Server itself as the SessionPool; the port adapts the
  // free-function delete onto the service's one-method seam.
  const pool = sessions === null ? null : {
    deleteActiveSession: (sessionId: string): Promise<boolean> =>
      deleteActiveSession(sessions!, sessionId),
  };
  const lifecycle = new SessionLifecycleService(
    pool,
    rt.dispatcher,
    rt.sessionDir,
    rt.identityMux,
  );
  lifecycle.setEventPublisher((eventType, data) =>
    rt.publishManagementEvent(eventType, data)
  );
  return lifecycle;
}

/** handleSessionFork ports run.go's fork branch. */
async function handleSessionFork(
  rt: ChannelRuntime,
  sessions: ActiveSessionManager,
  id: string,
  request: Request,
): Promise<Response> {
  const requestID = (request.headers.get("Idempotency-Key") ?? "").trim();
  if (requestID === "") {
    return writeJSON(400, {
      error: "idempotency_key_required",
      code: "idempotency_key_required",
    });
  }
  if (requestID.length > 256) {
    return writeJSON(400, {
      error: "idempotency_key_too_long",
      code: "idempotency_key_too_long",
    });
  }
  let body: {
    atSeq?: number | null;
    titleMode?: string;
    expertId?: string | null;
  } = {};
  try {
    const text = await limitBody(request);
    if (text.trim() !== "") body = JSON.parse(text) as typeof body;
  } catch {
    return writeJSON(400, { error: "invalid JSON" });
  }
  const options: ForkOptions = {
    sourceSessionId: id,
    atSeq: body.atSeq ?? null,
    requestId: requestID,
    titleMode: body.titleMode ?? "",
  };
  let result: ForkResult;
  if (body.expertId !== undefined && body.expertId !== null) {
    if (sessions === null) {
      return writeJSON(503, { error: "server not ready" });
    }
    try {
      result = await forkSessionWithExpert(
        sessions,
        request.signal,
        id,
        {
          atSeq: options.atSeq,
          requestId: options.requestId,
          titleMode: options.titleMode,
        },
        body.expertId,
      );
    } catch (err) {
      if (
        err === ErrSessionNotFound ||
        err === ErrExpertSwitchRequiresFork ||
        isSessionExpertMutationBusy(err)
      ) {
        return writeExpertHTTPError(err);
      }
      return forkError(err);
    }
    return writeJSON(200, result);
  }
  try {
    result = runtimeFork(rt.sessionDir, options);
  } catch (err) {
    return forkError(err);
  }
  return writeJSON(200, result);
}

/** forkError maps the canonical fork error set onto the HTTP matrix. */
function forkError(err: unknown): Response {
  let status = 409;
  let code = "fork_failed";
  if (err instanceof ForkSessionNotFoundError) {
    status = 404;
    code = "session_not_found";
  } else if (err instanceof ForkInvalidBoundaryError) {
    status = 400;
    code = "invalid_boundary";
  } else if (err instanceof ForkIdempotencyRequiredError) {
    status = 400;
    code = "idempotency_key_required";
  } else if (err instanceof ForkIdempotencyTooLongError) {
    status = 400;
    code = "idempotency_key_too_long";
  } else if (err instanceof ForkIdempotencyConflictError) {
    code = "idempotency_key_conflict";
  } else if (err instanceof ForkNoCompletedTurnError) {
    code = "no_completed_turn";
  } else if (err instanceof ForkUnavailableError) {
    code = "fork_unavailable";
  } else if (err instanceof ForkSessionActiveError) {
    code = "session_active";
  } else if (err instanceof ForkUnsupportedEntryError) {
    code = "fork_unsupported_entry";
  } else if (err instanceof SessionModifiedError) {
    code = "session_modified";
  } else if (err instanceof RuntimeLeaseLostError) {
    code = "session_lease_lost";
  }
  return writeJSON(status, { error: code, code });
}

/** handleSessionBindingsByID ports run.go's bindings branch. */
async function handleSessionBindingsByID(
  _rt: ChannelRuntime,
  lifecycle: SessionLifecycleService,
  id: string,
  request: Request,
): Promise<Response> {
  switch (request.method) {
    case "POST": {
      let req: { channelType?: string; channelId?: string };
      try {
        req = JSON.parse(await limitBody(request)) as typeof req;
      } catch (err) {
        return writeJSON(400, { error: `invalid JSON: ${errString(err)}` });
      }
      try {
        await lifecycle.bind(
          request.signal,
          id,
          req.channelType ?? "",
          req.channelId ?? "",
        );
      } catch (err) {
        return writeLifecycleError(err);
      }
      return writeJSON(200, {
        sessionId: id,
        channelType: req.channelType ?? "",
        channelId: req.channelId ?? "",
      });
    }
    case "PUT": {
      let req: {
        channelType?: string;
        channelId?: string;
        fromSessionId?: string;
        toSessionId?: string;
      };
      try {
        req = JSON.parse(await limitBody(request)) as typeof req;
      } catch (err) {
        return writeJSON(400, { error: `invalid JSON: ${errString(err)}` });
      }
      try {
        await lifecycle.transfer(
          request.signal,
          req.channelType ?? "",
          req.channelId ?? "",
          req.fromSessionId ?? "",
          req.toSessionId ?? "",
        );
      } catch (err) {
        return writeLifecycleError(err);
      }
      return writeJSON(200, {
        channelType: req.channelType ?? "",
        channelId: req.channelId ?? "",
        sessionId: req.toSessionId ?? "",
      });
    }
    case "DELETE": {
      try {
        await lifecycle.unbind(request.signal, id);
      } catch (err) {
        return writeLifecycleError(err);
      }
      return writeJSON(200, {
        sessionId: id,
        channelType: "local",
        channelId: "",
      });
    }
    default:
      return methodNotAllowed();
  }
}

/** handleSessionRuntime ports run.go's runtime branch. */
async function handleSessionRuntime(
  sessions: Server,
  id: string,
  request: Request,
): Promise<Response> {
  switch (request.method) {
    case "GET": {
      const { snapshot, err } = getSessionRuntime(sessions, id);
      if (err !== null || snapshot === null) {
        if (err === ErrSessionNotFound) return writeJSON(404, errorBody(err));
        return writeJSON(500, errorBody(err));
      }
      return writeJSON(200, snapshot);
    }
    case "PATCH": {
      let patch = {} as Record<string, unknown>;
      try {
        const text = await limitBody(request);
        if (text.trim() !== "") {
          patch = JSON.parse(text) as Record<string, unknown>;
        }
      } catch (err) {
        return writeJSON(400, { error: `invalid JSON: ${errString(err)}` });
      }
      try {
        const runtime = await patchSessionRuntime(
          sessions,
          id,
          patch as never,
        );
        return writeJSON(200, runtime);
      } catch (err) {
        if (err === ErrSessionNotFound) return writeJSON(404, errorBody(err));
        if ((err as Error).message.startsWith(ErrInvalidCapability.message)) {
          return writeJSON(400, errorBody(err));
        }
        return writeJSON(500, errorBody(err));
      }
    }
    default:
      return methodNotAllowed();
  }
}

const ErrInvalidCapability = new Error("invalid capability");

/** handleSessionCapabilities ports run.go's capabilities branch. */
async function handleSessionCapabilities(
  sessions: Server,
  id: string,
  request: Request,
): Promise<Response> {
  switch (request.method) {
    case "GET": {
      try {
        const caps = getSessionCapabilities(sessions, id);
        return writeJSON(200, caps);
      } catch (err) {
        if (err === ErrSessionNotFound) return writeJSON(404, errorBody(err));
        return writeJSON(500, errorBody(err));
      }
    }
    case "PATCH": {
      let patch = {} as Record<string, unknown>;
      try {
        const text = await limitBody(request);
        if (text.trim() !== "") {
          patch = JSON.parse(text) as Record<string, unknown>;
        }
      } catch (err) {
        return writeJSON(400, { error: `invalid JSON: ${errString(err)}` });
      }
      try {
        const caps = await patchSessionCapabilities(
          sessions,
          id,
          patch as never,
        );
        return writeJSON(200, caps);
      } catch (err) {
        if (err === ErrSessionNotFound) return writeJSON(404, errorBody(err));
        if (err === ErrInvalidCapability) return writeJSON(400, errorBody(err));
        return writeJSON(500, errorBody(err));
      }
    }
    default:
      return methodNotAllowed();
  }
}

/** handleSessionMessages ports run.go's messages branch. */
function handleSessionMessages(
  sessions: Server,
  id: string,
  url: URL,
): Response {
  const beforeStr = url.searchParams.get("before") ?? "";
  const limitStr = url.searchParams.get("limit") ?? "";
  if (beforeStr !== "" || limitStr !== "") {
    let limit = Number.parseInt(limitStr, 10);
    if (Number.isNaN(limit) || limit <= 0 || limit > 200) limit = 50;
    if (beforeStr !== "") {
      const beforeSeq = Number.parseInt(beforeStr, 10);
      if (Number.isNaN(beforeSeq)) {
        return writeJSON(400, { error: "invalid before seq" });
      }
      const { entries, hasMore } = getSessionMessagesBefore(
        sessions,
        id,
        beforeSeq,
        limit,
      );
      return writeJSON(200, { messages: entries, hasMore });
    }
    const { entries, hasMore } = getSessionMessagesLatest(sessions, id, limit);
    return writeJSON(200, { messages: entries, hasMore });
  }
  const msgs = getSessionMessages(sessions, id);
  return writeJSON(200, { messages: msgs });
}

// ---------------------------------------------------------------------------
// conflict/lifecycle writers
// ---------------------------------------------------------------------------

/** writeConflict ports run.go's helper. */
export function writeConflict(code: string, message: string): Response {
  return writeJSON(409, { error: { code, message } });
}

/** writeLifecycleError ports run.go's helper. */
export function writeLifecycleError(err: unknown): Response {
  if (err === null || err === undefined) {
    return new Response(null, { status: 200 });
  }
  if (err instanceof LifecycleConflict) {
    return writeConflict(err.code, err.message);
  }
  if (
    err instanceof DOMException &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  ) {
    return writeJSON(408, errorBody(err));
  }
  return writeJSON(500, errorBody(err));
}

// ---------------------------------------------------------------------------
// channels
// ---------------------------------------------------------------------------

/** handleChannels ports run.go's receiver. */
export function handleChannels(
  rt: ChannelRuntime,
): (request: Request) => Response {
  return (request) => {
    if (request.method !== "GET") return methodNotAllowed();
    return writeJSON(200, rt.channelStatuses());
  };
}

// ---------------------------------------------------------------------------
// env (secret-safe env.json surface)
// ---------------------------------------------------------------------------

/** envViewFromConfig ports run.go's helper over the shared env config. */
export function envViewFromConfig(vars: Record<string, string>): {
  variables: { name: string; valueConfigured: boolean }[];
} {
  const names = Object.keys(vars).sort();
  return {
    variables: names.map((name) => ({ name, valueConfigured: true })),
  };
}

/**
 * handleEnv exposes the global env.json through a secret-safe contract. GET
 * only returns sorted variable names and a configured flag; PATCH applies an
 * atomic set/unset mutation. The older PUT replacement method remains accepted
 * for compatibility. Values are never echoed in responses or errors.
 */
export function handleEnv(
  _rt: ChannelRuntime,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const cfg = loadEnv();
    switch (request.method) {
      case "GET":
        return writeJSON(200, envViewFromConfig(cfg.vars ?? {}));
      case "PUT": {
        let body: { vars?: Record<string, string> | null };
        try {
          body = JSON.parse(await limitBody(request)) as typeof body;
        } catch {
          return writeJSON(400, { error: "invalid JSON" });
        }
        const vars = body.vars ?? {};
        for (const name of Object.keys(vars)) {
          try {
            validateEnvName(name);
          } catch {
            return writeJSON(400, {
              error: "invalid environment variable name",
            });
          }
        }
        cfg.vars = vars;
        try {
          saveEnv(cfg);
        } catch (err) {
          return writeJSON(500, errorBody(err));
        }
        return writeJSON(200, envViewFromConfig(cfg.vars ?? {}));
      }
      case "PATCH": {
        let req: {
          set?: { name: string; value: string }[];
          unset?: string[];
        };
        try {
          req = JSON.parse(await limitBody(request)) as typeof req;
        } catch {
          return writeJSON(400, { error: "invalid JSON" });
        }
        const set: Record<string, string> = {};
        for (const entry of req.set ?? []) {
          const name = entry.name.trim();
          try {
            validateEnvName(name);
          } catch {
            return writeJSON(400, {
              error: `invalid name ${JSON.stringify(name)}`,
            });
          }
          set[name] = entry.value;
        }
        const unset: string[] = [];
        for (const raw of req.unset ?? []) {
          const name = raw.trim();
          try {
            validateEnvName(name);
          } catch {
            return writeJSON(400, {
              error: `invalid name ${JSON.stringify(name)}`,
            });
          }
          unset.push(name);
        }
        try {
          applyEnvPatch(cfg, set, unset);
        } catch (err) {
          return writeJSON(400, errorBody(err));
        }
        return writeJSON(200, envViewFromConfig(cfg.vars ?? {}));
      }
      default:
        return methodNotAllowed();
    }
  };
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

/** handleSettings ports run.go's receiver. */
export function handleSettings(
  rt: ChannelRuntime,
  srv: Server | null,
): (request: Request) => Promise<Response> {
  return async (request) => {
    switch (request.method) {
      case "GET": {
        try {
          const settings = loadSettings();
          return writeJSON(200, settings);
        } catch (err) {
          return writeJSON(500, errorBody(err));
        }
      }
      case "PUT": {
        let settings;
        try {
          settings = await request.json();
        } catch (err) {
          return writeJSON(400, errorBody(err));
        }
        try {
          saveGlobalSettings(settings);
        } catch (err) {
          return writeJSON(500, errorBody(err));
        }
        // Keep the cached knowledge-base service's settings snapshot current so
        // a later scan uses the new Indexer provider/model without losing its
        // in-flight background job registry.
        rt.knowledge.refreshKnowledgeServiceSettings(settings);
        if (srv !== null) {
          try {
            await srv.applySettings(settings);
          } catch (err) {
            console.error(`serve: apply settings: ${errString(err)}`);
            return writeJSON(500, errorBody(err));
          }
        }
        if (rt.dispatcher !== null) {
          try {
            rt.dispatcher.applySettings(settings);
          } catch (err) {
            console.error(`serve: apply channel settings: ${errString(err)}`);
            return writeJSON(500, errorBody(err));
          }
        }
        return writeJSON(200, settings);
      }
      default:
        return methodNotAllowed();
    }
  };
}

// ---------------------------------------------------------------------------
// memory
// ---------------------------------------------------------------------------

/** handleMemory ports run.go's receiver over the shared memory store. */
export function handleMemory(
  rt: ChannelRuntime,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const cfg = rt.configSnapshot();
    if (cfg === null || !cfg.features.memory) {
      switch (request.method) {
        case "GET":
          return writeJSON(200, { enabled: false, content: "" });
        case "PUT":
          return writeJSON(403, { error: "memory is disabled" });
        default:
          return methodNotAllowed();
      }
    }
    const workDir = apiWorkDirOf(cfg);
    const store = new MemoryStore(cfg.memory.path, workDir);
    switch (request.method) {
      case "GET": {
        try {
          const { content, path, source } = store.read();
          return writeJSON(200, { enabled: true, path, source, content });
        } catch (err) {
          return writeJSON(500, errorBody(err));
        }
      }
      case "PUT": {
        let body: { content?: string };
        try {
          body = await request.json() as { content?: string };
        } catch {
          return writeJSON(400, { error: "invalid JSON body" });
        }
        try {
          store.writeAll(body.content ?? "");
          const { content, path, source } = store.read();
          return writeJSON(200, { enabled: true, path, source, content });
        } catch (err) {
          return writeJSON(500, errorBody(err));
        }
      }
      default:
        return methodNotAllowed();
    }
  };
}

/** apiWorkDirOf is Go's cfg.API.GetWorkDir over the serve config. */
function apiWorkDirOf(cfg: ServeConfig): string {
  return cfg.api.workingDir !== ""
    ? cfg.api.workingDir
    : cfg.api.defaultWorkDir;
}

// ---------------------------------------------------------------------------
// web UI
// ---------------------------------------------------------------------------

/** handleWebUI ports run.go's receiver over the shared SPA handler. */
export function handleWebUI(
  rt: ChannelRuntime,
): (request: Request) => Response {
  return (request) => {
    const cfg = rt.configSnapshot();
    if (cfg === null || !cfg.webUI.enabled) {
      return new Response("404 page not found\n", {
        status: 404,
        headers: new Headers({
          "content-type": "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff",
        }),
      });
    }
    return createWebUIHandler({ dir: cfg.webUI.dir })(request);
  };
}

// ---------------------------------------------------------------------------
// browse / select-directory
// ---------------------------------------------------------------------------

/** handleBrowse ports run.go's receiver. */
export function handleBrowse(
  rt: ChannelRuntime,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "GET") return methodNotAllowed();
    const url = new URL(request.url);
    let path = url.searchParams.get("path") ?? "";
    if (Deno.build.os === "windows" && path === WINDOWS_DRIVE_LIST_ROOT) {
      return writeJSON(200, windowsDriveListResponse());
    }
    if (path === "") {
      path = browseDefaultDir(rt);
      const fallback = nearestExistingBrowseDir(path);
      if (fallback !== "") path = fallback;
    }
    let abs: string;
    let parent: string;
    try {
      [abs, parent] = resolveBrowseDir(rt, path);
    } catch (err) {
      return writeJSON(403, errorBody(err));
    }
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const e of Deno.readDir(abs)) entries.push(e);
    } catch (err) {
      return writeJSON(400, errorBody(err));
    }
    const dirs = [];
    for (const e of entries) {
      if (!e.isDirectory) continue;
      if (e.name.startsWith(".")) continue;
      dirs.push({ name: e.name, path: join(abs, e.name), isDir: true });
    }
    return writeJSON(200, {
      path: abs,
      parent,
      entries: dirs,
      selectable: true,
    });
  };
}

/** handleSelectDirectory ports run.go's receiver. */
export function handleSelectDirectory(
  rt: ChannelRuntime,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "POST") return methodNotAllowed();
    let body: { defaultPath?: string } = {};
    try {
      const text = await request.text();
      if (text.trim() !== "") body = JSON.parse(text) as typeof body;
    } catch {
      return writeJSON(400, { error: "invalid JSON body" });
    }
    let defaultPath = body.defaultPath ?? "";
    if (defaultPath === "") defaultPath = browseDefaultDir(rt);
    defaultPath = nearestExistingBrowseDir(defaultPath);
    const picker = rt.nativeDirectoryPicker ?? openNativeDirectoryPicker;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);
    let selected: string;
    try {
      selected = await picker(controller.signal, defaultPath);
    } catch (err) {
      if (err === errNativeDirectoryPickerUnavailable) {
        return writeJSON(501, errorBody(err));
      }
      if (
        err instanceof DOMException &&
        (err.name === "AbortError" || err.name === "TimeoutError")
      ) {
        return writeJSON(408, {
          error: "native directory picker timed out or was canceled",
        });
      }
      return writeJSON(500, errorBody(err));
    } finally {
      clearTimeout(timer);
    }
    if (selected.trim() === "") {
      return writeJSON(200, { canceled: true, path: "" });
    }
    try {
      const [abs] = resolveBrowseDir(rt, selected);
      return writeJSON(200, { canceled: false, path: abs });
    } catch (err) {
      return writeJSON(403, errorBody(err));
    }
  };
}

/** browseDefaultDir ports run.go's receiver. */
export function browseDefaultDir(rt: ChannelRuntime): string {
  const cfg = rt.configSnapshot();
  if (cfg !== null) return apiWorkDirOf(cfg);
  try {
    const cwd = Deno.cwd();
    if (cwd !== "") return cwd;
  } catch {
    // fall through
  }
  return ".";
}

/** nearestExistingBrowseDir ports run.go's helper. */
export function nearestExistingBrowseDir(path: string): string {
  let abs: string;
  try {
    abs = resolve(path);
  } catch {
    return "";
  }
  abs = normalize(abs);
  for (;;) {
    try {
      const real = Deno.realPathSync(abs);
      try {
        if (Deno.statSync(real).isDirectory) return normalize(real);
      } catch {
        // fall through to the parent walk
      }
    } catch {
      // EvalSymlinks failure: keep walking the parents
    }
    const parent = dirname(abs);
    if (parent === abs) return "";
    abs = parent;
  }
}

/** resolveBrowseDir ports run.go's receiver. */
export function resolveBrowseDir(
  rt: ChannelRuntime,
  path: string,
): [string, string] {
  let abs: string;
  try {
    abs = resolve(path);
  } catch (err) {
    throw new Error(`invalid path: ${errString(err)}`);
  }
  abs = normalize(abs);
  let realAbs: string;
  try {
    realAbs = normalize(Deno.realPathSync(abs));
  } catch (err) {
    throw new Error(`invalid path: ${errString(err)}`);
  }
  const roots = browseAllowedRoots(rt, realAbs);
  if (!pathWithinAnyRoot(realAbs, roots)) {
    throw new Error(
      `directory ${JSON.stringify(path)} is not in allowed browse roots`,
    );
  }
  // Windows volume roots (C:\) share no common parent; the virtual drive
  // list acts as their parent so browsing can switch between volumes.
  if (Deno.build.os === "windows" && isWindowsDriveRoot(realAbs)) {
    return [realAbs, WINDOWS_DRIVE_LIST_ROOT];
  }
  let parent = dirname(realAbs);
  if (parent === realAbs || !pathWithinAnyRoot(parent, roots)) {
    parent = realAbs;
  }
  return [realAbs, parent];
}

/** browseAllowedRoots ports run.go's receiver. */
export function browseAllowedRoots(
  rt: ChannelRuntime,
  path: string,
): string[] {
  const cfg = rt.configSnapshot();
  if (cfg === null) {
    let cwd: string;
    try {
      cwd = Deno.cwd();
    } catch (err) {
      throw new Error(`resolve working directory: ${errString(err)}`);
    }
    return [normalize(cwd)];
  }
  let configured: string[];
  if (cfg.api.allowedWorkDirs !== undefined) {
    configured = [...cfg.api.allowedWorkDirs];
  } else if (cfg.security.allowedWorkDirs.length > 0) {
    configured = [...cfg.security.allowedWorkDirs];
  } else {
    configured = browseFilesystemRoots(path);
  }
  if (configured.length === 0) {
    throw new Error("directory browsing is disabled");
  }
  const roots: string[] = [];
  for (const root of configured) {
    if (root === "") continue;
    let abs: string;
    try {
      abs = resolve(root);
    } catch (err) {
      throw new Error(
        `invalid browse root ${JSON.stringify(root)}: ${errString(err)}`,
      );
    }
    abs = normalize(abs);
    try {
      abs = normalize(Deno.realPathSync(abs));
    } catch {
      // Go keeps the unresolved path when EvalSymlinks fails.
    }
    roots.push(abs);
  }
  if (roots.length === 0) {
    throw new Error("directory browsing is disabled");
  }
  return roots;
}

// --- Windows drive enumeration (ported; inert off-Windows) -------------------

/**
 * windowsDriveListRoot is a virtual browse path that lists every available
 * Windows drive root. Drive roots have no common parent directory, so
 * regular parent navigation cannot switch between drives.
 */
const WINDOWS_DRIVE_LIST_ROOT = "\\";

/** volumeName is the filepath.VolumeName equivalent for drive/UNC prefixes. */
function volumeName(path: string): string {
  const drive = /^[A-Za-z]:/.exec(path);
  if (drive) return drive[0];
  if (path.startsWith("\\\\")) {
    const idx = path.indexOf("\\", 2);
    if (idx > 2) return path.slice(0, idx);
    return path;
  }
  return "";
}

function isWindowsDriveRoot(path: string): boolean {
  const volume = volumeName(path);
  return volume.length === 2 && volume[1] === ":" &&
    path === normalize(volume + "\\");
}

function windowsDriveRoots(): string[] {
  const roots: string[] = [];
  if (Deno.build.os !== "windows") return roots;
  for (let letter = 65; letter <= 90; letter++) {
    const root = String.fromCharCode(letter) + ":\\";
    try {
      if (Deno.statSync(root).isDirectory) roots.push(root);
    } catch {
      // absent drive
    }
  }
  return roots;
}

function windowsDriveListResponse(): Record<string, unknown> {
  const entries: Record<string, unknown>[] = [];
  for (const root of windowsDriveRoots()) {
    entries.push({ name: root, path: root, isDir: true });
  }
  return {
    path: WINDOWS_DRIVE_LIST_ROOT,
    parent: WINDOWS_DRIVE_LIST_ROOT,
    entries,
    selectable: false,
  };
}

/** browseFilesystemRoots ports run.go's helper. */
export function browseFilesystemRoots(path: string): string[] {
  let abs: string;
  try {
    abs = resolve(path);
  } catch {
    abs = "/";
  }
  abs = normalize(abs);
  const volume = volumeName(abs);
  if (Deno.build.os === "windows") {
    const roots = windowsDriveRoots();
    // A UNC share is its own volume. It cannot be enumerated alongside
    // drive letters, so retain the current share as an additional root.
    if (volume.length > 2) {
      const uncRoot = normalize(volume + "\\");
      if (!pathWithinAnyRoot(uncRoot, roots)) roots.push(uncRoot);
    }
    if (roots.length > 0) return roots;
  }
  if (volume !== "") return [normalize(volume + "\\")];
  return ["/"];
}

/** pathWithinAnyRoot ports run.go's filepath.Rel-based containment check. */
export function pathWithinAnyRoot(path: string, roots: string[]): boolean {
  for (const root of roots) {
    const rel = relative(root, path);
    if (rel !== ".." && !rel.startsWith(".." + SEPARATOR)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

/**
 * serveRoutes ports run.go's routes() receiver: the WebUI management route
 * table registered as openaiapi.Run's ExtraRoutes projection.
 */
export function serveRoutes(
  rt: ChannelRuntime,
  configPath: string,
): (srv: Server, mux: ServeMux) => void {
  return (srv, mux) => {
    const sessions = activeSessionManagerFromAPI(srv);
    mux.handle("/api/status", handleStatus(rt, sessions));
    mux.handle("/api/serve/config", handleServeConfig(rt, configPath, srv));
    mux.handle(
      "/api/serve/config/channels/",
      handleChannelConfigPatch(rt, configPath, srv),
    );
    mux.handle("/api/capabilities", handleCapabilities(rt, sessions));
    mux.handle("/api/session-id", handleSessionID(rt, sessions));
    mux.handle("/api/sessions", handleSessions(rt, sessions));
    mux.handle("/api/sessions/", handleSessionByID(rt, sessions));
    mux.handle("/api/experts", handleExperts(rt, sessions));
    mux.handle("/api/experts/", handleExperts(rt, sessions));
    mux.handle(
      "/api/knowledge-bases",
      (req) => rt.knowledge.handleKnowledgeBases(req),
    );
    mux.handle(
      "/api/knowledge-bases/",
      (req) => rt.knowledge.handleKnowledgeBases(req),
    );
    mux.handle("/api/projects", handleProjects(rt));
    mux.handle("/api/projects/", (req) => handleProjectByID(rt, req));
    mux.handle("/api/stats/", handleStats(rt));
    mux.handle("/api/settings", handleSettings(rt, srv));
    mux.handle("/api/mcp", (req) => handleMCPConfig(req));
    mux.handle("/api/env", handleEnv(rt));
    mux.handle("/api/memory", handleMemory(rt));
    mux.handle("/api/cron", (req) => rt.cron.handleCron(req));
    mux.handle("/api/cron/", (req) => rt.cron.handleCronByID(req));
    mux.handle("/api/channels", handleChannels(rt));
    mux.handle("/api/session-tools/catalog", handleSessionToolCatalog(rt));
    mux.handle("/api/session-bindings", handleSessionBindings(rt));
    mux.handle("/api/channels/wechat/login/qr", handleWechatLoginQR(rt));
    mux.handle("/api/channels/wechat/login", handleWechatLogin(rt, configPath));
    mux.handle("/ws/runs", (req) => runWebSocketHandler(srv, req));
    mux.handle(
      "/ws/logs",
      createLogsWebSocketHandler({
        logHub: rt.logHub,
        statusSnapshot: () => statusSnapshot(rt, sessions),
      }),
    );
    mux.handle("/api/browse", handleBrowse(rt));
    mux.handle("/api/select-directory", handleSelectDirectory(rt));
    mux.handle("/api/skillhub/", (req) => handleSkillHub(srv, req));
    mux.handle("/", handleWebUI(rt));
  };
}
