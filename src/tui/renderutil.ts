// ANSI-aware text wrapping.
// WrapPlainText hard-wraps model text to display-cell widths; WrapANSI wraps
// styled text preserving escape sequences. Tabs normalize to three spaces.
//
// These helpers sit on the hottest path of the TUI (every transcript row and
// every framed-panel block is wrapped), so each pass keeps an allocation-free
// fast path for plain text and measures with an early exit instead of
// stripping and re-measuring the whole line.

import {
  ansiSequenceEnd,
  displayWidth,
  displayWidthExceeds,
  runeWidth,
} from "./formatters.ts";

const ESC = 0x1b;

/** Terminal cell width of s after tab normalization (ANSI zero-width). */
export function visibleWidth(s: string): number {
  if (s === "") return 0;
  return displayWidth(normalizeTabs(s));
}

/**
 * Hard-wraps raw text to width cells (Go xansi.Hardwrap): breaks at cell
 * boundaries without word awareness, preserves ANSI styling.
 */
export function wrapPlainText(text: string, width: number): string {
  return wrapWith(text, width, (line) => hardwrap(line, width));
}

/**
 * Word-aware wrap for styled text (Go xansi.Wrap with "/" breakpoints).
 * Breaks preferentially after "/" path separators.
 */
export function wrapANSI(text: string, width: number): string {
  return wrapWith(text, width, (line) => wordWrap(line, width));
}

function wrapWith(
  text: string,
  width: number,
  wrapLine: (line: string) => string,
): string {
  if (width <= 0 || text === "") return text;
  const inputLines = normalizeTabs(text).split("\n");
  const wrapped: string[] = [];
  for (const line of inputLines) {
    const trimmedLine = trimRightVisibleASCIIWhitespace(line);
    if (isANSIBlankLine(trimmedLine)) {
      wrapped.push("");
      continue;
    }
    // A line that already fits never reaches the wrapper.
    if (!displayWidthExceeds(trimmedLine, width)) {
      wrapped.push(trimmedLine);
      continue;
    }
    for (const out of wrapLine(trimmedLine).split("\n")) {
      const trimmed = trimRightVisibleASCIIWhitespace(out);
      if (!isANSIBlankLine(trimmed)) {
        wrapped.push(trimmed);
      }
    }
  }
  return wrapped.join("\n");
}

function normalizeTabs(s: string): string {
  return s.includes("\t") ? s.replaceAll("\t", "   ") : s;
}

function trimRightVisibleASCIIWhitespace(s: string): string {
  if (s.indexOf("\u001B") === -1) return s.replace(/[ \t]+$/, "");
  const plain = stripANSI(s);
  const trimmed = plain.replace(/[ \t]+$/, "");
  if (trimmed.length === plain.length) return s;
  return truncateANSI(s, displayWidth(trimmed));
}

function isANSIBlankLine(s: string): boolean {
  if (s.indexOf("\u001B") === -1) return s.trim() === "";
  return stripANSI(s).trim() === "";
}

/** Strips ANSI escape sequences. */
export function stripANSI(s: string): string {
  // Plain text is the common case: skip the regex copy entirely.
  if (s.indexOf("\u001B") === -1) return s;
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-Z\-_])/g, "");
}

/** ANSI-aware truncation to width cells; trailing SGR sequences are kept
 * so styles terminate correctly (Go xansi.Truncate). */
export function truncateANSI(s: string, width: number): string {
  if (width <= 0) return "";
  if (!displayWidthExceeds(s, width)) return s;
  let w = 0;
  let out = "";
  let i = 0;
  while (i < s.length) {
    const code = s.charCodeAt(i);
    if (code === ESC) {
      const next = ansiSequenceEnd(s, i);
      out += s.slice(i, next);
      i = next;
      continue;
    }
    let cp = code;
    let size = 1;
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const low = s.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = ((cp - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
        size = 2;
      }
    }
    const rw = runeWidth(cp);
    if (w + rw > width) break;
    out += s.slice(i, i + size);
    w += rw;
    i += size;
  }
  // Preserve trailing SGR sequences from the unprinted remainder so color
  // state does not leak past the truncation point.
  while (i < s.length) {
    if (s.charCodeAt(i) !== ESC) {
      i++;
      continue;
    }
    const next = ansiSequenceEnd(s, i);
    const seq = s.slice(i, next);
    if (seq.endsWith("m")) out += seq;
    i = next;
  }
  return out;
}

/** Hard-wraps one line at exact cell boundaries, preserving ANSI. */
function hardwrap(line: string, width: number): string {
  const out: string[] = [];
  let current = "";
  let w = 0;
  let i = 0;
  while (i < line.length) {
    const code = line.charCodeAt(i);
    if (code === ESC) {
      const next = ansiSequenceEnd(line, i);
      current += line.slice(i, next);
      i = next;
      continue;
    }
    let cp = code;
    let size = 1;
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < line.length) {
      const low = line.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = ((cp - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
        size = 2;
      }
    }
    const rw = runeWidth(cp);
    if (w + rw > width) {
      out.push(current);
      current = "";
      w = 0;
    }
    current += line.slice(i, i + size);
    w += rw;
    i += size;
  }
  out.push(current);
  return out.join("\n");
}

/** Word-aware wrap breaking after spaces and "/" (Go xansi.Wrap). */
function wordWrap(line: string, width: number): string {
  const out: string[] = [];
  let current = "";
  let currentW = 0;
  for (const word of splitKeepANSI(line)) {
    const wordW = displayWidth(word.text);
    const sepW = displayWidth(word.separator);
    if (currentW > 0 && currentW + sepW + wordW > width) {
      out.push(current);
      current = word.text;
      currentW = wordW;
    } else {
      current += word.separator + word.text;
      currentW += sepW + wordW;
    }
  }
  out.push(current);
  return out.join("\n");
}

interface Word {
  text: string;
  separator: string;
}

/** Splits a line into words at spaces and "/" breakpoints, keeping ANSI. */
function splitKeepANSI(line: string): Word[] {
  // Escape-free text (the bulk of tool output) splits with slices only.
  if (line.indexOf("\u001B") === -1) return splitPlainWords(line);
  const words: Word[] = [];
  let text = "";
  let pendingSep = "";
  let i = 0;
  while (i < line.length) {
    const code = line.charCodeAt(i);
    if (code === ESC) {
      const next = ansiSequenceEnd(line, i);
      text += line.slice(i, next);
      i = next;
      continue;
    }
    if (code === 0x20 || code === 0x2f) {
      if (text !== "") {
        words.push({ text, separator: pendingSep });
        text = "";
        pendingSep = line[i];
      } else {
        pendingSep += line[i];
      }
      i++;
      continue;
    }
    let size = 1;
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < line.length) {
      const low = line.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) size = 2;
    }
    text += line.slice(i, i + size);
    i += size;
  }
  if (text !== "") words.push({ text, separator: pendingSep });
  return words;
}

/** Word split for a line that contains no escape sequence. */
function splitPlainWords(line: string): Word[] {
  const words: Word[] = [];
  let pendingSep = "";
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (code !== 0x20 && code !== 0x2f) continue;
    if (i > start) {
      words.push({ text: line.slice(start, i), separator: pendingSep });
      pendingSep = line[i];
    } else {
      pendingSep += line[i];
    }
    start = i + 1;
  }
  if (start < line.length) {
    words.push({ text: line.slice(start), separator: pendingSep });
  }
  return words;
}
