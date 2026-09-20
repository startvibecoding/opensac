// Ported from internal/agentruntime/decision_record_test.go,
// decision_replay_test.go, decision_resolver_test.go, decision_contract_test.go,
// and decision_rehydrate_test.go.

import { assertEquals, assertThrows } from "@std/assert";
import {
  DecisionApproval,
  DecisionQuestion,
  DecisionService,
} from "./decision.ts";
import {
  newDecisionRequestRecord,
  newDecisionResolutionRecord,
} from "./decision_record.ts";
import {
  expiredDecisions,
  replayDecisions,
  replayDecisionsAt,
} from "./decision_replay.ts";

Deno.test("DecisionRecord keeps protocol-neutral payload", () => {
  const request = {
    id: "approval-1",
    sessionId: "session-1",
    runId: "run-1",
    kind: DecisionApproval,
  };
  const record = newDecisionRequestRecord(request, { tool: "bash" });
  assertEquals(record.status, "pending");
  assertEquals(record.id, request.id);
  assertEquals(record.kind, request.kind);
  assertEquals((record.payload as Record<string, unknown>)["tool"], "bash");

  const resolved = newDecisionResolutionRecord(request, {
    id: request.id,
    kind: request.kind,
    status: "resolved",
    value: "approve_once",
  }, { action: "approve_once" });
  assertEquals(resolved.status, "resolved");
  assertEquals(resolved.value, "approve_once");
});

Deno.test("ReplayDecisions omits expired pending", () => {
  const now = new Date();
  const records = [
    {
      id: "expired",
      sessionId: "",
      runId: "run-1",
      kind: DecisionApproval,
      status: "pending",
      expiresAt: new Date(now.getTime() - 1000),
    },
    {
      id: "active",
      sessionId: "",
      runId: "run-1",
      kind: DecisionQuestion,
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

Deno.test("ExpiredDecisions honors later resolution", () => {
  const now = new Date();
  const expired = expiredDecisions([
    {
      id: "approval-1",
      sessionId: "",
      runId: "run-1",
      kind: DecisionApproval,
      status: "pending",
      expiresAt: new Date(now.getTime() - 1000),
    },
    {
      id: "approval-1",
      sessionId: "",
      runId: "run-1",
      kind: DecisionApproval,
      status: "resolved",
    },
  ], now);
  assertEquals(expired.length, 0);
});

Deno.test("ReplayDecisions pairs request and resolution", () => {
  const pending = replayDecisions([
    {
      id: "approval-1",
      sessionId: "",
      runId: "run-1",
      kind: DecisionApproval,
      status: "pending",
    },
    {
      id: "question-1",
      sessionId: "",
      runId: "run-1",
      kind: DecisionQuestion,
      status: "pending",
    },
    {
      id: "approval-1",
      sessionId: "",
      runId: "run-1",
      kind: DecisionApproval,
      status: "resolved",
      value: "approve_once",
    },
  ]);
  assertEquals(pending.size, 1);
  assertEquals(pending.get("question-1")?.kind, DecisionQuestion);
});

Deno.test("DecisionService bind and clearRunWithValue", () => {
  const service = new DecisionService();
  service.register({
    id: "question-1",
    runId: "run-1",
    kind: DecisionQuestion,
  });
  let resolved = "";
  service.bind("question-1", (value) => {
    resolved = value;
  });
  service.resolve({
    id: "question-1",
    kind: DecisionQuestion,
    status: "resolved",
    value: "yes",
  });
  assertEquals(resolved, "yes");

  service.register({
    id: "approval-1",
    runId: "run-1",
    kind: DecisionApproval,
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

Deno.test("DecisionService contract across kinds and runs", () => {
  const service = new DecisionService();
  const requests = [
    {
      id: "approval-1",
      runId: "run-1",
      sessionId: "session-1",
      kind: DecisionApproval,
    },
    {
      id: "question-1",
      runId: "run-1",
      sessionId: "session-1",
      kind: DecisionQuestion,
    },
    {
      id: "approval-2",
      runId: "run-2",
      sessionId: "session-2",
      kind: DecisionApproval,
    },
  ];
  for (const request of requests) service.register(request);
  assertThrows(() =>
    service.resolve({
      id: "approval-1",
      kind: DecisionQuestion,
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

Deno.test("DecisionService concurrent first response wins", async () => {
  const service = new DecisionService();
  service.register({
    id: "approval-race",
    runId: "run-race",
    kind: DecisionApproval,
  });
  const workers = 16;
  const results = await Promise.all(
    Array.from({ length: workers }, (_, i) =>
      Promise.resolve().then(() => {
        try {
          service.resolve({
            id: "approval-race",
            kind: DecisionApproval,
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

Deno.test("DecisionService rehydrate is sorted and idempotent", () => {
  const service = new DecisionService();
  const requests = service.rehydrate([
    {
      id: "z",
      sessionId: "s",
      runId: "r",
      kind: DecisionQuestion,
      status: "pending",
    },
    {
      id: "a",
      sessionId: "s",
      runId: "r",
      kind: DecisionApproval,
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
      kind: DecisionApproval,
      status: "pending",
    },
  ]);
  assertEquals(again.length, 1);
  assertEquals(again[0].id, "a");
});

Deno.test("DecisionService rehydrate rejects conflict", () => {
  const service = new DecisionService();
  service.rehydrate([
    {
      id: "d",
      sessionId: "s",
      runId: "r1",
      kind: DecisionApproval,
      status: "pending",
    },
  ]);
  assertThrows(() =>
    service.rehydrate([
      {
        id: "d",
        sessionId: "s",
        runId: "r2",
        kind: DecisionApproval,
        status: "pending",
      },
    ])
  );
});
