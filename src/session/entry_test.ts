// Tests for src/session/entry.ts (GenerateID has no Go test file; this pins the
// documented 16-character hex contract and uniqueness).

import { assert, assertEquals } from "../compat/assert.ts";
import { generateID } from "./entry.ts";
import { test } from "#testing";

test("generateID returns 16 lowercase hex chars and is unique", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const id = generateID();
    assertEquals(id.length, 16);
    assert(/^[0-9a-f]{16}$/.test(id), `unexpected id ${id}`);
    seen.add(id);
  }
  assertEquals(seen.size, 1000);
});
