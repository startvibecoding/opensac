// Ported from cmd/mothx/main.go runInteractive: the CLI root interactive
// action. Assembles the TUISession (shared runtime + controller + editor),
// renders the TuiShell, and lets the in-component useInput loop drive input.
// React createElement is used because this module is plain TS (no .tsx).

import React from "react";
import { render } from "ink";
import { TuiShell } from "../tui/tui_shell.tsx";
import { TUISession } from "../tui/tui_session.ts";
import type { Settings } from "../config/mod.ts";
import { CURSOR_BLINK_INTERVAL_MS } from "../tui/components/editor/editor.ts";

export interface TUIOptions {
  provider: string;
  model: string;
  mode: string;
  thinking: string;
  workDir: string;
  multiAgent?: boolean;
  delegate?: boolean;
  workflows?: boolean;
}

/** Best-effort terminal column count for layout. */
function terminalWidth(): number {
  try {
    const size = Deno.consoleSize();
    if (size && size.columns >= 20) return size.columns;
  } catch {
    // Non-TTY: fall back to the default width.
  }
  return 100;
}

/** Runs the interactive TUI until the user exits (Go runInteractive). */
export async function runInteractiveAction(
  options: TUIOptions,
  settings: Settings,
): Promise<void> {
  const workDir = options.workDir !== "" ? options.workDir : Deno.cwd();
  const session = new TUISession(
    { ...options, workDir, version: "dev" },
    settings,
  );
  await session.start();

  const width = terminalWidth();
  // The editor draws its own 2-cell horizontal frame inside a rounded border.
  session.editor.setWidth(width - 2);

  let version = 0;
  const rerender = () => {
    version++;
    instance.rerender(
      React.createElement(TuiShell, {
        session,
        controller: session.controller,
        version,
        width,
        onSubmit: (text: string) => {
          void session.submitPrompt(text);
        },
        onExit: () => {
          sessionEnded.resolve();
        },
      }),
    );
  };

  // Periodic refresh while the agent streams (the controller callbacks are
  // intentionally no-ops outside React; React batches on this timer).
  const refreshTimer = setInterval(rerender, 100);
  // Cursor blink for the editor input box.
  const blinkTimer = setInterval(() => {
    session.editor.blinkCursor();
  }, CURSOR_BLINK_INTERVAL_MS);

  const sessionEnded = Promise.withResolvers<void>();
  const instance = render(
    React.createElement(TuiShell, {
      session,
      controller: session.controller,
      version,
      width,
      onSubmit: (text: string) => {
        void session.submitPrompt(text);
      },
      onExit: () => {
        sessionEnded.resolve();
      },
    }),
    { exitOnCtrlC: false, patchConsole: false },
  );

  await sessionEnded.promise;
  clearInterval(refreshTimer);
  clearInterval(blinkTimer);
  instance.unmount();
}
