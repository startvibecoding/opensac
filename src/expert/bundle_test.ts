import { assert, assertEquals, assertThrows } from "@std/assert";
import * as path from "@std/path";
import {
  type Bundle,
  createMemoryFS,
  loadBundle,
  loadBundleFS,
  roleLead,
  roleMember,
  typeAgent,
} from "./mod.ts";

const validTeamManifest = `{
  "schemaVersion": 1,
  "name": "team-x",
  "expertType": "team",
  "agentName": "lead-x",
  "displayName": { "zh": "测试团队", "en": "Test Team" },
  "teamInfo": { "leadAgent": "lead-x", "memberAgents": ["worker-a", "worker-b"] },
  "members": [
    { "id": "lead-x", "name": { "zh": "领队", "en": "Lead L" }, "role": "lead" },
    { "id": "worker-a", "name": { "zh": "", "en": "Worker A" }, "role": "member" },
    { "id": "worker-b", "name": { "zh": "工人乙", "en": "Worker B" }, "role": "member" }
  ]
}`;

const validAgentManifest = `{
  "schemaVersion": 1,
  "name": "agent-x",
  "expertType": "agent",
  "agentName": "solo",
  "displayName": { "zh": "单专家", "en": "Solo Expert" },
  "members": [ { "id": "solo", "name": { "zh": "独立", "en": "Solo" }, "role": "lead" } ]
}`;

function teamFiles(): Record<string, string> {
  return {
    "expert.json": validTeamManifest,
    // lead frontmatter role intentionally "member": manifest must win.
    "agents/lead-x.md":
      "---\nname: lead-x\ndescription: 领队人设\nrole: member\nemoji: 🎯\n---\n领队正文\n",
    "agents/worker-a.md":
      "---\nname: worker-a\ndescription: worker a persona\nrole: member\nemoji: 🔧\n---\nA body\n",
    "agents/worker-b.md": "---\nname: worker-b\nrole: member\n---\nB body\n",
  };
}

function agentFiles(): Record<string, string> {
  return {
    "expert.json": validAgentManifest,
    // frontmatter role intentionally "member": agentName must resolve to lead.
    "agents/solo.md":
      "---\nname: solo\ndescription: 独立专家\nrole: member\nemoji: 🖥️\n---\nsolo body\n",
  };
}

/** Writes files (bundle-relative slash paths) under root/name; returns the dir. */
function writeBundle(
  root: string,
  name: string,
  files: Record<string, string>,
): string {
  const dir = path.join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    Deno.mkdirSync(path.dirname(p), { recursive: true });
    Deno.writeTextFileSync(p, content);
  }
  return dir;
}

function defIDs(b: Bundle): string[] {
  return [...b.defs.keys()];
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = Deno.makeTempDirSync();
  try {
    fn(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

Deno.test("loadBundle valid team", () => {
  withTempDir((tmp) => {
    const files = teamFiles();
    files["agents/extra.md"] =
      "---\nrole: member\ndescription: 未被 manifest 引用的成员\n---\nextra body\n";
    files["skills/pack-skill/SKILL.md"] =
      "---\nname: pack-skill\n---\nskill body\n";
    const dir = writeBundle(tmp, "team-x", files);

    const b = loadBundle(dir);
    assert(!b.invalid, `bundle invalid: ${b.invalidReason}`);
    assertEquals(b.name, "team-x");
    // 3 referenced + 1 unreferenced md all load into defs.
    assertEquals(b.defs.size, 4, defIDs(b).join(","));
    const lead = b.defs.get("lead-x")!;
    assertEquals(lead.role, roleLead);
    assertEquals(lead.displayName, "领队");
    assertEquals(lead.prompt, "领队正文");
    assertEquals(lead.emoji, "🎯");
    assertEquals(lead.description, "领队人设");
    for (const id of ["worker-a", "worker-b"]) {
      assertEquals(b.defs.get(id)!.role, roleMember, id);
    }
    assertEquals(b.defs.get("worker-a")!.displayName, "Worker A");
    assertEquals(b.defs.get("worker-b")!.displayName, "工人乙");
    assertEquals(b.defs.get("extra")!.displayName, "extra");
    assertEquals(b.defs.get("extra")!.role, roleMember);
    assertEquals(b.defs.get("extra")!.meta.name, "extra");
    assertEquals(b.skillsDir, path.join(dir, "skills"));
    assertEquals(b.skillsFS, null);
  });
});

Deno.test("loadBundle valid agent", () => {
  withTempDir((tmp) => {
    const dir = writeBundle(tmp, "agent-x", agentFiles());
    const b = loadBundle(dir);
    assert(!b.invalid, `bundle invalid: ${b.invalidReason}`);
    assertEquals(b.manifest.expertType, typeAgent);
    const solo = b.defs.get("solo");
    assert(solo !== undefined, `Defs missing solo: ${defIDs(b)}`);
    assertEquals(solo.role, roleLead);
    assertEquals(solo.displayName, "独立");
    assertEquals(b.skillsDir, "");
  });
});

function replaceInManifest(
  old: string,
  neu: string,
): (files: Record<string, string>) => Record<string, string> {
  return (files) => {
    const manifest = files["expert.json"];
    assert(
      manifest.includes(old),
      `replaceInManifest: pattern not found: ${old}`,
    );
    files["expert.json"] = manifest.replaceAll(old, neu);
    return files;
  };
}

Deno.test("loadBundle invalid cases", () => {
  interface InvalidCase {
    name: string;
    dirName?: string;
    files: () => Record<string, string>;
    mutate?: (files: Record<string, string>) => Record<string, string>;
    wantReason: string;
  }
  const cases: InvalidCase[] = [
    {
      name: "skill type rejected",
      files: teamFiles,
      mutate: replaceInManifest(
        `"expertType": "team"`,
        `"expertType": "skill"`,
      ),
      wantReason: "skills/skillhub",
    },
    {
      name: "unknown expertType rejected",
      files: teamFiles,
      mutate: replaceInManifest(
        `"expertType": "team"`,
        `"expertType": "workflow"`,
      ),
      wantReason: "expertType",
    },
    {
      name: "bad schemaVersion",
      files: teamFiles,
      mutate: replaceInManifest(`"schemaVersion": 1`, `"schemaVersion": 2`),
      wantReason: "schemaVersion",
    },
    {
      name: "manifest name mismatch with directory",
      files: teamFiles,
      mutate: replaceInManifest(`"name": "team-x"`, `"name": "other-name"`),
      wantReason: "不一致",
    },
    {
      name: "empty manifest name",
      files: teamFiles,
      mutate: replaceInManifest(`"name": "team-x"`, `"name": ""`),
      wantReason: "name",
    },
    {
      name: "bad json",
      files: teamFiles,
      mutate: (f) => {
        f["expert.json"] = `{not json`;
        return f;
      },
      wantReason: "expert.json",
    },
    {
      name: "missing expert.json",
      files: teamFiles,
      mutate: (f) => {
        delete f["expert.json"];
        return f;
      },
      wantReason: "expert.json",
    },
    {
      name: "team missing teamInfo",
      files: teamFiles,
      mutate: replaceInManifest(
        `"teamInfo": { "leadAgent": "lead-x", "memberAgents": ["worker-a", "worker-b"] },`,
        ``,
      ),
      wantReason: "teamInfo",
    },
    {
      name: "memberAgents contains leadAgent",
      files: teamFiles,
      mutate: replaceInManifest(
        `["worker-a", "worker-b"]`,
        `["lead-x", "worker-b"]`,
      ),
      wantReason: "leadAgent",
    },
    {
      name: "memberAgents duplicated",
      files: teamFiles,
      mutate: replaceInManifest(
        `["worker-a", "worker-b"]`,
        `["worker-a", "worker-a"]`,
      ),
      wantReason: "重复",
    },
    {
      name: "missing lead md",
      files: teamFiles,
      mutate: (f) => {
        delete f["agents/lead-x.md"];
        return f;
      },
      wantReason: "lead-x.md",
    },
    {
      name: "missing member md",
      files: teamFiles,
      mutate: (f) => {
        delete f["agents/worker-b.md"];
        return f;
      },
      wantReason: "worker-b.md",
    },
    {
      name: "agent type missing agentName",
      dirName: "agent-x",
      files: agentFiles,
      mutate: replaceInManifest(`"agentName": "solo",`, ``),
      wantReason: "agentName",
    },
    {
      name: "agent type missing md",
      dirName: "agent-x",
      files: agentFiles,
      mutate: (f) => {
        delete f["agents/solo.md"];
        return f;
      },
      wantReason: "solo.md",
    },
    {
      name: "illegal mode",
      files: teamFiles,
      mutate: (f) => {
        f["agents/worker-a.md"] =
          "---\nname: worker-a\nmode: turbo\n---\nbody\n";
        return f;
      },
      wantReason: "mode",
    },
    {
      name: "negative max_iterations",
      files: teamFiles,
      mutate: (f) => {
        f["agents/worker-a.md"] =
          "---\nname: worker-a\nmax_iterations: -3\n---\nbody\n";
        return f;
      },
      wantReason: "max_iterations",
    },
    {
      name: "frontmatter name mismatch",
      files: teamFiles,
      mutate: (f) => {
        f["agents/worker-b.md"] = "---\nname: someone-else\n---\nbody\n";
        return f;
      },
      wantReason: "文件名",
    },
    {
      name: "unclosed frontmatter",
      files: teamFiles,
      mutate: (f) => {
        f["agents/worker-b.md"] = "---\nname: worker-b\nbody without closing\n";
        return f;
      },
      wantReason: "frontmatter",
    },
    {
      name: "non-integer max_iterations",
      files: teamFiles,
      mutate: (f) => {
        f["agents/worker-a.md"] =
          "---\nname: worker-a\nmax_iterations: many\n---\nbody\n";
        return f;
      },
      wantReason: "max_iterations",
    },
  ];

  for (const tt of cases) {
    withTempDir((tmp) => {
      const dirName = tt.dirName ?? "team-x";
      let files = tt.files();
      if (tt.mutate) files = tt.mutate(files);
      const dir = writeBundle(tmp, dirName, files);
      const b = loadBundle(dir);
      assert(b.invalid, `case ${tt.name}: expected invalid bundle`);
      assert(
        b.invalidReason.includes(tt.wantReason),
        `case ${tt.name}: InvalidReason = ${JSON.stringify(b.invalidReason)}`,
      );
      assert(b.defs !== undefined, `case ${tt.name}: Defs must be initialized`);
      assertEquals(b.defs.size, 0, `case ${tt.name}`);
    });
  }
});

Deno.test("loadBundleFS", () => {
  const mapFiles: Record<string, string> = {
    "pkg-a/expert.json": validTeamManifest.replaceAll("team-x", "pkg-a"),
    "pkg-a/agents/lead-x.md": "---\nname: lead-x\nrole: lead\n---\nlead body\n",
    "pkg-a/agents/worker-a.md": "---\nname: worker-a\n---\na body\n",
    "pkg-a/agents/worker-b.md": "---\nname: worker-b\n---\nb body\n",
    "pkg-a/skills/s1/SKILL.md": "# s1\n",
  };
  const mapfs = createMemoryFS(mapFiles);
  const b = loadBundleFS(mapfs, "pkg-a");
  assert(!b.invalid, `pkg-a invalid: ${b.invalidReason}`);
  assertEquals(b.name, "pkg-a");
  assertEquals(b.defs.get("lead-x")!.role, roleLead);
  assertEquals(b.skillsDir, "pkg-a/skills");
  assert(b.skillsFS !== null, "skillsFS should be set for ExpertFS loads");
  assert(
    b.skillsFS!.stat(b.skillsDir)!.isDir,
    "skillsFS/skillsDir not resolvable",
  );

  // FS rooted at the bundle itself: name comes from the manifest.
  const rooted = createMemoryFS({
    "expert.json": validAgentManifest,
    "agents/solo.md": "---\nname: solo\n---\nsolo body\n",
  });
  const rb = loadBundleFS(rooted, ".");
  assert(!rb.invalid, `rooted bundle invalid: ${rb.invalidReason}`);
  assertEquals(rb.name, "agent-x");

  // Missing manifest is a validation failure, not an IO error.
  const empty = createMemoryFS({ "agents/solo.md": "x" });
  const eb = loadBundleFS(empty, "no-manifest");
  assert(
    eb.invalid && eb.invalidReason.includes("expert.json"),
    `expected invalid with expert.json reason, got ${eb.invalidReason}`,
  );

  assertThrows(() => loadBundleFS(undefined as never, "x"));
});
