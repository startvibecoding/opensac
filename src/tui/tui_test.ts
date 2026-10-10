// Toolchain smoke test for the Ink + React TUI target.

import { assert, assertEquals } from "../compat/assert.ts";
import { render } from "ink";
import { App } from "./mod.ts";
import { test } from "#testing";

test("ink and react load under Node", () => {
  assertEquals(typeof render, "function");
  assertEquals(typeof App, "function");
});

/** Minimal duck-typed stdout so Ink can render without a real TTY. */
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

test({
  name: "App renders through Ink",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const stdout = new FakeStdout();
    const instance = render(App({ label: "hello-ink" }), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    instance.unmount();
    assert(
      stdout.output.includes("hello-ink"),
      `unexpected Ink output: ${JSON.stringify(stdout.output)}`,
    );
  },
});
