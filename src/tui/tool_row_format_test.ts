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

Deno.test("plan rows render the checklist and compact progress", () => {
  const planData = {
    title: "My plan",
    note: "",
    steps: [
      { title: "one", status: "done" },
      { title: "two", status: "running" },
    ],
  };
  const row = formatToolRow(
    tr,
    input({ toolName: "plan", plan: planData }),
    false,
  );
  assertEquals(row, "[plan] My plan\n  ✓ one\n  ▸ two");
  const compact = formatToolRow(
    tr,
    input({ toolName: "plan", plan: planData }),
    true,
  );
  assertEquals(compact, "[plan] My plan (1/2)");
});

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

Deno.test("failed non-bash rows show canonical error state", () => {
  const row = formatToolRow(
    tr,
    input({
      executionState: "failed",
      fullContent: "tool output",
    }),
    false,
  );
  assertEquals(row, "[read] error\n---\ntool output");
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

const bashResult = (
  stdout: string,
  stderr = "(no output)",
  exitCode = 0,
) =>
  [
    "[runtime]",
    "bash",
    "[command]",
    "deno task check",
    "[cwd]",
    "/w",
    "[stdout]",
    stdout,
    "[stderr]",
    stderr,
    "[exit_code]",
    String(exitCode),
  ].join("\n");

Deno.test("compact bash row excerpts stdout, never the section markers", () => {
  const full = bashResult("hello from stdout\nmore");
  const row = formatToolRow(
    tr,
    input({
      toolName: "bash",
      toolArgs: { command: "deno task check" },
      summary: full,
      fullContent: full,
    }),
    true,
  );
  assertEquals(row, "[bash] deno task check (succeeded) hello from stdout");
  assert(!row.includes("[runtime]"), row);
  assert(!row.includes("[stdout]"), row);
});

Deno.test("compact bash row falls back to stderr when stdout is empty", () => {
  const full = bashResult("(no output)", "boom: things broke", 1);
  const row = formatToolRow(
    tr,
    input({
      toolName: "bash",
      toolArgs: { command: "false" },
      summary: full,
      fullContent: full,
    }),
    true,
  );
  assertEquals(row, "[bash] false (exit 1) boom: things broke");
});

Deno.test("compact bash row omits the summary when there is no output", () => {
  const full = bashResult("(no output)");
  const row = formatToolRow(
    tr,
    input({
      toolName: "bash",
      toolArgs: { command: "true" },
      summary: full,
      fullContent: full,
    }),
    true,
  );
  assertEquals(row, "[bash] true (succeeded)");
});

Deno.test("compact bash row drops the marker text of a started job", () => {
  const started =
    "[runtime]\nbash\n[command]\nnpm run dev\nUse 'jobs' tool to check status or 'kill' to stop.";
  const row = formatToolRow(
    tr,
    input({
      toolName: "bash",
      toolArgs: { command: "npm run dev" },
      summary: started,
      fullContent: started,
    }),
    true,
  );
  assertEquals(row, "[bash] npm run dev (started)");
});

Deno.test("compact bash excerpt truncates a single long stdout line", () => {
  const full = bashResult("x".repeat(400));
  const row = formatToolRow(
    tr,
    input({
      toolName: "bash",
      toolArgs: { command: "cmd" },
      summary: full,
      fullContent: full,
    }),
    true,
  );
  const excerpt = row.slice("[bash] cmd (succeeded) ".length);
  assertEquals(excerpt.length, 160);
  assertEquals(excerpt.slice(-3), "...");
});

Deno.test("full bash row keeps the whole structured result", () => {
  const full = bashResult("hello from stdout\nmore");
  const row = formatToolRow(
    tr,
    input({
      toolName: "bash",
      toolArgs: { command: "deno task check" },
      summary: full,
      fullContent: full,
    }),
    false,
  );
  assertEquals(row, `[bash] deno task check (succeeded)\n${full}`);
});

Deno.test("running rows prefix the spinner before the running label", () => {
  const bash = formatToolRow(
    tr,
    input({
      toolName: "bash",
      status: "running",
      toolArgs: { command: "npm run build" },
      spinner: "⠋",
    }),
    false,
  );
  assert(bash.includes("[bash] npm run build (⠋ running)"), bash);

  const read = formatToolRow(
    tr,
    input({ toolName: "read", status: "running", spinner: "⠋" }),
    false,
  );
  assert(read.includes("[read] ⠋ running"), read);
});
