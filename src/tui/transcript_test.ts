// Tests for the transcript/scrollback streaming skeleton.

import { assert, assertEquals } from "../compat/assert.ts";
import type { ReactElement } from "react";
import { render } from "ink";
import { MarkdownBlock, renderMarkdown, Transcript } from "./mod.ts";
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
  return Transcript({ blocks, width: 40 });
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
