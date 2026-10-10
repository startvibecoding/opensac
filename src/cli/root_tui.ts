// the CLI root interactive
// action. Assembles the TUISession (shared runtime + controller + input state),
// renders the TuiShell, and lets the shell's raw-stdin loop drive input.
// The TUI is a client of the single shared `opensac core`: this wiring builds
// the Core Client-backed TUIService exactly like `opensac acp` and never
// constructs Runtime implementations itself.
// React createElement is used because this module is plain TS (no .tsx).

import { runtime as nodeRuntime } from "../platform/runtime.ts";
import React from "react";
import { render } from "ink";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { atomicStdout } from "../tui/sync_output.ts";
import { TuiShell } from "../tui/tui_shell.tsx";
import { TUISession } from "../tui/tui_session.ts";
import { createCoreClientTUIService } from "../tui/core_service.ts";
import { type Settings } from "../config/mod.ts";
import { configDir } from "../config/mod.ts";
import { CoreClient } from "../core/client.ts";
import { resolveCoreConfig } from "../core/config.ts";
import { CORE_PROTOCOL_VERSION } from "../core/server.ts";
import { current as appVersionCurrent } from "../version/version.ts";
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
  /** `-c`: continue the most recent persisted session of this directory. */
  continueSession?: boolean;
  /** `-r`: resume one session by id or path. */
  resume?: string;
  /** `--session`: use one specific session file or id. */
  session?: string;
}

/**
 * Maps the root command's session flags onto the Runtime resume options.
 *
 * Exported because "parsed then dropped" is exactly how `-c` used to fail: the
 * flags existed, nothing consumed them. One named mapping keeps the seam
 * testable without booting a terminal, and keeps the precedence rule in one
 * place instead of inlined at the call site.
 */
export function tuiResumeOptions(flags: {
  continueSession?: boolean;
  resume?: string;
  session?: string;
}): { continueLast: boolean; resumeSession: string } {
  // An explicit target wins over "the most recent one"; `-r` wins over
  // `--session` because it names the session rather than a file to use.
  const target =
    (flags.resume ?? "").trim() !== ""
      ? (flags.resume ?? "").trim()
      : (flags.session ?? "").trim();
  return {
    continueLast: target === "" && flags.continueSession === true,
    resumeSession: target,
  };
}

/** Best-effort terminal column count for layout. */
function terminalWidth(): number {
  try {
    const size = nodeRuntime.consoleSize();
    if (size && size.columns >= 20) return size.columns;
  } catch {
    // Non-TTY: fall back to the default width.
  }
  return 100;
}

/** Best-effort terminal row count for panel/modal layouts. */
function terminalHeight(): number {
  try {
    const size = nodeRuntime.consoleSize();
    if (size && size.rows >= 12) return size.rows;
  } catch {
    // Non-TTY: fall back to the default height.
  }
  return 40;
}

/** Redraws the interactive frame only while a run is producing updates. */
export function refreshWhenBusy(busy: boolean, rerender: () => void): void {
  if (busy) rerender();
}

/**
 * Advances one editor-caret frame and returns whether the caret is now in the
 * blinking state.
 *
 * The caret blinks only while a run streams: the 100ms busy refresh timer
 * already repaints the managed region during a run, so toggling `cursorOn` is
 * enough to reveal the blink without scheduling a separate repaint. While idle
 * the caret stays solid and nothing is repainted — forcing a periodic full
 * repaint to animate an idle caret erased and redrew the whole managed block,
 * which flashed on terminals without DEC 2026 synchronized output (the product
 * does not need a cursor that blinks all the time). The single repaint on the
 * busy→idle edge only restores a solid caret so it never stays hidden; after
 * that the idle editor emits no repaint at all. Exported for tests.
 */
export function advanceEditorCaret(
  editor: { blinkCursor(): void; showCursor(): void },
  busy: boolean,
  wasBlinking: boolean,
  repaint: () => void,
): boolean {
  if (busy) {
    editor.blinkCursor();
    return true;
  }
  if (wasBlinking) {
    editor.showCursor();
    repaint();
  }
  return false;
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
  deps: { isTerminal?: () => boolean } = {},
): Promise<void> {
  const isTerminal = deps.isTerminal ?? (() => nodeRuntime.stdin.isTerminal());
  if (!isTerminal()) {
    // Ink's reconciler crashes on non-TTY stdin; fail before it starts so a
    // piped/CI invocation gets one actionable message instead of a stack.
    throw new Error(
      "interactive mode requires a terminal (TTY); use -P for non-interactive runs",
    );
  }
  const workDir = options.workDir !== "" ? options.workDir : nodeRuntime.cwd();
  // The TUI is a thin client of the shared Core: discover or auto-start it
  // exactly like `opensac acp` and project every run through its JSON-RPC
  // protocol plus the canonical event stream.
  const core = new CoreClient({
    stateDir: configDir(),
    version: appVersionCurrent(),
    protocolVersion: CORE_PROTOCOL_VERSION,
    config: resolveCoreConfig(settings),
  });
  // A registered Core built from different code can answer nothing this client
  // asks, so it is replaced instead of blocking startup behind a manual
  // `opensac core stop`. Everything else about discovery is unchanged.
  let coreReplaced = false;
  const discovery = await core.ensureStarted(undefined, {
    replaceIncompatible: true,
    onReplacingIncompatible: () => {
      coreReplaced = true;
    },
  });
  if (discovery.status !== "ready") {
    await core.close();
    const hint =
      discovery.status === "incompatible"
        ? '; run "opensac core stop" to replace it'
        : "";
    throw new Error(`Core is not ready: ${discovery.status}${hint}`);
  }
  const service = createCoreClientTUIService(core, { workDir });
  const session = new TUISession(
    {
      ...options,
      workDir,
      version: "dev",
      tuilang: settings.tuilang ?? "",
      // `-c` / `-r` / `--session` reach the Runtime-owned resume path through
      // the one named mapping, so no entry computes its own precedence.
      ...tuiResumeOptions(options),
    },
    service,
  );
  // The replacement already happened, so this reports it in the user's language
  // once the live view exists. It is not a transcript entry.
  if (coreReplaced) session.notifyCoreReplaced();
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
  // Asynchronous service completions (commands, dialog persistence) repaint
  // through this hook; while a run streams, the refresh timer below batches
  // repaints instead.
  session.setRenderScheduler(() => {
    if (!session.busy) rerender();
  });

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
    nodeRuntime.addSignalListener("SIGWINCH", onResize);
    removeResizeListener = () =>
      nodeRuntime.removeSignalListener("SIGWINCH", onResize);
  } catch {
    // SIGWINCH unsupported (e.g. Windows): keep the startup width.
  }

  // Periodic refresh while the agent streams (the controller callbacks are
  // intentionally no-ops outside React; React batches on this timer).
  const refreshTimer = setInterval(() => {
    refreshWhenBusy(session.busy, rerender);
  }, 100);
  // Cursor caret. It blinks only while a run streams (the 100ms refresh timer
  // above repaints and reveals the toggle); an idle caret stays solid without a
  // repaint, so it never flashes the whole managed block. `caretBlinking`
  // tracks the busy→idle edge so the caret is restored solid exactly once.
  let caretBlinking = false;
  const blinkTimer = setInterval(() => {
    caretBlinking = advanceEditorCaret(
      session.input.editor,
      session.busy,
      caretBlinking,
      rerender,
    );
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
  await session.close();
  await core.close();

  if (session.reloadRequested) {
    await reloadProcess();
  }
}

/** Re-executes the current CLI entrypoint with the same arguments (/reload). */
async function reloadProcess(): Promise<void> {
  const executable = nodeRuntime.execPath();
  const name = executable.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const isNode = name === "node" || name.startsWith("node.");
  const command = new nodeRuntime.Command(
    isNode ? process.execPath : executable,
    {
      args: isNode
        ? [
            fileURLToPath(new URL("../main.ts", import.meta.url)),
            ...nodeRuntime.args,
          ]
        : nodeRuntime.args,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const status = await command.spawn().status;
  if (!status.success) {
    throw new Error(`reload exited with code ${status.code}`);
  }
}
