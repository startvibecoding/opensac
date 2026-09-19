// Ported from internal/expert/manage_test.go

import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import {
  type ManagedBundle,
  Manager,
  manifestFileName,
  RoleLead,
  SchemaVersion,
  ScopeGlobal,
  ScopeProject,
  SourceBuiltin,
  SourceProject,
  TypeAgent,
} from "./mod.ts";

function managedAgentDraft(name: string): ManagedBundle {
  return {
    scope: "",
    manifest: {
      schemaVersion: SchemaVersion,
      name,
      expertType: TypeAgent,
      agentName: "lead",
      displayName: { zh: "测试主角", en: "Test Lead" },
      members: [{
        id: "lead",
        name: { zh: "主角", en: "Lead" },
        role: RoleLead,
      }],
    },
    agents: { lead: "---\nname: lead\n---\nYou are the lead.\n" },
  };
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = Deno.makeTempDirSync();
  try {
    fn(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

Deno.test("manager global create update delete", () => {
  withTempDir((tmp) => {
    const globalDir = path.join(tmp, "experts");
    const manager = new Manager();
    manager.globalDir = globalDir;
    const draft = managedAgentDraft("desktop-team");

    const created = manager.create(ScopeGlobal, draft);
    assertEquals(created.scope, ScopeGlobal);
    assertEquals(created.manifest.name, "desktop-team");
    assertEquals(
      Deno.statSync(path.join(globalDir, "desktop-team", manifestFileName))
        .isFile,
      true,
    );

    draft.manifest.displayName.zh = "已修改主角团";
    const updated = manager.update(ScopeGlobal, draft);
    assertEquals(updated.manifest.displayName.zh, "已修改主角团");
    manager.delete(ScopeGlobal, "desktop-team");
    let exists = true;
    try {
      Deno.statSync(path.join(globalDir, "desktop-team"));
    } catch {
      exists = false;
    }
    assert(!exists, "deleted bundle should not exist");
  });
});

Deno.test("manager project scope and invalid draft", () => {
  withTempDir((project) => {
    withTempDir((globalTmp) => {
      const manager = new Manager(project);
      manager.globalDir = path.join(globalTmp, "experts");
      const draft = managedAgentDraft("project-team");
      manager.create(ScopeProject, draft);
      const projectPath = path.join(
        project,
        ".mothx",
        "experts",
        "project-team",
        manifestFileName,
      );
      assert(Deno.statSync(projectPath).isFile);

      const invalid = managedAgentDraft("bad-team");
      invalid.agents["lead"] = "---\nname: other\n---\nwrong identity\n";
      let threw = false;
      try {
        manager.create(ScopeGlobal, invalid);
      } catch {
        threw = true;
      }
      assert(threw, "Create accepted invalid agent frontmatter");
      let exists = true;
      try {
        Deno.statSync(path.join(manager.globalDir, "bad-team"));
      } catch {
        exists = false;
      }
      assert(!exists, "invalid bundle was published");
    });
  });
});

Deno.test("manager rejects builtin and preserves precedence", () => {
  withTempDir((globalRoot) => {
    const prev = Deno.env.get("MOTHX_DIR");
    Deno.env.set("MOTHX_DIR", globalRoot);
    try {
      withTempDir((project) => {
        const manager = new Manager(project);
        let threw = false;
        try {
          manager.delete(SourceBuiltin, "software-company");
        } catch {
          threw = true;
        }
        assert(threw, "Delete accepted builtin scope");

        const global = managedAgentDraft("frontend-developer");
        global.manifest.displayName.zh = "全局覆盖";
        manager.create(ScopeGlobal, global);

        const projectDraft = managedAgentDraft("frontend-developer");
        projectDraft.manifest.displayName.zh = "项目覆盖";
        manager.create(ScopeProject, projectDraft);

        for (const item of manager.list()) {
          if (item.name === "frontend-developer") {
            assertEquals(item.source, SourceProject);
            assertEquals(item.displayName.zh, "项目覆盖");
            return;
          }
        }
        assert(false, "frontend-developer missing from effective list");
      });
    } finally {
      if (prev === undefined) Deno.env.delete("MOTHX_DIR");
      else Deno.env.set("MOTHX_DIR", prev);
    }
  });
});
