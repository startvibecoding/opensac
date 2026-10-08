import { assert, assertEquals } from "@opensac/assert";
import { COMMAND, prompt } from "./systeminit.ts";

Deno.test("CommandIsTheSlashSysteminit", () => {
  assertEquals(COMMAND, "/systeminit");
});

Deno.test("PromptNonInteractiveOmitsQuestionGuidance", () => {
  const p = prompt(false, "");
  assert(p.includes("high-quality AGENTS.md"));
  assert(!p.includes("question` tool"));
  assert(p.endsWith("When done, briefly summarize what you wrote and where."));
  assertEquals(p, prompt(false, ""));
});

Deno.test("PromptInteractiveAddsQuestionGuidance", () => {
  const p = prompt(true, "");
  assert(p.includes("question` tool"));
  assert(p.endsWith("When done, briefly summarize what you wrote and where."));
});

Deno.test("PromptAppendsTrimmedExtraBeforeFinalNote", () => {
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

Deno.test("PromptIgnoresBlankExtra", () => {
  assertEquals(prompt(false, "   \n\t"), prompt(false, ""));
  assertEquals(prompt(true, " "), prompt(true, ""));
});
