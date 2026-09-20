// Focused tests for TUI slice 2b: the editor buffer (Unicode multi-line
// editing), the editor model (key handling, wrapping, windowing), the
// suggestion dropdown (filter/wrap/scroll), and the command-suggest wiring
// (spec-driven items, argument tables).

import { assertEquals } from "@std/assert";
import { Buffer } from "./components/editor/buffer.ts";
import { Editor, wrapLineSegments } from "./components/editor/editor.ts";
import { Suggest, type SuggestItem } from "./components/suggest/suggest.ts";
import {
  commandArgumentSuggestionItems,
  commandSuggestionItems,
  commandSuggestionItemsForInput,
} from "./command_suggest.ts";
import { Translator } from "./i18n.ts";

function strip(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/\u001B\[[0-9;]*m/g, "");
}

// ─── buffer ─────────────────────────────────────────────────────────────────

Deno.test("buffer inserts, deletes, and moves across lines", () => {
  const b = new Buffer();
  assertEquals(b.value, "");
  assertEquals(b.lineCount, 1);

  for (const ch of "hello") b.insertRune(ch);
  assertEquals(b.value, "hello");
  b.insertNewline();
  for (const ch of "world") b.insertRune(ch);
  assertEquals(b.value, "hello\nworld");
  assertEquals(b.cursorPos(), [1, 5]);

  b.moveLeft();
  b.deleteForward(); // delete 'd'
  assertEquals(b.value, "hello\nworl");
  b.deleteBack(); // delete 'l'
  assertEquals(b.value, "hello\nwor");
  b.moveUp();
  assertEquals(b.cursorPos(), [0, 3]); // preferredCol clamped to 3
});

Deno.test("buffer deleteBack merges lines and tracks cursor", () => {
  const b = new Buffer();
  b.setValue("ab\ncd");
  b.moveEndAll();
  assertEquals(b.cursorPos(), [1, 2]);
  b.deleteBack(); // in-line: deletes 'd'
  assertEquals(b.value, "ab\nc");
  b.deleteBack(); // in-line: deletes 'c'
  assertEquals(b.value, "ab\n");
  b.deleteBack(); // col 0: merges with previous line
  assertEquals(b.value, "ab");
  assertEquals(b.cursorPos(), [0, 2]);
});

Deno.test("buffer ctrl-w deletes the previous word", () => {
  const b = new Buffer();
  b.setValue("one two three");
  b.moveEndAll();
  b.deleteWordBack();
  assertEquals(b.value, "one two ");
  assertEquals(b.cursorPos(), [0, 8]);
  b.deleteWordBack();
  assertEquals(b.value, "one ");
});

Deno.test("buffer insertString splits multi-line paste", () => {
  const b = new Buffer();
  b.setValue("ab|cd");
  b.moveEndAll();
  b.moveLeft(); // cursor before 'c'
  b.moveLeft();
  assertEquals(b.cursorPos(), [0, 3]);
  b.insertString("x\ny");
  assertEquals(b.value, "ab|x\nycd");
  assertEquals(b.cursorPos(), [1, 1]);
});

Deno.test("buffer word movement crosses the whole buffer", () => {
  const b = new Buffer();
  b.setValue("one two\nthree four");
  b.moveEndAll();
  b.moveWordLeft();
  assertEquals(b.cursorPos(), [1, 6]); // start of "four"
  b.moveWordLeft();
  assertEquals(b.cursorPos(), [1, 0]); // start of "three"
  b.moveWordLeft();
  assertEquals(b.cursorPos(), [0, 4]); // start of "two"
  b.moveWordRight();
  assertEquals(b.cursorPos(), [0, 7]);
  b.moveWordRight();
  assertEquals(b.cursorPos(), [1, 5]);
});

Deno.test("buffer counts runes including newlines and CJK", () => {
  const b = new Buffer();
  b.setValue("中文\nab");
  assertEquals(b.runeCount, 5); // 2 + newline + 2
  b.moveEndAll();
  // cursor sits after 'a'... moveEndAll puts it at end of "ab"
  assertEquals(b.cursorDisplayCol(), 2); // CJK lines above don't affect col cells
});

// ─── editor ─────────────────────────────────────────────────────────────────

Deno.test("editor handles keys: typing, submit, newline, edits", () => {
  const e = new Editor({ width: 40 });
  e.insertText("hello");
  assertEquals(e.value, "hello");
  assertEquals(e.handleKey("enter"), true); // submit
  assertEquals(e.value, "hello");
  assertEquals(e.handleKey("alt+enter"), false);
  assertEquals(e.value, "hello\n");
  e.insertText("second");
  assertEquals(e.value, "hello\nsecond");
  assertEquals(e.atLastLine, true);
  assertEquals(e.atFirstLine, false);
  e.handleKey("ctrl+u");
  assertEquals(e.value, "hello\n");
  e.handleKey("backspace");
  assertEquals(e.value, "hello");
});

Deno.test("editor blur blocks input", () => {
  const e = new Editor({ width: 40 });
  e.blur();
  e.insertText("nope");
  assertEquals(e.value, "");
  assertEquals(e.handleKey("enter"), false);
});

Deno.test("editor view wraps long lines and windows around the cursor", () => {
  const e = new Editor({ width: 30, maxLines: 2 });
  e.insertText("word ".repeat(10).trim());
  const view = e.view();
  const lines = view.split("\n");
  assertEquals(lines.length, 2); // maxLines window
  // Every line fits the padded width (30)
  for (const l of lines) {
    assertEquals(strip(l).length <= 30, true);
  }
});

Deno.test("editor placeholder renders when empty", () => {
  const e = new Editor({ width: 40, placeholder: "Type a message..." });
  const view = strip(e.view());
  assertEquals(view.includes("Type a message..."), true);
});

Deno.test("wrapLineSegments splits by display width", () => {
  const segs = wrapLineSegments("abcdef", 4, 0, 0);
  assertEquals(segs.length, 2);
  assertEquals(segs[0].text, "abcd");
  assertEquals(segs[1].text, "ef");
  // CJK: 4-wide line of 2-wide runes
  const cjk = wrapLineSegments("中文中文", 4, 0, 0);
  assertEquals(cjk[0].text, "中文");
});

// ─── suggest ────────────────────────────────────────────────────────────────

Deno.test("suggest filters by prefix on label or value", () => {
  const s = new Suggest(60);
  const items: SuggestItem[] = [
    { label: "/mode", value: "/mode ", description: "switch mode" },
    { label: "/model", value: "/model ", description: "switch model" },
    { label: "/clear", value: "/clear", description: "clear" },
  ];
  s.setItems(items);
  assertEquals(s.visible, false); // empty query hides

  s.update("/mo");
  assertEquals(s.visible, true);
  assertEquals(s.filtered.length, 2);

  s.update("/clear");
  assertEquals(s.filtered.length, 1);

  s.update("/zzz");
  assertEquals(s.visible, false);

  s.update("");
  assertEquals(s.visible, false);
  assertEquals(s.filtered.length, 3);
});

Deno.test("suggest selection wraps and applies", () => {
  const s = new Suggest(60);
  s.setItems([
    { label: "a", value: "a" },
    { label: "b", value: "b" },
  ]);
  s.update("x").update(""); // reset filter
  s.cursorDown();
  assertEquals(s.selected?.label, "b");
  s.cursorDown();
  assertEquals(s.selected?.label, "a"); // wrapped
  s.cursorUp();
  assertEquals(s.selected?.label, "b");
});

Deno.test("suggest view renders dropdown with border and scroll indicator", () => {
  const s = new Suggest(40, 3);
  const items: SuggestItem[] = [];
  for (let i = 0; i < 5; i++) {
    items.push({ label: `/cmd${i}`, value: `/cmd${i} ` });
  }
  s.setItems(items);
  s.update("/");
  const view = strip(s.view());
  const lines = view.split("\n");
  assertEquals(lines.length, 3 + 2 + 1); // border + maxVisible + more hint
  assertEquals(view.includes("╭"), true);
  assertEquals(view.includes("↑↓ more"), true);
});

// ─── command suggest wiring ─────────────────────────────────────────────────

Deno.test("commandSuggestionItems carries localized descriptions", () => {
  const en = commandSuggestionItems();
  assertEquals(en.length, 33);
  assertEquals(en[0].label, "/auth");
  assertEquals(
    en[0].description,
    "Configure provider token, base URL and models",
  );
  const zh = commandSuggestionItems(new Translator("zh"));
  assertEquals(zh[0]?.description?.includes("token"), true);
});

Deno.test("commandSuggestionItemsForInput gates on slash and newline", () => {
  assertEquals(commandSuggestionItemsForInput("hello"), undefined);
  assertEquals(commandSuggestionItemsForInput("/mode\nsecond"), undefined);
  const names = commandSuggestionItemsForInput("/mo");
  assertEquals(names?.query, "/mo");
  // The full spec table + query; prefix filtering happens in Suggest.filter
  assertEquals(names?.items.length, 33);
  const s = new Suggest(60).setItems(names!.items).update(names!.query);
  assertEquals(s.filtered.map((i) => i.label), ["/mode", "/model"]);
});

Deno.test("commandArgumentSuggestionItems suggests known arguments", () => {
  const mode = commandArgumentSuggestionItems("/mode ");
  assertEquals(mode.map((i) => i.value), [
    "/mode plan",
    "/mode agent",
    "/mode yolo",
    "/mode os",
  ]);
  const modeP = commandArgumentSuggestionItems("/mode p");
  assertEquals(modeP.length, 4); // full list; dropdown filters by prefix

  const tuilang = commandArgumentSuggestionItems("/tuilang global ");
  assertEquals(tuilang.map((i) => i.value), [
    "/tuilang global auto",
    "/tuilang global zh",
    "/tuilang global en",
  ]);

  const unknown = commandArgumentSuggestionItems("/bogus ");
  assertEquals(unknown, []);
  const noArgs = commandArgumentSuggestionItems("/clear ");
  assertEquals(noArgs, []);
});
