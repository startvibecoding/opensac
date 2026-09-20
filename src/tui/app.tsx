// Ink + React assembly of the TUI (the Go Bubble Tea App's View half).
//
// Rendering rules preserved from the Go App:
// - Completed transcript rows go to the terminal's own scrollback exactly once
//   via Ink's <Static>; only the active streaming row stays in the managed
//   view (inline mode, never the alternate screen).
// - The header, tab bar, and streaming rows are plain strings produced by the
//   migrated formatters; this component lays them out.

import React from "react";
import type { ReactElement } from "react";
import { Box, Static, Text } from "ink";
import { AppController } from "./app_controller.ts";
import { renderHeader } from "./header.ts";
import { displayWidth } from "./formatters.ts";

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
}

/** Strips ANSI for <Text> children so Ink owns styling. */
function plain(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-Z\-_])/g, "");
}

/** The full-screen layout. */
export function App({
  controller,
  header,
  width = 80,
  label,
  visibleRows = [],
}: AppProps): ReactElement {
  if (!controller) {
    // Legacy banner mode (toolchain smoke tests).
    return (
      <Box flexDirection="column">
        <Text color="cyan" bold>
          {label ?? "MothX"}
        </Text>
        {visibleRows.map((row) => <Text key={row.id}>{row.text}</Text>)}
      </Box>
    );
  }

  const store = controller.store;
  // Rows with an index below the active streaming rows are committed; the
  // active assistant/think slot and running tool rows stay in the managed
  // view. The store's `messages` array is the source of truth: every row is
  // committed exactly once via <Static>, identified by its index.
  const committed = store.messages
    .map((text, index) => ({ id: `row-${index}`, text, index }))
    .filter((row) =>
      row.text !== "" && row.index < activeSlotStart(controller)
    );

  const streamingRows = activeStreamingRows(controller);
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
      .map((line, i) => ({ id: `header-${i}`, text: line }))
    : [];
  const committedAll = [...headerLines, ...committed];

  return (
    <Box flexDirection="column">
      <Static items={committedAll}>
        {(row) => <Text key={row.id}>{row.text}</Text>}
      </Static>
      {streamingRows.map((row) => <Text key={row.id}>{plain(row.text)}</Text>)}
      {controller.shownApproval && (
        <Box flexDirection="column" borderStyle="round">
          <Text bold>Approval required</Text>
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
      {controller.isThinking && <Text dimColor>⠋ working…</Text>}
    </Box>
  );
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

/** The rows currently streaming (never sent to scrollback). */
function activeStreamingRows(
  controller: AppController,
): Array<{ id: string; text: string }> {
  const rows: Array<{ id: string; text: string }> = [];
  const store = controller.store;
  const { currentAssistantIdx, currentThinkIdx } = store;
  for (const idx of [currentThinkIdx, currentAssistantIdx]) {
    if (idx >= 0 && idx < store.messages.length) {
      const text = store.messages[idx] || store.assistantRaw(idx) ||
        store.thinkRaw(idx);
      rows.push({ id: `live-${idx}`, text: clip(text) });
    }
  }
  return rows;
}

function clip(text: string, maxLines = 8): string {
  const lines = plain(text).split("\n");
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
