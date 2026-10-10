// Raw terminal input parsing for the Ink shell.
//
// Ink's `useInput` normalizes the DEL byte (0x7f, what xterm-class terminals
// send for the Backspace key) to `key.delete`, so backspace and the forward
// Delete key become indistinguishable and backspace stops removing text. The
// shell therefore parses the raw chunks Ink exposes through its stdin context
// itself, exactly like Bubble Tea's key decoder does for the Go TUI.
//
// A chunk may contain one key, several keys (fast typing), or a whole paste
// (bracketed `ESC[200~ … ESC[201~` or a newline-bearing run). `splitInputChunk`
// returns one event per key while preserving literal text runs so the shell can
// fold large pastes into markers.

/** One parsed input event. */
export type KeyEvent =
  | { type: "text"; text: string; paste: boolean }
  | { type: "key"; name: KeyName; alt: boolean };

/**
 * Named keys emitted by the parser. Editor keys use the same spelling as
 * {@link Editor.handleKey} ("backspace", "ctrl+a", "alt+left", …).
 */
export type KeyName =
  | "enter"
  | "newline"
  | "backspace"
  | "delete"
  | "left"
  | "right"
  | "up"
  | "down"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "tab"
  | "shift+tab"
  | "escape"
  | "space"
  | `ctrl+${string}`
  | `alt+${string}`;

/** Text runs longer than this are treated as pastes without bracketed markers. */
export const PASTE_TEXT_THRESHOLD = 500;

/** CSI sequences that start a bracketed paste. */
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

/** Maps letter keys to their ctrl-notation name (1 → "a"). */
function ctrlName(code: number): KeyName {
  return `ctrl+${String.fromCharCode(code + 96)}` as KeyName;
}

function key(name: KeyName, alt = false): KeyEvent {
  return { type: "key", name, alt };
}

/**
 * Parses one raw stdin chunk into key events. Lone text runs become `text`
 * events; a `text` event is marked `paste` when it arrived through bracketed
 * paste, contains a newline, or is longer than {@link PASTE_TEXT_THRESHOLD}.
 */
export function splitInputChunk(chunk: string): KeyEvent[] {
  const events: KeyEvent[] = [];
  const n = chunk.length;
  let i = 0;
  while (i < n) {
    const ch = chunk[i];

    if (ch === "\u001b") {
      // Bracketed paste: consume through the end marker when present.
      if (chunk.startsWith(PASTE_START, i)) {
        const end = chunk.indexOf(PASTE_END, i + PASTE_START.length);
        if (end === -1) {
          events.push({
            type: "text",
            text: chunk.slice(i + PASTE_START.length),
            paste: true,
          });
          i = n;
          continue;
        }
        events.push({
          type: "text",
          text: chunk.slice(i + PASTE_START.length, end),
          paste: true,
        });
        i = end + PASTE_END.length;
        continue;
      }
      const esc = parseEscape(chunk, i);
      if (esc !== null) {
        events.push(esc.event);
        i = esc.next;
        continue;
      }
      // Alt + key, or a bare Escape.
      const c = chunk[i + 1];
      if (c === "\r") {
        events.push(key("enter", true));
        i += 2;
        continue;
      }
      if (c === "\u007f" || c === "\b") {
        events.push(key("backspace", true));
        i += 2;
        continue;
      }
      if (c !== undefined && /[A-Za-z0-9]/.test(c)) {
        events.push({
          type: "key",
          name: `alt+${c.toLowerCase()}` as KeyName,
          alt: true,
        });
        i += 2;
        continue;
      }
      events.push(key("escape"));
      i += 1;
      continue;
    }

    if (ch === "\r") {
      events.push(key("enter"));
      i += 1;
      continue;
    }
    if (ch === "\n") {
      events.push(key("newline"));
      i += 1;
      continue;
    }
    if (ch === "\t") {
      events.push(key("tab"));
      i += 1;
      continue;
    }
    if (ch === "\u007f" || ch === "\b") {
      events.push(key("backspace"));
      i += 1;
      continue;
    }

    const code = ch.charCodeAt(0);
    if (code === 0) {
      events.push(key("ctrl+space"));
      i += 1;
      continue;
    }
    if (code >= 1 && code <= 26) {
      // 0x08/0x09/0x0a/0x0d are handled above; the rest are ctrl+letter.
      events.push(key(ctrlName(code)));
      i += 1;
      continue;
    }

    // Literal text run: stop at any control byte or escape.
    let j = i;
    while (j < n) {
      const c = chunk[j];
      if (
        c === "\u001b" ||
        c === "\r" ||
        c === "\n" ||
        c === "\t" ||
        c === "\u007f" ||
        c === "\b" ||
        c.charCodeAt(0) < 0x20
      )
        break;
      j++;
    }
    const text = chunk.slice(i, j);
    events.push({
      type: "text",
      text,
      paste: text.length > PASTE_TEXT_THRESHOLD,
    });
    i = j;
  }
  return events;
}

/** Parses an ANSI escape sequence starting at `start`; null when unknown. */
function parseEscape(
  chunk: string,
  start: number,
): { event: KeyEvent; next: number } | null {
  // SS3 (ESC O …) and CSI (ESC [ …) sequences.
  const second = chunk[start + 1];
  if (second === "O") {
    const c = chunk[start + 2];
    const next = start + 3;
    switch (c) {
      case "A":
        return { event: key("up"), next };
      case "B":
        return { event: key("down"), next };
      case "C":
        return { event: key("right"), next };
      case "D":
        return { event: key("left"), next };
      case "H":
        return { event: key("home"), next };
      case "F":
        return { event: key("end"), next };
    }
    return null;
  }
  if (second !== "[") return null;

  // CSI: read the parameter bytes, then the final byte.
  let k = start + 2;
  let params = "";
  while (k < chunk.length && /[0-9;]/.test(chunk[k])) {
    params += chunk[k];
    k++;
  }
  if (k >= chunk.length) return null;
  const final = chunk[k];
  const next = k + 1;
  const modifier = params.includes(";") ? Number(params.split(";")[1]) : 1;
  const ctrl = (modifier - 1) % 8 >= 4;
  const alt = (((modifier - 1) % 8) & 2) !== 0;

  switch (final) {
    case "A":
      return {
        event: ctrl ? key("ctrl+up") : alt ? key("alt+up") : key("up"),
        next,
      };
    case "B":
      return {
        event: ctrl ? key("ctrl+down") : alt ? key("alt+down") : key("down"),
        next,
      };
    case "C":
      return {
        event: ctrl ? key("ctrl+right") : alt ? key("alt+right") : key("right"),
        next,
      };
    case "D":
      return {
        event: ctrl ? key("ctrl+left") : alt ? key("alt+left") : key("left"),
        next,
      };
    case "H":
      return { event: key("home"), next };
    case "F":
      return { event: key("end"), next };
    case "Z":
      return { event: key("shift+tab"), next };
    case "~": {
      switch (params) {
        case "1":
        case "7":
          return { event: key("home"), next };
        case "2":
          return { event: key("home"), next }; // insert → home (no insert mode)
        case "3":
          return { event: key("delete"), next };
        case "4":
        case "8":
          return { event: key("end"), next };
        case "5":
          return { event: key("pageup"), next };
        case "6":
          return { event: key("pagedown"), next };
      }
      return { event: key("escape"), next };
    }
    default:
      // Unknown CSI: swallow the sequence rather than typing it.
      return { event: key("escape"), next };
  }
}

/**
 * Joins a run of queued events that looks like a paste split into key events
 * (text, then Enter, then more text — terminals that do not use bracketed paste
 * deliver each pasted line as typed text plus Return). Returns the pasted text
 * or null when the run is ordinary typing. This mirrors the Go App's
 * `coalescedSplitPaste`.
 */
export function coalesceSplitPaste(events: KeyEvent[]): string | null {
  let out = "";
  let enterCount = 0;
  let sawEnter = false;
  let textAfterEnter = false;
  for (const ev of events) {
    if (ev.type === "text") {
      if (ev.text === "") continue;
      if (sawEnter) textAfterEnter = true;
      enterCount += (ev.text.match(/\n/g) ?? []).length;
      if (ev.text.includes("\n")) {
        sawEnter = true;
        textAfterEnter = true;
      }
      out += ev.text;
      continue;
    }
    switch (ev.name) {
      case "space":
        if (sawEnter) textAfterEnter = true;
        out += " ";
        break;
      case "enter":
        if (ev.alt) return null;
        enterCount++;
        sawEnter = true;
        out += "\n";
        break;
      case "newline":
        enterCount++;
        sawEnter = true;
        out += "\n";
        break;
      default:
        return null;
    }
  }
  if (enterCount === 0 || !textAfterEnter) return null;
  return out;
}
