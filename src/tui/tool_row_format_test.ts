// Focused tests for tool_row_format.ts: verifies the Ink tool rows match the
// Go TUI's renderToolResult behavior per tool type/status/compact mode.

import { assert, assertEquals } from "@std/assert";
import { Translator } from "./i18n.ts";
import {
  formatToolRow,
  toolHeader,
  type ToolRowInput,
  toolSectionValue,
} from "./tool_row_format.ts";

const tr = new Translator("en");

function input(partial: Partial<ToolRowInput>): ToolRowInput {
  return {
    toolName: "read",
    toolArgs: {},
    status: "completed",
    summary: "",
    fullContent: "",
    toolError: "",
    executionState: "",
    ...partial,
  };
}

Deno.test("header includes the path argument", () => {
  assertEquals(
    toolHeader(input({ toolName: "read", toolArgs: { path: "src/a.ts" } })),
    "[read] src/a.ts",
  );
  assertEquals(toolHeader(input({ toolName: "bash" })), "[bash]");
});

Deno.test("bash running shows the command and running state", () => {
  const row = formatToolRow(
    tr,
    input({
      toolName: "bash",
      status: "running",
      toolArgs: { command: "npm run build" },
    }),
    false,
  );
  assert(row.includes("[bash] npm run build (running)"), row);
});

Deno.test("bash multiline command is flattened with semicolons", () => {
  const row = formatToolRow(
    tr,
    input({
      toolName: "bash",
      status: "completed",
      toolArgs: { command: "a\nb" },
      fullContent: "[exit_code]\n0",
    }),
    false,
  );
  assert(row.includes("a; b"), row);
  assert(row.includes("(succeeded)"), row);
});

Deno.test("bash failed exit code is reflected", () => {
  const row = formatToolRow(
    tr,
    input({
      toolName: "bash",
      toolArgs: { command: "false" },
      fullContent: "[exit_code]\n2",
    }),
    false,
  );
  assert(row.includes("(exit 2)"), row);
});

Deno.test("grep running shows the pattern", () => {
  const row = formatToolRow(
    tr,
    input({
      toolName: "grep",
      status: "running",
      toolArgs: { path: "src", pattern: "TODO" },
    }),
    false,
  );
  assert(row.includes("[grep] src"), row);
  assert(row.includes("TODO"), row);
});

Deno.test("edit shows path and diff stat", () => {
  const row = formatToolRow(
    tr,
    input({
      toolName: "edit",
      toolArgs: { path: "src/a.ts" },
      diff: {
        path: "src/a.ts",
        added: 3,
        deleted: 1,
        addedLines: [],
        deletedLines: [],
        unified: "",
        oldText: "",
        newText: "",
        truncated: false,
      },
    }),
    false,
  );
  assert(row.includes("Edited src/a.ts (+3 -1)"), row);
});

Deno.test("unified diff excerpt carries line numbers", () => {
  const row = formatToolRow(
    tr,
    input({
      toolName: "edit",
      toolArgs: { path: "f.ts" },
      diff: {
        path: "f.ts",
        added: 1,
        deleted: 0,
        addedLines: [],
        deletedLines: [],
        unified: "@@ -1 +1 @@\n-keep\n+done",
        oldText: "keep",
        newText: "done",
        truncated: false,
      },
    }),
    false,
  );
  assert(row.includes("1   -keep"), row);
  assert(row.includes("1   +done"), row);
});

Deno.test("interrupted non-bash row shows canceled state", () => {
  const row = formatToolRow(
    tr,
    input({
      toolName: "write",
      status: "interrupted",
      toolArgs: { path: "x" },
    }),
    false,
  );
  assertEquals(row, "[write] x canceled");
});

Deno.test("compact mode forces a single-line summary", () => {
  const row = formatToolRow(
    tr,
    input({
      toolName: "read",
      toolArgs: { path: "x" },
      summary: "line1\nline2",
    }),
    true,
  );
  assertEquals(row, "[read] x line1");
});

Deno.test("toolSectionValue reads the line after a marker", () => {
  assertEquals(toolSectionValue("a\n[exit_code]\n7\nb", "[exit_code]"), "7");
  assertEquals(toolSectionValue("nothing", "[exit_code]"), "");
});

Deno.test("empty summary falls back to ellipsis", () => {
  const row = formatToolRow(tr, input({ toolName: "ls" }), false);
  assertEquals(row, "[ls] ...");
});
