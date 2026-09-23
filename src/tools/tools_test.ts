//
// Covers the Registry, the standard tools (read/ls/write/edit/insert/plan/
// find/grep/bash/jobs/kill/question/skill_ref/image_generation),
// the file-diff and atomic-write helpers, the file-lock manager, the globset/
// ignore helpers, and the job manager.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import type { Manager as SkillsManager } from "../skills/mod.ts";
import {
  BashTool,
  buildFileDiff,
  FileLockManager,
  FindTool,
  GlobSet,
  GrepTool,
  IgnoreStack,
  ImageGenerationTool,
  InsertTool,
  JobsTool,
  KillTool,
  LsTool,
  newRegistry,
  newRegistryWithConfig,
  PlanTool,
  QuestionTool,
  ReadTool,
  SkillRefTool,
  type Tool,
  type ToolContext,
  type ToolResult,
  writeFileAtomic,
  WriteTool,
} from "./mod.ts";
import { newJobManager } from "./jobmanager.ts";
import { formatGoDuration } from "./jobmanager.ts";
import { EditTool } from "./edit.ts";
import { newBashToolWithJobManager } from "./bash.ts";

function tempDir(): string {
  return Deno.makeTempDirSync();
}

function writeText(p: string, text: string): void {
  Deno.writeTextFileSync(p, text);
}

function readText(p: string): string {
  return Deno.readTextFileSync(p);
}

const ctx: ToolContext = {};

/** Asserts that `fn` throws or rejects, tolerating sync and async tools. */
async function expectRejects(fn: () => unknown): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert(threw, "expected the call to fail");
}

Deno.test("operation id context helpers", () => {
  const withId = { ...ctx, operationId: "op-1" };
  assertEquals(withId.operationId, "op-1");
});

Deno.test("NewRegistry and register/get/remove", () => {
  const r = newRegistry("/tmp", undefined);
  const plan = new PlanTool(r);
  r.register(plan);
  const tool = r.get("plan");
  assert(tool !== undefined);
  assertEquals(tool.name(), "plan");
  r.remove("plan");
  assertEquals(r.get("plan"), undefined);
});

Deno.test("RegisterDefaults registers the standard tool set", () => {
  const r = newRegistry("/tmp", undefined);
  r.registerDefaults();
  const expected = [
    "read",
    "write",
    "edit",
    "insert",
    "bash",
    "jobs",
    "kill",
    "grep",
    "find",
    "ls",
    "plan",
  ];
  for (const name of expected) {
    assert(r.get(name) !== undefined, `expected tool ${name}`);
  }
});

Deno.test("RegisterDefaultsWithPlanTool(false) omits plan", () => {
  const r = newRegistry("/tmp", undefined);
  r.registerDefaultsWithPlanTool(false);
  assertEquals(r.get("plan"), undefined);
});

Deno.test("ModeTools filters by mode", () => {
  const r = newRegistry("/tmp", undefined);
  r.registerDefaults();

  const planNames = new Set(r.modeTools("plan").map((t) => t.name));
  assert(planNames.has("read"));
  assert(planNames.has("grep"));
  assert(planNames.has("plan"));
  assert(!planNames.has("write"));
  assert(!planNames.has("bash"));

  assertEquals(r.modeTools("agent").length, 11);

  const osNames = r.modeTools("os").map((t) => t.name);
  assertEquals(osNames, ["bash"]);
});

Deno.test("PlanTool formats and returns a structured plan", async () => {
  const r = newRegistry("/tmp", undefined);
  const tool = new PlanTool(r);
  const result = await tool.execute(ctx, {
    title: "Ship feature",
    steps: [
      { title: "Read code", status: "done" },
      { title: "Implement change", status: "running" },
    ],
    note: "Keep scope small",
  });
  assert(result.plan);
  assertEquals(result.plan.title, "Ship feature");
  assertEquals(result.plan.steps.length, 2);
  assertEquals(result.plan.steps[1].status, "running");
  assertStringIncludes(result.text, "[running] Implement change");
});

Deno.test("PlanTool rejects empty steps and bad status", async () => {
  const r = newRegistry("/tmp", undefined);
  const tool = new PlanTool(r);
  await expectRejects(() => tool.execute(ctx, { steps: [] }));
  await expectRejects(() =>
    tool.execute(ctx, { steps: [{ title: "x", status: "bogus" }] })
  );
});

Deno.test("ReadTool reads numbered lines with offset and limit", async () => {
  const dir = tempDir();
  const file = path.join(dir, "a.txt");
  writeText(file, "one\ntwo\nthree\nfour\n");
  const r = newRegistry(dir, undefined);
  const tool = new ReadTool(r);

  const all = await tool.execute(ctx, { path: "a.txt" });
  assertStringIncludes(all.text, "1\tone\n");
  assertStringIncludes(all.text, "4\tfour\n");

  const limited = await tool.execute(ctx, {
    path: "a.txt",
    offset: 2,
    limit: 2,
  });
  assertStringIncludes(limited.text, "2\ttwo\n");
  assertStringIncludes(limited.text, "3\tthree\n");
  assert(!limited.text.includes("1\tone"));

  const pastEnd = await tool.execute(ctx, { path: "a.txt", offset: 99 });
  assertEquals(pastEnd.text, "(end of file)");
});

Deno.test("ReadTool rejects path escape", async () => {
  const dir = tempDir();
  const r = newRegistry(dir, undefined);
  const tool = new ReadTool(r);
  await expectRejects(() => tool.execute(ctx, { path: "../../etc/passwd" }));
});

Deno.test("ReadTool rejects a missing required path", async () => {
  const r = newRegistry("/tmp", undefined);
  const tool = new ReadTool(r);
  await expectRejects(() => tool.execute(ctx, {}));
});

Deno.test("WriteTool writes and reports a diff", async () => {
  const dir = tempDir();
  const r = newRegistry(dir, undefined);
  const tool = new WriteTool(r);
  const result = await tool.execute(ctx, {
    path: "out.txt",
    content: "hello world",
  });
  assertEquals(readText(path.join(dir, "out.txt")), "hello world");
  assert(result.diff);
  assertStringIncludes(result.text, "File written:");
});

Deno.test("EditTool applies multiple disjoint edits", async () => {
  const dir = tempDir();
  const file = path.join(dir, "e.txt");
  writeText(file, "alpha beta gamma");
  const r = newRegistry(dir, undefined);
  const tool = new EditTool(r);
  const result = await tool.execute(ctx, {
    path: "e.txt",
    edits: [
      { oldText: "alpha", newText: "ALPHA" },
      { oldText: "gamma", newText: "GAMMA" },
    ],
  });
  assertEquals(readText(file), "ALPHA beta GAMMA");
  assert(result.diff);
});

Deno.test("EditTool rejects non-unique and missing oldText", async () => {
  const dir = tempDir();
  const file = path.join(dir, "e.txt");
  writeText(file, "x x");
  const r = newRegistry(dir, undefined);
  const tool = new EditTool(r);
  await expectRejects(() =>
    tool.execute(ctx, {
      path: "e.txt",
      edits: [{ oldText: "x", newText: "y" }],
    })
  );
  await expectRejects(() =>
    tool.execute(ctx, {
      path: "e.txt",
      edits: [{ oldText: "zzz", newText: "y" }],
    })
  );
});

Deno.test("EditTool rejects overlapping edits", async () => {
  const dir = tempDir();
  const file = path.join(dir, "e.txt");
  writeText(file, "abcdef");
  const r = newRegistry(dir, undefined);
  const tool = new EditTool(r);
  await expectRejects(() =>
    tool.execute(ctx, {
      path: "e.txt",
      edits: [
        { oldText: "abc", newText: "x" },
        { oldText: "bcd", newText: "y" },
      ],
    })
  );
});

Deno.test("InsertTool positions", async () => {
  const cases: Array<{ position: Record<string, unknown>; want: string }> = [
    { position: { type: "head" }, want: "X\na\nb\n" },
    { position: { type: "tail" }, want: "a\nb\nX" },
    { position: { type: "before_line", line: 2 }, want: "a\nX\nb\n" },
    { position: { type: "after_line", line: 1 }, want: "a\nX\nb\n" },
  ];
  for (const tc of cases) {
    const dir = tempDir();
    const file = path.join(dir, "file.txt");
    writeText(file, "a\nb\n");
    const tool = new InsertTool(newRegistry(dir, undefined));
    await tool.execute(ctx, {
      path: "file.txt",
      content: "X",
      position: tc.position,
    });
    assertEquals(readText(file), tc.want);
  }
});

Deno.test("InsertTool dedupe and dry run", async () => {
  const dir = tempDir();
  const file = path.join(dir, "file.txt");
  writeText(file, "a\nb\n");
  const tool = new InsertTool(newRegistry(dir, undefined));

  const dedupe = await tool.execute(ctx, {
    path: "file.txt",
    content: "b\n",
    position: { type: "tail" },
    dedupe: { enabled: true, mode: "line" },
  });
  assertEquals(dedupe.diff, undefined);
  assertStringIncludes(dedupe.text, "already exists");

  const dry = await tool.execute(ctx, {
    path: "file.txt",
    content: "c\n",
    position: { type: "tail" },
    dry_run: true,
  });
  assert(dry.diff);
  assert(dry.insert);
  assert(dry.insert.dryRun);
  assertEquals(dry.insert.position, "tail");
  assertEquals(readText(file), "a\nb\n");
});

Deno.test("InsertTool rejects match position and out-of-range line", async () => {
  const dir = tempDir();
  const file = path.join(dir, "file.txt");
  writeText(file, "a\n");
  const tool = new InsertTool(newRegistry(dir, undefined));

  await expectRejects(() =>
    tool.execute(ctx, {
      path: "file.txt",
      content: "x",
      position: { type: "after_match", match: "a" },
    })
  );
  await expectRejects(() =>
    tool.execute(ctx, {
      path: "file.txt",
      content: "x",
      position: { type: "before_line", line: 3 },
    })
  );
});

Deno.test("FindTool finds files and respects maxDepth", async () => {
  const dir = tempDir();
  writeText(path.join(dir, "test.txt"), "Hello");
  writeText(path.join(dir, "test.go"), "package main");
  const nested = path.join(dir, "nested");
  Deno.mkdirSync(nested);
  writeText(path.join(nested, "nested.go"), "package nested");

  const tool = new FindTool(newRegistry(dir, undefined));
  const byTxt = await tool.execute(ctx, { pattern: "*.txt", path: "." });
  assertStringIncludes(byTxt.text, "test.txt");
  assert(!byTxt.text.includes("test.go"));

  const depth = await tool.execute(ctx, {
    pattern: "*.go",
    path: ".",
    maxDepth: 1,
  });
  assertStringIncludes(depth.text, "root.go".replace("root", "test"));
  assert(!depth.text.includes("nested.go"));

  await expectRejects(() =>
    tool.execute(ctx, { pattern: "*.txt", path: "missing" })
  );
});

Deno.test("GrepTool searches, filters by include and respects gitignore", async () => {
  const dir = tempDir();
  writeText(path.join(dir, "one.go"), "package main\nfunc Hello() {}\n");
  writeText(path.join(dir, "two.txt"), "Hello text\n");
  writeText(path.join(dir, ".gitignore"), "ignored.go\n");
  writeText(path.join(dir, "kept.go"), "func Kept() {}\n");
  writeText(path.join(dir, "ignored.go"), "func Ignored() {}\n");

  const tool = new GrepTool(newRegistry(dir, undefined));

  const include = await tool.execute(ctx, {
    pattern: "Hello",
    path: ".",
    include: "*.go",
  });
  assertStringIncludes(include.text, "one.go");
  assert(!include.text.includes("two.txt"));

  const gitignored = await tool.execute(ctx, {
    pattern: "func",
    path: ".",
    include: "*.go",
  });
  assertStringIncludes(gitignored.text, "kept.go");
  assert(!gitignored.text.includes("ignored.go"));
});

Deno.test("GrepTool limits total results and falls back to literal", async () => {
  const dir = tempDir();
  for (let i = 0; i < 5; i++) {
    writeText(path.join(dir, `file${i}.txt`), "match one\nmatch two\n");
  }
  const tool = new GrepTool(newRegistry(dir, undefined));

  const limited = await tool.execute(ctx, {
    pattern: "match",
    path: ".",
    maxResults: 3,
  });
  const matches =
    limited.text.split("\n").filter((l) => l.includes("match")).length;
  assertEquals(matches, 3);
  assertStringIncludes(limited.text, "truncated");

  const literalDir = tempDir();
  writeText(path.join(literalDir, "test.txt"), "Hello");
  const literalTool = new GrepTool(newRegistry(literalDir, undefined));
  const literal = await literalTool.execute(ctx, { pattern: "[", path: "." });
  assertStringIncludes(
    literal.text,
    "(invalid regex; fell back to literal search)",
  );
  assertStringIncludes(literal.text, "(no matches found)");
});

Deno.test("GrepTool skips oversized files instead of buffering them", async () => {
  const dir = tempDir();
  writeText(
    path.join(dir, "huge.txt"),
    "needle here\n" + "x".repeat(17 * 1024 * 1024),
  );
  writeText(path.join(dir, "small.txt"), "needle here\n");
  const tool = new GrepTool(newRegistry(dir, undefined));

  const result = await tool.execute(ctx, { pattern: "needle", path: "." });
  assertStringIncludes(result.text, "small.txt");
  assert(!result.text.includes("huge.txt"), "oversized file must not be read");
  assertStringIncludes(result.text, "skipped 1 files");
});

Deno.test("LsTool lists directory entries", async () => {
  const dir = tempDir();
  writeText(path.join(dir, "a.txt"), "hi");
  Deno.mkdirSync(path.join(dir, "sub"));
  const tool = new LsTool(newRegistry(dir, undefined));
  const result = await tool.execute(ctx, {});
  assertStringIncludes(result.text, "a.txt");
  assertStringIncludes(result.text, "sub/");
});

Deno.test("BashTool runs a sync command", async () => {
  const tool = new BashTool(newRegistry("/tmp", undefined), newJobManager());
  const result = await tool.execute(ctx, { command: "echo hello" });
  assertStringIncludes(result.text, "[runtime]\n");
  assertStringIncludes(result.text, "[command]\necho hello");
  assertStringIncludes(result.text, "[stdout]\nhello");
  assertStringIncludes(result.text, "[stderr]\n(no output)");
  assertStringIncludes(result.text, "[exit_code]\n0");
});

Deno.test("BashTool captures stderr and non-zero exit code", async () => {
  const tool = new BashTool(newRegistry("/tmp", undefined), newJobManager());
  const stderr = await tool.execute(ctx, { command: "echo problem >&2" });
  assertStringIncludes(stderr.text, "[stdout]\n(no output)");
  assertStringIncludes(stderr.text, "[stderr]\nproblem");

  const failing = await tool.execute(ctx, { command: "exit 3" });
  assertStringIncludes(failing.text, "[exit_code]\n3");
});

Deno.test("BashTool uses non-interactive auth env", async () => {
  const tool = new BashTool(newRegistry("/tmp", undefined), newJobManager());
  const result = await tool.execute(ctx, {
    command:
      'printf \'%s:%s:%s:%s\' "$GIT_TERMINAL_PROMPT" "$GIT_ASKPASS" "$SSH_ASKPASS" "$SSH_ASKPASS_REQUIRE"',
  });
  assertStringIncludes(result.text, "[stdout]\n0:true:true:never");
});

Deno.test("BashTool async creates a job that jobs/kill can manage", async () => {
  const jm = newJobManager();
  const r = newRegistry("/tmp", undefined);
  const bash = newBashToolWithJobManager(r, jm);
  const jobs = new JobsTool(r, bash);
  const kill = new KillTool(r, bash);

  const started = await bash.execute(ctx, {
    command: "sleep 5",
    async: true,
  });
  assertStringIncludes(started.text, "Use 'jobs' tool to check status");

  const listed = await jobs.execute(ctx, {});
  assertStringIncludes(listed.text, "running");

  const detail = await jobs.execute(ctx, { jobId: 1 });
  assertStringIncludes(detail.text, "Job ID:    1");

  const killed = await kill.execute(ctx, { jobId: 1 });
  assertStringIncludes(killed.text, "Sent kill signal to job 1");

  await expectRejects(() => jobs.execute(ctx, { jobId: 99 }));
});

Deno.test("BashTool honors a parent abort signal", async () => {
  const tool = new BashTool(newRegistry("/tmp", undefined), newJobManager());
  const controller = new AbortController();
  const promise = tool.execute({ signal: controller.signal }, {
    command: "sleep 5",
  });
  controller.abort();
  const result = await promise;
  // The abort terminates the process; the result still carries diagnostics.
  assertStringIncludes(result.text, "[exit_code]\n");
});

Deno.test("QuestionTool asks via the attached asker", async () => {
  const r = newRegistry("/tmp", undefined);
  const tool = new QuestionTool(r);
  const withAsker: ToolContext = {
    questionAsker: {
      askQuestion: (_ctx, _q, _options, _c) => "Option A",
    },
  };
  const result = await tool.execute(withAsker, {
    question: "Pick one",
    options: ["Option A", "Option B"],
  });
  assertStringIncludes(result.text, "User answered: Option A");

  await expectRejects(() =>
    tool.execute({}, { question: "Pick", options: ["a"] })
  );
  await expectRejects(() => tool.execute({}, {}));
});

Deno.test("SkillRefTool loads a reference from a fake manager", async () => {
  const fake = {
    loadReference: (skill: string, ref: string) =>
      skill === "demo" && ref === "references/x.md" ? "content!" : undefined,
    listReferences: (_skill: string) => undefined,
  } as unknown as SkillsManager;
  const tool = new SkillRefTool(fake);
  const result = tool.execute(ctx, {
    skill: "demo",
    ref: "references/x.md",
  }) as ToolResult;
  assertEquals(result.text, "content!");
  await expectRejects(async () =>
    await tool.execute(ctx, { skill: "missing", ref: "a" })
  );
});

Deno.test("ImageGenerationTool rejects when disabled", async () => {
  const tool = new ImageGenerationTool(undefined);
  await expectRejects(() => tool.execute(ctx, { prompt: "a cat" }));
});

Deno.test("buildFileDiff reports added and deleted lines", () => {
  const diff = buildFileDiff("f.txt", "a\nb\nc\n", "a\nB\nc\nd\n");
  assertEquals(diff.path, "f.txt");
  assert(diff.added >= 1);
  assert(diff.deleted >= 1);
  assertStringIncludes(diff.unified, "--- f.txt");
});

Deno.test("writeFileAtomic writes and leaves no temp file", () => {
  const dir = tempDir();
  const file = path.join(dir, "out.txt");
  writeFileAtomic(file, new TextEncoder().encode("hello world"));
  assertEquals(readText(file), "hello world");
  for (const entry of Deno.readDirSync(dir)) {
    assert(!entry.name.startsWith(".tmp-"), `leftover temp file ${entry.name}`);
  }
});

Deno.test("file lock manager waits and cancels", async () => {
  const mgr = new FileLockManager();
  const file = path.join(tempDir(), "locked.txt");
  const release = await mgr.acquire(undefined, file, "first");

  const controller = new AbortController();
  const second = mgr.acquire(controller.signal, file, "second");
  controller.abort();
  await expectRejects(() => second);

  release();

  const releaseAgain = await mgr.acquire(undefined, file, "third");
  releaseAgain();
});

/** Resolves `p` within `ms`, failing instead of hanging the suite. */
async function withDeadline<T>(p: Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${ms}ms (deadlock?)`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

Deno.test("file lock manager hands the lock to the next waiter", async () => {
  const mgr = new FileLockManager();
  const file = path.join(tempDir(), "locked.txt");
  const order: string[] = [];

  const first = await mgr.acquire(undefined, file, "first");
  const second = mgr.acquire(undefined, file, "second").then((release) => {
    order.push("second");
    return release;
  });
  const third = mgr.acquire(undefined, file, "third").then((release) => {
    order.push("third");
    return release;
  });

  first();
  const releaseSecond = await withDeadline(second);
  assertEquals(order, ["second"]);

  releaseSecond();
  const releaseThird = await withDeadline(third);
  assertEquals(order, ["second", "third"]);
  releaseThird();

  // The queue drained cleanly: a fresh acquire is immediate.
  const releaseFourth = await withDeadline(
    mgr.acquire(undefined, file, "fourth"),
  );
  releaseFourth();
});

Deno.test("file lock manager survives an aborted waiter in the queue", async () => {
  const mgr = new FileLockManager();
  const file = path.join(tempDir(), "locked.txt");
  const first = await mgr.acquire(undefined, file, "first");

  const controller = new AbortController();
  const aborted = mgr.acquire(controller.signal, file, "aborted");
  const next = mgr.acquire(undefined, file, "next").then((release) => release);
  controller.abort();
  await expectRejects(() => aborted);

  first();
  // The aborted waiter must not swallow the handoff and poison the lock.
  const releaseNext = await withDeadline(next);
  releaseNext();
});

Deno.test("EditTool serializes concurrent edits to the same file", async () => {
  const dir = tempDir();
  const file = path.join(dir, "e.txt");
  writeText(file, "alpha beta gamma");
  const r = newRegistry(dir, undefined);
  const tool = new EditTool(r);

  await withDeadline(
    Promise.all([
      tool.execute(ctx, {
        path: "e.txt",
        edits: [{ oldText: "alpha", newText: "ALPHA" }],
      }),
      tool.execute(ctx, {
        path: "e.txt",
        edits: [{ oldText: "gamma", newText: "GAMMA" }],
      }),
    ]),
  );
  assertEquals(readText(file), "ALPHA beta GAMMA");
});

Deno.test("default registries share a file lock manager", () => {
  const r1 = newRegistry(tempDir(), undefined);
  const r2 = newRegistry(tempDir(), undefined);
  assertEquals(r1.fileLocks() === r2.fileLocks(), true);
});

Deno.test("RegistryResolvePath resolves and rejects escapes", async () => {
  const r = newRegistry("/home/user/project", undefined);
  assertEquals(
    r.resolvePath("src/main.go"),
    "/home/user/project/src/main.go",
  );
  assertEquals(r.resolvePath("/home/user/project"), "/home/user/project");
  await expectRejects(() => Promise.resolve(r.resolvePath("../../etc/passwd")));
  await expectRejects(() =>
    Promise.resolve(r.resolvePath("/home/user/project2/file.txt"))
  );
});

Deno.test("RegistryConfig registers filtered tools", () => {
  const all = newRegistryWithConfig({ workDir: "/tmp" });
  assert(all.all().length > 0);

  const filtered = newRegistryWithConfig({
    workDir: "/tmp",
    toolFilter: ["read", "write"],
  });
  assertEquals(filtered.all().length, 2);
  assert(filtered.get("read") !== undefined);
  assert(filtered.get("write") !== undefined);
  assert(filtered.get("bash") === undefined);
});

Deno.test("Registry job managers are per-instance", () => {
  const r1 = newRegistry("/tmp", undefined);
  const r2 = newRegistry("/tmp", undefined);
  assert(r1.jobManager() !== r2.jobManager());
});

Deno.test("tool snippets and guidelines are gathered", () => {
  const r = newRegistry("/tmp", undefined);
  r.registerDefaults();
  const snippets = r.toolSnippets(["read", "write", "bash"]);
  assert(Object.keys(snippets).length >= 3);
  const guidelines = r.toolGuidelines(["read", "write", "bash"]);
  assert(guidelines.length >= 1);
});

Deno.test("ToolDefinition exposes name/description/parameters", () => {
  const r = newRegistry("/tmp", undefined);
  const tool: Tool = new ReadTool(r);
  const def = { name: tool.name(), description: tool.description() };
  assertEquals(def.name, "read");
  assert(def.description.length > 0);
  assert(tool.parameters() !== undefined);
});

Deno.test("mode tools for plan does not include write/bash", () => {
  const r = newRegistry("/tmp", undefined);
  r.registerDefaults();
  const planNames = new Set(r.modeTools("plan").map((t) => t.name));
  assert(planNames.has("read"));
  assert(planNames.has("plan"));
  assert(!planNames.has("write"));
  assert(!planNames.has("bash"));
});

Deno.test("GlobSet matches anchored, unanchored, and negated patterns", () => {
  const gs = GlobSet.newGlobSet(["*.go", "!main.go", "bin/"]);
  // An unanchored pattern matches any path component.
  assertEquals(gs.match("src/app.go").isIgnored, true);
  assertEquals(gs.match("main.go").isIgnored, false);
  assertEquals(gs.matchGlobFilter("app.go"), false);
  assertEquals(gs.matchGlobFilter("app.txt"), true);
});

Deno.test("IgnoreStack honors hidden and gitignore rules", () => {
  const dir = tempDir();
  writeText(path.join(dir, ".gitignore"), "ignored.go\n");
  const stack = new IgnoreStack(false, false, 0);
  stack.loadBaseRules(dir);
  stack.push(dir);

  assert(stack.isIgnored(path.join(dir, ".hidden"), false));
  assert(stack.isIgnored(path.join(dir, "ignored.go"), false));
  assert(!stack.isIgnored(path.join(dir, "kept.go"), false));
});

Deno.test("formatGoDuration matches Go duration strings", () => {
  assertEquals(formatGoDuration(0), "0s");
  assertEquals(formatGoDuration(5000), "5s");
  assertEquals(formatGoDuration(90000), "1m30s");
  assertEquals(formatGoDuration(3600000), "1h0m0s");
});
