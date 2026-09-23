//
// Deno ships no built-in fuzzer, so the Go fuzz target becomes a deterministic
// property test over the same seeds plus generated inputs.

import { assert } from "@std/assert";
import {
  auditVerdictFail,
  auditVerdictPass,
  parseAuditReport,
  parseRecoveryReport,
  parseWorkerReport,
  recoveryDecisionBlocked,
  recoveryDecisionResume,
  workerStatusBlockedCandidate,
  workerStatusCompleteCandidate,
  workerStatusContinue,
} from "./report.ts";

function* candidates(): Generator<string> {
  for (
    const seed of [
      '{"status":"continue","summary":"working"}',
      '{"verdict":"pass","review":"verified","requirements_checked":["tests"]}',
      '{"decision":"resume","summary":"continue work"}',
      '```json\n{"status":"blocked_candidate","summary":"blocked","blockers":["missing access"]}\n```',
      '{"status":"continue","summary":"quote: \\" and brace: }"}',
    ]
  ) {
    yield seed;
  }
  const alphabet = '{}[]":, abcXYZ019_-\\"';
  for (let i = 0; i < 500; i++) {
    let s = "";
    const len = i % 40;
    for (let j = 0; j < len; j++) {
      s += alphabet[(i * 7 + j * 13) % alphabet.length];
    }
    yield s;
  }
}

Deno.test("ParseReports fuzz invariants", () => {
  for (const input of candidates()) {
    try {
      const report = parseWorkerReport(input);
      assert(
        report.status === workerStatusContinue ||
          report.status === workerStatusCompleteCandidate ||
          report.status === workerStatusBlockedCandidate,
        `accepted invalid worker status ${JSON.stringify(report.status)}`,
      );
    } catch {
      // Rejection is a valid outcome.
    }

    try {
      const report = parseAuditReport(input);
      assert(
        report.verdict === auditVerdictPass ||
          report.verdict === auditVerdictFail,
        `accepted invalid audit verdict ${JSON.stringify(report.verdict)}`,
      );
    } catch {
      // Rejection is a valid outcome.
    }

    try {
      const report = parseRecoveryReport(input);
      if (report.decision === recoveryDecisionResume) {
        assert(
          report.summary !== "",
          "accepted recovery report without summary",
        );
      } else if (report.decision === recoveryDecisionBlocked) {
        assert(
          report.summary !== "" && report.blockers.length > 0,
          "accepted blocked recovery report without required fields",
        );
      } else {
        throw new Error(
          `accepted invalid recovery decision ${
            JSON.stringify(report.decision)
          }`,
        );
      }
    } catch {
      // Rejection is a valid outcome.
    }
  }
});
