// Focused tests for the two remaining TUI follow-ups that are unit-testable:
// the settings-driven translator (Go NewApp's ParseConfigured + warn +
// Resolve over settings.TUILang) and the editor width tracking applied on
// terminal resize (Go tea.WindowSizeMsg → input.SetWidth).

import { assertEquals } from "@opensac/assert";
import { localTimeZone, resolveLanguage } from "./i18n.ts";
import { tuiTranslatorFromSettings } from "./tui_session.ts";
import { applyEditorWidth } from "../cli/root_tui.ts";
import type { Settings } from "../config/mod.ts";

function settingsWith(tuilang?: string): Settings {
  return { tuilang } as Settings;
}

function captureConsoleError(): { errors: string[]; restore(): void } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (msg?: unknown) => {
    errors.push(String(msg));
  };
  return {
    errors,
    restore() {
      console.error = original;
    },
  };
}

Deno.test("tuiTranslatorFromSettings honors an explicit tuilang", () => {
  const capture = captureConsoleError();
  try {
    assertEquals(tuiTranslatorFromSettings(settingsWith("zh")).language, "zh");
    assertEquals(tuiTranslatorFromSettings(settingsWith("EN")).language, "en");
    // Valid values never warn.
    assertEquals(capture.errors, []);
  } finally {
    capture.restore();
  }
});

Deno.test("tuiTranslatorFromSettings falls back to auto with a warning on invalid values", () => {
  const capture = captureConsoleError();
  try {
    const translator = tuiTranslatorFromSettings(settingsWith("fr"));
    const expected = resolveLanguage("auto", new Date(), localTimeZone());
    assertEquals(translator.language, expected);
    assertEquals(
      capture.errors,
      [`Warning: invalid tuilang "fr"; using auto`],
    );
  } finally {
    capture.restore();
  }
});

Deno.test("tuiTranslatorFromSettings treats a missing tuilang as auto without warning", () => {
  const capture = captureConsoleError();
  try {
    const translator = tuiTranslatorFromSettings(settingsWith(undefined));
    const expected = resolveLanguage("auto", new Date(), localTimeZone());
    assertEquals(translator.language, expected);
    assertEquals(capture.errors, []);
  } finally {
    capture.restore();
  }
});

Deno.test("localTimeZone resolves the host IANA zone or null", () => {
  const zone = localTimeZone();
  assertEquals(zone === null || zone.length > 0, true);
});

Deno.test("applyEditorWidth tracks terminal resize with the frame offset", () => {
  const widths: number[] = [];
  const editor = {
    setWidth(w: number) {
      widths.push(w);
    },
  };
  assertEquals(applyEditorWidth(editor, 100, 120), 120);
  assertEquals(widths, [118]); // 2-cell frame inside the rounded border
  // Unchanged width is a no-op.
  assertEquals(applyEditorWidth(editor, 120, 120), null);
  assertEquals(widths, [118]);
});
