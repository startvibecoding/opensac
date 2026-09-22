// Focused tests for the AppController: the agent-event dispatch that feeds
// the transcript store, background-activity routing, approval/question
// queues with decision registration, and run-finished terminalization.

import { assert, assertEquals } from "@std/assert";
import { AppController, type RunHandle } from "./app_controller.ts";
import type { Event } from "../agent/events.ts";
import {
  EventDone,
  EventError,
  EventRunFinished,
  EventStatus,
  EventTextDelta,
  EventThinkDelta,
  EventToolCall,
  EventToolExecutionStart,
  EventToolResult,
  EventTurnEnd,
  EventTurnStart,
  TaskCanceled,
  TaskFailed,
} from "../agent/events.ts";
import { Translator } from "./i18n.ts";

function controller(
  leadAgentId?: string,
): { c: AppController; messages: string[] } {
  const messages: string[] = [];
  const c = new AppController(new Translator("en"), {
    onMessage: (_kind, text) => void messages.push(text),
    scheduleRender: () => {},
  }, { leadAgentId });
  return { c, messages };
}

function runHandle() {
  const registrations: Array<{ id: string; kind: string }> = [];
  const finished: string[] = [];
  const handle: RunHandle = {
    registerDecision(id, kind) {
      registrations.push({ id, kind });
      return undefined;
    },
    bindDecision() {},
    finish(state) {
      finished.push(state);
    },
  };
  return { handle, registrations, finished };
}

function ev(partial: Partial<Event>): Event {
  return { ...partial } as Event;
}

Deno.test("lead streaming events feed the transcript store", () => {
  const { c } = controller("lead");
  c.attachRun(runHandle().handle);
  c.handleAgentEvent(ev({ type: EventTurnStart }));
  c.handleAgentEvent(ev({ type: EventTextDelta, textDelta: "hel" }));
  c.handleAgentEvent(ev({ type: EventTextDelta, textDelta: "lo" }));
  c.handleAgentEvent(ev({ type: EventThinkDelta, thinkDelta: "hmm" }));
  c.handleAgentEvent(ev({ type: EventTurnEnd }));
  // Turn start reserved slot 0; think converted it; assistant slot 1 empty;
  // turn end committed both.
  assertEquals(c.store.currentAssistantIdx, -1);
  assertEquals(c.store.currentThinkIdx, -1);
  assertEquals(c.store.messages.length, 2);
});

Deno.test("background events route to the activity store, not the transcript", () => {
  const { c } = controller("lead");
  c.handleAgentEvent(
    ev({ type: EventTextDelta, agentId: "sub-1", textDelta: "sub text" }),
  );
  assertEquals(c.store.messages.length, 0);
  assertEquals(c.activities.size, 1);
  assertEquals(c.activities.get("sub-1")?.fullText, "sub text");
  // Lead's own events never become background activity
  c.handleAgentEvent(
    ev({ type: EventTextDelta, agentId: "lead", textDelta: "x" }),
  );
  assertEquals(c.activities.size, 1);
});

Deno.test("tool events open and terminalize rows", () => {
  const { c } = controller("lead");
  c.handleAgentEvent(ev({
    type: EventToolExecutionStart,
    toolCallId: "t1",
    toolName: "bash",
    toolArgs: { cmd: "ls" },
  }));
  assertEquals(c.store.toolResults[0].status, "running");
  c.handleAgentEvent(ev({
    type: EventToolResult,
    toolCallId: "t1",
    toolName: "bash",
    toolResult: "out",
  }));
  assertEquals(c.store.toolResults[0].status, "completed");
});

Deno.test("tool call event uses the embedded ToolCallBlock id/name", () => {
  const { c } = controller("lead");
  c.handleAgentEvent(ev({
    type: EventToolCall,
    toolCall: { id: "tc-1", name: "read" },
  }));
  assertEquals(c.store.toolResults[0].toolCallID, "tc-1");
  assertEquals(c.store.toolResults[0].toolName, "read");
});

Deno.test("status messages become transcript rows; retry-status skipped", () => {
  const { c, messages } = controller("lead");
  c.handleAgentEvent(ev({ type: EventStatus, statusMessage: "thinking..." }));
  assertEquals(messages, ["thinking..."]);
  c.handleAgentEvent(ev({
    type: EventStatus,
    retryStatus: true,
    statusMessage: "internal",
  }));
  assertEquals(messages.length, 1);
});

Deno.test("run finished terminalizes the run and interrupted tools", () => {
  const { c, messages } = controller("lead");
  const { handle, finished } = runHandle();
  c.attachRun(handle);
  c.isThinking = true;
  c.handleAgentEvent(
    ev({ type: EventToolExecutionStart, toolCallId: "t1", toolName: "bash" }),
  );
  c.handleAgentEvent(
    ev({
      type: EventRunFinished,
      status: TaskFailed,
      error: new Error("boom"),
    }),
  );
  assertEquals(finished, ["failed"]);
  assertEquals(c.isThinking, false);
  assertEquals(c.runTerminalHandled, true);
  assertEquals(c.store.toolResults[0].status, "interrupted");
  assertEquals(messages.join("\n").includes("boom"), true);
  // Success path
  const { handle: h2, finished: f2 } = runHandle();
  c.attachRun(h2);
  c.handleAgentEvent(ev({ type: EventRunFinished, status: "success" }));
  assertEquals(f2, ["completed"]);
});

Deno.test("cancellation maps to cancelled and adds a message", () => {
  const { c, messages } = controller("lead");
  const { handle, finished } = runHandle();
  c.attachRun(handle);
  c.handleAgentEvent(ev({ type: EventRunFinished, status: TaskCanceled }));
  assertEquals(finished, ["cancelled"]);
  assertEquals(messages.some((m) => m.toLowerCase().includes("cancel")), true);
});

Deno.test("legacy EventDone/EventError terminalize when RunFinished is absent", () => {
  const { c } = controller("lead");
  const { handle, finished } = runHandle();
  c.attachRun(handle);
  c.handleAgentEvent(ev({ type: EventError, error: new Error("legacy") }));
  assertEquals(finished, ["failed"]);
  assertEquals(c.runTerminalHandled, true);
  // A trailing legacy EventDone is ignored
  c.handleAgentEvent(ev({ type: EventDone }));
  assertEquals(finished, ["failed"]);
});

Deno.test("legacy EventDone terminalizes the run as completed", () => {
  const { c } = controller("lead");
  const { handle, finished } = runHandle();
  c.attachRun(handle);
  c.handleAgentEvent(ev({ type: EventDone }));
  assertEquals(finished, ["completed"]);
  assertEquals(c.runTerminalHandled, true);
});

Deno.test("approval requests register a decision and queue", () => {
  const { c } = controller("lead");
  const { handle, registrations } = runHandle();
  c.attachRun(handle);
  c.handleAgentEvent(ev({
    type: 15, // EventToolApprovalRequest
    approvalId: "ap-1",
    approvalTool: "bash",
    approvalArgs: { cmd: "rm" },
  }));
  assertEquals(registrations, [{ id: "ap-1", kind: "approval" }]);
  // Enqueue + show-next consumes the queue into the shown slot (Go semantics)
  assertEquals(c.approvalQueue.length, 0);
  assertEquals(c.shownApproval?.approvalID, "ap-1");
  assertEquals(c.shownApproval?.toolName, "bash");
  assertEquals(c.waitingForApproval, true);
});

Deno.test("member questions route to the lead mailbox path, not the human", () => {
  const { c, messages } = controller("lead");
  const { handle, registrations } = runHandle();
  c.attachRun(handle);
  c.handleAgentEvent(ev({
    type: 17, // EventQuestionRequest
    agentId: "sub-1",
    memberDisplayName: "Worker",
    questionText: "what next?",
  }));
  assertEquals(registrations.length, 0); // never registered as human decision
  assertEquals(c.questionQueue.length, 0);
  assertEquals(messages.some((m) => m.includes("Worker")), true);
});

Deno.test("human questions register and queue", () => {
  const { c } = controller("lead");
  const { handle, registrations } = runHandle();
  c.attachRun(handle);
  c.handleAgentEvent(ev({
    type: 17,
    questionId: "q-1",
    questionText: "continue?",
    questionOptions: ["yes", "no"],
  }));
  assertEquals(registrations, [{ id: "q-1", kind: "question" }]);
  assertEquals(c.questionQueue.length, 0); // consumed by show-next
  assertEquals(c.shownQuestion?.questionID, "q-1");
  assertEquals(c.waitingForQuestion, true);
  c.showNextQuestion();
  assertEquals(c.shownQuestion, undefined);
  assertEquals(c.waitingForQuestion, false);
});

Deno.test("duplicate approval registration surfaces an error message", () => {
  const { c, messages } = controller("lead");
  const handle: RunHandle = {
    registerDecision() {
      return "already registered";
    },
    bindDecision() {},
    finish() {},
  };
  c.attachRun(handle);
  c.handleAgentEvent(
    ev({ type: 15, approvalId: "ap-1", approvalTool: "bash" }),
  );
  assertEquals(c.approvalQueue.length, 0);
  assertEquals(
    messages.some((m) => m.includes("duplicate approval request")),
    true,
  );
});

// ─── Ink assembly ───────────────────────────────────────────────────────────

import { App } from "./app.tsx";
import { render } from "ink";

class FakeStdout {
  columns = 100;
  rows = 30;
  isTTY = true;
  output = "";
  write(s: string | Uint8Array): boolean {
    this.output += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }
  on(): this {
    return this;
  }
  off(): this {
    return this;
  }
  once(): this {
    return this;
  }
  addListener(): this {
    return this;
  }
  removeListener(): this {
    return this;
  }
  emit(): boolean {
    return false;
  }
  listenerCount(): number {
    return 0;
  }
  setEncoding(): this {
    return this;
  }
  end(): void {}
  hasColors(): boolean {
    return false;
  }
  getColorDepth(): number {
    return 1;
  }
}

Deno.test({
  name: "App renders controller transcript, header, and approval panel",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { c } = controller("lead");
    c.handleAgentEvent(
      ev({ type: EventTextDelta, textDelta: "streaming answer" }),
    );
    c.handleAgentEvent(ev({
      type: 15,
      approvalId: "ap-1",
      approvalTool: "bash",
      approvalArgs: { cmd: "ls" },
    }));
    const stdout = new FakeStdout();
    const instance = render(
      App({
        controller: c,
        header: {
          version: "test",
          providerName: "p",
          modelName: "m",
          cwd: "/w",
        },
        width: 90,
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    instance.unmount();
    const out = stdout.output.replace(
      // deno-lint-ignore no-control-regex
      /\u001B\[[0-9;]*m/g,
      "",
    );
    assert(out.includes("streaming answer"), out);
    assert(out.includes("Approval required"), out);
    assert(out.includes("OpenSAC (test)"), out);
  },
});

Deno.test("lead activity timeline tracks thinking and tools per turn", () => {
  const { c } = controller("lead");
  c.attachRun(runHandle().handle);
  c.handleAgentEvent(ev({ type: EventTurnStart }));
  c.handleAgentEvent(ev({ type: EventThinkDelta, thinkDelta: "hmm" }));
  c.handleAgentEvent(ev({
    type: EventToolCall,
    toolCall: { id: "t1", name: "bash" },
    toolArgs: { command: "ls" },
  }));

  // Tool still running: timeline shows thinking + running tool with live
  // elapsed timing.
  let items = c.activityManager.buildTimeline();
  assertEquals(items.length, 2);
  const tool = items.find((i) => i.type === "tool");
  assertEquals(tool?.status, "running");
  assertEquals(tool?.toolName, "bash");
  assertEquals(typeof tool?.elapsedMs, "number");
  const think = items.find((i) => i.type === "thinking");
  assertEquals(think?.status, "running");
  assertEquals(think?.content, "hmm");

  c.handleAgentEvent(ev({
    type: EventToolResult,
    toolCallId: "t1",
    toolResult: "ok",
  }));
  items = c.activityManager.buildTimeline();
  assertEquals(items.find((i) => i.type === "tool")?.status, "completed");
  assertEquals(items.find((i) => i.type === "tool")?.content, "ok");

  // Turn end finalizes the open thinking block.
  // After completion, thinking is removed from timeline (now in transcript).
  c.handleAgentEvent(ev({ type: EventTurnEnd }));
  assertEquals(
    c.activityManager.buildTimeline().find((i) => i.type === "thinking"),
    undefined,
  );
});

Deno.test("run finish interrupts tools that never returned", () => {
  const { c } = controller("lead");
  const { handle } = runHandle();
  c.attachRun(handle);
  c.handleAgentEvent(ev({ type: EventTurnStart }));
  c.handleAgentEvent(ev({
    type: EventToolExecutionStart,
    toolCallId: "t9",
    toolName: "bash",
  }));
  c.handleAgentEvent(ev({ type: EventRunFinished, status: TaskCanceled }));
  const tool = c.activityManager.buildTimeline().find((i) => i.type === "tool");
  assertEquals(tool?.status, "interrupted");
  // No thinking block was opened, so none is finalized.
  assertEquals(
    c.activityManager.buildTimeline().filter((i) => i.type === "thinking")
      .length,
    0,
  );
});

Deno.test("new turn resets the activity timeline", () => {
  const { c } = controller("lead");
  c.handleAgentEvent(ev({ type: EventTurnStart }));
  c.handleAgentEvent(ev({
    type: EventToolCall,
    toolCall: { id: "a", name: "grep" },
  }));
  assertEquals(c.activityManager.buildTimeline().length, 1);
  c.handleAgentEvent(ev({ type: EventTurnStart }));
  assertEquals(c.activityManager.buildTimeline().length, 0);
});
