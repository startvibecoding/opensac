import { assertEquals, assertStringIncludes } from "../compat/assert.ts";
import * as path from "../compat/path.ts";
import { extractSection, Store } from "./store.ts";
import { test } from "#testing";

test("StoreReadWrite", () => {
  const dir = Deno.makeTempDirSync();
  const p = path.join(dir, "memory.md");

  const store = new Store(p, "");

  // No file yet.
  let res = store.read();
  assertEquals(res.content, "");

  // Add creates file.
  store.add("User Profile", "prefers Go");

  res = store.read();
  assertEquals(res.path, p);
  assertEquals(res.source, "explicit");
  assertStringIncludes(res.content, "- prefers Go");
});

test("StoreReadSection", () => {
  const dir = Deno.makeTempDirSync();
  const p = path.join(dir, "memory.md");

  const md = `# Agent Memory

## User Profile

- likes Go
- prefers vim

## Working Memory

- project version is v0.1.27

## Lessons Learned

- always read before edit
`;
  Deno.writeTextFileSync(p, md, { mode: 0o600 });
  const store = new Store(p, "");

  let section = store.readSection("User Profile");
  assertStringIncludes(section, "likes Go");
  assertEquals(section.includes("project version"), false);

  section = store.readSection("Working Memory");
  assertStringIncludes(section, "project version");

  section = store.readSection("Nonexistent");
  assertEquals(section, "");
});

test("StoreAdd", () => {
  const dir = Deno.makeTempDirSync();
  const p = path.join(dir, "memory.md");

  const md = `# Agent Memory

## User Profile

- likes Go

## Working Memory
`;
  Deno.writeTextFileSync(p, md, { mode: 0o600 });
  const store = new Store(p, "");

  store.add("Working Memory", "new fact");

  const { content } = store.read();
  assertStringIncludes(content, "- new fact");
  assertStringIncludes(content, "- likes Go");
});

test("StoreUpdate", () => {
  const dir = Deno.makeTempDirSync();
  const p = path.join(dir, "memory.md");

  const md = `# Agent Memory

## Working Memory

- version is v0.1.26
`;
  Deno.writeTextFileSync(p, md, { mode: 0o600 });
  const store = new Store(p, "");

  store.update("Working Memory", "v0.1.26", "v0.1.27");

  const { content } = store.read();
  assertStringIncludes(content, "v0.1.27");
  assertEquals(content.includes("v0.1.26"), false);
});

test("StoreUpdateOnlyWithinSection", () => {
  const dir = Deno.makeTempDirSync();
  const p = path.join(dir, "memory.md");

  const md = `# Agent Memory

## User Profile

- shared fact

## Working Memory

- shared fact
`;
  Deno.writeTextFileSync(p, md, { mode: 0o600 });
  const store = new Store(p, "");

  store.update("Working Memory", "shared fact", "working fact");

  const { content } = store.read();
  assertStringIncludes(content, "## User Profile\n\n- shared fact");
  assertStringIncludes(content, "## Working Memory\n\n- working fact");
});

test("StoreDelete", () => {
  const dir = Deno.makeTempDirSync();
  const p = path.join(dir, "memory.md");

  const md = `# Agent Memory

## Working Memory

- fact one
- fact two
- fact three
`;
  Deno.writeTextFileSync(p, md, { mode: 0o600 });
  const store = new Store(p, "");

  store.delete("Working Memory", "fact two");

  const { content } = store.read();
  assertEquals(content.includes("fact two"), false);
  assertStringIncludes(content, "fact one");
  assertStringIncludes(content, "fact three");
});

test("StoreDeleteOnlyWithinSection", () => {
  const dir = Deno.makeTempDirSync();
  const p = path.join(dir, "memory.md");

  const md = `# Agent Memory

## User Profile

- shared fact

## Working Memory

- shared fact
`;
  Deno.writeTextFileSync(p, md, { mode: 0o600 });
  const store = new Store(p, "");

  store.delete("Working Memory", "shared fact");

  const { content } = store.read();
  assertStringIncludes(content, "## User Profile\n\n- shared fact");
  const working = extractSection(content, "Working Memory");
  assertEquals(working.includes("shared fact"), false);
});

test("StoreWriteAllUsesReadPath", () => {
  const dir = Deno.makeTempDirSync();
  const p = path.join(dir, "memory.md");
  Deno.writeTextFileSync(p, "# old", { mode: 0o600 });
  const store = new Store(p, "");

  store.writeAll("# new");

  const got = Deno.readTextFileSync(p);
  assertEquals(got, "# new");
});

test("StoreAddNewSection", () => {
  const dir = Deno.makeTempDirSync();
  const p = path.join(dir, "memory.md");

  const md = `# Agent Memory

## User Profile

- likes Go
`;
  Deno.writeTextFileSync(p, md, { mode: 0o600 });
  const store = new Store(p, "");

  store.add("Custom Section", "custom fact");

  const { content } = store.read();
  assertStringIncludes(content, "## Custom Section");
  assertStringIncludes(content, "- custom fact");
});

test("ExtractSection", () => {
  const content = `# Memory

## First

- a
- b

## Second

- c

## Third

- d
`;
  assertEquals(extractSection(content, "First"), "- a\n- b");
  assertEquals(extractSection(content, "Second"), "- c");
  assertEquals(extractSection(content, "Third"), "- d");
  assertEquals(extractSection(content, "Missing"), "");
});
