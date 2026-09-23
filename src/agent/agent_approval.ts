// (decision logic).
//
// The Go file defines these as methods on *Agent, reading a.config.Mode,
// a.config.Allow, and a.config.Settings. The Agent struct is not ported yet, so
// the pure decision logic is exposed as functions over a minimal config view.
// The pending-decision coordination (RequestToolApproval/RequestQuestion and
// their handlers) stays with the Agent until it lands.

import {
  getAutoEdit,
  matchBashCommand,
  matchEditPath,
} from "../config/allow.ts";
import type { AllowConfig } from "../config/allow.ts";
import type { Settings } from "../config/settings.ts";

/** The subset of Agent config the approval decision depends on. */
export interface ApprovalConfig {
  /** Current execution mode: "plan", "agent", "yolo", or "os". */
  mode: string;
  /** Auto-approval rules (allow.json): autoEdit, editPaths, bash rules. */
  allow?: AllowConfig;
  /** Global settings carrying the approval whitelist/blacklist. */
  settings?: Settings;
}

/**
 * Reports whether a tool call needs user approval based on the current mode.
 */
export function needsApproval(
  cfg: ApprovalConfig,
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  if ((toolName === "write" || toolName === "edit") && cfg.mode === "agent") {
    // Auto-approve edits globally when autoEdit is on.
    if (cfg.allow !== undefined && getAutoEdit(cfg.allow)) {
      return false;
    }
    // Auto-approve edits whose path matches the allow.json whitelist.
    if (cfg.allow !== undefined) {
      const p = args["path"];
      if (typeof p === "string" && matchEditPath(cfg.allow, p)) {
        return false;
      }
    }
    return cfg.settings?.approval?.confirmBeforeWrite === true;
  }
  if (toolName !== "bash") {
    return false;
  }
  if (isBashBlacklisted(cfg, args)) {
    return true;
  }
  switch (cfg.mode) {
    case "plan":
      // Plan mode: no tools should be executed (read-only tools don't need
      // approval).
      return false;
    case "agent":
      // Agent mode: project allow rules and settings whitelists can skip
      // approval.
      if (isBashProjectAllowed(cfg, args)) {
        return false;
      }
      return !isBashWhitelisted(cfg, args);
    case "yolo":
    case "os":
      // YOLO and OS modes: allow bash unless explicitly blacklisted above.
      return false;
    default:
      return false;
  }
}

function isBashProjectAllowed(
  cfg: ApprovalConfig,
  args: Record<string, unknown>,
): boolean {
  if (cfg.allow === undefined) return false;
  const arg = bashCommandArg(args);
  if (arg === undefined) return false;
  return matchBashCommand(cfg.allow, arg);
}

function isBashWhitelisted(
  cfg: ApprovalConfig,
  args: Record<string, unknown>,
): boolean {
  if (cfg.settings === undefined) return false;
  const command = bashCommandArg(args);
  if (command === undefined) return false;
  for (const prefix of cfg.settings.approval?.bashWhitelist ?? []) {
    if (command.startsWith(prefix)) return true;
  }
  return false;
}

function isBashBlacklisted(
  cfg: ApprovalConfig,
  args: Record<string, unknown>,
): boolean {
  if (cfg.settings === undefined) return false;
  const command = bashCommandArg(args);
  if (command === undefined) return false;
  for (const prefix of cfg.settings.approval?.bashBlacklist ?? []) {
    if (command.startsWith(prefix)) return true;
  }
  return false;
}

/** Extracts a non-empty, trimmed bash command from the "command"/"cmd" args. */
export function bashCommandArg(
  args: Record<string, unknown>,
): string | undefined {
  for (const key of ["command", "cmd"]) {
    const raw = args[key];
    if (typeof raw !== "string") continue;
    const command = raw.trim();
    if (command !== "") return command;
  }
  return undefined;
}
