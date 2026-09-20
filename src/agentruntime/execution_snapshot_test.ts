// Translated from internal/agentruntime/execution_snapshot_test.go.
//
// The Go tests drive a real session database and build raw
// `session_runtime_leases` fixtures to exercise the external/legacy/mismatched
// and verified-remote snapshot states. Raw SQL lease fixtures are allowed in
// tests (the DAO/DB rule governs production code). `time.Time` maps to `Date`.

import { assert, assertEquals } from "@std/assert";
import { newManager } from "../session/manager.ts";
import {
  acquireExecutionAdmission,
  acquireMutation,
  acquireRecovery,
} from "../session/mod.ts";
import { closeDatabases, openRootDB } from "../session/root_db.ts";
import { saveSessionRun, type SessionRun } from "../session/run_store.ts";
import {
  type ResponseRun,
  saveResponseRun,
} from "../session/response_store.ts";
import {
  type DurableRun,
  ExecutionRuntime,
  inspectSessionExecution,
  type RunEvent,
  RunStateCompleted,
  RunStateFailed,
  RunStateRunning,
  RunStore,
  SessionExecutionDetached,
  SessionExecutionExternal,
  SessionExecutionIdle,
  SessionExecutionInconsistent,
  SessionExecutionLocal,
  SessionExecutionOrphaned,
  SessionExecutionReserved,
} from "./mod.ts";

function makeRun(overrides: Partial<DurableRun>): DurableRun {
  return {
    id: "",
    sessionId: "",
    intentId: "",
    retryOf: "",
    attempt: 0,
    workDir: "",
    source: "",
    model: "",
    mode: "",
    status: "running",
    startedAt: new Date(),
    finishedAt: null,
    error: "",
    errorInfo: {},
    progress: {},
    usage: undefined,
    contextUsage: undefined,
    inputResourceIds: [],
    submissionKeyHash: "",
    submissionScope: "",
    submissionFingerprint: "",
    userEntryId: "",
    assistantEntryId: "",
    conversationTurnId: "",
    conversationTurn: false,
    ...overrides,
  };
}

function runEvent(
  sessionId: string,
  runId: string,
  eventType: string,
): RunEvent {
  return {
    sessionId,
    runId,
    eventType,
    source: "",
    status: "",
    model: "",
    mode: "",
    timestamp: new Date(),
  };
}

function baseSessionRun(overrides: Partial<SessionRun>): SessionRun {
  const now = new Date();
  return {
    id: "",
    sessionId: "",
    intentId: "",
    retryOf: "",
    attempt: 0,
    workDir: "",
    source: "",
    model: "",
    mode: "",
    status: "",
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    error: "",
    errorInfo: undefined,
    progress: undefined,
    usage: undefined,
    contextUsage: undefined,
    inputResourceIds: [],
    submissionKeyHash: "",
    submissionScope: "",
    submissionFingerprint: "",
    userEntryId: "",
    assistantEntryId: "",
    ...overrides,
  };
}

function initSession(sessionDir: string, id: string): void {
  const manager = newManager(Deno.makeTempDirSync(), sessionDir);
  manager.initWithID(id);
}

Deno.test("inspectSessionExecutionTracksLocalLifecycle", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "mothx-snapshot-" });
  try {
    initSession(sessionDir, "snapshot-local");
    const lease = acquireExecutionAdmission(sessionDir, "snapshot-local");
    try {
      const execution = new ExecutionRuntime();
      execution.setRunStore(new RunStore(sessionDir));
      const now = new Date();
      execution.beginDurable(
        undefined,
        makeRun({
          id: "run-local",
          sessionId: "snapshot-local",
          status: RunStateRunning,
          startedAt: now,
        }),
        runEvent("snapshot-local", "run-local", "started"),
      );

      let snapshot = inspectSessionExecution(sessionDir, "snapshot-local");
      assertEquals(snapshot.state, SessionExecutionLocal);
      assert(snapshot.running, "local run should be running");
      assert(!snapshot.canSubmit, "local run must not allow submit");
      assert(snapshot.canCancelLocal, "local run must allow local cancel");
      assert(snapshot.activeRun !== undefined, "local run projection missing");
      assertEquals(snapshot.activeRun!.id, "run-local");
      assertEquals(snapshot.linkageState, "bound");
      assertEquals(snapshot.leasePurpose, "execution");
      assert(snapshot.leaseEpoch > 0, "lease epoch must be set");
      assert(
        snapshot.leaseTokenIdentity !== "",
        "lease token identity must be set",
      );

      execution.finishDurable(
        "run-local",
        RunStateCompleted,
        "",
        runEvent("snapshot-local", "run-local", "finished"),
      );
      snapshot = inspectSessionExecution(sessionDir, "snapshot-local");
      assertEquals(snapshot.state, SessionExecutionReserved);
      assertEquals(snapshot.phase, "releasing");
      assert(!snapshot.canSubmit, "releasing lease must not allow submit");

      lease.release();
      snapshot = inspectSessionExecution(sessionDir, "snapshot-local");
      assertEquals(snapshot.state, SessionExecutionIdle);
      assert(!snapshot.busy, "idle session must not be busy");
      assert(snapshot.canSubmit, "idle session must allow submit");
    } finally {
      lease.release();
    }
  } finally {
    closeDatabases();
  }
});

Deno.test("inspectSessionExecutionDistinguishesExternalLegacyAndOrphaned", () => {
  const cases: {
    name: string;
    leasePurpose: string;
    leaseRunId: string;
    wantState: string;
    wantLinkage: string;
    wantRunning: boolean;
  }[] = [
    {
      name: "external",
      leasePurpose: "execution",
      leaseRunId: "run-active",
      wantState: SessionExecutionExternal,
      wantLinkage: "bound",
      wantRunning: true,
    },
    {
      name: "legacy unbound",
      leasePurpose: "run",
      leaseRunId: "",
      wantState: SessionExecutionExternal,
      wantLinkage: "legacy_unbound",
      wantRunning: true,
    },
    {
      name: "mismatched",
      leasePurpose: "execution",
      leaseRunId: "other-run",
      wantState: SessionExecutionInconsistent,
      wantLinkage: "mismatched",
      wantRunning: false,
    },
    {
      name: "orphaned",
      leasePurpose: "",
      leaseRunId: "",
      wantState: SessionExecutionOrphaned,
      wantLinkage: "none",
      wantRunning: false,
    },
  ];
  for (const testCase of cases) {
    const sessionDir = Deno.makeTempDirSync({ prefix: "mothx-snapshot-" });
    try {
      initSession(sessionDir, "snapshot-state");
      const now = new Date();
      saveSessionRun(
        sessionDir,
        baseSessionRun({
          id: "run-active",
          sessionId: "snapshot-state",
          status: "running",
          startedAt: now,
          updatedAt: now,
        }),
      );
      if (testCase.leasePurpose !== "") {
        const db = openRootDB(sessionDir);
        db.db!.run(
          `INSERT INTO session_runtime_leases
            (session_id, owner_instance_id, owner_pid, owner_kind,
             lease_token_hash, epoch, run_id, purpose, state, acquired_at,
             heartbeat_at, expires_at, updated_at)
           VALUES (?, 'external-owner', 4242, 'process', 'external-token', 7,
             ?, ?, 'active',
             CAST(strftime('%s','now') AS INTEGER),
             CAST(strftime('%s','now') AS INTEGER),
             CAST(strftime('%s','now') AS INTEGER) + 60,
             CAST(strftime('%s','now') AS INTEGER))`,
          "snapshot-state",
          testCase.leaseRunId,
          testCase.leasePurpose,
        );
      }

      const snapshot = inspectSessionExecution(sessionDir, "snapshot-state");
      assertEquals(
        snapshot.state,
        testCase.wantState,
        `${testCase.name}: state`,
      );
      assertEquals(
        snapshot.linkageState,
        testCase.wantLinkage,
        `${testCase.name}: linkage`,
      );
      assertEquals(
        snapshot.running,
        testCase.wantRunning,
        `${testCase.name}: running`,
      );
      assert(!snapshot.canSubmit, `${testCase.name}: must not allow submit`);
      assert(
        !snapshot.canCancelLocal,
        `${testCase.name}: must not allow local cancel`,
      );
    } finally {
      closeDatabases();
    }
  }
});

Deno.test("inspectSessionExecutionProjectsMutationAsReserved", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "mothx-snapshot-" });
  try {
    initSession(sessionDir, "snapshot-reserved");
    const lease = acquireMutation(sessionDir, "snapshot-reserved");
    try {
      const snapshot = inspectSessionExecution(sessionDir, "snapshot-reserved");
      assertEquals(snapshot.state, SessionExecutionReserved);
      assert(!snapshot.running, "mutation reservation must not be running");
      assert(snapshot.busy, "mutation reservation must be busy");
      assert(!snapshot.canSubmit, "mutation reservation must not allow submit");
      assertEquals(snapshot.displayOwnerScope, "local");
    } finally {
      lease.release();
    }
  } finally {
    closeDatabases();
  }
});

Deno.test(
  "inspectSessionExecutionRequiresCanonicalRemoteRecordForDetachedState",
  () => {
    const sessionDir = Deno.makeTempDirSync({ prefix: "mothx-snapshot-" });
    try {
      initSession(sessionDir, "snapshot-remote");
      const now = new Date();
      saveSessionRun(
        sessionDir,
        baseSessionRun({
          id: "run-remote",
          sessionId: "snapshot-remote",
          source: "responses_background",
          status: "running",
          startedAt: now,
          updatedAt: now,
        }),
      );

      let snapshot = inspectSessionExecution(sessionDir, "snapshot-remote");
      assertEquals(snapshot.state, SessionExecutionOrphaned);

      const remote: ResponseRun = {
        id: 0,
        sessionId: "snapshot-remote",
        localRunId: "provider-run",
        localTurnId: "run-remote",
        messageId: null,
        responseId: "resp-1",
        provider: "openai",
        api: "openai-responses",
        state: "in_progress",
        pollingUrl: "",
        lastEventSequence: null,
        cancelRequested: false,
        createdAt: now,
        updatedAt: now,
      };
      saveResponseRun(sessionDir, remote);

      snapshot = inspectSessionExecution(sessionDir, "snapshot-remote");
      assertEquals(snapshot.state, SessionExecutionDetached);
      assert(snapshot.running, "detached remote run should be running");
      assert(snapshot.canCancelRemote, "detached remote run must allow cancel");
      assert(!snapshot.canSubmit, "detached remote run must not allow submit");
      assertEquals(snapshot.remoteRunId, "provider-run");
    } finally {
      closeDatabases();
    }
  },
);

Deno.test("reattachDurableRunPromotesRecoveryLeaseAndRegistersLocal", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "mothx-snapshot-" });
  try {
    initSession(sessionDir, "snapshot-reattach");
    const now = new Date();
    saveSessionRun(
      sessionDir,
      baseSessionRun({
        id: "run-reattach",
        sessionId: "snapshot-reattach",
        status: "running",
        startedAt: now,
        updatedAt: now,
      }),
    );
    const lease = acquireRecovery(
      sessionDir,
      "snapshot-reattach",
      "run-reattach",
    );
    try {
      const execution = new ExecutionRuntime();
      execution.setRunStore(new RunStore(sessionDir));
      execution.reattachDurableRun(
        undefined,
        makeRun({
          id: "run-reattach",
          sessionId: "snapshot-reattach",
          status: RunStateRunning,
          startedAt: now,
        }),
        RunStateRunning,
        runEvent("snapshot-reattach", "run-reattach", "started"),
      );
      const binding = lease.binding();
      assertEquals(binding.purpose, "execution");
      assertEquals(binding.runId, "run-reattach");

      const snapshot = inspectSessionExecution(sessionDir, "snapshot-reattach");
      assertEquals(snapshot.state, SessionExecutionLocal);
      assert(snapshot.canCancelLocal, "reattached run must allow local cancel");

      execution.finishDurable(
        "run-reattach",
        RunStateFailed,
        "test cleanup",
        runEvent("snapshot-reattach", "run-reattach", "failed"),
      );
    } finally {
      lease.release();
    }
  } finally {
    closeDatabases();
  }
});
