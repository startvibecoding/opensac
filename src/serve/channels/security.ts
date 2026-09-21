// Ported from internal/serve/channels/security.go — user whitelist validation
// and smart approval logic for messaging channel mode.
//
// Deviation: util.IsWithinPath is async in the port (it resolves symlinks), so
// CheckWorkDirAllowed returns a Promise.

import { classifyBashCommand } from "../../agentruntime/mod.ts";
import { isWithinPath } from "../../util/path.ts";
import type { Config } from "./config.ts";

/** Security provides whitelist validation and smart approval logic for channel mode. */
export class Security {
  #cfg: Config;

  constructor(cfg: Config) {
    this.#cfg = cfg;
  }

  /** Returns an error string if the working directory is not allowed. */
  async checkWorkDirAllowed(workDir: string): Promise<string | null> {
    const allowed = this.#cfg.security.allowedWorkDirs;
    if (allowed.length === 0) {
      // No restriction
      return null;
    }

    for (const dir of allowed) {
      if (await isWithinPath(dir, workDir)) {
        return null;
      }
    }

    return `working directory ${workDir} not in allowed_work_dirs`;
  }

  /**
   * ShouldAutoApprove returns true if the tool call can be auto-approved in
   * messaging channel mode. Bots run unattended so the rules are stricter.
   */
  shouldAutoApprove(
    toolName: string,
    args: Record<string, unknown> | null,
    mode: string,
  ): boolean {
    if (!this.#cfg.security.smartApprovals) {
      // Smart approvals disabled — fall back to mode-based behavior
      return mode === "yolo" || mode === "os";
    }

    switch (toolName) {
      case "read":
      case "ls":
      case "grep":
      case "find":
      case "skill_ref":
      case "memory":
      case "plan":
      case "jobs":
        // Read-only tools: always auto-approve
        return true;

      case "write":
      case "edit":
        // File modifications: auto-approve in agent/yolo mode
        return mode === "agent" || mode === "yolo" || mode === "os";

      case "bash": {
        const command = typeof args?.["command"] === "string"
          ? args["command"] as string
          : "";
        const risk = commandRiskLevel(command);
        switch (mode) {
          case "yolo":
          case "os":
            return risk !== "high"; // yolo/os still block high-risk
          case "agent":
            return risk === "low"; // agent only auto-approves low-risk
        }
        return false;
      }

      case "kill":
        return mode === "agent" || mode === "yolo" || mode === "os";

      default:
        return mode === "yolo" || mode === "os";
    }
  }
}

/** Classifies the risk level of a bash command: "low", "medium", or "high". */
export function commandRiskLevel(command: string): "low" | "medium" | "high" {
  return classifyBashCommand(command);
}

/** ApprovalDecision represents the result of an approval check. */
export interface ApprovalDecision {
  approved: boolean;
  reason: string;
  riskLevel: string;
}

/** Formats a notification for medium/high risk tool calls. */
export function formatApprovalNotification(
  toolName: string,
  args: Record<string, unknown>,
  riskLevel: string,
  approved: boolean,
): string {
  const icon = approved ? "⚠️" : "🚫";
  const status = approved ? "auto-approved" : "blocked";

  let detail = "";
  if (toolName === "bash") {
    if (args["command"] !== undefined) {
      const cmdStr = String(args["command"]);
      detail = cmdStr.length > 80 ? cmdStr.slice(0, 80) + "..." : cmdStr;
    }
  } else {
    if (args["path"] !== undefined) {
      detail = String(args["path"]);
    }
  }

  if (detail !== "") {
    return `${icon} [${toolName}] ${detail} ${status} (${riskLevel} risk)`;
  }
  return `${icon} [${toolName}] ${status} (${riskLevel} risk)`;
}
