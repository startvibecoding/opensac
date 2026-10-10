// Focused tests for the raw terminal key parser: Backspace must stay distinct
// from Delete (Ink collapses both onto DEL), arrows/ctrl/alt decode, and
// bracketed paste folds to one event.

import { assertEquals } from "../compat/assert.ts";
import { coalesceSplitPaste, splitInputChunk } from "./keys.ts";
import { test } from "#testing";

test("plain text chunk becomes one text event", () => {
  const events = splitInputChunk("hello");
  assertEquals(events, [{ type: "text", text: "hello", paste: false }]);
});

test("DEL byte is backspace, not delete", () => {
  assertEquals(splitInputChunk("\x7f"), [
    {
      type: "key",
      name: "backspace",
      alt: false,
    },
  ]);
  assertEquals(splitInputChunk("\b"), [
    {
      type: "key",
      name: "backspace",
      alt: false,
    },
  ]);
  // The forward Delete key arrives as the CSI 3~ sequence.
  assertEquals(splitInputChunk("\x1b[3~"), [
    {
      type: "key",
      name: "delete",
      alt: false,
    },
  ]);
});

test("arrows and modifiers decode", () => {
  assertEquals(splitInputChunk("\x1b[A"), [
    {
      type: "key",
      name: "up",
      alt: false,
    },
  ]);
  assertEquals(splitInputChunk("\x1b[B"), [
    {
      type: "key",
      name: "down",
      alt: false,
    },
  ]);
  assertEquals(splitInputChunk("\x1b[C"), [
    {
      type: "key",
      name: "right",
      alt: false,
    },
  ]);
  assertEquals(splitInputChunk("\x1b[D"), [
    {
      type: "key",
      name: "left",
      alt: false,
    },
  ]);
  assertEquals(splitInputChunk("\x1b[1;5C"), [
    {
      type: "key",
      name: "ctrl+right",
      alt: false,
    },
  ]);
  assertEquals(splitInputChunk("\x1b[Z"), [
    {
      type: "key",
      name: "shift+tab",
      alt: false,
    },
  ]);
});

test("ctrl letters and enter/newline decode", () => {
  assertEquals(splitInputChunk("\x01"), [
    {
      type: "key",
      name: "ctrl+a",
      alt: false,
    },
  ]);
  assertEquals(splitInputChunk("\x03"), [
    {
      type: "key",
      name: "ctrl+c",
      alt: false,
    },
  ]);
  assertEquals(splitInputChunk("\x0f"), [
    {
      type: "key",
      name: "ctrl+o",
      alt: false,
    },
  ]);
  assertEquals(splitInputChunk("\r"), [
    {
      type: "key",
      name: "enter",
      alt: false,
    },
  ]);
  assertEquals(splitInputChunk("\n"), [
    {
      type: "key",
      name: "newline",
      alt: false,
    },
  ]);
  assertEquals(splitInputChunk("\t"), [
    {
      type: "key",
      name: "tab",
      alt: false,
    },
  ]);
});

test("alt+enter and alt+letter decode", () => {
  assertEquals(splitInputChunk("\x1b\r"), [
    {
      type: "key",
      name: "enter",
      alt: true,
    },
  ]);
  assertEquals(splitInputChunk("\x1bw"), [
    {
      type: "key",
      name: "alt+w",
      alt: true,
    },
  ]);
});

test("Batched input splits into individual keys", () => {
  const events = splitInputChunk("hi\r");
  assertEquals(events, [
    { type: "text", text: "hi", paste: false },
    { type: "key", name: "enter", alt: false },
  ]);
});

test("bracketed paste becomes one paste text event", () => {
  const events = splitInputChunk("\x1b[200~line1\nline2\x1b[201~");
  assertEquals(events, [{ type: "text", text: "line1\nline2", paste: true }]);
});

test("long text runs are marked as paste", () => {
  const events = splitInputChunk("x".repeat(600));
  assertEquals(events.length, 1);
  assertEquals(events[0].type, "text");
  assertEquals((events[0] as { paste: boolean }).paste, true);
});

test("coalesceSplitPaste joins split pastes but not plain typing", () => {
  assertEquals(coalesceSplitPaste(splitInputChunk("a\nb\nc")), "a\nb\nc");
  assertEquals(coalesceSplitPaste(splitInputChunk("hi")), null);
  assertEquals(coalesceSplitPaste(splitInputChunk("hi\r")), null);
  assertEquals(coalesceSplitPaste(splitInputChunk("a\rb\rc")), "a\nb\nc");
});
