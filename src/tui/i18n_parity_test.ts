// Bilingual catalog parity guard.
//
// AGENTS.md requires every TUI message ID to exist in both `catalogs.en` and
// `catalogs.zh`. The fallback chain (zh → en → raw ID) makes a missing key
// silent: the string still renders, in the wrong language, so nothing fails at
// runtime or at type-check time. This test is the only thing that turns that
// convention into an enforced check.

import { assert, assertEquals } from "@opensac/assert";
import { catalogs } from "./i18n.ts";

Deno.test("the TUI catalogs define exactly the same message IDs", () => {
  const en = Object.keys(catalogs.en).sort();
  const zh = Object.keys(catalogs.zh).sort();
  const onlyEn = en.filter((id) => !(id in catalogs.zh));
  const onlyZh = zh.filter((id) => !(id in catalogs.en));
  assertEquals(
    onlyEn,
    [],
    `message IDs missing from catalogs.zh: ${onlyEn.join(", ")}`,
  );
  assertEquals(
    onlyZh,
    [],
    `message IDs missing from catalogs.en: ${onlyZh.join(", ")}`,
  );
  assert(en.length > 0, "the catalogs must not be empty");
});

Deno.test("no catalog entry is an empty or whitespace-only string", () => {
  // An empty translation renders as a blank row rather than falling back, so it
  // is a defect of the same kind as a missing key.
  for (const language of ["en", "zh"] as const) {
    for (const [id, text] of Object.entries(catalogs[language])) {
      assert(text.trim() !== "", `${language} catalog entry is empty: ${id}`);
    }
  }
});
