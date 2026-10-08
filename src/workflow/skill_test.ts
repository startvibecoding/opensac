import { assert, assertEquals } from "@opensac/assert";
import * as path from "@opensac/path";
import { ensureProjectSkill, skillName } from "./skill.ts";

Deno.test("ensureProjectSkill creates workflow skill", async () => {
  const root = await Deno.makeTempDir();
  try {
    const [skillPath, created] = await ensureProjectSkill(root);
    assert(created, "expected skill to be created");
    assertEquals(
      skillPath,
      path.join(root, ".skills", skillName, "SKILL.md"),
    );
    const content = await Deno.readTextFile(skillPath);
    for (
      const want of [
        "# Workflow JavaScript",
        "Progressive references",
        "references/00-core-rules.md",
        "references/06-master-slave-team.md",
        "workflow, phase, and agent names must be string literals.",
        "Agent options are prompt, mode, workDir, tools, maxIterations, key",
        "Keep workflows bounded",
        "set timeoutSeconds for long workflow_run calls",
        "Use result, resultKey, resultLatest, results, and log",
        "Use key for repeated logical agents",
      ]
    ) {
      assert(
        content.includes(want),
        `skill content missing ${JSON.stringify(want)}`,
      );
    }

    const corePath = path.join(
      root,
      ".skills",
      skillName,
      "references",
      "00-core-rules.md",
    );
    const core = await Deno.readTextFile(corePath);
    for (
      const want of [
        "Agent names and phase names must be string literals.",
        'workflow("auth audit"',
        "# Core Rules and Skeletons",
        "concurrency is 5",
        "mode and workDir inherit",
        "Defaults: concurrency is 5",
        "maxIterations: 100",
        'resultKey("phase.agent", "r0")',
      ]
    ) {
      assert(
        core.includes(want),
        `core reference missing ${JSON.stringify(want)}`,
      );
    }

    for (
      const rel of [
        "01-research.md",
        "03-decision-routing.md",
        "04-continuous-loops.md",
        "05-horizontal-collaboration.md",
        "07-evaluator-optimizer.md",
        "08-governance-checkpoints.md",
      ]
    ) {
      await Deno.stat(
        path.join(root, ".skills", skillName, "references", rel),
      );
    }

    const loops = await Deno.readTextFile(
      path.join(
        root,
        ".skills",
        skillName,
        "references",
        "04-continuous-loops.md",
      ),
    );
    assert(loops.includes("# Bounded JavaScript Loops"));
    assert(loops.includes("for (var i = 0; i < 3"));

    const evaluator = await Deno.readTextFile(
      path.join(
        root,
        ".skills",
        skillName,
        "references",
        "07-evaluator-optimizer.md",
      ),
    );
    assert(evaluator.includes("# Evaluator-Optimizer Review Passes"));
    for (
      const unwanted of [
        "Critic Loops",
        "Bounded Optimizer Loop",
        "(legacy while ",
      ]
    ) {
      assert(!evaluator.includes(unwanted), `should not contain ${unwanted}`);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ensureProjectSkill does not overwrite existing skill", async () => {
  const root = await Deno.makeTempDir();
  try {
    const skillDir = path.join(root, ".skills", skillName);
    await Deno.mkdir(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, "SKILL.md");
    await Deno.writeTextFile(skillPath, "custom workflow skill");

    const [gotPath, created] = await ensureProjectSkill(root);
    assert(!created, "did not expect existing skill to be recreated");
    assertEquals(gotPath, skillPath);
    assertEquals(await Deno.readTextFile(skillPath), "custom workflow skill");

    await Deno.stat(path.join(skillDir, "references", "01-research.md"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ensureProjectSkill respects lowercase skill", async () => {
  const root = await Deno.makeTempDir();
  try {
    const skillDir = path.join(root, ".skills", skillName);
    await Deno.mkdir(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, "skill.md");
    await Deno.writeTextFile(skillPath, "lowercase workflow skill");

    const [gotPath, created] = await ensureProjectSkill(root);
    assert(!created, "did not expect lowercase skill to be recreated");
    assertEquals(gotPath, skillPath);
    await Deno.stat(path.join(skillDir, "references", "00-core-rules.md"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
