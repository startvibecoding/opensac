//
// The `RegisterTools`/`workflow_run` end-to-end and `AgentHost` cases depend on
// the not-yet-ported Agent Core (`internal/agent`) and are deferred to backlog
// #19; the lint/status/cancel and run-tool metadata cases are ported here.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  createCancelTool,
  createLintTool,
  createRunTool,
  type LintResult,
  lintWorkflowSourceWithin,
} from "./tools.ts";
import { createActiveRegistry } from "./active.ts";
import { statusCanceled, statusDone, statusError } from "./types.ts";

Deno.test("lint tool validates JavaScript source without running agents", async () => {
  const result = await createLintTool().execute({}, {
    source:
      `workflow("lint me", {phases:[phase("scan", agent("handler-audit", {key:"r0", mode:"plan", tools:["read","grep"], prompt:"Audit handler."})), phase("verify", agent("cross-check", {mode:"plan", prompt:resultKey("scan.handler-audit","r0")}))]});`,
  });
  const parsed = JSON.parse(result.text) as LintResult;
  assert(parsed.valid, `lint invalid: ${JSON.stringify(parsed)}`);
  assertEquals(parsed.status, statusDone);
});

Deno.test("lint tool reports workflow errors", async () => {
  const result = await createLintTool().execute({}, {
    source:
      `workflow("bad", {phases:[phase("verify", agent("check", {prompt:result("scan.missing")}))]});`,
  });
  const parsed = JSON.parse(result.text) as LintResult;
  assert(!parsed.valid, "expected invalid lint result");
  assertStringIncludes(
    parsed.error ?? "",
    `workflow result "scan.missing" not found`,
  );
});

Deno.test("run tool prompt guidelines require complete JavaScript source", () => {
  const tool = createRunTool(undefined, undefined);
  const guidelines = tool.promptGuidelines().join("\n");
  const params = JSON.stringify(tool.parameters());
  for (const want of ["JavaScript", "Markdown code fences", "timeoutSeconds"]) {
    assert(
      (guidelines + params).includes(want),
      `missing ${JSON.stringify(want)}`,
    );
  }
});

Deno.test("run tool execution timeout", () => {
  const tool = createRunTool(undefined, undefined);

  assert(!tool.executionTimeout({}).provided);
  const ninety = tool.executionTimeout({ timeoutSeconds: 90 });
  assert(ninety.provided);
  assertEquals(ninety.durationMs, 90_000);
  const zero = tool.executionTimeout({ timeoutSeconds: 0 });
  assert(zero.provided);
  assertEquals(zero.durationMs, 0);
  assert(!tool.executionTimeout({ timeoutSeconds: 1.5 }).provided);
});

Deno.test("cancel tool cancels active run", async () => {
  const active = createActiveRegistry();
  let canceled = false;
  active.register("run-1", () => {
    canceled = true;
  });
  const result = await createCancelTool(active).execute({}, { id: "run-1" });
  assert(canceled, "expected active run cancel function to be called");
  const parsed = JSON.parse(result.text) as { status: string };
  assertEquals(parsed.status, statusCanceled);
});

Deno.test("cancel tool rejects inactive run", async () => {
  await assertRejects(
    () =>
      createCancelTool(createActiveRegistry()).execute({}, { id: "missing" }),
  );
});

Deno.test("lint workflow source times out runaway source", async () => {
  const started = Date.now();
  const res = await lintWorkflowSourceWithin("while (true) {}", 50);
  assert(!res.valid, `lint result = ${JSON.stringify(res)}, want invalid`);
  assertEquals(res.status, statusError);
  assertEquals(res.error, "workflow source evaluation timed out");
  assert(
    Date.now() - started < 5000,
    "lint ran despite the 50ms budget",
  );
});
