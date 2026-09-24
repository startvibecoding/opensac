// Ink + React assembly of the TUI (the Go Bubble Tea App's View half).
//
// Rendering rules preserved from the Go App:
// - Completed transcript rows go to the terminal's own scrollback exactly once
//   via Ink's <Static>; only the active streaming row stays in the managed
//   view (inline mode, never the alternate screen).
// - The header, tab bar, and streaming rows are plain strings produced by the
//   migrated formatters; this component lays them out.
//
// Enhanced with TurnCard-style display inspired by moark:
// - Activity timeline showing tool executions and thinking
// - Collapsible tool results
// - Response text with improved formatting
// - Status indicators and timing

import React from "react";
import type { ReactElement } from "react";
import { Box, Static, Text } from "ink";
import {
  TOOL_EXECUTION_FAILED,
  TOOL_EXECUTION_INTERRUPTED,
} from "../agent/events.ts";
import { AppController } from "./app_controller.ts";
import { renderHeader } from "./header.ts";
import { displayWidth } from "./formatters.ts";
import type { TranscriptStore } from "./transcript_store.ts";
import type { Translator } from "./i18n.ts";
import { formatToolRow } from "./tool_row_format.ts";
import { CompactThinkingRow } from "./thinking_display.tsx";
import { CompactToolRow } from "./tool_execution_display.tsx";
import { stripANSI } from "./renderutil.ts";

export interface AppProps {
  /** The event-dispatch controller owning the transcript. */
  controller?: AppController;
  /** Static header info; omitted renders the plain label banner. */
  header?: {
    version: string;
    providerName: string;
    modelName: string;
    cwd: string;
  };
  /** Terminal width for header layout. */
  width?: number;
  /** Legacy banner label (kept for the toolchain smoke test). */
  label?: string;
  /** Visible tail of the transcript when `controller` is absent. */
  visibleRows?: Array<{ id: string; text: string }>;
  /** Compact mode: single-line tool summaries (Go a.compactMode). */
  compactMode?: boolean;
  /**
   * A framed modal overlays the conversation: hide the live streaming tail
   * (it is already rendered inside the modal) so the managed region fits the
   * terminal and Ink's full-region repaint cannot scroll or flicker.
   */
  overlayOpen?: boolean;
}

/** One transcript row with its presentation kind. */
export interface TranscriptRow {
  id: string;
  text: string;
  kind:
    | "header"
    | "plain"
    | "assistant"
    | "think"
    | "tool"
    | "error"
    | "warning";
}

/** The full-screen layout with enhanced TurnCard display. */
export function App({
  controller,
  header,
  width = 80,
  label,
  visibleRows = [],
  compactMode = false,
  overlayOpen = false,
}: AppProps): ReactElement {
  if (!controller) {
    // Legacy banner mode (toolchain smoke tests).
    return (
      <Box flexDirection="column">
        <Text color="cyan" bold>
          {label ?? "OpenSAC"}
        </Text>
        {visibleRows.map((row) => <Text key={row.id}>{row.text}</Text>)}
      </Box>
    );
  }

  const store = controller.store;
  // Rows with an index below the active streaming rows are committed; the
  // active assistant/think slot and running tool rows stay in the managed
  // view. The store's `messages` array is the source of truth: every row is
  // committed exactly once via <Static>, identified by its index. Running
  // tool rows never commit — <Static> is append-only, so a row whose text
  // will change (running… → summary) must stay in the managed view until it
  // reaches a terminal state.
  const slotStart = activeSlotStart(controller);
  const runningTools = new Set(
    store.toolResults.filter((r) => r.status === "running").map((r) =>
      r.msgIndex
    ),
  );
  const committed: TranscriptRow[] = [];
  const streaming: TranscriptRow[] = [];
  for (let i = 0; i < store.messages.length; i++) {
    const resolved = rowTextAt(store, i, compactMode);
    if (!resolved) continue;
    const row: TranscriptRow = {
      id: `row-${i}`,
      text: resolved.text,
      kind: resolved.kind,
    };
    if (i < slotStart && !runningTools.has(i)) committed.push(row);
    // Rows owned by the activity timeline (tools + the active think slot)
    // must not also render here, or the same thinking text appears twice.
    else if (
      resolved.kind !== "tool" &&
      !(resolved.kind === "think" && i === store.currentThinkIdx)
    ) {
      streaming.push(row);
    }
  }

  // Live per-turn activity timeline (tools + thinking) tracked by the
  // controller from the agent event stream. Running items carry live elapsed
  // timing; completed items keep their status/result until the next turn.
  const activities = controller.activityManager.buildTimeline();

  // Ink supports a single <Static>; header lines and committed transcript rows
  // share it, header first.
  const headerLines = header
    ? renderHeader(
      width,
      header.version,
      header.providerName,
      header.modelName,
      header.cwd,
    )
      .split("\n")
      .filter((l) => l !== "")
      .map((line, i): TranscriptRow => ({
        id: `header-${i}`,
        text: line,
        kind: "header",
      }))
    : [];
  const committedAll = [...headerLines, ...committed];

  return (
    <Box flexDirection="column">
      <Static items={committedAll}>
        {(row) => renderRow(row, false)}
      </Static>

      {
        /* Live activity timeline (running/completed tools + thinking).
          Rows receive width-4: 1-col left indent (marginLeft) + 3 cols of
          margin slack so a full-width row never touches the terminal edge. */
      }
      {activities.length > 0 && (
        <Box flexDirection="column" marginLeft={1} marginBottom={1}>
          {activities.map((activity) => (
            activity.type === "tool"
              ? (
                <CompactToolRow
                  key={activity.id}
                  toolName={activity.toolName ?? activity.type}
                  toolInput={activity.toolInput}
                  status={activity.status as
                    | "running"
                    | "completed"
                    | "error"
                    | "interrupted"}
                  intent={activity.intent}
                  elapsedMs={activity.elapsedMs}
                  width={width - 4}
                />
              )
              : (
                <CompactThinkingRow
                  key={activity.id}
                  content={activity.content ?? ""}
                  isStreaming={activity.status === "running"}
                  elapsedMs={activity.elapsedMs}
                  translator={controller.translator}
                  width={width - 4}
                />
              )
          ))}
        </Box>
      )}

      {!overlayOpen && streaming.map((row) => renderRow(row, true))}
      {controller.shownApproval && (
        <Box flexDirection="column" borderStyle="round">
          <Text bold color="yellow">
            {controller.translator.text("approval.required")}
          </Text>
          <Text>
            {controller.shownApproval.toolName}{" "}
            {JSON.stringify(controller.shownApproval.args ?? {})}
          </Text>
        </Box>
      )}
      {controller.shownQuestion && (
        <Box flexDirection="column" borderStyle="round">
          <Text bold>{controller.shownQuestion.question}</Text>
          {(controller.shownQuestion.options ?? []).map((opt) => (
            <Text key={opt}>- {opt}</Text>
          ))}
        </Box>
      )}
      {!overlayOpen && controller.isThinking && (
        <Text dimColor>
          ~ {controller.translator.text("thinking.in_progress")}
        </Text>
      )}
    </Box>
  );
}

/** Renders one transcript row; streaming rows are clipped and stripped. */
function renderRow(row: TranscriptRow, streaming: boolean): ReactElement {
  if (row.kind === "header") {
    return <Text key={row.id}>{row.text}</Text>;
  }
  if (row.kind === "think") {
    return (
      <Text key={row.id} dimColor italic>
        {streaming ? clip(row.text, 4) : row.text}
      </Text>
    );
  }
  if (row.kind === "tool") {
    return <Text key={row.id} color="cyan">{row.text}</Text>;
  }
  if (row.kind === "error") {
    return <Text key={row.id} color="red">{row.text}</Text>;
  }
  if (row.kind === "warning") {
    return <Text key={row.id} color="yellow">{row.text}</Text>;
  }
  return (
    <Text key={row.id}>
      {streaming ? stripANSI(clip(row.text, 6)) : row.text}
    </Text>
  );
}

/**
 * Resolves the display text of transcript row `index`. Streaming rows keep
 * their raw text in the store's per-slot builders (assistant/think); tool rows
 * carry their summary in `toolResults`. Empty placeholders resolve to nothing.
 */
function storeTranslator(store: TranscriptStore): Translator {
  return store.translator;
}

function rowTextAt(
  store: TranscriptStore,
  index: number,
  compact: boolean,
): { text: string; kind: TranscriptRow["kind"] } | undefined {
  const tool = store.toolResults.find((r) => r.msgIndex === index);
  if (tool) {
    const text = formatToolRow(
      storeTranslator(store),
      {
        toolName: tool.toolName,
        toolArgs: tool.toolArgs,
        status: tool.status,
        summary: tool.summary,
        fullContent: tool.fullContent,
        diff: tool.diff,
        plan: tool.plan,
        toolError: tool.toolError,
        executionState: tool.executionState,
      },
      compact,
    );
    const warning = tool.status === "interrupted" || tool.toolError !== "" ||
      tool.executionState === TOOL_EXECUTION_FAILED ||
      tool.executionState === TOOL_EXECUTION_INTERRUPTED;
    return {
      text,
      kind: warning ? "warning" : "tool",
    };
  }
  const message = store.messages[index];
  if (message !== undefined && message !== "") {
    return { text: message, kind: "plain" };
  }
  const assistant = store.assistantRaw(index);
  if (assistant !== "") return { text: assistant, kind: "assistant" };
  const think = store.thinkRaw(index);
  if (think !== "") return { text: think, kind: "think" };
  return undefined;
}

/** First message index eligible for scrollback commit. */
function activeSlotStart(controller: AppController): number {
  const { currentAssistantIdx, currentThinkIdx } = controller.store;
  const candidates = [currentAssistantIdx, currentThinkIdx].filter((i) =>
    i >= 0
  );
  return candidates.length > 0
    ? Math.min(...candidates)
    : store_end(controller);
}

function store_end(controller: AppController): number {
  return controller.store.messages.length;
}

function clip(text: string, maxLines = 6): string {
  const lines = stripANSI(text).split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(lines.length - maxLines).join("\n") + "\n";
}

/** Exposed for tests: grid width check of the rendered header. */
export function headerWidth(props: AppProps): number {
  if (!props.header) return 0;
  return Math.max(
    ...renderHeader(
      props.width ?? 80,
      props.header.version,
      props.header.providerName,
      props.header.modelName,
      props.header.cwd,
    ).split("\n").map(displayWidth),
  );
}
