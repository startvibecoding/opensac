// Translated from internal/serve/openaiapi/external_subagents_test.go — the
// channel-owned sub-agent history sink, its live broker publication, and the
// /ws/runs WebSocket protocol reachability.
//
// Deviations: Go's httptest + golang.org/x/net/websocket dial maps to
// Deno.serve with the browser-standard WebSocket client; Go's channel receive
// loops map to awaited BrokerEventStream.next() calls; Go's agent.Event
// literals map to the ported Event constants.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { closeAll } from "../../db/mod.ts";
import type { Model } from "../../provider/types.ts";
import type { Provider } from "../../provider/provider.ts";
import { newMockProvider } from "../../provider/mock.ts";
import {
  streamDone,
  streamStart,
  streamTextDelta,
} from "../../provider/mod.ts";
import {
  type Event,
  EventDone,
  EventRunFinished,
  EventTextDelta,
  EventToolCall,
  EventToolExecutionEnd,
} from "../../agent/events.ts";
import { statusActive } from "../../esm/mod.ts";
import { Server } from "./server.ts";
import { SessionPool } from "./session_mgr.ts";
import { newSessionStreamHub } from "./session_stream.ts";
import { EventBroker } from "./event_broker.ts";
import { esmStore, getOrCreateSession } from "./handler_chat_session.ts";
import { getWorkDir } from "./config.ts";
import {
  newExternalSubAgentServer,
  publishExternalSubAgentEvent,
} from "./external_subagents.ts";
import {
  getSessionSubAgentMessages,
  getSessionSubAgents,
} from "./session_read.ts";
import { runWebSocketHandler } from "./websocket.ts";

function tempDir(prefix: string): string {
  return Deno.makeTempDirSync({ prefix });
}

function testModel(): Model {
  return {
    id: "m1",
    name: "Model 1",
    provider: "mock",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 2048,
  };
}

function newTestServer(): Server {
  const sessionDir = tempDir("openaiapi-ext-sa-sess-");
  const workDir = tempDir("openaiapi-ext-sa-work-");
  const server = new Server({
    settings: { sessionDir } as never,
    cfg: { defaultWorkDir: workDir } as never,
  });
  server.pool = new SessionPool(0, 0);
  server.streamHub = newSessionStreamHub();
  server.eventBroker = new EventBroker();
  const p = newMockProvider("mock", [testModel()], [
    { type: streamStart },
    { type: streamTextDelta, textDelta: "ok" },
    { type: streamDone, stopReason: "stop" },
  ]);
  server.provider = p as unknown as Provider;
  server.model = p.models()[0];
  return server;
}

/** nextJson resolves the next WebSocket message parsed as JSON. */
function nextJson(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for websocket message")),
      5000,
    );
    ws.addEventListener(
      "message",
      (m) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(typeof m.data === "string" ? m.data : "{}"));
        } catch (err) {
          reject(err);
        }
      },
      { once: true },
    );
  });
}

/**
 * External child terminal events are projections from channel-owned managers.
 * They may update the child history but are never an ESM continuation trigger:
 * only explicit user ESM mutations start the coordinator.
 */
Deno.test("externalMemberTerminalDoesNotStartESMContinuation", async () => {
  const server = newTestServer();
  try {
    const sessionID = "external-member-terminal-no-esm";
    await getOrCreateSession(server, sessionID, getWorkDir(server.cfg!));
    esmStore(server)!
      .create(sessionID, "complete the delivery without an auto-start");

    publishExternalSubAgentEvent(server, sessionID, {
      type: EventRunFinished,
      agentId: "member-terminal",
      memberId: "software-engineer",
      expertId: "software-company",
      memberDisplayName: "工程师",
      status: "success",
    } as unknown as Event);

    assert(
      server.startESM === undefined &&
        server.esmCoordinatorRunning?.(sessionID) !== true,
      "member terminal event started an ESM coordinator without a user ESM mutation",
    );
    const obj = esmStore(server)!.get(sessionID);
    assertEquals(obj.status, statusActive);
    const children = getSessionSubAgents(server, sessionID);
    assertEquals(children.length, 1);
    assertEquals(children[0].status, "done");
    assertEquals(children[0].memberId, "software-engineer");
  } finally {
    await server.pool!.stop();
    closeAll();
  }
});

Deno.test("externalSubAgentEventsExposeHistoryAndPublishLiveUpdates", async () => {
  const server = new Server();
  server.eventBroker = new EventBroker();
  server.pool = new SessionPool(0, 0);
  const { events, cancel } = server.eventBroker!.subscribe("wechat-session");

  publishExternalSubAgentEvent(server, "wechat-session", {
    type: EventTextDelta,
    agentId: "child-1",
    textDelta: "working",
    memberId: "engineer",
    expertId: "software-company",
    memberDisplayName: "工程师",
    memberEmoji: "🛠️",
    memberRole: "member",
  } as unknown as Event);
  publishExternalSubAgentEvent(server, "wechat-session", {
    type: EventToolCall,
    agentId: "child-1",
    toolCallId: "call-1",
    toolName: "grep",
    toolArgs: { pattern: "TODO" },
  } as unknown as Event);
  publishExternalSubAgentEvent(server, "wechat-session", {
    type: EventToolExecutionEnd,
    agentId: "child-1",
    toolCallId: "call-1",
    toolName: "grep",
    toolResult: "found",
  } as unknown as Event);
  publishExternalSubAgentEvent(server, "wechat-session", {
    type: EventDone,
    agentId: "child-1",
  } as unknown as Event);

  const agents = getSessionSubAgents(server, "wechat-session");
  assertEquals(agents.length, 1);
  assertEquals(agents[0].id, "child-1");
  assertEquals(agents[0].status, "done");
  assert(!agents[0].active);
  assertEquals(agents[0].messageCount, 4);
  assertEquals(agents[0].memberId, "engineer");
  assertEquals(agents[0].expertId, "software-company");
  assertEquals(agents[0].memberDisplayName, "工程师");
  assertEquals(agents[0].memberEmoji, "🛠️");
  assertEquals(agents[0].memberRole, "member");

  const messages = getSessionSubAgentMessages(
    server,
    "wechat-session",
    "child-1",
  );
  assertEquals(messages.length, 4);
  assertEquals(messages[0].role, "assistant");
  assertEquals(messages[0].content, "working");
  assertEquals(messages[1].role, "toolCall");
  assertEquals(messages[1].toolName, "grep");
  assertEquals(messages[2].role, "toolResult");
  assertEquals(messages[2].toolName, "grep");
  assertEquals(messages[3].role, "status");
  assertEquals(messages[3].content, "done");

  let gotTranscript = false;
  let gotTool = false;
  let gotDone = false;
  for (let i = 0; i < 4; i++) {
    const ev = await events.next();
    if (ev === undefined) break;
    if (ev.event === "transcript") {
      gotTranscript = true;
      const item = ev.data as { type?: string };
      if (item && item.type === "subagent_status") gotDone = true;
    }
    if (ev.event === "tool_event") gotTool = true;
  }
  cancel();
  assert(gotTranscript && gotTool && gotDone);

  let unknown: unknown;
  try {
    getSessionSubAgentMessages(server, "wechat-session", "unknown");
  } catch (err) {
    unknown = err;
  }
  assert(unknown instanceof Error);
  assertStringIncludes((unknown as Error).message, "session not found");
});

Deno.test("externalSubAgentEventsReachWebSocketClient", async () => {
  const server = newExternalSubAgentServer();
  const ac = new AbortController();
  const http = Deno.serve(
    { port: 0, signal: ac.signal },
    (req) => runWebSocketHandler(server, req),
  );
  let ws: WebSocket | undefined;
  try {
    const url = `ws://localhost:${(http.addr as Deno.NetAddr).port}`;
    ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws!.onopen = () => resolve();
      ws!.onerror = () => reject(new Error("websocket dial failed"));
    });

    ws.send(
      JSON.stringify({ type: "hello", clientId: "external-subagent-test" }),
    );
    const ready = await nextJson(ws);
    assertEquals(ready["type"], "ready");

    ws.send(JSON.stringify({
      type: "subscribe",
      subscriptions: [{ sessionId: "wechat-session" }],
    }));
    const subscribed = await nextJson(ws);
    assertEquals(subscribed["type"], "subscribed");
    assertEquals(subscribed["sessionId"], "wechat-session");

    publishExternalSubAgentEvent(server, "wechat-session", {
      type: EventTextDelta,
      agentId: "child-1",
      textDelta: "live",
    } as unknown as Event);
    publishExternalSubAgentEvent(server, "wechat-session", {
      type: EventDone,
      agentId: "child-1",
    } as unknown as Event);

    let gotText = false;
    let gotDone = false;
    while (!gotText || !gotDone) {
      const event = await nextJson(ws);
      if (
        event["type"] !== "session_event" ||
        event["sessionId"] !== "wechat-session" ||
        event["event"] !== "transcript"
      ) {
        continue;
      }
      const data = event["data"] as {
        type?: string;
        message?: { content?: string };
      };
      if (data.type === "assistant_delta" && data.message?.content === "live") {
        gotText = true;
      }
      if (data.type === "subagent_status" && data.message?.content === "done") {
        gotDone = true;
      }
    }
  } finally {
    ac.abort();
    await http.finished.catch(() => {});
    ws?.close();
    await server.pool!.stop();
  }
});

Deno.test("externalSubAgentTerminalEventDeduplicated", () => {
  const server = new Server();
  server.eventBroker = new EventBroker();
  server.pool = new SessionPool(0, 0);

  // The parent event stream and the AgentManager status listener can both
  // deliver the same terminal event; the sink must record it only once.
  publishExternalSubAgentEvent(server, "wechat-session", {
    type: EventTextDelta,
    agentId: "child-1",
    textDelta: "work",
  } as unknown as Event);
  publishExternalSubAgentEvent(server, "wechat-session", {
    type: EventDone,
    agentId: "child-1",
  } as unknown as Event);
  publishExternalSubAgentEvent(server, "wechat-session", {
    type: EventDone,
    agentId: "child-1",
  } as unknown as Event);
  // Anything after the terminal state is a duplicate or out-of-order straggler.
  publishExternalSubAgentEvent(server, "wechat-session", {
    type: EventTextDelta,
    agentId: "child-1",
    textDelta: "late",
  } as unknown as Event);

  const agents = getSessionSubAgents(server, "wechat-session");
  assertEquals(agents.length, 1);
  assertEquals(agents[0].status, "done");
  assert(!agents[0].active);
  assertEquals(agents[0].messageCount, 2);

  const messages = getSessionSubAgentMessages(
    server,
    "wechat-session",
    "child-1",
  );
  assertEquals(messages.length, 2);
  assertEquals(messages[1].role, "status");
  assertEquals(messages[1].content, "done");
});

Deno.test("externalSubAgentTerminalFallbackRecoversQueuedAssistantText", async () => {
  const server = new Server();
  server.eventBroker = new EventBroker();
  server.pool = new SessionPool(0, 0);
  const { events, cancel } = server.eventBroker!.subscribe("wechat-session");

  // The AgentManager terminal listener can overtake text already queued on the
  // parent stream. Its status snapshot carries the complete persisted result so
  // the projection can fill the missing suffix before publishing the terminal.
  publishExternalSubAgentEvent(server, "wechat-session", {
    type: EventTextDelta,
    agentId: "child-1",
    textDelta: "child ",
  } as unknown as Event);
  publishExternalSubAgentEvent(server, "wechat-session", {
    type: EventRunFinished,
    agentId: "child-1",
    status: "success",
    statusMessage: "child result",
  } as unknown as Event);
  publishExternalSubAgentEvent(server, "wechat-session", {
    type: EventTextDelta,
    agentId: "child-1",
    textDelta: "result",
  } as unknown as Event);

  const messages = getSessionSubAgentMessages(
    server,
    "wechat-session",
    "child-1",
  );
  assertEquals(messages.length, 2);
  assertEquals(messages[0].role, "assistant");
  assertEquals(messages[0].content, "child result");
  assertEquals(messages[1].role, "status");
  assertEquals(messages[1].content, "done");

  const projected: {
    type?: string;
    message?: { content?: string };
  }[] = [];
  for (let i = 0; i < 3; i++) {
    const ev = await events.next();
    if (ev === undefined) break;
    if (ev.event === "transcript") {
      projected.push(
        ev.data as {
          type?: string;
          message?: { content?: string };
        },
      );
    }
  }
  cancel();
  assertEquals(projected.length, 3);
  assertEquals(projected[0].type, "assistant_delta");
  assertEquals(projected[0].message?.content, "child ");
  assertEquals(projected[1].type, "assistant_delta");
  assertEquals(projected[1].message?.content, "result");
  assertEquals(projected[2].type, "subagent_status");
});
