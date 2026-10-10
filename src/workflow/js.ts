// (the JavaScript workflow DSL evaluator).
//
// The Go implementation evaluates the DSL inside a `goja` VM and interrupts a
// runaway script. Node has no interruptible in-process VM, so the DSL runs in
// an isolated worker (js_worker.js, loaded as text and started from a data:
// URL) that is terminated on abort or when the wall-clock evaluation budget
// expires. The worker only builds the node graph; worker agents run natively
// afterwards via the runner.

import { jsWorkerSource as workerSource } from "./js_worker_source.ts";
import { abortError } from "./types.ts";

/** Caps one workflow-run evaluation. */
export const jsEvalTimeoutMs = 30_000;
/** The tighter cap for `workflow_lint`, which must fail fast. */
export const lintEvalTimeoutMs = 5_000;

/** Reports a workflow source that outran the VM evaluation budget. */
export class JsEvaluationTimeoutError extends Error {
  constructor() {
    super("workflow source evaluation timed out");
    this.name = "JsEvaluationTimeoutError";
  }
}

/** A parsed workflow definition. */
export interface JsWorkflow {
  name: string;
  concurrency: number;
  children: JsNode[];
}

/** One node in the workflow graph. */
export interface JsNode {
  kind: string;
  name: string;
  opts: Record<string, unknown>;
  children: JsNode[];
}

/** A deferred runtime expression (result/resultKey/results/log/concurrency). */
export interface JsExpr {
  expr: string;
  args: unknown[];
}

/** Reports whether a value is a deferred workflow expression. */
export function isJsExpr(value: unknown): value is JsExpr {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { expr?: unknown }).expr === "string" &&
    Array.isArray((value as { args?: unknown }).args)
  );
}

const workerUrl =
  "data:application/javascript," + encodeURIComponent(workerSource);

/** Evaluates a workflow source with the default run evaluation budget. */
export function evalJsWorkflow(
  source: string,
  signal?: AbortSignal,
): Promise<JsWorkflow> {
  return evalJsWorkflowWithin(source, jsEvalTimeoutMs, signal);
}

/**
 * Evaluates `source` with an explicit wall-clock budget. The caller's signal
 * and the budget are both honored; whichever fires first terminates the worker.
 */
export function evalJsWorkflowWithin(
  source: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<JsWorkflow> {
  const worker = new Worker(workerUrl, { type: "module" });
  return new Promise<JsWorkflow>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onAbort = () => fail(abortError());

    if (signal?.aborted) {
      fail(abortError());
      return;
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => fail(new JsEvaluationTimeoutError()), timeoutMs);
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    worker.onmessage = (event: MessageEvent) => {
      if (settled) return;
      const data = event.data as
        { ok: true; workflow: unknown } | { ok: false; error: string };
      if (data.ok) {
        settled = true;
        cleanup();
        resolve(normalizeWorkflow(data.workflow));
      } else {
        fail(new Error(data.error));
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      fail(new Error(event.message || "workflow evaluation failed"));
    };

    worker.postMessage({ source });
  });
}

function normalizeWorkflow(raw: unknown): JsWorkflow {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("expected workflow node");
  }
  const wf = raw as {
    name?: unknown;
    concurrency?: unknown;
    children?: unknown;
  };
  if (typeof wf.name !== "string") {
    throw new Error("source must call workflow(name, body)");
  }
  const concurrency = typeof wf.concurrency === "number" ? wf.concurrency : 0;
  const children = Array.isArray(wf.children)
    ? wf.children.map(normalizeNode)
    : [];
  return { name: wf.name, concurrency, children };
}

function normalizeNode(raw: unknown): JsNode {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("expected workflow node");
  }
  const node = raw as {
    kind?: unknown;
    name?: unknown;
    opts?: unknown;
    children?: unknown;
  };
  return {
    kind: typeof node.kind === "string" ? node.kind : "",
    name: typeof node.name === "string" ? node.name : "",
    opts:
      typeof node.opts === "object" && node.opts !== null
        ? (node.opts as Record<string, unknown>)
        : {},
    children: Array.isArray(node.children)
      ? node.children.map(normalizeNode)
      : [],
  };
}
