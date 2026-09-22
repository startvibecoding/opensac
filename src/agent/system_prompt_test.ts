// Focused tests for the system-prompt builder.

import { assert, assertEquals } from "@std/assert";
import { buildSubAgentContext, buildSystemPrompt } from "./system_prompt.ts";

Deno.test("system prompt includes identity, mode, tools and guidelines", () => {
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

Deno.test("system prompt orders project rules before expert and context", () => {
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

Deno.test("system prompt renders sub-agent section only in multi-agent mode", () => {
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

Deno.test("sub-agent context includes the operating contract", () => {
  const ctx = buildSubAgentContext();
  assertEquals(ctx.includes("## Sub-Agent Operating Contract"), true);
  assertEquals(ctx.includes("**Result:**"), true);
});
