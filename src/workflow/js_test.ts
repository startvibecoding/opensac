//
// The goja-specific `TestGojaUndefinedAndNullExportAsNil` is dropped (no goja
// equivalent): the Deno worker already normalizes undefined/null to null.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  evalJsWorkflow,
  evalJsWorkflowWithin,
  isJsExpr,
  JsEvaluationTimeoutError,
} from "./js.ts";
import { resolveJsValue, Runner, WorkflowRuntime } from "./runner.ts";
import { isCanceled, type RunState, statusRunning } from "./types.ts";

function fixedClock(): () => Date {
  let t = new Date(Date.UTC(2026, 5, 18, 10, 0, 0, 0));
  return () => {
    t = new Date(t.getTime() + 1);
    return t;
  };
}

function testRuntime(): WorkflowRuntime {
  const now = new Date(Date.UTC(2026, 7, 7, 12, 0, 0, 0));
  const state: RunState = {
    id: "",
    name: "",
    status: statusRunning,
    startedAt: now,
    updatedAt: now,
    results: {},
  };
  return new WorkflowRuntime(
    new Runner({ now: fixedClock() }),
    state,
    () => {},
  );
}

Deno.test("resolveJsValue nested values and numbers", async () => {
  const rt = testRuntime();
  const value = {
    object: {
      text: { expr: "result", args: ["scan.worker"] },
      items: [3, 2.5, null],
    },
    null: null,
  };
  rt.state.results!["scan.worker"] = {
    key: "scan.worker",
    name: "worker",
    phase: "scan",
    status: "done",
    result: "findings",
    startedAt: new Date(),
  };
  const got = await resolveJsValue(rt, undefined, value) as {
    object: { text: unknown; items: unknown[] };
  };
  assertEquals(got.object.text, "findings");
  assertEquals(got.object.items, [3, 2.5, null]);
});

Deno.test("resolveJsValue errors propagate", async () => {
  const rt = testRuntime();
  await assertRejects(
    () =>
      resolveJsValue(rt, undefined, {
        expr: "resultKey",
        args: ["scan.worker", "bad[]"],
      }),
    Error,
    "must not contain",
  );
  const ac = new AbortController();
  ac.abort();
  let canceled = false;
  try {
    await resolveJsValue(rt, ac.signal, "value");
  } catch (err) {
    canceled = isCanceled(err);
  }
  assert(canceled, "expected cancellation error");
});

Deno.test("evalJsWorkflow cancellation interrupts runtime", async () => {
  const ac = new AbortController();
  const done = evalJsWorkflow(
    `workflow("hang", {phases:[phase("loop", function(){ while (true) {} })]});`,
    ac.signal,
  );
  setTimeout(() => ac.abort(), 10);
  let canceled = false;
  try {
    await done;
  } catch (err) {
    canceled = isCanceled(err);
  }
  assert(canceled, "expected context cancellation to stop evaluation");
});

Deno.test("evalJsWorkflowWithin times out runaway source", async () => {
  const started = Date.now();
  const err = await assertRejects(
    () => evalJsWorkflowWithin("while (true) {}", 50),
  );
  assert(
    err instanceof JsEvaluationTimeoutError,
    `error = ${err}, want JsEvaluationTimeoutError`,
  );
  assert(
    Date.now() - started < 5000,
    "evaluation ran despite the 50ms budget",
  );
});

Deno.test("evalJsWorkflowWithin keeps completion behavior", async () => {
  const wf = await evalJsWorkflowWithin(
    `workflow("ok", {phases:[phase("scan", agent("worker", {prompt:"look"})), phase("verify", agent("checker", {prompt: result("scan.worker")}))]});`,
    1000,
  );
  assertEquals(wf.name, "ok");
  assertEquals(wf.children.length, 2);
});

Deno.test("isJsExpr recognizes deferred expressions", () => {
  assert(isJsExpr({ expr: "result", args: [] }));
  assert(!isJsExpr({ kind: "result" }));
  assert(!isJsExpr("x"));
});

Deno.test("results and logs are deterministically ordered", async () => {
  const rt = testRuntime();
  const t0 = new Date(Date.UTC(2026, 7, 7, 12, 0, 0, 0));
  rt.state.results!["p.b"] = {
    key: "p.b",
    name: "b",
    phase: "p",
    status: "done",
    result: "b",
    startedAt: t0,
  };
  rt.state.results!["p.a"] = {
    key: "p.a",
    name: "a",
    phase: "p",
    status: "done",
    result: "a",
    startedAt: t0,
  };
  rt.state.results!["p.c"] = {
    key: "p.c",
    name: "c",
    phase: "p",
    status: "done",
    result: "c",
    startedAt: new Date(t0.getTime() + 1000),
  };
  const got = rt.resultsText("p");
  const ia = got.indexOf("p.a:\n");
  const ib = got.indexOf("p.b:\n");
  assert(ia >= 0 && ib >= 0 && ia < ib, `results order = ${got}`);

  await resolveJsValue(rt, undefined, {
    expr: "log",
    args: ["hello", "world"],
  });
  assertEquals(rt.state.logs!.length, 1);
  assertEquals(rt.state.logs![0].message, "hello world");
});
