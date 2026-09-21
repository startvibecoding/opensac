// Ported from internal/serve/channels/background_recovery.go — delivers a
// completed channel background result after a dispatcher restart. Delivery
// state lives in run events, while the message body remains in the canonical
// session transcript. Go's Dispatcher method maps to a function that takes the
// Dispatcher first.
//
// Deviations: Go's map iteration order is unspecified; the port iterates the
// pending map in insertion order, which is deterministic here.

import {
  listSessionMessagesAfter,
  listSessionRunEvents,
} from "../../session/mod.ts";
import { replayRunEvents } from "../../agentruntime/run_replay.ts";
import {
  newDeliveryReconciledEvent,
  replayDeliveries,
} from "../../agentruntime/delivery_replay.ts";
import { SessionRunEventSink } from "../../agentruntime/run_event.ts";
import type { Message } from "../../provider/mod.ts";
import { formatAttachmentSummary } from "./run_helpers.ts";
import type { ChannelSession, Dispatcher } from "./dispatcher.ts";

/**
 * reconcileCompletedBackgroundRun replays the pending channel deliveries for
 * one session and marks them reconciled. `progress` is the platform-owned
 * delivery sink (the same callback that streams run progress).
 */
export function reconcileCompletedBackgroundRun(
  d: Dispatcher | null,
  sess: ChannelSession | null,
  progress: ((text: string) => void) | null,
): void {
  if (
    d === null || d === undefined || sess === null || sess === undefined ||
    progress === null || progress === undefined || sess.manager === null ||
    sess.manager === undefined
  ) {
    return;
  }
  const header = sess.manager.getHeader();
  if (header === null || header === undefined || header.id === "") return;
  let events;
  try {
    events = listSessionRunEvents(d.sessionDir, header.id);
  } catch {
    return;
  }
  const replay = replayRunEvents(events, "");
  interface PendingDelivery {
    runId: string;
    assistantEntry: string;
    progress: string[];
  }
  const pendingRecords = replayDeliveries(events);
  const pending = new Map<string, PendingDelivery>();
  const progressByRun = new Map<string, string[]>();
  for (const event of replay.events) {
    if (
      !isChannelRunSource(event.source) || event.eventType !== "tool_progress"
    ) {
      continue;
    }
    let tool = "";
    let status = "";
    let summary = "";
    if (event.data !== null && typeof event.data === "object") {
      const data = event.data as Record<string, unknown>;
      if (typeof data.tool === "string") tool = data.tool;
      if (typeof data.status === "string") status = data.status;
      if (typeof data.summary === "string") summary = data.summary;
    }
    if (tool.trim() === "" && status.trim() === "") continue;
    let line = `Tool ${tool} ${status}`.trim();
    if (summary.trim() !== "" && summary !== "(empty result)") {
      line += ": " + summary;
    }
    if (line !== "") {
      const lines = progressByRun.get(event.runId) ?? [];
      lines.push(line);
      progressByRun.set(event.runId, lines);
    }
  }
  for (const [runId, record] of pendingRecords) {
    pending.set(runId, {
      runId,
      assistantEntry: record.assistantEntry,
      progress: progressByRun.get(runId) ?? [],
    });
  }
  if (pending.size === 0) return;
  let messages;
  try {
    messages = listSessionMessagesAfter(d.sessionDir, header.id, 0, 500);
  } catch {
    return;
  }
  for (const [runId, item] of pending) {
    let message: Message | null = null;
    for (const candidate of messages) {
      if (
        item.assistantEntry !== "" && candidate.entryID === item.assistantEntry
      ) {
        message = candidate.message;
        break;
      }
    }
    if (message === null) continue;
    for (const line of item.progress) {
      progress(line);
    }
    let text = (message.content ?? "").trim();
    if (text === "") {
      for (const block of message.contents ?? []) {
        if (block.type === "text") text += block.text;
      }
      text = text.trim();
    }
    const summary = formatAttachmentSummary(message.attachments ?? []);
    if (summary !== "") {
      if (text !== "") text += "\n\n";
      text += summary;
    }
    if (text !== "") {
      progress(text);
    }
    try {
      new SessionRunEventSink(d.sessionDir).record(
        newDeliveryReconciledEvent(
          header.id,
          runId,
          "channel",
          { reason: "dispatcher_restart" },
        ),
      );
    } catch {
      // Go ignores the record error too; the next restart retries delivery.
    }
  }
}

/** isChannelRunSource reports whether a run-event source label was produced by
 * the channel dispatcher (any adapter variant). */
export function isChannelRunSource(source: string): boolean {
  const normalized = source.trim().toLowerCase();
  switch (normalized) {
    case "wechat":
    case "feishu":
    case "channel:wechat":
    case "channel:feishu":
      return true;
    default:
      return normalized.startsWith("channel:");
  }
}
