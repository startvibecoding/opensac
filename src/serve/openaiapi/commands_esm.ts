// Ported from internal/serve/openaiapi/commands_esm.go — the /esm slash
// command with TUI parity. WebUI ESM control uses the same /esm command as the
// TUI instead of dedicated graphical controls; the command runs through the
// shared Server ESM operations (esm_api.ts), so chat input and API stay on one
// path. input is the full trimmed command line; objective and guidance text
// keep their raw spacing.
import {
  ErrInvalidObjective,
  ErrInvalidTransition,
  ErrNotFound,
  ErrObjectiveExists,
  type Objective,
} from "../../esm/mod.ts";
import { formatObjective } from "../../esm/tools.ts";
import type { APISession } from "./session_mgr.ts";
import type { Server } from "./server.ts";
import type { CommandResult } from "./commands.ts";
import {
  addESMGuidance,
  clearESM,
  createESM,
  editESM,
  pauseESM,
  resumeESM,
} from "./esm_api.ts";
import { esmStore } from "./handler_chat_session.ts";

/** cmdESM implements the /esm slash command with TUI parity. */
export async function cmdESM(
  server: Server,
  sess: APISession | null,
  input: string,
): Promise<CommandResult> {
  if (!sess || sess.id === "") {
    return { message: "No active session for ESM.", error: true };
  }
  const sessionId = sess.id;
  const store = esmStore(server);
  if (!store) {
    return { message: "ESM storage is unavailable.", error: true };
  }
  const raw = input.replace(/^\/esm/, "").trim();
  if (raw === "" || raw === "status") {
    try {
      const obj = store.get(sessionId);
      return { message: formatESMCommandStatus(obj), error: false };
    } catch (err) {
      if (err === ErrNotFound) {
        return {
          message:
            "Enable Supervisor Mode\nStatus: none\n\nCreate one with /esm <objective>.",
          error: false,
        };
      }
      return { message: esmCommandErrorText(err), error: true };
    }
  }

  const [sub, rest] = splitESMCommand(raw);
  let err: unknown = undefined;
  let note = "";
  switch (sub) {
    case "edit":
      if (rest === "") {
        return { message: "Usage: /esm edit <objective>", error: true };
      }
      try {
        editESM(server, sessionId, rest);
      } catch (e) {
        err = e;
      }
      break;
    case "pause":
      if (rest !== "") {
        return { message: "Usage: /esm pause", error: true };
      }
      try {
        await pauseESM(server, sessionId);
      } catch (e) {
        err = e;
      }
      break;
    case "resume":
      if (rest !== "") {
        return { message: "Usage: /esm resume", error: true };
      }
      try {
        resumeESM(server, sessionId);
      } catch (e) {
        err = e;
      }
      break;
    case "clear":
      if (rest !== "") {
        return { message: "Usage: /esm clear", error: true };
      }
      try {
        await clearESM(server, sessionId);
        return { message: "Enable Supervisor Mode cleared.", error: false };
      } catch (e) {
        err = e;
      }
      break;
    case "guide":
      if (rest === "") {
        return { message: "Usage: /esm guide <text>", error: true };
      }
      try {
        addESMGuidance(server, sessionId, "", rest);
      } catch (e) {
        err = e;
      }
      note = "Guidance queued for the next ESM role run.";
      break;
    default:
      try {
        createESM(server, sessionId, raw);
      } catch (e) {
        err = e;
      }
  }
  if (err !== undefined) {
    return { message: esmCommandErrorText(err), error: true };
  }
  let obj: Objective;
  try {
    obj = store.get(sessionId);
  } catch (getErr) {
    return { message: esmCommandErrorText(getErr), error: true };
  }
  const message = formatESMCommandStatus(obj);
  return note === ""
    ? { message, error: false }
    : { message: `${note}\n${message}`, error: false };
}

export function splitESMCommand(raw: string): [string, string] {
  raw = raw.trim();
  if (raw === "") return ["", ""];
  const idx = raw.search(/[ \t]/);
  if (idx < 0) return [raw, ""];
  return [raw.slice(0, idx), raw.slice(idx + 1).trim()];
}

export function formatESMCommandStatus(obj: Objective | null): string {
  return formatObjective(obj) +
    "\n\nCommands: /esm edit <objective>, /esm pause, /esm resume, /esm clear, /esm guide <text>";
}

export function esmCommandErrorText(err: unknown): string {
  if (err === ErrNotFound) {
    return "No ESM objective. Create one with /esm <objective>.";
  }
  if (err === ErrObjectiveExists) {
    return "An unfinished ESM objective already exists. Use /esm edit <objective> or /esm clear.";
  }
  if (err === ErrInvalidObjective) {
    return "ESM objective cannot be empty.";
  }
  if (err === ErrInvalidTransition) {
    return "ESM status cannot be changed that way.";
  }
  return err instanceof Error ? err.message : String(err);
}
