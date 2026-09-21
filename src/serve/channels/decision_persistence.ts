// Ported from internal/serve/channels/decision_persistence.go plus the
// decision-service helpers and the unattended approval handler that live in
// channels/dispatcher.go. Go's Dispatcher methods map to functions that take
// the Dispatcher first (a TS class cannot be spread across the Go package's
// files).
//
// Deviations: Go's log.Printf maps to console.error; the
// `expiresAt time.Time` zero value maps to an undefined deadline.

import {
  DecisionApproval,
  type DecisionKind,
  type DecisionResolution,
  DecisionService,
  type DecisionService as DecisionServiceView,
} from "../../agentruntime/decision.ts";
import { DecisionStatusPending } from "../../agentruntime/decision_events.ts";
import {
  type DecisionTransition,
  recordDecisionEvent,
} from "../../agentruntime/decision_events.ts";
import { SessionRunEventSink } from "../../agentruntime/run_event.ts";
import type { ChannelSession, Dispatcher } from "./dispatcher.ts";
import { channelRunSource } from "./dispatcher.ts";
import { commandRiskLevel, formatApprovalNotification } from "./security.ts";
/**
 * persistChannelDecision appends one decision transition to the channel
 * session's durable run-event ledger. Guarded no-op for sessions without a
 * resolved run identity.
 */
export function persistChannelDecision(
  d: Dispatcher | null,
  sess: ChannelSession | null,
  id: string,
  kind: DecisionKind,
  status: string,
  value: string,
  payload: Record<string, unknown> | null,
): Error | null {
  if (
    d === null || d === undefined || sess === null || sess === undefined ||
    id === "" || sess.id === "" || sess.runID === ""
  ) {
    return null;
  }
  const transition: DecisionTransition = {
    request: { id, sessionId: sess.id, runId: sess.runID, kind },
    status,
    value,
    payload: payload ?? undefined,
    source: channelRunSource(sess),
    mode: sess.mode,
  };
  try {
    recordDecisionEvent(
      new SessionRunEventSink(d.sessionDir),
      transition,
    );
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** persistChannelDecisionRequest records a pending decision without deadline. */
export function persistChannelDecisionRequest(
  d: Dispatcher | null,
  sess: ChannelSession | null,
  id: string,
  kind: DecisionKind,
  payload: Record<string, unknown> | null,
): void {
  persistChannelDecisionRequestWithDeadline(
    d,
    sess,
    id,
    kind,
    payload,
    undefined,
  );
}

/** persistChannelDecisionRequestWithDeadline records a pending decision with
 * an optional expiry. Failures are logged, never propagated: an unpersisted
 * request degrades to the in-memory-only decision. */
export function persistChannelDecisionRequestWithDeadline(
  d: Dispatcher | null,
  sess: ChannelSession | null,
  id: string,
  kind: DecisionKind,
  payload: Record<string, unknown> | null,
  expiresAt?: Date,
): void {
  if (
    d === null || d === undefined || sess === null || sess === undefined ||
    id === "" || sess.id === "" || sess.runID === ""
  ) {
    return;
  }
  try {
    recordDecisionEvent(new SessionRunEventSink(d.sessionDir), {
      request: { id, sessionId: sess.id, runId: sess.runID, kind },
      status: DecisionStatusPending,
      payload: payload ?? undefined,
      expiresAt,
      source: channelRunSource(sess),
      mode: sess.mode,
    });
  } catch (err) {
    console.error(`[channels] save decision request ${id}: ${err}`);
  }
}

/** channelDecisionService lazily attaches the session's DecisionService and
 * mirrors it onto the Runtime alias. */
export function channelDecisionService(
  _d: Dispatcher,
  sess: ChannelSession | null,
): DecisionServiceView | null {
  if (sess === null || sess === undefined) return null;
  if (sess.decisions === null || sess.decisions === undefined) {
    sess.decisions = new DecisionService();
    sess.runtime?.setDecisions(sess.decisions);
  }
  return sess.decisions;
}

/** registerChannelDecision adds one pending approval/question to the session. */
export function registerChannelDecision(
  d: Dispatcher,
  sess: ChannelSession | null,
  id: string,
  kind: DecisionKind,
): void {
  if (sess === null || sess === undefined || id === "") return;
  const service = channelDecisionService(d, sess);
  if (service === null) return;
  try {
    service.register({
      id,
      runId: sess.runID,
      sessionId: sess.id,
      kind,
    });
  } catch {
    // Go ignores the Register error as well (duplicate registration).
  }
}

/** clearChannelDecisions cancels every decision still pending for the run and
 * persists the cancellation so replay never revives them. */
export function clearChannelDecisions(
  d: Dispatcher,
  sess: ChannelSession | null,
): void {
  if (sess === null || sess === undefined || sess.decisions === null) return;
  for (const request of sess.decisions.clearRunWithValue(sess.runID, "")) {
    persistChannelDecision(d, sess, request.id, request.kind, "cancelled", "", {
      reason: "channel run ended before the decision was resolved",
    });
  }
}

/**
 * messagingApprovalHandler returns an ApprovalHandler for messaging platforms.
 * Medium risk → auto-approve + notify; high risk → auto-reject + notify.
 */
export function messagingApprovalHandler(
  d: Dispatcher,
  sess: ChannelSession,
  progress: ((text: string) => void) | null,
): (
  toolCallID: string,
  toolName: string,
  args: Record<string, unknown>,
) => boolean {
  const runtime = d.runtimeSnapshot();
  return (toolCallID, toolName, args) => {
    registerChannelDecision(d, sess, toolCallID, DecisionApproval);
    try {
      if (sess.decisions !== null) {
        const resolution: DecisionResolution = {
          id: toolCallID,
          kind: DecisionApproval,
          status: "resolved",
        };
        sess.decisions.resolveWith(resolution, () => {
          const err = persistChannelDecision(
            d,
            sess,
            toolCallID,
            DecisionApproval,
            "resolved",
            "",
            null,
          );
          if (err !== null) {
            console.error(`[channels] resolve decision ${toolCallID}: ${err}`);
          }
        });
      }
    } catch (err) {
      console.error(`[channels] resolve decision ${toolCallID}: ${err}`);
    }
    if (toolName === "git_access") {
      progress?.(
        "⛔ Git metadata access is not available in unattended channel sessions",
      );
      return false;
    }
    if (
      runtime.security !== null && runtime.security !== undefined &&
      runtime.security.shouldAutoApprove(toolName, args, sess.mode)
    ) {
      return true;
    }

    let risk: "low" | "medium" | "high" = "medium";
    if (toolName === "bash") {
      const command = args["command"];
      risk = commandRiskLevel(
        typeof command === "string"
          ? command
          : command === undefined || command === null
          ? ""
          : String(command),
      );
    }

    if (risk === "medium") {
      progress?.(formatApprovalNotification(toolName, args, risk, true));
      return true;
    }

    progress?.(formatApprovalNotification(toolName, args, risk, false));
    return false;
  };
}
