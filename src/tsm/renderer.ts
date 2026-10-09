//
// Converts a Markdown AST into ANSI-styled terminal output. Zero external
// dependencies.

import { Node, NodeType } from "./node.ts";
import { defaultOption, parse as parseDoc } from "./parser.ts";

// ── ANSI Escape Codes ───────────────────────────────────────────────────────

export const ansiReset = "\x1b[0m";
const ansiBold = "\x1b[1m";
const ansiDim = "\x1b[2m";
const ansiItalic = "\x1b[3m";
const ansiUnderline = "\x1b[4m";
const ansiStrike = "\x1b[9m";

const ansiFgBlack = "\x1b[30m";
const ansiFgRed = "\x1b[31m";
const ansiFgGreen = "\x1b[32m";
const ansiFgYellow = "\x1b[33m";
const ansiFgBlue = "\x1b[34m";
const ansiFgMagenta = "\x1b[35m";
const ansiFgCyan = "\x1b[36m";

const ansiFgBrightBlack = "\x1b[90m";
const ansiFgBrightRed = "\x1b[91m";
const ansiFgBrightGreen = "\x1b[92m";
const ansiFgBrightYellow = "\x1b[93m";
const ansiFgBrightBlue = "\x1b[94m";
const ansiFgBrightMagenta = "\x1b[95m";
const ansiFgBrightCyan = "\x1b[96m";
const ansiFgBrightWhite = "\x1b[97m";

// ── Theme ───────────────────────────────────────────────────────────────────

/** Defines ANSI styles for every Markdown element. */
export interface Theme {
  heading: string;
  heading1: string;
  heading2: string;
  heading3: string;
  heading4: string;
  heading5: string;
  heading6: string;
  blockQuote: string;
  blockQuoteBar: string;
  codeText: string;
  codeBg: string;
  codeLang: string;
  tableBorder: string;
  tableHeader: string;
  tableHeaderText: string;
  tableCell: string;
  horizontal: string;
  listBullet: string;
  listNumber: string;
  bold: string;
  italic: string;
  code: string;
  codeBgInline: string;
  link: string;
  linkURL: string;
  strike: string;
  taskChecked: string;
  taskUnchecked: string;
  /** Extra spaces between letters (mirrors kern). */
  letterSpacing: number;
  /** Blank lines between wrapped lines (mirrors lineSpacing). */
  lineSpacing: number;
}

/** Returns a dark-terminal-friendly theme. */
export function defaultTheme(): Theme {
  return {
    heading: ansiBold + ansiFgBrightCyan,
    heading1: ansiBold + ansiFgBrightCyan,
    heading2: ansiBold + ansiFgBrightBlue,
    heading3: ansiBold + ansiFgBrightMagenta,
    heading4: ansiBold + ansiFgBrightGreen,
    heading5: ansiBold + ansiFgYellow,
    heading6: ansiBold + ansiFgBrightRed,
    blockQuote: ansiItalic + ansiFgBrightBlack,
    blockQuoteBar: ansiFgBrightBlack,
    codeText: ansiFgBrightWhite,
    codeBg: "",
    codeLang: ansiFgBrightBlack + ansiDim,
    tableBorder: ansiFgBrightBlack,
    tableHeader: ansiBold + ansiFgBrightWhite,
    tableHeaderText: ansiBold + ansiFgBrightWhite,
    tableCell: "",
    horizontal: ansiFgBrightBlack,
    listBullet: ansiFgBrightYellow,
    listNumber: ansiFgBrightYellow,
    bold: ansiBold,
    italic: ansiItalic,
    code: ansiFgBrightRed,
    codeBgInline: "",
    link: ansiFgBrightBlue + ansiUnderline,
    linkURL: ansiFgBrightBlack + ansiDim,
    strike: ansiStrike,
    taskChecked: ansiFgGreen,
    taskUnchecked: ansiFgBrightBlack,
    letterSpacing: 0,
    lineSpacing: 1,
  };
}

/** Returns a light-terminal-friendly theme. */
export function lightTheme(): Theme {
  return {
    heading: ansiBold + ansiFgCyan,
    heading1: ansiBold + ansiFgCyan,
    heading2: ansiBold + ansiFgBlue,
    heading3: ansiBold + ansiFgMagenta,
    heading4: ansiBold + ansiFgGreen,
    heading5: ansiBold + ansiFgYellow,
    heading6: ansiBold + ansiFgRed,
    blockQuote: ansiItalic + ansiFgBlack,
    blockQuoteBar: ansiFgBlack,
    codeText: ansiFgBlack,
    codeBg: "",
    codeLang: ansiFgBlack + ansiDim,
    tableBorder: ansiFgBlack,
    tableHeader: ansiBold + ansiFgBlack,
    tableHeaderText: ansiBold + ansiFgBlack,
    tableCell: "",
    horizontal: ansiFgBlack,
    listBullet: ansiFgYellow,
    listNumber: ansiFgYellow,
    bold: ansiBold,
    italic: ansiItalic,
    code: ansiFgRed,
    codeBgInline: "",
    link: ansiFgBlue + ansiUnderline,
    linkURL: ansiFgBlack + ansiDim,
    strike: ansiStrike,
    taskChecked: ansiFgGreen,
    taskUnchecked: ansiFgBlack,
    letterSpacing: 0,
    lineSpacing: 1,
  };
}

/** Returns the default theme (auto-detection happens in the CLI layer). */
export function autoTheme(): Theme {
  return defaultTheme();
}

// ── ANSI helpers ────────────────────────────────────────────────────────────

interface AnsiSegment {
  text: string;
  visible: boolean;
}

/** Splits a string into visible runs and ANSI escape sequences. */
export function parseANSI(s: string): AnsiSegment[] {
  const segs: AnsiSegment[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      let j = i + 1;
      if (j < s.length && s[j] === "[") {
        j++;
        while (j < s.length) {
          const c = s[j];
          j++;
          if (/[a-zA-Z]/.test(c)) break;
        }
      } else {
        j = i + 1;
      }
      segs.push({ text: s.slice(i, j), visible: false });
      i = j;
    } else {
      let j = i + 1;
      while (j < s.length && s[j] !== "\x1b") j++;
      segs.push({ text: s.slice(i, j), visible: true });
      i = j;
    }
  }
  return segs;
}

/** Returns the terminal display width of a string, ignoring ANSI escapes. */
export function visualWidth(s: string): number {
  let w = 0;
  let inEsc = false;
  for (const r of s) {
    if (r === "\x1b") {
      inEsc = true;
      continue;
    }
    if (inEsc) {
      if (/[a-zA-Z]/.test(r)) inEsc = false;
      continue;
    }
    w += runeVisualWidth(r);
  }
  return w;
}

function runeVisualWidth(ch: string): number {
  if (ch === "") return 0;
  const r = ch.codePointAt(0)!;
  if (r === 0) return 0;
  if (r < 32 || (r >= 0x7f && r < 0xa0)) return 0;
  if (isCombiningRune(r)) return 0;
  if (isWideRune(r)) return 2;
  return 1;
}

function isCombiningRune(r: number): boolean {
  return (r >= 0x0300 && r <= 0x036f) ||
    (r >= 0x1ab0 && r <= 0x1aff) ||
    (r >= 0x1dc0 && r <= 0x1dff) ||
    (r >= 0x20d0 && r <= 0x20ff) ||
    (r >= 0xfe00 && r <= 0xfe0f) ||
    (r >= 0xfe20 && r <= 0xfe2f);
}

function isWideRune(r: number): boolean {
  return (r >= 0x1100 && r <= 0x115f) ||
    (r >= 0x2329 && r <= 0x232a) ||
    (r >= 0x2e80 && r <= 0xa4cf) ||
    (r >= 0xac00 && r <= 0xd7a3) ||
    (r >= 0xf900 && r <= 0xfaff) ||
    (r >= 0xfe10 && r <= 0xfe19) ||
    (r >= 0xfe30 && r <= 0xfe6f) ||
    (r >= 0xff00 && r <= 0xff60) ||
    (r >= 0xffe0 && r <= 0xffe6) ||
    (r >= 0x1f300 && r <= 0x1f64f) ||
    (r >= 0x1f900 && r <= 0x1f9ff) ||
    (r >= 0x20000 && r <= 0x3fffd);
}

/** Removes all ANSI escape sequences from a string. */
export function stripANSI(s: string): string {
  let buf = "";
  let inEsc = false;
  for (const r of s) {
    if (r === "\x1b") {
      inEsc = true;
      continue;
    }
    if (inEsc) {
      if (/[a-zA-Z]/.test(r)) inEsc = false;
      continue;
    }
    buf += r;
  }
  return buf;
}

/**
 * Wraps ANSI-styled text at word boundaries. `lineSpacing` controls blank lines
 * between wrapped segments.
 *
 * Two invariants keep styled text aligned:
 * - A word wider than the available cells (a space-free CJK run, or one long
 *   bold/code span) is hard-split at cell boundaries. Without this the line
 *   overflows the render width and the terminal re-wraps it mid-style, which
 *   shifts every following row.
 * - A new line re-opens the style state as of the *start* of the word that was
 *   pushed onto it, not the state after the word's own escapes were consumed.
 *   Otherwise the first wrapped continuation loses the span's color/bold.
 */
export function wrapANSI(
  text: string,
  maxWidth: number,
  indent: string,
  lineSpacing: number,
): string {
  if (maxWidth <= 0) return text;
  const segs = parseANSI(text);
  if (segs.length === 0) return "";
  const indentW = visualWidth(indent);
  let availWidth = maxWidth - indentW;
  if (availWidth < 1) availWidth = 1;

  let out = "";
  let line = "";
  let col = 0;
  let activeStyles = "";
  let lineHasContent = false;

  const flushLine = (startStyles: string) => {
    out += line + "\n";
    for (let i = 0; i < lineSpacing; i++) out += "\n";
    line = "";
    col = 0;
    lineHasContent = false;
    line += indent;
    if (startStyles !== "") line += startStyles;
  };

  let word = "";
  let wordCol = 0;
  // Style state when the pending word started. Escapes already collected into
  // `word` have advanced `activeStyles`, so a break before the word must
  // restore this snapshot instead.
  let wordStartStyles = "";

  const beginWord = () => {
    if (word === "") wordStartStyles = activeStyles;
  };

  const flushWord = () => {
    if (wordCol === 0) return;
    if (wordCol > availWidth) {
      for (const chunk of splitStyledWord(word, availWidth, wordStartStyles)) {
        if (chunk.width === 0) {
          line += chunk.text;
          continue;
        }
        if (lineHasContent && col + chunk.width > availWidth) {
          flushLine(chunk.startStyles);
        }
        line += chunk.text;
        col += chunk.width;
        lineHasContent = true;
      }
    } else {
      if (lineHasContent && col + wordCol > availWidth) {
        flushLine(wordStartStyles);
      }
      line += word;
      col += wordCol;
      lineHasContent = true;
    }
    word = "";
    wordCol = 0;
  };

  for (const seg of segs) {
    if (!seg.visible) {
      beginWord();
      word += seg.text;
      if (seg.text === ansiReset) activeStyles = "";
      else activeStyles += seg.text;
      continue;
    }
    for (const ch of seg.text) {
      if (ch === " " || ch === "\t") {
        flushWord();
        const chW = runeVisualWidth(ch);
        if (col + chW > availWidth && lineHasContent) {
          flushLine(activeStyles);
        } else {
          line += ch;
          col += chW;
          lineHasContent = true;
        }
      } else {
        beginWord();
        word += ch;
        wordCol += runeVisualWidth(ch);
      }
    }
  }
  flushWord();
  out += line;
  return out;
}

interface WordChunk {
  text: string;
  width: number;
  startStyles: string;
}

/**
 * Splits one overlong word into lines of at most `availWidth` visible cells.
 * Escape sequences stay attached to the chunk that carries the text they
 * first apply to, and each chunk records the style state at its start so the
 * wrapper can re-open it after a break.
 */
function splitStyledWord(
  word: string,
  availWidth: number,
  wordStartStyles: string,
): WordChunk[] {
  const chunks: WordChunk[] = [];
  let text = "";
  let width = 0;
  let styles = wordStartStyles;
  let chunkStyles = wordStartStyles;
  const push = () => {
    if (text === "") return;
    chunks.push({ text, width, startStyles: chunkStyles });
    text = "";
    width = 0;
    chunkStyles = styles;
  };
  for (const seg of parseANSI(word)) {
    if (!seg.visible) {
      text += seg.text;
      if (seg.text === ansiReset) styles = "";
      else styles += seg.text;
      continue;
    }
    for (const ch of seg.text) {
      const chW = runeVisualWidth(ch);
      // A single wide cell can legitimately exceed availWidth (availWidth 1);
      // never split before the first cell, or the chunk loop makes no progress.
      if (width > 0 && width + chW > availWidth) push();
      text += ch;
      width += chW;
    }
  }
  push();
  return chunks;
}

function hardWrapANSI(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0 || visualWidth(text) <= maxWidth) return [text];

  const lines: string[] = [];
  let line = "";
  let col = 0;
  let activeStyles = "";

  const flushLine = () => {
    lines.push(line);
    line = "";
    col = 0;
    if (activeStyles !== "") line += activeStyles;
  };

  for (const seg of parseANSI(text)) {
    if (!seg.visible) {
      line += seg.text;
      if (seg.text === ansiReset) activeStyles = "";
      else activeStyles += seg.text;
      continue;
    }
    for (const ch of seg.text) {
      const chW = runeVisualWidth(ch);
      if (col > 0 && col + chW > maxWidth) flushLine();
      line += ch;
      col += chW;
    }
  }
  if (line.length > 0 || lines.length === 0) lines.push(line);
  return lines;
}

// ── Renderer ────────────────────────────────────────────────────────────────

/** Renders a Markdown AST to ANSI terminal output. */
export class Renderer {
  theme: Theme;
  width: number;
  #buf = "";
  #styleStack: string[] = [];

  constructor(theme: Theme | undefined, width: number) {
    this.theme = theme ?? defaultTheme();
    this.width = width <= 0 ? 80 : width;
  }

  /** Renders the entire document AST to an ANSI string. */
  render(doc: Node): string {
    this.#buf = "";
    this.#renderChildren(doc);
    return this.#buf;
  }

  #renderChildren(n: Node): void {
    for (const child of n.children) this.#renderNode(child);
  }

  #pushStyle(style: string): void {
    this.#styleStack.push(style);
    this.#buf += style;
  }

  #popStyle(): void {
    if (this.#styleStack.length > 0) this.#styleStack.pop();
    this.#buf += ansiReset;
    for (const s of this.#styleStack) this.#buf += s;
  }

  #renderNode(n: Node): void {
    switch (n.type) {
      case NodeType.Heading:
        this.#renderHeading(n);
        break;
      case NodeType.Paragraph:
        this.#renderParagraph(n);
        break;
      case NodeType.FencedCodeBlock:
        this.#renderFencedCodeBlock(n);
        break;
      case NodeType.IndentedCodeBlock:
        this.#renderCodeBox("", n.code.split("\n"));
        break;
      case NodeType.Blockquote:
        this.#renderBlockquote(n);
        break;
      case NodeType.ThematicBreak:
        this.#renderThematicBreak();
        break;
      case NodeType.UnorderedList:
        this.#renderList(n);
        break;
      case NodeType.ListItem:
        this.#renderListItem(n);
        break;
      case NodeType.Table:
        this.#renderTable(n);
        break;
      case NodeType.TableRow:
      case NodeType.TableCell:
        break;

      case NodeType.Text:
        this.#buf += n.text;
        break;
      case NodeType.Emphasis:
        this.#pushStyle(this.theme.italic);
        this.#renderInlineContent(n);
        this.#popStyle();
        break;
      case NodeType.Strong:
        this.#pushStyle(this.theme.bold);
        this.#renderInlineContent(n);
        this.#popStyle();
        break;
      case NodeType.CodeSpan:
        this.#pushStyle(this.theme.code);
        this.#buf += n.text;
        this.#popStyle();
        break;
      case NodeType.Link:
        this.#pushStyle(this.theme.link);
        this.#renderInlineContent(n);
        this.#popStyle();
        this.#buf += " ";
        this.#buf += this.theme.linkURL;
        this.#buf += "(" + n.url + ")";
        this.#buf += ansiReset;
        break;
      case NodeType.Image: {
        let alt = "";
        if (n.children.length > 0) alt = n.children[0].textContent();
        this.#buf += this.theme.code;
        this.#buf += "🖼 " + alt;
        this.#buf += ansiReset;
        if (n.url !== "") {
          this.#buf += " ";
          this.#buf += this.theme.linkURL;
          this.#buf += "(" + n.url + ")";
          this.#buf += ansiReset;
        }
        break;
      }
      case NodeType.Strikethrough:
        this.#pushStyle(this.theme.strike);
        this.#renderInlineContent(n);
        this.#popStyle();
        break;
      case NodeType.Autolink:
        this.#buf += this.theme.link;
        this.#buf += n.url;
        this.#buf += ansiReset;
        break;
      case NodeType.SoftBreak:
        this.#buf += "\n";
        break;
      case NodeType.HardBreak:
      case NodeType.LineBreak:
        this.#buf += "\n";
        break;
      default:
        this.#renderChildren(n);
    }
  }

  #getHeadingStyle(level: number): string {
    switch (level) {
      case 1:
        return this.theme.heading1;
      case 2:
        return this.theme.heading2;
      case 3:
        return this.theme.heading3;
      case 4:
        return this.theme.heading4;
      case 5:
        return this.theme.heading5;
      case 6:
        return this.theme.heading6;
      default:
        return this.theme.heading;
    }
  }

  #renderHeading(n: Node): void {
    const prefix = "#".repeat(n.level) + " ";
    const style = this.#getHeadingStyle(n.level);
    const oldBuf = this.#buf;
    this.#buf = "";
    this.#buf += style;
    this.#buf += prefix;
    this.#renderInlineContent(n);
    this.#buf += ansiReset;
    const tmp = this.#buf;
    this.#buf = oldBuf;
    const wrapped = wrapANSI(tmp, this.width, "", this.theme.lineSpacing);
    this.#buf += wrapped;
    this.#buf += "\n\n";
  }

  #renderParagraph(n: Node): void {
    const oldBuf = this.#buf;
    this.#buf = "";
    this.#renderInlineContent(n);
    const tmp = this.#buf;
    this.#buf = oldBuf;
    const wrapped = wrapANSI(tmp, this.width, "", this.theme.lineSpacing);
    this.#buf += wrapped;
    this.#buf += "\n\n";
  }

  #renderFencedCodeBlock(n: Node): void {
    this.#renderCodeBox(n.language, n.code.split("\n"));
  }

  #renderCodeBox(lang: string, lines: string[]): void {
    let boxW = this.width - 2;
    if (boxW < 20) boxW = 20;

    this.#buf += this.theme.tableBorder;
    this.#buf += "┌" + "─".repeat(boxW) + "┐";
    this.#buf += ansiReset + "\n";

    const drawCodeLine = (line: string, style: string) => {
      this.#buf += this.theme.tableBorder + "│";
      this.#buf += " " + style + line;
      const padding = boxW - 1 - visualWidth(line);
      if (padding > 0) this.#buf += " ".repeat(padding);
      this.#buf += ansiReset + this.theme.tableBorder + "│" + ansiReset + "\n";
    };

    if (lang !== "") {
      const label = lang + " ";
      for (const line of hardWrapANSI(label, boxW - 1)) {
        drawCodeLine(line, this.theme.codeLang);
      }
      this.#buf += this.theme.tableBorder;
      this.#buf += "├" + "─".repeat(boxW) + "┤";
      this.#buf += ansiReset + "\n";
    }

    for (const line of lines) {
      for (const wrapped of hardWrapANSI(line, boxW - 1)) {
        drawCodeLine(wrapped, this.theme.codeText);
      }
    }

    this.#buf += this.theme.tableBorder;
    this.#buf += "└" + "─".repeat(boxW) + "┘";
    this.#buf += ansiReset + "\n\n";
  }

  #renderBlockquote(n: Node): void {
    const depth = n.quoteLevel;
    const bar = "│ ".repeat(depth + 1);
    const barW = visualWidth(bar);

    const sub = new Renderer(this.theme, this.width - barW);
    sub.#renderChildren(n);
    const content = trimRight(sub.#buf, "\n");

    for (const line of content.split("\n")) {
      this.#buf += this.theme.blockQuoteBar + bar;
      this.#buf += this.theme.blockQuote + line + ansiReset + "\n";
    }
    this.#buf += "\n";
  }

  #renderThematicBreak(): void {
    let w = this.width - 2;
    if (w < 1) w = 1;
    this.#buf += this.theme.horizontal + "─".repeat(w) + ansiReset + "\n\n";
  }

  #renderList(n: Node): void {
    for (const child of n.children) this.#renderListItem(child);
    this.#buf += "\n";
  }

  #renderListItem(n: Node): void {
    let depth = 0;
    let p = n.parent;
    while (p) {
      if (
        p.type === NodeType.UnorderedList || p.type === NodeType.OrderedList
      ) {
        depth++;
      }
      p = p.parent;
    }
    const indent = "  ".repeat(Math.max(0, depth - 1));

    const isOrdered = n.parent !== undefined &&
      n.parent.type === NodeType.OrderedList;
    let marker = "";
    if (isOrdered) {
      const startNum = n.parent ? n.parent.startNum : 1;
      let idx = n.indexInParent();
      if (idx < 0) idx = 0;
      marker = `${startNum + idx}. `;
    } else {
      marker = "• ";
    }

    if (n.isTaskItem) {
      if (n.checked) {
        this.#buf += indent + this.theme.taskChecked + "☑ " + ansiReset;
      } else {
        this.#buf += indent + this.theme.taskUnchecked + "☐ " + ansiReset;
      }
    } else if (isOrdered) {
      this.#buf += indent + this.theme.listNumber + marker + ansiReset;
    } else {
      this.#buf += indent + this.theme.listBullet + marker + ansiReset;
    }

    const markerW = visualWidth(indent) + visualWidth(marker);
    const contIndent = indent + " ".repeat(visualWidth(marker));

    for (const child of n.children) {
      if (child.type === NodeType.Paragraph) {
        const oldBuf = this.#buf;
        this.#buf = "";
        this.#renderInlineContent(child);
        const tmp = this.#buf;
        this.#buf = oldBuf;

        const wrapped = wrapANSI(
          tmp,
          this.width - markerW,
          "",
          this.theme.lineSpacing,
        );
        const lines = wrapped.split("\n");
        lines.forEach((line, i) => {
          if (i === 0) this.#buf += line;
          else this.#buf += "\n" + (line === "" ? "" : contIndent + line);
        });
      } else {
        this.#renderNode(child);
      }
    }
    this.#buf += "\n";
  }

  #renderTable(n: Node): void {
    if (n.children.length === 0) return;

    interface Row {
      cells: string[];
      isHeader: boolean;
    }
    const rows: Row[] = [];
    for (const child of n.children) {
      if (child.type === NodeType.TableRow) {
        const cells: string[] = [];
        for (const cell of child.children) {
          if (cell.type === NodeType.TableCell) {
            const sub = new Renderer(this.theme, this.width);
            sub.#renderInlineContent(cell);
            cells.push(trimRight(sub.#buf, "\n").trim());
          }
        }
        rows.push({ cells, isHeader: child.isTableHeader });
      }
    }

    if (rows.length === 0) return;

    let colCount = 0;
    for (const rw of rows) {
      if (rw.cells.length > colCount) colCount = rw.cells.length;
    }
    let colWidths = new Array<number>(colCount).fill(0);
    for (const rw of rows) {
      rw.cells.forEach((cell, i) => {
        if (i < colCount) {
          const w = visualWidth(cell);
          if (w > colWidths[i]) colWidths[i] = w;
        }
      });
    }
    for (let i = 0; i < colWidths.length; i++) {
      if (colWidths[i] < 3) colWidths[i] = 3;
    }
    colWidths = fitTableColumnWidths(colWidths, this.width);

    const drawSep = (
      left: string,
      mid: string,
      right: string,
      fill: string,
    ) => {
      this.#buf += this.theme.tableBorder + left;
      colWidths.forEach((w, i) => {
        this.#buf += fill.repeat(w + 2);
        if (i < colCount - 1) this.#buf += mid;
      });
      this.#buf += right + ansiReset + "\n";
    };

    const drawRow = (cells: string[], isHeader: boolean) => {
      const wrappedCells: string[][] = [];
      let rowHeight = 1;
      for (let i = 0; i < colCount; i++) {
        const text = i < cells.length ? cells[i] : "";
        const wrapped = wrapTableCell(text, colWidths[i]);
        wrappedCells.push(wrapped);
        if (wrapped.length > rowHeight) rowHeight = wrapped.length;
      }

      for (let lineIdx = 0; lineIdx < rowHeight; lineIdx++) {
        this.#buf += this.theme.tableBorder + "│";
        for (let i = 0; i < colCount; i++) {
          const text = lineIdx < wrappedCells[i].length
            ? wrappedCells[i][lineIdx]
            : "";
          let pad = colWidths[i] - visualWidth(text);
          if (pad < 0) pad = 0;
          if (isHeader) {
            this.#buf += this.theme.tableHeaderText + " " + text +
              " ".repeat(pad + 1) + ansiReset;
          } else {
            this.#buf += " " + text + " ".repeat(pad + 1) + ansiReset;
          }
          this.#buf += this.theme.tableBorder + "│";
        }
        this.#buf += ansiReset + "\n";
      }
    };

    drawSep("┌", "┬", "┐", "─");
    let firstRow = true;
    for (const rw of rows) {
      drawRow(rw.cells, rw.isHeader);
      if (firstRow && rw.isHeader) {
        drawSep("├", "┼", "┤", "─");
        firstRow = false;
      }
    }
    drawSep("└", "┴", "┘", "─");
    this.#buf += "\n";
  }

  #renderInlineContent(n: Node): void {
    for (const child of n.children) this.#renderNode(child);
  }
}

/** Creates a Renderer with the given theme and terminal width. */
export function createRenderer(
  theme: Theme | undefined,
  width: number,
): Renderer {
  return new Renderer(theme, width);
}

function trimRight(s: string, cutset: string): string {
  let i = s.length;
  while (i > 0 && cutset.includes(s[i - 1])) i--;
  return s.slice(0, i);
}

function fitTableColumnWidths(
  desired: number[],
  maxTableWidth: number,
): number[] {
  const widths = [...desired];
  if (widths.length === 0 || maxTableWidth <= 0) return widths;

  const colCount = widths.length;
  const available = maxTableWidth - (3 * colCount + 1);
  let minWidth = 3;
  if (available < colCount * minWidth) minWidth = 1;
  if (available < colCount * minWidth) {
    return widths.map(() => 1);
  }

  let total = 0;
  for (let i = 0; i < widths.length; i++) {
    if (widths[i] < minWidth) widths[i] = minWidth;
    total += widths[i];
  }
  if (total <= available) return widths;

  for (let i = 0; i < widths.length; i++) widths[i] = minWidth;

  let remaining = available - colCount * minWidth;
  while (remaining > 0) {
    let progressed = false;
    for (let i = 0; i < widths.length; i++) {
      if (widths[i] >= desired[i]) continue;
      widths[i]++;
      remaining--;
      progressed = true;
      if (remaining === 0) break;
    }
    if (!progressed) break;
  }
  return widths;
}

function wrapTableCell(text: string, maxWidth: number): string[] {
  if (text === "") return [""];
  if (maxWidth <= 0) return [text];

  const wrapped = wrapANSI(text, maxWidth, "", 0);
  const lines: string[] = [];
  for (const line of wrapped.split("\n")) {
    if (visualWidth(line) <= maxWidth) {
      lines.push(line);
      continue;
    }
    lines.push(...hardWrapANSI(line, maxWidth));
  }
  if (lines.length === 0) return [""];
  return lines;
}

/** Parses and renders Markdown in one call. */
export function render(
  src: string,
  width: number,
  theme: Theme | undefined,
): string {
  const doc = parseDoc(src, defaultOption());
  const r = new Renderer(theme, width);
  return r.render(doc);
}
