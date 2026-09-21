// Ported from internal/serve/openaiapi/handler_chat.go — the Server-bound
// session-resource cluster (this module is named handler_chat_session.ts
// because the guard-covered handler_chat.ts file name is reserved for the
// HTTP/input-contract half of handler_chat.go, which lands with the
// run-executor slice): AllocateSessionID, claimAllocatedSessionID,
// getOrCreateSession, bindSessionRuntime, validatePersistedSessionWorkDir,
// buildSessionResources, applySessionToolOptions, applyBoolOption,
// syncSessionTools, registerCronTool, removeSubAgentTools,
// removeWorkflowTools, refreshSessionContext, settingsForSession,
// registerA2AMasterTool, registerA2ADispatchTool, a2aDispatcherAdapter, and
// clearSession. `newAgentManagerForSession` comes from commands.go (its other
// Server-bound halves land with the command slices), and the ESM steering
// helper mirrors esm_api.go's `esmStore` plus esm_coordinator.go's
// `esmSteeringMessages` (the coordinator/API land with their own slice).
// The HTTP halves of handler_chat.go (handleChatCompletions and the streaming
// projections) land with the run-executor slice.
//
// The Server-bound methods become exported functions taking the `Server` as
// their first argument, matching the other openaiapi modules.
//
// Deviations: Go's `(value, error)` pairs throw typed errors here (matching
// session_read/session_capabilities); `context.Context` maps to `AbortSignal`;
// Go's sync.RWMutex on the Server is dropped for short synchronous critical
// sections while the session-create mutex stays the async `CountedMutex`;
// `registerA2ADispatchTool` reads the a2a-list config synchronously
// (`Deno.readTextFileSync`) because the Builder's RegistryHook is synchronous
// in the ported Runtime, so its read/parse error text is wrapped in one step
// instead of two; `applyBoolOption` addresses the session flag by field name
// instead of Go's pointer indirection; the whole cluster is async because
// Runtime.BindSession/Builder.Build/RefreshResources await.
import type { AgentManager } from "../../agent/manager.ts";
import {
  registerDelegateSubAgentTool,
  registerSubAgentTools,
} from "../../agent/subagent.ts";
import { subAgentToolNames } from "../../agent/subagent_support.ts";
import {
  type A2AManager,
  type AgentListConfig,
  agentListConfigPath,
  newA2AManager,
  projectAgentListConfigPath,
} from "../../a2a/master.ts";
import {
  createSession,
  deleteSession,
} from "../../agentruntime/session_lifecycle.ts";
import {
  Builder,
  SessionRuntime,
  subAgentToolsEnabled,
} from "../../agentruntime/session_runtime.ts";
import { newAgentManager } from "../../agentruntime/agent_manager.ts";
import { SourceWebUI } from "../../agentruntime/source.ts";
import { newSessionScopedStoreWithWorkDir } from "../../cron/session_store.ts";
import { newCronTool } from "../../cron/tool.ts";
import type { Scheduler as CronScheduler } from "../../cron/scheduler.ts";
import { getSessionDir, type Settings } from "../../config/settings.ts";
import { Store as ESMStore } from "../../esm/store.ts";
import { SteeringSource } from "../../esm/steering.ts";
import { Level } from "../../sandbox/sandbox.ts";
import {
  type Manager as SessionManager,
  openByIDExact,
} from "../../session/manager.ts";
import { SessionIDExistsError } from "../../session/session_errors.ts";
import { generateID } from "../../session/entry.ts";
import { A2ADispatchTool, type AgentEntry } from "../../tools/a2a_dispatch.ts";
import type { Registry, ToolContext } from "../../tools/tool.ts";
import { registerWorkflowTools } from "../../workflow/tools.ts";
import type { Message } from "../../provider/types.ts";
import type { Server } from "./server.ts";
import { APISession } from "./session_mgr.ts";
import { sameWorkDir } from "./chat_support.ts";
import { getWorkDir, validateWorkDir } from "./config.ts";
import {
  capabilitySnapshotFromSession,
  persistSessionCapabilitiesWithEvents,
} from "./events.ts";
import type { SessionToolOptions } from "./types.ts";
import {
  applyStoredCapabilitiesToSession,
  loadStoredCapabilities,
  resolveSessionMode,
} from "./session_capabilities.ts";

/**
 * applyStoredSessionCapabilities replays a restored session's persisted
 * capability row and synchronizes tools when the capability set changed. It
 * lives beside the creation cluster because getOrCreateSession calls it during
 * assembly.
 */
export async function applyStoredSessionCapabilities(
  server: Server,
  sess: APISession,
): Promise<void> {
  if (!sess) return;
  const { caps: stored, ok } = loadStoredCapabilities(server, sess.id);
  const oldBrowser = sess.browser;
  const oldWorkflows = sess.workflows;
  if (ok && stored) {
    const invalid = applyStoredCapabilitiesToSession(sess, stored);
    if (invalid) throw invalid;
  }
  const resolved = resolveSessionMode(server, sess, "");
  if (resolved.err) throw resolved.err;
  sess.mode = resolved.mode;
  await syncSessionTools(
    server,
    sess,
    oldBrowser !== sess.browser || oldWorkflows !== sess.workflows,
  );
}

/** sessionResources bundles the Runtime-built resources for one session. */
export interface SessionResources {
  runtime: SessionRuntime;
  registry: Registry;
  sandboxMgr: SessionRuntime["sandboxMgr"];
  mcpClients: SessionRuntime["mcpClients"];
  skillsMgr: SessionRuntime["skillsMgr"];
  extraContext: string;
  ruleContent: string;
}

/**
 * allocateSessionID reserves a server-issued session ID that is not yet a
 * persisted session. Allocated IDs expire after 10 minutes.
 */
export async function allocateSessionID(server: Server): Promise<string> {
  if (!server || !server.settings) {
    throw new Error("session server is not ready");
  }
  await server.sessionCreateMu.lock();
  try {
    const now = new Date();
    for (const [id, allocatedAt] of server.allocatedSessionIDs) {
      if (now.getTime() - allocatedAt.getTime() > 10 * 60_000) {
        server.allocatedSessionIDs.delete(id);
      }
    }

    const sessionDir = getSessionDir(server.settings);
    for (let attempt = 0; attempt < 16; attempt++) {
      const id = generateID();
      if (server.allocatedSessionIDs.has(id)) continue;
      try {
        openByIDExact(sessionDir, id);
      } catch (err) {
        const errText = (err instanceof Error ? err.message : String(err))
          .toLowerCase();
        // openByIDExact reports a missing ID differently depending on whether
        // sessions.db exists: "not found" when the database is absent, and
        // "not registered in DB" when the row is absent.
        if (
          errText.includes("not found") ||
          errText.includes("not registered in db")
        ) {
          server.allocatedSessionIDs.set(id, now);
          return id;
        }
        throw new Error(
          `check session ID availability: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    throw new SessionIDExistsError("allocate unique session ID");
  } finally {
    server.sessionCreateMu.unlock();
  }
}

/** claimAllocatedSessionID consumes a previously allocated session ID. */
export function claimAllocatedSessionID(server: Server, id: string): boolean {
  if (!server.allocatedSessionIDs.has(id)) return false;
  server.allocatedSessionIDs.delete(id);
  return true;
}

/**
 * assemblePersistedSession builds a live APISession around a just-opened
 * persisted session manager. It is the shared body of the restored-session
 * branches in getOrCreateSession.
 */
async function assemblePersistedSession(
  server: Server,
  sessionID: string,
  workDir: string,
  mgr: SessionManager,
  includeSandboxAlias: boolean,
): Promise<APISession> {
  let sessWorkDir = workDir;
  const header = mgr.getHeader();
  if (header && header.cwd !== "") sessWorkDir = header.cwd;
  await validatePersistedSessionWorkDir(server, sessWorkDir);
  const resources = await buildSessionResources(server, sessWorkDir);
  const gwSess = new APISession();
  gwSess.runtime = resources.runtime;
  gwSess.id = sessionID;
  gwSess.workDir = sessWorkDir;
  gwSess.manager = mgr;
  gwSess.registry = resources.registry;
  // Go's restored-ID branch omits SandboxMgr/MCPClients (the runtime owns
  // them); the default-ID branch keeps the SandboxMgr alias.
  if (includeSandboxAlias) gwSess.sandboxMgr = resources.sandboxMgr;
  gwSess.skillsMgr = resources.skillsMgr;
  gwSess.extraContext = resources.extraContext;
  gwSess.ruleContent = resources.ruleContent;
  gwSess.delegateMode = server.cfg?.enableDelegate ?? false;
  gwSess.workflows = server.cfg?.enableWorkflows ?? false;
  gwSess.webSearch = server.isWebSearchAvailable();
  gwSess.browser = server.cfg?.enableBrowser ?? false;
  gwSess.a2aMaster = server.cfg?.enableA2AMaster ?? false;
  gwSess.multiAgent = server.cfg?.enableSubAgents ?? false;
  gwSess.lastUsed = new Date();
  const bindErr = await bindSessionRuntime(gwSess);
  if (bindErr) {
    resources.runtime.shutdown().catch(() => {});
    throw bindErr;
  }
  await applyStoredSessionCapabilities(server, gwSess);
  if (gwSess.multiAgent || gwSess.delegateMode || gwSess.workflows) {
    gwSess.agentMgr = await newAgentManagerForSession(server, gwSess);
  }
  registerCronTool(server, gwSess);
  server.pool?.put(gwSess);
  return gwSess;
}

/** getOrCreateSession returns an existing session or creates a new one. */
export async function getOrCreateSession(
  server: Server,
  sessionID: string,
  workDir: string,
): Promise<APISession> {
  if (sessionID !== "") {
    const existing = server.pool?.get(sessionID);
    if (existing) {
      if (workDir !== "" && !sameWorkDir(existing.workDir, workDir)) {
        throw new Error(
          `session ${
            JSON.stringify(sessionID)
          } belongs to a different working directory`,
        );
      }
      await validatePersistedSessionWorkDir(server, existing.workDir);
      return existing;
    }
  }

  // Serialize creation so concurrent requests don't create duplicate sessions
  // for the same explicit ID or work-directory default.
  await server.sessionCreateMu.lock();
  try {
    let allocatedID = false;

    if (sessionID !== "") {
      const existing = server.pool?.get(sessionID);
      if (existing) {
        if (workDir !== "" && !sameWorkDir(existing.workDir, workDir)) {
          throw new Error(
            `session ${
              JSON.stringify(sessionID)
            } belongs to a different working directory`,
          );
        }
        await validatePersistedSessionWorkDir(server, existing.workDir);
        return existing;
      }
      allocatedID = claimAllocatedSessionID(server, sessionID);
      if (!allocatedID) {
        let mgr: SessionManager | null = null;
        try {
          mgr = openByIDExact(getSessionDir(server.settings!), sessionID);
        } catch {
          // Fall through to fresh-session creation.
        }
        if (mgr) {
          return await assemblePersistedSession(
            server,
            sessionID,
            workDir,
            mgr,
            false,
          );
        }
      }
    } else {
      const defaultID = server.defaultSessionIDs.get(workDir) ?? "";
      if (defaultID !== "") {
        const pooled = server.pool?.getForWorkDir(workDir, defaultID);
        if (pooled) return pooled;
        let mgr: SessionManager | null = null;
        try {
          mgr = openByIDExact(getSessionDir(server.settings!), defaultID);
        } catch {
          // Fall through to fresh-session creation under the default ID.
        }
        if (mgr) {
          return await assemblePersistedSession(
            server,
            defaultID,
            workDir,
            mgr,
            true,
          );
        }
        sessionID = defaultID;
      }
    }

    // Create new session
    let mgr: SessionManager;
    try {
      mgr = createSession({
        workDir,
        sessionDir: getSessionDir(server.settings!),
        id: sessionID,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (sessionID !== "") {
        throw new Error(
          `initialize session ${JSON.stringify(sessionID)}: ${message}`,
        );
      }
      throw new Error(`initialize session: ${message}`);
    }

    let id = sessionID;
    if (id === "") {
      const header = mgr.getHeader();
      if (header) id = header.id;
    }

    const resources = await buildSessionResources(server, workDir);

    const sess = new APISession();
    sess.runtime = resources.runtime;
    sess.id = id;
    sess.workDir = workDir;
    sess.manager = mgr;
    sess.registry = resources.registry;
    sess.sandboxMgr = resources.sandboxMgr;
    sess.mcpClients = resources.mcpClients;
    sess.mode = "";
    sess.skillsMgr = resources.skillsMgr;
    sess.extraContext = resources.extraContext;
    sess.ruleContent = resources.ruleContent;
    sess.delegateMode = server.cfg?.enableDelegate ?? false;
    sess.workflows = server.cfg?.enableWorkflows ?? false;
    sess.webSearch = server.isWebSearchAvailable();
    sess.browser = server.cfg?.enableBrowser ?? false;
    sess.a2aMaster = server.cfg?.enableA2AMaster ?? false;
    sess.multiAgent = server.cfg?.enableSubAgents ?? false;
    sess.lastUsed = new Date();
    const bindErr = await bindSessionRuntime(sess);
    if (bindErr) {
      resources.runtime.shutdown().catch(() => {});
      throw bindErr;
    }
    await applyStoredSessionCapabilities(server, sess);

    // The runtime resolves a team expert from the persisted session binding.
    // It forces the sub-agent capability even when the adapter-level toggle is
    // false, so tool/manager setup must go through the common predicate rather
    // than only the WebUI capability flags.
    await syncSessionTools(server, sess, false);

    server.pool?.put(sess);

    // If this session was created for the standard endpoint's internal default,
    // remember it so subsequent requests for the same work directory reuse it.
    if (sessionID === "") {
      if (!server.defaultSessionIDs.has(workDir)) {
        server.defaultSessionIDs.set(workDir, sess.id);
      }
    }

    return sess;
  } finally {
    server.sessionCreateMu.unlock();
  }
}

/**
 * bindSessionRuntime attaches adapter session identity to its shared runtime.
 * Resource construction intentionally happens before the persisted Manager is
 * known in some recovery paths, so this binding is centralized here.
 */
export async function bindSessionRuntime(
  sess: APISession,
): Promise<Error | null> {
  if (!sess || !sess.runtime) return null;
  if (!sess.manager) {
    return new Error("initialized session manager is required");
  }
  try {
    await sess.runtime.bindSession(sess.manager, SourceWebUI);
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  const execution = sess.executionRuntime();
  if (execution) sess.runtime.setExecution(execution);
  if (sess.decisions) sess.runtime.setDecisions(sess.decisions);
  return null;
}

/**
 * validatePersistedSessionWorkDir applies the current policy when restoring a
 * session. The configured default remains trusted even when overrides are
 * disabled, preserving the documented default-workdir behavior.
 */
export async function validatePersistedSessionWorkDir(
  server: Server,
  workDir: string,
): Promise<void> {
  if (sameWorkDir(workDir, getWorkDir(server.cfg!))) return;
  await validateWorkDir(server.cfg!, workDir);
}

/**
 * buildSessionResources builds context, skills, registry, sandbox and MCP
 * connections for one session through the shared Runtime builder.
 */
export async function buildSessionResources(
  server: Server,
  workDir: string,
): Promise<SessionResources> {
  // Serve supplies its effective sandbox level; the front-end-neutral builder
  // owns all shared context, skills, registry and MCP construction.
  let level = Level.None;
  if (server.sandboxMgr) {
    level = server.sandboxMgr.getActive().level();
  }
  const runtime = await new Builder(server.settings!, level).build(undefined, {
    source: SourceWebUI,
    workDir,
    workflows: server.cfg?.enableWorkflows ?? false,
    browser: server.cfg?.enableBrowser ?? false,
    artifactEnabled: server.cfg?.enableArtifact ?? false,
    registryHooks: [
      (rt: SessionRuntime) => {
        registerA2AMasterTool(server, rt.registry!);
      },
    ],
  });
  return {
    runtime,
    registry: runtime.registry!,
    sandboxMgr: runtime.sandboxMgr,
    mcpClients: runtime.mcpClients,
    skillsMgr: runtime.skillsMgr,
    extraContext: runtime.extraContext,
    ruleContent: runtime.ruleContent,
  };
}

/**
 * applySessionToolOptions applies the per-run tool toggles and persists them
 * with capability events.
 */
export async function applySessionToolOptions(
  server: Server,
  sess: APISession,
  opts: SessionToolOptions | null,
  runId: string,
): Promise<void> {
  if (!sess) return;
  const before = capabilitySnapshotFromSession(sess);
  let browserChanged = false;
  let workflowsChanged = false;
  if (opts) {
    applyBoolOption(sess, "webSearch", opts.webSearch);
    browserChanged = applyBoolOption(sess, "browser", opts.browser);
    applyBoolOption(sess, "a2aMaster", opts.a2aMaster);
    applyBoolOption(sess, "delegateMode", opts.delegate);
    applyBoolOption(sess, "multiAgent", opts.multiAgent);
    workflowsChanged = applyBoolOption(sess, "workflows", opts.workflows);
  }
  await syncSessionTools(server, sess, browserChanged || workflowsChanged);
  if (opts) {
    const err = persistSessionCapabilitiesWithEvents(
      server,
      sess,
      before,
      "run_tools",
      "webui",
      runId,
      { source: "run_submit" },
    );
    if (err) throw err;
  }
}

/**
 * applyBoolOption copies `src` into the named session flag when it changed.
 * Returns whether the flag changed.
 */
export function applyBoolOption(
  sess: APISession,
  field:
    | "webSearch"
    | "browser"
    | "a2aMaster"
    | "delegateMode"
    | "multiAgent"
    | "workflows",
  src: boolean | undefined,
): boolean {
  if (src === undefined || sess[field] === src) return false;
  sess[field] = src;
  return true;
}

/**
 * syncSessionTools re-registers the session-scoped optional tools (cron, A2A,
 * sub-agent, delegate, workflow) after any capability change.
 */
export async function syncSessionTools(
  server: Server,
  sess: APISession,
  refreshContext: boolean,
): Promise<void> {
  if (!sess || !sess.registry) return;
  registerCronTool(server, sess);

  if (refreshContext) {
    await refreshSessionContext(server, sess);
  }

  if (sess.runtime) {
    sess.runtime.synchronizeCoreTools(sess.browser);
  }

  if (sess.a2aMaster) {
    registerA2ADispatchTool(server, sess.registry);
  } else {
    sess.registry.remove("a2a_dispatch");
  }

  if (
    subAgentToolsEnabled(sess.runtime, sess.multiAgent) ||
    sess.delegateMode || sess.workflows
  ) {
    if (!sess.agentMgr) {
      sess.agentMgr = await newAgentManagerForSession(server, sess);
    }
  } else {
    sess.agentMgr = undefined;
  }

  if (subAgentToolsEnabled(sess.runtime, sess.multiAgent) && sess.agentMgr) {
    registerSubAgentTools(sess.registry, sess.agentMgr);
  } else {
    removeSubAgentTools(sess.registry);
  }

  if (sess.delegateMode && sess.agentMgr) {
    registerDelegateSubAgentTool(sess.registry, sess.agentMgr);
  } else {
    sess.registry.remove("delegate_subagent");
  }
  if (sess.workflows && sess.agentMgr) {
    registerWorkflowTools(sess.registry, { manager: sess.agentMgr });
  } else {
    removeWorkflowTools(sess.registry);
  }
}

/** registerCronTool binds the cron tool to the session-scoped store. */
export function registerCronTool(server: Server, sess: APISession): void {
  if (!sess || !sess.registry) return;
  if (!server || !server.cronStore) {
    sess.registry.remove("cron");
    return;
  }
  sess.registry.register(
    newCronTool(
      newSessionScopedStoreWithWorkDir(
        server.cronStore,
        sess.id,
        sess.workDir,
      ),
      (server.cronScheduler ?? null) as CronScheduler | null,
    ),
  );
}

/** removeSubAgentTools removes every sub-agent tool from the registry. */
export function removeSubAgentTools(registry: Registry): void {
  if (!registry) return;
  for (const name of subAgentToolNames()) {
    registry.remove(name);
  }
}

/** removeWorkflowTools removes every workflow tool from the registry. */
export function removeWorkflowTools(registry: Registry): void {
  if (!registry) return;
  for (
    const name of [
      "workflow_lint",
      "workflow_run",
      "workflow_status",
      "workflow_cancel",
    ]
  ) {
    registry.remove(name);
  }
}

/** refreshSessionContext reloads context files and skills for one session. */
export async function refreshSessionContext(
  server: Server,
  sess: APISession,
): Promise<void> {
  if (!sess) return;
  if (!sess.runtime) {
    // Compatibility for test fixtures and adapters not yet migrated to the
    // builder. All production OpenAI API sessions have Runtime set at open.
    sess.runtime = new SessionRuntime({
      id: sess.id,
      source: SourceWebUI,
      entrySource: SourceWebUI,
      workDir: sess.workDir,
      manager: sess.manager,
      registry: sess.registry,
      sandboxMgr: sess.sandboxMgr,
      skillsMgr: sess.skillsMgr,
      mcpClients: sess.mcpClients,
      extraContext: sess.extraContext,
      ruleContent: sess.ruleContent,
      artifactEnabled: server.cfg?.enableArtifact ?? false,
    });
    if (sess.manager) {
      await sess.runtime.bindSession(sess.manager, SourceWebUI);
    }
  }
  await sess.runtime.refreshResources(server.settings!, {
    workflows: sess.workflows,
    browser: sess.browser,
    activeSkills: sess.activeSkills,
  });
  sess.skillsMgr = sess.runtime.skillsMgr;
  sess.extraContext = sess.runtime.extraContext;
  sess.ruleContent = sess.runtime.ruleContent;
  if (sess.agentMgr) {
    sess.agentMgr = await newAgentManagerForSession(server, sess);
    // Re-register sub-agent/delegate/workflow tools with the new manager so
    // tool instances reference the current AgentMgr. Without this, tools
    // created by syncSessionTools keep pointing at the old manager while the
    // parent agent is registered into the new one, causing "parent agent not
    // found" errors when sub-agents are spawned.
    if (subAgentToolsEnabled(sess.runtime, sess.multiAgent) && sess.agentMgr) {
      registerSubAgentTools(sess.registry!, sess.agentMgr);
    }
    if (sess.delegateMode && sess.agentMgr) {
      registerDelegateSubAgentTool(sess.registry!, sess.agentMgr);
    }
    if (sess.workflows && sess.agentMgr) {
      registerWorkflowTools(sess.registry!, { manager: sess.agentMgr });
    }
  }
}

/** settingsForSession clones the settings with the session's web-search flag. */
export function settingsForSession(
  server: Server,
  sess: APISession | null,
): Settings | null {
  if (!server.settings || !sess) return server.settings;
  const runtimeSettings: Settings = { ...server.settings };
  runtimeSettings.webSearch = {
    ...runtimeSettings.webSearch,
    enabled: sess.webSearch,
  };
  return runtimeSettings;
}

/** registerA2AMasterTool wires the A2A dispatch tool when enabled. */
export function registerA2AMasterTool(
  server: Server,
  registry: Registry,
): void {
  if (!server.cfg?.enableA2AMaster) return;
  registerA2ADispatchTool(server, registry);
}

/**
 * registerA2ADispatchTool loads a2a-list.json and registers the dispatch tool.
 * Synchronous so the Builder's RegistryHook can call it directly.
 */
export function registerA2ADispatchTool(
  _server: Server,
  registry: Registry,
): void {
  let a2aListPath = projectAgentListConfigPath();
  try {
    Deno.statSync(a2aListPath);
  } catch {
    a2aListPath = agentListConfigPath();
  }
  let a2aListCfg: AgentListConfig;
  try {
    a2aListCfg = JSON.parse(Deno.readTextFileSync(a2aListPath));
  } catch (err) {
    throw new Error(`load a2a-list.json: ${(err as Error).message}`);
  }
  const a2aMgr = newA2AManager(a2aListCfg);
  registry.register(new A2ADispatchTool(new A2ADispatcherAdapter(a2aMgr)));
}

/** a2aDispatcherAdapter adapts the A2A manager to the tool dispatcher. */
export class A2ADispatcherAdapter {
  #mgr: A2AManager;

  constructor(mgr: A2AManager) {
    this.#mgr = mgr;
  }

  list(): AgentEntry[] {
    const entries = this.#mgr.list();
    const result: AgentEntry[] = [];
    for (const e of entries) {
      result.push({ name: e.name, url: e.url });
    }
    return result;
  }

  dispatch(
    ctx: ToolContext,
    name: string,
    message: string,
  ): Promise<string> | string {
    return this.#mgr.dispatch(
      ctx.signal ?? new AbortController().signal,
      name,
      message,
    );
  }
}

/**
 * clearSession deletes the persisted session and recreates it in place,
 * keeping the session ID and the workdir default binding.
 */
export async function clearSession(
  server: Server,
  sess: APISession,
  workDir: string,
): Promise<void> {
  if (!sess) throw new Error("no active session to clear");
  const sessionDir = getSessionDir(server.settings!);
  if (!sess.manager) {
    throw new Error("current session is not initialized");
  }
  const header = sess.manager.getHeader();
  if (header && header.cwd !== "") {
    workDir = header.cwd;
  }
  try {
    await deleteSession(sessionDir, sess.id);
  } catch (err) {
    throw new Error(
      `delete current session: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  let newMgr: SessionManager;
  try {
    newMgr = createSession({ workDir, sessionDir, id: sess.id });
  } catch (err) {
    throw new Error(
      `create fresh session: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  sess.manager = newMgr;
  sess.workDir = workDir;
  const bindErr = await bindSessionRuntime(sess);
  if (bindErr) {
    throw new Error(`rebind fresh session runtime: ${bindErr.message}`);
  }
  sess.touch();
  sess.forceCompact = false;
  server.defaultSessionIDs.set(workDir, sess.id);
}

/**
 * newAgentManagerForSession builds the session's AgentManager through the
 * shared Runtime manager path. Returns undefined on failure (Go returns nil).
 */
export async function newAgentManagerForSession(
  server: Server,
  sess: APISession,
): Promise<AgentManager | undefined> {
  if (!sess) return undefined;
  const runtimeSettings = settingsForSession(server, sess);
  if (!sess.runtime) {
    // Compatibility for adapter-owned test fixtures while all production
    // sessions are created by agentruntime.Builder.
    sess.runtime = new SessionRuntime({
      id: sess.id,
      source: SourceWebUI,
      entrySource: SourceWebUI,
      workDir: sess.workDir,
      manager: sess.manager,
      registry: sess.registry,
      sandboxMgr: sess.sandboxMgr,
      skillsMgr: sess.skillsMgr,
      mcpClients: sess.mcpClients,
      extraContext: sess.extraContext,
      ruleContent: sess.ruleContent,
      artifactEnabled: server.cfg?.enableArtifact ?? false,
    });
  }
  if (sess.manager) {
    try {
      await sess.runtime.bindSession(sess.manager, SourceWebUI);
    } catch {
      return undefined;
    }
  }
  if (sess.runtime.extraContext === "") {
    sess.runtime.extraContext = server.extraContext;
  }
  if (!sess.runtime.skillsMgr) {
    sess.runtime.skillsMgr = server.skillsMgr;
  }
  if (!sess.runtime.sandboxMgr) {
    sess.runtime.sandboxMgr = server.sandboxMgr;
  }
  try {
    return newAgentManager({
      runtime: sess.runtime,
      provider: server.provider!,
      model: server.model!,
      settings: runtimeSettings!,
      providerName: server.providerName,
      allow: server.getAllow(),
      multiAgentEnabled: true,
      delegateEnabled: sess.delegateMode ||
        (server.cfg?.enableDelegate ?? false),
      workflowsEnabled: sess.workflows,
    });
  } catch {
    return undefined;
  }
}

/**
 * esmSteeringMessages exposes the core's version-aware ESM steering source to
 * one normal WebUI run. The source only injects persisted objective updates at
 * Agent loop boundaries; it never creates a competing execution.
 */
export function esmSteeringMessages(
  server: Server,
  sessionId: string,
): () => Message[] {
  const source = new SteeringSource(esmStore(server), sessionId);
  return () => source.next();
}

/** esmStore builds the ESM objective store for the server's session root. */
export function esmStore(server: Server): ESMStore | null {
  if (!server || !server.settings) return null;
  return new ESMStore(getSessionDir(server.settings));
}
