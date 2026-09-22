// Translated from internal/serve/channels/background_recovery_test.go.

import { assert } from "@std/assert";
import { newAssistantMessage } from "../../provider/mod.ts";
import { SessionRunEventSink } from "../../agentruntime/run_event.ts";
import { newManager } from "../../session/mod.ts";
import { ChannelSession, type Dispatcher } from "./dispatcher.ts";
import { reconcileCompletedBackgroundRun } from "./background_recovery.ts";

Deno.test("reconcile completed background run after restart", () => {
  const sessionDir = Deno.makeTempDirSync({ prefix: "opensac-bgr-" });
  const workDir = Deno.makeTempDirSync();
  const mgr = newManager(workDir, sessionDir);
  mgr.init();
  const entryID = mgr.appendMessage(
    newAssistantMessage([{ type: "text", text: "background answer" }]),
  );
  const now = new Date();
  const sink = new SessionRunEventSink(sessionDir);
  sink.record({
    sessionId: mgr.getHeader()!.id,
    runId: "run-channel-restart",
    eventType: "tool_progress",
    source: "channel:wechat",
    status: "completed",
    model: "",
    mode: "",
    timestamp: now,
    data: { tool: "read", status: "completed", summary: "file read" },
  });
  sink.record({
    sessionId: mgr.getHeader()!.id,
    runId: "run-channel-restart",
    eventType: "finished",
    source: "channel:wechat",
    status: "completed",
    model: "",
    mode: "",
    timestamp: new Date(now.getTime() + 1),
    data: { channelDeliveryPending: true, assistantEntryId: entryID },
  });
  const d = { sessionDir } as unknown as Dispatcher;
  const channel = new ChannelSession();
  channel.platform = "wechat";
  channel.userID = "user";
  channel.manager = mgr;
  const deliveries: string[] = [];
  reconcileCompletedBackgroundRun(d, channel, (text) => deliveries.push(text));
  assert(
    deliveries.length === 2 && deliveries[0].includes("read") &&
      deliveries[1].includes("background answer"),
    `deliveries = ${JSON.stringify(deliveries)}`,
  );
  reconcileCompletedBackgroundRun(d, channel, (text) => deliveries.push(text));
  assert(
    deliveries.length === 2,
    `delivery repeated after reconciliation: ${JSON.stringify(deliveries)}`,
  );
});
