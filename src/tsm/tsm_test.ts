// and gsm/gsm_test.go. Outputs are byte-identical to the Go library for
// well-formed Markdown and for pure-ASCII input (verified by differential
// testing); see the note at the end of this file for the one intentional
// deviation.

import { assert, assertEquals } from "@opensac/assert";
import {
  computeIDs,
  createStream,
  defaultOption,
  defaultTheme,
  gsmRender,
  lightTheme,
  Node,
  NodeType,
  parse,
  Renderer,
  streamOption,
  stripANSI,
  visualWidth,
  wrapANSI,
} from "./mod.ts";

function root(src: string): Node {
  return parse(src, defaultOption());
}

// ── Parser: blocks ──────────────────────────────────────────────────────────

Deno.test("heading levels and trailing hashes", () => {
  const doc = root("## Heading ##");
  const h = doc.findChild(NodeType.Heading)!;
  assertEquals(h.level, 2);
  assertEquals(h.children[0].text, "Heading");
});

Deno.test("heading requires a space", () => {
  const doc = root("#nos");
  assertEquals(doc.findChild(NodeType.Heading), undefined);
  assertEquals(doc.findChild(NodeType.Paragraph)!.textContent(), "#nos\n");
});

Deno.test("paragraph and hard break", () => {
  const doc = root("line1  \nline2");
  const p = doc.findChild(NodeType.Paragraph)!;
  assertEquals(p.children.some((c) => c.type === NodeType.HardBreak), true);
  assertEquals(p.textContent(), "line1\nline2\n");
});

Deno.test("fenced code block", () => {
  const doc = root("```go\nx := 1\n```");
  const code = doc.findChild(NodeType.FencedCodeBlock)!;
  assertEquals(code.language, "go");
  assertEquals(code.code, "x := 1");
});

Deno.test("indented code block", () => {
  const doc = root("    code line");
  const code = doc.findChild(NodeType.IndentedCodeBlock)!;
  assertEquals(code.code, "code line");
});

Deno.test("blockquote nested", () => {
  const doc = root("> outer\n>\n> > inner");
  const bq = doc.findChild(NodeType.Blockquote)!;
  assertEquals(bq.quoteLevel, 0);
  assertEquals(
    stripANSI(gsmRender("> outer\n>\n> > inner", 30)),
    "│ outer\n│ \n│ │ inner\n\n",
  );
});

Deno.test("unordered list with task items", () => {
  const doc = root("- a\n- [x] b\n- [ ] c");
  const list = doc.findChild(NodeType.UnorderedList)!;
  assertEquals(list.children.length, 3);
  assertEquals(list.children[1].isTaskItem, true);
  assertEquals(list.children[1].checked, true);
  assertEquals(list.children[2].checked, false);
});

Deno.test("ordered list start number", () => {
  const doc = root("3. third\n4. fourth");
  const list = doc.findChild(NodeType.OrderedList)!;
  assertEquals(list.startNum, 3);
  assertEquals(list.children.length, 2);
});

Deno.test("list item startsWithBold", () => {
  const doc = root("- **bold** rest");
  const item = doc.findChild(NodeType.UnorderedList)!.children[0];
  assertEquals(item.startsWithBold, true);
});

Deno.test("table basic", () => {
  const doc = root("| a | b |\n|---|---|\n| 1 | 2 |");
  const table = doc.findChild(NodeType.Table)!;
  assertEquals(table.children.length, 2);
  assertEquals(table.children[0].isTableHeader, true);
  assertEquals(table.children[0].children.length, 2);
});

Deno.test("thematic break variants", () => {
  for (const src of ["---", "***", "___", "- - -"]) {
    assertEquals(
      root(src).findChild(NodeType.ThematicBreak) !== undefined,
      true,
      src,
    );
  }
});

// ── Parser: inline ──────────────────────────────────────────────────────────

Deno.test("inline emphasis strong code", () => {
  const doc = root("a *i* b **s** c `k`");
  const p = doc.findChild(NodeType.Paragraph)!;
  const kinds = p.children.map((c) => c.type);
  assert(kinds.includes(NodeType.Emphasis));
  assert(kinds.includes(NodeType.Strong));
  assert(kinds.includes(NodeType.CodeSpan));
});

Deno.test("inline link, image, strikethrough, autolink", () => {
  const doc = root(
    "see [t](http://x.com) ![alt](http://y.png) ~~gone~~ <http://z.com> <a@b.com>",
  );
  const p = doc.findChild(NodeType.Paragraph)!;
  const types = new Set(p.children.map((c) => c.type));
  assert(types.has(NodeType.Link));
  assert(types.has(NodeType.Image));
  assert(types.has(NodeType.Strikethrough));
  assertEquals(
    p.children.filter((c) => c.type === NodeType.Autolink).length,
    2,
  );
});

Deno.test("link title parsed", () => {
  const doc = root('[t](http://x.com "the title")');
  const link = doc.findChild(NodeType.Paragraph)!.findChild(NodeType.Link)!;
  assertEquals(link.url, "http://x.com");
  assertEquals(link.title, "the title");
});

Deno.test("speculative emphasis rewrite on stream", () => {
  // A trailing single delimiter is closed into an (empty) Emphasis node, so
  // the placeholder underscore disappears from the text content.
  assertEquals(parse("a_", streamOption()).textContent(), "a\n");
  assertEquals(parse("a_", defaultOption()).textContent(), "a_\n");
  // Partial strong markup keeps its text visible.
  assert(
    parse("Yeah, this is **cool", streamOption()).textContent().includes(
      "cool",
    ),
  );
});

Deno.test("speculative disabled by default", () => {
  const doc = parse("Hello **wor", defaultOption());
  const p = doc.findChild(NodeType.Paragraph)!;
  assertEquals(p.children.some((c) => c.type === NodeType.Strong), false);
});

Deno.test("speculative table rewrite", () => {
  const doc = parse("| a | b", streamOption());
  const p = doc.findChild(NodeType.Paragraph);
  // The partial table paragraph is emptied so nothing renders.
  assert(!p || p.children.length === 0);
});

Deno.test("latex preprocessing", () => {
  const doc = root("$$\\dfrac{1}{2}$$");
  const code = doc.findChild(NodeType.FencedCodeBlock)!;
  assertEquals(code.language, "blockmath");
  assertEquals(code.code, "\\frac{1}{2}");

  const inline = root("value $\\boxed{x}$ here");
  const p = inline.findChild(NodeType.Paragraph)!;
  assert(
    p.children.some((c) => c.type === NodeType.CodeSpan && c.text === "${x}$"),
  );
});

Deno.test("computeIDs and textContent", () => {
  const doc = root("# Title\n\nPara.");
  computeIDs(doc);
  assertEquals(doc.id, "0");
  assertEquals(doc.children[0].id, "0-0");
  assertEquals(doc.children[1].id, "0-1");
  assertEquals(doc.children[0].textContent(), "Title\n");
});

Deno.test("empty and blank input", () => {
  assertEquals(root("").children.length, 0);
  assertEquals(root("\n\n").children.length, 0);
});

// ── Renderer ────────────────────────────────────────────────────────────────

Deno.test("render heading golden", () => {
  const out = gsmRender("# Hello **world**", 30);
  assertEquals(
    out.replaceAll("\x1b", "\\e"),
    "\\e[1m\\e[96m# Hello \\e[1mworld\\e[0m\\e[0m\n\n",
  );
  assertEquals(stripANSI(out), "# Hello world\n\n");
});

Deno.test("render unordered list with task golden", () => {
  const out = gsmRender("- a\n- [x] b", 30);
  assertEquals(stripANSI(out), "• a\n☑ b\n\n");
  assertEquals(
    out.replaceAll("\x1b", "\\e"),
    "\\e[93m• \\e[0ma\n\\e[32m☑ \\e[0mb\n\n",
  );
});

Deno.test("render ordered list has no trailing blank line (Go quirk)", () => {
  const out = gsmRender("3. third\n4. fourth", 20);
  assertEquals(
    out.replaceAll("\x1b", "\\e"),
    "\\e[93m3. \\e[0mthird\n\\e[93m4. \\e[0mfourth\n",
  );
});

Deno.test("render blockquote golden", () => {
  assertEquals(stripANSI(gsmRender("> q", 30)), "│ q\n\n");
});

Deno.test("render table golden", () => {
  const out = stripANSI(gsmRender("| a | b |\n|---|---|\n| 1 | 2 |", 30));
  assertEquals(
    out,
    "┌─────┬─────┐\n│ a   │ b   │\n├─────┼─────┤\n│ 1   │ 2   │\n└─────┴─────┘\n\n",
  );
});

Deno.test("render thematic break golden", () => {
  assertEquals(stripANSI(gsmRender("---", 30)), "─".repeat(28) + "\n\n");
});

Deno.test("render code block with CJK width", () => {
  const out = stripANSI(gsmRender("```\n日本\n```", 30));
  assert(out.includes("日本"));
  const lines = out.split("\n");
  assertEquals(visualWidth(lines[0]), 30);
  assertEquals(visualWidth(lines[1]), 30);
});

Deno.test("render paragraph wrapping", () => {
  const out = stripANSI(
    gsmRender("The quick brown fox jumps over the lazy", 12),
  );
  for (const line of out.trimEnd().split("\n")) {
    assert(visualWidth(line) <= 12, `line too wide: ${JSON.stringify(line)}`);
  }
});

Deno.test("render image placeholder", () => {
  const out = stripANSI(gsmRender("![alt](http://y.png)", 40));
  assert(out.includes("🖼 alt"));
  assert(out.includes("(http://y.png)"));
});

Deno.test("renderer themes are defined", () => {
  assert(defaultTheme().heading.length > 0);
  assert(lightTheme().heading.length > 0);
  assertEquals(new Renderer(undefined, 0).width, 80);
});

Deno.test("stripANSI", () => {
  assertEquals(stripANSI("\x1b[1mhello\x1b[0m"), "hello");
  assertEquals(stripANSI("\x1b[38;5;200mx"), "x");
  assertEquals(stripANSI("plain"), "plain");
  assertEquals(stripANSI(""), "");
});

Deno.test("visualWidth", () => {
  assertEquals(visualWidth("abc"), 3);
  assertEquals(visualWidth("\x1b[1mab\x1b[0m"), 2);
  assertEquals(visualWidth("日本"), 4);
  assertEquals(visualWidth("a🎉"), 3);
  assertEquals(visualWidth(""), 0);
});

Deno.test("wrapANSI word boundary", () => {
  assertEquals(wrapANSI("one two three", 7, "", 0), "one two\nthree");
  assertEquals(wrapANSI("one two three", 7, "", 1), "one two\n\nthree");
  assertEquals(wrapANSI("hello", 80, "", 0), "hello");
  assertEquals(wrapANSI("", 80, "", 0), "");
});

Deno.test("wrapANSI splits overlong words instead of overflowing", () => {
  // A space-free CJK run and a single long styled span are both wider than
  // the wrap width; every produced line must fit inside it.
  for (
    const text of [
      "这是一段中文里没有空格换行的长句子需要按单元格切开",
      "\x1b[1m这是一个很长的加粗span跨越多个换行宽度才结束\x1b[0m尾",
    ]
  ) {
    for (const line of wrapANSI(text, 10, "", 0).split("\n")) {
      assert(visualWidth(line) <= 10, `overflow: ${JSON.stringify(line)}`);
    }
  }
});

Deno.test("wrapANSI re-opens the style state at each continuation line", () => {
  // The trailing reset belongs to the end of the code span, so the line that
  // starts with "width" must still re-open the span's colour; a snapshot
  // taken after the word's escapes were consumed used to render it plain.
  const text =
    "text with \x1b[91ma very long inline code span that itself exceeds the wrap width\x1b[0m tail";
  const lines = wrapANSI(text, 20, "", 0).split("\n");
  const widthLine = lines.find((l) => l.includes("width"));
  assert(widthLine !== undefined && widthLine.startsWith("\x1b[91m"));
  // Mid-span continuations keep the bold state too.
  const boldLines = wrapANSI(
    "plain \x1b[1mbold words that must stay bold across the wrap\x1b[0m end",
    20,
    "",
    0,
  ).split("\n");
  for (const line of boldLines) {
    if (visualWidth(stripANSI(line)) === 0) continue;
    const isMidSpan = /\b(words|must|stay|bold|across|the|wrap)\b/.test(
      stripANSI(line),
    ) && !stripANSI(line).startsWith("plain");
    if (isMidSpan) assert(line.includes("\x1b[1m"), JSON.stringify(line));
  }
});

// ── gsm streaming facade ────────────────────────────────────────────────────

Deno.test("createStream default width and empty output", () => {
  const s = createStream(0);
  assertEquals(s.output(), "");
  s.update("# hi");
  assert(s.output().includes("# hi"));
});

Deno.test("stream preserves Unicode order for SSE text", () => {
  const sseText =
    "已改回 `https://se.lab.bza.edu.cn`,编译通过。\n\n现在 baseURL 默认是 `https://se.lab.bza.edu.cn`,仍保留了 `OSCANNER_BASE_URL` 环境变量覆盖能力。";
  const expectedInOrder = [
    "已改回",
    "https://se.lab.bza.edu.cn",
    "编译通过。",
    "现在 baseURL 默认是",
    "OSCANNER_BASE_URL",
    "环境变量覆盖能力",
  ];
  const s = createStream(80);
  const runes = Array.from(sseText);
  let accumulated = "";
  for (let i = 0; i < runes.length; i += 7) {
    accumulated += runes.slice(i, i + 7).join("");
    s.update(accumulated);
    const out = stripANSI(s.output());
    // The stream must never emit invalid UTF-8 (i.e. never split a surrogate
    // pair or a code point).
    assert(
      !out.includes("\uFFFD"),
      `stream output should stay valid UTF-8: ${JSON.stringify(out)}`,
    );
  }
  const final = stripANSI(s.output()).replace(/\s+/g, "");
  let last = -1;
  for (const part of expectedInOrder) {
    const idx = final.indexOf(part.replace(/\s+/g, ""));
    assert(idx >= 0, `missing fragment ${JSON.stringify(part)}`);
    assert(idx >= last, `reordered fragment ${JSON.stringify(part)}`);
    last = idx;
  }
});

// ── Intentional deviation from the Go original ──────────────────────────────
//
// Go's inline parser reads the escaped character as a *byte* and converts it
// with string(byte), so escaping a multi-byte character emits its first byte
// reinterpreted as a Latin-1 rune (e.g. `\本` renders "æ"). This port operates
// on code points, so `\本` renders "本". We keep the correct behaviour and do
// not reproduce that UTF-8 bug.
Deno.test("escaping a multibyte character is code-point correct", () => {
  assertEquals(stripANSI(gsmRender("\\本", 20)), "本\n\n");
});
