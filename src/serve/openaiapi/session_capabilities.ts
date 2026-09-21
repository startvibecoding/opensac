// Ported from internal/serve/openaiapi/session_mgr.go (the capability
// resolution/persistence cluster) and session_capabilities.go's pure helpers.
// The Server-bound methods become exported functions taking the `Server` as
// their first argument; `applyStoredSessionCapabilities` and
// `patchActiveSessionCapabilities` live in session_patch.ts because both call
// the agent-construction cluster (`syncSessionTools`).
import { findBindingBySessionId } from "../../session/bindings.ts";
import {
  loadSessionCapabilities,
  saveSessionCapabilities,
  type SessionCapabilities as PersistedSessionCapabilities,
} from "../../session/session_events.ts";
import {
  resolvePolicy,
  type SourceResolution,
  type SourceResolutionInput,
  SourceUnknown,
  SourceWebUI,
} from "../../agentruntime/source.ts";
import type { Header } from "../../session/entry.ts";
import { getSessionDir } from "../../config/settings.ts";
import type { Server } from "./server.ts";
import {
  type APISession,
  ErrInvalidCapability,
  ErrSessionNotFound,
} from "./session_mgr.ts";
import type { SessionCapabilities } from "./types.ts";

/** validateCapabilityMode accepts the empty mode (meaning "resolve default"). */
export function validateCapabilityMode(mode: string): Error | null {
  switch (mode) {
    case "":
    case "plan":
    case "agent":
    case "yolo":
    case "os":
      return null;
    default:
      return new Error(
        `${ErrInvalidCapability.message}: mode must be plan, agent, yolo, os, or empty string`,
      );
  }
}

export function normalizedDisplayMode(mode: string): string {
  return mode.trim() === "code" ? "code" : "work";
}

/** applyStoredCapabilitiesToSession writes persisted capability state into a live session. */
export function applyStoredCapabilitiesToSession(
  sess: APISession,
  stored: PersistedSessionCapabilities,
): Error | null {
  const invalid = validateCapabilityMode(stored.mode);
  if (invalid) return invalid;
  sess.mode = stored.mode;
  sess.displayMode = normalizedDisplayMode(stored.displayMode);
  sess.delegateMode = stored.delegateMode;
  sess.multiAgent = stored.multiAgent;
  sess.workflows = stored.workflows;
  sess.webSearch = stored.webSearch;
  sess.browser = stored.browser;
  sess.a2aMaster = stored.a2aMaster;
  return null;
}

/** applyStoredCapabilitiesToResponse overlays persisted state onto a capability response. */
export function applyStoredCapabilitiesToResponse(
  caps: SessionCapabilities,
  stored: PersistedSessionCapabilities,
): void {
  caps.mode = stored.mode;
  if (caps.mode === "") caps.mode = "yolo";
  caps.delegateMode = stored.delegateMode;
  caps.delegate = stored.delegateMode;
  caps.multiAgent = stored.multiAgent;
  caps.workflows = stored.workflows;
  caps.webSearch = stored.webSearch;
  caps.browser = stored.browser;
  caps.a2aMaster = stored.a2aMaster;
  caps.displayMode = stored.displayMode;
  if (caps.displayMode !== "code") caps.displayMode = "work";
  caps.runtimeOnly = false;
  caps.persistenceNote = "";
}

/** loadStoredCapabilities reads the persisted capability row for one session. */
export function loadStoredCapabilities(
  server: Server,
  id: string,
): { caps: PersistedSessionCapabilities | null; ok: boolean } {
  if (!server.settings || id === "") return { caps: null, ok: false };
  return loadSessionCapabilities(getSessionDir(server.settings), id);
}

/** persistSessionCapabilities saves the session's current capability state. */
export function persistSessionCapabilities(
  server: Server,
  sess: APISession,
): void {
  if (!server.settings || sess.id === "") return;
  saveSessionCapabilities(getSessionDir(server.settings), {
    sessionId: sess.id,
    mode: sess.mode,
    displayMode: normalizedDisplayMode(sess.displayMode),
    delegateMode: sess.delegateMode,
    multiAgent: sess.multiAgent,
    workflows: sess.workflows,
    webSearch: sess.webSearch,
    browser: sess.browser,
    a2aMaster: sess.a2aMaster,
    updatedAt: new Date(),
  });
}

/**
 * resolveSessionMode resolves one effective mode for session display,
 * execution, records, and approvals. Bound WeChat and Feishu sessions cannot
 * be downgraded.
 */
export function resolveSessionMode(
  server: Server,
  sess: APISession,
  requestedMode: string,
): { mode: string; err: Error | null } {
  const { mode, err } = resolveSessionPolicy(server, sess, requestedMode);
  return { mode, err };
}

/** resolveSessionPolicy resolves source and mode through the shared Runtime resolver. */
export function resolveSessionPolicy(
  server: Server,
  sess: APISession,
  requestedMode: string,
): { resolution: SourceResolution; mode: string; err: Error | null } {
  if (!sess) {
    return {
      resolution: { source: SourceUnknown, conflicted: false, diagnostics: [] },
      mode: "",
      err: ErrSessionNotFound,
    };
  }
  const header = sess.manager ? sess.manager.getHeader() : null;
  const defaultMode = server.cfg?.defaultMode ?? "";
  if (sess.runtime) {
    const resolved = sess.runtime.resolvePolicy(
      sess.mode,
      requestedMode,
      defaultMode,
    );
    return { resolution: resolved.resolution, mode: resolved.mode, err: null };
  }
  let binding = null;
  if (server.settings && sess.id !== "") {
    try {
      binding = findBindingBySessionId(getSessionDir(server.settings), sess.id);
    } catch (err) {
      return {
        resolution: {
          source: SourceUnknown,
          conflicted: false,
          diagnostics: [],
        },
        mode: "",
        err: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }
  const input: SourceResolutionInput = {
    binding,
    sessionHeader: header,
    requested: SourceWebUI,
  };
  const result = resolvePolicy(input, sess.mode, requestedMode, defaultMode);
  return {
    resolution: result.resolution,
    mode: result.mode,
    err: result.error,
  };
}

/** resolveSessionModeFromHeader resolves mode for a session that has no live Runtime yet. */
export function resolveSessionModeFromHeader(
  server: Server,
  header: Header | null,
  sessionMode: string,
  requestedMode: string,
): { mode: string; err: Error | null } {
  const defaultMode = server.cfg?.defaultMode ?? "";
  const result = resolvePolicy(
    { sessionHeader: header, requested: SourceWebUI },
    sessionMode,
    requestedMode,
    defaultMode,
  );
  return { mode: result.mode, err: result.error };
}

/** defaultSessionCapabilities builds the serve-level capability defaults. */
export function defaultSessionCapabilities(
  server: Server,
  workDir: string,
  active: boolean,
  persisted: boolean,
): SessionCapabilities {
  let mode = "";
  let delegateMode = false;
  let workflows = false;
  let webSearch = false;
  let browser = false;
  let a2aMaster = false;
  let multiAgent = false;
  const cfg = server.cfg;
  if (cfg) {
    mode = cfg.defaultMode ?? "";
    delegateMode = cfg.enableDelegate ?? false;
    workflows = cfg.enableWorkflows ?? false;
    webSearch = server.isWebSearchAvailable();
    browser = cfg.enableBrowser ?? false;
    a2aMaster = cfg.enableA2AMaster ?? false;
    multiAgent = cfg.enableSubAgents ?? false;
  }
  if (mode === "") mode = "yolo";
  return {
    workDir,
    active,
    mode,
    displayMode: "work",
    delegateMode,
    delegate: delegateMode,
    multiAgent,
    workflows,
    webSearch,
    browser,
    a2aMaster,
    model: currentModelID(server),
    thinkingLevel: currentThinkingLevel(server),
    persisted,
    runtimeOnly: true,
    persistenceNote:
      "capability changes are runtime-only until session capability persistence is implemented",
  };
}

/** capabilitiesFromSession projects a live (or nil) session into capability state. */
export function capabilitiesFromSession(
  server: Server,
  sess: APISession | null,
  active: boolean,
  persisted: boolean,
): SessionCapabilities {
  if (!sess) return defaultSessionCapabilities(server, "", active, persisted);
  const caps = defaultSessionCapabilities(
    server,
    sess.workDir,
    active,
    persisted,
  );
  caps.id = sess.id;
  const resolved = resolveSessionMode(server, sess, "");
  if (resolved.err === null) {
    caps.mode = resolved.mode;
  } else if (sess.mode !== "") {
    caps.mode = sess.mode;
  }
  caps.displayMode = normalizedDisplayMode(sess.displayMode);
  caps.delegateMode = sess.delegateMode;
  caps.delegate = sess.delegateMode;
  caps.multiAgent = sess.multiAgent;
  caps.workflows = sess.workflows;
  caps.webSearch = sess.webSearch;
  caps.browser = sess.browser;
  caps.a2aMaster = sess.a2aMaster;
  const stored = loadStoredCapabilities(server, sess.id);
  if (stored.ok) {
    caps.runtimeOnly = false;
    caps.persistenceNote = "";
  }
  return caps;
}

/** currentModelID returns the server's active model ID. */
export function currentModelID(server: Server): string {
  return server.model?.id ?? "";
}

/** currentThinkingLevel resolves the serve-level default thinking level. */
export function currentThinkingLevel(server: Server): string {
  const cfg = server.cfg;
  if (!cfg) return "";
  if (cfg.defaultThinkingLevel && cfg.defaultThinkingLevel !== "") {
    return cfg.defaultThinkingLevel;
  }
  if (server.settings) return server.settings.defaultThinkingLevel ?? "";
  return "";
}
