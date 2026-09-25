// TUI ESM supervisor wiring + modal/panel sizing tests.
//
// Covers the gaps reported against mothx: the TUI must start an ESM
// continuation worker (worker/critic/audit role agents) after /esm create and
// resume, and Ctrl+O / Ctrl+E layouts must adapt to the terminal size.

import { assert, assertEquals } from "@std/assert";
import { testWithIsolatedConfig as test } from "../test_helpers.ts";
import { TUISession } from "./tui_session.ts";
import { defaultSettings } from "../config/settings.ts";
import { Store as ESMStore } from "../esm/store.ts";
import { displayWidth } from "./formatters.ts";

function makeSession(): TUISession {
  const settings = defaultSettings();
  return new TUISession(
    {
      provider: settings.defaultProvider ?? "openai",
      model: settings.defaultModel ?? "",
      mode: "yolo",
      thinking: "",
      workDir: Deno.cwd(),
      version: "test",
    },
    settings,
  );
}

test(
  "esm continuation stays idle without an objective",
  () => {
    const session = makeSession();
    session.startESMContinuationIfIdle();
    assertEquals(session.esmWorkerRunning, false);
  },
);

test(
  "esm continuation with an objective stays idle while the runtime is unbuilt",
  () => {
    const session = makeSession();
    const sessionID = session.currentSessionID();
    assert(sessionID !== "", "session header must be initialized");
    const store = new ESMStore(session.manager.getSessionDir());
    store.create(sessionID, "ship the release");
    // The lazily-built runtime/manager path must degrade to idle instead of
    // throwing when start() has not run (a fresh process before Builder.build).
    session.startESMContinuationIfIdle();
    assertEquals(session.esmWorkerRunning, false);
    // Aborting while idle is a no-op.
    session.abortESMWorker();
    assertEquals(session.esmWorkerRunning, false);
    store.clear(sessionID);
  },
);

test(
  "tool modal width and height adapt to the terminal",
  () => {
    const session = makeSession();
    session.controller.addMessage("hello");
    session.setTerminalSize(70, 24);
    session.openToolModal();
    const view = session.toolModalView();
    const lines = view.split("\n");
    // deno-lint-ignore no-control-regex
    const border = lines[0].replace(/\u001B\[[0-9;]*m/g, "");
    assert(border.startsWith("╭"));
    assertEquals(displayWidth(border), 70);
    // Rows: terminal 24 minus shell chrome (8) plus the modal frame stays
    // within the terminal, so the editor below is never pushed off-screen.
    assert(
      lines.length <= 24,
      `modal rendered ${lines.length} rows for a 24-row terminal`,
    );
    // Page size shrinks with the terminal height (was hardcoded to 30 rows).
    const page = session.toolModalPageSize();
    assert(page > 0 && page < 24, `unexpected page size ${page}`);
  },
);

test(
  "esm panel width and height adapt to the terminal",
  () => {
    const session = makeSession();
    session.setTerminalSize(64, 20);
    session.openESMPanel();
    const view = session.esmPanelView();
    const lines = view.split("\n");
    // deno-lint-ignore no-control-regex
    const border = lines[0].replace(/\u001B\[[0-9;]*m/g, "");
    assert(border.startsWith("╭"));
    // esmPanelWidth subtracts 4 columns for the shell gutter.
    assertEquals(displayWidth(border), 60);
    assert(
      lines.length <= 20,
      `esm panel rendered ${lines.length} rows for a 20-row terminal`,
    );
    session.closeESMPanel();
  },
);
