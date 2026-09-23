// the autocomplete
// suggestion dropdown for slash commands. Prefix-matches items against the
// current query, wraps the selection, and renders a rounded-border dropdown
// with a scroll window centered on the cursor.

import { displayWidth, truncateDisplay } from "../../formatters.ts";
import { ACCENT, BOLD, DIM, RESET } from "../../theme.ts";

/** One autocomplete suggestion. */
export interface SuggestItem {
  /** Display text. */
  label: string;
  /** Optional description. */
  description?: string;
  /** The actual value to insert. */
  value: string;
}

export class Suggest {
  #items: SuggestItem[] = [];
  #filtered: SuggestItem[] = [];
  #cursor = 0;
  #maxVisible: number;
  #visible = false;
  #query = "";
  #width: number;

  constructor(width: number, maxVisible = 8) {
    this.#width = width;
    this.#maxVisible = maxVisible;
  }

  /** Sets the available completion items and re-filters. */
  setItems(items: SuggestItem[]): this {
    this.#items = items;
    this.#filter();
    return this;
  }

  setWidth(width: number): this {
    this.#width = width;
    return this;
  }

  /** Updates the filter from the current input query. */
  update(query: string): this {
    this.#query = query;
    this.#filter();
    return this;
  }

  get visible(): boolean {
    return this.#visible;
  }

  /** The currently selected item, or undefined. */
  get selected(): SuggestItem | undefined {
    if (this.#filtered.length === 0) return undefined;
    if (this.#cursor < 0 || this.#cursor >= this.#filtered.length) {
      return undefined;
    }
    return this.#filtered[this.#cursor];
  }

  get cursor(): number {
    return this.#cursor;
  }

  /** The filtered items in display order. */
  get filtered(): SuggestItem[] {
    return this.#filtered;
  }

  /** Moves the selection up, wrapping to the bottom at the top. */
  cursorUp(): this {
    if (this.#filtered.length === 0) return this;
    this.#cursor--;
    if (this.#cursor < 0) this.#cursor = this.#filtered.length - 1;
    return this;
  }

  /** Moves the selection down, wrapping to the top at the bottom. */
  cursorDown(): this {
    if (this.#filtered.length === 0) return this;
    this.#cursor++;
    if (this.#cursor >= this.#filtered.length) this.#cursor = 0;
    return this;
  }

  /** Renders the dropdown; "" when hidden or nothing matches. */
  view(): string {
    if (!this.#visible || this.#filtered.length === 0) return "";

    const contentWidth = Math.max(this.#width - 2, 1);

    let start = 0;
    let end = this.#filtered.length;
    let hasMore = false;

    if (end > this.#maxVisible) {
      start = this.#cursor - Math.floor(this.#maxVisible / 2);
      if (start < 0) start = 0;
      end = start + this.#maxVisible;
      if (end > this.#filtered.length) {
        end = this.#filtered.length;
        start = end - this.#maxVisible;
        if (start < 0) start = 0;
      }
      hasMore = true;
    }

    const lines: string[] = [];
    for (let i = start; i < end; i++) {
      lines.push(
        this.#renderItem(this.#filtered[i], i === this.#cursor, contentWidth),
      );
    }

    if (hasMore) {
      const indicator = "  ↑↓ more";
      const padded = indicator + " ".repeat(
        Math.max(contentWidth - displayWidth(indicator), 0),
      );
      lines.push(`${DIM}${padded}${RESET}`);
    }

    return roundedDropdown(lines, contentWidth);
  }

  #renderItem(item: SuggestItem, selected: boolean, maxWidth: number): string {
    const label = item.label;
    const desc = item.description ? ` ${item.description}` : "";
    let line = label + desc;
    if (displayWidth(line) > maxWidth) {
      line = truncateDisplay(line, maxWidth);
    } else {
      line = line + " ".repeat(maxWidth - displayWidth(line));
    }
    return selected
      ? `${ACCENT}${BOLD}${line}${RESET}`
      : `${DIM}${line}${RESET}`;
  }

  #filter(): void {
    const q = this.#query.toLowerCase();
    if (q === "") {
      this.#filtered = this.#items;
      this.#visible = false;
      this.#cursor = clampCursor(this.#cursor, this.#filtered.length);
      return;
    }
    const matched = this.#items.filter((item) =>
      item.label.toLowerCase().startsWith(q) ||
      item.value.toLowerCase().startsWith(q)
    );
    this.#filtered = matched;
    this.#visible = matched.length > 0;
    this.#cursor = clampCursor(this.#cursor, this.#filtered.length);
  }
}

function clampCursor(cursor: number, count: number): number {
  if (count === 0) return 0;
  if (cursor >= count) return count - 1;
  if (cursor < 0) return 0;
  return cursor;
}

function roundedDropdown(lines: string[], contentWidth: number): string {
  const top = `╭${"─".repeat(contentWidth + 2)}╮`;
  const bottom = `╰${"─".repeat(contentWidth + 2)}╯`;
  const body = lines.map((l) => {
    const pad = " ".repeat(Math.max(contentWidth - displayWidth(l), 0));
    return `│ ${l}${pad} │`;
  });
  return [top, ...body, bottom].join("\n");
}
