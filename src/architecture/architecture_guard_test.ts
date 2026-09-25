import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  coreBoundaryAllowlist,
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
// canonical Run persistence. The Core allowlist is file-specific and remains
// subject to the same Agent/runtime checks as every other production module.
Deno.test("production architecture guard", () => {
  const violations = productionViolations(projectRoot);
  assertEquals(
    violations,
    [],
    `production architecture violations:\n- ${formatViolations(violations)}`,
  );
});

Deno.test("Core boundary allowlist is narrow and preserves Agent construction guards", () => {
  const root = Deno.makeTempDirSync();
  try {
    const coreDir = join(root, "src/core");
    Deno.mkdirSync(coreDir, { recursive: true });
    Deno.writeTextFileSync(
      join(coreDir, "server.ts"),
      [
        'import { Agent } from "../agent/agent.ts";',
        'export function build() { return new Agent("id", "", {}, {}); }',
      ].join("\n"),
    );
    Deno.writeTextFileSync(
      join(coreDir, "client.ts"),
      [
        'export * from "../agent/agent.ts";',
        'const name = "agent";',
        "const mod = await import(`../agent/${name}.ts`);",
        'import "../esm/runtime_core.ts";',
        'import "../context/contextfiles.ts";',
        'import "../ai/example.ts";',
        'const dynamicName = "agent";',
        'const concatenated = await import("../agent/" + dynamicName + ".ts");',
      ].join("\n"),
    );
    Deno.writeTextFileSync(
      join(coreDir, "unreviewed.ts"),
      "export const value = true;\n",
    );

    const violations = productionViolations(root);
    const joined = formatViolations(violations);
    const clientViolations = violations.filter(
      (violation) => violation.file === "src/core/client.ts",
    );
    assert(
      clientViolations.some((violation) =>
        violation.message.includes(
          "Core foundation imports runtime implementation module",
        )
      ),
    );
    assert(
      clientViolations.some((violation) =>
        violation.message.includes("non-literal dynamic import")
      ),
    );
    for (const specifier of ["../esm/", "../context/", "../ai/"]) {
      assert(
        clientViolations.some((violation) =>
          violation.message.includes(specifier)
        ),
        `expected omitted Core dependency ${specifier}`,
      );
    }
    assert(joined.includes("direct new Agent"));
    assert(joined.includes("explicitly classified"));
    assert(
      Object.keys(coreBoundaryAllowlist).every((path) =>
        path.startsWith("src/core/") && path.endsWith(".ts")
      ),
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("Core boundary rejects a concatenated dynamic import independently", () => {
  const root = Deno.makeTempDirSync();
  try {
    const coreDir = join(root, "src/core");
    Deno.mkdirSync(coreDir, { recursive: true });
    Deno.writeTextFileSync(
      join(coreDir, "client.ts"),
      [
        'const name = "agent";',
        'const mod = await import("../agent/" + name + ".ts");',
      ].join("\n"),
    );

    const violations = productionViolations(root).filter(
      (violation) => violation.file === "src/core/client.ts",
    );
    assertEquals(
      violations.filter((violation) =>
        violation.message.includes("non-literal dynamic import")
      ).length,
      1,
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("Core Runtime Host is the narrow runtime import exception", () => {
  const root = Deno.makeTempDirSync();
  try {
    const coreDir = join(root, "src/core");
    Deno.mkdirSync(coreDir, { recursive: true });
    Deno.writeTextFileSync(
      join(coreDir, "runtime_host.ts"),
      [
        'import type { RuntimeSource } from "../agentruntime/source.ts";',
        "export type Source = RuntimeSource;",
      ].join("\n"),
    );

    const violations = productionViolations(root).filter(
      (violation) => violation.file === "src/core/runtime_host.ts",
    );
    assertEquals(violations, []);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
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
    'export * from "../agent/agent.ts";',
    'export { Runtime } from "../agentruntime/index.ts";',
    'const mod = await import("./dynamic.ts");',
  ].join("\n");
  assertEquals(importSpecifiers(source), [
    "../session/run_store.ts",
    "node:sqlite",
    "side-effect",
    "../agent/agent.ts",
    "../agentruntime/index.ts",
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
    path: "src/acp/adapter.ts",
    src: [
      'import { createSessionRun } from "../session/run_store.ts";',
      'export function persist() { createSessionRun("", {} as never); }',
    ].join("\n"),
    want: "direct session.createSessionRun",
  },
  {
    name: "session run query",
    path: "src/acp/adapter.ts",
    src: [
      'import { getSessionRun } from "../session/run_store.ts";',
      'export function inspect() { getSessionRun("", "run"); }',
    ].join("\n"),
    want: "direct session.getSessionRun",
  },
  {
    name: "run store update",
    path: "src/acp/adapter.ts",
    src: 'export function persist(runStore: any) { runStore.update("run"); }\n',
    want: "direct agentruntime.RunStore.update",
  },
  {
    name: "run store finish",
    path: "src/acp/adapter.ts",
    src: 'export function persist(runStore: any) { runStore.finish("run"); }\n',
    want: "direct agentruntime.RunStore.finish",
  },
  {
    name: "legacy runtime lease",
    path: "src/acp/new_adapter.ts",
    src: [
      'import { tryLockRuntime } from "../session/runtime_lock.ts";',
      'export function reserve() { tryLockRuntime("", "session"); }',
    ].join("\n"),
    want: "new use of legacy session.tryLockRuntime",
  },
  {
    name: "legacy attachment delivery",
    path: "src/acp/new_adapter.ts",
    src: "export function project(s: any) { s.beginDelivery(); }\n",
    want: "new use of legacy attachment delivery API beginDelivery",
  },
  {
    name: "direct SQL handle",
    path: "src/acp/new_adapter.ts",
    src: 'export function persist(db: any) { db.exec("SELECT 1"); }\n',
    want: "direct database exec",
  },
  {
    name: "direct agent construction",
    path: "src/acp/new_adapter.ts",
    src:
      'export function build(reg: any) { return new Agent("id", "", {}, reg); }\n',
    want: "direct new Agent",
  },
  {
    name: "foreign key enforcement DSN pragma",
    path: "src/acp/adapter.ts",
    src: 'export const open = "file:db?_pragma=foreign_keys(ON)";\n',
    want: "SQLite foreign key enforcement is owned by src/db",
  },
  {
    name: "foreign key enforcement equality pragma",
    path: "src/acp/adapter.ts",
    src: 'export const open = "PRAGMA foreign_keys = 1";\n',
    want: "SQLite foreign key enforcement is owned by src/db",
  },
  {
    name: "foreign key enforcement lowercase pragma",
    path: "src/acp/adapter.ts",
    src: 'export const open = "pragma foreign_keys = true";\n',
    want: "SQLite foreign key enforcement is owned by src/db",
  },
  {
    name: "foreign key disable pragma is allowed",
    path: "src/acp/adapter.ts",
    src: 'export const open = "PRAGMA foreign_keys = OFF";\n',
    want: "",
  },
  {
    name: "bare foreign_keys pragma without enable value is allowed",
    path: "src/acp/adapter.ts",
    src: 'export const open = "PRAGMA foreign_keys";\n',
    want: "",
  },
  {
    name: "runtime store wiring is allowed",
    path: "src/acp/adapter.ts",
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
