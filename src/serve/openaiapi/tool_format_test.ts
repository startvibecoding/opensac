// Translated from internal/serve/openaiapi/server_test.go's tool-formatting
// cases (TestInferCodeLang, TestToolKeyArg, TestFormatToolCollapsed_*,
// TestFormatToolResult_Dispatches, TestLangFromPath, TestFormatToolHeaderMD,
// TestFormatToolHeader, TestToolKeyArg_BashLongCommand).

import { assertEquals } from "@std/assert";
import {
  formatToolCollapsed,
  formatToolExpanded,
  formatToolHeader,
  formatToolHeaderMD,
  formatToolResult,
  inferCodeLang,
  langFromPath,
  type toolCallInfo,
  toolKeyArg,
} from "./tool_format.ts";
import type { FileDiff } from "../../tools/io_helpers.ts";

Deno.test("inferCodeLang table", () => {
  const tests: [string, Record<string, unknown> | null, string][] = [
    ["bash", null, "bash"],
    ["read", { path: "main.go" }, "go"],
    ["read", { path: "app.py" }, "python"],
    ["read", { path: "style.css" }, "css"],
    ["read", { path: "Makefile" }, "makefile"],
    ["read", { path: "Dockerfile" }, "dockerfile"],
    ["read", { path: "data.json" }, "json"],
    ["grep", { pattern: "x" }, ""],
    ["ls", null, ""],
  ];
  for (const [tool, args, want] of tests) {
    assertEquals(
      inferCodeLang(tool, args),
      want,
      `${tool} ${JSON.stringify(args)}`,
    );
  }
});

Deno.test("toolKeyArg table", () => {
  const tests: [string, string, Record<string, unknown> | null, string][] = [
    ["read path", "read", { path: "main.go" }, "main.go"],
    ["bash command", "bash", { command: "ls -la" }, "ls -la"],
    ["grep", "grep", { pattern: "TODO", path: "src/" }, "TODO src/"],
    ["nil args", "read", null, ""],
    ["unknown tool", "foo", { name: "bar" }, "bar"],
  ];
  for (const [name, tool, args, want] of tests) {
    assertEquals(toolKeyArg(tool, args), want, name);
  }
});

Deno.test("formatToolCollapsed read keeps the one-line summary", () => {
  const tc: toolCallInfo = {
    name: "read",
    args: { path: "main.go" },
    status: "completed",
    result: "package main\n\nfunc main() {}\n",
    diff: null,
    error: null,
  };
  const text = formatToolCollapsed(tc);
  assertEquals(text.includes("read"), true, text);
  assertEquals(text.includes("main.go"), true, text);
  assertEquals(text.includes("✅"), true, text);
  // Should NOT contain the file content
  assertEquals(text.includes("package main"), false, text);
  assertEquals(text.includes("```"), false, text);
});

Deno.test("formatToolCollapsed edit always shows the diff", () => {
  const diff: FileDiff = {
    path: "main.go",
    added: 1,
    deleted: 1,
    addedLines: [],
    deletedLines: [],
    unified: "+new line\n-old line\n",
    oldText: null,
    newText: "",
    truncated: false,
  };
  const tc: toolCallInfo = {
    name: "edit",
    args: { path: "main.go" },
    status: "completed",
    result: "",
    diff,
    error: null,
  };
  const text = formatToolCollapsed(tc);
  // edit with diff should always show the diff even in collapsed mode
  assertEquals(text.includes("```diff"), true, text);
  assertEquals(text.includes("+new line"), true, text);
});

Deno.test("formatToolCollapsed errors are always shown", () => {
  const tc: toolCallInfo = {
    name: "bash",
    args: { command: "false" },
    status: "failed",
    result: "",
    diff: null,
    error: new Error("exit code 1"),
  };
  const text = formatToolCollapsed(tc);
  assertEquals(text.includes("Error: exit code 1"), true, text);
});

Deno.test("formatToolCollapsed bash hides stdout", () => {
  const tc: toolCallInfo = {
    name: "bash",
    args: { command: "go test ./..." },
    status: "completed",
    result: "ok  pkg 0.5s\n",
    diff: null,
    error: null,
  };
  const text = formatToolCollapsed(tc);
  assertEquals(text.includes("✅"), true, text);
  assertEquals(text.includes("ok  pkg"), false, text);
});

Deno.test("formatToolResult dispatches on detail level", () => {
  const tc: toolCallInfo = {
    name: "read",
    args: { path: "main.go" },
    status: "completed",
    result: "package main\n",
    diff: null,
    error: null,
  };

  const collapsed = formatToolResult(tc, "collapsed");
  const expanded = formatToolResult(tc, "expanded");

  assertEquals(
    collapsed.includes("```go"),
    false,
    "collapsed should not have code fence",
  );
  assertEquals(
    expanded.includes("```go"),
    true,
    "expanded should have code fence",
  );
});

Deno.test("langFromPath table", () => {
  const tests: [string, string][] = [
    ["main.go", "go"],
    ["app.py", "python"],
    ["index.js", "javascript"],
    ["app.ts", "typescript"],
    ["comp.tsx", "tsx"],
    ["comp.jsx", "jsx"],
    ["main.rs", "rust"],
    ["app.rb", "ruby"],
    ["Main.java", "java"],
    ["main.c", "c"],
    ["main.h", "c"],
    ["main.cpp", "cpp"],
    ["main.cc", "cpp"],
    ["main.cs", "csharp"],
    ["main.swift", "swift"],
    ["main.kt", "kotlin"],
    ["script.sh", "bash"],
    ["script.bash", "bash"],
    ["script.zsh", "zsh"],
    ["script.ps1", "powershell"],
    ["query.sql", "sql"],
    ["index.html", "html"],
    ["style.css", "css"],
    ["style.scss", "scss"],
    ["data.json", "json"],
    ["config.yaml", "yaml"],
    ["config.yml", "yaml"],
    ["config.toml", "toml"],
    ["data.xml", "xml"],
    ["README.md", "markdown"],
    ["main.tf", "hcl"],
    ["main.lua", "lua"],
    ["main.php", "php"],
    ["main.pl", "perl"],
    ["main.ex", "elixir"],
    ["main.erl", "erlang"],
    ["main.hs", "haskell"],
    ["main.scala", "scala"],
    ["main.clj", "clojure"],
    ["main.vim", "vim"],
    ["schema.proto", "protobuf"],
    ["schema.graphql", "graphql"],
    ["config.ini", "ini"],
    [".env", "bash"],
    ["Makefile", "makefile"],
    ["Dockerfile", "dockerfile"],
    ["Gemfile", "ruby"],
    ["unknown.xyz", ""],
  ];
  for (const [path, want] of tests) {
    assertEquals(langFromPath(path), want, path);
  }
});

Deno.test("formatToolHeaderMD", () => {
  assertEquals(
    formatToolHeaderMD("read", { path: "main.go" }),
    "🔧 read: main.go",
  );
  assertEquals(formatToolHeaderMD("plan", null), "🔧 plan");
});

Deno.test("formatToolHeader", () => {
  assertEquals(formatToolHeader("bash", { command: "ls" }), "🔧 [bash] ls");
  assertEquals(formatToolHeader("plan", null), "🔧 [plan]");
});

Deno.test("toolKeyArg truncates long bash commands", () => {
  const longCmd = "a".repeat(200);
  const got = toolKeyArg("bash", { command: longCmd });
  assertEquals(
    got.length <= 124,
    true,
    `expected truncated, got len ${got.length}`,
  ); // 120 + "..."
  assertEquals(got.endsWith("..."), true);
});

Deno.test("formatToolExpanded renders the fenced result", () => {
  const tc: toolCallInfo = {
    name: "read",
    args: { path: "app.py" },
    status: "completed",
    result: "print('hi')",
    diff: null,
    error: null,
  };
  const text = formatToolExpanded(tc);
  assertEquals(text.includes("```python\nprint('hi')\n```\n\n"), true, text);
});
