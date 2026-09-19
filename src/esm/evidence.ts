// Ported from internal/esm/evidence.go
//
// The per-role tool-call evidence accumulator. TUI and WebUI adapters must
// share this tracker so the "tool-backed evidence" checks in
// applyWorkerResult/applyReviewResult cannot diverge between adapters.

import {
  type Event,
  eventToolCall,
  eventToolExecutionEnd,
  eventToolExecutionStart,
  eventToolResult,
  type Message,
  roleAssistant,
} from "../../sdk/agent/mod.ts";

/**
 * Accumulates tool-call evidence for one ESM role run.
 */
export class EvidenceTracker {
  private toolCalls = 0;
  private readonly toolNames = new Map<string, number>();
  private readonly toolError = new Map<string, boolean>();
  private readonly seen = new Set<string>();

  /**
   * Records one agent event's tool evidence. Tool calls are counted once per
   * unique tool-call ID; events without an ID are counted as they arrive.
   */
  observe(ev: Event): void {
    if (ev == null) return;
    switch (ev.type) {
      case eventToolCall:
      case eventToolExecutionStart: {
        let id = ev.toolCallId ?? "";
        if (id === "" && ev.toolCall != null) id = ev.toolCall.id;
        if (id === "") {
          this.toolCalls++;
        } else if (!this.seen.has(id)) {
          this.seen.add(id);
          this.toolCalls++;
        }
        let name = ev.toolName ?? "";
        if (name === "" && ev.toolCall != null) name = ev.toolCall.name;
        if (name !== "") {
          this.toolNames.set(name, (this.toolNames.get(name) ?? 0) + 1);
        }
        break;
      }
      case eventToolExecutionEnd:
      case eventToolResult:
        if (ev.toolError != null && (ev.toolCallId ?? "") !== "") {
          this.toolError.set(ev.toolCallId as string, true);
        }
        break;
    }
  }

  /** Returns the accumulated evidence for a RoleResult. */
  summary(): {
    toolCalls: number;
    toolNames: Map<string, number>;
    toolError: Map<string, boolean>;
  } {
    return {
      toolCalls: this.toolCalls,
      toolNames: this.toolNames,
      toolError: this.toolError,
    };
  }
}

/**
 * Returns the final assistant text of a run. It prefers content and falls back
 * to concatenated text blocks, so both adapters parse the same structured ESM
 * report from the same canonical extraction.
 */
export function finalAssistantResponse(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== roleAssistant) continue;
    const content = messages[i].content ?? "";
    if (content.trim() !== "") return content;
    let b = "";
    for (const block of messages[i].contents ?? []) {
      if (block.type === "text" && (block.text ?? "") !== "") {
        b += block.text as string;
      }
    }
    return b;
  }
  return "";
}
