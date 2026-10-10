// Task 6 boundary: the TUI production graph is a `TUIService`/Core Client
// projection. `src/tui/**` and `src/cli/root_tui.ts` may not import Agent,
// SessionRuntime, session-lifecycle/fork, provider-construction, session-store,
// or DAO modules, and `TUISession` may not construct runtime owners (`Builder`,
// `createAgentManager`, `createSession`, `DecisionService`). The canonical event
// vocabulary arrives through `src/agentruntime/events.ts` instead.

import { runtime as nodeRuntime } from "../platform/runtime.ts";
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "../compat/assert.ts";
import { fromFileUrl, join } from "../compat/path.ts";
import {
  importSpecifiers,
  isTuiFrontendPath,
  productionViolations,
  TUI_FORBIDDEN_IMPORT_ROOTS,
  tuiBoundaryViolations,
  type Violation,
} from "../architecture/guard.ts";
import { test } from "#testing";

const projectRoot = fromFileUrl(new URL("../../", import.meta.url));

function formatViolations(violations: Violation[]): string {
  return violations.map((v) => `${v.file}: ${v.message}`).join("\n- ");
}

/** Task 6 scope: the whole TUI/CLI front-end graph, print included. */
function task6Violations(root: string): Violation[] {
  // `src/cli/root_print.ts` is held to the same boundary as the interactive
  // entries: it only ever had a transitional exclusion, which is now removed
  // (it reports zero violations and stays enforced like every other entry).
  return tuiBoundaryViolations(root);
}

test("TUI production graph has no runtime-owner bypass", () => {
  const violations = task6Violations(projectRoot);
  assertEquals(
    violations,
    [],
    `TUI boundary violations:\n- ${formatViolations(violations)}`,
  );
});

test("TUI boundary rejects banned imports and constructions", () => {
  const root = nodeRuntime.makeTempDirSync();
  try {
    const tuiDir = join(root, "src/tui");
    nodeRuntime.mkdirSync(tuiDir, { recursive: true });
    nodeRuntime.mkdirSync(join(root, "src/cli"), { recursive: true });
    nodeRuntime.writeTextFileSync(
      join(tuiDir, "session.ts"),
      [
        'import { Builder } from "../agentruntime/session_runtime.ts";',
        'import { listForDirDetailed } from "../session/manager.ts";',
        'import { create } from "../provider/factory/factory.ts";',
        'import { EVENT_TEXT_DELTA } from "../agent/events.ts";',
        "export function build() {",
        "  return new Builder(create, listForDirDetailed, EVENT_TEXT_DELTA);",
        "}",
      ].join("\n"),
    );
    nodeRuntime.writeTextFileSync(
      join(root, "src/tui/service.ts"),
      'import { DecisionService } from "../agentruntime/decision.ts";\n' +
        "export const decisions = new DecisionService();\n",
    );
    nodeRuntime.writeTextFileSync(
      join(root, "src/cli/root_tui.ts"),
      'import { createSession } from "../agentruntime/session_lifecycle.ts";\n' +
        "export const manager = createSession({ workDir: '.' });\n",
    );

    const violations = productionViolations(root);
    const joined = formatViolations(violations);
    for (const specifier of [
      "../agentruntime/session_runtime.ts",
      "../session/manager.ts",
      "../provider/factory/factory.ts",
      "../agent/events.ts",
    ]) {
      assert(
        joined.includes(specifier),
        `expected banned import ${specifier} to be rejected:\n${joined}`,
      );
    }
    // Every documented ban root stays part of the guard surface.
    for (const bannedRoot of TUI_FORBIDDEN_IMPORT_ROOTS) {
      assert(bannedRoot.startsWith("src/"), bannedRoot);
    }
    assert(joined.includes("TUI front-end constructs Builder"));
    assertStringIncludes(joined, "TUI front-end constructs DecisionService");
    assertStringIncludes(joined, "TUI front-end constructs createSession");
    // The pure service port must not import runtime implementation modules at
    // all (`src/agentruntime/decision.ts` is rejected there too).
    assert(
      violations.some(
        (violation) =>
          violation.file === "src/tui/service.ts" &&
          violation.message.includes("../agentruntime/decision.ts"),
      ),
    );
  } finally {
    nodeRuntime.removeSync(root, { recursive: true });
  }
});

test("TUISession and root_tui keep the ownership rules", () => {
  const forbiddenSpecifiers = [
    "session_runtime",
    "session_lifecycle",
    "provider/",
    "session/",
    "dao/",
    "agent/",
  ];
  for (const rel of [
    "src/tui/tui_session.ts",
    "src/cli/root_tui.ts",
    "src/cli/root_print.ts",
  ]) {
    const src = nodeRuntime.readTextFileSync(join(projectRoot, rel));
    for (const specifier of importSpecifiers(src)) {
      for (const forbidden of forbiddenSpecifiers) {
        assert(
          !specifier.includes(forbidden),
          `${rel} imports ${specifier} (${forbidden})`,
        );
      }
    }
    // Runtime-owner constructions stay Core-owned (plan: Builder,
    // createAgentManager, createSession, DecisionService).
    for (const pattern of [
      /\bnew\s+Builder\s*\(/,
      /\bcreateAgentManager\s*\(/,
      /(?<![.\w$])createSession\s*\(/,
      /\bnew\s+DecisionService\s*\(/,
      /\bloadSettingsWithMeta\s*\(/,
    ]) {
      assertEquals(
        pattern.exec(src),
        null,
        `${rel} matches forbidden construction ${pattern}`,
      );
    }
  }
  assert(isTuiFrontendPath("src/tui/tui_session.ts"));
  assert(isTuiFrontendPath("src/cli/root_tui.ts"));
  assert(!isTuiFrontendPath("src/core/runtime_host.ts"));
});
