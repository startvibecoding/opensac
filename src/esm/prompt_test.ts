import { assert } from "@opensac/assert";
import {
  auditTaskPrompt,
  criticTaskPrompt,
  steeringPrompt,
  workerTaskPrompt,
} from "./prompt.ts";
import { createUpdateTool } from "./tools.ts";
import { statusActive, statusCompleteCandidate } from "./state.ts";
import { makeObjective } from "./test_helpers.ts";

Deno.test("SteeringPrompt requires full objective audit", () => {
  const obj = makeObjective({
    sessionId: "sess",
    esmId: "esm",
    objective: "ship full goal <not demo> & verify",
    status: statusActive,
  });

  const prompt = steeringPrompt(obj);
  const required = [
    "Do not shrink it to a demo",
    "Completion audit before update_esm complete",
    "evidence proves every requirement",
    "Treat missing, weak, indirect, or uncertain evidence as not complete",
    "verification evidence in reason",
    "completion candidate only",
  ];
  for (const want of required) {
    assert(
      prompt.includes(want),
      `steeringPrompt missing ${JSON.stringify(want)}`,
    );
  }
  assert(!prompt.includes("<not demo>"), "objective was not escaped");
  assert(
    prompt.includes("&lt;not demo&gt; &amp; verify"),
    "escaped objective missing",
  );
});

Deno.test("UpdateTool requires reason", () => {
  const tool = createUpdateTool(null, () => "");
  const params = JSON.stringify(tool.parameters());
  assert(
    params.includes('"required":["status","reason"]'),
    `update_esm parameters do not require reason: ${params}`,
  );

  const guidelines = tool.promptGuidelines().join("\n");
  for (
    const want of [
      "complete_candidate",
      "Do not mark complete for a demo",
      "three consecutive ESM agent runs",
    ]
  ) {
    assert(
      guidelines.includes(want),
      `update_esm guidelines missing ${JSON.stringify(want)}`,
    );
  }
});

Deno.test("Worker and audit prompts use isolated roles", () => {
  const obj = makeObjective({
    objective: "ship real feature",
    status: statusCompleteCandidate,
    completionReason: "worker says complete",
    completionReview: "previous audit failed",
    blockedCount: 1,
    blockedReason: "missing token",
  });

  const worker = workerTaskPrompt(obj);
  for (
    const want of [
      "ESM worker sub-agent",
      "Work toward the full objective, not a demo",
      "complete_candidate",
      "Do not call get_esm or update_esm",
      "Previous failed completion audit",
    ]
  ) {
    assert(
      worker.includes(want),
      `WorkerTaskPrompt missing ${JSON.stringify(want)}`,
    );
  }

  const audit = auditTaskPrompt(obj);
  for (
    const want of [
      "ESM audit sub-agent",
      "must be skeptical",
      "Completion candidate evidence",
      "Pass only when your own tool-backed evidence proves the full objective is complete",
      "You must use tools to inspect the current repository state",
      '"verdict":"pass|fail"',
    ]
  ) {
    assert(
      audit.includes(want),
      `AuditTaskPrompt missing ${JSON.stringify(want)}`,
    );
  }

  const critic = criticTaskPrompt(obj);
  for (
    const want of [
      "ESM critic sub-agent",
      "challenge the worker's completion claim",
      "Look for demos",
      "Pass only when your own tool-backed inspection finds no hard blocker",
      "You must use tools to inspect the current repository state",
      '"verdict":"pass|fail"',
    ]
  ) {
    assert(
      critic.includes(want),
      `CriticTaskPrompt missing ${JSON.stringify(want)}`,
    );
  }
});
