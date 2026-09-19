// deno-lint-ignore-file
// Workflow DSL evaluator worker.
//
// This module runs the user-authored workflow JavaScript in an isolated worker
// so a runaway script (`while (true) {}`) can be interrupted by terminating
// the worker. It is loaded as text (see js.ts) and instantiated from a data:
// URL, so it needs no imports and works inside the compiled binary.
//
// The worker only builds the node graph; worker agents run natively afterwards.
self.onmessage = (event) => {
  const source = event.data.source;

  const expr = (kind) => (...args) => ({ expr: kind, args });

  function bodyNodes(value) {
    if (typeof value === "function") {
      return bodyNodes(value());
    }
    if (value && typeof value === "object" && value.__node === true) {
      return [value];
    }
    if (Array.isArray(value)) {
      const out = [];
      for (const item of value) {
        for (const node of bodyNodes(item)) out.push(node);
      }
      return out;
    }
    if (value && typeof value === "object" && value.phases !== undefined) {
      return bodyNodes(value.phases);
    }
    throw new Error(
      "workflow body must be a node, array, function, or options object",
    );
  }

  const agent = (name, opts) => ({
    __node: true,
    kind: "agent",
    name: String(name),
    opts: opts && typeof opts === "object" ? opts : {},
  });
  const parallel = (...nodes) => ({
    __node: true,
    kind: "parallel",
    children: nodes,
  });
  const series = (...nodes) => ({
    __node: true,
    kind: "series",
    children: nodes,
  });
  const phase = (name, body) => ({
    __node: true,
    kind: "phase",
    name: String(name),
    children: bodyNodes(body),
  });
  const result = expr("result");
  const resultKey = expr("resultKey");
  const resultLatest = expr("resultLatest");
  const results = expr("results");
  const log = expr("log");
  const concurrency = (value) => ({ expr: "concurrency", args: [value] });

  let workflow = null;
  const workflowBuiltin = (name, body) => {
    workflow = {
      name: String(name),
      concurrency: 0,
      children: bodyNodes(body),
    };
    if (
      body && typeof body === "object" && !Array.isArray(body) &&
      typeof body.concurrency === "number"
    ) {
      workflow.concurrency = Math.trunc(body.concurrency);
    }
    return workflow.name;
  };

  try {
    const params = [
      "agent",
      "parallel",
      "series",
      "phase",
      "workflow",
      "result",
      "resultKey",
      "resultLatest",
      "results",
      "log",
      "concurrency",
    ];
    // deno-lint-ignore no-new-func
    const fn = new Function(...params, source);
    fn(
      agent,
      parallel,
      series,
      phase,
      workflowBuiltin,
      result,
      resultKey,
      resultLatest,
      results,
      log,
      concurrency,
    );
    if (!workflow) {
      throw new Error("source must call workflow(name, body)");
    }
    self.postMessage({ ok: true, workflow });
  } catch (err) {
    self.postMessage({
      ok: false,
      error: String(err && err.message ? err.message : err),
    });
  }
};
