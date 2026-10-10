import { assert, assertEquals } from "../compat/assert.ts";
import { builtinFS, type Bundle, loadBundleFS } from "./mod.ts";
import {
  expertSchemaVersion,
  roleLead,
  roleMember,
  typeAgent,
  typeTeam,
} from "./mod.ts";
import { test } from "#testing";

function loadSeed(name: string): Bundle {
  const b = loadBundleFS(builtinFS, name);
  assert(!b.invalid, `seed ${name} invalid: ${b.invalidReason}`);
  return b;
}

test("builtin seeds load valid", () => {
  const entries = builtinFS.readDir(".") ?? [];
  const found = new Set(entries.map((e) => e.name));
  for (const seed of ["software-company", "frontend-developer"]) {
    assert(found.has(seed), `BuiltinFS missing seed directory ${seed}`);
    const b = loadSeed(seed);
    assertEquals(b.name, seed);
  }
});

test("software company seed", () => {
  const b = loadSeed("software-company");

  assertEquals(b.manifest.schemaVersion, expertSchemaVersion);
  assertEquals(b.manifest.expertType, typeTeam);
  assert(b.manifest.teamInfo !== undefined, "teamInfo missing");
  assertEquals(b.manifest.agentName, "software-team-lead");
  assertEquals(b.manifest.teamInfo!.leadAgent, "software-team-lead");
  assertEquals(b.manifest.displayName.zh, "一人公司");
  assertEquals(b.manifest.displayName.en, "Software Company");
  assertEquals(b.manifest.categoryId, "engineering");
  const quickPrompts = b.manifest.quickPrompts ?? [];
  assert(quickPrompts.length >= 2 && quickPrompts.length <= 3);
  quickPrompts.forEach((qp, i) => {
    assert(qp.zh !== "" && qp.en !== "", `quickPrompts[${i}] missing zh/en`);
  });
  assertEquals(b.manifest.defaultInitPrompt!.zh !== "", true);
  assertEquals(b.manifest.defaultInitPrompt!.en !== "", true);
  assertEquals((b.manifest.members ?? []).length, 5);

  const wantIDs = [
    "software-team-lead",
    "software-product-manager",
    "software-architect",
    "software-engineer",
    "software-qa-engineer",
  ];
  assertEquals(b.defs.size, wantIDs.length, [...b.defs.keys()].join(","));
  for (const id of wantIDs) {
    assert(b.defs.has(id), `Defs missing ${id}`);
  }
  const lead = b.defs.get("software-team-lead")!;
  assertEquals(lead.role, roleLead);
  assertEquals(lead.displayName, "齐活林");
  assert(
    lead.emoji !== "" && lead.meta.vibe !== "" && lead.meta.color !== "",
    "lead frontmatter metadata incomplete",
  );
  for (const id of wantIDs.slice(1)) {
    const def = b.defs.get(id)!;
    assertEquals(def.role, roleMember, id);
    assert(
      def.displayName !== "" && def.emoji !== "" && def.description !== "",
      `${id} persona metadata incomplete`,
    );
    assert(def.prompt !== "", `${id} prompt empty`);
  }

  // Lead SOP must carry the full orchestration specification (proposal §7).
  for (
    const want of [
      "subagent_spawn",
      "subagent_wait",
      "subagent_status",
      "subagent_send",
      "subagent_destroy",
      "禁止代写",
      "禁止模拟",
      "已由系统绑定",
      "非重叠",
      "反射式",
      "写集不相交",
      "⚡",
      "🔧",
      "🏗️",
      "📋",
      "最多 2 轮",
      "TL;DR",
      "文件清单",
      "下一步建议",
      "deliverables/software-company/",
      "hub-and-spoke",
    ]
  ) {
    assert(lead.prompt.includes(want), `lead SOP missing ${want}`);
  }
  const pm = b.defs.get("software-product-manager")!.prompt;
  for (const want of ["背景", "用户故事", "验收标准", "非目标"]) {
    assert(pm.includes(want), `PM prompt missing ${want}`);
  }
  const arch = b.defs.get("software-architect")!.prompt;
  for (
    const want of [
      "decision-complete",
      "文件级改动清单",
      "接口签名",
      "数据结构",
      "任务分解",
    ]
  ) {
    assert(arch.includes(want), `architect prompt missing ${want}`);
  }
  const eng = b.defs.get("software-engineer")!;
  for (
    const want of [
      "ALL-AT-ONCE",
      "脚手架",
      "GLOBAL_CONSISTENCY_CHECK",
      "IS_PASS",
      "设计文档",
    ]
  ) {
    assert(eng.prompt.includes(want), `engineer prompt missing ${want}`);
  }
  assertEquals(eng.meta.mode, "yolo");
  const wantTools = ["read", "write", "edit", "bash", "grep", "find"];
  assertEquals(eng.meta.tools, wantTools);
  assertEquals(eng.meta.maxIterations, 80);
  const qa = b.defs.get("software-qa-engineer")!.prompt;
  for (const want of ["测试计划", "回归", "最小复现", "2 轮"]) {
    assert(qa.includes(want), `QA prompt missing ${want}`);
  }
});

test("frontend developer seed", () => {
  const b = loadSeed("frontend-developer");

  assertEquals(b.manifest.expertType, typeAgent);
  assertEquals(b.manifest.agentName, "frontend-developer");
  assertEquals(b.manifest.displayName.zh, "前端开发专家");
  assertEquals(b.manifest.displayName.en, "Frontend Developer");
  const members = b.manifest.members ?? [];
  assertEquals(members.length, 1);
  assertEquals(members[0].role, roleLead);
  assertEquals(b.defs.size, 1, [...b.defs.keys()].join(","));
  const def = b.defs.get("frontend-developer");
  assert(def !== undefined, "Defs missing frontend-developer");
  assertEquals(def.role, roleLead);
  assertEquals(def.displayName, "前小端");
  for (
    const field of [
      { label: "name", value: def.meta.name },
      { label: "description", value: def.meta.description },
      { label: "role", value: def.meta.role },
      { label: "emoji", value: def.meta.emoji },
      { label: "color", value: def.meta.color },
      { label: "vibe", value: def.meta.vibe },
    ]
  ) {
    assert(field.value !== "", `frontmatter ${field.label} empty`);
  }
  for (const want of ["组件化", "可访问性", "性能"]) {
    assert(def.prompt.includes(want), `frontend prompt missing ${want}`);
  }
  assert(
    b.skillsDir !== "",
    "SkillsDir empty; seed ships skills/frontend-review",
  );
  assert(b.skillsFS !== null, "skillsFS nil for embedded load");
  assert(
    b.skillsFS!.stat(b.skillsDir + "/frontend-review/SKILL.md") !== undefined,
    "bundled skill not resolvable via skillsFS",
  );
  assertEquals(b.defs.size, 1, "skills/ must not leak into Defs");
});
