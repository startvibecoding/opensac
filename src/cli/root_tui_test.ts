import { assertEquals, assertRejects } from "@std/assert";
import { defaultSettings } from "../config/settings.ts";
import {
  advanceEditorCaret,
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

Deno.test("caret blinks while a run streams without an extra repaint", () => {
  // During a busy run the 100ms refresh timer already repaints, so the caret
  // toggles for the blink but the caret step never forces its own full repaint
  // (that periodic repaint is what flashed the whole managed block).
  let toggles = 0;
  let shows = 0;
  let repaints = 0;
  const editor = {
    blinkCursor: () => toggles++,
    showCursor: () => shows++,
  };

  let blinking = advanceEditorCaret(editor, true, false, () => repaints++);
  assertEquals(toggles, 1, "busy caret toggles to animate the blink");
  assertEquals(repaints, 0, "busy repaint is owned by the refresh timer");
  assertEquals(blinking, true);

  blinking = advanceEditorCaret(editor, true, blinking, () => repaints++);
  assertEquals(toggles, 2);
  assertEquals(repaints, 0);
});

Deno.test("idle caret stays solid with no periodic repaint", () => {
  // The regression: an idle caret must never force a repaint, or the managed
  // region flashes every blink tick on terminals without synchronized output.
  let toggles = 0;
  let shows = 0;
  let repaints = 0;
  const editor = {
    blinkCursor: () => toggles++,
    showCursor: () => shows++,
  };

  // Steady idle (not just after a run): nothing toggles, nothing repaints.
  const blinking = advanceEditorCaret(editor, false, false, () => repaints++);
  assertEquals(toggles, 0);
  assertEquals(shows, 0);
  assertEquals(repaints, 0);
  assertEquals(blinking, false);
});

Deno.test("busy→idle edge restores a solid caret with one repaint", () => {
  // The last busy blink can leave the caret hidden; the transition repaints
  // once so the idle editor shows a solid caret, then stops repainting.
  let toggles = 0;
  let shows = 0;
  let repaints = 0;
  const editor = {
    blinkCursor: () => toggles++,
    showCursor: () => shows++,
  };

  const blinking = advanceEditorCaret(editor, false, true, () => repaints++);
  assertEquals(toggles, 0, "idle does not toggle the caret");
  assertEquals(shows, 1, "idle edge restores a solid caret");
  assertEquals(repaints, 1, "the edge repaints exactly once");
  assertEquals(blinking, false);

  // The next idle tick emits nothing further: no continuous blink, no flicker.
  advanceEditorCaret(editor, false, blinking, () => repaints++);
  assertEquals(repaints, 1, "steady idle stays silent");
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
