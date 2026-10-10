// Tests for the transcript/scrollback streaming skeleton.

import { assert, assertEquals } from "../compat/assert.ts";
import React, { type ReactElement } from "react";
import { render } from "ink";
import { MarkdownBlock, renderMarkdown, Transcript } from "./mod.ts";
import { admitCompletedTranscriptBlocks } from "./transcript.tsx";
import { type TranscriptBlock } from "./mod.ts";
import { test } from "#testing";

class FakeStdout {
  columns = 80;
  rows = 24;
  isTTY = true;
  output = "";
  write(s: string | Uint8Array): boolean {
    this.output += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }
  on(): this {
    return this;
  }
  off(): this {
    return this;
  }
  once(): this {
    return this;
  }
  addListener(): this {
    return this;
  }
  removeListener(): this {
    return this;
  }
  emit(): boolean {
    return false;
  }
  listenerCount(): number {
    return 0;
  }
  setEncoding(): this {
    return this;
  }
  end(): void {}
  hasColors(): boolean {
    return false;
  }
  getColorDepth(): number {
    return 1;
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

function view(blocks: TranscriptBlock[]): ReactElement {
  return React.createElement(Transcript, { blocks, width: 40 });
}

test("markdown helpers delegate to tsm", () => {
  assertEquals(renderMarkdown("# Hi", 40).includes("# Hi"), true);
  const block = new MarkdownBlock(40);
  block.update("Hel");
  assert(!block.done);
  assertEquals(block.output().includes("Hel"), true);
  block.finish("Hello **world**");
  assert(block.done);
  assertEquals(block.output().includes("world"), true);
  assert(!block.output().includes("**"));
});

test({
  name: "completed blocks commit to Static exactly once",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const stdout = new FakeStdout();
    const inst = render(view([{ id: "1", text: "# hello", done: true }]), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await tick();
    // A later render adds a second completed block; the first must not be
    // re-emitted (Static writes it to scrollback only once).
    inst.rerender(
      view([
        { id: "1", text: "# hello", done: true },
        { id: "2", text: "- item", done: true },
      ]),
    );
    await tick();
    inst.unmount();

    const helloCount = stdout.output.split("hello").length - 1;
    assertEquals(helloCount, 1, stdout.output);
    assert(stdout.output.includes("hello"));
    assert(stdout.output.includes("item"));
  },
});

test("out-of-order completion appends instead of reordering Static items", () => {
  const ids = new Set<string>();
  let admitted: TranscriptBlock[] = [];
  admitted = admitCompletedTranscriptBlocks(admitted, ids, [
    { id: "first", text: "first finished", done: false },
    { id: "second", text: "second finished", done: true },
  ]);
  assertEquals(
    admitted.map((block) => block.id),
    ["second"],
  );

  // `first` inserts before `second` in source order. Ink's Static indexes
  // its input rather than its React keys, so the second admission must append
  // `first` instead of handing Ink a reordered array that reprints `second`.
  admitted = admitCompletedTranscriptBlocks(admitted, ids, [
    { id: "first", text: "first finished", done: true },
    { id: "second", text: "second finished", done: true },
  ]);
  assertEquals(
    admitted.map((block) => block.id),
    ["second", "first"],
  );
});

test({
  name: "active streaming block stays in the managed view and updates",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const stdout = new FakeStdout();
    const inst = render(view([{ id: "1", text: "Hel", done: false }]), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await tick();
    inst.rerender(view([{ id: "1", text: "Hello world", done: false }]));
    await tick();
    inst.unmount();
    assert(stdout.output.includes("Hello world"));
    // Once completed, the block moves into Static/scrollback.
    const stdout2 = new FakeStdout();
    const inst2 = render(view([{ id: "1", text: "Hello world", done: true }]), {
      stdout: stdout2 as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await tick();
    inst2.unmount();
    assertEquals(stdout2.output.split("Hello world").length - 1, 1);
  },
});
