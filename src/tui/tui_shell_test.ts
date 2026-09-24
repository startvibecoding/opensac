// Focused shell tests: raw stdin → editor/backspace/submit and a split paste.
// Ink input requires a TTY, so the shell is mounted over a fake stdin/stdout.

import { assert, assertEquals } from "@std/assert";
import React from "react";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { TuiShell } from "./tui_shell.tsx";
import { AppController } from "./app_controller.ts";
import { EVENT_TEXT_DELTA, EVENT_TURN_START } from "../agent/events.ts";
import { InputState } from "./input_state.ts";
import { Translator } from "./i18n.ts";
import type { TUISession } from "./tui_session.ts";

class FakeStdin extends EventEmitter {
  isTTY = true;
  #chunks: string[] = [];
  setEncoding(): this {
    return this;
  }
  setRawMode(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  read(): string | null {
    return this.#chunks.shift() ?? null;
  }
  push(data: string): void {
    this.#chunks.push(data);
    this.emit("readable");
  }
}

class FakeStdout {
  columns = 100;
  rows = 40;
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

interface Harness {
  stdin: FakeStdin;
  input: InputState;
  submitted: string[];
  actions: string[];
  output: () => string;
  unmount: () => void;
}

function mount(busy = false): Harness {
  const translator = new Translator("en");
  const controller = new AppController(translator, {
    onMessage: () => {},
    scheduleRender: () => {},
  });
  const input = new InputState({ width: 98, translator });
  const submitted: string[] = [];
  const actions: string[] = [];
  const session = {
    controller,
    input,
    translator,
    header: { version: "t", providerName: "p", modelName: "m", cwd: "/w" },
    busy,
    mode: "yolo",
    toolModalOpen: false,
    esmPanelOpen: false,
    answerApproval: () => {},
    answerQuestion: () => {},
    cancelRun: () => {},
    handleEscape: () => void actions.push("escape"),
    cycleMode: () => void actions.push("cycle-mode"),
    openToolModal: () => void actions.push("tool-details"),
    openESMPanel: () => void actions.push("esm-panel"),
    toggleCompactMode: () => void actions.push("compact-toggle"),
    describeMultiAgent: () => void actions.push("multi-agent-status"),
    previewLastPastedImage: () => void actions.push("paste-image"),
  } as unknown as TUISession;

  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const instance = render(
    React.createElement(TuiShell, {
      session,
      controller,
      version: 0,
      width: 100,
      onSubmit: (t: string) => submitted.push(t),
      onExit: () => {},
    }),
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  return {
    stdin,
    input,
    submitted,
    actions,
    output: () => stdout.output,
    unmount: () => instance.unmount(),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test({
  name: "shell types, backspaces, and submits",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = mount();
    await sleep(60);
    h.stdin.push("hello");
    await sleep(20);
    assertEquals(h.input.value, "hello");
    h.stdin.push("\x7f");
    await sleep(20);
    assertEquals(h.input.value, "hell");
    h.stdin.push("\r");
    await sleep(60);
    assertEquals(h.submitted, ["hell"]);
    assertEquals(h.input.value, "");
    h.unmount();
  },
});

Deno.test({
  name: "shell routes shortcut keys",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = mount();
    await sleep(60);
    h.stdin.push("\x0f"); // ctrl+o
    h.stdin.push("\x05"); // ctrl+e
    h.stdin.push("\x07"); // ctrl+g
    await sleep(30);
    assertEquals(h.actions, ["tool-details", "esm-panel", "compact-toggle"]);
    h.stdin.push("\t"); // tab → cycle mode (empty input)
    await sleep(30);
    assert(h.actions.includes("cycle-mode"));
    h.unmount();
  },
});

Deno.test({
  name: "shell folds a bracket-pasted payload",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = mount();
    await sleep(60);
    const payload = Array.from({ length: 9 }, (_, i) => `line${i}`).join("\n");
    h.stdin.push(`\x1b[200~${payload}\x1b[201~`);
    await sleep(60);
    assertEquals(h.input.value, "[paste #1 +9 lines]");
    h.stdin.push("\r");
    await sleep(60);
    assertEquals(h.submitted, [payload]);
    h.unmount();
  },
});

Deno.test({
  name: "ESM panel is exclusive and closes while output continues",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const translator = new Translator("en");
    const controller = new AppController(translator, {
      onMessage: () => {},
      scheduleRender: () => {},
    });
    controller.handleAgentEvent({ type: EVENT_TURN_START });
    controller.handleAgentEvent({
      type: EVENT_TEXT_DELTA,
      textDelta: "LIVE-TRANSCRIPT",
    });
    const input = new InputState({ width: 98, translator });
    const state = { esmOpen: true };
    const session = {
      controller,
      input,
      translator,
      header: { version: "t", providerName: "p", modelName: "m", cwd: "/w" },
      busy: false,
      mode: "yolo",
      toolModalOpen: false,
      planModalOpen: false,
      get esmPanelOpen() {
        return state.esmOpen;
      },
      esmPanelView: () => "ESM-PANEL-CONTENT",
      closeESMPanel: () => {
        state.esmOpen = false;
      },
      answerApproval: () => {},
      answerQuestion: () => {},
      cancelRun: () => {},
    } as unknown as TUISession;

    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const instance = render(
      React.createElement(TuiShell, {
        session,
        controller,
        version: 0,
        width: 100,
        onSubmit: () => {},
        onExit: () => {},
      }),
      {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    await sleep(40);
    assert(stdout.output.includes("ESM-PANEL-CONTENT"), stdout.output);
    assert(!stdout.output.includes("LIVE-TRANSCRIPT"), stdout.output);

    const closeStart = stdout.output.length;
    stdin.push("\x05"); // ctrl+e
    await sleep(40);
    assertEquals(state.esmOpen, false);
    const closed = stdout.output.slice(closeStart);
    assert(closed.includes("LIVE-TRANSCRIPT"), closed);
    instance.unmount();
  },
});

Deno.test({
  name: "busy footer animates the rotating dots spinner",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = mount(true);
    await sleep(60);
    assert(/[⠋⠙⠹⠸⠴⠦⠧⠇⠏] working/.test(h.output()), h.output());
    h.unmount();
  },
});
