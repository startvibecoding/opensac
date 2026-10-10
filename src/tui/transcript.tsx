// Transcript rendering for the Ink TUI.
//
// Completed blocks are committed to the terminal's own scrollback exactly once
// via Ink's <Static> (inline mode, never the alternate screen), so the terminal
// handles selection, copy, and wheel scrolling natively. Only the active
// streaming block stays in the managed view.

import React, { useRef } from "react";
import { Box, Static, Text } from "ink";
import { type Theme } from "../tsm/mod.ts";
import { renderMarkdown, renderStreamingMarkdown } from "./markdown.ts";

/** One transcript entry: an assistant message or tool output block. */
export interface TranscriptBlock {
  /** Stable, unique id (required for <Static> de-duplication). */
  id: string;
  /** Markdown source accumulated so far. */
  text: string;
  /** Whether the block has finished streaming. */
  done: boolean;
}

export interface TranscriptProps {
  blocks: TranscriptBlock[];
  width: number;
  theme?: Theme;
}

/**
 * Admits newly completed blocks in terminal-completion order. The caller keeps
 * the IDs for the lifetime of its Ink <Static> instance.
 *
 * @internal Exported for the no-terminal regression test.
 */
export function admitCompletedTranscriptBlocks(
  existing: TranscriptBlock[],
  ids: Set<string>,
  blocks: readonly TranscriptBlock[],
): TranscriptBlock[] {
  const newlyCompleted: TranscriptBlock[] = [];
  for (const block of blocks) {
    if (!block.done || ids.has(block.id)) continue;
    ids.add(block.id);
    // A Static item cannot change after it has been written to scrollback.
    // Keep the completion snapshot rather than retaining caller-owned data.
    newlyCompleted.push({ ...block });
  }
  // Ink's <Static> memoizes from the `items` identity, so mutating a retained
  // array would prevent an admitted block from ever reaching scrollback.
  return newlyCompleted.length === 0
    ? existing
    : [...existing, ...newlyCompleted];
}

/**
 * Renders a transcript: completed blocks through <Static> (scrollback) and the
 * active streaming block in the managed view.
 */
export function Transcript({
  blocks,
  width,
  theme,
}: TranscriptProps): React.ReactElement {
  // Ink's <Static> tracks how many items it has emitted, rather than the
  // React keys of those items. Passing it `blocks.filter(b => b.done)` is
  // therefore unsafe: when an earlier stream finishes after a later one, the
  // filtered list inserts before an already emitted item. Ink then treats the
  // old tail as new output and prints it again. Keep an append-only snapshot
  // keyed by the block's stable ID, just as the controller-backed transcript
  // does in app.tsx.
  const admission = useRef<{
    ids: Set<string>;
    /** New identity is required: Ink memoizes <Static>'s item array. */
    items: TranscriptBlock[];
  }>({ ids: new Set(), items: [] }).current;
  admission.items = admitCompletedTranscriptBlocks(
    admission.items,
    admission.ids,
    blocks,
  );
  const active = blocks.filter((b) => !b.done);

  const renderStaticBlock = (block: TranscriptBlock): React.ReactElement =>
    React.createElement(
      Text,
      { key: block.id },
      renderMarkdown(block.text, width, theme),
    );

  // Ink's <Static> is a generic function component; bind its item type here so
  // createElement can resolve the overload without widening T to `unknown`.
  const StaticList = Static as unknown as React.ComponentType<{
    items: TranscriptBlock[];
    children: (item: TranscriptBlock, index: number) => React.ReactNode;
  }>;

  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(StaticList, {
      key: "static",
      items: admission.items,
      children: renderStaticBlock,
    }),
    ...active.map((block) =>
      React.createElement(
        Text,
        { key: block.id },
        renderStreamingMarkdown(block.text, width, theme),
      ),
    ),
  );
}
