// Transcript rendering for the Ink TUI.
//
// Completed blocks are committed to the terminal's own scrollback exactly once
// via Ink's <Static> (inline mode, never the alternate screen), so the terminal
// handles selection, copy, and wheel scrolling natively. Only the active
// streaming block stays in the managed view.

import React from "react";
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
 * Renders a transcript: completed blocks through <Static> (scrollback) and the
 * active streaming block in the managed view.
 */
export function Transcript(
  { blocks, width, theme }: TranscriptProps,
): React.ReactElement {
  const completed = blocks.filter((b) => b.done);
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
      items: completed,
      children: renderStaticBlock,
    }),
    ...active.map((block) =>
      React.createElement(
        Text,
        { key: block.id },
        renderStreamingMarkdown(block.text, width, theme),
      )
    ),
  );
}
