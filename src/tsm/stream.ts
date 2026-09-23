//
// Streaming Markdown rendering for terminal output: a thin facade over the
// parser and renderer packages, with one-shot and streaming modes.

import { parse, streamOption } from "./parser.ts";
import {
  defaultTheme,
  lightTheme,
  render as renderMarkdown,
  Renderer,
  type Theme,
} from "./renderer.ts";

/** Provides incremental Markdown rendering for streaming use cases. */
export class Stream {
  #renderer: Renderer;
  #builder = "";

  /** `width` is the terminal width (0 uses the default of 80). */
  constructor(width: number, theme?: Theme) {
    const w = width <= 0 ? 80 : width;
    this.#renderer = new Renderer(theme ?? defaultTheme(), w);
  }

  /**
   * Feeds new Markdown content to the stream. The content should be the
   * accumulated Markdown text so far.
   */
  update(content: string): void {
    this.#builder = content;
  }

  /** Renders the current accumulated Markdown to ANSI terminal output. */
  output(): string {
    if (this.#builder === "") return "";
    const doc = parse(this.#builder, streamOption());
    return this.#renderer.render(doc);
  }
}

/** Creates a new streaming renderer. */
export function createStream(width: number, theme?: Theme): Stream {
  return new Stream(width, theme);
}

/** Convenience function for one-shot Markdown rendering. */
export function render(
  src: string,
  width: number,
  theme?: Theme,
): string {
  return renderMarkdown(src, width, theme);
}

/** Renders Markdown with streaming-optimized parsing. */
export function renderWithStreamOption(
  src: string,
  width: number,
  theme?: Theme,
): string {
  const w = width <= 0 ? 80 : width;
  const doc = parse(src, streamOption());
  return new Renderer(theme ?? defaultTheme(), w).render(doc);
}

export { defaultTheme, lightTheme };
