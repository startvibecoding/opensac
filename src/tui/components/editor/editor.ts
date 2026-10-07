// a multi-line text
// editor component. Enter submits (SubmitMsg), Alt+Enter / Ctrl+J insert a
// newline. The Go original is a Bubble Tea Model; the TS projection keeps the
// same state and view logic as a plain class with a string-keyed handler so
// the Ink layer can map `useInput` events onto it without owning semantics.

import { displayWidth } from "../../formatters.ts";
import { DIM, RESET } from "../../theme.ts";
import { Buffer } from "./buffer.ts";

export const CURSOR_BLINK_INTERVAL_MS = 530;

/** Editor-specific surface constants mirroring the Go lipgloss styles. */
const BG = "\u001B[48;5;236m";
const REVERSE = "\u001B[7m";

export interface EditorOptions {
  width: number;
  maxLines?: number;
  placeholder?: string;
  prompt?: string;
}

interface DisplayLine {
  text: string;
  bufLine: number;
  startCol: number;
  endCol: number;
}

export class Editor {
  #buf = new Buffer();
  #focus = true;
  #cursorOn = true;
  #width: number;
  #maxLines: number;
  #placeholder: string;
  #prompt: string;

  constructor(options: EditorOptions) {
    this.#width = options.width;
    this.#maxLines = options.maxLines ?? 5;
    this.#placeholder = options.placeholder ?? "Type a message...";
    this.#prompt = options.prompt ?? "";
  }

  focus(): this {
    this.#focus = true;
    this.#cursorOn = true;
    return this;
  }

  blur(): this {
    this.#focus = false;
    return this;
  }

  get focused(): boolean {
    return this.#focus;
  }

  get value(): string {
    return this.#buf.value;
  }

  setValue(text: string): this {
    this.#buf.setValue(text);
    this.#buf.moveEndAll();
    return this;
  }

  reset(): this {
    this.#buf.reset();
    return this;
  }

  setWidth(w: number): this {
    this.#width = w;
    return this;
  }

  setMaxLines(n: number): this {
    this.#maxLines = n;
    return this;
  }

  setPlaceholder(s: string): this {
    this.#placeholder = s;
    return this;
  }

  get placeholder(): string {
    return this.#placeholder;
  }

  setPrompt(s: string): this {
    this.#prompt = s;
    return this;
  }

  get lineCount(): number {
    return this.#buf.lineCount;
  }

  cursorPos(): [number, number] {
    return this.#buf.cursorPos();
  }

  cursorEnd(): this {
    this.#buf.moveEndAll();
    return this;
  }

  insertString(s: string): this {
    this.#buf.insertString(s);
    return this;
  }

  get atFirstLine(): boolean {
    return this.#buf.cursorLine === 0;
  }

  get atLastLine(): boolean {
    return this.#buf.cursorLine >= this.#buf.lineCount - 1;
  }

  /** Toggles the cursor blink (Go cursorBlinkMsg). */
  blinkCursor(): void {
    this.#cursorOn = !this.#cursorOn;
  }

  /**
   * Restores a solid (visible) caret. Used when a run ends and the blink stops:
   * the idle editor keeps showing a steady caret without repainting to animate
   * it, so the caret never stays stuck in the hidden blink phase.
   */
  showCursor(): void {
    this.#cursorOn = true;
  }

  /**
   * Handles one key event by name; rune input goes through {@link insertText}.
   * Key names: enter, backspace, delete, left, right, up, down, home, end,
   * tab, ctrl+a, ctrl+e, ctrl+j, ctrl+k, ctrl+u, ctrl+w, alt+enter,
   * alt+left, alt+right, ctrl+left, ctrl+right.
   * Returns true when Enter produced a submit.
   */
  handleKey(key: string): boolean {
    if (!this.#focus) return false;
    switch (key) {
      case "alt+enter":
        this.#buf.insertNewline();
        return false;
      case "enter":
        return true; // submit
      case "ctrl+j":
        this.#buf.insertNewline();
        return false;
      case "backspace":
        this.#buf.deleteBack();
        return false;
      case "delete":
        this.#buf.deleteForward();
        return false;
      case "alt+left":
      case "ctrl+left":
        this.#buf.moveWordLeft();
        return false;
      case "alt+right":
      case "ctrl+right":
        this.#buf.moveWordRight();
        return false;
      case "left":
        this.#buf.moveLeft();
        return false;
      case "right":
        this.#buf.moveRight();
        return false;
      case "up":
        this.#buf.moveUp();
        return false;
      case "down":
        this.#buf.moveDown();
        return false;
      case "home":
      case "ctrl+a":
        this.#buf.moveHome();
        return false;
      case "end":
      case "ctrl+e":
        this.#buf.moveEnd();
        return false;
      case "ctrl+k":
        this.#buf.deleteToLineEnd();
        return false;
      case "ctrl+u":
        this.#buf.deleteToLineStart();
        return false;
      case "ctrl+w":
        this.#buf.deleteWordBack();
        return false;
      case "space":
        this.#buf.insertRune(" ");
        return false;
      case "tab":
        this.#buf.insertString("  ");
        return false;
      default:
        return false;
    }
  }

  /** Inserts literal text (Go tea.KeyRunes). */
  insertText(text: string): void {
    if (!this.#focus) return;
    for (const r of Array.from(text)) {
      if (r === "\n") this.#buf.insertNewline();
      else this.#buf.insertRune(r);
    }
  }

  /** Renders the editor view (windowed around the cursor). */
  view(): string {
    const promptW = displayWidth(this.#prompt);
    // The Go style has Padding(0,1) → horizontal frame size 2.
    const frameW = 2;
    let contentW = this.#width - frameW;
    if (contentW < 1) contentW = 1;
    let availW = contentW - promptW;
    if (availW < 1) availW = 1;

    const text = this.#buf.value;
    const isEmpty = text === "";

    let displayLines: DisplayLine[];
    if (isEmpty && !this.#focus) {
      displayLines = [{ text: "", bufLine: 0, startCol: 0, endCol: 0 }];
    } else if (isEmpty) {
      displayLines = [{
        text: this.#renderEmptyLine(),
        bufLine: 0,
        startCol: 0,
        endCol: 0,
      }];
    } else {
      displayLines = this.#buildDisplayLines(availW);
    }

    const maxVis = Math.max(this.#maxLines, 1);
    const totalLines = displayLines.length;
    const cursorDispLine = this.#cursorDisplayLine(availW);

    let startLine = 0;
    if (totalLines > maxVis) {
      startLine = cursorDispLine - Math.floor(maxVis / 2);
      if (startLine < 0) startLine = 0;
      if (startLine + maxVis > totalLines) startLine = totalLines - maxVis;
    }
    const endLine = Math.min(startLine + maxVis, totalLines);

    const renderedLines: string[] = [];
    const [cursorBufLine, cursorBufCol] = this.#buf.cursorPos();

    for (let i = startLine; i < endLine; i++) {
      let line = displayLines[i].text;
      if (!isEmpty && this.#focus && this.#cursorOn && i === cursorDispLine) {
        line = this.#insertCursor(displayLines[i], cursorBufLine, cursorBufCol);
      }
      renderedLines.push(this.#prompt + line);
    }

    const view = renderedLines.join("\n");
    return this.#styleWidth(view);
  }

  #styleWidth(view: string): string {
    // Apply the padded background to each line, padded to the editor width.
    const inner = this.#width - 2;
    return view.split("\n").map((line) => {
      const pad = " ".repeat(Math.max(inner - displayWidth(line), 0));
      return `${BG} ${line}${pad} ${RESET}`;
    }).join("\n");
  }

  #cursorDisplayLine(availW: number): number {
    if (this.#buf.value === "") return 0;
    const [cursorLine, cursorCol] = this.#buf.cursorPos();
    const displayLines = this.#buildDisplayLines(availW);
    for (let i = 0; i < displayLines.length; i++) {
      const line = displayLines[i];
      if (line.bufLine !== cursorLine) continue;
      if (cursorCol >= line.startCol && cursorCol <= line.endCol) return i;
    }
    if (displayLines.length === 0) return 0;
    return displayLines.length - 1;
  }

  #insertCursor(line: DisplayLine, bufLine: number, bufCol: number): string {
    if (line.bufLine !== bufLine) return line.text;
    const runes = Array.from(line.text);
    let runePos = bufCol - line.startCol;
    if (runePos < 0) runePos = 0;
    if (runePos > runes.length) runePos = runes.length;
    if (runePos < runes.length) {
      const ch = runes[runePos];
      const before = runes.slice(0, runePos).join("");
      const after = runes.slice(runePos + 1).join("");
      return `${before}${REVERSE}${ch}${RESET}${after}`;
    }
    return runes.join("") + `${REVERSE} ${RESET}`;
  }

  #renderEmptyLine(): string {
    if (this.#placeholder === "") {
      if (this.#cursorOn) return `${REVERSE} ${RESET}`;
      return " ";
    }
    const dimText = `${DIM}${this.#placeholder}${RESET}`;
    if (!this.#cursorOn) return dimText;
    const runes = Array.from(this.#placeholder);
    return `${REVERSE}${runes[0]}${RESET}${DIM}${
      runes.slice(1).join("")
    }${RESET}`;
  }

  #buildDisplayLines(availW: number): DisplayLine[] {
    const rawLines = this.#buf.value.split("\n");
    const displayLines: DisplayLine[] = [];
    rawLines.forEach((line, lineNum) => {
      displayLines.push(...wrapLineSegments(line, availW, lineNum, 0));
    });
    if (displayLines.length === 0) {
      return [{ text: "", bufLine: 0, startCol: 0, endCol: 0 }];
    }
    return displayLines;
  }
}

/** Wraps one logical line into display segments for the given width. */
export function wrapLineSegments(
  line: string,
  width: number,
  bufLine: number,
  startCol: number,
): DisplayLine[] {
  const runes = Array.from(line);
  if (width <= 0 || displayWidth(line) <= width) {
    return [{
      text: line,
      bufLine,
      startCol,
      endCol: startCol + runes.length,
    }];
  }

  const result: DisplayLine[] = [];
  let current: string[] = [];
  let currentW = 0;
  let segmentStart = startCol;

  for (let i = 0; i < runes.length; i++) {
    const r = runes[i];
    const rw = displayWidth(r);
    if (currentW > 0 && currentW + rw > width) {
      result.push({
        text: current.join(""),
        bufLine,
        startCol: segmentStart,
        endCol: startCol + i,
      });
      segmentStart = startCol + i;
      current = [r];
      currentW = rw;
    } else {
      current.push(r);
      currentW += rw;
    }
  }
  if (current.length > 0) {
    result.push({
      text: current.join(""),
      bufLine,
      startCol: segmentStart,
      endCol: startCol + runes.length,
    });
  }
  if (result.length === 0) {
    result.push({ text: "", bufLine, startCol, endCol: startCol });
  }
  return result;
}
