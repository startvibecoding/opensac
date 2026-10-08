// The framed panels' incremental content cache: a frame must rebuild only the
// blocks whose cheap signature changed, and must materialize only the visible
// window. These are the primitives behind the Ctrl+O/Ctrl+T performance
// contract asserted in tool_modal_perf_test.ts.

import { assert, assertEquals } from "@opensac/assert";
import {
  type ModalBlock,
  ModalContentCache,
  wrapBlockLines,
} from "./modal_content.ts";

function blocks(
  texts: Record<string, string>,
  rebuilt: string[],
): ModalBlock[] {
  return Object.entries(texts).map(([key, text]) => ({
    key,
    sig: `${key}:${text.length}`,
    build: () => {
      rebuilt.push(key);
      return text;
    },
  }));
}

Deno.test("modal cache rebuilds only blocks whose signature changed", () => {
  const cache = new ModalContentCache();
  const rebuilt: string[] = [];
  cache.refresh(blocks({ a: "first\nline", b: "second" }, rebuilt), 40);
  assertEquals(rebuilt, ["a", "b"]);
  assertEquals(cache.blockCount, 2);
  // "a" grows, "b" is untouched.
  rebuilt.length = 0;
  cache.refresh(blocks({ a: "first\nline longer", b: "second" }, rebuilt), 40);
  assertEquals(rebuilt, ["a"]);
  assertEquals(cache.lastRebuiltBlocks, 1);
  // Nothing changed at all.
  rebuilt.length = 0;
  cache.refresh(blocks({ a: "first\nline longer", b: "second" }, rebuilt), 40);
  assertEquals(rebuilt, []);
});

Deno.test("modal cache invalidates every block on width or generation change", () => {
  const cache = new ModalContentCache();
  const rebuilt: string[] = [];
  cache.refresh(blocks({ a: "aaaa", b: "bbbb" }, rebuilt), 40);
  rebuilt.length = 0;
  cache.refresh(blocks({ a: "aaaa", b: "bbbb" }, rebuilt), 30);
  assertEquals(rebuilt, ["a", "b"], "a new wrap width re-wraps the body");
  rebuilt.length = 0;
  cache.refresh(blocks({ a: "aaaa", b: "bbbb" }, rebuilt), 30, 7);
  assertEquals(rebuilt, ["a", "b"], "a cleared transcript drops stale rows");
});

Deno.test("modal cache slices the window with one separator between blocks", () => {
  const cache = new ModalContentCache();
  cache.refresh(
    [
      { key: "a", sig: "1", build: () => "a1\na2\na3" },
      { key: "b", sig: "1", build: () => "b1" },
      { key: "c", sig: "1", build: () => "c1\nc2" },
    ],
    40,
  );
  // 3 + 1 + 1 + 1 + 2 lines.
  assertEquals(cache.lineCount, 8);
  assertEquals(cache.slice(0, 3), ["a1", "a2", "a3"]);
  assertEquals(cache.slice(3, 2), ["", "b1"]);
  assertEquals(cache.slice(5, 2), ["", "c1"], "the block separator is a line");
  assertEquals(cache.slice(7, 5), ["c2"], "short at the end of the body");
  assertEquals(cache.slice(99, 4), []);
  assertEquals(cache.slice(1, 0), []);
});

Deno.test("modal cache keeps block layout stable for empty blocks", () => {
  const cache = new ModalContentCache();
  cache.refresh(
    [
      { key: "a", sig: "1", build: () => "only" },
      { key: "b", sig: "1", build: () => "" },
      { key: "c", sig: "1", build: () => "tail" },
    ],
    40,
  );
  // The empty block still occupies one (blank) line plus its separator.
  assertEquals(cache.lineCount, 5);
  assertEquals(cache.slice(0, 5), ["only", "", "", "", "tail"]);
});

Deno.test("modal cache patches the same block array in place", () => {
  const cache = new ModalContentCache();
  const rebuilt: string[] = [];
  const list = blocks({ a: "aaaa", b: "bbbb" }, rebuilt);
  cache.refresh(list, 40);
  assertEquals(rebuilt, ["a", "b"], "the first frame resolves the body");

  // A repeat frame over the identical array rebuilds nothing.
  rebuilt.length = 0;
  cache.refresh(list, 40);
  assertEquals(rebuilt, []);
  assertEquals(cache.lastRebuiltBlocks, 0);

  // The caller mutates one block in place (a spinner tick on a live row): the
  // layout is patched without re-resolving the body.
  list[0] = {
    ...list[0],
    sig: "a:99",
    build: () => {
      rebuilt.push("a");
      return "a1\na2\na3";
    },
  };
  rebuilt.length = 0;
  cache.refresh(list, 40);
  assertEquals(rebuilt, ["a"], "only the moved block re-wraps");
  assertEquals(cache.lineCount, 5, "3 lines + separator + 1 line");
  assertEquals(cache.slice(0, 6), ["a1", "a2", "a3", "", "bbbb"]);

  // A new array reference (the body grew) takes the full resolve path.
  rebuilt.length = 0;
  cache.refresh([...list], 40);
  assertEquals(rebuilt, []);
  assertEquals(cache.blockCount, 2);
});

Deno.test("modal cache bounds its retained text and re-wraps on demand", () => {
  // Well over the enforced minimum budget (4096 chars): the cold blocks must
  // give up their wrapped text while the layout keeps every line count.
  const cache = new ModalContentCache(5000);
  const blocks: ModalBlock[] = [];
  for (let i = 0; i < 12; i++) {
    blocks.push({
      key: `b${i}`,
      sig: "same",
      build: () => `block ${i}\n${"filler ".repeat(600)}`,
    });
  }
  cache.refresh(blocks, 40);
  assert(
    cache.cachedChars <= 5000 + 5000,
    `retained text escaped its budget: ${cache.cachedChars}`,
  );
  assert(cache.lastEvictedBlocks > 0, "the coldest blocks gave up their text");
  const unbounded = new ModalContentCache();
  unbounded.refresh(blocks, 40);
  assertEquals(unbounded.lineCount, cache.lineCount, "layout is complete");
  assertEquals(unbounded.blockCount, cache.blockCount);

  // Reading a window re-materializes only the blocks it shows, and a repeat
  // read of the same window is free: the touched block became the hottest.
  const first = cache.slice(0, 3);
  assertEquals(first[0], "block 0");
  assert(cache.lastMaterializedBlocks > 0, "the evicted window re-wrapped");
  const hot = cache.lastMaterializedBlocks;
  cache.slice(0, 3);
  assertEquals(cache.lastMaterializedBlocks, hot);

  // The re-wrapped window is byte-identical to the unbounded cache's.
  assertEquals(cache.slice(0, 20), unbounded.slice(0, 20));
});

Deno.test("wrapBlockLines wraps per input line and keeps blank lines", () => {
  const width = 10;
  assertEquals(
    wrapBlockLines("one two three four five", width),
    ["one two", "three four", "five"],
  );
  assertEquals(wrapBlockLines("a\n\nb", width), ["a", "", "b"]);
  assertEquals(wrapBlockLines("", width), [""]);
  // ANSI styling survives the wrap.
  const styled = wrapBlockLines("\u001b[31mred word another\u001b[0m", width);
  assert(styled.length > 1, "styled text wrapped");
  // deno-lint-ignore no-control-regex
  assert(/\u001B\[31m/.test(styled[0]), "style kept on the first segment");
});
