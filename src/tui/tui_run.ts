// Ported from internal/tui/run.go: the TuiRun adapter bridging the TUI to the
// shared execution lifecycle. It owns decision registration/persistence via
// the DecisionService + ExecutionRuntime event sink, terminal decision
// status mapping, and implements the AppController RunHandle contract.
// The durable begin path (ExecutionIntent/BeginIntentDurable) is wired in the
// CLI root assembly where the SessionRuntime builds the agent.

import type { ExecutionRuntime } from "../agentruntime/execution.ts";
import {
  DecisionApproval,
  type DecisionKind,
  DecisionQuestion,
  type DecisionRequest,
  type DecisionResolution,
  DecisionService,
} from "../agentruntime/decision.ts";
import { recordDecisionEvent } from "../agentruntime/decision_events.ts";
import type { RunState } from "../agentruntime/run_state.ts";
import type { RunHandle } from "./app_controller.ts";

export const decisionSourceTUI = "tui";

/** Maps a terminal RunState to the decision status recorded for decisions
 * still pending when the run ended (Go decisionTerminalStatus): only an
 * explicit cancellation cancels them; every other terminal outcome means they
 * lapsed with the run. */
export function decisionTerminalStatus(state: RunState): string {
  switch (state) {
    case "cancelled":
    case "cancelling":
      return "cancelled";
    default:
      return "timed_out";
  }
}

export interface TuiRunOptions {
  execution?: ExecutionRuntime;
  decisions?: DecisionService;
  runId: string;
  sessionId?: string;
  sessionDir?: string;
  mode?: string;
  model?: string;
}

export class TuiRun implements RunHandle {
  readonly execution?: ExecutionRuntime;
  readonly decisions?: DecisionService;
  readonly runId: string;
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly mode: string;
  readonly model: string;

  constructor(options: TuiRunOptions) {
    this.execution = options.execution;
    this.decisions = options.decisions;
    this.runId = options.runId;
    this.sessionId = options.sessionId ?? "";
    this.sessionDir = options.sessionDir ?? "";
    this.mode = options.mode ?? "";
    this.model = options.model ?? "";
  }

  /** Registers a pending decision; returns an error message on duplicates. */
  registerDecision(id: string, kind: DecisionKind): string | undefined {
    if (!this.decisions) return undefined;
    try {
      this.decisions.register({
        id,
        runId: this.runId,
        sessionId: this.sessionId,
        kind,
      });
    } catch (err) {
      return (err as Error).message;
    }
    this.persistDecision(id, kind, "pending", "", undefined);
    return undefined;
  }

  bindDecision(id: string, resolve: (value: string) => void): void {
    this.decisions?.bind(id, resolve);
  }

  persistDecision(
    id: string,
    kind: DecisionKind,
    status: string,
    value: string,
    payload?: unknown,
  ): void {
    if (!this.sessionDir || !this.sessionId || !this.runId) return;
    if (this.execution === undefined) return;
    recordDecisionEvent({ record: (ev) => this.execution!.recordEvent(ev) }, {
      request: {
        id,
        runId: this.runId,
        sessionId: this.sessionId,
        kind,
      },
      status,
      value,
      payload,
      source: decisionSourceTUI,
      mode: this.mode,
    });
  }

  resolveDecision(id: string, kind: DecisionKind, value: string): void {
    if (!this.decisions) return;
    const resolution: DecisionResolution = {
      id,
      kind,
      status: "resolved",
      value,
    };
    this.decisions.resolveWith(resolution, () => {
      this.persistDecision(id, kind, "resolved", value, { value });
    });
  }

  /** Terminalizes still-pending decisions with the run's terminal state. */
  clearDecisions(state: RunState): void {
    if (!this.decisions) return;
    const status = decisionTerminalStatus(state);
    for (const request of this.decisions.clearRunWithValue(this.runId, "")) {
      this.persistDecision(
        request.id,
        request.kind,
        status,
        "",
        { reason: "TUI run ended before the decision was resolved" },
      );
    }
  }

  finish(state: RunState): void {
    this.clearDecisions(state);
    this.execution?.finishWithState(this.runId, state);
  }

  waitForApproval(): void {
    this.execution?.waitForApproval(this.runId);
  }

  waitForQuestion(): void {
    this.execution?.waitForQuestion(this.runId);
  }

  resume(): void {
    this.execution?.resume(this.runId);
  }

  cancel(): boolean {
    return this.execution?.cancel() ?? false;
  }
}

/** Re-exported for the controller contract typing. */
export type { DecisionKind, DecisionRequest };
export { DecisionApproval, DecisionQuestion };
