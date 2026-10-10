import { runtime } from "../platform/runtime.ts";
import { assert, assertEquals, assertFalse } from "../compat/assert.ts";
import * as path from "../compat/path.ts";
import {
  buildContextString,
  defaultRuleContent,
  ensureRuleFile,
  type FileContent,
  loadContextFiles,
  loadRuleFile,
  ruleFile,
} from "./mod.ts";
import { test } from "#testing";

function contains(s: string, substr: string): boolean {
  return s.includes(substr);
}

test("loadContextFiles", () => {
  const tmpDir = runtime.makeTempDirSync();
  try {
    const projectDir = path.join(tmpDir, "project");
    const globalDir = path.join(tmpDir, "global");

    runtime.mkdirSync(projectDir, { recursive: true });
    runtime.mkdirSync(globalDir, { recursive: true });

    runtime.writeTextFileSync(
      path.join(projectDir, "AGENTS.md"),
      "# Project Agent",
    );
    runtime.writeTextFileSync(
      path.join(globalDir, "AGENTS.md"),
      "# Global Config",
    );

    const result = loadContextFiles(projectDir, globalDir, null);

    assertEquals(result.projectFiles.length, 1);
    assertEquals(result.globalFiles.length, 1);
    assertEquals(result.projectFiles[0].name, "AGENTS.md");
  } finally {
    runtime.removeSync(tmpDir, { recursive: true });
  }
});

test("buildContextString", () => {
  const result = {
    globalFiles: [] as FileContent[],
    parentFiles: [] as FileContent[],
    projectFiles: [
      { name: "AGENTS.md", path: "/test/AGENTS.md", content: "# Test Content" },
    ],
  };

  const context = buildContextString(result);

  assert(context !== "");
  assert(contains(context, "AGENTS.md"));
  assert(contains(context, "# Test Content"));
});

test("buildContextString empty", () => {
  const result = { globalFiles: [], parentFiles: [], projectFiles: [] };
  assertEquals(buildContextString(result), "");
});

test("extraFiles", () => {
  const tmpDir = runtime.makeTempDirSync();
  try {
    runtime.writeTextFileSync(path.join(tmpDir, "CUSTOM.md"), "# Custom");

    const result = loadContextFiles(tmpDir, "", ["CUSTOM.md"]);

    assertEquals(result.projectFiles.length, 1);
    assertEquals(result.projectFiles[0].name, "CUSTOM.md");
  } finally {
    runtime.removeSync(tmpDir, { recursive: true });
  }
});

test("extraFiles cannot escape base dir", () => {
  const tmpDir = runtime.makeTempDirSync();
  try {
    const projectDir = path.join(tmpDir, "project");
    runtime.mkdirSync(projectDir, { recursive: true });

    runtime.writeTextFileSync(path.join(tmpDir, "SECRET.md"), "# Secret");
    runtime.writeTextFileSync(path.join(projectDir, "SAFE.md"), "# Safe");

    const result = loadContextFiles(projectDir, "", [
      "../SECRET.md",
      path.join(tmpDir, "SECRET.md"),
      "SAFE.md",
    ]);

    assertEquals(result.projectFiles.length, 1);
    assertEquals(result.projectFiles[0].name, "SAFE.md");
  } finally {
    runtime.removeSync(tmpDir, { recursive: true });
  }
});

test("loadRuleFile missing does not create file", () => {
  const tmpDir = runtime.makeTempDirSync();
  try {
    assertEquals(loadRuleFile(tmpDir), "");

    const rulePath = path.join(tmpDir, ruleFile);
    let exists = true;
    try {
      runtime.statSync(rulePath);
    } catch (err) {
      exists = !(err instanceof runtime.errors.NotFound);
    }
    assertFalse(exists, `loadRuleFile created ${rulePath}`);
  } finally {
    runtime.removeSync(tmpDir, { recursive: true });
  }
});

test("loadRuleFile reads project rule", () => {
  const tmpDir = runtime.makeTempDirSync();
  try {
    const rulePath = path.join(tmpDir, ruleFile);
    runtime.mkdirSync(path.dirname(rulePath), { recursive: true });
    runtime.writeTextFileSync(rulePath, "follow local rules\n");

    assertEquals(loadRuleFile(tmpDir), "follow local rules\n");
  } finally {
    runtime.removeSync(tmpDir, { recursive: true });
  }
});

test("ensureRuleFile creates default", () => {
  const tmpDir = runtime.makeTempDirSync();
  try {
    const { path: p, content, written } = ensureRuleFile(tmpDir, false);
    assert(written);
    assertEquals(p, path.join(tmpDir, ruleFile));
    assertEquals(content, defaultRuleContent);
    assertEquals(runtime.readTextFileSync(p), defaultRuleContent);
  } finally {
    runtime.removeSync(tmpDir, { recursive: true });
  }
});

test("ensureRuleFile preserves existing unless forced", () => {
  const tmpDir = runtime.makeTempDirSync();
  try {
    const rulePath = path.join(tmpDir, ruleFile);
    runtime.mkdirSync(path.dirname(rulePath), { recursive: true });
    runtime.writeTextFileSync(rulePath, "custom rule");

    let res = ensureRuleFile(tmpDir, false);
    assertFalse(res.written);
    assertEquals(res.content, "custom rule");

    res = ensureRuleFile(tmpDir, true);
    assert(res.written);
    assertEquals(res.content, defaultRuleContent);
  } finally {
    runtime.removeSync(tmpDir, { recursive: true });
  }
});

test("parent files", () => {
  const tmpDir = runtime.makeTempDirSync();
  try {
    const parentDir = path.join(tmpDir, "parent");
    const childDir = path.join(parentDir, "child");

    runtime.mkdirSync(childDir, { recursive: true });

    runtime.writeTextFileSync(
      path.join(parentDir, "AGENTS.md"),
      "# Parent Config",
    );

    const result = loadContextFiles(childDir, "", null);

    assertEquals(result.parentFiles.length, 1);
    assertEquals(result.parentFiles[0].name, "AGENTS.md");
  } finally {
    runtime.removeSync(tmpDir, { recursive: true });
  }
});

test("defaultRuleContent matches project rule template", () => {
  assert(defaultRuleContent.startsWith("# Project Rules\n"));
  assert(defaultRuleContent.endsWith("\n"));
});
