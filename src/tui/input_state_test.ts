// Focused tests for the TUI input state: backspace/delete, history, suggestions,
// paste folding on submit, and the shortcut action map.

import { assertEquals } from "@std/assert";
import { InputState } from "./input_state.ts";
import { Translator } from "./i18n.ts";

function state(): InputState {
  return new InputState({ width: 80, translator: new Translator("en") });
}

Deno.test("ctrl+t requests the plan modal", () => {
  const s = state();
  assertEquals(s.handleKey("ctrl+t").kind, "plan-details");
});

Deno.test("backspace removes the character before the cursor", () => {
  const s = state();
  s.insertText("abc");
  s.handleKey("backspace");
  assertEquals(s.value, "ab");
});

Deno.test("delete removes the character under the cursor", () => {
  const s = state();
  s.insertText("abc");
  s.handleKey("left");
  s.handleKey("delete");
  assertEquals(s.value, "ab");
});

Deno.test("enter submits and resets, expanding folded pastes", () => {
  const s = state();
  s.insertText("hello");
  assertEquals(s.handleKey("enter").kind, "submit");
  const value = s.takeSubmission();
  assertEquals(value, "hello");
  assertEquals(s.value, "");
});

Deno.test("large paste folds to a marker and expands on submit", () => {
  const s = state();
  const payload = Array.from({ length: 9 }, (_, i) => `row${i}`).join("\n");
  s.insertPaste(payload);
  assertEquals(s.value, "[paste #1 +9 lines]");
  const value = s.takeSubmission();
  assertEquals(value, payload);
});

Deno.test("history navigation recalls and restores the draft", () => {
  const s = state();
  s.insertText("first");
  s.takeSubmission();
  s.insertText("second");
  s.takeSubmission();
  s.insertText("draft");
  s.handleKey("up");
  assertEquals(s.value, "second");
  s.handleKey("up");
  assertEquals(s.value, "first");
  s.handleKey("down");
  assertEquals(s.value, "second");
  s.handleKey("down");
  assertEquals(s.value, "draft");
});

Deno.test("slash command suggestions filter and accept", () => {
  const s = state();
  s.insertText("/mo");
  assertEquals(s.suggestionsVisible, true);
  assertEquals(s.suggest.selected?.label, "/mode");
  s.handleKey("tab");
  assertEquals(s.value, "/mode ");
});

Deno.test("shortcut keys map to shell actions", () => {
  const s = state();
  s.insertText("x");
  assertEquals(s.handleKey("ctrl+o").kind, "tool-details");
  assertEquals(s.handleKey("ctrl+e").kind, "esm-panel");
  assertEquals(s.handleKey("ctrl+g").kind, "compact-toggle");
  assertEquals(s.handleKey("ctrl+p").kind, "multi-agent-status");
  assertEquals(s.handleKey("ctrl+r").kind, "paste-image");
  assertEquals(s.handleKey("escape").kind, "escape");
  assertEquals(s.handleKey("ctrl+c").kind, "cancel-or-exit");
  assertEquals(s.handleKey("pageup").kind, "page-up");
  assertEquals(s.handleKey("pagedown").kind, "page-down");
});

Deno.test("tab cycles mode only outside slash commands", () => {
  const s = state();
  assertEquals(s.handleKey("tab").kind, "cycle-mode");
  s.insertText("/mode");
  assertEquals(s.handleKey("tab").kind, "none");
});
