// Test compatibility surface for the Node.js test runner.
//
// The repository used to declare tests with `nodeRuntime.test(...)` under the Node
// CLI. It now runs on `node:test`, and this module is the single owner of that
// transition: every test file imports `test` from here (via `#testing`) rather
// than reaching for a runtime global.
//
// `test()` keeps the Node declaration shapes so the ~2300 existing call sites
// needed only an import change:
//   test("name", fn)
//   test({ name, ...options }, fn)
//
// Node-only option fields (`sanitizeOps`, `sanitizeResources`, `ignore`) are
// accepted and ignored: Node has no op/resource sanitizer, and leaks are caught
// by explicit assertions instead. A `time` option maps onto Node's per-test
// timeout; omitting it leaves Node's default of "no timeout" in place, which is
// what the long-task continuity policy wants.

import { runtime as nodeRuntime } from "../platform/runtime.ts";
import nodeTest from "node:test";
import { setTimeout as delay } from "node:timers/promises";

/** Re-exported so tests can type their context without importing node:test. */
export type TestContext = import("node:test").TestContext;

/** Options accepted alongside a test name (superset of the node:test ones). */
export interface TestOptions {
  name?: string;
  fn?: TestBody;
  only?: boolean;
  skip?: boolean | string;
  todo?: boolean | string;
  /** Execution budget in milliseconds (Node semantics). */
  time?: number;
  concurrency?: number | boolean;
  signal?: AbortSignal;
  /** @deprecated Node-only op sanitizer toggle; kept for call-site parity. */
  sanitizeOps?: boolean;
  /** @deprecated Node-only resource sanitizer toggle; kept for call-site parity. */
  sanitizeResources?: boolean;
  /** @deprecated Node-only lint escape; kept for call-site parity. */
  ignore?: boolean;
}

type TestTarget = string | Function | TestOptions;
type TestBody = (context: any) => unknown;
type Marker = Partial<Record<"only" | "skip" | "todo", true>>;

const register = nodeTest as unknown as (
  name: string,
  options: Record<string, unknown>,
  fn: TestBody,
) => void;

function normalize(
  target: TestTarget,
  body?: TestBody,
): { name: string; options: Record<string, unknown>; fn: TestBody } {
  let name = "";
  let fn: TestBody | undefined = body;
  let options: Record<string, unknown> = {};

  if (typeof target === "string") {
    name = target;
  } else if (typeof target === "function") {
    // Node allows `test(function foo() {})`; the name comes from the function.
    name = target.name || "anonymous";
    fn = fn ?? ((context: any) => (target as (...a: any[]) => any)(context));
  } else if (target && typeof target === "object") {
    const {
      name: optionName,
      fn: optionFn,
      time,
      sanitizeOps: _sanitizeOps,
      sanitizeResources: _sanitizeResources,
      ignore: _ignore,
      ...rest
    } = target;
    name = optionName ?? "";
    fn = fn ?? optionFn;
    options = { ...rest };
    if (typeof time === "number" && time > 0) options.timeout = time;
  }

  if (!fn) throw new TypeError(`test("${name}"): missing test function`);
  return { name, options, fn };
}

/**
 * Node's `t.step(...)` runs a named subtest. Node's test context exposes
 * `t.test(...)` for the same purpose, so map one onto the other when the body
 * receives a context that lacks `step`.
 */
function attachStep(context: any): any {
  if (!context || typeof context === "object") {
    if (
      typeof context?.step !== "function" &&
      typeof context?.test === "function"
    ) {
      try {
        context.step = (name: string, body: (t: any) => unknown) =>
          context.test(name, body);
      } catch {
        // A frozen context is fine; the body simply will not get `step`.
      }
    }
  }
  return context;
}

function declare(marker: Marker, target: TestTarget, body?: TestBody): void {
  const { name, options, fn } = normalize(target, body);
  register(name, { ...marker, ...options }, (context) =>
    fn(attachStep(context)),
  );
}

/** Registers one test with the Node test runner. */
export function test(target: TestTarget, body?: TestBody): void {
  declare({}, target, body);
}

/** Registers a test that must run exclusively (`--test-name-pattern`). */
test.only = (target: TestTarget, body?: TestBody): void =>
  declare({ only: true }, target, body);

/** Registers a test that reports as skipped. */
test.skip = (target: TestTarget, body?: TestBody): void =>
  declare({ skip: true }, target, body);

/** Registers a test that documents intended-but-unwritten work. */
test.todo = (target: TestTarget, body?: TestBody): void =>
  declare({ todo: true }, target, body);

/** Grouping and BDD aliases, mirroring the `nodeRuntime.test` suite helpers. */
test.describe = nodeTest.describe.bind(nodeTest);
test.it = nodeTest.it.bind(nodeTest);
test.suite = nodeTest.suite?.bind(nodeTest);
test.beforeEach = nodeTest.beforeEach?.bind(nodeTest);
test.afterEach = nodeTest.afterEach?.bind(nodeTest);
test.before = nodeTest.before?.bind(nodeTest);
test.after = nodeTest.after?.bind(nodeTest);

/** Waits `ms` with a real timer (replaces ad-hoc Node sleep helpers). */
export const sleep = delay;

/** Minimal deferred promise for tests that wait on an event. */
export class Deferred<T> {
  readonly promise: Promise<T>;
  #resolve!: (value: T) => void;
  #reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  resolve(value: T): void {
    this.#resolve(value);
  }

  reject(reason?: unknown): void {
    this.#reject(reason);
  }
}
