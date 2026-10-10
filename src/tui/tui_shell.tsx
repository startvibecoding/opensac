// Interactive TUI shell: renders the transcript/editor/panels and translates
// raw terminal input into editor edits and app actions.
//
// The shell is a projection: it owns no session, agent, tool, or persistence
// state. Keyboard handling goes through `splitInputChunk` (ours, so Backspace
// and Delete stay distinct — Ink's `useInput` collapses both onto the DEL
// byte) and forwards key events to {@link InputState}; results are dispatched
// to the session.

import { runtime } from "../platform/runtime.ts";
import React, { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Box, Text, useApp, useStdin } from "ink";
import { App } from "./app.tsx";
import type { AppController } from "./app_controller.ts";
import type { TUISession } from "./tui_session.ts";
import type { InputState } from "./input_state.ts";
import { coalesceSplitPaste, type KeyEvent, splitInputChunk } from "./keys.ts";
import { formatCachePercent, formatTokens } from "./formatters.ts";
import { SPINNER_INTERVAL_MS, spinnerFrame } from "./spinner.ts";

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
  // Rotating-dots spinner tick; only advances while a run is active.
  const [spin, setSpin] = useState(0);

  const queueRef = useRef<KeyEvent[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlersRef = useRef({ session, controller, exit, onExit, onSubmit });

  handlersRef.current = { session, controller, exit, onExit, onSubmit };

  // Advance the spinner one frame per interval while a run is active so the
  // busy footer and running tool rows animate.
  useEffect(() => {
    if (!session.busy) return;
    const id = setInterval(() => setSpin((n) => n + 1), SPINNER_INTERVAL_MS);
    return () => clearInterval(id);
  }, [session.busy]);

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
    // `runtime.addSignalListener("SIGINT")` throws on Windows, where the shim has
    // no POSIX signal delivery to hook. In raw mode Ctrl+C arrives as the bare
    // 0x03 byte on stdin instead (Ink's own exit-on-Ctrl+C watch for the same
    // byte), so parse the emitted chunks and run the same handler. Signal
    // listening stays the primary path everywhere that supports it.
    let listening = false;
    try {
      runtime.addSignalListener("SIGINT", onSignal);
      listening = true;
    } catch {
      // Signal listeners are unsupported on this host (e.g. Windows).
    }
    const decoder = new TextDecoder();
    const onInputChunk = (chunk: unknown): void => {
      const text =
        chunk instanceof Uint8Array
          ? decoder.decode(chunk)
          : String(chunk ?? "");
      if (text === "\x03") onSignal();
    };
    const emitter = internal_eventEmitter;
    if (!listening && emitter !== undefined) {
      emitter.on("input", onInputChunk);
    }
    return () => {
      if (listening) runtime.removeSignalListener("SIGINT", onSignal);
      emitter?.off("input", onInputChunk);
    };
  }, [internal_eventEmitter]);

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
      const couldBePaste =
        queueRef.current.length > 0 ||
        events.some(
          (ev) =>
            (ev.type === "text" && (ev.paste || ev.text.includes("\n"))) ||
            (ev.type === "key" &&
              (ev.name === "enter" || ev.name === "newline")),
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
  const overlayOpen =
    session.toolModalOpen ||
    session.planModalOpen ||
    session.esmPanelOpen ||
    session.skillHubPanelOpen ||
    session.skillMgrPanelOpen ||
    session.dialogOpen;

  return (
    <Box flexDirection="column">
      {
        React.createElement(App, {
          controller,
          header: session.header,
          width,
          compactMode: session.compactMode,
          overlayOpen,
        }) as ReactElement
      }
      {session.toolModalOpen && (
        <Panel text={session.toolModalView(spinnerFrame(spin))} />
      )}
      {session.planModalOpen && <Panel text={session.planModalView()} />}
      {session.esmPanelOpen && <Panel text={session.esmPanelView()} />}
      {session.skillHubPanelOpen && (
        <Panel text={session.skillHubPanelView()} />
      )}
      {session.skillMgrPanelOpen && (
        <Panel text={session.skillMgrPanelView()} />
      )}
      {session.dialogOpen && <Panel text={session.dialogView(width)} />}
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
          ? `${spinnerFrame(spin)} ${session.translator.text("shell.busy")}`
          : session.translator.text("shell.hint")}
      </Text>
      <Text dimColor>
        {`${session.header.providerName}/${session.header.modelName} · mode: ${session.mode}${statusSuffix(
          controller,
        )}`}
      </Text>
    </Box>
  );
}

/**
 * A framed panel string (tool modal, plan modal, ESM panel, dialog).
 *
 * The panels render as one pre-framed block, and every panel byte comes from
 * the session's cached content. Memoizing on the string keeps an unchanged
 * frame out of Ink's layout and output diff entirely, which matters while the
 * spinner tick re-renders the whole shell.
 */
const Panel = React.memo(function Panel({
  text,
}: {
  text: string;
}): ReactElement {
  return (
    <Box flexDirection="column">
      <Text>{text}</Text>
    </Box>
  );
});

/**
 * Footer status suffix: context usage and cache hit line (mothx builtin footer
 * right column). Empty until the first turn reports provider usage.
 */
function statusSuffix(controller: AppController): string {
  const usage = controller.contextUsage;
  if (usage === undefined) return "";
  const parts: string[] = [];
  if (usage.contextWindow > 0) {
    parts.push(
      usage.percent !== undefined
        ? `${usage.percent.toFixed(1)}%/${formatTokens(usage.contextWindow)}`
        : `?/${formatTokens(usage.contextWindow)}`,
    );
  }
  const cache = formatCachePercent({
    totalInputTokens: usage.totalTokens,
    totalCacheRead: usage.cacheRead,
    totalCacheWrite: usage.cacheWrite,
  });
  if (cache !== "") parts.push(cache);
  return parts.length > 0 ? ` · ${parts.join(" | ")}` : "";
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
  // The framed /skillhub popup owns the keyboard the same way.
  if (session.skillHubPanelOpen) {
    session.handleSkillHubKey(ev);
    return;
  }
  // The framed /skillmgr popup owns the keyboard the same way.
  if (session.skillMgrPanelOpen) {
    session.handleSkillMgrKey(ev);
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
  if (session.planModalOpen && handlePlanModalKey(ev, session)) return;
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
    case "plan-details":
      session.openPlanModal();
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

/** Keys consumed by the Ctrl+T plan modal. */
function handlePlanModalKey(ev: KeyEvent, session: TUISession): boolean {
  if (ev.type === "text") {
    if (ev.text.trim() === "q") {
      session.closePlanModal();
      return true;
    }
    return false;
  }
  switch (ev.name) {
    case "escape":
    case "ctrl+t":
      session.closePlanModal();
      return true;
    case "up":
      session.scrollPlanModal(-1);
      return true;
    case "down":
      session.scrollPlanModal(1);
      return true;
    case "pageup":
      session.scrollPlanModal(-session.planModalPageSize());
      return true;
    case "pagedown":
      session.scrollPlanModal(session.planModalPageSize());
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

/** Re-exported for tests that drive the shell without a TTY. */
export { splitInputChunk };
