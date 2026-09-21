// Ported from internal/serve/openaiapi/esm_api.go — the Server ESM control
// operations shared by the /esm slash command and the HTTP handlers: the
// WebUI snapshot projection, the create/edit/pause/resume/clear/guidance
// transitions, and the idle guards.
//
// Deviations: Go's methods on *Server map to exported functions taking the
// Server; the ESM store is synchronous in the Deno port. The lifecycle
// coordinator start/stop/running hooks (Go's esmCoordinator fields in
// esm_coordinator.go) are Server hooks filled by the coordinator slice; while
// startESM is unset the state transitions persist and publish without starting
// a continuation. Go's RFC3339Nano timestamps map to ISO-8601 (millisecond)
// strings.
import { ErrNotFound, ESMStore, type Objective } from "../../esm/mod.ts";
import {
  type ESMGuidance,
  listESMGuidance,
} from "../../session/esm_guidance.ts";
import { getSessionDir } from "../../config/settings.ts";
import { inspectSessionExecution } from "../../agentruntime/execution.ts";
import { publishSessionRuntimeById } from "./session_runtime_snapshot.ts";
import { esmStore } from "./handler_chat_session.ts";
import { ErrSessionNotFound } from "./session_mgr.ts";
import type { Server } from "./server.ts";

/**
 * ErrESMControlRequiresIdle keeps lifecycle-changing ESM controls aligned
 * with the TUI: a running lead may receive a new objective steering update,
 * but pause/resume/clear must not change the contract underneath it.
 */
export const ErrESMControlRequiresIdle = new Error(
  "ESM pause, resume, and clear require the current run to finish or be cancelled",
);

/** ESMSnapshot is the stable WebUI representation of an ESM objective. */
export interface ESMSnapshot {
  sessionId: string;
  esmId?: string;
  status: string;
  phase?: string;
  objective?: string;
  tokensUsed: number;
  timeUsedMs: number;
  blockedCount?: number;
  blockedReason?: string;
  completionReason?: string;
  completionReview?: string;
  progressSummary?: string;
  remainingWork?: string[];
  rejectionCount?: number;
  recoveryCount?: number;
  recoveryReason?: string;
  version?: string;
  createdAt?: string;
  updatedAt?: string;
  guidance?: ESMGuidance[];
}

function timestamp(value: Date): string {
  return value.toISOString();
}

export function esmSnapshot(obj: Objective | null): ESMSnapshot {
  if (!obj) {
    return { sessionId: "", status: "none", tokensUsed: 0, timeUsedMs: 0 };
  }
  return {
    sessionId: obj.sessionId,
    esmId: obj.esmId,
    status: obj.status,
    phase: obj.phase,
    objective: obj.objective,
    tokensUsed: obj.tokensUsed,
    timeUsedMs: obj.timeUsedMs,
    blockedCount: obj.blockedCount,
    blockedReason: obj.blockedReason,
    completionReason: obj.completionReason,
    completionReview: obj.completionReview,
    progressSummary: obj.progressSummary,
    remainingWork: obj.remainingWork ? [...obj.remainingWork] : undefined,
    rejectionCount: obj.rejectionCount,
    recoveryCount: obj.recoveryCount,
    recoveryReason: obj.recoveryReason,
    version: timestamp(obj.updatedAt),
    createdAt: timestamp(obj.createdAt),
    updatedAt: timestamp(obj.updatedAt),
  };
}

export function getESM(server: Server, sessionId: string): ESMSnapshot {
  if (sessionId === "") throw ErrSessionNotFound;
  const store = esmStore(server);
  if (!store) throw ErrSessionNotFound;
  let out: ESMSnapshot;
  try {
    const obj = store.get(sessionId);
    out = esmSnapshot(obj);
  } catch (err) {
    if (err === ErrNotFound) {
      return { sessionId, status: "none", tokensUsed: 0, timeUsedMs: 0 };
    }
    throw err;
  }
  out.sessionId = sessionId;
  const sessionDir = server.settings ? getSessionDir(server.settings) : "";
  if (sessionDir !== "") {
    try {
      out.guidance = listESMGuidance(sessionDir, sessionId, "pending", 100);
    } catch {
      // Go ignores guidance listing failures the same way.
    }
  }
  return out;
}

export function publishESM(
  server: Server,
  sessionId: string,
  snapshot: ESMSnapshot,
): void {
  if (!server || !snapshot) return;
  server.getEventBroker().publishRawJSON(sessionId, "", "esm.updated", {
    snapshot,
    version: snapshot.version,
  });
  publishSessionRuntimeById(server, sessionId);
}

export function createESM(
  server: Server,
  sessionId: string,
  objective: string,
): ESMSnapshot {
  const store = requireStore(server);
  const obj = store.create(sessionId, objective);
  const out = esmSnapshot(obj);
  publishESM(server, sessionId, out);
  server.startESM?.(sessionId);
  return out;
}

export function editESM(
  server: Server,
  sessionId: string,
  objective: string,
): ESMSnapshot {
  const store = requireStore(server);
  const obj = store.edit(sessionId, objective);
  const out = esmSnapshot(obj);
  publishESM(server, sessionId, out);
  server.startESM?.(sessionId);
  return out;
}

export async function pauseESM(
  server: Server,
  sessionId: string,
): Promise<ESMSnapshot> {
  // A control action may explicitly cancel this process's ESM continuation,
  // but it must never change an objective underneath a foreground or external
  // run. Check first, stop the owned continuation, then verify the canonical
  // execution state once more before persisting the transition.
  requireESMControlIdle(server, sessionId, true);
  await stopESMForControl(server, sessionId);
  requireESMControlIdle(server, sessionId, false);
  const store = requireStore(server);
  const obj = store.pause(sessionId);
  const out = esmSnapshot(obj);
  publishESM(server, sessionId, out);
  return out;
}

export function resumeESM(server: Server, sessionId: string): ESMSnapshot {
  requireESMControlIdle(server, sessionId, false);
  const store = requireStore(server);
  const obj = store.resume(sessionId);
  const out = esmSnapshot(obj);
  publishESM(server, sessionId, out);
  server.startESM?.(sessionId);
  return out;
}

export async function clearESM(
  server: Server,
  sessionId: string,
): Promise<void> {
  requireESMControlIdle(server, sessionId, true);
  await stopESMForControl(server, sessionId);
  requireESMControlIdle(server, sessionId, false);
  const store = requireStore(server);
  store.clear(sessionId);
  publishESM(server, sessionId, {
    sessionId,
    status: "none",
    tokensUsed: 0,
    timeUsedMs: 0,
  });
}

/**
 * requireESMControlIdle checks both the local adapter projection and the
 * durable Runtime projection. The local check avoids a race before a WebUI
 * foreground run has written its durable row; the durable check covers a run
 * owned by another Serve process. A pause/clear action may cancel the local
 * ESM coordinator it owns, but never an unrelated foreground execution.
 */
export function requireESMControlIdle(
  server: Server | null,
  sessionId: string,
  allowOwnedCoordinator: boolean,
): void {
  if (!server || sessionId === "") throw ErrSessionNotFound;
  const ownedCoordinator = allowOwnedCoordinator &&
    (server.esmCoordinatorRunning?.(sessionId) ?? false);
  if (server.pool) {
    const sess = server.pool.getExact(sessionId);
    if (sess && sess.isRunning() && !ownedCoordinator) {
      throw ErrESMControlRequiresIdle;
    }
  }
  if (!server.settings || getSessionDir(server.settings) === "") return;
  const snapshot = inspectSessionExecution(
    getSessionDir(server.settings),
    sessionId,
  );
  if (snapshot.busy && !ownedCoordinator) {
    throw ErrESMControlRequiresIdle;
  }
}

export function addESMGuidance(
  server: Server,
  sessionId: string,
  version: string,
  text: string,
): ESMSnapshot {
  validateESMVersion(server, sessionId, version);
  const store = requireStore(server);
  // The core owns guidance persistence, version stamping, injection, and
  // consumption so TUI and WebUI share one lifecycle.
  store.addGuidance(sessionId, text);
  const out = getESM(server, sessionId);
  publishESM(server, sessionId, out);
  server.startESM?.(sessionId);
  return out;
}

export function validateESMVersion(
  server: Server,
  sessionId: string,
  version: string,
): void {
  if (version.trim() === "") return;
  const current = getESM(server, sessionId);
  if (current.version !== version) {
    throw new Error("esm objective changed; reload and try again");
  }
}

function requireStore(server: Server): ESMStore {
  const store = esmStore(server);
  if (!store) throw ErrSessionNotFound;
  return store;
}

/**
 * stopESMForControl awaits the explicit cancellation boundary used by pause
 * and clear (Go's stopESMForControl). While the coordinator hook is unset the
 * server owns no continuation and the stop is a no-op.
 */
async function stopESMForControl(
  server: Server,
  sessionId: string,
): Promise<void> {
  const stop = server.stopESMForControl;
  if (!stop) return;
  await stop.call(server, sessionId);
}
