// Owns the interactive input state behind the Ink shell: the editor buffer, the
// slash-command suggestion dropdown, input history, and paste folding. The
// shell translates raw key events into {@link InputAction}s; everything that
// mutates the draft lives here so the React layer stays a thin projection and
// the behavior is unit-testable without a TTY.
//
// (history + submit), command_suggest.go
// (dropdown), and app_paste.go (folding).

import { Editor } from "./components/editor/editor.ts";
import { Suggest, type SuggestItem } from "./components/suggest/suggest.ts";
import {
  commandSuggestionItems,
  commandSuggestionItemsForInput,
} from "./command_suggest.ts";
import { Translator } from "./i18n.ts";
import type { KeyName } from "./keys.ts";
import { PasteStore } from "./paste.ts";

/** What the shell should do after the input state handled a key event. */
export type InputAction =
  | { kind: "none" }
  | { kind: "submit" }
  | { kind: "escape" }
  | { kind: "cancel-or-exit" }
  | { kind: "tool-details" }
  | { kind: "plan-details" }
  | { kind: "esm-panel" }
  | { kind: "paste-image" }
  | { kind: "compact-toggle" }
  | { kind: "multi-agent-status" }
  | { kind: "cycle-mode" }
  | { kind: "page-up" }
  | { kind: "page-down" };

const MAX_HISTORY = 200;

export interface InputStateOptions {
  width: number;
  placeholder?: string;
  translator: Translator;
}

export class InputState {
  readonly editor: Editor;
  readonly suggest: Suggest;
  readonly paste = new PasteStore();
  readonly translator: Translator;

  #history: string[] = [];
  #historyBrowsing = false;
  #historyIndex = 0;
  #historyDraft = "";

  constructor(options: InputStateOptions) {
    this.translator = options.translator;
    this.editor = new Editor({
      width: options.width,
      placeholder: options.placeholder ??
        this.translator.text("input.placeholder"),
    });
    this.suggest = new Suggest(options.width, 8);
    this.updateSuggestions();
  }

  get value(): string {
    return this.editor.value;
  }

  /** Applies a width change to the editor and dropdown (frame offset -2). */
  setWidth(terminalWidth: number): void {
    this.editor.setWidth(terminalWidth - 2);
    this.suggest.setWidth(Math.max(terminalWidth - 2, 1));
  }

  /** Inserts literal text and refreshes the suggestion filter. */
  insertText(text: string): void {
    this.editor.insertText(text);
    this.updateSuggestions();
    this.resetHistoryNavigation();
  }

  /** Inserts a single space (the parser emits space as a named key). */
  insertSpace(): void {
    this.editor.insertText(" ");
    this.updateSuggestions();
    this.resetHistoryNavigation();
  }

  /** Folds a large pasted payload to a marker and inserts it. */
  insertPaste(text: string): void {
    this.editor.insertText(this.paste.fold(text));
    this.updateSuggestions();
    this.resetHistoryNavigation();
  }

  /** True while the draft is a slash command without a newline. */
  commandInputActive(): boolean {
    const value = this.editor.value;
    return value.startsWith("/") && !value.includes("\n");
  }

  /** True while the command name (before the first space) is being typed. */
  commandNameInputActive(): boolean {
    const value = this.editor.value;
    return value.startsWith("/") && !/[ \t\n]/.test(value);
  }

  get suggestionsVisible(): boolean {
    return this.suggest.visible;
  }

  /** Recomputes the dropdown from the current draft. */
  updateSuggestions(): void {
    const value = this.editor.value;
    const resolved = commandSuggestionItemsForInput(value, this.translator);
    if (resolved === undefined) {
      this.suggest.setItems(commandSuggestionItems(this.translator)).update("");
      return;
    }
    this.suggest.setItems(resolved.items).update(resolved.query);
  }

  /** Accepts the highlighted suggestion; true when the draft changed. */
  applySelectedSuggestion(): boolean {
    const item: SuggestItem | undefined = this.suggest.selected;
    if (!item || item.value === this.editor.value) return false;
    this.editor.setValue(item.value);
    this.updateSuggestions();
    return true;
  }

  /**
   * Clears the draft for submission: expands paste markers, records history,
   * and returns the trimmed text, or null when there is nothing to send.
   */
  takeSubmission(): string | null {
    const raw = this.editor.value.trim();
    this.editor.reset();
    this.suggest.setItems(commandSuggestionItems(this.translator)).update("");
    this.resetHistoryNavigation();
    if (raw === "") return null;
    this.recordHistory(raw);
    return this.paste.expand(raw);
  }

  /** Records a submitted input (Go recordInputHistory). */
  recordHistory(input: string): void {
    const trimmed = input.trim();
    if (trimmed === "") return;
    if (
      this.#history.length > 0 &&
      this.#history[this.#history.length - 1] === trimmed
    ) {
      this.resetHistoryNavigation();
      return;
    }
    this.#history.push(trimmed);
    if (this.#history.length > MAX_HISTORY) {
      this.#history = this.#history.slice(this.#history.length - MAX_HISTORY);
    }
    this.resetHistoryNavigation();
  }

  get history(): readonly string[] {
    return this.#history;
  }

  /** Moves through input history; true when the draft changed (Go navigateInputHistory). */
  navigateHistory(direction: number): boolean {
    if (this.#history.length === 0) return false;
    if (direction < 0) {
      if (!this.#historyBrowsing) {
        this.#historyDraft = this.editor.value;
        this.#historyIndex = this.#history.length - 1;
        this.#historyBrowsing = true;
      } else if (this.#historyIndex > 0) {
        this.#historyIndex--;
      }
    } else if (direction > 0) {
      if (!this.#historyBrowsing) return false;
      if (this.#historyIndex < this.#history.length - 1) {
        this.#historyIndex++;
      } else {
        this.#historyBrowsing = false;
        this.#historyIndex = 0;
        this.editor.setValue(this.#historyDraft);
        this.#historyDraft = "";
        this.updateSuggestions();
        return true;
      }
    } else {
      return false;
    }
    if (this.#historyIndex >= 0 && this.#historyIndex < this.#history.length) {
      this.editor.setValue(this.#history[this.#historyIndex]);
      this.updateSuggestions();
      return true;
    }
    return false;
  }

  resetHistoryNavigation(): void {
    this.#historyBrowsing = false;
    this.#historyIndex = 0;
    this.#historyDraft = "";
  }

  get historyBrowsing(): boolean {
    return this.#historyBrowsing;
  }

  /**
   * Handles one named key. Returns the shell-level action; editor edits return
   * `{ kind: "none" }`. Approval/question routing stays in the shell because it
   * owns the decision panels.
   */
  handleKey(name: KeyName, alt = false): InputAction {
    switch (name) {
      case "enter":
        if (alt) {
          this.editor.handleKey("alt+enter");
          this.updateSuggestions();
          this.resetHistoryNavigation();
          return { kind: "none" };
        }
        if (
          this.suggestionsVisible && this.commandNameInputActive() &&
          this.applySelectedSuggestion()
        ) {
          return { kind: "none" };
        }
        return { kind: "submit" };
      case "newline":
        this.editor.handleKey("ctrl+j");
        this.updateSuggestions();
        this.resetHistoryNavigation();
        return { kind: "none" };
      case "escape":
        return { kind: "escape" };
      case "tab":
        if (this.suggestionsVisible && this.applySelectedSuggestion()) {
          return { kind: "none" };
        }
        if (this.commandInputActive()) return { kind: "none" };
        return { kind: "cycle-mode" };
      case "shift+tab":
        return { kind: "none" };
      case "up":
        if (this.suggestionsVisible) {
          this.suggest.cursorUp();
          return { kind: "none" };
        }
        if (this.#historyBrowsing || this.editor.atFirstLine) {
          if (this.navigateHistory(-1)) return { kind: "none" };
        }
        if (!this.editor.atFirstLine) this.editor.handleKey("up");
        return { kind: "none" };
      case "down":
        if (this.suggestionsVisible) {
          this.suggest.cursorDown();
          return { kind: "none" };
        }
        if (this.#historyBrowsing && this.navigateHistory(1)) {
          return { kind: "none" };
        }
        if (!this.editor.atLastLine) this.editor.handleKey("down");
        return { kind: "none" };
      case "ctrl+c":
        return { kind: "cancel-or-exit" };
      case "ctrl+o":
        return { kind: "tool-details" };
      case "ctrl+t":
        return { kind: "plan-details" };
      case "ctrl+e":
        return { kind: "esm-panel" };
      case "ctrl+r":
        return { kind: "paste-image" };
      case "ctrl+g":
        return { kind: "compact-toggle" };
      case "ctrl+p":
        return { kind: "multi-agent-status" };
      case "pageup":
        return { kind: "page-up" };
      case "pagedown":
        return { kind: "page-down" };
      case "space":
        this.insertSpace();
        return { kind: "none" };
      case "backspace":
      case "delete":
      case "left":
      case "right":
      case "home":
      case "end":
      case "ctrl+a":
      case "ctrl+j":
      case "ctrl+k":
      case "ctrl+u":
      case "ctrl+w":
      case "ctrl+left":
      case "ctrl+right":
      case "alt+left":
      case "alt+right":
        this.editor.handleKey(name);
        this.updateSuggestions();
        if (
          name !== "left" && name !== "right" && name !== "home" &&
          name !== "end"
        ) {
          this.resetHistoryNavigation();
        }
        return { kind: "none" };
      case "alt+enter":
        this.editor.handleKey("alt+enter");
        this.updateSuggestions();
        return { kind: "none" };
      default:
        return { kind: "none" };
    }
  }
}
