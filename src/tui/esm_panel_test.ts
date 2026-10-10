// Focused tests for TUI slice 2d: the renderutil ANSI-aware wrapper and the
// ESM panel rendering pipeline (phase/pipeline/progress math, field
// wrapping, live activity lines, full panel assembly).

import { assertEquals } from "../compat/assert.ts";
import {
  stripANSI,
  truncateANSI,
  visibleWidth,
  wrapANSI,
  wrapPlainText,
} from "./renderutil.ts";
import {
  activeESMPanelActivity,
  effectiveESMPhase,
  esmCompletedStages,
  esmPanelLines,
  esmPanelProgress,
  esmPanelWidth,
  esmPhaseActivityLabel,
  esmPhaseIndex,
  formatDurationMSForPanel,
  renderESMPipeline,
} from "./esm_panel.ts";
import { type Objective } from "../esm/state.ts";
import {
  statusBlocked,
  statusComplete,
  statusCompleteCandidate,
  statusPaused,
} from "../esm/state.ts";
import { type AgentActivity } from "./activity.ts";
import { Translator } from "./i18n.ts";
import { test } from "#testing";

function makeObjective(partial: Partial<Objective> = {}): Objective {
  return {
    sessionId: "s1",
    esmId: "e1",
    objective: "ship the feature",
    status: "active",
    tokensUsed: 1234,
    timeUsedMs: 65_000,
    blockedCount: 0,
    blockedReason: "",
    blockedRunId: "",
    completionReason: "",
    completionRunId: "",
    completionReview: "",
    phase: "",
    progressSummary: "",
    remainingWork: [],
    rejectionCount: 0,
    rejectionRunId: "",
    recoveryCount: 0,
    recoveryReason: "",
    createdAt: new Date("2026-09-20T10:00:00"),
    updatedAt: new Date("2026-09-20T11:00:00"),
    ...partial,
  };
}

const tr = new Translator("en");

// ─── renderutil ─────────────────────────────────────────────────────────────

test("visibleWidth counts cells, CJK doubles, ANSI zero", () => {
  assertEquals(visibleWidth("abc"), 3);
  assertEquals(visibleWidth("中文"), 4);
  assertEquals(visibleWidth("\u001B[31mred\u001B[0m"), 3);
  assertEquals(visibleWidth("a\tb"), 5); // tab → 3 spaces
  assertEquals(visibleWidth(""), 0);
});

test("wrapPlainText hard-wraps at cell boundaries", () => {
  assertEquals(wrapPlainText("short", 10), "short");
  assertEquals(wrapPlainText("abcdefghij", 4), "abcd\nefgh\nij");
  // CJK: two cells per rune → 4-wide line holds 2 runes
  assertEquals(wrapPlainText("中文中文中", 4), "中文\n中文\n中");
  assertEquals(wrapPlainText("", 10), "");
  assertEquals(wrapPlainText("abc", 0), "abc"); // width<=0 passthrough
});

test("wrapPlainText preserves ANSI styling across breaks", () => {
  const styled = "\u001B[31mabcdefgh\u001B[0m";
  const wrapped = wrapPlainText(styled, 3);
  const lines = wrapped.split("\n");
  assertEquals(lines.length, 3);
  assertEquals(stripANSI(wrapped).split("\n").join(""), "abcdefgh");
});

test("wrapANSI breaks at word and path boundaries", () => {
  assertEquals(wrapANSI("hello world", 5), "hello\nworld");
  assertEquals(wrapANSI("/a/b/c", 4), "/a/b\nc");
  assertEquals(wrapANSI("short", 10), "short");
});

test("truncateANSI truncates without breaking escapes", () => {
  assertEquals(truncateANSI("abcdef", 3), "abc");
  assertEquals(
    truncateANSI("\u001B[31mabcdef\u001B[0m", 3),
    "\u001B[31mabc\u001B[0m",
  );
  assertEquals(truncateANSI("\u001B[31mabcdef", 3), "\u001B[31mabc");
  assertEquals(truncateANSI("abcdef", 10), "abcdef");
  assertEquals(truncateANSI("abcdef", 0), "");
  assertEquals(stripANSI(truncateANSI("\u001B[31mabcdef\u001B[0m", 3)), "abc");
});

// ─── esm panel ──────────────────────────────────────────────────────────────

test("esmPanelWidth matches the Go defaults", () => {
  assertEquals(esmPanelWidth(80), 76);
  assertEquals(esmPanelWidth(0), 76);
  assertEquals(esmPanelWidth(-5), 76);
  assertEquals(esmPanelWidth(4), 1);
});

test("effectiveESMPhase falls back from status", () => {
  assertEquals(effectiveESMPhase(makeObjective({ phase: "critic" })), "critic");
  assertEquals(effectiveESMPhase(makeObjective({ phase: "" })), "worker");
  assertEquals(
    effectiveESMPhase(makeObjective({ phase: "", status: statusComplete })),
    "complete",
  );
  assertEquals(
    effectiveESMPhase(
      makeObjective({ phase: "", status: statusCompleteCandidate }),
    ),
    "critic",
  );
});

test("esmPhaseIndex and completed stages ladder", () => {
  assertEquals(esmPhaseIndex("worker"), 0);
  assertEquals(esmPhaseIndex("critic"), 1);
  assertEquals(esmPhaseIndex("audit"), 2);
  assertEquals(esmPhaseIndex("complete"), 3);
  assertEquals(esmCompletedStages("worker"), 0);
  assertEquals(esmCompletedStages("critic"), 1);
  assertEquals(esmCompletedStages("complete"), 3);
});

test("renderESMPipeline marks current, done, and paused stages", () => {
  assertEquals(
    renderESMPipeline("worker", "active", tr),
    "[>] Worker execution -> [ ] Critic review -> [ ] Final audit",
  );
  assertEquals(
    renderESMPipeline("critic", "active", tr).startsWith(
      "[x] Worker execution -> [>] Critic review",
    ),
    true,
  );
  assertEquals(
    renderESMPipeline("worker", statusPaused, tr).startsWith(
      "[!] Worker execution",
    ),
    true,
  );
  // Complete phase marks everything done
  assertEquals(
    renderESMPipeline("complete", statusComplete, tr).startsWith("[x] Worker"),
    true,
  );
});

test("esmPhaseActivityLabel prefers status over phase", () => {
  assertEquals(
    esmPhaseActivityLabel("worker", "active", tr),
    "Worker is investigating and implementing the objective",
  );
  assertEquals(
    esmPhaseActivityLabel("worker", statusBlocked, tr),
    "ESM is blocked",
  );
  assertEquals(
    esmPhaseActivityLabel("critic", "active", tr),
    "Critic is independently reviewing the worker evidence",
  );
  assertEquals(
    esmPhaseActivityLabel("audit", "active", tr),
    "Audit is independently verifying completion",
  );
  assertEquals(
    esmPhaseActivityLabel("audit", statusComplete, tr),
    "The objective has passed final audit",
  );
});

test("esmPanelProgress reports stages and remaining work", () => {
  const obj = makeObjective({ remainingWork: ["a", "b"] });
  assertEquals(
    esmPanelProgress(obj, "worker", tr),
    "Progress: 0/3 pipeline stages completed; 2 work item(s) remaining",
  );
  const none = makeObjective();
  assertEquals(
    esmPanelProgress(none, "audit", tr),
    "Progress: 2/3 pipeline stages completed",
  );
});

test("esmPanelLines renders no-objective guidance", () => {
  const lines = esmPanelLines(null, 76, tr);
  assertEquals(
    lines[0],
    "No Enable Supervisor Mode objective for this session.",
  );
  assertEquals(lines[2], "Create one with /esm <objective>.");
});

test("esmPanelLines assembles the full objective view", () => {
  const obj = makeObjective({
    phase: "critic",
    progressSummary: "worker finished task 1",
    remainingWork: ["write tests", "update docs"],
    rejectionCount: 2,
    recoveryCount: 1,
    recoveryReason: "provider hiccup",
  });
  const lines = esmPanelLines(obj, 76, tr);
  const text = lines.join("\n");
  assertEquals(lines[0], "Enable Supervisor Mode");
  assertEquals(
    text.includes("Now: Critic is independently reviewing the worker evidence"),
    true,
  );
  assertEquals(
    text.includes(
      "Progress: 1/3 pipeline stages completed; 2 work item(s) remaining",
    ),
    true,
  );
  assertEquals(text.includes("Status: active"), true);
  assertEquals(text.includes("Stage: Critic review"), true);
  assertEquals(
    text.includes("Pipeline: [x] Worker execution -> [>] Critic review"),
    true,
  );
  assertEquals(text.includes("Objective: ship the feature"), true);
  assertEquals(
    text.includes("Latest worker progress: worker finished task 1"),
    true,
  );
  assertEquals(text.includes("Remaining work (2):"), true);
  assertEquals(text.includes("  1. write tests"), true);
  assertEquals(text.includes("  2. update docs"), true);
  assertEquals(text.includes("Consecutive completion rejections: 2"), true);
  assertEquals(text.includes("Consecutive automatic recoveries: 1"), true);
  assertEquals(text.includes("Latest recovery reason: provider hiccup"), true);
  assertEquals(text.includes("Tokens: 1234"), true);
  assertEquals(text.includes("Time: 1m05s"), true);
  assertEquals(text.includes("Last saved update:"), true);
});

test("esmPanelLines reports load errors", () => {
  const lines = esmPanelLines(makeObjective(), 76, tr, undefined, {
    loadError: "db unavailable",
  });
  assertEquals(lines.length, 1);
  assertEquals(lines[0], "Failed to load ESM progress: db unavailable");
});

test("esmPanelLines appends live activity for the active agent", () => {
  const obj = makeObjective();
  // No active agent: no live details section
  const plain = esmPanelLines(obj, 76, tr);
  assertEquals(plain.some((l) => l.includes("Live details:")), false);

  // Active agent without a snapshot yet
  const starting = esmPanelLines(obj, 76, tr, { activeAgentId: "a1" });
  assertEquals(starting.some((l) => l.includes("a1")), true);

  // Active agent with a snapshot
  const act: AgentActivity = {
    agentId: "a1",
    kind: "subagent",
    state: "running",
    lastThink: "",
    lastText: "",
    lastTool: "bash",
    lastResult: "",
    fullThink: "",
    fullText: "",
    fullResult: "",
    lastToolName: "bash",
    events: [],
  };
  const live = esmPanelLines(obj, 76, tr, {
    activeAgentId: "a1",
    activity: act,
  });
  const text = live.join("\n");
  assertEquals(text.includes("Live details:"), true);
  assertEquals(text.includes("a1 [running]"), true);
  assertEquals(text.includes("bash"), true);
});

test("activeESMPanelActivity falls back through result/text/think", () => {
  const base: AgentActivity = {
    agentId: "a1",
    kind: "subagent",
    state: "running",
    lastThink: "",
    lastText: "",
    lastTool: "",
    lastResult: "",
    fullThink: "",
    fullText: "",
    fullResult: "",
    lastToolName: "",
    events: [],
  };
  const result = activeESMPanelActivity(
    { activeAgentId: "a1", activity: { ...base, lastResult: "the result" } },
    76,
    tr,
  );
  assertEquals(result.some((l) => l.includes("the result")), true);

  const text = activeESMPanelActivity(
    { activeAgentId: "a1", activity: { ...base, lastText: "the text" } },
    76,
    tr,
  );
  assertEquals(text.some((l) => l.includes("the text")), true);

  const think = activeESMPanelActivity(
    { activeAgentId: "a1", activity: { ...base, lastThink: "deep thought" } },
    76,
    tr,
  );
  assertEquals(think.some((l) => l.includes("deep thought")), true);

  // Empty id yields no lines
  assertEquals(activeESMPanelActivity({ activeAgentId: "" }, 76, tr), []);
});

test("esmPanelLines wraps long fields to the panel width", () => {
  const obj = makeObjective({ objective: "x".repeat(200) });
  const lines = esmPanelLines(obj, 40, tr);
  for (const line of lines) {
    assertEquals(visibleWidth(line) <= 40, true, JSON.stringify(line));
  }
});

test("formatDurationMSForPanel switches units", () => {
  assertEquals(formatDurationMSForPanel(500), "500ms");
  assertEquals(formatDurationMSForPanel(65_000), "1m05s");
});
