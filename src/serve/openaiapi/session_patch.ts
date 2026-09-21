// Ported from internal/serve/openaiapi/session_mgr.go — the Server-bound
// patch halves: PatchSessionRuntime, PatchSessionCapabilities,
// DeleteActiveSession, buildAgentOptionsForSession, plus
// applyStoredSessionCapabilities (restored-session capability replay) and
// session_capabilities.go's patchActiveSessionCapabilities (the slash-command
// patch path). They land together because all of them drive the
// agent-construction cluster (syncSessionTools/newAgentManagerForSession)
// from handler_chat_session.ts.
//
// The Server-bound methods become exported functions taking the `Server` as
// their first argument, matching the other openaiapi modules.
//
// Deviations: Go's `(value, error)` pairs throw typed errors here (matching
// session_read); the per-session request mutex is the async `CountedMutex`
// because it is held across awaits; `buildAgentOptionsForSession` returns the
// ported `AgentBuildOptions` whose `getSteeringMessages` hook is the ESM
// steering source from handler_chat_session.ts.
import type { Model } from "../../provider/types.ts";
import { resolveMaxTokens } from "../../agent/max_tokens.ts";
import type { AgentBuildOptions } from "../../agentruntime/session_runtime.ts";
import { deleteSession } from "../../agentruntime/session_lifecycle.ts";
import { closeClients } from "../../mcp/mcp.ts";
import { openByIDExact } from "../../session/manager.ts";
import { getSessionDir } from "../../config/settings.ts";
import type { Server } from "./server.ts";
import {
  APISession,
  ErrInvalidCapability,
  ErrSessionNotFound,
} from "./session_mgr.ts";
import {
  capabilitiesFromSession,
  normalizedDisplayMode,
  resolveSessionMode,
  validateCapabilityMode,
} from "./session_capabilities.ts";
import { runtimeSnapshotFromCapabilities } from "./session_runtime_snapshot.ts";
import { publishSessionStreamEvent } from "./session_stream.ts";
import {
  capabilitySnapshotFromSession,
  persistSessionCapabilitiesWithEvents,
} from "./events.ts";
import { applyBoolOption } from "./handler_chat_session.ts";
import {
  esmSteeringMessages,
  getOrCreateSession,
  settingsForSession,
  syncSessionTools,
} from "./handler_chat_session.ts";
import type {
  SessionCapabilities,
  SessionCapabilityPatch,
  SessionRuntimePatch,
  SessionRuntimeSnapshot,
} from "./types.ts";

/**
 * patchSessionRuntime applies the structured WebUI runtime patch and returns
 * the projected runtime snapshot.
 */
export async function patchSessionRuntime(
  server: Server,
  id: string,
  patch: SessionRuntimePatch,
): Promise<SessionRuntimeSnapshot> {
  if (id === "") throw ErrSessionNotFound;
  const capPatch: SessionCapabilityPatch = {};
  if (patch.displayMode !== undefined) {
    const mode = patch.displayMode.trim();
    if (mode !== "work" && mode !== "code") {
      throw new Error(
        `${ErrInvalidCapability.message}: displayMode must be work or code`,
      );
    }
    capPatch.displayMode = mode;
  }
  if (patch.mode !== undefined) {
    capPatch.mode = patch.mode;
  }
  if (patch.tools) {
    capPatch.webSearch = patch.tools.webSearch;
    capPatch.browser = patch.tools.browser;
    capPatch.a2aMaster = patch.tools.a2aMaster;
    capPatch.delegateMode = patch.tools.delegate;
    capPatch.multiAgent = patch.tools.multiAgent;
    capPatch.workflows = patch.tools.workflows;
  }
  for (const [name, enabled] of Object.entries(patch.capabilities ?? {})) {
    switch (name) {
      case "browser":
        capPatch.browser = enabled;
        break;
      case "delegate":
        capPatch.delegateMode = enabled;
        break;
      case "multiAgent":
        capPatch.multiAgent = enabled;
        break;
      case "workflows":
        capPatch.workflows = enabled;
        break;
      case "webSearch":
        capPatch.webSearch = enabled;
        break;
      case "a2aMaster":
        capPatch.a2aMaster = enabled;
        break;
      default:
        throw ErrInvalidCapability;
    }
  }
  const updated = await patchSessionCapabilities(server, id, capPatch);
  const snapshot = runtimeSnapshotFromCapabilities(server, updated);
  snapshot.displayMode = updated.displayMode;
  publishSessionStreamEvent(server, id, "runtime_event", snapshot);
  return snapshot;
}

/**
 * patchSessionCapabilities activates a session if needed and updates mutable
 * runtime capabilities.
 */
export async function patchSessionCapabilities(
  server: Server,
  id: string,
  patch: SessionCapabilityPatch,
): Promise<SessionCapabilities> {
  if (id === "") throw ErrSessionNotFound;
  const { workDir, found } = server.findSessionWorkDir(id);
  if (!found) throw ErrSessionNotFound;
  const sess = await getOrCreateSession(server, id, workDir);
  if (!sess) throw ErrSessionNotFound;
  if (!server.pool?.pin(sess)) throw ErrSessionNotFound;
  try {
    await sess.mu.lock();
    try {
      const before = capabilitySnapshotFromSession(sess);
      let refreshContext = false;
      let registryChanged = false;
      if (patch.mode !== undefined) {
        const mode = patch.mode.trim();
        const invalid = validateCapabilityMode(mode);
        if (invalid) throw invalid;
        const resolved = resolveSessionMode(server, sess, mode);
        if (resolved.err) throw resolved.err;
        sess.mode = resolved.mode;
      }
      if (patch.displayMode !== undefined) {
        sess.displayMode = normalizedDisplayMode(patch.displayMode);
      }
      if (applyBoolOption(sess, "webSearch", patch.webSearch)) {
        // Web search affects hosted tool injection at next agent construction.
      }
      if (applyBoolOption(sess, "browser", patch.browser)) {
        refreshContext = true;
        registryChanged = true;
      }
      if (applyBoolOption(sess, "a2aMaster", patch.a2aMaster)) {
        registryChanged = true;
      }
      const delegate = patch.delegateMode ?? patch.delegate;
      if (applyBoolOption(sess, "delegateMode", delegate)) {
        registryChanged = true;
      }
      if (applyBoolOption(sess, "multiAgent", patch.multiAgent)) {
        registryChanged = true;
      }
      if (applyBoolOption(sess, "workflows", patch.workflows)) {
        refreshContext = true;
        registryChanged = true;
      }
      // Mode and webSearch only affect agent construction/configuration. They
      // do not own registry state, so a mode-only WebUI PATCH must not
      // re-register session tools (or reinitialize optional integrations such
      // as A2A).
      if (registryChanged) {
        await syncSessionTools(server, sess, refreshContext);
      }
      const err = persistSessionCapabilitiesWithEvents(
        server,
        sess,
        before,
        "api_patch",
        "webui",
        "",
        { source: "session_capabilities_patch" },
      );
      if (err) throw err;
      sess.touch();

      const caps = capabilitiesFromSession(server, sess, true, !!sess.manager);
      caps.runtimeOnly = false;
      caps.persistenceNote = "";
      return caps;
    } finally {
      sess.mu.unlock();
    }
  } finally {
    server.pool.unpin(sess);
  }
}

/**
 * patchActiveSessionCapabilities updates an already locked active session for
 * slash commands. Registry synchronization remains capability-owned: a mode
 * change only persists the runtime setting and never re-registers tools.
 */
export async function patchActiveSessionCapabilities(
  server: Server,
  sess: APISession,
  patch: SessionCapabilityPatch,
  source: string,
  actor: string,
  runId: string,
  data: Record<string, unknown> | undefined,
): Promise<SessionCapabilities> {
  if (!sess) throw ErrSessionNotFound;
  const before = capabilitySnapshotFromSession(sess);
  let refreshContext = false;
  let registryChanged = false;

  if (patch.mode !== undefined) {
    const mode = patch.mode.trim();
    const invalid = validateCapabilityMode(mode);
    if (invalid) throw invalid;
    const resolved = resolveSessionMode(server, sess, mode);
    if (resolved.err) throw resolved.err;
    sess.mode = resolved.mode;
  }
  if (applyBoolOption(sess, "webSearch", patch.webSearch)) {
    // Web search is read when building the next agent configuration.
  }
  if (applyBoolOption(sess, "browser", patch.browser)) {
    refreshContext = true;
    registryChanged = true;
  }
  if (applyBoolOption(sess, "a2aMaster", patch.a2aMaster)) {
    registryChanged = true;
  }
  const delegate = patch.delegateMode ?? patch.delegate;
  if (applyBoolOption(sess, "delegateMode", delegate)) {
    registryChanged = true;
  }
  if (applyBoolOption(sess, "multiAgent", patch.multiAgent)) {
    registryChanged = true;
  }
  if (applyBoolOption(sess, "workflows", patch.workflows)) {
    refreshContext = true;
    registryChanged = true;
  }
  if (registryChanged) {
    await syncSessionTools(server, sess, refreshContext);
  }
  const err = persistSessionCapabilitiesWithEvents(
    server,
    sess,
    before,
    source,
    actor,
    runId,
    data,
  );
  if (err) throw err;
  sess.touch();
  const caps = capabilitiesFromSession(server, sess, true, !!sess.manager);
  caps.runtimeOnly = false;
  caps.persistenceNote = "";
  return caps;
}

/** deleteActiveSession shuts down and deletes one active or persisted session. */
export async function deleteActiveSession(
  server: Server,
  id: string,
): Promise<boolean> {
  if (!server || !server.pool) return false;
  let sess: APISession | undefined;
  try {
    sess = server.pool.getExact(id);
  } catch (err) {
    throw err;
  }
  if (!sess) {
    if (!server.settings) return false;
    try {
      openByIDExact(getSessionDir(server.settings), id);
    } catch {
      return false;
    }
    await deleteSession(getSessionDir(server.settings), id);
    return true;
  }
  if (sess.runtime) {
    try {
      await sess.runtime.shutdown(AbortSignal.timeout(10_000));
    } catch (err) {
      throw new Error(
        `shutdown session runtime: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  } else {
    closeClients(sess.mcpClients);
    sess.mcpClients = [];
  }
  if (sess.manager && sess.manager.getFile() !== "" && server.settings) {
    await deleteSession(getSessionDir(server.settings), sess.id);
  }
  if (sess.runtime) {
    sess.mcpClients = []; // legacy alias is released by Runtime.
  }
  server.pool.removeByWorkDir(sess.workDir, sess.id);

  for (const [workDir, defaultID] of server.defaultSessionIDs) {
    if (defaultID === sess.id) server.defaultSessionIDs.delete(workDir);
  }

  return true;
}

/**
 * buildAgentOptionsForSession assembles the shared Runtime agent-build inputs
 * for one session's run.
 */
export function buildAgentOptionsForSession(
  server: Server,
  sess: APISession,
  model: Model,
  mode: string,
): AgentBuildOptions {
  let extraContext = sess.extraContext;
  if (extraContext === "") extraContext = server.extraContext;
  const runtimeSettings = settingsForSession(server, sess)!;

  let thinkingLevel = server.cfg?.defaultThinkingLevel ?? "";
  if (thinkingLevel === "") {
    thinkingLevel = server.settings?.defaultThinkingLevel ?? "";
  }

  return {
    provider: server.provider,
    providerName: server.providerName,
    model,
    mode,
    thinkingLevel,
    maxTokens: resolveMaxTokens(model),
    maxTokensSet: true,
    settings: runtimeSettings,
    allow: server.getAllow(),
    extraContext,
    ruleContent: sess.ruleContent,
    multiAgent: sess.multiAgent,
    delegateMode: sess.delegateMode,
    workflows: sess.workflows,
    getSteeringMessages: esmSteeringMessages(server, sess.id),
  };
}
