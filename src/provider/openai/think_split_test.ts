import { assertEquals } from "../../compat/assert.ts";
import { ThinkSplitter } from "./think_split.ts";
import { test } from "#testing";

const open = "\u003cthink\u003e";
const close = "\u003c/think\u003e";

test("ThinkSplitterSingleChunk", () => {
  const s = new ThinkSplitter();
  const { text, think } = s.push(
    `${open}reasoning here${close}visible answer`,
  );
  assertEquals(think, "reasoning here");
  assertEquals(text, "visible answer");
  const f = s.flush();
  assertEquals(f.text, "");
  assertEquals(f.think, "");
});

test("ThinkSplitterPlainText", () => {
  const s = new ThinkSplitter();
  const { text, think } = s.push("just plain text");
  assertEquals(think, "");
  assertEquals(text, "just plain text");
});

test("ThinkSplitterTagSplitAcrossChunks", () => {
  const s = new ThinkSplitter();
  let text = "";
  let think = "";
  for (
    const c of [
      "\u003cthi",
      "nk\u003ethink",
      "ing\u003c/th",
      "ink\u003eans",
      "wer",
    ]
  ) {
    const r = s.push(c);
    text += r.text;
    think += r.think;
  }
  const f = s.flush();
  text += f.text;
  think += f.think;
  assertEquals(think, "thinking");
  assertEquals(text, "answer");
});

test("ThinkSplitterTextBeforeThink", () => {
  const s = new ThinkSplitter();
  const { text, think } = s.push(`hello ${open}secret${close} world`);
  assertEquals(think, "secret");
  assertEquals(text, "hello  world");
});

test("ThinkSplitterUnclosedThink", () => {
  const s = new ThinkSplitter();
  const { text, think } = s.push(`${open}still thinking`);
  assertEquals(text, "");
  assertEquals(think, "still thinking");
  const f = s.flush();
  assertEquals(f.text, "");
  assertEquals(f.think, "");
});

test("ThinkSplitterPartialFalseAlarm", () => {
  // A "<" that turns out not to be a tag must be emitted as text.
  const s = new ThinkSplitter();
  let text = "";
  for (const c of ["a \u003c", "b c"]) text += s.push(c).text;
  text += s.flush().text;
  assertEquals(text, "a \u003cb c");
});

test("ThinkSplitterFlushPartialTag", () => {
  // A dangling partial tag at end of stream is emitted literally.
  const s = new ThinkSplitter();
  const { text } = s.push("done \u003cthi");
  assertEquals(text, "done ");
  assertEquals(s.flush().text, "\u003cthi");
});
