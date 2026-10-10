/* eslint-disable */
// Bounded user-pattern matching worker.
//
// JS `RegExp` backtracks, so a pattern that passed the shape screen in
// regex.ts (for example `(a|a)+$`) can still hang the single-threaded event
// loop against one long line. This worker moves every match run off the main
// thread so a runaway pattern can be interrupted by terminating the worker
// (the wall-clock budget is enforced by the host). It is loaded as text (see
// regex.ts) and instantiated from a data: URL, so it needs no imports and
// works inside the compiled binary.
self.onmessage = (event) => {
  const { id, pattern, flags, lines } = event.data;

  let re;
  try {
    re = new RegExp(pattern, flags);
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: String((err && err.message) || err),
    });
    return;
  }

  const matched = [];
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) matched.push(i);
  }
  self.postMessage({ id, ok: true, matched });
};
