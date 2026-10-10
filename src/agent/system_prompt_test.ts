// Focused tests for the system-prompt builder.

import { runtime } from "../platform/runtime.ts";
import { assert, assertEquals } from "../compat/assert.ts";
import { resolveBashShell } from "../platform/platform.ts";
import { createBashTool } from "../tools/bash.ts";
import { createRegistry, createRegistryWithConfig } from "../tools/tool.ts";
import {
  buildSubAgentContext,
  buildSystemPrompt,
  buildSystemPromptWithOptions,
} from "./system_prompt.ts";
import { test } from "#testing";

test("system prompt includes identity, mode, tools and guidelines", () => {
  const prompt = buildSystemPrompt(
    "yolo",
    ["read", "grep"],
    "/work",
    "",
    "",
    { read: "read a file", grep: "search files" },
    ["tool guideline"],
    false,
    false,
    false,
  );

  assert(prompt.includes("You are OpenSAC"));
  assert(prompt.includes("## Mode: YOLO"));
  assert(prompt.includes("- Working directory: /work"));
  assert(prompt.includes("- read: read a file"));
  assert(prompt.includes("- grep: search files"));
  assert(prompt.includes("- tool guideline"));
  assert(prompt.includes("Local execution policy: parallel mode"));
});

test("system prompt orders project rules before expert and context", () => {
  const prompt = buildSystemPrompt(
    "agent",
    ["read"],
    "/work",
    "RULE_CONTENT",
    "EXTRA_CONTEXT",
    { read: "r" },
    [],
    false,
    false,
    false,
  );
  const ruleIdx = prompt.indexOf("## Project Rules");
  const ctxIdx = prompt.indexOf("## Context from project files");
  assert(ruleIdx >= 0 && ctxIdx >= 0);
  assert(ruleIdx < ctxIdx);
  assert(prompt.includes("RULE_CONTENT"));
  assert(prompt.includes("EXTRA_CONTEXT"));
});

test("system prompt renders sub-agent section only in multi-agent mode", () => {
  const single = buildSystemPrompt(
    "yolo",
    ["read"],
    "/w",
    "",
    "",
    {},
    [],
    false,
    false,
    false,
  );
  assert(!single.includes("## Sub-Agent Tools"));
  const multi = buildSystemPrompt(
    "yolo",
    ["read"],
    "/w",
    "",
    "",
    {},
    [],
    true,
    false,
    false,
  );
  assert(multi.includes("## Sub-Agent Tools"));
});

test("sub-agent context includes the operating contract", () => {
  const ctx = buildSubAgentContext();
  assertEquals(ctx.includes("## Sub-Agent Operating Contract"), true);
  assertEquals(ctx.includes("**Result:**"), true);
});

test("the advertised shell is the shell the bash tool runs", () => {
  // Regression: the prompt used to override the shell on Windows (advertising
  // the extracted BusyBox) while `bash` executed powershell/cmd, so the model
  // wrote POSIX syntax that then failed. Both sides must share one resolver.
  const prompt = buildSystemPrompt(
    "yolo",
    ["bash"],
    "/work",
    "",
    "",
    {},
    [],
    false,
    false,
    false,
  );
  const tool = createBashTool(createRegistry("/work", undefined));
  assert(
    prompt.includes(`- Shell: ${resolveBashShell()}`),
    "system prompt must advertise the shell the bash tool resolves",
  );
  assertEquals(tool.resolveShell(), resolveBashShell());
});

test("a configured settings.shellPath reaches the tool and the prompt", () => {
  // Regression: `settings.shellPath` was dead config. It was persisted and shown
  // in the TUI, but nothing ever read it, so the user's chosen shell was
  // silently ignored.
  const dir = runtime.makeTempDirSync({ prefix: ".opensac-shellpath-" });
  try {
    const custom = `${dir}/myshell`;
    runtime.writeTextFileSync(custom, "#!/bin/sh\n");

    const registry = createRegistryWithConfig({
      workDir: "/work",
      shellPath: custom,
    });
    const tool = createBashTool(registry);
    assertEquals(tool.resolveShell(), custom);

    const prompt = buildSystemPromptWithOptions(
      "yolo",
      ["bash"],
      "/work",
      "",
      "",
      {},
      [],
      false,
      false,
      false,
      { shellPath: registry.shellPath() },
    );
    assert(
      prompt.includes(`- Shell: ${custom}`),
      "prompt must advertise the configured shell",
    );
  } finally {
    runtime.removeSync(dir, { recursive: true });
  }
});
