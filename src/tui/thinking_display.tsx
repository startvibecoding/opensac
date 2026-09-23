// Compact thinking row for the live activity timeline: a one-line dim italic
// preview of the active/completed thinking block with elapsed timing.
//
// The fuller collapsible ThinkingBlock/StreamingThinking variants were
// superseded by the transcript's committed/streaming think rows (app.tsx
// renders store think rows) and removed — nothing else called them.

import React from "react";
import type { ReactElement } from "react";
import { Text } from "ink";
import { formatDuration, truncateDisplay } from "./formatters.ts";
import type { Translator } from "./i18n.ts";

/** Plain-text prefix shown before a thinking block (no emoji). */
const THINK_PREFIX = "~";

/** Streaming tick appended while the block is still open. */
const STREAMING_MARK = "|";

export interface CompactThinkingRowProps {
  content: string;
  isStreaming?: boolean;
  elapsedMs?: number;
  translator: Translator;
  width: number;
}

export function CompactThinkingRow({
  content,
  isStreaming = false,
  elapsedMs,
  translator,
  width,
}: CompactThinkingRowProps): ReactElement {
  const timeStr = elapsedMs ? ` (${formatDuration(elapsedMs)})` : "";
  // truncateDisplay measures display cells, so CJK previews fit the row.
  // width-15 budgets the fixed "~ <label> — " prefix plus the trailing
  // "(elapsed) |" suffix.
  const preview = truncateDisplay(content, width - 15);

  return (
    <Text dimColor italic>
      {THINK_PREFIX} {translator.text("thinking.thinking")}
      {preview && ` — ${preview}`}
      {timeStr}
      {isStreaming && ` ${STREAMING_MARK}`}
    </Text>
  );
}
