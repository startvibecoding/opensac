// Ported from cmd/mothx/main.go runInteractive: the CLI root interactive
// action. Assembles the TUISession (shared runtime + controller + input state),
// renders the TuiShell, and lets the shell's raw-stdin loop drive input.
// React createElement is used because this module is plain TS (no .tsx).

import React from "react";
import { render } from "ink";
import process from "node:process";
import { atomicStdout } from "../tui/sync_output.ts";
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

/** Best-effort terminal row count for panel/modal layouts. */
function terminalHeight(): number {
  try {
    const size = Deno.consoleSize();
    if (size && size.rows >= 12) return size.rows;
  } catch {
    // Non-TTY: fall back to the default height.
  }
  return 40;
}

/** Applies one width change to the editor (Go WindowSizeMsg →
 * input.SetWidth). Returns the applied width, or null when unchanged.
 * Exported for tests. */
export function applyEditorWidth(
  editor: { setWidth(w: number): unknown },
  previous: number,
  next: number,
): number | null {
  if (next === previous) return null;
  // The editor draws its own 2-cell horizontal frame inside a rounded border.
  editor.setWidth(next - 2);
  return next;
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

  let width = terminalWidth();
  let height = terminalHeight();
  // The input state frames the editor inside a rounded border (2 columns).
  session.setEditorWidth(width);
  session.setTerminalSize(width, height);

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
          void session.handleSubmit(text);
        },
        onExit: () => {
          sessionEnded.resolve();
        },
      }),
    );
  };

  // Track terminal resize (Go tea.WindowSizeMsg → SetWidth + rerender):
  // SIGWINCH fires on every resize while a real terminal is attached.
  const onResize = () => {
    const nextWidth = terminalWidth();
    const nextHeight = terminalHeight();
    if (nextWidth === width && nextHeight === height) return;
    if (nextWidth !== width) {
      width = nextWidth;
      session.setEditorWidth(width);
    }
    height = nextHeight;
    session.setTerminalSize(width, height);
    rerender();
  };
  let removeResizeListener = () => {};
  try {
    Deno.addSignalListener("SIGWINCH", onResize);
    removeResizeListener = () =>
      Deno.removeSignalListener("SIGWINCH", onResize);
  } catch {
    // SIGWINCH unsupported (e.g. Windows): keep the startup width.
  }

  // Periodic refresh while the agent streams (the controller callbacks are
  // intentionally no-ops outside React; React batches on this timer).
  const refreshTimer = setInterval(rerender, 100);
  // Cursor blink for the editor input box.
  const blinkTimer = setInterval(() => {
    session.input.editor.blinkCursor();
  }, CURSOR_BLINK_INTERVAL_MS);

  const sessionEnded = Promise.withResolvers<void>();
  const instance = render(
    React.createElement(TuiShell, {
      session,
      controller: session.controller,
      version,
      width,
      onSubmit: (text: string) => {
        void session.handleSubmit(text);
      },
      onExit: () => {
        sessionEnded.resolve();
      },
    }),
    {
      exitOnCtrlC: false,
      patchConsole: false,
      // Every Ink write (erase + repaint of the managed region) becomes one
      // atomic frame, so a live modal cannot flicker mid-repaint.
      stdout: atomicStdout(process.stdout),
    },
  );

  await sessionEnded.promise;
  clearInterval(refreshTimer);
  clearInterval(blinkTimer);
  removeResizeListener();
  instance.unmount();

  if (session.reloadRequested) {
    await reloadProcess();
  }
}

/** Re-executes the current binary with the same arguments (/reload). */
async function reloadProcess(): Promise<void> {
  const executable = Deno.execPath();
  const command = new Deno.Command(executable, {
    args: Deno.args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await command.spawn().status;
  if (!status.success) {
    throw new Error(`reload exited with code ${status.code}`);
  }
}
