// Focused tests for internal/agentruntime/session_directories.go.

import { assert, assertEquals, assertThrows } from "@opensac/assert";
import { normalizeAdditionalDirectories } from "./session_directories.ts";

Deno.test("NormalizeAdditionalDirectories cleans, dedupes, and sorts", () => {
  assertEquals(
    normalizeAdditionalDirectories(["/b/./x", "/a", "/b/y"]),
    ["/a", "/b/x", "/b/y"],
  );
  assertEquals(
    normalizeAdditionalDirectories(["/a", "/a/", "/a"]),
    ["/a"],
  );
  assertEquals(normalizeAdditionalDirectories([]), []);
});

Deno.test("NormalizeAdditionalDirectories rejects empty and relative paths", () => {
  assertThrows(() => normalizeAdditionalDirectories(["relative/path"]), Error);
  assertThrows(() => normalizeAdditionalDirectories(["  "]), Error);
  assert(true);
});
