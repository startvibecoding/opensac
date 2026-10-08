import { assert, assertEquals } from "@opensac/assert";
import * as path from "@opensac/path";
import {
  Center,
  sourceBuiltin,
  sourceGlobal,
  sourceProject,
  typeTeam,
} from "./mod.ts";

/** Builds a minimal valid agent-bundle manifest for shadow assertions. */
function shadowManifest(name: string, displayZh: string): string {
  return `{
  "schemaVersion": 1,
  "name": "${name}",
  "expertType": "agent",
  "agentName": "solo",
  "displayName": { "zh": "${displayZh}", "en": "${name}" },
  "members": [ { "id": "solo", "name": { "zh": "${displayZh}", "en": "Solo" }, "role": "lead" } ]
}`;
}

function shadowFiles(
  name: string,
  displayZh: string,
): Record<string, string> {
  return {
    "expert.json": shadowManifest(name, displayZh),
    "agents/solo.md": "---\nname: solo\n---\nsolo body\n",
  };
}

/** Writes files (bundle-relative slash paths) under layerDir/name. */
function writeLayerBundle(
  layerDir: string,
  name: string,
  files: Record<string, string>,
): void {
  const dir = path.join(layerDir, name);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    Deno.mkdirSync(path.dirname(p), { recursive: true });
    Deno.writeTextFileSync(p, content);
  }
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = Deno.makeTempDirSync();
  try {
    fn(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

function withEnv(key: string, value: string, fn: () => void): void {
  const prev = Deno.env.get(key);
  Deno.env.set(key, value);
  try {
    fn();
  } finally {
    if (prev === undefined) Deno.env.delete(key);
    else Deno.env.set(key, prev);
  }
}

Deno.test("center list shadow and sort", () => {
  withTempDir((globalRoot) => {
    withEnv("OPENSAC_DIR", globalRoot, () => {
      withTempDir((projectRoot) => {
        const globalDir = path.join(globalRoot, "experts");
        const projectDir = path.join(projectRoot, ".opensac", "experts");

        // global shadows builtin frontend-developer and adds a global-only bundle.
        writeLayerBundle(
          globalDir,
          "frontend-developer",
          shadowFiles("frontend-developer", "全局前端"),
        );
        writeLayerBundle(
          globalDir,
          "zz-global-only",
          shadowFiles("zz-global-only", "全局专属"),
        );
        // project shadows builtin software-company, global frontend-developer and
        // global zz-global-only, and adds a project-only bundle.
        writeLayerBundle(
          projectDir,
          "software-company",
          shadowFiles("software-company", "项目软件公司"),
        );
        writeLayerBundle(
          projectDir,
          "frontend-developer",
          shadowFiles("frontend-developer", "项目前端"),
        );
        writeLayerBundle(
          projectDir,
          "zz-global-only",
          shadowFiles("zz-global-only", "项目覆盖全局"),
        );
        writeLayerBundle(
          projectDir,
          "aaa-project-only",
          shadowFiles("aaa-project-only", "项目专属"),
        );

        const list = new Center(projectRoot).list();
        const byName = new Map(list.map((s) => [s.name, s]));
        const wants = [
          {
            name: "aaa-project-only",
            source: sourceProject,
            displayName: "项目专属",
          },
          {
            name: "frontend-developer",
            source: sourceProject,
            displayName: "项目前端",
          },
          {
            name: "software-company",
            source: sourceProject,
            displayName: "项目软件公司",
          },
          {
            name: "zz-global-only",
            source: sourceProject,
            displayName: "项目覆盖全局",
          },
        ];
        for (const want of wants) {
          const got = byName.get(want.name);
          assert(got !== undefined, `List missing ${want.name}`);
          assertEquals(got.source, want.source, want.name);
          assertEquals(got.displayName.zh, want.displayName, want.name);
          assert(!got.invalid, `${want.name} invalid: ${got.invalidReason}`);
        }
        for (let i = 1; i < list.length; i++) {
          assert(list[i - 1].name <= list[i].name, "List not sorted");
        }

        // Without the project layer, global shadows builtin; builtin survives.
        const byName2 = new Map(
          new Center().list().map((s) => [s.name, s]),
        );
        const fe = byName2.get("frontend-developer")!;
        assertEquals(fe.source, sourceGlobal);
        assertEquals(fe.displayName.zh, "全局前端");
        assertEquals(byName2.get("software-company")!.source, sourceBuiltin);
        assertEquals(byName2.get("zz-global-only")!.source, sourceGlobal);
      });
    });
  });
});

Deno.test("center list missing layers tolerated", () => {
  withTempDir((globalRoot) => {
    withEnv("OPENSAC_DIR", globalRoot, () => {
      const list = new Center().list();
      assertEquals(list.length, 2);
      assertEquals(list[0].name, "frontend-developer");
      assertEquals(list[1].name, "software-company");
      for (const s of list) {
        assertEquals(s.source, sourceBuiltin, s.name);
        assert(!s.invalid, `${s.name} invalid: ${s.invalidReason}`);
        assert(s.expertType !== "", `${s.name} ExpertType empty`);
      }

      withTempDir((projectRoot) => {
        writeLayerBundle(
          path.join(projectRoot, ".opensac", "experts"),
          "proj-only",
          shadowFiles("proj-only", "项目专属"),
        );
        assertEquals(new Center().list().length, 2);
        assertEquals(new Center(projectRoot).list().length, 3);
      });
    });
  });
});

Deno.test("center list invalid manifest flagged", () => {
  withTempDir((globalRoot) => {
    withEnv("OPENSAC_DIR", globalRoot, () => {
      withTempDir((projectRoot) => {
        const projectDir = path.join(projectRoot, ".opensac", "experts");

        // Broken JSON in the project layer.
        writeLayerBundle(projectDir, "broken-pkg", {
          "expert.json": "{not json",
        });
        // Project bundle shadowing a valid builtin with a manifest-name mismatch.
        writeLayerBundle(projectDir, "frontend-developer", {
          "expert.json": shadowManifest("frontend-developer", "坏影").replace(
            `"name": "frontend-developer"`,
            `"name": "mismatched"`,
          ),
          "agents/solo.md": "---\nname: solo\n---\nbody\n",
        });

        const byName = new Map(
          new Center(projectRoot).list().map((s) => [s.name, s]),
        );
        const broken = byName.get("broken-pkg");
        assert(broken !== undefined, "broken-pkg missing from List");
        assert(broken.invalid && broken.invalidReason!.includes("expert.json"));
        const shadow = byName.get("frontend-developer");
        assert(shadow !== undefined, "frontend-developer missing from List");
        assertEquals(shadow.source, sourceProject);
        assert(
          shadow.invalid && shadow.invalidReason!.includes("不一致"),
          `frontend-developer = ${JSON.stringify(shadow)}`,
        );
        assert(
          byName.has("software-company"),
          "builtin software-company missing",
        );
      });
    });
  });
});

Deno.test("center get", () => {
  withTempDir((globalRoot) => {
    withEnv("OPENSAC_DIR", globalRoot, () => {
      withTempDir((projectRoot) => {
        const c = new Center(projectRoot);
        const b = c.get("software-company");
        assert(!b.invalid, `builtin seed invalid: ${b.invalidReason}`);
        assertEquals(b.manifest.expertType, typeTeam);
        assertEquals(b.defs.size, 5);

        // Project layer wins over builtin.
        writeLayerBundle(
          path.join(projectRoot, ".opensac", "experts"),
          "software-company",
          shadowFiles("software-company", "项目软件公司"),
        );
        const b2 = c.get("software-company");
        assert(!b2.invalid, `project bundle invalid: ${b2.invalidReason}`);
        assertEquals(b2.manifest.displayName.zh, "项目软件公司");

        // Global layer wins over builtin when no project copy exists.
        writeLayerBundle(
          path.join(globalRoot, "experts"),
          "frontend-developer",
          shadowFiles("frontend-developer", "全局前端"),
        );
        const b3 = c.get("frontend-developer");
        assertEquals(b3.manifest.displayName.zh, "全局前端");

        // Not found.
        let threw = false;
        try {
          c.get("does-not-exist");
        } catch {
          threw = true;
        }
        assert(threw, "get(does-not-exist) should fail");
        // Name hygiene.
        for (const bad of ["", "  ", "../escape", "a/b", "a\\b", ".."]) {
          let badThrew = false;
          try {
            c.get(bad);
          } catch {
            badThrew = true;
          }
          assert(badThrew, `get(${JSON.stringify(bad)}) should fail`);
        }
      });
    });
  });
});
