// (pure helpers) — display-width
// truncation, bash-output compaction, and duration formatting. The
// i18n-coupled formatters (formatToolArgsWithTranslator etc.) migrate with
// the Ink tool-result components.

/** ANSI escape sequence (CSI and simple two-byte forms) for width 0. */
const ansiRe = new RegExp("\u001B(?:\\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])", "g");

/**
 * Returns the terminal display width of `s` in cells: CJK and other
 * wide runes count as 2, ANSI escape sequences as 0, combining marks as 0
 * (lipgloss.Width semantics for the ranges the TUI actually renders).
 *
 * Text without an escape byte skips the strip pass entirely — plain tool
 * output is the common case and the strip copy was measured as a large part
 * of the TUI's rendering cost.
 */
export function displayWidth(s: string): number {
  return s.indexOf("\u001B") === -1
    ? widthOfPlain(s, Number.POSITIVE_INFINITY)
    : widthOfPlain(s.replace(ansiRe, ""), Number.POSITIVE_INFINITY);
}

/** Terminal cells occupied by one code point (0 for combining marks). */
export function runeWidth(cp: number): number {
  // Zero-width: combining marks and common format characters
  if (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritical marks
    cp === 0x200b ||
    cp === 0xfeff // zero-width space / BOM
  ) {
    return 0;
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
    return 2;
  }
  return 1;
}

/**
 * True once `s` is wider than `limit` cells. Wrapping and truncation only need
 * the comparison, so this stops counting at the boundary instead of measuring
 * the whole line.
 */
export function displayWidthExceeds(s: string, limit: number): boolean {
  if (limit <= 0) return s !== "";
  // Plain text stops counting at the boundary; styled text keeps the exact
  // escape-sequence strip semantics of displayWidth (and its width is the
  // visible width, not the raw length).
  if (s.indexOf("\u001B") === -1) return widthOfPlain(s, limit) > limit;
  return displayWidth(s) > limit;
}

/** Cell width of ANSI-free text, early-exiting once `stopAfter` is exceeded. */
function widthOfPlain(s: string, stopAfter: number): number {
  let width = 0;
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      const low = s.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = ((cp - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
        i++;
      }
    }
    width += runeWidth(cp);
    if (width > stopAfter) return width;
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
  if (!displayWidthExceeds(s, maxWidth)) return s;
  const suffix = "...";
  const target = maxWidth - displayWidth(suffix);
  if (target <= 0) return suffix;
  let w = 0;
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch === 0x1b) {
      // Consume the whole escape sequence without counting width.
      const next = ansiSequenceEnd(s, i);
      out += s.slice(i, next);
      i = next;
      continue;
    }
    let cp = ch;
    let size = 1;
    if (ch >= 0xd800 && ch <= 0xdbff && i + 1 < s.length) {
      const low = s.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = ((cp - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
        size = 2;
      }
    }
    const rw = runeWidth(cp);
    if (w + rw > target) break;
    out += s.slice(i, i + size);
    w += rw;
    i += size;
  }
  return out + suffix;
}

/**
 * Index just past the ANSI escape sequence starting at `start` (an ESC byte).
 * Byte-level scanning keeps the styled truncation paths allocation-free.
 */
export function ansiSequenceEnd(s: string, start: number): number {
  let i = start + 1;
  if (i < s.length && s.charCodeAt(i) === 0x5b) {
    // CSI: parameter/intermediate bytes then the final byte (@..~).
    i++;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c >= 0x40 && c <= 0x7e) return i + 1;
      i++;
    }
    return i;
  }
  return i < s.length ? i + 1 : i;
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

/** Compact token count: 999 / 1.2k / 12k / 1.2M (Go formatTokens). */
export function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.floor(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.floor(count / 1_000_000)}M`;
}

export interface CacheUsageInput {
  totalInputTokens: number;
  totalCacheRead: number;
  totalCacheWrite: number;
}

/**
 * Cache hit ratio against the full input footprint, or -1 when no usage has
 * been recorded (Go cacheHitPercent).
 */
export function cacheHitPercent(u: CacheUsageInput): number {
  if (u.totalInputTokens <= 0) return -1;
  const pct = (u.totalCacheRead / u.totalInputTokens) * 100;
  return Math.min(pct, 100);
}

/**
 * Cache display line: "Cache: N%", a raw token count, or "" when nothing has
 * been recorded (Go formatCachePercent).
 */
export function formatCachePercent(u: CacheUsageInput): string {
  const pct = cacheHitPercent(u);
  if (pct >= 0) return `Cache: ${Math.round(pct)}%`;
  if (u.totalCacheRead > 0) return `CacheRead: ${u.totalCacheRead}`;
  if (u.totalCacheWrite > 0) return `CacheWrite: ${u.totalCacheWrite}`;
  return "";
}
