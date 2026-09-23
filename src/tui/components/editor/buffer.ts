// a Unicode-aware
// multi-line text buffer. Text is stored as lines (no trailing newline);
// the cursor is (line, col) with col a rune offset, plus a preferred column
// for vertical navigation. maxHeight/width wrapping is handled by the editor
// view, not the buffer.

import { displayWidth } from "../../formatters.ts";

export class Buffer {
  #lines: string[] = [""];
  #cursorLine = 0;
  #cursorCol = 0;
  #preferredCol = 0;

  /** Full text content (lines joined with "\n"). */
  get value(): string {
    return this.#lines.join("\n");
  }

  /** Replaces all content and resets the cursor. */
  setValue(text: string): void {
    if (text === "") {
      this.#lines = [""];
    } else {
      this.#lines = text.replaceAll("\r\n", "\n").split("\n");
    }
    this.#cursorLine = 0;
    this.#cursorCol = 0;
    this.#preferredCol = 0;
  }

  /** Clears all content and cursor position. */
  reset(): void {
    this.#lines = [""];
    this.#cursorLine = 0;
    this.#cursorCol = 0;
    this.#preferredCol = 0;
  }

  get lineCount(): number {
    return this.#lines.length;
  }

  /** Total rune count including newline separators. */
  get runeCount(): number {
    let n = 0;
    for (let i = 0; i < this.#lines.length; i++) {
      n += Array.from(this.#lines[i]).length;
      if (i < this.#lines.length - 1) n++;
    }
    return n;
  }

  get cursorLine(): number {
    return this.#cursorLine;
  }

  get cursorCol(): number {
    return this.#cursorCol;
  }

  /** The current line (no newline). */
  get currentLine(): string {
    return this.#lines[this.#cursorLine] ?? "";
  }

  /** Inserts a single rune at the cursor. */
  insertRune(r: string): void {
    this.#clampCursor();
    const runes = Array.from(this.#lines[this.#cursorLine]);
    runes.splice(this.#cursorCol, 0, r);
    this.#lines[this.#cursorLine] = runes.join("");
    this.#cursorCol++;
    this.#preferredCol = this.#cursorCol;
  }

  /** Inserts a string at the cursor, splitting on newlines (\r\n, \r too). */
  insertString(s: string): void {
    s = s.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    if (!s.includes("\n")) {
      for (const r of Array.from(s)) this.insertRune(r);
      return;
    }

    this.#clampCursor();
    const runes = Array.from(this.#lines[this.#cursorLine]);
    const col = Math.min(this.#cursorCol, runes.length);
    const before = runes.slice(0, col).join("");
    const after = runes.slice(col).join("");

    const parts = s.split("\n");
    const newLines = [
      before + parts[0],
      ...parts.slice(1, -1),
      parts[parts.length - 1] + after,
    ];

    this.#lines.splice(
      this.#cursorLine,
      1,
      ...newLines,
    );

    this.#cursorLine += newLines.length - 1;
    this.#cursorCol = Array.from(parts[parts.length - 1]).length;
    this.#preferredCol = this.#cursorCol;
  }

  /** Splits the current line at the cursor. */
  insertNewline(): void {
    this.#clampCursor();
    const runes = Array.from(this.#lines[this.#cursorLine]);
    const col = Math.min(this.#cursorCol, runes.length);
    const before = runes.slice(0, col).join("");
    const after = runes.slice(col).join("");
    this.#lines.splice(this.#cursorLine, 1, before, after);
    this.#cursorLine++;
    this.#cursorCol = 0;
    this.#preferredCol = 0;
  }

  /** Removes the character before the cursor (Backspace). */
  deleteBack(): void {
    this.#clampCursor();
    if (this.#cursorCol > 0) {
      const runes = Array.from(this.#lines[this.#cursorLine]);
      runes.splice(this.#cursorCol - 1, 1);
      this.#lines[this.#cursorLine] = runes.join("");
      this.#cursorCol--;
      this.#preferredCol = this.#cursorCol;
    } else if (this.#cursorLine > 0) {
      const prev = this.#lines[this.#cursorLine - 1];
      const curr = this.#lines[this.#cursorLine];
      this.#cursorCol = Array.from(prev).length;
      this.#lines.splice(this.#cursorLine - 1, 2, prev + curr);
      this.#cursorLine--;
      this.#preferredCol = this.#cursorCol;
    }
  }

  /** Removes the character at the cursor (Delete); merges with next line. */
  deleteForward(): void {
    this.#clampCursor();
    const runes = Array.from(this.#lines[this.#cursorLine]);
    if (this.#cursorCol < runes.length) {
      runes.splice(this.#cursorCol, 1);
      this.#lines[this.#cursorLine] = runes.join("");
    } else if (this.#cursorLine < this.#lines.length - 1) {
      const curr = this.#lines[this.#cursorLine];
      const next = this.#lines[this.#cursorLine + 1];
      this.#lines.splice(this.#cursorLine, 2, curr + next);
    }
  }

  /** Removes from the cursor to end of line (Ctrl+K). */
  deleteToLineEnd(): void {
    this.#clampCursor();
    const runes = Array.from(this.#lines[this.#cursorLine]);
    if (this.#cursorCol < runes.length) {
      this.#lines[this.#cursorLine] = runes.slice(0, this.#cursorCol).join("");
    }
  }

  /** Removes from start of line to the cursor (Ctrl+U). */
  deleteToLineStart(): void {
    this.#clampCursor();
    const runes = Array.from(this.#lines[this.#cursorLine]);
    if (this.#cursorCol > 0) {
      this.#lines[this.#cursorLine] = runes.slice(this.#cursorCol).join("");
      this.#cursorCol = 0;
      this.#preferredCol = 0;
    }
  }

  /** Removes the word before the cursor (Ctrl+W). */
  deleteWordBack(): void {
    this.#clampCursor();
    if (this.#cursorCol === 0) {
      this.deleteBack();
      return;
    }
    const runes = Array.from(this.#lines[this.#cursorLine]);
    const end = this.#cursorCol;
    let start = end;
    while (start > 0 && isSpace(runes[start - 1])) start--;
    while (start > 0 && !isSpace(runes[start - 1])) start--;
    runes.splice(start, end - start);
    this.#lines[this.#cursorLine] = runes.join("");
    this.#cursorCol = start;
    this.#preferredCol = start;
  }

  /** Moves one character left; wraps to the end of the previous line. */
  moveLeft(): void {
    this.#clampCursor();
    if (this.#cursorCol > 0) {
      this.#cursorCol--;
      this.#preferredCol = this.#cursorCol;
    } else if (this.#cursorLine > 0) {
      this.#cursorLine--;
      this.#cursorCol = Array.from(this.#lines[this.#cursorLine]).length;
      this.#preferredCol = this.#cursorCol;
    }
  }

  /** Moves one character right; wraps to the start of the next line. */
  moveRight(): void {
    this.#clampCursor();
    const lineLen = Array.from(this.#lines[this.#cursorLine]).length;
    if (this.#cursorCol < lineLen) {
      this.#cursorCol++;
      this.#preferredCol = this.#cursorCol;
    } else if (this.#cursorLine < this.#lines.length - 1) {
      this.#cursorLine++;
      this.#cursorCol = 0;
      this.#preferredCol = 0;
    }
  }

  /** Moves to the start of the previous word. */
  moveWordLeft(): void {
    this.#clampCursor();
    const runes = Array.from(this.value);
    let pos = this.#absoluteCursor();
    if (pos === 0 || runes.length === 0) return;
    while (pos > 0 && isSpace(runes[pos - 1])) pos--;
    while (pos > 0 && !isSpace(runes[pos - 1])) pos--;
    this.#setAbsoluteCursor(pos);
  }

  /** Moves to the end of the next word. */
  moveWordRight(): void {
    this.#clampCursor();
    const runes = Array.from(this.value);
    let pos = this.#absoluteCursor();
    if (pos >= runes.length || runes.length === 0) return;
    while (pos < runes.length && isSpace(runes[pos])) pos++;
    while (pos < runes.length && !isSpace(runes[pos])) pos++;
    this.#setAbsoluteCursor(pos);
  }

  /** Moves one line up honoring preferredCol; false at the top line. */
  moveUp(): boolean {
    this.#clampCursor();
    if (this.#cursorLine === 0) return false;
    this.#cursorLine--;
    const lineLen = Array.from(this.#lines[this.#cursorLine]).length;
    this.#cursorCol = Math.min(this.#preferredCol, lineLen);
    return true;
  }

  /** Moves one line down honoring preferredCol; false at the last line. */
  moveDown(): boolean {
    this.#clampCursor();
    if (this.#cursorLine >= this.#lines.length - 1) return false;
    this.#cursorLine++;
    const lineLen = Array.from(this.#lines[this.#cursorLine]).length;
    this.#cursorCol = Math.min(this.#preferredCol, lineLen);
    return true;
  }

  /** Moves to the start of the current line. */
  moveHome(): void {
    this.#cursorCol = 0;
    this.#preferredCol = 0;
  }

  /** Moves to the end of the current line. */
  moveEnd(): void {
    this.#cursorCol = Array.from(this.#lines[this.#cursorLine]).length;
    this.#preferredCol = this.#cursorCol;
  }

  /** Moves to the very end of the buffer. */
  moveEndAll(): void {
    this.#cursorLine = this.#lines.length - 1;
    if (this.#cursorLine < 0) {
      this.#cursorLine = 0;
      this.#lines = [""];
    }
    this.#cursorCol = Array.from(this.#lines[this.#cursorLine]).length;
    this.#preferredCol = this.#cursorCol;
  }

  /** The cursor position as [line, col]. */
  cursorPos(): [number, number] {
    return [this.#cursorLine, this.#cursorCol];
  }

  #absoluteCursor(): number {
    let pos = 0;
    for (let i = 0; i < this.#cursorLine && i < this.#lines.length; i++) {
      pos += Array.from(this.#lines[i]).length + 1;
    }
    return pos + this.#cursorCol;
  }

  #setAbsoluteCursor(pos: number): void {
    const total = this.runeCount;
    if (pos < 0) pos = 0;
    if (pos > total) pos = total;
    for (let i = 0; i < this.#lines.length; i++) {
      const lineLen = Array.from(this.#lines[i]).length;
      if (pos <= lineLen) {
        this.#cursorLine = i;
        this.#cursorCol = pos;
        this.#preferredCol = pos;
        return;
      }
      pos -= lineLen + 1;
    }
    this.moveEndAll();
  }

  #clampCursor(): void {
    if (this.#cursorLine < 0) this.#cursorLine = 0;
    if (this.#cursorLine >= this.#lines.length) {
      this.#cursorLine = this.#lines.length - 1;
    }
    const lineLen = Array.from(this.#lines[this.#cursorLine]).length;
    if (this.#cursorCol < 0) this.#cursorCol = 0;
    if (this.#cursorCol > lineLen) this.#cursorCol = lineLen;
  }

  /** Display column of the cursor in terminal cells. */
  cursorDisplayCol(): number {
    this.#clampCursor();
    const runes = Array.from(this.#lines[this.#cursorLine]);
    if (this.#cursorCol > runes.length) this.#cursorCol = runes.length;
    return displayWidth(runes.slice(0, this.#cursorCol).join(""));
  }
}

function isSpace(r: string): boolean {
  return /\s/.test(r);
}
