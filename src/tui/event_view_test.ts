// Ctrl+G simple/full event display (the Go TUI's compact mode): the simple
// view keeps one-line tool rows and drops routine lifecycle rows, and the full
// view replays the rows the simple view withheld — each row released to
// terminal scrollback exactly once through Ink's append-only <Static>.

import { assert, assertEquals } from "@std/assert";
import { render } from "ink";
import { App } from "./app.tsx";
import { AppController } from "./app_controller.ts";
import { Translator } from "./i18n.ts";
import { stripANSI } from "./renderutil.ts";
import { createFakeTUIService } from "./service.ts";
import { TUISession } from "./tui_session.ts";

/** Minimal duck-typed stdout so Ink can render without a real TTY. */
class FakeStdout {
  columns = 100;
  rows = 30;
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function session(tuilang: string): TUISession {
  return new TUISession(
    {
      provider: "openai",
      model: "",
      mode: "yolo",
      thinking: "",
      workDir: Deno.cwd(),
      version: "test",
      tuilang,
    },
    createFakeTUIService(),
  );
}

Deno.test({
  name: "Ctrl+G reports the event view in the configured language",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const en = session("en");
    // The simple view is the default, matching the Ctrl+G shortcut hint.
    assertEquals(en.compactMode, true);
    en.toggleCompactMode();
    assertEquals(en.controller.store.messages.at(-1), "Full event display: ON");
    assertEquals(
      en.controller.store.messageKinds.get(
        en.controller.store.messages.length - 1,
      ),
      "status",
    );
    en.toggleCompactMode();
    assertEquals(
      en.controller.store.messages.at(-1),
      "Simple event display: ON",
    );

    const zh = session("zh");
    zh.toggleCompactMode();
    assertEquals(zh.controller.store.messages.at(-1), "完整事件显示：开启");
  },
});

Deno.test({
  name: "simple view withholds lifecycle rows until the full view replays",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const c = new AppController(new Translator("en"), {
      onMessage: () => {},
      scheduleRender: () => {},
    });
    c.addMessage("user: hello", "plain");
    c.addEventMessage("Context compacted: 1200 tokens", false);
    c.addEventMessage("Tool failed: permission denied", true);

    const view = (compactMode: boolean) =>
      App({ controller: c, compactMode, width: 80 });
    const stdout = new FakeStdout();
    const instance = render(view(true), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await sleep(30);

    let out = stripANSI(stdout.output);
    assert(out.includes("user: hello"), out);
    assert(out.includes("Tool failed: permission denied"), out);
    assert(!out.includes("Context compacted"), out);

    // Full view: the withheld row is released once, the printed rows are not
    // re-emitted.
    instance.rerender(view(false));
    await sleep(30);
    out = stripANSI(stdout.output);
    assert(out.includes("Context compacted: 1200 tokens"), out);
    assertEquals(count(out, "user: hello"), 1);
    assertEquals(count(out, "Context compacted: 1200 tokens"), 1);

    // Back to the simple view: already printed rows stay where they are.
    instance.rerender(view(true));
    await sleep(30);
    out = stripANSI(stdout.output);
    assertEquals(count(out, "user: hello"), 1);
    assertEquals(count(out, "Context compacted: 1200 tokens"), 1);
    instance.unmount();
  },
});

Deno.test({
  name: "a cleared transcript admits its new rows exactly once",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const c = new AppController(new Translator("en"), {
      onMessage: () => {},
      scheduleRender: () => {},
    });
    c.addMessage("before clear", "plain");
    const view = () => App({ controller: c, compactMode: true, width: 80 });
    const stdout = new FakeStdout();
    const instance = render(view(), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await sleep(30);
    assert(stripANSI(stdout.output).includes("before clear"));

    c.store.resetTranscriptState();
    c.addMessage("after clear", "plain");
    instance.rerender(view());
    await sleep(30);
    const out = stripANSI(stdout.output);
    assert(out.includes("after clear"), out);
    assertEquals(count(out, "after clear"), 1);
    instance.unmount();
  },
});
