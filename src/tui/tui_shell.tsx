// Interactive shell component: the Ink useInput keyboard loop. Printable
// keys and edits go through the migrated Editor; Enter submits; approval and
// question panels answer through the controller. Lives inside the React tree
// because Ink's useInput hook requires a component context.

import React, { useEffect } from "react";
import type { ReactElement } from "react";
import { Text, useApp, useInput } from "ink";
import { App } from "./app.tsx";
import type { AppController } from "./app_controller.ts";
import type { TUISession } from "./tui_session.ts";

export interface TuiShellProps {
  session: TUISession;
  controller: AppController;
  /** Forces a rerender after store mutations from outside React. */
  version: number;
  width: number;
  onSubmit: (text: string) => void;
  onExit: () => void;
}

export function TuiShell({
  session,
  controller,
  version,
  width,
  onSubmit,
  onExit,
}: TuiShellProps): ReactElement {
  const { exit } = useApp();

  useEffect(() => {
    const onSignal = () => {
      if (session.busy) {
        session.cancelRun();
      } else {
        exit();
        onExit();
      }
    };
    Deno.addSignalListener("SIGINT", onSignal);
    return () => Deno.removeSignalListener("SIGINT", onSignal);
  }, [session, exit, onExit]);

  useInput((input, key) => {
    const controller = session.controller;

    // Approval panel: y/n
    if (controller.shownApproval) {
      if (input === "y") session.answerApproval(true);
      else if (input === "n") session.answerApproval(false);
      return;
    }
    // Question panel: numeric options
    if (controller.shownQuestion) {
      const options = controller.shownQuestion.options ?? [];
      const idx = Number.parseInt(input, 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= options.length) {
        session.answerQuestion(options[idx - 1]);
      } else if (key.return && controller.shownQuestion) {
        session.answerQuestion("");
      }
      return;
    }

    if (input === "c" && key.ctrl) {
      if (session.busy) session.cancelRun();
      else {
        exit();
        onExit();
      }
      return;
    }

    const editor = session.editor;
    if (key.return) {
      if (key.meta || key.ctrl) {
        editor.insertText("\n");
        return;
      }
      const value = editor.value.trim();
      if (value === "" || session.busy) return;
      editor.reset();
      onSubmit(value);
      return;
    }
    if (key.upArrow) {
      editor.handleKey("up");
      return;
    }
    if (key.downArrow) {
      editor.handleKey("down");
      return;
    }
    if (key.leftArrow) {
      editor.handleKey(key.meta || key.ctrl ? "ctrl+left" : "left");
      return;
    }
    if (key.rightArrow) {
      editor.handleKey(key.meta || key.ctrl ? "ctrl+right" : "right");
      return;
    }
    if (key.backspace || key.delete) {
      editor.handleKey(key.delete ? "delete" : "backspace");
      return;
    }
    if (key.tab) {
      editor.handleKey("tab");
      return;
    }
    if (key.ctrl) {
      const map: Record<string, string> = {
        a: "ctrl+a",
        e: "ctrl+e",
        j: "ctrl+j",
        k: "ctrl+k",
        u: "ctrl+u",
        w: "ctrl+w",
      };
      const mapped = map[input];
      if (mapped) editor.handleKey(mapped);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      editor.insertText(input);
    }
  });

  // Include `version` so React re-renders when the store changes externally.
  void version;
  return React.createElement(App, {
    controller,
    header: session.header,
    width,
  }) as ReactElement;
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
