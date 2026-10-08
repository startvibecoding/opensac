// Generated from regex_worker.js (embedded worker source). Do not edit by hand.
//
// esbuild/Node cannot bundle Deno `import ... with { type: "text" }`, so
// the worker source is inlined as a string here. Deno and the esbuild
// bundle share it. Regenerate with: deno task gen:worker-sources

export const regexWorkerSource = "// deno-lint-ignore-file\n// Bounded user-pattern matching worker.\n//\n// JS `RegExp` backtracks, so a pattern that passed the shape screen in\n// regex.ts (for example `(a|a)+$`) can still hang the single-threaded event\n// loop against one long line. This worker moves every match run off the main\n// thread so a runaway pattern can be interrupted by terminating the worker\n// (the wall-clock budget is enforced by the host). It is loaded as text (see\n// regex.ts) and instantiated from a data: URL, so it needs no imports and\n// works inside the compiled binary.\nself.onmessage = (event) => {\n  const { id, pattern, flags, lines } = event.data;\n\n  let re;\n  try {\n    re = new RegExp(pattern, flags);\n  } catch (err) {\n    self.postMessage({\n      id,\n      ok: false,\n      error: String((err && err.message) || err),\n    });\n    return;\n  }\n\n  const matched = [];\n  for (let i = 0; i < lines.length; i++) {\n    re.lastIndex = 0;\n    if (re.test(lines[i])) matched.push(i);\n  }\n  self.postMessage({ id, ok: true, matched });\n};\n";
