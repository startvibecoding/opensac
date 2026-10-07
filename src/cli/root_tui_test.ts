import { assertEquals, assertRejects } from "@std/assert";
import { defaultSettings } from "../config/settings.ts";
import {
  blinkEditorCursor,
  refreshWhenBusy,
  runInteractiveAction,
  tuiResumeOptions,
} from "./root_tui.ts";

Deno.test("interactive refresh skips idle redraws", () => {
  let rerenders = 0;
  const rerender = () => rerenders++;

  refreshWhenBusy(false, rerender);
  assertEquals(rerenders, 0);

  refreshWhenBusy(true, rerender);
  assertEquals(rerenders, 1);
});

Deno.test("cursor blink toggles the editor and repaints each frame", () => {
  // The original defect: the blink timer toggled `cursorOn` but never
  // repainted, so an idle editor showed a frozen (non-blinking) cursor.
  let toggles = 0;
  let rerenders = 0;
  const editor = { blinkCursor: () => toggles++ };

  blinkEditorCursor(editor, () => rerenders++);
  blinkEditorCursor(editor, () => rerenders++);

  assertEquals(toggles, 2);
  assertEquals(rerenders, 2);
});

Deno.test("runInteractiveAction requires a terminal instead of crashing Ink", async () => {
  await assertRejects(
    () =>
      runInteractiveAction(
        {
          provider: "",
          model: "",
          mode: "",
          thinking: "",
          workDir: Deno.cwd(),
        },
        defaultSettings(),
        { isTerminal: () => false },
      ),
    Error,
    "interactive mode requires a terminal",
  );
});

Deno.test("tuiResumeOptions maps the session flags the TUI resumes from", () => {
  // The original defect: `-c` was parsed and never reached the TUI, so every
  // launch opened a new empty session.
  assertEquals(
    tuiResumeOptions({ continueSession: true, resume: "", session: "" }),
    { continueLast: true, resumeSession: "" },
  );
  // An explicit target wins, and `-c` must not also claim "most recent".
  assertEquals(
    tuiResumeOptions({
      continueSession: true,
      resume: "session-9",
      session: "",
    }),
    { continueLast: false, resumeSession: "session-9" },
  );
  assertEquals(
    tuiResumeOptions({ continueSession: false, resume: "", session: "s-7" }),
    { continueLast: false, resumeSession: "s-7" },
  );
  // Whitespace-only values are "not provided", not an empty resume target.
  assertEquals(
    tuiResumeOptions({ continueSession: false, resume: "  ", session: "" }),
    { continueLast: false, resumeSession: "" },
  );
  // No flags at all keeps the default fresh-session behaviour.
  assertEquals(
    tuiResumeOptions({}),
    { continueLast: false, resumeSession: "" },
  );
});
