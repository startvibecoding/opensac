import type { ExecutionRuntime } from "./execution.ts";
import {
  DECISION_APPROVAL,
  DECISION_QUESTION,
  type DecisionKind,
  type DecisionRequest,
  type DecisionResolution,
  DecisionService,
} from "./decision.ts";
import { recordDecisionEvent } from "./decision_events.ts";
import { type RunState } from "./run_state.ts";

export const decisionSourceRuntime = "runtime";

export function decisionTerminalStatus(state: RunState): string {
  switch (state) {
    case "cancelled":
    case "cancelling":
      return "cancelled";
    default:
      return "timed_out";
  }
}

export interface RuntimeRunOptions {
  execution?: ExecutionRuntime;
  decisions?: DecisionService;
  runId: string;
  sessionId?: string;
  sessionDir?: string;
  mode?: string;
  model?: string;
  source?: string;
}

/** Front-end-neutral decision/cancellation handle for one Core-owned Run. */
export class RuntimeRun {
  readonly execution?: ExecutionRuntime;
  readonly decisions?: DecisionService;
  readonly runId: string;
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly mode: string;
  readonly model: string;
  readonly source: string;

  constructor(options: RuntimeRunOptions) {
    this.execution = options.execution;
    this.decisions = options.decisions;
    this.runId = options.runId;
    this.sessionId = options.sessionId ?? "";
    this.sessionDir = options.sessionDir ?? "";
    this.mode = options.mode ?? "";
    this.model = options.model ?? "";
    this.source = options.source ?? decisionSourceRuntime;
  }

  registerDecision(id: string, kind: DecisionKind): string | undefined {
    if (this.decisions === undefined) return undefined;
    try {
      this.decisions.register({
        id,
        runId: this.runId,
        sessionId: this.sessionId,
        kind,
      });
    } catch (error) {
      return (error as Error).message;
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
    recordDecisionEvent(
      {
        record: (event) => this.execution!.recordEvent(event),
      },
      {
        request: { id, runId: this.runId, sessionId: this.sessionId, kind },
        status,
        value,
        payload,
        source: this.source,
        mode: this.mode,
      },
    );
  }

  resolveDecision(id: string, kind: DecisionKind, value: string): void {
    this.decisions?.resolveWith(
      {
        id,
        kind,
        status: "resolved",
        value,
      },
      () => {
        this.persistDecision(id, kind, "resolved", value, { value });
      },
    );
  }

  clearDecisions(state: RunState): void {
    if (this.decisions === undefined) return;
    const status = decisionTerminalStatus(state);
    for (const request of this.decisions.clearRunWithValue(this.runId, "")) {
      this.persistDecision(request.id, request.kind, status, "", {
        reason: "Runtime run ended before the decision was resolved",
      });
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

export { DECISION_APPROVAL, DECISION_QUESTION };
export type { DecisionKind, DecisionRequest, DecisionResolution };
