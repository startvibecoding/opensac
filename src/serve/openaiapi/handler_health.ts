// Ported from internal/serve/openaiapi/handler_health.go. The Go method binds
// to *Server; the Deno projection takes the Server as its first argument.
import type { Server } from "./server.ts";
import type { HealthResponse } from "./types.ts";
import { writeError, writeJSON } from "./auth.ts";

export function handleHealth(server: Server, req: Request): Response {
  if (req.method !== "GET") {
    return writeError(405, "method not allowed", "invalid_request_error");
  }
  const resp: HealthResponse = {
    status: "ok",
    version: server.version,
    // Go dereferences s.pool directly (Run always installs one); the port
    // tolerates a handler-only Server for the same reason.
    sessions: server.pool?.count() ?? 0,
  };
  return writeJSON(200, resp);
}
