import { runtime } from "../platform/runtime.ts";
import { assert, assertEquals } from "../compat/assert.ts";
import * as path from "../compat/path.ts";
import {
  expertSchemaVersion,
  type ManagedBundle,
  Manager,
  manifestFileName,
  roleLead,
  SCOPE_GLOBAL,
  SCOPE_PROJECT,
  sourceBuiltin,
  sourceProject,
  typeAgent,
} from "./mod.ts";
import { test } from "#testing";

function managedAgentDraft(name: string): ManagedBundle {
  return {
    scope: "",
    manifest: {
      schemaVersion: expertSchemaVersion,
      name,
      expertType: typeAgent,
      agentName: "lead",
      displayName: { zh: "测试主角", en: "Test Lead" },
      members: [
        {
          id: "lead",
          name: { zh: "主角", en: "Lead" },
          role: roleLead,
        },
      ],
    },
    agents: { lead: "---\nname: lead\n---\nYou are the lead.\n" },
  };
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = runtime.makeTempDirSync();
  try {
    fn(dir);
  } finally {
    runtime.removeSync(dir, { recursive: true });
  }
}

test("manager global create update delete", () => {
  withTempDir((tmp) => {
    const globalDir = path.join(tmp, "experts");
    const manager = new Manager();
    manager.globalDir = globalDir;
    const draft = managedAgentDraft("desktop-team");

    const created = manager.create(SCOPE_GLOBAL, draft);
    assertEquals(created.scope, SCOPE_GLOBAL);
    assertEquals(created.manifest.name, "desktop-team");
    assertEquals(
      runtime.statSync(path.join(globalDir, "desktop-team", manifestFileName))
        .isFile,
      true,
    );

    draft.manifest.displayName.zh = "已修改主角团";
    const updated = manager.update(SCOPE_GLOBAL, draft);
    assertEquals(updated.manifest.displayName.zh, "已修改主角团");
    manager.delete(SCOPE_GLOBAL, "desktop-team");
    let exists = true;
    try {
      runtime.statSync(path.join(globalDir, "desktop-team"));
    } catch {
      exists = false;
    }
    assert(!exists, "deleted bundle should not exist");
  });
});

test("manager project scope and invalid draft", () => {
  withTempDir((project) => {
    withTempDir((globalTmp) => {
      const manager = new Manager(project);
      manager.globalDir = path.join(globalTmp, "experts");
      const draft = managedAgentDraft("project-team");
      manager.create(SCOPE_PROJECT, draft);
      const projectPath = path.join(
        project,
        ".opensac",
        "experts",
        "project-team",
        manifestFileName,
      );
      assert(runtime.statSync(projectPath).isFile);

      const invalid = managedAgentDraft("bad-team");
      invalid.agents["lead"] = "---\nname: other\n---\nwrong identity\n";
      let threw = false;
      try {
        manager.create(SCOPE_GLOBAL, invalid);
      } catch {
        threw = true;
      }
      assert(threw, "Create accepted invalid agent frontmatter");
      let exists = true;
      try {
        runtime.statSync(path.join(manager.globalDir, "bad-team"));
      } catch {
        exists = false;
      }
      assert(!exists, "invalid bundle was published");
    });
  });
});

test("manager rejects builtin and preserves precedence", () => {
  withTempDir((globalRoot) => {
    const prev = runtime.env.get("OPENSAC_DIR");
    runtime.env.set("OPENSAC_DIR", globalRoot);
    try {
      withTempDir((project) => {
        const manager = new Manager(project);
        let threw = false;
        try {
          manager.delete(sourceBuiltin, "software-company");
        } catch {
          threw = true;
        }
        assert(threw, "Delete accepted builtin scope");

        const global = managedAgentDraft("frontend-developer");
        global.manifest.displayName.zh = "全局覆盖";
        manager.create(SCOPE_GLOBAL, global);

        const projectDraft = managedAgentDraft("frontend-developer");
        projectDraft.manifest.displayName.zh = "项目覆盖";
        manager.create(SCOPE_PROJECT, projectDraft);

        for (const item of manager.list()) {
          if (item.name === "frontend-developer") {
            assertEquals(item.source, sourceProject);
            assertEquals(item.displayName.zh, "项目覆盖");
            return;
          }
        }
        assert(false, "frontend-developer missing from effective list");
      });
    } finally {
      if (prev === undefined) runtime.env.delete("OPENSAC_DIR");
      else runtime.env.set("OPENSAC_DIR", prev);
    }
  });
});
