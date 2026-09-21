// Ported from internal/serve/openaiapi/expert_api.go — the Serve/WebUI expert
// identity-transition slice. The Runtime owns validation, session persistence
// and resource rehydration (SessionRuntime.setExpert); this adapter only
// rebuilds its manager/tool projection from the new Runtime state. The busy
// sentinel is matched by name (`ErrSessionExpertMutationBusy`) so handlers that
// cannot import this module (handler_run_submit.ts) can still classify it.
//
// Deviation: Go's methods on *Server map to exported functions taking the
// Server; `errors.Is` sentinels map to identity/name checks over the cause
// chain; `context.Context` maps to an optional AbortSignal; Go's mutex pairs
// collapse to the async session CountedMutex; SetSessionExpert is async
// because acquireSessionMutation/setExpert/syncSessionTools await.
import {
  acquireSessionMutation,
  DetachedRemoteExecutionError,
} from "../../agentruntime/execution_admission.ts";
import {
  type ForkOptions,
  type ForkResult,
  forkWithExpert,
} from "../../agentruntime/fork.ts";
import {
  inspectExpert as inspectExpertRuntime,
  listExperts as listExpertsRuntime,
} from "../../agentruntime/expert.ts";
import type { Bundle, Summary } from "../../expert/expert.ts";
import type { LocalizedText } from "../../expert/expert.ts";
import { getSessionDir } from "../../config/settings.ts";
import {
  RuntimeLeaseBusyError,
  SessionRunActiveError,
} from "../../session/runtime_lock.ts";
import { getWorkDir } from "./config.ts";
import {
  getOrCreateSession,
  syncSessionTools,
} from "./handler_chat_session.ts";
import { ErrSessionNotFound } from "./session_mgr.ts";
import type { Server } from "./server.ts";
import type { APISession } from "./session_mgr.ts";
import { publishSessionStreamEvent } from "./session_stream.ts";

/** Name of the busy sentinel matched by `isSessionExpertMutationBusy`. */
export const ErrSessionExpertMutationBusyName = "ErrSessionExpertMutationBusy";

/**
 * SessionExpertMutationBusyError means that a session has an active or
 * externally owned run and its identity cannot safely change yet.
 */
export class SessionExpertMutationBusyError extends Error {
  override name = ErrSessionExpertMutationBusyName;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = ErrSessionExpertMutationBusyName;
  }
}

/** Go's sentinel value, kept as an error for direct-throw call sites. */
export const ErrSessionExpertMutationBusy = new SessionExpertMutationBusyError(
  "session expert identity cannot change while a run is active",
);

/** ExpertSummary is the WebUI-safe projection of one discoverable expert
 * bundle. Persona prompt bodies are intentionally excluded from this catalog. */
export interface ExpertSummary {
  id: string;
  expertType: string;
  displayName: LocalizedText;
  source: string;
  invalid: boolean;
  reason?: string;
}

/** ExpertMember is metadata used by a WebUI member card. Runtime definitions
 * remain authoritative for prompts and execution capability overrides. */
export interface ExpertMember {
  id: string;
  name: LocalizedText;
  profession?: LocalizedText;
  avatar?: string;
  role: string;
}

/** ExpertDetail is the inspect response for a single bundle. It deliberately
 * exposes manifest metadata only, never persona Markdown or tool prompts. */
export interface ExpertDetail {
  id: string;
  expertType: string;
  displayName: LocalizedText;
  categoryId?: string;
  quickPrompts?: LocalizedText[];
  defaultInitPrompt?: LocalizedText;
  members?: ExpertMember[];
  invalid: boolean;
  reason?: string;
}

/** SessionExpertState is the current session identity projection. A null
 * expert represents an explicitly unbound session. */
export interface SessionExpertState {
  sessionId: string;
  expert?: ExpertDetail | null;
}

export function expertSummaryFromRuntime(summary: Summary): ExpertSummary {
  return {
    id: summary.name,
    expertType: summary.expertType,
    displayName: summary.displayName,
    source: summary.source,
    invalid: summary.invalid,
    reason: summary.invalidReason,
  };
}

export function expertDetailFromBundle(
  bundle: Bundle | null,
): ExpertDetail | null {
  if (bundle === null) return null;
  const detail: ExpertDetail = {
    id: bundle.name,
    expertType: bundle.manifest.expertType,
    displayName: bundle.manifest.displayName,
    categoryId: bundle.manifest.categoryId,
    quickPrompts: bundle.manifest.quickPrompts
      ? [...bundle.manifest.quickPrompts]
      : undefined,
    defaultInitPrompt: bundle.manifest.defaultInitPrompt,
    invalid: bundle.invalid,
    reason: bundle.invalidReason,
  };
  if (bundle.manifest.members && bundle.manifest.members.length > 0) {
    detail.members = bundle.manifest.members.map((member) => ({
      id: member.id,
      name: member.name,
      profession: member.profession,
      avatar: member.avatar,
      role: member.role,
    }));
  }
  return detail;
}

export function expertWorkDir(server: Server, sessionID: string): string {
  if (!server || !server.cfg) throw ErrSessionNotFound;
  if (sessionID.trim() === "") return getWorkDir(server.cfg);
  const { workDir, found } = server.findSessionWorkDir(sessionID);
  if (!found) throw ErrSessionNotFound;
  return workDir;
}

/** listExperts returns the discoverable bundles for either the default work
 * directory or the authoritative work directory of sessionID. */
export function listExperts(
  server: Server,
  sessionID: string,
): ExpertSummary[] {
  const workDir = expertWorkDir(server, sessionID);
  const summaries = listExpertsRuntime(workDir);
  return summaries.map(expertSummaryFromRuntime);
}

/** inspectExpert returns one validated/displayable bundle for the same work
 * directory resolution as listExperts. It does not bind the session. */
export function inspectExpert(
  server: Server,
  sessionID: string,
  expertID: string,
): ExpertDetail {
  const workDir = expertWorkDir(server, sessionID);
  const bundle = inspectExpertRuntime(workDir, expertID);
  return expertDetailFromBundle(bundle)!;
}

export function isAllocatedSessionID(server: Server, id: string): boolean {
  if (!server || id === "") return false;
  return server.allocatedSessionIDs.has(id);
}

/**
 * sessionForExpertMutation opens an existing session, or materializes a
 * server-issued deferred WebUI session. Arbitrary unknown IDs are rejected so
 * an identity mutation cannot create an untracked session namespace.
 */
export async function sessionForExpertMutation(
  server: Server,
  id: string,
): Promise<APISession> {
  const { workDir, found } = server.findSessionWorkDir(id);
  if (!found) {
    if (!isAllocatedSessionID(server, id) || !server.cfg) {
      throw ErrSessionNotFound;
    }
    return await getOrCreateSession(server, id, getWorkDir(server.cfg));
  }
  return await getOrCreateSession(server, id, workDir);
}

/** getSessionExpert returns the Runtime-resolved identity of a persisted or
 * active WebUI session. It intentionally reuses the session Runtime instead
 * of reading expert_id or package files in this adapter. */
export async function getSessionExpert(
  server: Server,
  id: string,
): Promise<SessionExpertState> {
  const sess = await sessionForExpertMutation(server, id);
  const state: SessionExpertState = { sessionId: sess.id };
  if (!sess.runtime) return state;
  const { binding } = sess.runtime.expertState();
  if (binding !== null) {
    state.expert = expertDetailFromBundle(binding.bundle);
  }
  return state;
}

/** setSessionExpert is the Serve/WebUI identity transition. The Runtime owns
 * validation, session persistence and resource rehydration; the adapter only
 * rebuilds its manager/tool projection from the new Runtime state. */
export async function setSessionExpert(
  server: Server,
  signal: AbortSignal | undefined,
  id: string,
  expertID: string,
): Promise<SessionExpertState> {
  const sess = await sessionForExpertMutation(server, id);
  if (!sess.runtime || !sess.manager || !server.settings) {
    throw ErrSessionNotFound;
  }
  if ((expertID ?? "").trim() !== "") {
    const bundle = sess.runtime.inspectExpert(expertID);
    if (bundle.invalid) {
      throw new Error(
        `expert bundle ${
          JSON.stringify(bundle.name)
        } is invalid: ${bundle.invalidReason}`,
      );
    }
  }
  let guard;
  try {
    guard = await acquireSessionMutation(
      signal,
      getSessionDir(server.settings),
      sess.id,
      {},
    );
  } catch (err) {
    throw new SessionExpertMutationBusyError(
      `session expert identity cannot change while a run is active: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  try {
    if (!server.pool!.pin(sess)) throw ErrSessionNotFound;

    await sess.mu.lock();
    try {
      if (sess.isRunning()) throw ErrSessionExpertMutationBusy;
      await sess.runtime.setExpert(expertID);
      // SetExpert rehydrates Runtime resources. Rebuild all adapter aliases and
      // discard the old manager so roster/mailbox context cannot leak across an
      // identity change.
      sess.skillsMgr = sess.runtime.skillsMgr;
      sess.extraContext = sess.runtime.extraContext;
      sess.ruleContent = sess.runtime.ruleContent;
      sess.agentMgr = undefined;
      await syncSessionTools(server, sess, false);
      const state: SessionExpertState = { sessionId: sess.id };
      const { binding } = sess.runtime.expertState();
      if (binding !== null) {
        state.expert = expertDetailFromBundle(binding.bundle);
      }
      sess.touch();
      publishSessionStreamEvent(server, sess.id, "expert_changed", state);
      return state;
    } finally {
      sess.mu.unlock();
    }
  } finally {
    guard.release();
    server.pool!.unpin(sess);
  }
}

/** forkSessionWithExpert validates the requested child identity through the
 * source Runtime, then delegates the durable branch operation to the canonical
 * Runtime fork boundary. The source identity/history remains immutable. */
export async function forkSessionWithExpert(
  server: Server,
  _signal: AbortSignal | undefined,
  id: string,
  options: Omit<ForkOptions, "sourceSessionId">,
  expertID: string,
): Promise<ForkResult> {
  const sess = await sessionForExpertMutation(server, id);
  if (!sess.runtime) throw ErrSessionNotFound;
  if ((expertID ?? "").trim() !== "") {
    const bundle = sess.runtime.inspectExpert(expertID);
    if (bundle.invalid) {
      throw new Error(
        `expert bundle ${
          JSON.stringify(bundle.name)
        } is invalid: ${bundle.invalidReason}`,
      );
    }
  }
  return forkWithExpert(getSessionDir(server.settings!), {
    ...options,
    sourceSessionId: id,
  }, expertID);
}

/** isSessionExpertMutationBusy lets the HTTP adapter map Runtime lease
 * contention to the same 409 semantic used by other session mutations. */
export function isSessionExpertMutationBusy(err: unknown): boolean {
  let current: unknown = err;
  while (current instanceof Error) {
    if (
      current instanceof SessionRunActiveError ||
      current instanceof RuntimeLeaseBusyError ||
      current instanceof DetachedRemoteExecutionError
    ) {
      return true;
    }
    if (current.name === ErrSessionExpertMutationBusyName) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * wireExpertAPI fills the Server's expert identity-transition hook. Go
 * declares SetSessionExpert as a Server method; the port binds it explicitly
 * so tests and the serve assembly slice opt in.
 */
export function wireExpertAPI(server: Server): void {
  server.setSessionExpert ??= (signal, sessionId, expertId) =>
    setSessionExpert(server, signal, sessionId, expertId);
}
