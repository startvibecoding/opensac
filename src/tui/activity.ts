// Ported from internal/tui/activity.go: folds the agent event stream of
// background/team agents into per-agent activity snapshots, and renders those
// snapshots for the status line and the tool modal's agent tabs.
//
// The store owns state folding only (`record(event, now)`); rendering takes
// snapshots, mirroring the Go split between App state and render helpers.

import type { Event } from "../agent/events.ts";
import type { AgentID } from "../../sdk/agent/types.ts";
import {
  EventDone,
  EventError,
  EventHostedItem,
  EventQuestionRequest,
  EventQuestionResponse,
  EventRetry,
  EventRunFinished,
  EventStatus,
  EventTextDelta,
  EventThinkDelta,
  EventToolApprovalRequest,
  EventToolApprovalResponse,
  EventToolCall,
  EventToolExecutionEnd,
  EventToolExecutionStart,
  EventToolResult,
  TaskCanceled,
  TaskFailed,
} from "../agent/events.ts";
import { sprintf } from "./i18n.ts";
import {
  classifyError,
  displayErrorMessage,
  PhaseModel,
  PhaseTool,
  SideEffectUnknown,
} from "../agentruntime/error_info.ts";
import { Translator } from "./i18n.ts";

export const MAX_ACTIVITY_LINES = 200;

export interface ActivityLine {
  time: Date;
  text: string;
}

/** One agent's folded activity snapshot. */
export interface AgentActivity {
  agentId: AgentID;
  memberId?: string;
  memberDisplayName?: string;
  memberEmoji?: string;
  kind: string;
  state: string;
  lastThink: string;
  lastText: string;
  lastTool: string;
  lastResult: string;
  fullThink: string;
  fullText: string;
  fullResult: string;
  lastToolName: string;
  lastToolArgs?: Record<string, unknown>;
  updatedAt?: Date;
  events: ActivityLine[];
}

/** Folds agent events into ordered activity snapshots. */
export class AgentActivityStore {
  #activities = new Map<string, AgentActivity>();
  #order: string[] = [];

  /** Ordered agent IDs of every tracked activity. */
  get order(): string[] {
    return [...this.#order];
  }

  get(id: string): AgentActivity | undefined {
    return this.#activities.get(id);
  }

  get size(): number {
    return this.#activities.size;
  }

  /** Drops every tracked activity (Go /clear). */
  clear(): void {
    this.#activities.clear();
    this.#order = [];
  }

  /** Whether this event belongs to a background/team agent (not the lead). */
  static isBackgroundAgentEvent(event: Event, leadAgentId?: string): boolean {
    if (!event.agentId) return false;
    if (leadAgentId !== undefined && event.agentId === leadAgentId) {
      return false;
    }
    switch (event.type) {
      case EventToolApprovalRequest:
      case EventToolApprovalResponse:
      case EventQuestionRequest:
      case EventQuestionResponse:
        return false;
      default:
        return true;
    }
  }

  /** Folds one event into the store. */
  record(event: Event, now: Date = new Date()): void {
    const id = event.agentId;
    if (!id) return;

    let act = this.#activities.get(id);
    if (!act) {
      act = {
        agentId: id,
        kind: id.startsWith("workflow:") ? "workflow" : "subagent",
        state: "running",
        lastThink: "",
        lastText: "",
        lastTool: "",
        lastResult: "",
        fullThink: "",
        fullText: "",
        fullResult: "",
        lastToolName: "",
        events: [],
      };
      this.#activities.set(id, act);
      if (!this.#order.includes(id)) this.#order.push(id);
    }

    if (event.memberId) {
      act.memberId = event.memberId;
      act.memberDisplayName = event.memberDisplayName;
      act.memberEmoji = event.memberEmoji;
    }

    act.updatedAt = now;
    switch (event.type) {
      case EventStatus: {
        if (event.retryStatus) break;
        if (event.statusMessage) {
          act.lastResult = truncatePlain(event.statusMessage, 160);
          this.#appendLine(act, now, event.statusMessage);
        }
        break;
      }
      case EventRetry: {
        act.state = "running";
        const line = retryStatusMessage(event);
        act.lastResult = truncatePlain(line, 160);
        this.#appendLine(act, now, line);
        break;
      }
      case EventThinkDelta: {
        act.state = "running";
        act.lastThink = truncatePlain(
          act.lastThink + (event.thinkDelta ?? ""),
          240,
        );
        act.fullThink += event.thinkDelta ?? "";
        break;
      }
      case EventTextDelta: {
        act.state = "running";
        act.lastText = truncatePlain(
          act.lastText + (event.textDelta ?? ""),
          320,
        );
        act.fullText += event.textDelta ?? "";
        break;
      }
      case EventHostedItem: {
        act.state = "running";
        if (event.hostedItem) {
          let line = "activity.hosted_item";
          if (event.hostedItem.type) line += ` [${event.hostedItem.type}]`;
          if (event.hostedItem.status) line += `: ${event.hostedItem.status}`;
          act.lastResult = truncatePlain(line, 160);
          this.#appendLine(act, now, line);
        }
        break;
      }
      case EventToolCall:
      case EventToolExecutionStart: {
        act.state = "running";
        let name = event.toolName ?? "";
        if (!name && event.toolCall) name = event.toolCall.name;
        if (name) {
          act.lastTool = formatActivityTool(name, event.toolArgs);
          act.lastToolName = name;
          act.lastToolArgs = event.toolArgs;
          this.#appendLine(
            act,
            now,
            sprintfMessage(
              "activity.tool_started",
              formatDetailedActivityTool(name, event.toolArgs),
            ),
          );
        }
        break;
      }
      case EventToolResult:
      case EventToolExecutionEnd: {
        let name = event.toolName ?? "";
        if (!name && event.toolCall) name = event.toolCall.name;
        let result = (event.toolResult ?? "").trim();
        if (event.toolError) {
          act.state = "error";
          const info = classifyError(event.toolError, {
            phase: PhaseTool,
            sideEffectState: SideEffectUnknown,
          });
          result = displayErrorMessage(info);
        }
        if (result) {
          act.lastResult = truncatePlain(result, 320);
          act.fullResult = result;
        }
        if (name || result) {
          let line = "activity.tool_result";
          if (name) line += ` [${name}]`;
          if (result) line += ":\n" + result;
          this.#appendLine(act, now, line);
        }
        break;
      }
      case EventRunFinished: {
        if (isTerminalActivityState(act.state)) break;
        switch (event.status) {
          case TaskFailed: {
            act.state = "error";
            const message = activityFailureMessage(event.error);
            act.lastResult = truncatePlain(message, 320);
            act.fullResult = message;
            this.#appendLine(
              act,
              now,
              sprintfMessage("activity.error", message),
            );
            break;
          }
          case TaskCanceled:
            act.state = "canceled";
            this.#appendLine(act, now, "activity.canceled");
            break;
          default:
            act.state = "done";
            this.#appendLine(act, now, "activity.done");
        }
        break;
      }
      case EventDone: {
        if (isTerminalActivityState(act.state)) break;
        act.state = "done";
        this.#appendLine(act, now, "activity.done");
        break;
      }
      case EventError: {
        if (isTerminalActivityState(act.state)) break;
        act.state = "error";
        const message = activityFailureMessage(event.error);
        act.lastResult = truncatePlain(message, 320);
        act.fullResult = message;
        this.#appendLine(act, now, sprintfMessage("activity.error", message));
        break;
      }
    }
  }

  #appendLine(act: AgentActivity, time: Date, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    act.events.push({ time, text: trimmed });
    if (act.events.length > MAX_ACTIVITY_LINES) {
      act.events = act.events.slice(act.events.length - MAX_ACTIVITY_LINES);
    }
  }
}

// The Go store renders through the Translator inline; the TS store records
// message IDs for i18n-coupled lines and the renderer resolves them. Events
// that start as literal text (status messages) are stored as-is.

function sprintfMessage(id: string, arg: string): string {
  // activity.tool_started / activity.error take one %s argument; resolve the
  // English text at record time so the timeline stays readable in snapshots.
  return new Translator("en").text(id, arg);
}

function retryStatusMessage(event: Event): string {
  const attempt = event.retryAttempt ?? 0;
  const max = event.retryMaxAttempts ?? 0;
  if (event.retryReason) {
    return `retrying (${attempt}${max ? `/${max}` : ""}): ${event.retryReason}`;
  }
  return `retrying (${attempt}${max ? `/${max}` : ""})`;
}

function activityFailureMessage(err?: Error): string {
  const info = classifyError(err ?? new Error("unknown error"), {
    phase: PhaseModel,
  });
  const message = displayErrorMessage(info).trim();
  return message || "The run could not be completed.";
}

function isTerminalActivityState(state: string): boolean {
  return state === "done" || state === "error" || state === "canceled";
}

// ─── formatting / rendering ─────────────────────────────────────────────────

/** Compact tool call summary: name(key="value", ...). */
export function formatActivityTool(
  name: string,
  args?: Record<string, unknown>,
): string {
  if (!args || Object.keys(args).length === 0) return name;
  const parts: string[] = [];
  for (
    const key of [
      "path",
      "cmd",
      "command",
      "query",
      "pattern",
      "handle",
      "message",
      "source",
      "task",
    ]
  ) {
    if (key in args) {
      parts.push(
        `${key}=${JSON.stringify(truncatePlain(String(args[key]), 80))}`,
      );
    }
  }
  if (parts.length === 0) return name;
  return `${name}(${parts.join(", ")})`;
}

/** Multi-line detailed tool call header (Go formatDetailedActivityTool). */
export function formatDetailedActivityTool(
  name: string,
  args?: Record<string, unknown>,
): string {
  const details = formatToolArgsLines(name, args);
  if (details) return `${name}\n${details}`;
  return name;
}

/** Minimal argument formatter; the i18n-rich version lands with the tool
 * result components (Go formatToolArgs). */
function formatToolArgsLines(
  _name: string,
  args?: Record<string, unknown>,
): string {
  if (!args) return "";
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
}

/** Whitespace-collapsing rune truncation (Go truncatePlain). */
export function truncatePlain(s: string, max: number): string {
  s = s.split(/\s+/).filter(Boolean).join(" ");
  if (max <= 0) return s;
  const runes = Array.from(s);
  if (runes.length <= max) return s;
  if (max <= 3) return runes.slice(0, max).join("");
  return runes.slice(0, max - 3).join("") + "...";
}

/** Renders one agent's full activity panel (Go renderAgentActivity). */
export function renderAgentActivity(
  act: AgentActivity | undefined,
  agentId: string,
  tr: Translator,
  now: Date = new Date(),
): string {
  if (!act) {
    return `${agentId}\n\n${tr.text("activity.no_activity")}`;
  }
  const lines: string[] = [];
  let header = agentId;
  if (act.kind) header += ` (${act.kind})`;
  if (act.state) header += ` [${act.state}]`;
  if (act.updatedAt && act.updatedAt.getTime() > 0) {
    header += ` ${
      tr.text("activity.updated", formatActivityAge(act.updatedAt, now))
    }`;
  }
  lines.push(header);
  if (act.lastToolName) {
    lines.push(
      "",
      tr.text("activity.latest_tool"),
      formatDetailedActivityTool(act.lastToolName, act.lastToolArgs),
    );
  } else if (act.lastTool) {
    lines.push("", `${tr.text("activity.latest_tool")} ${act.lastTool}`);
  }
  if (act.fullThink) {
    lines.push("", tr.text("activity.thinking"), act.fullThink);
  } else if (act.lastThink) {
    lines.push("", `${tr.text("activity.thinking")} ${act.lastThink}`);
  }
  if (act.fullText) {
    lines.push("", tr.text("activity.response"), act.fullText);
  } else if (act.lastText) {
    lines.push("", `${tr.text("activity.response")} ${act.lastText}`);
  }
  if (act.fullResult) {
    lines.push("", tr.text("activity.latest_result"), act.fullResult);
  } else if (act.lastResult) {
    lines.push("", `${tr.text("activity.latest_result")} ${act.lastResult}`);
  }
  if (act.events.length > 0) {
    lines.push("", tr.text("activity.timeline"));
    for (const ev of act.events) {
      const hh = String(ev.time.getHours()).padStart(2, "0");
      const mm = String(ev.time.getMinutes()).padStart(2, "0");
      const ss = String(ev.time.getSeconds()).padStart(2, "0");
      lines.push(`  ${hh}:${mm}:${ss}  ${ev.text}`);
    }
  }
  if (lines.length === 1) {
    lines.push("", `(${tr.text("activity.no_activity")})`);
  }
  return lines.join("\n");
}

/** Renders the relative age ("12s ago" / "3m ago"). */
export function formatActivityAge(t: Date, now: Date = new Date()): string {
  let d = Math.round((now.getTime() - t.getTime()) / 1000);
  if (d < 0) d = 0;
  if (d < 60) return sprintf("%ds ago", [d]);
  return sprintf("%dm ago", [Math.floor(d / 60)]);
}

/** Renders the trailing status summary of active agents (Go
 * renderActivitySummary). Uses the English label set; App passes its
 * translator-agnostic statusStyle separately in the Ink layer. */
export function renderActivitySummary(
  store: AgentActivityStore,
  width: number,
): string {
  if (store.order.length === 0) return "";
  const limit = 4;
  const lines: string[] = [];
  for (let i = store.order.length - 1; i >= 0 && lines.length < limit; i--) {
    const act = store.get(store.order[i]);
    if (!act) continue;
    const detail = act.lastTool || act.lastResult || act.lastText ||
      act.lastThink;
    const state = act.state || "running";
    let line = `${act.agentId} [${state}]`;
    if (detail) line += ` ${detail}`;
    if (width > 0) line = truncatePlain(line, width - 2);
    lines.push(line);
  }
  if (lines.length === 0) return "";
  return lines.join("\n");
}
