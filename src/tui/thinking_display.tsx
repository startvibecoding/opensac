// Thinking process visualization for Ink TUI.
//
// Displays the thinking/reasoning process in a collapsible, styled format.
// Inspired by moark's thinking display but adapted for terminal.
//
// Features:
// - Collapsible thinking blocks
// - Streaming indicator
// - Syntax highlighting for code blocks in thinking
// - Timing information

import React from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import { formatDuration } from "./formatters.ts";
import type { Translator } from "./i18n.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ThinkingBlockProps {
  id: string;
  content: string;
  isStreaming?: boolean;
  startTime?: number;
  endTime?: number;
  isExpanded?: boolean;
  translator: Translator;
  width: number;
  maxLines?: number;
}

export interface ThinkingIndicatorProps {
  isThinking: boolean;
  translator: Translator;
}

// ─────────────────────────────────────────────────────────────────────────────
// Style Constants
// ─────────────────────────────────────────────────────────────────────────────

const ICONS = {
  thinking: "💭",
  expand: "▶",
  collapse: "▼",
  streaming: "▊",
};

// ─────────────────────────────────────────────────────────────────────────────
// Thinking Block Component
// ─────────────────────────────────────────────────────────────────────────────

export function ThinkingBlock({
  content,
  isStreaming = false,
  startTime,
  endTime,
  isExpanded = true,
  translator,
  maxLines = 10,
}: ThinkingBlockProps): ReactElement {
  const elapsedMs = startTime && endTime
    ? endTime - startTime
    : startTime
    ? Date.now() - startTime
    : undefined;

  const timeStr = elapsedMs ? formatDuration(elapsedMs) : "";

  // Collapsed view
  if (!isExpanded) {
    return (
      <Box flexDirection="column">
        <Text dimColor>
          {ICONS.expand} {ICONS.thinking}{" "}
          {translator.text("thinking.collapsed")}
          {content.length > 0 && ` (${content.length} chars)`}
          {timeStr && ` (${timeStr})`}
        </Text>
      </Box>
    );
  }

  // Expanded view
  const lines = content.split("\n");
  const displayLines = lines.slice(0, maxLines);
  const hasMore = lines.length > maxLines;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
    >
      {/* Header */}
      <Box flexDirection="row">
        <Text dimColor italic>
          {ICONS.collapse} {ICONS.thinking} {translator.text("thinking.title")}
        </Text>
        {timeStr && <Text dimColor>({timeStr})</Text>}
        {isStreaming && <Text color="cyan">{ICONS.streaming}</Text>}
      </Box>

      {/* Content */}
      <Box flexDirection="column" marginLeft={1}>
        {displayLines.map((line, index) => (
          <Text key={index} dimColor italic>
            {line}
          </Text>
        ))}
        {hasMore && (
          <Text dimColor>
            ...{" "}
            {translator.text("thinking.more_lines", lines.length - maxLines)}
          </Text>
        )}
      </Box>
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Compact Thinking Row (for activity timeline)
// ─────────────────────────────────────────────────────────────────────────────

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
  const preview = truncateText(content, width - 15);

  return (
    <Text dimColor italic>
      {ICONS.thinking} {translator.text("thinking.thinking")}
      {preview && ` — ${preview}`}
      {timeStr}
      {isStreaming && ` ${ICONS.streaming}`}
    </Text>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Thinking Indicator Component
// ─────────────────────────────────────────────────────────────────────────────

export function ThinkingIndicator({
  isThinking,
  translator,
}: ThinkingIndicatorProps): ReactElement {
  if (!isThinking) return <Text />;

  return (
    <Box>
      <Text dimColor>
        {ICONS.thinking} {translator.text("thinking.in_progress")}
      </Text>
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming Thinking Display
// ─────────────────────────────────────────────────────────────────────────────

export interface StreamingThinkingProps {
  content: string;
  translator: Translator;
  width: number;
  maxDisplayLines?: number;
}

export function StreamingThinking({
  content,
  translator,
  maxDisplayLines = 6,
}: StreamingThinkingProps): ReactElement {
  const lines = content.split("\n");
  const displayLines = lines.slice(-maxDisplayLines);

  return (
    <Box flexDirection="column">
      <Text dimColor italic>
        {ICONS.thinking} {translator.text("thinking.streaming")}...
      </Text>
      <Box flexDirection="column" marginLeft={2}>
        {displayLines.map((line, index) => (
          <Text key={index} dimColor italic>
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Thinking Summary
// ─────────────────────────────────────────────────────────────────────────────

export interface ThinkingSummaryProps {
  blocks: Array<{
    id: string;
    content: string;
    startTime?: number;
    endTime?: number;
  }>;
  translator: Translator;
}

export function ThinkingSummary({
  blocks,
  translator,
}: ThinkingSummaryProps): ReactElement {
  if (blocks.length === 0) return <Text />;

  const totalChars = blocks.reduce((sum, b) => sum + b.content.length, 0);
  const totalTime = blocks.reduce((sum, b) => {
    if (b.startTime && b.endTime) {
      return sum + (b.endTime - b.startTime);
    }
    return sum;
  }, 0);

  return (
    <Text dimColor>
      {ICONS.thinking} {blocks.length} {translator.text("thinking.blocks")}
      {totalTime > 0 && ` (${formatDuration(totalTime)}, ${totalChars} chars)`}
    </Text>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

function truncateText(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return text.substring(0, maxWidth - 3) + "...";
}

// ─────────────────────────────────────────────────────────────────────────────
// Thinking Block Manager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manages thinking blocks for a conversation turn.
 */
export class ThinkingBlockManager {
  #blocks: Map<string, {
    id: string;
    content: string;
    startTime: number;
    endTime?: number;
    isStreaming: boolean;
  }> = new Map();

  /**
   * Starts a new thinking block.
   */
  startBlock(id: string): void {
    this.#blocks.set(id, {
      id,
      content: "",
      startTime: Date.now(),
      isStreaming: true,
    });
  }

  /**
   * Appends content to a thinking block.
   */
  appendContent(id: string, content: string): void {
    const block = this.#blocks.get(id);
    if (!block) return;
    block.content += content;
  }

  /**
   * Completes a thinking block.
   */
  completeBlock(id: string): void {
    const block = this.#blocks.get(id);
    if (!block) return;
    block.endTime = Date.now();
    block.isStreaming = false;
  }

  /**
   * Gets all thinking blocks.
   */
  getBlocks(): Array<{
    id: string;
    content: string;
    startTime: number;
    endTime?: number;
    isStreaming: boolean;
  }> {
    return Array.from(this.#blocks.values());
  }

  /**
   * Checks if any block is still streaming.
   */
  hasStreamingBlocks(): boolean {
    for (const block of this.#blocks.values()) {
      if (block.isStreaming) return true;
    }
    return false;
  }

  /**
   * Clears all blocks.
   */
  clear(): void {
    this.#blocks.clear();
  }
}
