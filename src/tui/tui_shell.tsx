// Interactive TUI shell: renders the transcript/editor/panels and translates
// raw terminal input into editor edits and app actions.
//
// The shell is a projection: it owns no session, agent, tool, or persistence
// state. Keyboard handling goes through `splitInputChunk` (ours, so Backspace
// and Delete stay distinct — Ink's `useInput` collapses both onto the DEL
// byte) and forwards key events to {@link InputState}; results are dispatched
// to the session.

import React, { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Box, Text, useApp, useStdin } from "ink";
import { App } from "./app.tsx";
import type { AppController } from "./app_controller.ts";
import type { TUISession } from "./tui_session.ts";
import type { InputState } from "./input_state.ts";
import { coalesceSplitPaste, type KeyEvent, splitInputChunk } from "./keys.ts";

export interface TuiShellProps {
  session: TUISession;
  controller: AppController;
  /** Forces a rerender after store mutations from outside React. */
  version: number;
  width: number;
  onSubmit: (text: string) => void;
  onExit: () => void;
}

/** Events are held this long to coalesce a terminal-split paste. */
const SPLIT_PASTE_IDLE_MS = 16;

export function TuiShell({
  session,
  controller,
  version,
  width,
  onSubmit,
  onExit,
}: TuiShellProps): ReactElement {
  const { exit } = useApp();
  const { setRawMode, internal_eventEmitter } = useStdin();
  const input: InputState = session.input;
  const [, forceRender] = useState(0);

  const queueRef = useRef<KeyEvent[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlersRef = useRef({ session, controller, exit, onExit, onSubmit });

  handlersRef.current = { session, controller, exit, onExit, onSubmit };

  useEffect(() => {
    const onSignal = () => {
      const current = handlersRef.current;
      if (current.session.busy) {
        current.session.cancelRun();
      } else {
        current.exit();
        current.onExit();
      }
    };
    Deno.addSignalListener("SIGINT", onSignal);
    return () => Deno.removeSignalListener("SIGINT", onSignal);
  }, []);

  useEffect(() => {
    setRawMode(true);
    return () => setRawMode(false);
  }, [setRawMode]);

  useEffect(() => {
    const cancelTimer = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    const flush = () => {
      cancelTimer();
      const events = queueRef.current;
      queueRef.current = [];
      if (events.length === 0) return;
      const current = handlersRef.current;
      const coalesced = coalesceSplitPaste(events);
      if (coalesced !== null) {
        current.session.input.insertPaste(coalesced);
        forceRender((n) => n + 1);
        return;
      }
      for (const ev of events) {
        processEvent(ev, current.session, current.controller, current);
      }
      forceRender((n) => n + 1);
    };
    const schedule = () => {
      cancelTimer();
      timerRef.current = setTimeout(flush, SPLIT_PASTE_IDLE_MS);
    };
    const onInput = (chunk: string) => {
      const events = splitInputChunk(chunk);
      if (events.length === 0) return;
      // Plain keystrokes and short text apply immediately; only a chunk that
      // could be part of a terminal-split paste (a newline, a bare Enter, or
      // text while events are already pending) waits for the idle window.
      const couldBePaste = queueRef.current.length > 0 ||
        events.some((ev) =>
          (ev.type === "text" && (ev.paste || ev.text.includes("\n"))) ||
          (ev.type === "key" && (ev.name === "enter" || ev.name === "newline"))
        );
      if (!couldBePaste) {
        for (const ev of events) {
          processEvent(
            ev,
            handlersRef.current.session,
            handlersRef.current.controller,
            handlersRef.current,
          );
        }
        forceRender((n) => n + 1);
        return;
      }
      queueRef.current.push(...events);
      schedule();
    };
    internal_eventEmitter.on("input", onInput);
    return () => {
      internal_eventEmitter.off("input", onInput);
      cancelTimer();
    };
  }, [internal_eventEmitter]);

  // Include `version` so React re-renders when the store changes externally.
  void version;

  return (
    <Box flexDirection="column">
      {React.createElement(App, {
        controller,
        header: session.header,
        width,
      }) as ReactElement}
      {session.toolModalOpen && (
        <Box flexDirection="column">
          <Text>{session.toolModalView()}</Text>
        </Box>
      )}
      {session.esmPanelOpen && (
        <Box flexDirection="column">
          <Text>{session.esmPanelView()}</Text>
        </Box>
      )}
      {session.dialogOpen && (
        <Box flexDirection="column">
          <Text>{session.dialogView(width)}</Text>
        </Box>
      )}
      {!session.dialogOpen && (
        <Box borderStyle="round" flexDirection="column">
          <Text>{input.editor.view()}</Text>
        </Box>
      )}
      {!session.dialogOpen && input.suggest.visible && (
        <Text>{input.suggest.view()}</Text>
      )}
      <Text dimColor>
        {session.busy
          ? session.translator.text("shell.busy")
          : session.translator.text("shell.hint")}
      </Text>
      <Text dimColor>
        {`${session.header.providerName}/${session.header.modelName} · mode: ${session.mode}`}
      </Text>
    </Box>
  );
}

interface ShellHandlers {
  session: TUISession;
  controller: AppController;
  exit: () => void;
  onExit: () => void;
  onSubmit: (text: string) => void;
}

/** Applies one parsed key event to the session. */
function processEvent(
  ev: KeyEvent,
  session: TUISession,
  controller: AppController,
  h: ShellHandlers,
): void {
  // An open dialog owns the keyboard first.
  if (session.dialogOpen) {
    session.handleDialogKey(ev);
    return;
  }
  // Approval panel: y/n plus Enter/Escape.
  if (controller.shownApproval) {
    if (ev.type === "text") {
      const t = ev.text.trim().toLowerCase();
      if (t === "y" || t === "1") session.answerApproval(true);
      else if (t === "n" || t === "0") session.answerApproval(false);
    } else if (ev.name === "enter") {
      session.answerApproval(true);
    } else if (ev.name === "escape") {
      session.cancelRun();
    }
    return;
  }
  // Question panel: numbered options or free text.
  if (controller.shownQuestion) {
    const options = controller.shownQuestion.options ?? [];
    if (ev.type === "text") {
      const idx = Number.parseInt(ev.text.trim(), 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= options.length) {
        session.answerQuestion(options[idx - 1]);
      } else {
        session.answerQuestion(ev.text);
      }
    } else if (ev.name === "enter") {
      session.answerQuestion("");
    } else if (ev.name === "escape") {
      session.cancelRun();
    }
    return;
  }
  // Modal overlays consume their navigation keys first.
  if (session.toolModalOpen && handleToolModalKey(ev, session)) return;
  if (session.esmPanelOpen && handleESMPanelKey(ev, session)) return;

  if (ev.type === "text") {
    if (ev.paste) session.input.insertPaste(ev.text);
    else session.input.insertText(ev.text);
    return;
  }

  const action = session.input.handleKey(ev.name, ev.alt);
  switch (action.kind) {
    case "submit": {
      const value = session.input.takeSubmission();
      if (value === null || session.busy) return;
      h.onSubmit(value);
      return;
    }
    case "escape":
      session.handleEscape();
      return;
    case "cancel-or-exit":
      if (session.busy) session.cancelRun();
      else {
        h.exit();
        h.onExit();
      }
      return;
    case "cycle-mode":
      session.cycleMode();
      return;
    case "tool-details":
      session.openToolModal();
      return;
    case "esm-panel":
      session.openESMPanel();
      return;
    case "compact-toggle":
      session.toggleCompactMode();
      return;
    case "multi-agent-status":
      session.describeMultiAgent();
      return;
    case "paste-image":
      session.previewLastPastedImage();
      return;
    default:
      return;
  }
}

function handleToolModalKey(ev: KeyEvent, session: TUISession): boolean {
  if (ev.type === "text") {
    if (ev.text.trim() === "q") {
      session.closeToolModal();
      return true;
    }
    return false;
  }
  switch (ev.name) {
    case "escape":
    case "ctrl+o":
      session.closeToolModal();
      return true;
    case "up":
      session.scrollToolModal(-1);
      return true;
    case "down":
      session.scrollToolModal(1);
      return true;
    case "left":
      session.switchToolModalTarget(-1);
      return true;
    case "right":
      session.switchToolModalTarget(1);
      return true;
    case "pageup":
      session.scrollToolModal(-session.toolModalPageSize());
      return true;
    case "pagedown":
      session.scrollToolModal(session.toolModalPageSize());
      return true;
    default:
      return false;
  }
}

function handleESMPanelKey(ev: KeyEvent, session: TUISession): boolean {
  if (ev.type === "text") return false;
  switch (ev.name) {
    case "escape":
    case "ctrl+e":
      session.closeESMPanel();
      return true;
    case "up":
      session.scrollESMPanel(-1);
      return true;
    case "down":
      session.scrollESMPanel(1);
      return true;
    case "pageup":
      session.scrollESMPanel(-10);
      return true;
    case "pagedown":
      session.scrollESMPanel(10);
      return true;
    default:
      return false;
  }
}

/** Footer line for the editor input area. */
export function inputFooter(busy: boolean, value: string): ReactElement {
  return (
    <Text dimColor>
      {busy
        ? "working… (ctrl+c to cancel)"
        : `${value.length} chars — enter to send`}
    </Text>
  );
}

/** Re-exported for tests that drive the shell without a TTY. */
export { splitInputChunk };
