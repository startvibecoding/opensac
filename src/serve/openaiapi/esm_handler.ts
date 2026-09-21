// Ported from internal/serve/openaiapi/esm_handler.go — HandleESMAPI serves
// graphical WebUI ESM controls, not TUI commands.
//
// Deviations: Go's method maps to an exported function taking the Server (the
// route binding itself lives in the run.go assembly slice, which has not been
// ported yet); `json.NewDecoder(io.LimitReader(...))` maps to a 1MiB-bounded
// `request.json()` decode; the `http.ResponseWriter` maps to returning a
// Response.
import type { Server } from "./server.ts";
import { writeError, writeJSON } from "./auth.ts";
import { ErrSessionNotFound } from "./session_mgr.ts";
import { ErrESMControlRequiresIdle } from "./esm_api.ts";
import {
  addESMGuidance,
  clearESM,
  createESM,
  editESM,
  type ESMSnapshot,
  getESM,
  pauseESM,
  resumeESM,
  validateESMVersion,
} from "./esm_api.ts";

/** ESMControlRequest contains user-controlled ESM fields exposed by WebUI. */
export interface ESMControlRequest {
  objective?: string;
  version?: string;
}

/** HandleESMAPI serves the /api/sessions/{id}/esm[/action] control surface. */
export async function handleESMAPI(
  server: Server,
  request: Request,
): Promise<Response> {
  const parts = new URL(request.url).pathname
    .replace(/^\/api\/sessions\//, "")
    .replace(/^\/+|\/+$/g, "")
    .split("/");
  if (parts.length < 2 || parts[0] === "" || parts[1] !== "esm") {
    return writeError(400, "invalid ESM path", "invalid_request_error");
  }
  const id = parts[0];
  if (parts.length === 2) {
    switch (request.method) {
      case "GET": {
        let v: ESMSnapshot;
        try {
          v = getESM(server, id);
        } catch (err) {
          return writeESMError(err);
        }
        return writeJSON(200, v);
      }
      case "POST": {
        let req: ESMControlRequest;
        try {
          req = await decodeControlRequest(request);
        } catch (err) {
          return writeError(
            400,
            `invalid JSON: ${(err as Error).message}`,
            "invalid_request_error",
          );
        }
        try {
          validateESMVersion(server, id, req.version ?? "");
          const v = createESM(server, id, req.objective ?? "");
          return writeJSON(200, v);
        } catch (err) {
          return writeESMError(err);
        }
      }
      case "PATCH": {
        let req: ESMControlRequest;
        try {
          req = await decodeControlRequest(request);
        } catch (err) {
          return writeError(
            400,
            `invalid JSON: ${(err as Error).message}`,
            "invalid_request_error",
          );
        }
        try {
          validateESMVersion(server, id, req.version ?? "");
          if ((req.objective ?? "").trim() === "") {
            return writeError(
              400,
              "objective is required",
              "invalid_request_error",
            );
          }
          const v = editESM(server, id, req.objective ?? "");
          return writeJSON(200, v);
        } catch (err) {
          return writeESMError(err);
        }
      }
      case "DELETE": {
        try {
          await clearESM(server, id);
        } catch (err) {
          return writeESMError(err);
        }
        return writeJSON(200, {
          sessionId: id,
          status: "none",
          tokensUsed: 0,
          timeUsedMs: 0,
        });
      }
      default:
        return new Response(null, { status: 405 });
    }
  }
  if (parts.length !== 3) {
    return writeError(400, "invalid ESM action", "invalid_request_error");
  }
  let v: ESMSnapshot;
  switch (parts[2]) {
    case "guidance": {
      if (request.method !== "POST") {
        return new Response(null, { status: 405 });
      }
      let req: { guidance?: string; version?: string };
      try {
        req = await decodeControlRequest(request);
      } catch (err) {
        return writeError(
          400,
          `invalid JSON: ${(err as Error).message}`,
          "invalid_request_error",
        );
      }
      try {
        v = addESMGuidance(server, id, req.version ?? "", req.guidance ?? "");
      } catch (err) {
        return writeESMError(err);
      }
      break;
    }
    case "pause": {
      if (request.method !== "POST") {
        return new Response(null, { status: 405 });
      }
      try {
        v = await pauseESM(server, id);
      } catch (err) {
        return writeESMError(err);
      }
      break;
    }
    case "resume": {
      if (request.method !== "POST") {
        return new Response(null, { status: 405 });
      }
      try {
        v = resumeESM(server, id);
      } catch (err) {
        return writeESMError(err);
      }
      break;
    }
    default:
      return writeError(404, "unknown ESM action", "not_found");
  }
  return writeJSON(200, v);
}

/** decodeControlRequest bounds and decodes the 1MiB JSON control body. */
async function decodeControlRequest(
  request: Request,
): Promise<ESMControlRequest> {
  const body = await request.text();
  if (body.length > 1 << 20) {
    throw new Error("body exceeds limit");
  }
  const parsed: unknown = body.trim() === "" ? {} : JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected a JSON object");
  }
  return parsed as ESMControlRequest;
}

/** writeESMError projects ESM control failures onto the HTTP status space. */
export function writeESMError(err: unknown): Response {
  let status = 500;
  const msg = err instanceof Error ? err.message : String(err);
  if (err === ErrSessionNotFound) {
    status = 404;
  } else if (err === ErrESMControlRequiresIdle) {
    status = 409;
  } else if (
    msg.includes("changed") || msg.includes("already exists") ||
    msg.includes("invalid esm status")
  ) {
    status = 409;
  } else if (
    msg.includes("cannot be empty") || msg.includes("positive") ||
    msg.includes("invalid")
  ) {
    status = 400;
  }
  return writeError(status, msg, "esm_error");
}
