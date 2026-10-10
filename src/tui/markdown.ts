// Streaming Markdown block model for the Ink TUI.
//
// Wraps src/tsm: the active (streaming) block is rendered with the
// streaming-optimized parser option, and a completed block is re-rendered once
// with the full parser before it is committed to the terminal scrollback.

import { type Theme } from "../tsm/mod.ts";
import { gsmRender, renderWithStreamOption } from "../tsm/mod.ts";

/** Renders a completed Markdown block to ANSI text. */
export function renderMarkdown(
  src: string,
  width: number,
  theme?: Theme,
): string {
  return gsmRender(src, width, theme);
}

/** Renders a partially streamed Markdown block to ANSI text. */
export function renderStreamingMarkdown(
  src: string,
  width: number,
  theme?: Theme,
): string {
  return renderWithStreamOption(src, width, theme);
}

/**
 * Accumulates streamed assistant Markdown for one transcript block. While the
 * block is active it renders with conservative speculative rewriting; `finish`
 * marks it complete so the caller can commit it to scrollback.
 */
export class MarkdownBlock {
  #text = "";
  #done = false;

    readonly width: number;
  readonly theme?: Theme;

  constructor(width: number, theme?: Theme) {
    this.width = width;
    this.theme = theme;
  }

  get text(): string {
    return this.#text;
  }

  get done(): boolean {
    return this.#done;
  }

  /** Replaces the accumulated content with the latest streamed text. */
  update(text: string): void {
    this.#text = text;
    this.#done = false;
  }

  /** Marks the block complete (optionally with final content). */
  finish(text?: string): void {
    if (text !== undefined) this.#text = text;
    this.#done = true;
  }

  /** Renders the current content to ANSI text. */
  output(): string {
    return this.#done
      ? renderMarkdown(this.#text, this.width, this.theme)
      : renderStreamingMarkdown(this.#text, this.width, this.theme);
  }
}
