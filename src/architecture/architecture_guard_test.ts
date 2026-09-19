import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  foreignKeyEnforcementPattern,
  importSpecifiers,
  productionViolations,
  stringLiterals,
  type Violation,
} from "./guard.ts";

const projectRoot = fromFileUrl(new URL("../../", import.meta.url));

function formatViolations(violations: Violation[]): string {
  return violations.map((v) => `${v.file}: ${v.message}`).join("\n- ");
}

// Prevents adapters from silently reintroducing complete Agent construction or
// canonical Run persistence. The allowlist is intentionally empty: every entry
// must be an explicit, documented migration bridge.
Deno.test("production architecture guard", () => {
  const violations = productionViolations(projectRoot);
  assertEquals(
    violations,
    [],
    `production architecture violations:\n- ${formatViolations(violations)}`,
  );
});

Deno.test("string literals ignore comments and template bodies", () => {
  const source = [
    '// "comment_literal"',
    'const raw = `{"decision":"resume"}`;',
    "const single = 'decision_';",
  ].join("\n");
  assertEquals(stringLiterals(source), ["decision_"]);
});

Deno.test("import specifiers read static and dynamic imports", () => {
  const source = [
    'import { createSessionRun } from "../session/run_store.ts";',
    'import type { SQLInputValue } from "node:sqlite";',
    'import "side-effect";',
    'const mod = await import("./dynamic.ts");',
  ].join("\n");
  assertEquals(importSpecifiers(source), [
    "../session/run_store.ts",
    "node:sqlite",
    "side-effect",
    "./dynamic.ts",
  ]);
});

Deno.test("foreign key enforcement pattern only matches enabling values", () => {
  assert(foreignKeyEnforcementPattern.test("file:db?_pragma=foreign_keys(ON)"));
  assert(foreignKeyEnforcementPattern.test("PRAGMA foreign_keys = 1"));
  assert(foreignKeyEnforcementPattern.test("pragma foreign_keys = true"));
  assert(!foreignKeyEnforcementPattern.test("PRAGMA foreign_keys = OFF"));
  assert(!foreignKeyEnforcementPattern.test("PRAGMA foreign_keys"));
  assert(!foreignKeyEnforcementPattern.test("PRAGMA foreign_keys(0)"));
});

interface Case {
  name: string;
  path: string;
  src: string;
  want: string;
}

const bypassCases: Case[] = [
  {
    name: "session create",
    path: "src/serve/adapter.ts",
    src: [
      'import { createSessionRun } from "../session/run_store.ts";',
      'export function persist() { createSessionRun("", {} as never); }',
    ].join("\n"),
    want: "direct session.createSessionRun",
  },
  {
    name: "session run query",
    path: "src/serve/adapter.ts",
    src: [
      'import { getSessionRun } from "../session/run_store.ts";',
      'export function inspect() { getSessionRun("", "run"); }',
    ].join("\n"),
    want: "direct session.getSessionRun",
  },
  {
    name: "run store update",
    path: "src/serve/adapter.ts",
    src: 'export function persist(runStore: any) { runStore.update("run"); }\n',
    want: "direct agentruntime.RunStore.update",
  },
  {
    name: "run store finish",
    path: "src/serve/adapter.ts",
    src: 'export function persist(runStore: any) { runStore.finish("run"); }\n',
    want: "direct agentruntime.RunStore.finish",
  },
  {
    name: "legacy runtime lease",
    path: "src/serve/new_adapter.ts",
    src: [
      'import { tryLockRuntime } from "../session/runtime_lock.ts";',
      'export function reserve() { tryLockRuntime("", "session"); }',
    ].join("\n"),
    want: "new use of legacy session.tryLockRuntime",
  },
  {
    name: "legacy attachment delivery",
    path: "src/serve/new_adapter.ts",
    src: "export function project(s: any) { s.beginDelivery(); }\n",
    want: "new use of legacy attachment delivery API beginDelivery",
  },
  {
    name: "direct SQL handle",
    path: "src/serve/new_adapter.ts",
    src: 'export function persist(db: any) { db.exec("SELECT 1"); }\n',
    want: "direct database exec",
  },
  {
    name: "direct agent construction",
    path: "src/serve/new_adapter.ts",
    src:
      'export function build(reg: any) { return new Agent("id", "", {}, reg); }\n',
    want: "direct new Agent",
  },
  {
    name: "foreign key enforcement DSN pragma",
    path: "src/serve/adapter.ts",
    src: 'export const open = "file:db?_pragma=foreign_keys(ON)";\n',
    want: "SQLite foreign key enforcement is owned by src/db",
  },
  {
    name: "foreign key enforcement equality pragma",
    path: "src/serve/adapter.ts",
    src: 'export const open = "PRAGMA foreign_keys = 1";\n',
    want: "SQLite foreign key enforcement is owned by src/db",
  },
  {
    name: "foreign key enforcement lowercase pragma",
    path: "src/serve/adapter.ts",
    src: 'export const open = "pragma foreign_keys = true";\n',
    want: "SQLite foreign key enforcement is owned by src/db",
  },
  {
    name: "foreign key disable pragma is allowed",
    path: "src/serve/adapter.ts",
    src: 'export const open = "PRAGMA foreign_keys = OFF";\n',
    want: "",
  },
  {
    name: "bare foreign_keys pragma without enable value is allowed",
    path: "src/serve/adapter.ts",
    src: 'export const open = "PRAGMA foreign_keys";\n',
    want: "",
  },
  {
    name: "runtime store wiring is allowed",
    path: "src/serve/adapter.ts",
    src:
      "export function wire(execution: any, runStore: any) { execution.setRunStore(runStore); }\n",
    want: "",
  },
];

Deno.test("production architecture guard detects canonical run bypasses", async (t) => {
  for (const tc of bypassCases) {
    await t.step(tc.name, () => {
      const root = Deno.makeTempDirSync();
      try {
        const target = join(root, tc.path);
        Deno.mkdirSync(join(root, tc.path, ".."), { recursive: true });
        Deno.writeTextFileSync(target, tc.src);
        const violations = productionViolations(root);
        const joined = formatViolations(violations);
        if (tc.want === "") {
          assertEquals(violations, [], `unexpected violations:\n${joined}`);
          return;
        }
        assert(
          joined.includes(tc.want),
          `violations ${JSON.stringify(joined)} do not contain ${
            JSON.stringify(tc.want)
          }`,
        );
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });
  }
});
