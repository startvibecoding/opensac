// Ported from internal/serve/openaiapi/decision_projection.go. Go defines the
// helper as a *Server method but never uses the receiver; the Server
// parameter is dropped in the Deno projection.
import type { APISession } from "./session_mgr.ts";
import type { DecisionKind } from "../../agentruntime/decision.ts";

/**
 * pendingDecisionIDsForRun returns the Runtime-owned pending decision
 * identity for one run. Payload maps remain the compatibility source for
 * protocol data; this helper makes the Runtime decision set authoritative
 * for identity.
 */
export function pendingDecisionIDsForRun(
  sess: APISession | undefined,
  runId: string,
): Map<string, DecisionKind> {
  const result = new Map<string, DecisionKind>();
  if (sess === null || sess === undefined || runId === "") {
    return result;
  }
  if (sess.decisions) {
    for (const request of sess.decisions.pending()) {
      if (request.runId === runId) {
        result.set(request.id, request.kind);
      }
    }
  }
  return result;
}
