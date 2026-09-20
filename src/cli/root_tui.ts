// Ported from cmd/mothx/main.go runInteractive: the CLI root interactive
// action. Assembles the TUISession (shared runtime + controller + editor),
// renders the TuiShell, and lets the in-component useInput loop drive input.
// React createElement is used because this module is plain TS (no .tsx).

import React from "react";
import { render } from "ink";
import { TuiShell } from "../tui/tui_shell.tsx";
import { TUISession } from "../tui/tui_session.ts";
import type { Settings } from "../config/mod.ts";

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

  let version = 0;
  const rerender = () => {
    version++;
    instance.rerender(
      React.createElement(TuiShell, {
        session,
        controller: session.controller,
        version,
        width: 100,
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

  const sessionEnded = Promise.withResolvers<void>();
  const instance = render(
    React.createElement(TuiShell, {
      session,
      controller: session.controller,
      version,
      width: 100,
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
  instance.unmount();
}
