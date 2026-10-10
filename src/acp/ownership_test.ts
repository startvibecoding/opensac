import { assert, assertEquals } from "../compat/assert.ts";
import { fromFileUrl, join } from "../compat/path.ts";
import { productionViolations, type Violation } from "../architecture/guard.ts";
import { test } from "#testing";

function formatViolations(violations: Violation[]): string {
  return violations.map((violation) =>
    `${violation.file}: ${violation.message}`
  ).join("\n- ");
}

const projectRoot = fromFileUrl(new URL("../../", import.meta.url));

test("production ACP entry cannot import runtime implementation modules", () => {
  const violations = productionViolations(projectRoot).filter(
    (violation) => violation.file === "src/acp/run.ts",
  );
  assertEquals(violations, [], formatViolations(violations));
});

test("ACP public surface does not export the legacy management router", () => {
  const source = Deno.readTextFileSync(join(projectRoot, "src/acp/mod.ts"));
  assertEquals(source.includes('export * from "./manage.ts";'), false);
  assertEquals(source.includes('export * from "./manage_skillhub.ts";'), false);
  assertEquals(
    source.includes('export * from "./manage_knowledge_bases.ts";'),
    false,
  );
});

test("ACP bridge files cannot import runtime implementation modules", () => {
  const root = Deno.makeTempDirSync();
  try {
    const acpDir = join(root, "src/acp");
    Deno.mkdirSync(acpDir, { recursive: true });
    Deno.writeTextFileSync(
      join(acpDir, "bridge.ts"),
      [
        'import { SessionRuntime } from "../agentruntime/session_runtime.ts";',
        'import { Agent } from "../agent/agent.ts";',
        'import { openRootDB } from "../db/index.ts";',
        "export const value = [SessionRuntime, Agent, openRootDB];",
      ].join("\n"),
    );

    const violations = productionViolations(root).filter(
      (violation) => violation.file === "src/acp/bridge.ts",
    );
    assert(
      violations.some((violation) =>
        violation.message.includes(
          "ACP bridge imports runtime implementation module",
        )
      ),
      `expected ACP bridge import violation:\n- ${
        formatViolations(violations)
      }`,
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

test("ACP bridge files cannot directly construct runtime owners", () => {
  const root = Deno.makeTempDirSync();
  try {
    const acpDir = join(root, "src/acp");
    Deno.mkdirSync(acpDir, { recursive: true });
    Deno.writeTextFileSync(
      join(acpDir, "bridge_extensions.ts"),
      [
        'import { Agent } from "../agent/agent.ts";',
        'import { SessionRuntime } from "../agentruntime/session_runtime.ts";',
        "export function build() {",
        "  return [new Agent(), new SessionRuntime()];",
        "}",
      ].join("\n"),
    );

    const violations = productionViolations(root).filter(
      (violation) => violation.file === "src/acp/bridge_extensions.ts",
    );
    assert(
      violations.some((violation) => violation.message.includes("ACP bridge")),
      `expected ACP bridge ownership violation:\n- ${
        formatViolations(violations)
      }`,
    );
    assertEquals(
      violations.some((violation) =>
        violation.message.includes("direct new Agent")
      ),
      true,
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});
