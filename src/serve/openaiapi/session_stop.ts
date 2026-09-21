// Ported from internal/serve/openaiapi/session_mgr.go — the Server-bound stop
// halves: RequestSessionStop, requestSessionStop (with the optional target Run
// identity used by Run API cancellation), and CancelSessionRun.
//
// RequestSessionStop is the Serve projection of the Runtime-owned stop
// operation. It supplies provider and Decision hooks but does not decide Run
// ownership from APISession or RunManager memory.
//
// Deviations: Go's `(result, error)` return maps to `{ result, err }`; Go's
// `s.responsesRuns` driver becomes the `BackgroundRunDriver` hook on Server
// (installed by applySettings for openai-responses providers); its
// cancel argument order follows the ported provider surface (identifiers
// first, AbortSignal last); Go's `_ =` error swallowing is kept for the
// projection calls.
import {
  type RemoteStopRequest,
  RemoteStopUnsupportedError,
  requestSessionStop as runtimeRequestSessionStop,
  SessionStopAccepted,
  SessionStopNoActiveRun,
  SessionStopRecoveryStarted,
  SessionStopRemoteAccepted,
  type SessionStopResult,
  StopStateUnavailableError,
} from "../../agentruntime/execution_stop.ts";
import { SessionExecutionUnknown } from "../../agentruntime/execution.ts";
import { RunStateCancelling } from "../../agentruntime/run_state.ts";
import { getSessionDir } from "../../config/settings.ts";
import type { Server } from "./server.ts";
import { ErrSessionNotFound } from "./session_mgr.ts";
import { clearSessionApprovalsForRun } from "./approval.ts";
import {
  publishSessionRuntimeById,
  publishSessionRuntimeForSession,
} from "./session_runtime_snapshot.ts";

/**
 * requestSessionStop is the Serve projection of Runtime stop with an optional
 * target Run identity. The target is used by Run API cancellation to prevent a
 * stale request from cancelling a newer Run in the same Session.
 */
export async function requestSessionStop(
  server: Server,
  id: string,
  expectedRunId = "",
): Promise<{ result: SessionStopResult; err: Error | null }> {
  if (!server.settings || id === "") {
    return { result: emptyStopResult(), err: ErrSessionNotFound };
  }
  let result: SessionStopResult;
  try {
    result = await runtimeRequestSessionStop(
      undefined,
      getSessionDir(server.settings),
      id,
      {
        expectedRunId,
        remoteCancel: async (
          _ctx: AbortSignal | undefined,
          request: RemoteStopRequest,
        ) => {
          const driver = server.responsesRuns;
          const currentProvider = server.provider;
          if (
            !driver ||
            !currentProvider ||
            currentProvider.name().toLowerCase() !==
              request.provider.toLowerCase()
          ) {
            throw new RemoteStopUnsupportedError();
          }
          await driver.cancel(request.sessionId, request.remoteRunId, _ctx);
        },
      },
    );
  } catch (err) {
    if (err instanceof StopStateUnavailableError) {
      // Go returns the partial result alongside the error.
      return { result: err.result, err: toError(err.cause ?? err) };
    }
    return { result: emptyStopResult(), err: toError(err) };
  }

  if (
    result.code === SessionStopAccepted &&
    result.execution.activeRun &&
    server.pool
  ) {
    const sess = server.pool.getExact(id);
    if (sess) {
      const runId = result.execution.activeRun.id;
      if (sess.activeRunId === runId) {
        sess.activeRunStatus = RunStateCancelling;
      }
      clearSessionApprovalsForRun(
        server,
        sess,
        runId,
        "cancelled",
        "run cancelled by user",
      );
      publishSessionRuntimeForSession(server, sess);
    }
  } else if (result.execution.sessionExists) {
    publishSessionRuntimeById(server, id);
  }
  return { result, err: null };
}

/**
 * cancelSessionRun remains as a compatibility wrapper for in-process callers.
 * New protocol handlers should inspect the structured requestSessionStop
 * result.
 */
export async function cancelSessionRun(
  server: Server,
  id: string,
): Promise<Error | null> {
  const { result, err } = await requestSessionStop(server, id);
  if (err) return err;
  switch (result.code) {
    case SessionStopAccepted:
    case SessionStopRemoteAccepted:
    case SessionStopRecoveryStarted:
      return null;
    case SessionStopNoActiveRun:
      return ErrSessionNotFound;
    default:
      return new Error(`session stop rejected: ${result.code}`);
  }
}

function emptyStopResult(): SessionStopResult {
  return {
    code: "",
    execution: {
      sessionId: "",
      sessionExists: false,
      state: SessionExecutionUnknown,
      phase: "",
      running: false,
      busy: true,
      canSubmit: false,
      canCancelLocal: false,
      canCancelRemote: false,
      leasePurpose: "",
      leaseEpoch: 0,
      leaseOwnerInstanceId: "",
      leaseOwnerPid: 0,
      leaseTokenIdentity: "",
      linkageState: "none",
      recoveryAction: "none",
      recoveryAttempt: 0,
      recoveryLastError: "",
      displayOwnerScope: "unknown",
      remoteRunId: "",
      remoteProvider: "",
      remoteState: "",
    },
  };
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
