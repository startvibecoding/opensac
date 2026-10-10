// A reusable interactive dialog framework for the Ink TUI: a rounded panel with
// a title, an optional search/input box, a scrollable selectable list, and a
// footer hint. It owns cursor, search, input, and scroll state; concrete
// dialogs implement {@link DialogController} to supply pages and react to
// selections, exactly like the Go TUI's per-dialog models over one render shape.
//
// Dialogs never persist anything themselves: a controller mutates config
// through the shared config/session APIs and reports the result as a status
// message, so the panel is a real editor rather than a status display.

import { displayWidth, truncateDisplay } from "./formatters.ts";
import { type KeyEvent } from "./keys.ts";
import { ACCENT, BOLD, DIM, RED, RESET } from "./theme.ts";

/** Max selectable rows shown at once (Go authMaxVisibleOptions). */
export const MAX_VISIBLE_ITEMS = 5;

/** One selectable row. */
export interface DialogItem {
  label: string;
  description?: string;
  value: string;
  /** Marks the currently-effective item with `*`. */
  current?: boolean;
}

/** A single-line text prompt shown above the list. */
export interface DialogInput {
  prompt: string;
  value: string;
  placeholder?: string;
  /** Masks the value (API keys). */
  masked?: boolean;
}

/** One rendered dialog page. */
export interface DialogPage {
  title: string;
  items: DialogItem[];
  /** Optional search box; when present, printable keys filter the list. */
  search?: boolean;
  /** Optional single-line input box. */
  input?: DialogInput;
  /** Static lines shown before the list. */
  body?: string[];
  hint: string;
  error?: string;
}

/** What a dialog reports back to the session when it closes. */
export interface DialogOutcome {
  message?: string;
  error?: boolean;
  /**
   * Requests the session open another dialog after this one closes (Go
   * closeAuthDialog + openDefaultModelDialog handoffs).
   */
  handoff?: "auth" | "defaultModel" | "tuilang";
}

/** The behavior a concrete dialog implements. */
export interface DialogController {
  /** Builds the current page for the current state. */
  page(): DialogPage;
  /** A row was chosen with Enter. */
  select(value: string): void;
  /** The input box submitted its text. */
  submit(value: string): void;
  /** A printable key was pressed with no input box active. */
  key(name: string): void;
  /** Escape was pressed (the dialog may close or step back). */
  back(): void;
}

/**
 * The interactive panel. The session drives it with key events and renders
 * {@link view}; the controller mutates the underlying state.
 */
export class Dialog {
  #controller: DialogController;
  #cursor = 0;
  #search = "";
  #inputActive = false;
  #inputValue = "";
  #closed = false;
  #outcome: DialogOutcome = {};

  /**
   * Creates a dialog from a controller factory. The factory receives this
   * instance so the controller can close the panel or open its input box,
   * which keeps the controller/dialog pair free of a construction cycle.
   */
  constructor(factory: (dialog: Dialog) => DialogController) {
    this.#controller = factory(this);
  }

  get closed(): boolean {
    return this.#closed;
  }

  get outcome(): DialogOutcome {
    return this.#outcome;
  }

  /** Closes the dialog, optionally reporting a status message. */
  close(
    message?: string,
    error = false,
    handoff?: DialogOutcome["handoff"],
  ): void {
    this.#closed = true;
    if (message !== undefined && message !== "") {
      this.#outcome = { message, error };
    }
    if (handoff !== undefined) this.#outcome.handoff = handoff;
  }

  /** Opens the single-line input box (pre-filled with `value`). */
  openInput(value = ""): void {
    this.#inputActive = true;
    this.#inputValue = value;
  }

  /** Closes the input box without submitting. */
  closeInput(): void {
    this.#inputActive = false;
    this.#inputValue = "";
  }

  get inputActive(): boolean {
    return this.#inputActive;
  }

  get inputValue(): string {
    return this.#inputValue;
  }

  /** Resets the cursor to the top of the list (after a page change). */
  resetCursor(): void {
    this.#cursor = 0;
    this.#search = "";
    this.#inputActive = false;
    this.#inputValue = "";
  }

  /** Moves the selection, wrapping at both ends. */
  moveCursor(delta: number, total: number): void {
    if (total <= 0) {
      this.#cursor = 0;
      return;
    }
    this.#cursor += delta;
    if (this.#cursor < 0) this.#cursor = total - 1;
    if (this.#cursor >= total) this.#cursor = 0;
  }

  /** The index of the selected row. */
  get cursor(): number {
    return this.#cursor;
  }

  /** The active search query. */
  get search(): string {
    return this.#search;
  }

  /** Applies one key event. */
  handleKey(ev: KeyEvent): void {
    const page = this.#controller.page();

    // Input mode: the box owns printable keys and Enter.
    if (this.#inputActive && page.input !== undefined) {
      if (ev.type === "text") {
        this.#inputValue += ev.text;
        return;
      }
      switch (ev.name) {
        case "backspace":
          this.#inputValue = this.#inputValue.slice(0, -1);
          return;
        case "enter":
          this.#controller.submit(this.#inputValue);
          return;
        case "escape":
          this.closeInput();
          this.#controller.back();
          return;
        default:
          return;
      }
    }

    if (ev.type === "text") {
      if (page.search === true) {
        this.#search += ev.text;
        this.#cursor = 0;
        return;
      }
      this.#controller.key(ev.text);
      return;
    }

    switch (ev.name) {
      case "up":
        this.moveCursor(-1, this.#visibleItems(page).length);
        return;
      case "down":
        this.moveCursor(1, this.#visibleItems(page).length);
        return;
      case "enter": {
        // Select within the same filtered list that is rendered; otherwise a
        // search query would pick an unfiltered row at the same index.
        const items = this.#visibleItems(page);
        const item = items[this.#cursor];
        if (item !== undefined) this.#controller.select(item.value);
        return;
      }
      case "escape":
        if (this.#search !== "") {
          this.#search = "";
          this.#cursor = 0;
          return;
        }
        this.#controller.back();
        return;
      case "backspace":
        if (page.search === true && this.#search !== "") {
          this.#search = this.#search.slice(0, -1);
          this.#cursor = 0;
        }
        return;
      default:
        return;
    }
  }

  /** Renders the panel at the given terminal width. */
  view(terminalWidth: number): string {
    const page = this.#controller.page();
    const width = clampWidth(terminalWidth);
    const contentWidth = Math.max(width - 6, 20);

    const lines: string[] = [truncateDisplay(page.title, contentWidth), ""];
    if (page.body !== undefined) {
      for (const line of page.body) {
        lines.push(truncateDisplay(line, contentWidth));
      }
      lines.push("");
    }

    if (page.input !== undefined) {
      const value = this.#inputActive ? this.#inputValue : page.input.value;
      // Mask ordinary secrets, but leave ${ENV} references readable so users
      // can keep an existing env-based binding untouched.
      const keepReadable =
        page.input.masked === true &&
        value.startsWith("${") &&
        value.endsWith("}");
      const shown =
        page.input.masked === true && value !== "" && !keepReadable
          ? "*".repeat(Array.from(value).length)
          : value;
      const cursor = this.#inputActive ? `${ACCENT}█${RESET}` : "";
      const placeholder =
        shown === "" && page.input.placeholder !== undefined
          ? `${DIM}${page.input.placeholder}${RESET}`
          : "";
      lines.push(
        truncateDisplay(
          `${page.input.prompt} ${shown}${cursor}${placeholder}`,
          contentWidth,
        ),
      );
      lines.push("");
    } else if (page.search === true && this.#search !== "") {
      lines.push(
        truncateDisplay(`${DIM}search: ${this.#search}${RESET}`, contentWidth),
      );
      lines.push("");
    }

    const items = this.#visibleItems(page);
    if (items.length === 0) {
      lines.push(`${DIM}(no matches)${RESET}`);
    } else {
      const limit = Math.min(MAX_VISIBLE_ITEMS, items.length);
      const [start, end] = visibleRange(this.#cursor, items.length, limit);
      for (let i = start; i < end; i++) {
        const item = items[i];
        const pointer =
          i === this.#cursor ? `${ACCENT}${BOLD}› ${RESET}` : "  ";
        const marker = item.current === true ? "* " : "  ";
        lines.push(
          truncateDisplay(`${pointer}${marker}${item.label}`, contentWidth),
        );
        if (item.description !== undefined && item.description !== "") {
          lines.push(
            truncateDisplay(
              `    ${DIM}${item.description}${RESET}`,
              contentWidth,
            ),
          );
        }
      }
      if (items.length > limit) {
        lines.push(
          "",
          `${DIM}showing ${start + 1}-${end} of ${items.length}${RESET}`,
        );
      }
    }

    if (page.error !== undefined && page.error !== "") {
      lines.push(
        "",
        truncateDisplay(`${RED}${page.error}${RESET}`, contentWidth),
      );
    }
    lines.push("", `${DIM}${page.hint}${RESET}`);

    return frame(lines, width);
  }

  #filtered(items: DialogItem[]): DialogItem[] {
    if (this.#search === "") return items;
    const query = this.#search.toLowerCase();
    return items.filter(
      (item) =>
        item.label.toLowerCase().includes(query) ||
        item.value.toLowerCase().includes(query),
    );
  }

  /** Items currently visible after search filtering (one source of truth). */
  #visibleItems(page: DialogPage): DialogItem[] {
    return this.#filtered(page.items);
  }
}

/** Clamps a dialog to a readable width (Go 50..100). */
export function clampWidth(terminalWidth: number): number {
  let width = terminalWidth - 4;
  if (width < 50) width = 50;
  if (width > 100) width = 100;
  return width;
}

/** A centered window over `total` rows (Go authVisibleRange). */
export function visibleRange(
  cursor: number,
  total: number,
  limit: number,
): [number, number] {
  if (total <= 0) return [0, 0];
  if (limit <= 0 || total <= limit) return [0, total];
  let start = cursor - Math.floor(limit / 2);
  if (start < 0) start = 0;
  if (start + limit > total) start = total - limit;
  return [start, start + limit];
}

/** Wraps content lines in a rounded border of the given outer width. */
export function frame(lines: string[], width: number): string {
  const inner = Math.max(width - 2, 10);
  const body = lines.map((line) => {
    const pad = " ".repeat(Math.max(inner - displayWidth(line), 0));
    return `│ ${line}${pad} │`;
  });
  return [`╭${"─".repeat(inner)}╮`, ...body, `╰${"─".repeat(inner)}╯`].join(
    "\n",
  );
}

/** Normalizes an age into a short human string (Go formatAgeWithTranslator). */
export function formatAge(
  modTime: Date,
  now: Date,
  tr: {
    text(id: string, ...args: unknown[]): string;
  },
): string {
  const delta = now.getTime() - modTime.getTime();
  if (delta < 60_000) return tr.text("sessions.age.just_now");
  if (delta < 3_600_000) {
    return tr.text("sessions.age.minutes", Math.floor(delta / 60_000));
  }
  if (delta < 86_400_000) {
    return tr.text("sessions.age.hours", Math.floor(delta / 3_600_000));
  }
  if (delta < 30 * 86_400_000) {
    return tr.text("sessions.age.days", Math.floor(delta / 86_400_000));
  }
  return modTime.toISOString().slice(0, 10);
}
