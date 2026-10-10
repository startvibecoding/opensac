// decision_replay_test.go, decision_resolver_test.go, decision_contract_test.go,
// and decision_rehydrate_test.go.

import { assertEquals, assertThrows } from "../compat/assert.ts";
import {
  DECISION_APPROVAL,
  DECISION_QUESTION,
  DecisionService,
} from "./decision.ts";
import {
  createDecisionRequestRecord,
  createDecisionResolutionRecord,
} from "./decision_record.ts";
import {
  expiredDecisions,
  replayDecisions,
  replayDecisionsAt,
} from "./decision_replay.ts";
import { test } from "#testing";

test("DecisionRecord keeps protocol-neutral payload", () => {
  const request = {
    id: "approval-1",
    sessionId: "session-1",
    runId: "run-1",
    kind: DECISION_APPROVAL,
  };
  const record = createDecisionRequestRecord(request, { tool: "bash" });
  assertEquals(record.status, "pending");
  assertEquals(record.id, request.id);
  assertEquals(record.kind, request.kind);
  assertEquals((record.payload as Record<string, unknown>)["tool"], "bash");

  const resolved = createDecisionResolutionRecord(request, {
    id: request.id,
    kind: request.kind,
    status: "resolved",
    value: "approve_once",
  }, { action: "approve_once" });
  assertEquals(resolved.status, "resolved");
  assertEquals(resolved.value, "approve_once");
});

test("ReplayDecisions omits expired pending", () => {
  const now = new Date();
  const records = [
    {
      id: "expired",
      sessionId: "",
      runId: "run-1",
      kind: DECISION_APPROVAL,
      status: "pending",
      expiresAt: new Date(now.getTime() - 1000),
    },
    {
      id: "active",
      sessionId: "",
      runId: "run-1",
      kind: DECISION_QUESTION,
      status: "pending",
      expiresAt: new Date(now.getTime() + 60_000),
    },
  ];
  const pending = replayDecisionsAt(records, now);
  assertEquals(pending.size, 1);
  assertEquals(pending.get("active")?.id, "active");
  const expired = expiredDecisions(records, now);
  assertEquals(expired.length, 1);
  assertEquals(expired[0].id, "expired");
});

test("ExpiredDecisions honors later resolution", () => {
  const now = new Date();
  const expired = expiredDecisions([
    {
      id: "approval-1",
      sessionId: "",
      runId: "run-1",
      kind: DECISION_APPROVAL,
      status: "pending",
      expiresAt: new Date(now.getTime() - 1000),
    },
    {
      id: "approval-1",
      sessionId: "",
      runId: "run-1",
      kind: DECISION_APPROVAL,
      status: "resolved",
    },
  ], now);
  assertEquals(expired.length, 0);
});

test("ReplayDecisions pairs request and resolution", () => {
  const pending = replayDecisions([
    {
      id: "approval-1",
      sessionId: "",
      runId: "run-1",
      kind: DECISION_APPROVAL,
      status: "pending",
    },
    {
      id: "question-1",
      sessionId: "",
      runId: "run-1",
      kind: DECISION_QUESTION,
      status: "pending",
    },
    {
      id: "approval-1",
      sessionId: "",
      runId: "run-1",
      kind: DECISION_APPROVAL,
      status: "resolved",
      value: "approve_once",
    },
  ]);
  assertEquals(pending.size, 1);
  assertEquals(pending.get("question-1")?.kind, DECISION_QUESTION);
});

test("DecisionService bind and clearRunWithValue", () => {
  const service = new DecisionService();
  service.register({
    id: "question-1",
    runId: "run-1",
    kind: DECISION_QUESTION,
  });
  let resolved = "";
  service.bind("question-1", (value) => {
    resolved = value;
  });
  service.resolve({
    id: "question-1",
    kind: DECISION_QUESTION,
    status: "resolved",
    value: "yes",
  });
  assertEquals(resolved, "yes");

  service.register({
    id: "approval-1",
    runId: "run-1",
    kind: DECISION_APPROVAL,
  });
  resolved = "";
  service.bind("approval-1", (value) => {
    resolved = value;
  });
  const cleared = service.clearRunWithValue("run-1", "cancelled");
  assertEquals(cleared.length, 1);
  assertEquals(cleared[0].id, "approval-1");
  assertEquals(resolved, "cancelled");
  assertEquals(service.pending().length, 0);
});

test("DecisionService contract across kinds and runs", () => {
  const service = new DecisionService();
  const requests = [
    {
      id: "approval-1",
      runId: "run-1",
      sessionId: "session-1",
      kind: DECISION_APPROVAL,
    },
    {
      id: "question-1",
      runId: "run-1",
      sessionId: "session-1",
      kind: DECISION_QUESTION,
    },
    {
      id: "approval-2",
      runId: "run-2",
      sessionId: "session-2",
      kind: DECISION_APPROVAL,
    },
  ];
  for (const request of requests) service.register(request);
  assertThrows(() =>
    service.resolve({
      id: "approval-1",
      kind: DECISION_QUESTION,
      status: "resolved",
    })
  );
  assertEquals(service.pending().length, requests.length);

  const cleared = service.clearRun("run-1");
  assertEquals(cleared.length, 2);
  const pending = service.pending();
  assertEquals(pending.length, 1);
  assertEquals(pending[0].id, "approval-2");
});

test("DecisionService concurrent first response wins", async () => {
  const service = new DecisionService();
  service.register({
    id: "approval-race",
    runId: "run-race",
    kind: DECISION_APPROVAL,
  });
  const workers = 16;
  const results = await Promise.all(
    Array.from({ length: workers }, (_, i) =>
      Promise.resolve().then(() => {
        try {
          service.resolve({
            id: "approval-race",
            kind: DECISION_APPROVAL,
            status: "resolved",
            value: `decision-${i}`,
          });
          return true;
        } catch {
          return false;
        }
      })),
  );
  assertEquals(results.filter(Boolean).length, 1);
  assertEquals(service.pending().length, 0);
});

test("DecisionService rehydrate is sorted and idempotent", () => {
  const service = new DecisionService();
  const requests = service.rehydrate([
    {
      id: "z",
      sessionId: "s",
      runId: "r",
      kind: DECISION_QUESTION,
      status: "pending",
    },
    {
      id: "a",
      sessionId: "s",
      runId: "r",
      kind: DECISION_APPROVAL,
      status: "pending",
    },
  ]);
  assertEquals(requests.length, 2);
  assertEquals(requests[0].id, "a");
  assertEquals(requests[1].id, "z");
  const again = service.rehydrate([
    {
      id: "a",
      sessionId: "s",
      runId: "r",
      kind: DECISION_APPROVAL,
      status: "pending",
    },
  ]);
  assertEquals(again.length, 1);
  assertEquals(again[0].id, "a");
});

test("DecisionService rehydrate rejects conflict", () => {
  const service = new DecisionService();
  service.rehydrate([
    {
      id: "d",
      sessionId: "s",
      runId: "r1",
      kind: DECISION_APPROVAL,
      status: "pending",
    },
  ]);
  assertThrows(() =>
    service.rehydrate([
      {
        id: "d",
        sessionId: "s",
        runId: "r2",
        kind: DECISION_APPROVAL,
        status: "pending",
      },
    ])
  );
});

test("DecisionService clearRun resumes bound waiters", () => {
  const service = new DecisionService();
  service.register({
    id: "approval-clear",
    runId: "run-clear",
    kind: DECISION_APPROVAL,
  });
  let resumed: string | null = null;
  service.bind("approval-clear", (value) => {
    resumed = value;
  });
  service.register({
    id: "approval-sticky",
    runId: "run-clear",
    kind: DECISION_APPROVAL,
  });
  service.bind("approval-sticky", () => {
    throw new Error("resume failed");
  });

  const cleared = service.clearRun("run-clear");
  assertEquals(cleared.length, 1);
  assertEquals(cleared[0].id, "approval-clear");
  assertEquals(resumed, "");
  // A decision whose resume callback failed stays pending for a retried clear.
  const pending = service.pending();
  assertEquals(pending.length, 1);
  assertEquals(pending[0].id, "approval-sticky");
});

test("DecisionService failed commit retries without double resume", () => {
  const service = new DecisionService();
  service.register({
    id: "approval-commit",
    runId: "run-commit",
    kind: DECISION_APPROVAL,
  });
  let resumes = 0;
  service.bind("approval-commit", () => {
    resumes++;
  });

  assertThrows(() =>
    service.resolveWith(
      { id: "approval-commit", status: "resolved", value: "approve" },
      () => {
        throw new Error("persist failed");
      },
    )
  );
  assertEquals(resumes, 1);
  assertEquals(service.pending().length, 1);

  let commits = 0;
  const request = service.resolveWith(
    { id: "approval-commit", status: "resolved", value: "approve" },
    () => {
      commits++;
    },
  );
  assertEquals(request.id, "approval-commit");
  assertEquals(commits, 1);
  assertEquals(resumes, 1, "the resume callback must fire at most once");
  assertEquals(service.pending().length, 0);
});
