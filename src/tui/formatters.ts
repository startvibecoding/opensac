// Ported from internal/tui/formatters.go (pure helpers) — display-width
// truncation, bash-output compaction, and duration formatting. The
// i18n-coupled formatters (formatToolArgsWithTranslator etc.) migrate with
// the Ink tool-result components.

/** ANSI escape sequence (CSI and simple two-byte forms) for width 0. */
const ansiRe = new RegExp(
  "\u001B(?:\\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])",
  "g",
);

/**
 * Returns the terminal display width of `s` in cells: CJK and other
 * wide runes count as 2, ANSI escape sequences as 0, combining marks as 0
 * (lipgloss.Width semantics for the ranges the TUI actually renders).
 */
export function displayWidth(s: string): number {
  const stripped = s.replace(ansiRe, "");
  let width = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0) ?? 0;
    // Zero-width: combining marks and common format characters
    if (
      (cp >= 0x0300 && cp <= 0x036f) || // combining diacritical marks
      cp === 0x200b || cp === 0xfeff // zero-width space / BOM
    ) {
      continue;
    }
    // Wide: CJK Unified, extensions, fullwidth forms, Hangul, kana
    if (
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK Radicals..Yi
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
      (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
      (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd) // CJK Extension B+
    ) {
      width += 2;
      continue;
    }
    width += 1;
  }
  return width;
}

/**
 * Truncates `s` so its display width does not exceed maxWidth, appending
 * "..." when truncation occurs (Go tui.truncate). Width is measured in
 * display cells; ANSI escape sequences pass through with zero width and are
 * never split mid-sequence.
 */
export function truncateDisplay(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (displayWidth(s) <= maxWidth) return s;
  const suffix = "...";
  const target = maxWidth - displayWidth(suffix);
  if (target <= 0) return suffix;
  let w = 0;
  let out = "";
  let i = 0;
  const chars = Array.from(s);
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === "\u001B") {
      // Consume the whole escape sequence without counting width.
      let seq = ch;
      i++;
      // CSI: parameter bytes then final byte
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
        // Two-byte escape (e.g. ESC ] … for OSC is rare in TUI text)
        seq += chars[i];
        i++;
      }
      out += seq;
      continue;
    }
    const rw = displayWidth(ch);
    if (w + rw > target) break;
    out += ch;
    w += rw;
    i++;
  }
  return out + suffix;
}

/** Collapses runs of blank lines and trims each line (Go compactBashOutput). */
export function compactBashOutput(s: string): string {
  let out = "";
  let prevBlank = false;
  for (const line of s.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      if (!prevBlank) out += "\n";
      prevBlank = true;
      continue;
    }
    prevBlank = false;
    out += trimmed + "\n";
  }
  return out.trim();
}

/** Formats a duration the way the Go status line does. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}
