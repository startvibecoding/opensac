import { assert, assertEquals } from "@opensac/assert";
import {
  auditVerdictPass,
  parseAuditReport,
  parseRecoveryReport,
  parseWorkerReport,
  recoveryDecisionResume,
  workerStatusCompleteCandidate,
} from "./report.ts";

Deno.test("ParseWorkerReport extracts JSON", () => {
  const report = parseWorkerReport(
    '```json\n{"status":"complete_candidate","summary":"done","evidence":["test passed"],"remaining_work":[],"blockers":[]}\n```',
  );
  assertEquals(report.status, workerStatusCompleteCandidate);
  assertEquals(report.summary, "done");
  assertEquals(report.evidence.length, 1);
});

Deno.test("ParseWorkerReport accepts missing_work alias", () => {
  const report = parseWorkerReport(
    '{"status":"continue","summary":"working","missing_work":[" add tests ","  "]}',
  );
  assertEquals(report.remainingWork, ["add tests"]);
});

Deno.test("ParseWorkerReport merges and deduplicates remaining work", () => {
  const report = parseWorkerReport(
    '{"status":"continue","summary":"working","remaining_work":[" implement fix ","run tests"],"missing_work":["implement fix"," update docs ","run tests"]}',
  );
  assertEquals(report.remainingWork, [
    "implement fix",
    "run tests",
    "update docs",
  ]);
});

Deno.test("ParseAuditReport rejects invalid verdict", () => {
  let threw = false;
  try {
    parseAuditReport('{"verdict":"maybe","review":"unclear"}');
  } catch {
    threw = true;
  }
  assert(threw, "ParseAuditReport accepted invalid verdict");
});

Deno.test("ParseAuditReport pass", () => {
  const report = parseAuditReport(
    '{"verdict":"pass","review":"verified","requirements_checked":["req -> ok"],"missing_work":[],"evidence":["deno test"]}',
  );
  assertEquals(report.verdict, auditVerdictPass);
  assertEquals(report.review, "verified");
  assertEquals(report.requirementsChecked.length, 1);
});

Deno.test("ParseRecoveryReport", () => {
  const report = parseRecoveryReport(
    '{"decision":"resume","summary":"tests show the partial change is valid","evidence":["deno test ./..."],"remaining_work":["finish docs"],"blockers":[]}',
  );
  assertEquals(report.decision, recoveryDecisionResume);
  assert(report.summary !== "");
  assertEquals(report.remainingWork.length, 1);

  let threw = false;
  try {
    parseRecoveryReport(
      '{"decision":"blocked","summary":"cannot continue","blockers":[]}',
    );
  } catch {
    threw = true;
  }
  assert(threw, "ParseRecoveryReport accepted blocked report without blocker");
});
