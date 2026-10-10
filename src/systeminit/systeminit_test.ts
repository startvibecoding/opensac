import { assert, assertEquals } from "../compat/assert.ts";
import { COMMAND, prompt } from "./systeminit.ts";
import { test } from "#testing";

test("CommandIsTheSlashSysteminit", () => {
  assertEquals(COMMAND, "/systeminit");
});

test("PromptNonInteractiveOmitsQuestionGuidance", () => {
  const p = prompt(false, "");
  assert(p.includes("high-quality AGENTS.md"));
  assert(!p.includes("question` tool"));
  assert(p.endsWith("When done, briefly summarize what you wrote and where."));
  assertEquals(p, prompt(false, ""));
});

test("PromptInteractiveAddsQuestionGuidance", () => {
  const p = prompt(true, "");
  assert(p.includes("question` tool"));
  assert(p.endsWith("When done, briefly summarize what you wrote and where."));
});

test("PromptAppendsTrimmedExtraBeforeFinalNote", () => {
  const p = prompt(false, "  write AGENTS.md in English  ");
  assert(
    p.includes(
      "Additional user instructions (follow these closely):\nwrite AGENTS.md in English",
    ),
  );
  assert(
    p.indexOf("write AGENTS.md in English") <
      p.indexOf("When done, briefly summarize"),
  );
});

test("PromptIgnoresBlankExtra", () => {
  assertEquals(prompt(false, "   \n\t"), prompt(false, ""));
  assertEquals(prompt(true, " "), prompt(true, ""));
});
