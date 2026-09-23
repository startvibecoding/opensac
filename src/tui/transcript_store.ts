// the transcript storage half of the App — the
// messages array, the assistant/think streaming slots, and the tool-result
// state machine (agent_events.go appendToolExecutionStart/appendToolResult/
// finalizeInterruptedTools, input.go streaming builders, and state.go's
// resetTranscriptState). Rendering stays in the Ink layer; this module owns
// indices, matching, dedup, and terminalization exactly as the Go App does.

import type { FileDiff } from "../tools/io_helpers.ts";
import { compactBashOutput } from "./formatters.ts";
import { Translator } from "./i18n.ts";
import type { TaskPlan } from "../tools/tool.ts";

export type ToolResultStatus = "running" | "completed" | "interrupted";

export interface ToolResultEntry {
  toolCallID: string;
  toolName: string;
  toolArgs?: Record<string, unknown>;
  status: ToolResultStatus;
  /** Short summary for the collapsed view. */
  summary: string;
  /** Full content for the expanded view. */
  fullContent: string;
  diff?: FileDiff;
  /** Structured task plan published with the result (plan tool). */
  plan?: TaskPlan;
  /** Stable presentation error from the tool execution. */
  toolError: string;
  executionState: string;
  /** Index in messages where this tool row lives. */
  msgIndex: number;
}

/** Parameters of a tool result event the store matches against. */
export interface ToolResultEvent {
  toolCallID: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolDiff?: FileDiff;
  plan?: TaskPlan;
  toolError?: Error;
  toolExecutionState?: string;
}

export interface TranscriptStoreOptions {
  translator: Translator;
  /** Summarizer override (tests); defaults to summarizeToolResult. */
  summarize?: (
    toolName: string,
    result: string,
    diff?: FileDiff,
  ) => string;
}

/**
 * Owns the transcript rows. messages[i] is the raw text of row i (the Ink
 * layer renders it); streaming rows may briefly hold "" placeholders.
 */
export class TranscriptStore {
  #translator: Translator;
  #summarize: (toolName: string, result: string, diff?: FileDiff) => string;

  messages: string[] = [];
  toolResults: ToolResultEntry[] = [];

  /** The translator bound at construction (used by Ink row formatting). */
  get translator(): Translator {
    return this.#translator;
  }

  currentAssistantIdx = -1;
  currentThinkIdx = -1;

  #assistantRaw = new Map<number, string>();
  #assistantDirty = new Set<number>();
  #thinkRaw = new Map<number, string>();

  constructor(options: TranscriptStoreOptions) {
    this.#translator = options.translator;
    this.#summarize = options.summarize ??
      ((toolName, result, diff) =>
        summarizeToolResult(toolName, result, diff, this.#translator));
  }

  // ── streaming slots ────────────────────────────────────────────────────────

  /**
   * Reserves the assistant display slot (Go EVENT_TURN_START handling) so later
   * tool output cannot shift the assistant index underneath us.
   */
  beginAssistantSlot(): void {
    this.currentAssistantIdx = this.messages.length;
    this.#assistantRaw.set(this.currentAssistantIdx, "");
    this.messages.push("");
  }

  /** Appends a text delta, opening a slot when none is active. */
  appendAssistantDelta(delta: string): void {
    if (
      this.currentAssistantIdx >= 0 &&
      this.currentAssistantIdx < this.messages.length
    ) {
      this.#appendAssistantDelta(this.currentAssistantIdx, delta);
    } else {
      this.currentAssistantIdx = this.messages.length;
      this.#assistantRaw.set(this.currentAssistantIdx, "");
      this.#appendAssistantDelta(this.currentAssistantIdx, delta);
      this.messages.push("");
    }
    this.#assistantDirty.add(this.currentAssistantIdx);
  }

  /**
   * Appends a think delta. When the active assistant slot is still an empty
   * placeholder it converts to the think slot (Go EVENT_THINK_DELTA handling).
   */
  appendThinkDelta(delta: string): void {
    if (
      this.currentThinkIdx >= 0 && this.currentThinkIdx < this.messages.length
    ) {
      this.#appendThinkDelta(this.currentThinkIdx, delta);
      return;
    }
    if (
      this.currentAssistantIdx >= 0 &&
      this.currentAssistantIdx === this.messages.length - 1 &&
      (this.#assistantRaw.get(this.currentAssistantIdx) ?? "") === ""
    ) {
      // Assistant slot untouched → reuse it for reasoning
      const reused = this.currentAssistantIdx;
      this.currentThinkIdx = reused;
      this.#assistantRaw.delete(reused);
      this.#assistantDirty.delete(reused);
      this.currentAssistantIdx = this.messages.length;
      this.#assistantRaw.set(this.currentAssistantIdx, "");
      this.#assistantDirty.add(this.currentAssistantIdx);
      this.messages.push("");
    } else {
      this.currentThinkIdx = this.messages.length;
      this.messages.push("");
    }
    this.#thinkRaw.set(this.currentThinkIdx, "");
    this.#appendThinkDelta(this.currentThinkIdx, delta);
  }

  /** Commits active streaming rows and clears the active indices. */
  commitActiveStream(): void {
    const hadActive = this.currentThinkIdx >= 0 ||
      this.currentAssistantIdx >= 0;
    if (this.currentThinkIdx >= 0) {
      // finalizeThinkStream: builder content already mirrors thinkRaw here.
      this.currentThinkIdx = -1;
    }
    if (this.currentAssistantIdx >= 0) {
      this.#assistantDirty.delete(this.currentAssistantIdx);
      this.currentAssistantIdx = -1;
    }
    if (hadActive) {
      // Go calls updateViewportContent here; the Ink layer derives that from
      // store state, so no callback is needed.
    }
  }

  /** Raw accumulated text of an assistant row. */
  assistantRaw(idx: number): string {
    return this.#assistantRaw.get(idx) ?? "";
  }

  /** Raw accumulated text of a think row. */
  thinkRaw(idx: number): string {
    return this.#thinkRaw.get(idx) ?? "";
  }

  isAssistantDirty(idx: number): boolean {
    return this.#assistantDirty.has(idx);
  }

  markAssistantRendered(idx: number): void {
    this.#assistantDirty.delete(idx);
  }

  #appendAssistantDelta(idx: number, delta: string): void {
    this.#assistantRaw.set(idx, (this.#assistantRaw.get(idx) ?? "") + delta);
  }

  #appendThinkDelta(idx: number, delta: string): void {
    this.#thinkRaw.set(idx, (this.#thinkRaw.get(idx) ?? "") + delta);
  }

  // ── tool rows ──────────────────────────────────────────────────────────────

  /** Opens a running tool row (Go appendToolExecutionStart). */
  appendToolExecutionStart(
    toolCallID: string,
    toolName: string,
    toolArgs?: Record<string, unknown>,
  ): void {
    if (toolName === "") return;
    if (
      this.hasToolEntry(toolCallID, "running") ||
      this.hasToolEntry(toolCallID, "completed")
    ) {
      return;
    }
    this.commitActiveStream();
    const msgIdx = this.messages.length;
    this.toolResults.push({
      toolCallID,
      toolName,
      toolArgs,
      status: "running",
      summary: "",
      fullContent: "",
      toolError: "",
      executionState: "",
      msgIndex: msgIdx,
    });
    this.messages.push("");
  }

  /**
   * Terminalizes the matching running row or opens a completed row
   * (Go appendToolResult). Late stragglers after an interrupted row are
   * dropped so an aborted run cannot open a second row for the same call.
   */
  appendToolResult(event: ToolResultEvent): void {
    if (this.hasToolEntry(event.toolCallID, "completed")) return;

    let matchedArgs = event.toolArgs;
    let matchedName = event.toolName ?? "";
    for (let j = this.toolResults.length - 1; j >= 0; j--) {
      const row = this.toolResults[j];
      if (row.toolCallID !== event.toolCallID) continue;
      if (matchedArgs === undefined) matchedArgs = row.toolArgs;
      if (matchedName === "") matchedName = row.toolName;
      break;
    }

    for (let j = this.toolResults.length - 1; j >= 0; j--) {
      const row = this.toolResults[j];
      if (row.toolCallID !== event.toolCallID || row.status !== "running") {
        continue;
      }
      row.toolName = matchedName;
      row.toolArgs = matchedArgs;
      row.status = "completed";
      row.fullContent = event.toolResult ?? "";
      row.diff = event.toolDiff;
      row.plan = event.plan;
      row.summary = this.#summarize(
        matchedName,
        event.toolResult ?? "",
        event.toolDiff,
      );
      row.toolError = event.toolError ? event.toolError.message : "";
      row.executionState = event.toolExecutionState ?? "";
      return;
    }

    if (this.hasToolEntry(event.toolCallID, "interrupted")) {
      return;
    }

    const msgIdx = this.messages.length;
    this.toolResults.push({
      toolCallID: event.toolCallID,
      toolName: matchedName,
      toolArgs: matchedArgs,
      status: "completed",
      msgIndex: msgIdx,
      fullContent: event.toolResult ?? "",
      diff: event.toolDiff,
      plan: event.plan,
      summary: this.#summarize(
        matchedName,
        event.toolResult ?? "",
        event.toolDiff,
      ),
      toolError: event.toolError ? event.toolError.message : "",
      executionState: event.toolExecutionState ?? "",
    });
    this.messages.push("");
  }

  /**
   * Terminalizes tool rows still running when the run reached a terminal
   * outcome (Go finalizeInterruptedTools). Rows with results are untouched.
   */
  finalizeInterruptedTools(): void {
    for (const row of this.toolResults) {
      if (row.status !== "running") continue;
      row.status = "interrupted";
      row.executionState = "interrupted";
    }
  }

  hasToolEntry(toolCallID: string, status: ToolResultStatus): boolean {
    return this.toolResults.some(
      (r) => r.toolCallID === toolCallID && r.status === status,
    );
  }

  /** The transcript row index of a tool row. */
  msgIndexOf(toolCallID: string): number | undefined {
    return this.toolResults.find((r) => r.toolCallID === toolCallID)?.msgIndex;
  }

  // ── reset ──────────────────────────────────────────────────────────────────

  /** Clears conversation bookkeeping (Go resetTranscriptState). */
  resetTranscriptState(): void {
    this.messages = [];
    this.toolResults = [];
    this.currentAssistantIdx = -1;
    this.currentThinkIdx = -1;
    this.#assistantRaw.clear();
    this.#assistantDirty.clear();
    this.#thinkRaw.clear();
  }
}

/** Per-tool collapsed summary (Go summarizeToolResult). */
export function summarizeToolResult(
  toolName: string,
  result: string,
  diff: FileDiff | undefined,
  tr: Translator,
): string {
  switch (toolName) {
    case "bash":
      return compactBashOutput(result);
    case "read": {
      const lines = result.split("\n");
      return tr.text("tool.result.lines", lines.length);
    }
    case "ls":
      return compactBashOutput(result);
    case "write": {
      const summary = diff ? summarizeFileDiff(diff) : "";
      if (summary) return summary;
      return summarizeWriteToolResult(result);
    }
    case "edit": {
      const summary = diff ? summarizeFileDiff(diff) : "";
      if (summary) return summary;
      return tr.text("tool.result.applied");
    }
    default:
      return truncatePlain50(result);
  }
}

function truncatePlain50(s: string): string {
  const runes = Array.from(s);
  if (runes.length <= 50) return s;
  return runes.slice(0, 47).join("") + "...";
}

/** Diff summary line (Go summarizeFileDiff). */
export function summarizeFileDiff(diff: FileDiff | undefined): string {
  if (!diff) return "";
  const suffix = diff.truncated ? " large" : "";
  return `+${diff.added} -${diff.deleted}${suffix} (-${
    formatLineRangesForDisplay(diff.deletedLines)
  } +${formatLineRangesForDisplay(diff.addedLines)})`;
}

/** Compresses line lists into compact ranges (Go formatLineRangesForDisplay). */
export function formatLineRangesForDisplay(lines: number[]): string {
  if (lines.length === 0) return "none";
  const ranges: string[] = [];
  let start = lines[0];
  let prev = lines[0];
  for (const line of lines.slice(1)) {
    if (line === prev + 1) {
      prev = line;
      continue;
    }
    ranges.push(formatLineRangeForDisplay(start, prev));
    start = line;
    prev = line;
  }
  ranges.push(formatLineRangeForDisplay(start, prev));
  return ranges.join(",");
}

function formatLineRangeForDisplay(start: number, end: number): string {
  return start === end ? `${start}` : `${start}-${end}`;
}

/** Write-tool fallback summary (Go summarizeWriteToolResult). */
export function summarizeWriteToolResult(result: string): string {
  const lines = result.split("\n").filter((l) => l.trim() !== "");
  const first = lines[0]?.trim() ?? "";
  if (first === "") return "";
  return truncatePlain50(first);
}
