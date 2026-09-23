// internal/acp/acp.go (`Run`, `resolveACPModelSelection`,
// `resolveACPProviderSelection`).
//
// `runACP` wires the long-lived ACP process: settings/provider preflight, the
// lease-first RecoveryCoordinator, runtime-lease/database-rebuild watches, the
// provider catalog, sandbox manager, shared context resources, the shared
// session runtime + optional agent manager, the management-plane cron runtime,
// and finally the newline-delimited JSON-RPC read/dispatch loop over stdin.
//
// Deviations from Go: the mutex drops on the single-threaded event loop;
// `context.Context` maps to `AbortSignal`/`AbortController`; `bufio.Reader`
// maps to the existing `ACPLineReader` over `Deno.stdin.readable`; and Go's
// synchronous handlers are already `async` on the server, so the switch simply
// awaits the prompt/session ones. Startup failures before `initialize` print
// the machine-readable `OPENSAC_ACP_ERROR` line exactly like Go.

import { AcpServer, type AcpServerSink } from "./server.ts";
import { ACPLineReader, EmptyMessageError, validRPCID } from "./wire.ts";
import { RPCError } from "../mcp/rpc.ts";
import { handleManageRequest } from "./manage.ts";
import { stopManageCron } from "./manage_knowledge_bases.ts";
import {
  ACPStartupError,
  classifyACPStartupError,
  startupErrorFromDoctor,
  writeACPStartupError,
} from "./support.ts";
import {
  isACPArtifactEnabled,
  loadAllow,
  loadSettings,
  loadSettingsFor,
  type Settings,
  setVerbose,
} from "../config/mod.ts";
import { validateProvider } from "../doctor/doctor.ts";
import { create, parseQualifiedModel } from "../provider/factory/mod.ts";
import { normalizeThinkingLevel } from "../provider/types.ts";
import { createManager, Level } from "../sandbox/sandbox.ts";
import {
  createAgentManager,
  loadContextResources,
  RecoveryCoordinator,
  SessionRuntime,
  SOURCE_ACP,
} from "../agentruntime/mod.ts";
import { sandboxSettingsOptions } from "../config/settings.ts";
import { subscribeRuntimeLeaseNotifications } from "../session/runtime_lease_bus.ts";
import { watchDatabaseRebuilds } from "../session/database_recovery_notice.ts";
import { getSessionDir } from "../config/mod.ts";
import { current as appversionCurrent } from "../version/version.ts";
import { debugLogf } from "../provider/debug.ts";
import { startDebugServer } from "../debugendpoints/debugendpoints.ts";
import { encodeBase64 } from "@std/encoding/base64";
import { acpStructuredRPCError } from "./projection.ts";
import type { ACPRPCRequest } from "./wire.ts";
import type { Provider } from "../provider/provider.ts";

/** Process-level ACP options, ported from `acp.RunOptions`. */
export interface RunOptions {
  version?: string;
  provider?: string;
  model?: string;
  mode?: string;
  thinking?: string;
  sandbox?: boolean;
  verbose?: boolean;
  debug?: boolean;
  multiAgent?: boolean;
  delegate?: boolean;
  workflows?: boolean;
  webSearch?: boolean;
  browser?: boolean;
  artifact?: boolean;
  /** Approval/question deadlines in milliseconds (Go durations). */
  permissionTimeoutMs?: number;
  questionTimeoutMs?: number;
}

/** ACP transport resources that may be replaced by tests. */
export interface RunTransport {
  reader: ACPLineReader;
  sink: AcpServerSink;
}

/** Synchronous stdout sink matching Go's `os.Stdout` line writes. */
class StdoutSink implements AcpServerSink {
  write(data: string): void {
    Deno.stdout.writeSync(new TextEncoder().encode(data));
  }
}

/** Default transport: newline-delimited JSON-RPC over stdin/stdout. */
export function stdioTransport(): RunTransport {
  return {
    reader: new ACPLineReader(Deno.stdin.readable),
    sink: new StdoutSink(),
  };
}

/**
 * Applies the Harbor requested-model override while keeping explicit CLI
 * selections fail-closed when they disagree.
 */
export function resolveACPModelSelection(
  opts: RunOptions,
  requested: string,
  requestedSet: boolean,
): { providerName: string; modelID: string } {
  let providerName = (opts.provider ?? "").trim();
  let modelID = (opts.model ?? "").trim();
  if (!requestedSet) return { providerName, modelID };
  const parsed = parseQualifiedModel(requested);
  if (parsed === undefined) {
    throw new Error(
      `HARBOR_ACP_REQUESTED_MODEL ${
        JSON.stringify(requested)
      } must use provider/model format`,
    );
  }
  const requestedProvider = parsed.providerName;
  const requestedModel = parsed.modelID;
  if (
    providerName !== "" &&
    !providerName.toLowerCase().includes(requestedProvider.toLowerCase()) &&
    !requestedProvider.toLowerCase().includes(providerName.toLowerCase())
  ) {
    throw new Error(
      `HARBOR_ACP_REQUESTED_MODEL provider ${
        JSON.stringify(requestedProvider)
      } conflicts with configured provider ${JSON.stringify(providerName)}`,
    );
  }
  if (
    modelID !== "" &&
    modelID.toLowerCase() !== requestedModel.toLowerCase()
  ) {
    throw new Error(
      `HARBOR_ACP_REQUESTED_MODEL model ${
        JSON.stringify(requestedModel)
      } conflicts with configured model ${JSON.stringify(modelID)}`,
    );
  }
  providerName = requestedProvider;
  modelID = requestedModel;
  return { providerName, modelID };
}

/**
 * Applies request precedence before the startup check, falling back to the
 * configured defaults only when the caller selected nothing.
 */
export function resolveACPProviderSelection(
  settings: Settings,
  opts: RunOptions,
  requested: string,
  requestedSet: boolean,
): { providerName: string; modelID: string } {
  const { providerName, modelID } = resolveACPModelSelection(
    opts,
    requested,
    requestedSet,
  );
  if (providerName !== "") return { providerName, modelID };
  return {
    providerName: (settings.defaultProvider ?? "").trim(),
    modelID: modelID !== "" ? modelID : (settings.defaultModel ?? "").trim(),
  };
}

/**
 * Runs the ACP stdio server. Returns at clean EOF. Startup failures before
 * `initialize` are classified and printed as `OPENSAC_ACP_ERROR`.
 */
export async function runACP(
  opts: RunOptions = {},
  transport: RunTransport = stdioTransport(),
): Promise<void> {
  let initialized = false;
  try {
    initialized = await runACPInner(opts, transport);
  } catch (error) {
    if (!initialized) writeACPStartupError(error);
    throw error;
  }
}

async function runACPInner(
  opts: RunOptions,
  transport: RunTransport,
): Promise<boolean> {
  setVerbose(opts.verbose === true || opts.debug === true);
  if (opts.debug === true) {
    Deno.env.set("VIBECODING_DEBUG", "1");
    startDebugServer((msg) =>
      Deno.stderr.writeSync(new TextEncoder().encode(msg))
    );
  }

  const cwd = Deno.cwd();
  let info: Deno.FileInfo;
  try {
    info = Deno.statSync(cwd);
  } catch (error) {
    throw new ACPStartupError({
      code: "cwd_invalid",
      message: "working directory is unavailable",
      fix: "Start opensac from an existing directory",
      cause: error,
    });
  }
  if (!info.isDirectory) {
    throw new ACPStartupError({
      code: "cwd_invalid",
      message: "working directory is unavailable",
      fix: "Start opensac from an existing directory",
      cause: new Error(
        `working directory ${JSON.stringify(cwd)} is not a directory`,
      ),
    });
  }

  const runVersion = (opts.version ?? "").trim() || appversionCurrent();

  let preflightSettings: Settings;
  try {
    preflightSettings = loadSettingsFor(cwd);
  } catch (error) {
    throw new ACPStartupError({
      code: "config_invalid",
      message: "settings could not be loaded",
      fix: "Fix settings.json syntax",
      cause: error,
    });
  }

  const requested = Deno.env.get("HARBOR_ACP_REQUESTED_MODEL");
  const requestedSet = requested !== undefined;
  let providerName: string;
  let modelID: string;
  try {
    ({ providerName, modelID } = resolveACPProviderSelection(
      preflightSettings,
      opts,
      requested ?? "",
      requestedSet,
    ));
  } catch (error) {
    throw classifyACPStartupError(error);
  }
  const providerChecks = validateProvider(
    preflightSettings,
    providerName,
    modelID,
  );
  if (providerChecks.length > 0) {
    const startup = startupErrorFromDoctor({
      ok: false,
      version: runVersion,
      summary: "",
      checks: providerChecks,
    });
    if (startup !== null) throw startup;
  }

  let settings: Settings;
  try {
    settings = loadSettings();
  } catch (error) {
    throw new ACPStartupError({
      code: "config_invalid",
      message: "settings could not be loaded",
      fix: "Fix settings.json syntax",
      cause: error,
    });
  }

  // Long-running Runtime host: lease-first recovery coordinator.
  const recoveryAbort = new AbortController();
  const recoveryCoordinator = new RecoveryCoordinator(
    getSessionDir(settings),
    {},
  );
  await recoveryCoordinator.start(recoveryAbort.signal);
  const stopRecovery = () => {
    recoveryAbort.abort();
    void recoveryCoordinator.stop();
  };

  if (opts.webSearch === true) {
    if (settings.webSearch) settings.webSearch.enabled = true;
  }

  const srv = new AcpServer();
  srv.settings = settings;
  srv.allow = loadAllow();
  srv.cwd = cwd;
  srv.version = runVersion;
  srv.multiAgent = opts.multiAgent === true;
  srv.delegate = opts.delegate === true;
  srv.workflows = opts.workflows === true;
  srv.browser = opts.browser === true;
  srv.artifact = opts.artifact === true || isACPArtifactEnabled(settings);
  srv.artifactOverride = opts.artifact === true;
  srv.reader = transport.reader;
  srv.sink = transport.sink;
  srv.permissionTimeoutMs = opts.permissionTimeoutMs ?? 0;
  srv.questionTimeoutMs = opts.questionTimeoutMs ?? 0;

  const stopLeaseNotifications = subscribeRuntimeLeaseNotifications(
    (notification) => {
      switch (notification.type) {
        case "acquired":
        case "released":
        case "lost":
        case "state_changed":
          srv.notifyExternalRunStatus(notification.sessionId ?? "");
          break;
      }
    },
  );
  const stopDatabaseWatch = watchDatabaseRebuilds(null);

  // LIFO: cron scheduler stops before session runtimes so in-flight job runs
  // cancel first; recovery coordinator and watches unwind last.
  const cleanup = async () => {
    stopManageCron(srv);
    await srv.shutdownAllSessionRuntimes();
    stopDatabaseWatch();
    stopLeaseNotifications();
    stopRecovery();
  };

  const enabled = true;
  let primary: {
    provider: Provider;
    model: import("../provider/types.ts").Model;
  };
  try {
    primary = create(settings, providerName, modelID, {
      builtinAnthropicCacheControl: enabled,
      requireModel: true,
    });
  } catch (error) {
    await cleanup();
    throw classifyACPStartupError(error);
  }
  srv.p = primary.provider;
  srv.providerName = providerName !== ""
    ? providerName
    : (settings.defaultProvider ?? "");
  srv.m = primary.model;
  srv.providers = { [srv.providerName]: primary.provider };

  // Build the provider catalog once; unusable providers are omitted.
  for (const name of Object.keys(settings.providers ?? {})) {
    if (name.toLowerCase() === srv.providerName.toLowerCase()) continue;
    try {
      const candidate = create(settings, name, "", {
        builtinAnthropicCacheControl: enabled,
        requireModel: true,
      });
      srv.providers[name] = candidate.provider;
    } catch (error) {
      debugLogf(`ACP provider %s unavailable: %v`, name, error);
    }
  }

  srv.mode = opts.mode || settings.defaultMode || "yolo";
  srv.thinkingLevel = normalizeThinkingLevel(
    opts.thinking || settings.defaultThinkingLevel || "",
  );

  const sbMgr = createManager(
    cwd,
    sandboxSettingsOptions(
      settings.sandbox ?? {
        enabled: false,
        level: "",
        allowNetwork: false,
      },
    ),
  );
  const sandboxEnabled = opts.sandbox === true ||
    (settings.sandbox?.enabled ?? false);
  if (!sandboxEnabled) {
    sbMgr.setLevel(Level.None);
  } else {
    const level = settings.sandbox?.level === "strict"
      ? Level.Strict
      : Level.Standard;
    sbMgr.setLevel(level);
    const fallback = sbMgr.fallbackError();
    if (fallback !== undefined) {
      Deno.stderr.writeSync(
        new TextEncoder().encode(
          `Warning: sandbox unavailable; using direct execution: ${
            fallback instanceof Error ? fallback.message : fallback
          }\n`,
        ),
      );
    }
  }
  srv.sbMgr = sbMgr;

  const resources = await loadContextResources(
    settings,
    cwd,
    opts.workflows === true,
    opts.browser === true,
  );
  srv.skillsMgr = resources.skillsMgr;
  srv.extraContext = resources.extraContext;
  srv.ruleContent = resources.ruleContent;

  srv.runtime = new SessionRuntime({
    source: SOURCE_ACP,
    entrySource: SOURCE_ACP,
    workDir: cwd,
    sandboxMgr: sbMgr,
    skillsMgr: resources.skillsMgr,
    extraContext: srv.extraContext,
    ruleContent: srv.ruleContent,
    providers: srv.providers,
    artifactEnabled: srv.artifact,
  });

  if (
    opts.multiAgent === true || opts.delegate === true ||
    opts.workflows === true
  ) {
    srv.agentMgr = createAgentManager({
      runtime: srv.runtime,
      provider: primary.provider,
      model: primary.model,
      settings,
      providerName: srv.providerName,
      allow: srv.allow,
      multiAgentEnabled: true,
      delegateEnabled: opts.delegate === true,
      workflowsEnabled: opts.workflows === true,
    });
  }

  // Resume persisted knowledge-base schedules; a setup failure must not block
  // the ACP transport.
  try {
    ensureManageCronForRun(srv);
  } catch (error) {
    console.error(
      `[acp] start management cron runtime: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }

  await dispatchLoop(srv);
  await cleanup();
  return srv.acpInitialized();
}

/** Lazily starts the management cron runtime. */
function ensureManageCronForRun(srv: AcpServer): {
  scheduler: unknown;
  store: unknown;
} {
  return manageCronModule.ensureManageCron(srv);
}

import * as manageCronModule from "./manage_knowledge_bases.ts";

// ─── stdio dispatch ─────────────────────────────────────────────────────────

/** The newline-delimited request dispatch loop. Exported for focused tests. */
export async function dispatchLoop(srv: AcpServer): Promise<void> {
  while (true) {
    let req: ACPRPCRequest | null;
    try {
      req = await srv.readRequest();
    } catch (error) {
      if (error instanceof EmptyMessageError) continue;
      srv.writeMessage({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error" },
      });
      continue;
    }
    if (req === null) return; // EOF

    if (req.jsonrpc !== "2.0" || !validRPCID(req.idRaw)) {
      let idRaw = req.idRaw;
      if (!validRPCID(idRaw) || ((idRaw ?? "").trim() === "")) {
        idRaw = "null";
      }
      if ((req.idRaw ?? "") !== "" || req.jsonrpc !== "2.0") {
        srv.writeResponse(
          idRaw,
          null,
          new RPCError(-32600, "invalid request"),
        );
      }
      continue;
    }

    if (req.method === "" && (req.idRaw ?? "") !== "") {
      srv.deliverResponse(req.idRaw, req.result, req.error);
      continue;
    }
    if (req.method === "") continue;
    if (req.method !== "initialize" && !srv.acpInitialized()) {
      if ((req.idRaw ?? "") !== "") {
        srv.writeResponse(
          req.idRaw,
          null,
          new RPCError(-32600, "initialize must be called first"),
        );
      }
      continue;
    }

    await dispatchMethod(srv, req);
  }
}

/** Dispatches one validated request. Exported for focused tests. */
export async function dispatchMethod(
  srv: AcpServer,
  req: ACPRPCRequest,
): Promise<void> {
  switch (req.method) {
    case "initialize":
      srv.handleInitialize(req);
      return;
    case "opensac/doctor":
      srv.handleDoctor(req);
      return;
    case "session/new":
      await srv.handleNewSession(req);
      return;
    case "session/load":
      await srv.handleLoadSession(req);
      return;
    case "opensac/session/history":
      srv.handleSessionHistory(req);
      return;
    case "opensac/session/draft-config-options":
      srv.handleDraftConfigOptions(req);
      return;
    case "session/resume":
      await srv.handleResumeSession(req);
      return;
    case "session/fork":
      await srv.handleForkSession(req);
      return;
    case "session/prompt":
      await srv.handlePrompt(req);
      return;
    case "session/cancel":
      srv.handleCancel(req);
      return;
    case "$/cancel_request":
      srv.handleCancelRequest(req);
      return;
    case "session/close":
      await srv.handleCloseSession(req);
      return;
    case "opensac/session/delete":
    case "session/delete":
      srv.handleDeleteSession(req);
      return;
    case "opensac/session/setTitle":
      srv.handleSetSessionTitle(req);
      return;
    case "opensac/session/setWorkDir":
      await srv.handleSetSessionWorkDir(req);
      return;
    case "opensac/session/setMeta":
      srv.handleSetSessionMeta(req);
      return;
    case "opensac/projects/list":
      srv.handleProjectsList(req);
      return;
    case "opensac/projects/create":
      srv.handleProjectsCreate(req);
      return;
    case "opensac/projects/rename":
      srv.handleProjectsRename(req);
      return;
    case "opensac/projects/delete":
      srv.handleProjectsDelete(req);
      return;
    case "opensac/workspace/extend":
      srv.handleWorkspaceExtend(req);
      return;
    case "opensac/attachment/fetch":
      handleAttachmentFetch(srv, req);
      return;
    case "opensac/attachment/list":
      srv.handleAttachmentList(req);
      return;
    case "session/list":
      srv.handleListSessions(req);
      return;
    case "opensac/session/listAll":
      srv.handleListAllSessions(req);
      return;
    case "session/set_config_option":
      await srv.handleSetConfigOption(req);
      return;
    case "session/set_mode":
      await srv.handleSetMode(req);
      return;
    default:
      if (req.method.startsWith("opensac/manage/")) {
        handleManageRequest(srv, req);
      } else if ((req.idRaw ?? "") !== "") {
        srv.writeResponse(
          req.idRaw,
          null,
          new RPCError(-32601, "method not found"),
        );
      }
  }
}

// ─── attachment fetch ───────────────────────────────────────────────────────

interface AttachmentFetchRequest {
  sessionId?: unknown;
  attachmentId?: unknown;
}

const maxRequestBytes = 10 << 20;

/** Serves `opensac/attachment/fetch`. Exported for focused tests. */
export function handleAttachmentFetch(
  srv: AcpServer,
  req: ACPRPCRequest,
): void {
  const input = (req.params ?? {}) as AttachmentFetchRequest;
  if (
    typeof input.sessionId !== "string" || input.sessionId.trim() === "" ||
    typeof input.attachmentId !== "string" || input.attachmentId.trim() === ""
  ) {
    srv.writeResponse(
      req.idRaw,
      null,
      new RPCError(-32602, "sessionId and attachmentId are required"),
    );
    return;
  }
  const sessionID = input.sessionId.trim();
  const attachmentID = input.attachmentId.trim();

  let service: ReturnType<AcpServer["attachmentService"]>;
  try {
    service = srv.attachmentService();
  } catch (error) {
    srv.writeResponse(
      req.idRaw,
      null,
      attachmentFetchRPCError(
        "attachment_unavailable",
        error instanceof Error ? error.message : String(error),
        null,
      ),
    );
    return;
  }
  void (async () => {
    let opened: {
      record: import("../agentruntime/attachment.ts").SessionAttachment;
      file: Deno.FsFile;
    };
    try {
      opened = await service.Open(sessionID, attachmentID);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let code = "attachment_unavailable";
      let publicMessage = `open attachment ${attachmentID}: ${message}`;
      if (message.includes("not found")) {
        code = "attachment_not_found";
        publicMessage =
          `attachment ${attachmentID} is not available for session ${sessionID}`;
      } else if (message.includes("expired")) {
        code = "attachment_expired";
        publicMessage = `attachment ${attachmentID} has expired`;
      }
      srv.writeResponse(
        req.idRaw,
        null,
        attachmentFetchRPCError(code, publicMessage, null),
      );
      return;
    }
    const { record, file } = opened;
    try {
      if (record.bytes > maxRequestBytes) {
        srv.writeResponse(
          req.idRaw,
          null,
          attachmentFetchRPCError(
            "attachment_too_large",
            `attachment ${attachmentID} exceeds the ${maxRequestBytes} byte fetch limit`,
            { size: record.bytes, maxBytes: maxRequestBytes },
          ),
        );
        return;
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      const buf = new Uint8Array(64 * 1024);
      while (total <= maxRequestBytes) {
        const n = await file.read(buf);
        if (n === null) break;
        chunks.push(buf.slice(0, n));
        total += n;
      }
      if (total > maxRequestBytes) {
        srv.writeResponse(
          req.idRaw,
          null,
          attachmentFetchRPCError(
            "attachment_too_large",
            `attachment ${attachmentID} exceeds the ${maxRequestBytes} byte fetch limit`,
            { size: total, maxBytes: maxRequestBytes },
          ),
        );
        return;
      }
      const content = concatChunks(chunks, total);
      srv.writeResponse(req.idRaw, {
        filename: record.filename,
        mediaType: record.mediaType,
        size: record.bytes,
        contentBase64: encodeBase64(content),
      }, null);
    } catch (error) {
      srv.writeResponse(
        req.idRaw,
        null,
        attachmentFetchRPCError(
          "attachment_unavailable",
          `read attachment ${attachmentID}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          null,
        ),
      );
    } finally {
      try {
        file.close();
      } catch {
        // already closed
      }
    }
  })();
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function attachmentFetchRPCError(
  code: string,
  message: string,
  data: Record<string, unknown> | null,
): RPCError {
  return acpStructuredRPCError(-32000, code, message, data);
}

// ─── startup error types ────────────────────────────────────────────────────
