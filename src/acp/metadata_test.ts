// Translated/focused tests for the ACP request-metadata projections.

import { assertEquals } from "@std/assert";
import {
  formatEditorContext,
  requestEditorContext,
  requestParentSessionID,
  requestSurface,
  requestWorkspace,
  utf8Length,
  utf8Prefix,
} from "./metadata.ts";

Deno.test("request metadata accessors prefer the mothx namespace", () => {
  const meta = {
    mothx: {
      workspace: { cwd: "/work", additionalDirectories: ["/extra"] },
      parentSessionId: "parent-1",
      surface: "desktop",
      editorContext: { path: "/work/a.ts", language: "typescript" },
    },
    "mothx.dev": {
      workspace: { cwd: "/other" },
      parentSessionId: "parent-2",
      surface: "web",
    },
  };
  assertEquals(requestWorkspace(meta)?.cwd, "/work");
  assertEquals(requestParentSessionID(meta), "parent-1");
  assertEquals(requestSurface(meta), "desktop");
  assertEquals(requestEditorContext(meta)?.language, "typescript");

  const devOnly = { "mothx.dev": { workspace: { cwd: "/dev" } } };
  assertEquals(requestWorkspace(devOnly)?.cwd, "/dev");
  assertEquals(requestParentSessionID(devOnly), "");
  assertEquals(requestSurface(undefined), "");
});

Deno.test("formatEditorContext labels untrusted metadata and bounds the selection", () => {
  assertEquals(formatEditorContext(undefined), "");
  const small = formatEditorContext({
    path: "/work/a.ts",
    language: "typescript",
    selection: { startLine: 1, endLine: 2, text: "const x = 1;" },
    diagnostics: [{
      severity: "error",
      line: 3,
      message: "unused",
    }],
  });
  assertEquals(small.includes("## Editor context (untrusted metadata)"), true);
  assertEquals(small.includes("Path: /work/a.ts"), true);
  assertEquals(small.includes("Selection (lines 1-2):\nconst x = 1;"), true);
  assertEquals(small.includes("Diagnostic (error, lines 3-3): unused"), true);

  const long = formatEditorContext({
    selection: { startLine: 0, endLine: 0, text: "a".repeat(80001) },
  });
  assertEquals(long.includes("[selection truncated]"), true);
});

Deno.test("utf8 helpers operate on byte length", () => {
  assertEquals(utf8Length("本"), 3);
  assertEquals(utf8Prefix("a本b", 4), "a本");
  // A split multi-byte sequence degrades to the replacement character.
  assertEquals(utf8Prefix("本", 1), "\uFFFD");
  assertEquals(utf8Prefix("abc", 0), "");
});
