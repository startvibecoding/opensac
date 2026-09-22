// Focused tests for the live activity-row labels: every tool shows the
// single-line call it is about to run after the tool name
// (`bash: cd src & ls`, `read: src/main.ts`).

import { assertEquals } from "@std/assert";
import { toolCallLabel } from "./tool_execution_display.tsx";

Deno.test("toolCallLabel shows the whole bash command, not just its first word", () => {
  assertEquals(
    toolCallLabel("bash", { command: "cd /home/free/src/opensac/x & ls" }),
    "bash: cd /home/free/src/opensac/x & ls",
  );
});

Deno.test("toolCallLabel flattens a multi-line command onto one line", () => {
  assertEquals(
    toolCallLabel("bash", { command: "cd src\nnpm test" }),
    "bash: cd src; npm test",
  );
  assertEquals(
    toolCallLabel("bash", { command: "cd src\r\nnpm test" }),
    "bash: cd src; npm test",
  );
});

Deno.test("toolCallLabel shows the path and pattern of file tools", () => {
  assertEquals(
    toolCallLabel("read", { path: "src/main.ts" }),
    "read: src/main.ts",
  );
  assertEquals(
    toolCallLabel("write", { file_path: "/tmp/a.txt" }),
    "write: /tmp/a.txt",
  );
  assertEquals(
    toolCallLabel("find", { path: "src", pattern: "**/*.ts" }),
    "find: src **/*.ts",
  );
  assertEquals(toolCallLabel("grep", { pattern: "TODO" }), "grep: TODO");
});

Deno.test("toolCallLabel falls back to the bare tool name", () => {
  assertEquals(toolCallLabel("bash"), "bash");
  assertEquals(toolCallLabel("bash", { command: "   " }), "bash");
  assertEquals(toolCallLabel("bash", { timeoutMs: 1000 }), "bash");
  // Unknown tools keep their plain name instead of an invented argument.
  assertEquals(toolCallLabel("plan", { plan: {} }), "plan");
});
