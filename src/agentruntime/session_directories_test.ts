// Focused tests for internal/agentruntime/session_directories.go.

import { assert, assertEquals, assertThrows } from "../compat/assert.ts";
import { normalizeAdditionalDirectories } from "./session_directories.ts";
import { test } from "#testing";

test("NormalizeAdditionalDirectories cleans, dedupes, and sorts", () => {
  assertEquals(normalizeAdditionalDirectories(["/b/./x", "/a", "/b/y"]), [
    "/a",
    "/b/x",
    "/b/y",
  ]);
  assertEquals(normalizeAdditionalDirectories(["/a", "/a/", "/a"]), ["/a"]);
  assertEquals(normalizeAdditionalDirectories([]), []);
});

test("NormalizeAdditionalDirectories rejects empty and relative paths", () => {
  assertThrows(() => normalizeAdditionalDirectories(["relative/path"]), Error);
  assertThrows(() => normalizeAdditionalDirectories(["  "]), Error);
  assert(true);
});
