// renders the Supervisor Mode progress
// panel. The Go original reads App state; this projection parameterizes the
// objective snapshot and the active agent's activity so every function stays
// pure and testable. The ESM runtime itself is src/esm (already migrated).

import {
  type Objective,
  type Phase,
  phaseAudit,
  phaseComplete,
  phaseCritic,
  phaseWorker,
  type Status,
  statusBlocked,
  statusComplete,
  statusCompleteCandidate,
  statusPaused,
  statusUsageLimited,
} from "../esm/state.ts";
import { type AgentActivity } from "./activity.ts";
import { formatDuration } from "./formatters.ts";
import { Translator } from "./i18n.ts";
import { wrapPlainText } from "./renderutil.ts";
import { type TUIEsmObjectiveView } from "./service.ts";

/** Maps the JSON-safe Core ESM objective view onto the panel's Objective. */
export function esmObjectiveFromView(view: TUIEsmObjectiveView): Objective {
  return {
    ...view,
    remainingWork: [...view.remainingWork],
    createdAt: new Date(view.createdAt),
    updatedAt: new Date(view.updatedAt),
  };
}

export interface ESMPanelActivityContext {
  activeAgentId: string;
  activity?: AgentActivity;
}

/** Panel width for a terminal width (Go esmPanelWidth). */
export function esmPanelWidth(terminalWidth: number): number {
  if (terminalWidth <= 0) terminalWidth = 80;
  const width = terminalWidth - 4;
  return width < 1 ? 1 : width;
}

/** Content width after the modal's horizontal padding (4 columns). */
export function esmPanelContentWidth(width: number): number {
  const w = width - 4;
  return w < 1 ? 1 : w;
}

/** The "now" line: phase activity plus the live sub-agent detail. */
export function esmPanelNow(
  obj: Objective,
  tr: Translator,
  ctx?: ESMPanelActivityContext,
): string {
  const phase = effectiveESMPhase(obj);
  const base = esmPhaseActivityLabel(phase, obj.status, tr);
  if (!ctx || ctx.activeAgentId === "") return base;
  const act = ctx.activity;
  if (!act) return `${base}; ${tr.text("esm.panel.subagent_starting")}`;
  if (act.lastTool) {
    return `${base}; ${tr.text("esm.panel.latest_tool", act.lastTool)}`;
  }
  if (act.lastResult) {
    return `${base}; ${tr.text("esm.panel.latest_result", act.lastResult)}`;
  }
  if (act.lastText) {
    return `${base}; ${tr.text("esm.panel.latest_response", act.lastText)}`;
  }
  if (act.lastThink) return `${base}; reasoning in progress`;
  return `${base}; sub-agent is running`;
}

export function esmCompletedStages(phase: Phase): number {
  switch (phase) {
    case phaseCritic:
      return 1;
    case phaseAudit:
      return 2;
    case phaseComplete:
      return 3;
    default:
      return 0;
  }
}

export function esmPanelProgress(
  obj: Objective,
  phase: Phase,
  tr: Translator,
): string {
  let progress = tr.text("esm.panel.progress", esmCompletedStages(phase));
  const remaining = obj.remainingWork.length;
  if (remaining > 0) {
    progress += tr.text("esm.panel.work_remaining", remaining);
  }
  return progress;
}

export function esmPhaseActivityLabel(
  phase: Phase,
  status: Status,
  tr: Translator,
): string {
  switch (status) {
    case statusPaused:
      return tr.text("esm.panel.activity.paused");
    case statusBlocked:
      return tr.text("esm.panel.activity.blocked");
    case statusUsageLimited:
      return tr.text("esm.panel.activity.usage_limited");
    case statusComplete:
      return tr.text("esm.panel.activity.audit_passed");
  }
  switch (phase) {
    case phaseCritic:
      return tr.text("esm.panel.activity.critic_reviewing");
    case phaseAudit:
      return tr.text("esm.panel.activity.auditing");
    default:
      return tr.text("esm.panel.activity.worker_investigating");
  }
}

export function esmPanelNextStep(
  obj: Objective,
  phase: Phase,
  tr: Translator,
): string {
  switch (obj.status) {
    case statusPaused:
      return tr.text("esm.panel.next.paused");
    case statusBlocked:
      return tr.text("esm.panel.next.blocked");
    case statusUsageLimited:
      return tr.text("esm.panel.next.usage_limited");
    case statusComplete:
      return tr.text("esm.panel.next.complete");
  }
  switch (phase) {
    case phaseCritic:
      return tr.text("esm.panel.next.critic");
    case phaseAudit:
      return tr.text("esm.panel.next.audit");
    default:
      return tr.text("esm.panel.next.worker");
  }
}

/** Formats the last-saved timestamp with a relative suffix. */
export function formatESMPanelUpdateTime(
  updatedAt: Date,
  now: Date = new Date(),
): string {
  let ago = now.getTime() - updatedAt.getTime();
  if (ago < 0) ago = 0;
  const pad = (n: number) => String(n).padStart(2, "0");
  const local = `${updatedAt.getFullYear()}-${pad(updatedAt.getMonth() + 1)}-${pad(
    updatedAt.getDate(),
  )} ${pad(updatedAt.getHours())}:${pad(updatedAt.getMinutes())}:${pad(
    updatedAt.getSeconds(),
  )}`;
  return `${local} (${formatDuration(ago)} ago)`;
}

export function effectiveESMPhase(obj: Objective): Phase {
  if (obj.phase !== "") return obj.phase;
  switch (obj.status) {
    case statusComplete:
      return phaseComplete;
    case statusCompleteCandidate:
      return phaseCritic;
    default:
      return phaseWorker;
  }
}

export function esmPhaseLabel(phase: Phase, tr: Translator): string {
  switch (phase) {
    case phaseCritic:
      return tr.text("esm.panel.phase.critic_review");
    case phaseAudit:
      return tr.text("esm.panel.phase.final_audit");
    case phaseComplete:
      return tr.text("esm.panel.phase.complete");
    default:
      return tr.text("esm.panel.phase.worker_execution");
  }
}

/** The `[x] worker -> [>] critic -> [ ] audit` pipeline row. */
export function renderESMPipeline(
  phase: Phase,
  status: Status,
  tr: Translator,
): string {
  const stages: Array<{ phase: Phase; label: string }> = [
    { phase: phaseWorker, label: tr.text("esm.panel.phase.worker_execution") },
    { phase: phaseCritic, label: tr.text("esm.panel.phase.critic_review") },
    { phase: phaseAudit, label: tr.text("esm.panel.phase.final_audit") },
  ];
  const current = esmPhaseIndex(phase);
  const parts: string[] = [];
  for (let i = 0; i < stages.length; i++) {
    let marker = " ";
    if (phase === phaseComplete || i < current) marker = "x";
    else if (i === current && status === statusPaused) marker = "!";
    else if (i === current) marker = ">";
    parts.push(`[${marker}] ${stages[i].label}`);
  }
  return parts.join(" -> ");
}

export function esmPhaseIndex(phase: Phase): number {
  switch (phase) {
    case phaseCritic:
      return 1;
    case phaseAudit:
      return 2;
    case phaseComplete:
      return 3;
    default:
      return 0;
  }
}

/** Live activity lines for the active sub-agent. */
export function activeESMPanelActivity(
  ctx: ESMPanelActivityContext,
  width: number,
  tr: Translator,
): string[] {
  if (ctx.activeAgentId === "") return [];
  const act = ctx.activity;
  if (!act) {
    return [tr.text("esm.panel.activity_starting", ctx.activeAgentId)];
  }
  const lines: string[] = [
    tr.text("esm.panel.activity_state", ctx.activeAgentId, act.state),
  ];
  if (act.lastTool) lines.push(tr.text("esm.panel.tool", act.lastTool));
  if (act.lastResult) lines.push(tr.text("esm.panel.latest", act.lastResult));
  else if (act.lastText) lines.push(tr.text("esm.panel.latest", act.lastText));
  else if (act.lastThink) {
    lines.push(tr.text("esm.panel.thinking", act.lastThink));
  }
  return wrapESMPanelLines(lines, width);
}

/** Builds the full panel body lines (Go esmPanelLines). */
export function esmPanelLines(
  obj: Objective | null | undefined,
  width: number,
  tr: Translator,
  ctx?: ESMPanelActivityContext,
  options: { loadError?: string } = {},
): string[] {
  if (options.loadError !== undefined) {
    return [tr.text("esm.panel.load_failed", options.loadError)];
  }
  if (obj === null || obj === undefined || !obj.esmId) {
    return [
      tr.text("esm.panel.no_objective"),
      "",
      tr.text("esm.panel.create_hint"),
    ];
  }

  const phase = effectiveESMPhase(obj);
  const lines: string[] = [
    tr.text("esm.panel.title"),
    "",
    tr.text("esm.panel.now", esmPanelNow(obj, tr, ctx)),
    esmPanelProgress(obj, phase, tr),
    tr.text("esm.panel.next", esmPanelNextStep(obj, phase, tr)),
    "",
    tr.text("esm.panel.status", obj.status),
    tr.text("esm.panel.stage", esmPhaseLabel(phase, tr)),
    tr.text("esm.panel.pipeline", renderESMPipeline(phase, obj.status, tr)),
  ];
  appendWrappedESMField(
    lines,
    tr.text("esm.panel.objective"),
    obj.objective,
    width,
  );

  if (obj.progressSummary !== "") {
    lines.push("");
    appendWrappedESMField(
      lines,
      tr.text("esm.panel.latest_worker_progress"),
      obj.progressSummary,
      width,
    );
  }
  if (obj.remainingWork.length > 0) {
    lines.push(
      "",
      tr.text("esm.panel.remaining_work", obj.remainingWork.length),
    );
    appendESMItems(lines, obj.remainingWork, width);
  }
  if (obj.blockedReason !== "") {
    lines.push("");
    appendWrappedESMField(
      lines,
      tr.text("esm.panel.blocker"),
      obj.blockedReason,
      width,
    );
    lines.push(tr.text("esm.panel.repeated_blocker_audit", obj.blockedCount));
  }
  if (obj.completionReview !== "") {
    lines.push("");
    appendWrappedESMField(
      lines,
      tr.text("esm.panel.latest_completion_review"),
      obj.completionReview,
      width,
    );
  }
  if (obj.rejectionCount > 0) {
    lines.push(tr.text("esm.panel.completion_rejections", obj.rejectionCount));
  }
  if (obj.recoveryCount > 0) {
    lines.push(
      "",
      tr.text("esm.panel.automatic_recoveries", obj.recoveryCount),
    );
    if (obj.recoveryReason !== "") {
      appendWrappedESMField(
        lines,
        tr.text("esm.panel.latest_recovery_reason"),
        obj.recoveryReason,
        width,
      );
    }
  }
  if (obj.completionReason !== "" && obj.status === statusCompleteCandidate) {
    lines.push("");
    appendWrappedESMField(
      lines,
      tr.text("esm.panel.completion_candidate"),
      obj.completionReason,
      width,
    );
  }

  const activity = activeESMPanelActivity(
    ctx ?? { activeAgentId: "" },
    width,
    tr,
  );
  if (activity.length > 0) {
    lines.push("", tr.text("esm.panel.live_details"));
    lines.push(...activity);
  }

  lines.push("", tr.text("esm.panel.tokens", obj.tokensUsed));
  if (obj.timeUsedMs > 0) {
    lines.push(
      tr.text("esm.panel.time", formatDurationMSForPanel(obj.timeUsedMs)),
    );
  }
  if (obj.updatedAt.getTime() > 0) {
    lines.push(
      tr.text("esm.panel.last_saved", formatESMPanelUpdateTime(obj.updatedAt)),
    );
  }
  return wrapESMPanelLines(lines, width);
}

function appendWrappedESMField(
  lines: string[],
  label: string,
  value: string,
  width: number,
): void {
  lines.push(...wrapPlainText(`${label}: ${value.trim()}`, width).split("\n"));
}

function appendESMItems(lines: string[], items: string[], width: number): void {
  items.forEach((item, i) => {
    lines.push(...wrapPlainText(`  ${i + 1}. ${item}`, width).split("\n"));
  });
}

function wrapESMPanelLines(lines: string[], width: number): string[] {
  const wrapped: string[] = [];
  for (const line of lines) {
    wrapped.push(...wrapPlainText(line, width).split("\n"));
  }
  return wrapped;
}

export function formatDurationMSForPanel(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return formatDuration(ms);
}
