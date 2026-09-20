// Ported from internal/tui/renderutil/ansi_wrap.go: ANSI-aware text wrapping.
// WrapPlainText hard-wraps model text to display-cell widths; WrapANSI wraps
// styled text preserving escape sequences. Tabs normalize to three spaces.

import { displayWidth } from "./formatters.ts";

const PATH_BREAKPOINTS = "/";

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
  return s.replaceAll("\t", "   ");
}

function trimRightVisibleASCIIWhitespace(s: string): string {
  const plain = stripANSI(s);
  const trimmed = plain.replace(/[ \t]+$/, "");
  if (trimmed.length === plain.length) return s;
  return truncateANSI(s, displayWidth(trimmed));
}

function isANSIBlankLine(s: string): boolean {
  return stripANSI(s).trim() === "";
}

/** Strips ANSI escape sequences. */
export function stripANSI(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-Z\-_])/g, "");
}

/** ANSI-aware truncation to width cells; trailing SGR sequences are kept
 * so styles terminate correctly (Go xansi.Truncate). */
export function truncateANSI(s: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(s) <= width) return s;
  let w = 0;
  let out = "";
  let i = 0;
  const chars = Array.from(s);
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === "\u001B") {
      const [seq, next] = consumeANSISeq(chars, i);
      out += seq;
      i = next;
      continue;
    }
    const rw = displayWidth(ch);
    if (w + rw > width) break;
    out += ch;
    w += rw;
    i++;
  }
  // Preserve trailing SGR sequences from the unprinted remainder so color
  // state does not leak past the truncation point.
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === "\u001B") {
      const [seq, next] = consumeANSISeq(chars, i);
      if (seq.endsWith("m")) out += seq;
      i = next;
      continue;
    }
    i++;
  }
  return out;
}

/** Hard-wraps one line at exact cell boundaries, preserving ANSI. */
function hardwrap(line: string, width: number): string {
  if (displayWidth(line) <= width) return line;
  const out: string[] = [];
  let current = "";
  let w = 0;
  let i = 0;
  const chars = Array.from(line);
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === "\u001B") {
      const [seq, next] = consumeANSISeq(chars, i);
      current += seq;
      i = next;
      continue;
    }
    const rw = displayWidth(ch);
    if (w + rw > width) {
      out.push(current);
      current = "";
      w = 0;
    }
    current += ch;
    w += rw;
    i++;
  }
  out.push(current);
  return out.join("\n");
}

/** Word-aware wrap breaking after spaces and "/" (Go xansi.Wrap). */
function wordWrap(line: string, width: number): string {
  if (displayWidth(line) <= width) return line;
  const out: string[] = [];
  let current = "";
  let currentW = 0;
  const words = splitKeepANSI(line);
  for (const word of words) {
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
  const words: Word[] = [];
  let text = "";
  let pendingSep = "";
  let i = 0;
  const chars = Array.from(line);
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === "\u001B") {
      const [seq, next] = consumeANSISeq(chars, i);
      text += seq;
      i = next;
      continue;
    }
    if (ch === " " || ch === PATH_BREAKPOINTS) {
      if (text !== "") {
        words.push({ text, separator: pendingSep });
        text = "";
        pendingSep = ch;
      } else {
        pendingSep += ch;
      }
      i++;
      continue;
    }
    text += ch;
    i++;
  }
  if (text !== "") words.push({ text, separator: pendingSep });
  return words;
}

function consumeANSISeq(chars: string[], start: number): [string, number] {
  let seq = chars[start];
  let i = start + 1;
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
  return [seq, i];
}
