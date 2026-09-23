import { assert, assertEquals, assertFalse } from "@std/assert";
import * as path from "@std/path";
import {
  buildContextString,
  defaultRuleContent,
  ensureRuleFile,
  type FileContent,
  loadContextFiles,
  loadRuleFile,
  ruleFile,
} from "./mod.ts";

function contains(s: string, substr: string): boolean {
  return s.includes(substr);
}

Deno.test("loadContextFiles", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const projectDir = path.join(tmpDir, "project");
    const globalDir = path.join(tmpDir, "global");

    Deno.mkdirSync(projectDir, { recursive: true });
    Deno.mkdirSync(globalDir, { recursive: true });

    Deno.writeTextFileSync(
      path.join(projectDir, "AGENTS.md"),
      "# Project Agent",
    );
    Deno.writeTextFileSync(
      path.join(globalDir, "AGENTS.md"),
      "# Global Config",
    );

    const result = loadContextFiles(projectDir, globalDir, null);

    assertEquals(result.projectFiles.length, 1);
    assertEquals(result.globalFiles.length, 1);
    assertEquals(result.projectFiles[0].name, "AGENTS.md");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("buildContextString", () => {
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

Deno.test("buildContextString empty", () => {
  const result = { globalFiles: [], parentFiles: [], projectFiles: [] };
  assertEquals(buildContextString(result), "");
});

Deno.test("extraFiles", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(path.join(tmpDir, "CUSTOM.md"), "# Custom");

    const result = loadContextFiles(tmpDir, "", ["CUSTOM.md"]);

    assertEquals(result.projectFiles.length, 1);
    assertEquals(result.projectFiles[0].name, "CUSTOM.md");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("extraFiles cannot escape base dir", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const projectDir = path.join(tmpDir, "project");
    Deno.mkdirSync(projectDir, { recursive: true });

    Deno.writeTextFileSync(path.join(tmpDir, "SECRET.md"), "# Secret");
    Deno.writeTextFileSync(path.join(projectDir, "SAFE.md"), "# Safe");

    const result = loadContextFiles(projectDir, "", [
      "../SECRET.md",
      path.join(tmpDir, "SECRET.md"),
      "SAFE.md",
    ]);

    assertEquals(result.projectFiles.length, 1);
    assertEquals(result.projectFiles[0].name, "SAFE.md");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("loadRuleFile missing does not create file", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    assertEquals(loadRuleFile(tmpDir), "");

    const rulePath = path.join(tmpDir, ruleFile);
    let exists = true;
    try {
      Deno.statSync(rulePath);
    } catch (err) {
      exists = !(err instanceof Deno.errors.NotFound);
    }
    assertFalse(exists, `loadRuleFile created ${rulePath}`);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("loadRuleFile reads project rule", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const rulePath = path.join(tmpDir, ruleFile);
    Deno.mkdirSync(path.dirname(rulePath), { recursive: true });
    Deno.writeTextFileSync(rulePath, "follow local rules\n");

    assertEquals(loadRuleFile(tmpDir), "follow local rules\n");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("ensureRuleFile creates default", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const { path: p, content, written } = ensureRuleFile(tmpDir, false);
    assert(written);
    assertEquals(p, path.join(tmpDir, ruleFile));
    assertEquals(content, defaultRuleContent);
    assertEquals(Deno.readTextFileSync(p), defaultRuleContent);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("ensureRuleFile preserves existing unless forced", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const rulePath = path.join(tmpDir, ruleFile);
    Deno.mkdirSync(path.dirname(rulePath), { recursive: true });
    Deno.writeTextFileSync(rulePath, "custom rule");

    let res = ensureRuleFile(tmpDir, false);
    assertFalse(res.written);
    assertEquals(res.content, "custom rule");

    res = ensureRuleFile(tmpDir, true);
    assert(res.written);
    assertEquals(res.content, defaultRuleContent);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("parent files", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const parentDir = path.join(tmpDir, "parent");
    const childDir = path.join(parentDir, "child");

    Deno.mkdirSync(childDir, { recursive: true });

    Deno.writeTextFileSync(
      path.join(parentDir, "AGENTS.md"),
      "# Parent Config",
    );

    const result = loadContextFiles(childDir, "", null);

    assertEquals(result.parentFiles.length, 1);
    assertEquals(result.parentFiles[0].name, "AGENTS.md");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("defaultRuleContent matches project rule template", () => {
  assert(defaultRuleContent.startsWith("# Project Rules\n"));
  assert(defaultRuleContent.endsWith("\n"));
});
