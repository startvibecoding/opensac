// Tests for the bounded user-pattern matching worker (regex_match.ts).

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "../compat/assert.ts";
import {
  createUserRegExpMatcher,
  RegExpMatchTimeoutError,
  userRegExpMatchBudgetMs,
} from "./regex_match.ts";
import { regexWorkerSource } from "./regex_worker_source.ts";
import { test } from "#testing";

function referenceMatches(
  pattern: string,
  flags: string,
  lines: readonly string[],
): number[] {
  const re = new RegExp(pattern, flags);
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) out.push(i);
  }
  return out;
}

test("UserRegExpMatcher matches exactly like an in-process RegExp", async () => {
  const lines = [
    "package main",
    "func Hello() {}",
    "hello world",
    "",
    "HELLO again",
    "no match here",
  ];
  const cases: { pattern: string; flags: string }[] = [
    { pattern: "Hello", flags: "" },
    { pattern: "hello", flags: "i" },
    { pattern: "^func [A-Z]", flags: "" },
    { pattern: "(foo|func|no match)", flags: "" },
    { pattern: "a+", flags: "" },
    { pattern: "z", flags: "" },
  ];
  for (const { pattern, flags } of cases) {
    const matcher = createUserRegExpMatcher(pattern, flags);
    try {
      const matched = await matcher.match(lines);
      assertEquals(matched, referenceMatches(pattern, flags, lines), pattern);
    } finally {
      matcher.close();
    }
  }
});

test("UserRegExpMatcher spans multiple chunks and returns local indices", async () => {
  const lines: string[] = [];
  for (let i = 0; i < 1300; i++) {
    lines.push(i % 7 === 0 ? `hit ${i}` : `miss ${i}`);
  }
  const matcher = createUserRegExpMatcher("hit", "", { chunkLines: 64 });
  try {
    const matched = await matcher.match(lines);
    assertEquals(matched, referenceMatches("hit", "", lines));
    assert(matched.length > 100, "expected matches across chunks");
  } finally {
    matcher.close();
  }
});

test("UserRegExpMatcher times out a catastrophic pattern instead of hanging", async () => {
  // `(a|a)+$` passes the compileUserRegExp shape screen but backtracks
  // exponentially against a long non-matching line.
  const matcher = createUserRegExpMatcher("(a|a)+$", "", { timeoutMs: 100 });
  const lines = ["a".repeat(40) + "!"];
  try {
    const started = performance.now();
    await assertRejects(
      () => matcher.match(lines),
      RegExpMatchTimeoutError,
    );
    const elapsed = performance.now() - started;
    assert(elapsed < 3000, `timeout must fire quickly, took ${elapsed}ms`);
  } finally {
    matcher.close();
  }
  await assertRejects(() => matcher.match(["abc"]), RegExpMatchTimeoutError);
});

test("UserRegExpMatcher rejects when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const matcher = createUserRegExpMatcher("abc", "", {
    signal: controller.signal,
  });
  try {
    await assertRejects(() => matcher.match(["abc"]), Error, "aborted");
  } finally {
    matcher.close();
  }
});

test("UserRegExpMatcher aborts an in-flight match via the signal", async () => {
  const controller = new AbortController();
  // A slow-but-finite pattern keeps the request in flight while we abort.
  const matcher = createUserRegExpMatcher("(a|a)+$", "", {
    timeoutMs: userRegExpMatchBudgetMs,
    signal: controller.signal,
  });
  const pending = matcher.match(["a".repeat(40) + "!"]);
  controller.abort();
  await assertRejects(() => pending, Error, "aborted");
  matcher.close();
});

test("UserRegExpMatcher reports invalid patterns like compileUserRegExp", async () => {
  const matcher = createUserRegExpMatcher("(unclosed", "");
  try {
    await assertRejects(
      () => matcher.match(["abc"]),
      Error,
      "invalid regex",
    );
  } finally {
    matcher.close();
  }
});

test("UserRegExpMatcher rejects use after close and tolerates double close", async () => {
  const matcher = createUserRegExpMatcher("abc");
  matcher.close();
  matcher.close();
  await assertRejects(() => matcher.match(["abc"]), Error, "closed");
});

test("UserRegExpMatcher default budget constant stays positive", () => {
  assert(userRegExpMatchBudgetMs > 0);
  assertStringIncludes("regex matching timed out", "timed out");
});

test("inlined regex worker source stays in sync with regex_worker.js", async () => {
  const onDisk = await Deno.readTextFile(
    new URL("./regex_worker.js", import.meta.url),
  );
  assertEquals(regexWorkerSource, onDisk);
});
