//
// The Go tests drive a real session database and build raw
// `session_runtime_leases` fixtures to exercise the external/legacy/mismatched
// and verified-remote snapshot states. Raw SQL lease fixtures are allowed in
// tests (the DAO/DB rule governs production code). `time.Time` maps to `Date`.

import { assert, assertEquals } from "../compat/assert.ts";
import { createManager } from "../session/manager.ts";
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
  RUN_STATE_COMPLETED,
  RUN_STATE_FAILED,
  RUN_STATE_RUNNING,
  type RunEvent,
  RunStore,
  SESSION_EXECUTION_DETACHED,
  SESSION_EXECUTION_EXTERNAL,
  SESSION_EXECUTION_IDLE,
  SESSION_EXECUTION_INCONSISTENT,
  SESSION_EXECUTION_LOCAL,
  SESSION_EXECUTION_ORPHANED,
  SESSION_EXECUTION_RESERVED,
} from "./mod.ts";
import { test } from "#testing";

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
  const manager = createManager(Deno.makeTempDirSync(), sessionDir);
  manager.initWithID(id);
}

test("inspectSessionExecutionTracksLocalLifecycle", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-snapshot-" });
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
          status: RUN_STATE_RUNNING,
          startedAt: now,
        }),
        runEvent("snapshot-local", "run-local", "started"),
      );

      let snapshot = inspectSessionExecution(sessionDir, "snapshot-local");
      assertEquals(snapshot.state, SESSION_EXECUTION_LOCAL);
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
        RUN_STATE_COMPLETED,
        "",
        runEvent("snapshot-local", "run-local", "finished"),
      );
      snapshot = inspectSessionExecution(sessionDir, "snapshot-local");
      assertEquals(snapshot.state, SESSION_EXECUTION_RESERVED);
      assertEquals(snapshot.phase, "releasing");
      assert(!snapshot.canSubmit, "releasing lease must not allow submit");

      lease.release();
      snapshot = inspectSessionExecution(sessionDir, "snapshot-local");
      assertEquals(snapshot.state, SESSION_EXECUTION_IDLE);
      assert(!snapshot.busy, "idle session must not be busy");
      assert(snapshot.canSubmit, "idle session must allow submit");
    } finally {
      lease.release();
    }
  } finally {
    closeDatabases();
  }
});

test("inspectSessionExecutionDistinguishesExternalLegacyAndOrphaned", () => {
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
      wantState: SESSION_EXECUTION_EXTERNAL,
      wantLinkage: "bound",
      wantRunning: true,
    },
    {
      name: "legacy unbound",
      leasePurpose: "run",
      leaseRunId: "",
      wantState: SESSION_EXECUTION_EXTERNAL,
      wantLinkage: "legacy_unbound",
      wantRunning: true,
    },
    {
      name: "mismatched",
      leasePurpose: "execution",
      leaseRunId: "other-run",
      wantState: SESSION_EXECUTION_INCONSISTENT,
      wantLinkage: "mismatched",
      wantRunning: false,
    },
    {
      name: "orphaned",
      leasePurpose: "",
      leaseRunId: "",
      wantState: SESSION_EXECUTION_ORPHANED,
      wantLinkage: "none",
      wantRunning: false,
    },
  ];
  for (const testCase of cases) {
    const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-snapshot-" });
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

test("inspectSessionExecutionProjectsMutationAsReserved", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-snapshot-" });
  try {
    initSession(sessionDir, "snapshot-reserved");
    const lease = acquireMutation(sessionDir, "snapshot-reserved");
    try {
      const snapshot = inspectSessionExecution(sessionDir, "snapshot-reserved");
      assertEquals(snapshot.state, SESSION_EXECUTION_RESERVED);
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

test(
  "inspectSessionExecutionRequiresCanonicalRemoteRecordForDetachedState",
  () => {
    const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-snapshot-" });
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
      assertEquals(snapshot.state, SESSION_EXECUTION_ORPHANED);

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
      assertEquals(snapshot.state, SESSION_EXECUTION_DETACHED);
      assert(snapshot.running, "detached remote run should be running");
      assert(snapshot.canCancelRemote, "detached remote run must allow cancel");
      assert(!snapshot.canSubmit, "detached remote run must not allow submit");
      assertEquals(snapshot.remoteRunId, "provider-run");
    } finally {
      closeDatabases();
    }
  },
);

test("reattachDurableRunPromotesRecoveryLeaseAndRegistersLocal", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-snapshot-" });
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
          status: RUN_STATE_RUNNING,
          startedAt: now,
        }),
        RUN_STATE_RUNNING,
        runEvent("snapshot-reattach", "run-reattach", "started"),
      );
      const binding = lease.binding();
      assertEquals(binding.purpose, "execution");
      assertEquals(binding.runId, "run-reattach");

      const snapshot = inspectSessionExecution(sessionDir, "snapshot-reattach");
      assertEquals(snapshot.state, SESSION_EXECUTION_LOCAL);
      assert(snapshot.canCancelLocal, "reattached run must allow local cancel");

      execution.finishDurable(
        "run-reattach",
        RUN_STATE_FAILED,
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
