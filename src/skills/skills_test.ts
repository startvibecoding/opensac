// (representative subset).

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import {
  builtinFS,
  createProjectSkillsDir,
  expertCreaterSkillName,
  extractDescription,
  Manager,
  newManagerWithProjectDirs,
  parseReferences,
  projectSkillDirs,
  type SkillFS,
} from "./mod.ts";

function writeSkill(
  dir: string,
  name: string,
  content: string,
  refs: Record<string, string> = {},
): void {
  const sd = path.join(dir, name);
  Deno.mkdirSync(sd, { recursive: true });
  Deno.writeTextFileSync(path.join(sd, "SKILL.md"), content);
  for (const [rel, c] of Object.entries(refs)) {
    const p = path.join(sd, rel);
    Deno.mkdirSync(path.dirname(p), { recursive: true });
    Deno.writeTextFileSync(p, c);
  }
}

function memoryFS(files: Record<string, string>): SkillFS {
  return {
    readFile: (p) => files[p],
    readDir: (dir) => {
      const prefix = dir.endsWith("/") ? dir : dir + "/";
      const seen = new Map<string, boolean>();
      for (const key of Object.keys(files)) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        const name = slash < 0 ? rest : rest.slice(0, slash);
        if (!seen.has(name)) seen.set(name, slash >= 0);
      }
      return seen.size === 0
        ? undefined
        : [...seen].map(([name, isDir]) => ({ name, isDir }));
    },
  };
}

Deno.test("projectSkillDirs includes agents skills", () => {
  const root = "/tmp/proj";
  assertEquals(projectSkillDirs(root), [
    path.join(root, ".opensac", "skills"),
    path.join(root, ".skills"),
    path.join(root, ".agents", "skills"),
    path.join(root, "skills"),
  ]);
  assertEquals(projectSkillDirs(""), []);
});

Deno.test("load discovers built-in skills", () => {
  const m = newManagerWithProjectDirs("", []);
  m.load();
  assert(m.get(expertCreaterSkillName));
  assertEquals(m.listBySource("builtin").length >= 2, true);
});

Deno.test("loadFromDir loads skill and its references", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "skills-" });
  const dir = path.join(tmp, "skills");
  writeSkill(
    dir,
    "alpha",
    "# Alpha\n\nA test skill.\n\n- [a](references/a.md)\n",
    {
      "references/a.md": "REF A",
    },
  );
  const m = newManagerWithProjectDirs("", [dir]);
  m.load();
  const s = m.get("alpha")!;
  assert(s);
  assertEquals(s.name, "alpha");
  assertEquals(s.source, "project");
  assertEquals(s.description, "Alpha");
  assertEquals(s.references.length, 1);
  assertEquals(s.references[0].path, "references/a.md");
});

Deno.test("project dirs precedence overrides same name", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "skills-" });
  const globalDir = path.join(tmp, "global");
  const projDir = path.join(tmp, "proj");
  writeSkill(globalDir, "dup", "# Global\n");
  writeSkill(projDir, "dup", "# Project\n");
  const m = newManagerWithProjectDirs(globalDir, [projDir]);
  m.load();
  assertEquals(m.get("dup")!.content.includes("Project"), true);
});

Deno.test("get/list/listBySource/names", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "skills-" });
  const dir = path.join(tmp, "skills");
  writeSkill(dir, "b", "# B\n");
  writeSkill(dir, "a", "# A\n");
  const m = newManagerWithProjectDirs("", [dir]);
  m.load();
  assertEquals(m.names().includes("a"), true);
  assertEquals(m.names().includes("b"), true);
  const projectNames = m.listBySource("project").map((s) => s.name);
  assert(projectNames.includes("a") && projectNames.includes("b"));
  assertEquals(m.list().map((s) => s.name).includes("a"), true);
});

Deno.test("loadFS validates directory", () => {
  const m = new Manager("", []);
  const fsys = memoryFS({ "skills/x/SKILL.md": "# X\n" });
  // A missing dir is tolerated.
  m.loadFS(fsys, "missing", "builtin");
  assertEquals(m.get("x"), undefined);
  // Invalid dirs are rejected.
  assert(() => {
    try {
      m.loadFS(fsys, ".", "builtin");
    } catch {
      return true;
    }
    return false;
  });
});

Deno.test("loadFS loads embedded skill and reference", () => {
  const fsys = memoryFS({
    "skills/alpha/SKILL.md": "# Alpha\n\n- [基础](references/base.md)\n",
    "skills/alpha/references/base.md": "BASE",
  });
  const m = new Manager("", []);
  m.loadFS(fsys, "skills", "builtin");
  const s = m.get("alpha")!;
  assertEquals(s.references.length, 1);
  assertEquals(m.loadReference("alpha", "references/base.md"), "BASE");
});

Deno.test("extractDescription", () => {
  assertEquals(extractDescription("# Title\n\nbody"), "Title");
  assertEquals(extractDescription("\n\nplain line\n"), "plain line");
  assertEquals(extractDescription(""), "(no description)");
});

Deno.test("parseReferences", () => {
  const content = [
    "### 1. 基础 (references/base.md) [已加载]",
    "",
    "- [高级](references/adv.md)",
  ].join("\n");
  const refs = parseReferences(content, "/skill", undefined);
  assertEquals(refs.length, 2);
  assertEquals(refs[0].path, "references/base.md");
  assertEquals(refs[0].autoLoad, true);
  assertEquals(refs[1].path, "references/adv.md");
  assertEquals(refs[1].autoLoad, false);

  // Dedup: repeated path is only counted once.
  const dup = parseReferences(
    "### a (references/base.md)\n### b (references/base.md)",
    "/skill",
    undefined,
  );
  assertEquals(dup.length, 1);

  assertEquals(parseReferences("no refs here", "/skill", undefined).length, 0);
});

Deno.test("buildSkillContext with references", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "skills-" });
  const dir = path.join(tmp, "skills");
  writeSkill(
    dir,
    "withrefs",
    "# S\n\n### base (references/base.md) [已加载]\n",
    {
      "references/base.md": "BASE",
    },
  );
  writeSkill(dir, "lazy", "# L\n\n- [doc](references/doc.md)\n", {
    "references/doc.md": "DOC",
  });
  const m = newManagerWithProjectDirs("", [dir]);
  m.load();

  const ctx = m.buildSkillContext("withrefs");
  assert(ctx.includes("Active Skill: withrefs"));
  assert(ctx.includes("BASE"));

  const lazyCtx = m.buildSkillContext("lazy");
  assert(lazyCtx.includes("On-Demand References"));
  assert(lazyCtx.includes("references/doc.md"));
  assertEquals(m.buildSkillContext("missing"), "");
});

Deno.test("loadReference direct file and path escape", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "skills-" });
  const dir = path.join(tmp, "skills");
  writeSkill(dir, "d", "# D\n", { "references/extra.md": "EXTRA" });
  const m = newManagerWithProjectDirs("", [dir]);
  m.load();
  assertEquals(m.loadReference("d", "references/extra.md"), "EXTRA");
  assertEquals(m.loadReference("d", "../../etc/passwd"), undefined);
  assertEquals(m.loadReference("nope", "x.md"), undefined);
});

Deno.test("buildAllSkillsContext includes built-ins", () => {
  const m = newManagerWithProjectDirs("", []);
  m.load();
  const ctx = m.buildAllSkillsContext();
  assert(ctx.includes("Available Skills"));
  assert(ctx.includes(expertCreaterSkillName));
});

Deno.test("createProjectSkillsDir", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "skills-" });
  createProjectSkillsDir(tmp);
  assert(Deno.statSync(path.join(tmp, ".skills")).isDirectory);
});

Deno.test("load applies global disabled skills", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "skills-" });
  const configDir = path.join(tmp, "config");
  Deno.mkdirSync(configDir, { recursive: true });
  const prev = Deno.env.get("OPENSAC_DIR");
  Deno.env.set("OPENSAC_DIR", configDir);
  try {
    const dir = path.join(tmp, "skills");
    writeSkill(dir, "keep", "# Keep\n");
    writeSkill(dir, "drop", "# Drop\n");
    Deno.writeTextFileSync(
      path.join(configDir, "settings.json"),
      JSON.stringify({ skills: { disabled: ["drop"] } }),
    );
    const m = newManagerWithProjectDirs("", [dir]);
    m.load();
    assert(m.get("keep"));
    assertEquals(m.get("drop"), undefined);
    assertEquals(m.isSkillDisabled("drop"), true);
    assertEquals(m.disabledSkills(), ["drop"]);

    // Live update re-enables without a reload.
    m.setDisabledSkills([]);
    assert(m.get("drop"));
  } finally {
    if (prev === undefined) Deno.env.delete("OPENSAC_DIR");
    else Deno.env.set("OPENSAC_DIR", prev);
  }
});

Deno.test("builtinFS readDir/readFile", () => {
  const entries = builtinFS.readDir("builtin")!;
  assert(entries.some((e) => e.name === expertCreaterSkillName && e.isDir));
  assert(builtinFS.readFile("builtin/missing/SKILL.md") === undefined);
});
