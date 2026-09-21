// Ported from internal/serve/mcp_api.go
//
// handleMCPConfig manages the global MCP configuration shared by all
// runtimes. It intentionally uses the same mcp.json schema and path as the
// TUI. The Go `*channelRuntime` receiver maps to free functions over the
// standard Request/Response types; the run.go slice registers them on the
// route table.

import {
  globalMCPPath,
  loadMCPConfig,
  type MCPConfig,
  normalizeMCPConfig,
  saveMCPConfig,
} from "../config/mcp.ts";
import { ProjectDirName } from "../config/paths.ts";
import { join } from "@std/path";
import { ErrSessionNotFound } from "../serve/openaiapi/session_mgr.ts";
import {
  type ActiveSessionInfo,
  ErrActiveSessionIDAmbiguous,
} from "../serve/openaiapi/session_mgr.ts";
import { writeJson } from "./http.ts";

/**
 * Narrow view of the run.go `activeSessionManager` for session-scoped MCP
 * config lookups; the full interface lands with the run.go slice.
 */
export interface ActiveSessionsView {
  listActiveSessions(): ActiveSessionInfo[];
}

const MCP_CONFIG_BODY_LIMIT = 1 << 20; // 1 MiB, Go's io.LimitReader bound

/** GET/PUT on the global mcp.json. */
export function handleMCPConfig(
  request: Request,
): Promise<Response> {
  return handleMCPConfigAtPath(request, globalMCPPath());
}

/** GET/PUT on an explicit mcp.json path (the Go `*AtPath` variant). */
export async function handleMCPConfigAtPath(
  request: Request,
  path: string,
): Promise<Response> {
  switch (request.method) {
    case "GET": {
      try {
        const cfg = loadServeMCPConfig(path);
        return writeJson(() => {}, 200, cfg);
      } catch (err) {
        return writeJson(() => {}, 500, { error: (err as Error).message });
      }
    }
    case "PUT": {
      let body: unknown;
      try {
        const raw = await request.arrayBuffer();
        if (raw.byteLength > MCP_CONFIG_BODY_LIMIT) {
          throw new Error("request body too large");
        }
        body = JSON.parse(new TextDecoder().decode(raw));
      } catch (err) {
        return writeJson(() => {}, 400, {
          error: "invalid MCP config: " + (err as Error).message,
        });
      }
      const cfg = body as MCPConfig;
      normalizeMCPConfig(cfg);
      try {
        saveMCPConfig(path, cfg);
      } catch (err) {
        return writeJson(() => {}, 500, { error: (err as Error).message });
      }
      return writeJson(() => {}, 200, cfg);
    }
    default:
      return new Response(null, { status: 405 });
  }
}

/**
 * Loads mcp.json for serving: a missing file yields an empty config (Go's
 * `os.ErrNotExist` branch) and every loaded config is normalized.
 */
export function loadServeMCPConfig(path: string): MCPConfig {
  try {
    const cfg = loadMCPConfig(path);
    normalizeMCPConfig(cfg);
    return cfg;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return {};
    }
    throw err;
  }
}

/** GET/PUT on the session work directory's project mcp.json. */
export async function handleSessionMCPConfig(
  request: Request,
  sessions: ActiveSessionsView | null,
  id: string,
): Promise<Response> {
  if (sessions === null) {
    return writeJson(() => {}, 503, { error: "API server not ready" });
  }
  let workDir: string;
  try {
    workDir = sessionWorkDir(sessions.listActiveSessions(), id);
  } catch (err) {
    if (err === ErrSessionNotFound) {
      return writeJson(() => {}, 404, { error: (err as Error).message });
    }
    return writeJson(() => {}, 400, { error: (err as Error).message });
  }
  return await handleMCPConfigAtPath(
    request,
    projectMCPPathForWorkDir(workDir),
  );
}

function projectMCPPathForWorkDir(workDir: string): string {
  // config.projectMCPPath resolves against the process project dir; the
  // session-scoped path joins the resolved work directory instead (Go:
  // filepath.Join(workDir, config.ProjectMCPPath()) where ProjectPath is
  // cwd-relative). Preserves meaningful trailing slashes via join.
  return join(workDir, ProjectDirName, "mcp.json");
}

/**
 * Resolves the work directory shared by every active session with the given
 * ID. Ambiguous IDs (multiple sessions with different work dirs) throw
 * ErrActiveSessionIDAmbiguous, unknown IDs throw ErrSessionNotFound.
 */
export function sessionWorkDir(
  items: ActiveSessionInfo[],
  id: string,
): string {
  let workDir = "";
  for (const item of items) {
    if (item.id !== id) continue;
    if (workDir !== "" && workDir !== item.workDir) {
      throw ErrActiveSessionIDAmbiguous;
    }
    workDir = item.workDir;
  }
  if (workDir === "") throw ErrSessionNotFound;
  return workDir;
}
