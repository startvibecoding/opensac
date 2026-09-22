// Ported from internal/tui/tool_modal.go: the expanded tool-output modal.
// The Go original is App-coupled (targets from a.toolResults, activity from
// a.agentActivities); the TS projection splits ownership the same way the
// rest of the slice does — a state/geometry class owning scrolling, target
// switching, and chrome, with content lines supplied by the caller.

import { displayWidth } from "./formatters.ts";
import { Translator } from "./i18n.ts";

/** Style constants matching the Go toolModalStyle (rounded border + padding). */
const ACCENT = "\u001B[38;5;86m";
const BOLD = "\u001B[1m";
const DIM = "\u001B[38;5;240m";
const RESET = "\u001B[0m";

/** One modal content target (a tool result or a background agent). */
export interface ToolModalTarget {
  id: string;
  /** Tab label; falls back to kind when empty. */
  label?: string;
  kind: string;
}

export class ToolModalState {
  #width: number;
  #height: number;
  #targets: ToolModalTarget[] = [];
  #active = 0;
  #offset = 0;
  #pinnedBottom = true;

  constructor(width: number, height: number) {
    this.#width = Math.max(width, 20);
    this.#height = height;
  }

  setWidth(w: number): this {
    this.#width = Math.max(w, 20);
    return this;
  }

  setHeight(h: number): this {
    this.#height = h;
    return this;
  }

  setTargets(targets: ToolModalTarget[]): this {
    this.#targets = targets;
    if (this.#active >= targets.length) {
      this.#active = Math.max(targets.length - 1, 0);
    }
    return this;
  }

  get targets(): ToolModalTarget[] {
    return this.#targets;
  }

  get active(): number {
    return this.#active;
  }

  get pinnedBottom(): boolean {
    return this.#pinnedBottom;
  }

  get offset(): number {
    return this.#offset;
  }

  /** Width of the modal for a terminal width (Go toolModalWidth). */
  static widthFor(terminalWidth: number): number {
    const width = terminalWidth - 4;
    return width < 20 ? 20 : width;
  }

  /** Content width after horizontal padding (Go toolModalContentWidth). */
  static contentWidthFor(width: number): number {
    // Go toolModalStyle uses Padding(0, 2) → 4 horizontal columns.
    const w = width - 4;
    return w < 1 ? 1 : w;
  }

  /** Chrome rows: title + border + separator (+ tabs). */
  static chromeFor(hasTabs: boolean): number {
    return hasTabs ? 4 : 3;
  }

  /** Vertical frame rows (top + bottom border). */
  static verticalFrame(): number {
    return 2;
  }

  /** Page size for the given available height. */
  pageSizeFor(hasTabs: boolean, availableHeight: number): number {
    const pageSize = availableHeight -
      ToolModalState.chromeFor(hasTabs) -
      ToolModalState.verticalFrame();
    return pageSize < 1 ? 1 : pageSize;
  }

  /** Max scroll offset for the given line count and page size. */
  static maxOffsetFor(lineCount: number, pageSize: number): number {
    const maxOffset = lineCount - pageSize;
    return maxOffset < 0 ? 0 : maxOffset;
  }

  /** Switches to the next/previous target; resets scroll. */
  switchTarget(delta: number): void {
    if (this.#targets.length <= 1) return;
    this.#active += delta;
    if (this.#active < 0) this.#active = this.#targets.length - 1;
    if (this.#active >= this.#targets.length) this.#active = 0;
    this.#pinnedBottom = true;
    this.#offset = 0;
  }

  /** Scrolls by delta lines, clamping and updating the bottom pin. */
  scroll(delta: number, lineCount: number, pageSize: number): void {
    this.#offset += delta;
    if (this.#offset < 0) this.#offset = 0;
    const maxOffset = ToolModalState.maxOffsetFor(lineCount, pageSize);
    if (this.#offset > maxOffset) this.#offset = maxOffset;
    this.#pinnedBottom = this.#offset === maxOffset;
  }

  /** Snaps to the bottom when pinned (call before rendering). */
  applyPin(lineCount: number, pageSize: number): void {
    const maxOffset = ToolModalState.maxOffsetFor(lineCount, pageSize);
    if (this.#pinnedBottom) this.#offset = maxOffset;
    if (this.#offset > maxOffset) this.#offset = maxOffset;
  }

  /**
   * Renders the modal frame around the given content lines.
   * `tr` supplies the localized title/hints.
   */
  render(
    lines: string[],
    tr: Translator,
    options: { availableHeight?: number } = {},
  ): string {
    const width = this.#width;
    const contentWidth = ToolModalState.contentWidthFor(width);
    const hasTabs = this.#targets.length > 1;
    const availableHeight = options.availableHeight ?? this.#height;
    const pageSize = this.pageSizeFor(hasTabs, availableHeight);
    this.applyPin(lines.length, pageSize);

    const end = Math.min(this.#offset + pageSize, lines.length);
    let visible = lines.slice(this.#offset, end).join("\n");
    if (visible === "") visible = " ";

    let position = tr.text(
      "tool.modal.position",
      this.#offset + 1,
      end,
      lines.length,
    );
    if (lines.length === 0) {
      position = tr.text("tool.modal.position_empty");
    }
    let title = `${tr.text("tool.modal.title")}  ${position}  ${
      tr.text("tool.modal.switch_target_hint")
    }  ${tr.text("tool.modal.page_hint")}  ${
      tr.text("tool.modal.scroll_hint")
    }  ${tr.text("tool.modal.close_hint")}`;
    title = truncateDisplay(title, contentWidth);

    const tabs = this.#renderTabs(contentWidth);
    let header = title;
    if (tabs) header += "\n" + tabs;
    const separator = "─".repeat(Math.min(contentWidth, displayWidth(title)));
    const content = `${header}\n${separator}\n${visible}`;
    const chrome = ToolModalState.chromeFor(hasTabs);
    return frameBox(content, width, pageSize + chrome);
  }

  #renderTabs(width: number): string {
    if (this.#targets.length <= 1) return "";
    const parts: string[] = [];
    for (let i = 0; i < this.#targets.length; i++) {
      const target = this.#targets[i];
      const label = target.label || target.kind;
      parts.push(
        i === this.#active
          ? `${ACCENT}${BOLD}${label}${RESET}`
          : `${DIM}${label}${RESET}`,
      );
    }
    const row = parts.join("  |  ");
    if (displayWidth(row) > width) return truncateDisplay(row, width);
    return row;
  }
}

/** ANSI-aware truncation with an "…" suffix (Go xansi.Truncate). */
function truncateDisplay(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (displayWidth(s) <= maxWidth) return s;
  let w = 0;
  let out = "";
  let i = 0;
  const chars = Array.from(s);
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === "\u001B") {
      let seq = ch;
      i++;
      if (i < chars.length && chars[i] === "[") {
        seq += chars[i];
        i++;
        while (i < chars.length && !/[\x40-\x7E]/.test(chars[i])) {
          seq += chars[i];
          i++;
        }
        if (i < chars.length) {
          seq += chars[i];
          i++;
        }
      } else if (i < chars.length) {
        seq += chars[i];
        i++;
      }
      out += seq;
      continue;
    }
    const rw = displayWidth(ch);
    if (w + rw > maxWidth - 1) break;
    out += ch;
    w += rw;
    i++;
  }
  return out + "…";
}

function frameBox(content: string, width: number, height: number): string {
  const inner = Math.max(width - 2, 4);
  const lines = content.split("\n");
  while (lines.length < height) lines.push("");
  const body = lines.map((l) => {
    // `│ ` + text + padding + ` │` must equal the inner width.
    const pad = " ".repeat(Math.max(inner - 2 - displayWidth(l), 0));
    return `│ ${l}${pad} │`;
  });
  return [
    `╭${"─".repeat(inner)}╮`,
    ...body,
    `╰${"─".repeat(inner)}╯`,
  ].join("\n");
}
