// TUI ESM supervisor wiring + modal/panel sizing tests.
//
// Covers the gaps reported against mothx: the TUI consumes the Core-owned ESM
// continuation worker's canonical run events after /esm create and resume, and
// Ctrl+O / Ctrl+E layouts must adapt to the terminal size.

import { assert, assertEquals } from "../compat/assert.ts";
import { testWithIsolatedConfig as test } from "../test_helpers.ts";
import { TUISession } from "./tui_session.ts";
import { createFakeTUIService, type FakeTUIService } from "./service.ts";
import { displayWidth } from "./formatters.ts";

function makeSession(): { session: TUISession; service: FakeTUIService } {
  const service = createFakeTUIService();
  const session = new TUISession(
    {
      provider: "openai",
      model: "",
      mode: "yolo",
      thinking: "",
      workDir: Deno.cwd(),
      version: "test",
    },
    service,
  );
  return { session, service };
}

test(
  "esm continuation stays idle without an objective",
  async () => {
    const { session } = makeSession();
    await session.startESMContinuationIfIdle();
    assertEquals(session.esmWorkerRunning, false);
  },
);

test(
  "esm continuation consumes the Core worker stream and settles idle",
  async () => {
    const { session, service } = makeSession();
    await session.start();
    const sessionID = session.currentSessionID();
    assert(sessionID !== "", "Core-owned session must be bound");
    await service.esmCommand({
      sessionId: sessionID,
      action: "create",
      objective: "ship the release",
    });
    await session.startESMContinuationIfIdle();
    assertEquals(session.esmWorkerRunning, true);
    // The Core-owned worker terminalizes through canonical run events; the
    // consumer releases once the stream ends.
    service.emit(sessionID, "esm-continuation", "esm_status", {
      text: "worker started",
    });
    service.emit(
      sessionID,
      "esm-continuation",
      "esm_finished",
      { status: "completed" },
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(session.esmWorkerRunning, false);
    // Aborting while idle is a no-op.
    await session.abortESMWorker();
    assertEquals(session.esmWorkerRunning, false);
    await service.esmCommand({ sessionId: sessionID, action: "clear" });
    await session.close();
  },
);

test(
  "tool modal width and height adapt to the terminal",
  () => {
    const { session } = makeSession();
    session.controller.addMessage("hello");
    session.setTerminalSize(70, 24);
    session.openToolModal();
    const view = session.toolModalView();
    const lines = view.split("\n");
    // eslint-disable-next-line no-control-regex
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
    const { session } = makeSession();
    session.setTerminalSize(64, 20);
    session.openESMPanel();
    const view = session.esmPanelView();
    const lines = view.split("\n");
    // eslint-disable-next-line no-control-regex
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
