// Ported from internal/serve/channels/watchdog.go — force-stops channel runs
// that stopped making progress. Go's Dispatcher methods map to functions that
// take the Dispatcher first (a TS class cannot be spread across the Go
// package's files).
//
// Deviations: the ticker goroutine maps to an async loop with a setTimeout
// tick that exits when the dispatcher run-root signal aborts; Go's
// sync.RWMutex critical sections are all synchronous, so the mutex pairs
// collapse; `time.Time` zero values map to unset (NaN) dates.

import type { Agent } from "../../agent/mod.ts";
import { RunStore } from "../../agentruntime/run_store.ts";
import { RunStateCancelling } from "../../agentruntime/run_state.ts";
import { SessionRunEventSink } from "../../agentruntime/run_event.ts";
import { updateDurableRun } from "../../agentruntime/durable_ops.ts";
import type { ChannelSession, Dispatcher } from "./dispatcher.ts";
import {
  defaultConfig,
  getRunMaxDurationMS,
  getRunStaleTimeoutMS,
  withConfigMethods,
} from "./config.ts";

/** watchdogTick is how often the dispatcher scans channel runs for stalls. */
export const watchdogTickMS = 15_000;

/**
 * startWatchdog launches the run watchdog. It stops when the dispatcher run
 * root signal aborts (Dispatcher.Close).
 */
export function startWatchdog(d: Dispatcher): void {
  if (d === null || d === undefined || d.runRootSignal === null) return;
  void runWatchdog(d);
}

async function runWatchdog(d: Dispatcher): Promise<void> {
  const signal = d.runRootSignal!;
  while (!signal.aborted) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, watchdogTickMS);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    if (signal.aborted) return;
    checkStalledRuns(d, new Date());
  }
}

/**
 * checkStalledRuns force-stops channel runs that stopped making progress.
 * A run is stalled when no agent event arrived within the configured stale
 * timeout, or when it exceeds the configured total duration cap. Force-stopping
 * aborts the agent (unblocking waits that ignore context cancellation), cancels
 * the run context and marks the persisted run as cancelling so /new, /status
 * and the WebUI converge on reality instead of reporting a phantom active run.
 */
export function checkStalledRuns(d: Dispatcher, now: Date): void {
  const runtime = d.runtimeSnapshot();
  const cfg = runtime.cfg ?? withConfigMethods(defaultConfig());
  const stale = getRunStaleTimeoutMS(cfg.agent);
  const maxDuration = getRunMaxDurationMS(cfg.agent);
  if (stale <= 0 && maxDuration <= 0) return;

  const sessions = [...d.sessions.values()];

  const activeRuns = new Set<string>();
  for (const sess of sessions) {
    if (sess === null || sess === undefined) continue;
    const runID = sess.runID;
    const cancel = sess.runCancel;
    const runningAgent = sess.runAgent;
    const startedAt = sess.runStartedAt;
    const lastEventAt = sess.lastEventAt;
    if (runID === "") continue;
    activeRuns.add(runID);

    let reason = "";
    if (
      maxDuration > 0 && !Number.isNaN(startedAt.getTime()) &&
      now.getTime() - startedAt.getTime() > maxDuration
    ) {
      reason = `run exceeded max duration ${
        formatDurationSeconds(maxDuration)
      }`;
    } else if (
      stale > 0 && !Number.isNaN(lastEventAt.getTime()) &&
      now.getTime() - lastEventAt.getTime() > stale
    ) {
      reason = `no agent events for ${formatDurationSeconds(stale)}`;
    }
    if (reason === "") continue;
    if (watchdogAlreadyFired(d, runID)) continue;
    forceStopRun(d, sess, runID, reason, cancel, runningAgent);
  }
  pruneWatchdogFired(d, activeRuns);
}

/** formatDurationSeconds renders a millisecond duration rounded to whole
 * seconds the way Go prints a rounded time.Duration (e.g. "10m0s" → "600s").
 * Go uses Duration.Round(time.Second) whose String format is compound; the
 * projection keeps the human-readable compound form for the common units. */
function formatDurationSeconds(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total % 3600 === 0 && total >= 3600) {
    const h = total / 3600;
    if (h % 24 === 0) return `${h / 24}d`;
    return `${h}h0m0s`;
  }
  if (total % 60 === 0 && total >= 60) return `${total / 60}m0s`;
  return `${total}s`;
}

/**
 * forceStopRun persists the cancellation through the canonical durable Run,
 * falling back to the in-process abort bridge when no ExecutionRuntime is
 * attached (test fixtures and legacy embedded hosts).
 */
export function forceStopRun(
  d: Dispatcher,
  sess: ChannelSession,
  runID: string,
  reason: string,
  cancel: (() => void) | null,
  runningAgent: Agent | null,
): void {
  const sessionID = sess.id;
  console.error(
    `[channels] watchdog forcing stop of run ${runID} (session ${sessionID}): ${reason}`,
  );
  const message = "watchdog: " + reason;
  let cancelled = false;
  if (sess.execution !== null && sess.execution !== undefined) {
    sess.execution.setRunStore(new RunStore(d.sessionDir));
    sess.execution.setEventSink(new SessionRunEventSink(d.sessionDir));
    try {
      cancelled = sess.execution.cancelDurable(message);
    } catch (err) {
      console.error(
        `[channels] watchdog persist cancellation for run ${runID}: ${err}`,
      );
    }
  }
  if (!cancelled) {
    if (runningAgent !== null && runningAgent !== undefined) {
      runningAgent.abort();
    }
    cancel?.();
    try {
      updateDurableRun(d.sessionDir, runID, RunStateCancelling, message);
    } catch (err) {
      console.error(`[channels] watchdog update run ${runID}: ${err}`);
    }
  }
  const eventData = { error: message };
  const event = {
    sessionId: sessionID,
    runId: runID,
    eventType: "canceled",
    // Keep the watchdog marker distinct from the originating adapter source;
    // the run row and normal lifecycle events retain the resolved source.
    source: "channel:watchdog",
    status: "cancelling",
    model: "",
    mode: "",
    timestamp: new Date(),
    data: eventData,
  };
  try {
    if (sess.execution !== null && sess.execution !== undefined) {
      sess.execution.recordEvent(event);
    } else {
      new SessionRunEventSink(d.sessionDir).record(event);
    }
  } catch (err) {
    console.error(`[channels] watchdog save run event ${runID}: ${err}`);
  }
  d.notifyRunObserver(sessionID);
}

/**
 * watchdogAlreadyFired records that a run was already force-stopped so a run
 * that ignores abort does not get spammed with repeated stop requests. Entries
 * are pruned once the run leaves the active set.
 */
export function watchdogAlreadyFired(d: Dispatcher, runID: string): boolean {
  if (d.watchdogFired.has(runID)) return true;
  d.watchdogFired.add(runID);
  return false;
}

export function pruneWatchdogFired(
  d: Dispatcher,
  activeRuns: Set<string>,
): void {
  for (const runID of d.watchdogFired) {
    if (!activeRuns.has(runID)) d.watchdogFired.delete(runID);
  }
}
