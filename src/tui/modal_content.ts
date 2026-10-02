// Incremental content assembly for the framed panels (Ctrl+O tool modal,
// Ctrl+T plan modal, Ctrl+E ESM panel).
//
// A panel is a scrollable window over a large, mostly immutable body: the
// expanded transcript, one agent snapshot, or a plan. Rebuilding and
// ANSI-wrapping the whole body for every keystroke and every spinner tick made
// a frame cost O(conversation) — the dominant TUI hot spot.
//
// The cache splits the body into blocks keyed by a cheap change signature and
// separates the two things a frame actually needs:
//
//   * layout — the wrapped line *count* of every block (needed to clamp and
//     pin the scroll), and
//   * text — the wrapped lines of the *visible window* only.
//
// So a frame costs O(rebuilt blocks + page size), and the retained memory is
// bounded by `maxCachedChars` rather than by the size of the session: evicted
// blocks keep their signature and line count and re-wrap on demand.

import { wrapANSI } from "./renderutil.ts";

/**
 * One lazily built panel block. `key` identifies the block across frames
 * (transcript row index, agent id, …); `sig` is a cheap change signature that
 * must stay equal while the built text is unchanged; `build` produces the raw,
 * unwrapped multi-line text and runs only when `sig` changed or when an
 * evicted block scrolls back into view.
 */
export interface ModalBlock {
  key: string;
  sig: string;
  build: () => string;
}

/** Windowed view over a panel body, as consumed by the frame renderers. */
export interface ModalContentView {
  /** Total wrapped line count, including the blank separators between blocks. */
  readonly lineCount: number;
  /** `count` lines starting at `offset`; short at the end of the body. */
  slice(offset: number, count: number): string[];
}

interface CacheEntry {
  sig: string;
  /** Wrapped lines, or null once evicted (the layout keeps `count`). */
  lines: string[] | null;
  count: number;
  /** Characters held in `lines` (0 once evicted). */
  chars: number;
  /** Refresh token that last touched this entry, for stale pruning. */
  seen: number;
}

/**
 * One resolved block of the current frame: its layout span in the body.
 *
 * `count`, `start`, and `separator` survive text eviction, which is what keeps
 * the scroll clamp and bottom pin exact while the cache holds bounded text.
 */
interface Span {
  key: string;
  block: ModalBlock;
  /** Absolute index of the block's first line. */
  start: number;
  count: number;
  /** Whether a blank separator line follows this block. */
  separator: boolean;
}

/** Wrapped text the cache keeps hot before evicting the coldest blocks. */
export const DEFAULT_MAX_CACHED_CHARS = 1 << 20;

/**
 * Per-panel cache of block layouts plus the bounded set of wrapped lines.
 * The entries map doubles as an LRU list: resolution re-inserts touched
 * entries, so the map front is always the least recently used body text.
 */
export class ModalContentCache implements ModalContentView {
  #width = 0;
  #generation = 0;
  #maxChars: number;
  #entries = new Map<string, CacheEntry>();
  #spans: Span[] = [];
  #total = 0;
  #chars = 0;
  #pass = 0;
  #lastRebuilt = 0;
  #lastEvicted = 0;
  #lastMaterialized = 0;

  constructor(maxCachedChars = DEFAULT_MAX_CACHED_CHARS) {
    this.#maxChars = Math.max(maxCachedChars, 4096);
  }

  /**
   * Resolves the frame's block list. A block whose signature is unchanged keeps
   * its wrapped line count with no re-formatting; a width change invalidates
   * every entry (all lines were wrapped to the old width), and a `generation`
   * change (a cleared transcript reuses row indices) drops entries the new body
   * does not name.
   */
  refresh(blocks: ModalBlock[], width: number, generation = 0): this {
    if (width !== this.#width || generation !== this.#generation) {
      this.#entries.clear();
      this.#chars = 0;
      this.#width = width;
      this.#generation = generation;
    }
    const spans = this.#spans;
    const pass = ++this.#pass;
    let rebuilt = 0;
    let start = 0;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      let entry = this.#entries.get(block.key);
      if (entry === undefined || entry.sig !== block.sig) {
        if (entry !== undefined) this.#chars -= entry.chars;
        else this.#entries.set(block.key, entry = {} as CacheEntry);
        const lines = wrapBlockLines(block.build(), width);
        entry.sig = block.sig;
        entry.lines = lines;
        entry.count = lines.length;
        entry.chars = charTotal(lines);
        this.#chars += entry.chars;
        rebuilt++;
      }
      entry.seen = pass;
      const separator = i < blocks.length - 1;
      let span = spans[i];
      if (span === undefined) {
        span = { key: block.key, block, start, count: entry.count, separator };
        spans.push(span);
      } else {
        span.key = block.key;
        span.block = block;
        span.start = start;
        span.count = entry.count;
        span.separator = separator;
      }
      start += entry.count + (separator ? 1 : 0);
    }
    spans.length = blocks.length;
    if (this.#entries.size > blocks.length) this.#pruneStale(pass);
    this.#total = start;
    this.#lastRebuilt = rebuilt;
    this.#lastMaterialized = 0;
    this.#lastEvicted = 0;
    this.#evict();
    return this;
  }

  get lineCount(): number {
    return this.#total;
  }

  /** Blocks resolved in the current frame. */
  get blockCount(): number {
    return this.#spans.length;
  }

  /**
   * Blocks re-formatted and re-wrapped by the most recent `refresh`. A scroll or
   * a spinner tick on an unchanged body must report 0 (or the live rows only);
   * this is the performance contract the panel tests assert on.
   */
  get lastRebuiltBlocks(): number {
    return this.#lastRebuilt;
  }

  /** Blocks whose text was re-wrapped to fill the visible window. */
  get lastMaterializedBlocks(): number {
    return this.#lastMaterialized;
  }

  /** Blocks whose text was dropped by the memory bound last frame. */
  get lastEvictedBlocks(): number {
    return this.#lastEvicted;
  }

  /** Wrapped characters currently held by the cache. */
  get cachedChars(): number {
    return this.#chars;
  }

  /**
   * Drops the cached wrapped text but keeps the layout (each block's signature
   * and line count). A panel that is closed or idle keeps no megabytes of
   * strings, yet reopening it still costs O(visible window) instead of a full
   * re-wrap, because only the blocks the window actually reads re-materialize.
   */
  dropText(): void {
    for (const entry of this.#entries.values()) {
      if (entry.lines === null) continue;
      this.#chars -= entry.chars;
      entry.lines = null;
      entry.chars = 0;
    }
  }

  /** Drops every cached block (panel closed, or the body was replaced). */
  clear(): void {
    this.#entries.clear();
    this.#spans = [];
    this.#total = 0;
    this.#chars = 0;
    this.#lastRebuilt = 0;
    this.#lastEvicted = 0;
    this.#lastMaterialized = 0;
  }

  slice(offset: number, count: number): string[] {
    const out: string[] = [];
    if (count <= 0 || this.#spans.length === 0) return out;
    let pos = Math.max(offset, 0);
    if (pos >= this.#total) return out;
    let i = this.#blockAt(pos);
    // Every branch either appends a line (advancing `pos`) or advances `i`,
    // so the walk terminates without an iteration cap.
    while (out.length < count && i < this.#spans.length) {
      const span = this.#spans[i];
      const end = span.start + span.count;
      if (pos < end) {
        const lines = this.#linesOf(span);
        const local = pos - span.start;
        const take = Math.min(end - pos, count - out.length);
        for (let k = 0; k < take; k++) out.push(lines[local + k]);
        pos += take;
        continue;
      }
      if (pos === end && span.separator) {
        out.push("");
        pos++;
        i++;
        continue;
      }
      // Empty block, or a scroll offset that landed past the block end.
      i++;
      if (i < this.#spans.length) pos = Math.max(pos, this.#spans[i].start);
    }
    return out;
  }

  /**
   * The wrapped lines of one span, re-wrapping a block whose text was evicted.
   * Only the visible window reaches this, so at most a few blocks re-wrap.
   */
  #linesOf(span: Span): string[] {
    const entry = this.#entries.get(span.key);
    if (entry === undefined) {
      // refresh() just resolved this frame's spans, so this is defensive.
      const lines = wrapBlockLines(span.block.build(), this.#width);
      return lines;
    }
    if (entry.lines === null) {
      const lines = wrapBlockLines(span.block.build(), this.#width);
      entry.lines = lines;
      entry.chars = charTotal(lines);
      this.#chars += entry.chars;
      this.#lastMaterialized++;
      // Touch the LRU: re-insert so the memory bound evicts the coldest body
      // text, never the window that was just read.
      this.#entries.delete(span.key);
      this.#entries.set(span.key, entry);
    }
    return entry.lines;
  }

  /** Drops the coldest wrapped text until the cache fits its budget. */
  #evict(): void {
    if (this.#chars <= this.#maxChars) return;
    // Keep at least one page worth of text so a frame never evicts what it is
    // about to render; the visible window re-wraps only its own blocks.
    for (const entry of this.#entries.values()) {
      if (this.#chars <= this.#maxChars) break;
      if (entry.lines === null) continue;
      this.#chars -= entry.chars;
      entry.lines = null;
      entry.chars = 0;
      this.#lastEvicted++;
    }
  }

  #pruneStale(pass: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.seen === pass) continue;
      this.#chars -= entry.chars;
      this.#entries.delete(key);
    }
  }

  /** Index of the block owning absolute line `pos`. */
  #blockAt(pos: number): number {
    let lo = 0;
    let hi = this.#spans.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.#spans[mid].start <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

/**
 * Wraps a multi-line block to the panel content width, one input line at a
 * time (the panels' Go original wraps per line, never across lines).
 */
export function wrapBlockLines(text: string, width: number): string[] {
  if (text === "") return [""];
  if (!text.includes("\n")) return splitWrapped(wrapANSI(text, width));
  const out: string[] = [];
  for (const line of text.split("\n")) {
    out.push(...splitWrapped(wrapANSI(line, width)));
  }
  return out.length > 0 ? out : [""];
}

function splitWrapped(wrapped: string): string[] {
  return wrapped.includes("\n") ? wrapped.split("\n") : [wrapped];
}

function charTotal(lines: string[]): number {
  let chars = 0;
  for (const line of lines) chars += line.length;
  return chars;
}
