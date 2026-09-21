// Ported from internal/serve/openaiapi/skillhub_session.go — the SkillHub
// session state/install helpers (activateSkillForSession, the runtime settings
// snapshot, work-directory resolution, and the refresh/replace-state
// operations). The marketplace HTTP API that consumes them lands with the
// skillhub API slice.
//
// Deviation: Go's methods on *Server map to exported functions taking the
// Server; refreshSessionContext/validateWorkDir are async in the Deno port;
// Go's map + mutex pairs collapse to a Record and the async session
// CountedMutex; filepath.Clean maps to @std/path's posix normalize.
import { normalize } from "@std/path";
import {
  DefaultSkillHubOfficialHandle,
  getGlobalSkillsDir,
} from "../../config/settings.ts";
import type { APISession } from "./session_mgr.ts";
import type { Server } from "./server.ts";
import { getWorkDir, validateWorkDir } from "./config.ts";
import { sameWorkDir } from "./chat_support.ts";
import {
  getOrCreateSession,
  refreshSessionContext,
  validatePersistedSessionWorkDir,
} from "./handler_chat_session.ts";

/** SkillHubRuntime contains the serve settings needed by marketplace handlers. */
export interface SkillHubRuntime {
  globalSkillsDir?: string;
  defaultWorkDir?: string;
  defaultMarket?: string;
  defaultScope?: string;
  officialHandles?: string[];
}

/** SkillHubSessionState reports marketplace activation state for one API session. */
export interface SkillHubSessionState {
  sessionId?: string;
  workDir: string;
  activeSkills: string[];
}

/** skillHubRuntime returns a snapshot of marketplace-related runtime settings. */
export function skillHubRuntime(server: Server): SkillHubRuntime {
  if (!server) return {};
  const runtime: SkillHubRuntime = {};
  if (server.cfg) {
    runtime.defaultWorkDir = getWorkDir(server.cfg);
  }
  if (server.settings) {
    runtime.globalSkillsDir = getGlobalSkillsDir(server.settings);
    runtime.defaultMarket = server.settings.skillHub?.defaultMarket ?? "";
    runtime.defaultScope = server.settings.skillHub?.defaultInstallScope ?? "";
    runtime.officialHandles = server.settings.skillHub?.officialHandles
      ? [...server.settings.skillHub.officialHandles]
      : [];
  }
  if (!runtime.defaultMarket) runtime.defaultMarket = "skillhub.cn";
  if (!runtime.defaultScope) runtime.defaultScope = "project";
  if (!runtime.officialHandles || runtime.officialHandles.length === 0) {
    runtime.officialHandles = [DefaultSkillHubOfficialHandle];
  }
  return runtime;
}

/** resolveSkillHubWorkDir resolves a request workDir through the existing serve whitelist. */
export async function resolveSkillHubWorkDir(
  server: Server,
  sessionID: string,
  requested: string,
): Promise<string> {
  if (!server || !server.cfg) {
    throw new Error("API server not ready");
  }
  if (sessionID !== "") {
    const { workDir, found } = server.findSessionWorkDir(sessionID);
    if (found) {
      if (requested !== "" && !sameWorkDir(requested, workDir)) {
        throw new Error(
          `workDir ${JSON.stringify(requested)} does not match session ${
            JSON.stringify(sessionID)
          } workDir ${JSON.stringify(workDir)}`,
        );
      }
      await validatePersistedSessionWorkDir(server, workDir);
      return normalize(workDir);
    }
  }
  let workDir = requested;
  if (workDir === "") {
    workDir = getWorkDir(server.cfg);
  }
  if (!sameWorkDir(workDir, getWorkDir(server.cfg))) {
    await validateWorkDir(server.cfg, workDir);
  }
  return normalize(workDir);
}

/**
 * inspectSkillHubSession returns SkillHub state without materializing an unknown
 * session. Read-only SkillHub requests can run before the WebUI submits the first
 * run, so creating a session here would incorrectly bind it to the serve default
 * workDir when an older client omitted its still-optimistic workDir.
 */
export async function inspectSkillHubSession(
  server: Server,
  sessionID: string,
  requestedWorkDir: string,
): Promise<SkillHubSessionState> {
  const workDir = await resolveSkillHubWorkDir(
    server,
    sessionID,
    requestedWorkDir,
  );
  if (sessionID === "") {
    return { workDir, activeSkills: [] };
  }
  const { found } = server.findSessionWorkDir(sessionID);
  if (!found) {
    return { sessionId: sessionID, workDir, activeSkills: [] };
  }
  return await refreshSkillHubSession(server, sessionID, workDir, "");
}

/** refreshSkillHubSessionMany refreshes a session and activates all requested skills. */
export async function refreshSkillHubSessionMany(
  server: Server,
  sessionID: string,
  requestedWorkDir: string,
  names: string[],
): Promise<SkillHubSessionState> {
  const workDir = await resolveSkillHubWorkDir(
    server,
    sessionID,
    requestedWorkDir,
  );
  const sess = await getOrCreateSession(server, sessionID, workDir);
  if (!server.pool!.pin(sess)) {
    throw new Error("session is no longer active");
  }
  try {
    await sess.mu.lock();
    try {
      const previous: Record<string, boolean> = {};
      for (const [name, enabled] of Object.entries(sess.activeSkills)) {
        previous[name] = enabled;
      }
      for (const raw of names) {
        const name = raw.trim();
        if (name === "") continue;
        if (!sess.skillsMgr || !sess.skillsMgr.get(name)) {
          sess.activeSkills = previous;
          throw new Error(`skill not found: ${name}`);
        }
        sess.activeSkills[name] = true;
      }
      try {
        await refreshSessionContext(server, sess);
      } catch (err) {
        sess.activeSkills = previous;
        try {
          await refreshSessionContext(server, sess);
        } catch {
          // Go ignores the rollback refresh failure.
        }
        throw err;
      }
      return skillHubSessionState(sess);
    } finally {
      sess.mu.unlock();
    }
  } finally {
    server.pool!.unpin(sess);
  }
}

/** setActiveSkillsForSession replaces the active skill set for a session. */
export async function setActiveSkillsForSession(
  server: Server,
  sessionID: string,
  requestedWorkDir: string,
  names: string[],
): Promise<SkillHubSessionState> {
  const workDir = await resolveSkillHubWorkDir(
    server,
    sessionID,
    requestedWorkDir,
  );
  const sess = await getOrCreateSession(server, sessionID, workDir);
  if (!server.pool!.pin(sess)) {
    throw new Error("session is no longer active");
  }
  try {
    await sess.mu.lock();
    try {
      await setActiveSkillsLocked(server, sess, names);
      return skillHubSessionState(sess);
    } finally {
      sess.mu.unlock();
    }
  } finally {
    server.pool!.unpin(sess);
  }
}

export async function setActiveSkillsLocked(
  server: Server,
  sess: APISession,
  names: string[],
): Promise<void> {
  const next: Record<string, boolean> = {};
  for (const raw of names) {
    const name = raw.trim();
    if (name === "") continue;
    if (!sess.skillsMgr || !sess.skillsMgr.get(name)) {
      throw new Error(`skill not found: ${name}`);
    }
    next[name] = true;
  }
  const previous = sess.activeSkills;
  sess.activeSkills = next;
  try {
    await refreshSessionContext(server, sess);
  } catch (err) {
    sess.activeSkills = previous;
    try {
      await refreshSessionContext(server, sess);
    } catch {
      // Go ignores the rollback refresh failure.
    }
    throw err;
  }
}

export async function refreshSkillHubSession(
  server: Server,
  sessionID: string,
  requestedWorkDir: string,
  activate: string,
): Promise<SkillHubSessionState> {
  const workDir = await resolveSkillHubWorkDir(
    server,
    sessionID,
    requestedWorkDir,
  );
  const sess = await getOrCreateSession(server, sessionID, workDir);
  if (!server.pool!.pin(sess)) {
    throw new Error("session is no longer active");
  }
  try {
    await sess.mu.lock();
    try {
      if (activate !== "") {
        await activateSkillForSession(server, sess, activate);
      } else {
        await refreshSessionContext(server, sess);
      }
      return skillHubSessionState(sess);
    } finally {
      sess.mu.unlock();
    }
  } finally {
    server.pool!.unpin(sess);
  }
}

export async function activateSkillForSession(
  server: Server,
  sess: APISession,
  name: string,
): Promise<void> {
  if (!sess) throw new Error("no active session");
  const previous = sess.activeSkills[name] ?? false;
  sess.activeSkills[name] = true;
  try {
    await refreshSessionContext(server, sess);
  } catch (err) {
    if (!previous) delete sess.activeSkills[name];
    throw err;
  }
  if (!sess.skillsMgr || !sess.skillsMgr.get(name)) {
    if (!previous) {
      delete sess.activeSkills[name];
      try {
        await refreshSessionContext(server, sess);
      } catch {
        // Go ignores the rollback refresh failure.
      }
    }
    throw new Error(`skill not found: ${name}`);
  }
}

export function skillHubSessionState(sess: APISession): SkillHubSessionState {
  const names: string[] = [];
  for (const [name, enabled] of Object.entries(sess.activeSkills)) {
    if (enabled) names.push(name);
  }
  names.sort();
  return {
    sessionId: sess.id,
    workDir: sess.workDir,
    activeSkills: names,
  };
}
