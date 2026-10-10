// Focused tests for the AppController: the agent-event dispatch that feeds
// the transcript store, background-activity routing, approval/question
// queues with decision registration, and run-finished terminalization.

import { assert, assertEquals } from "../compat/assert.ts";
import { AppController, type RunHandle } from "./app_controller.ts";
import { type Event } from "../agent/events.ts";
import {
  EVENT_DONE,
  EVENT_ERROR,
  EVENT_HOSTED_ITEM,
  EVENT_PLAN_UPDATE,
  EVENT_RUN_FINISHED,
  EVENT_STATUS,
  EVENT_TEXT_DELTA,
  EVENT_THINK_DELTA,
  EVENT_TOOL_CALL,
  EVENT_TOOL_EXECUTION_END,
  EVENT_TOOL_EXECUTION_START,
  EVENT_TOOL_RESULT,
  EVENT_TURN_END,
  EVENT_TURN_START,
  TASK_CANCELED,
  TASK_FAILED,
  TOOL_EXECUTION_FAILED,
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

test("plan updates set the current plan and tag their tool row", () => {
  const { c } = controller("lead");
  c.handleAgentEvent(ev({ type: EVENT_TURN_START }));
  c.handleAgentEvent(
    ev({
      type: EVENT_TOOL_EXECUTION_START,
      toolCallId: "tc-p",
      toolName: "plan",
    }),
  );
  c.handleAgentEvent(
    ev({
      type: EVENT_PLAN_UPDATE,
      toolCallId: "tc-p",
      plan: {
        title: "T",
        note: "",
        steps: [{ title: "s", status: "running" }],
      },
    }),
  );
  c.handleAgentEvent(
    ev({
      type: EVENT_TOOL_RESULT,
      toolCallId: "tc-p",
      toolName: "plan",
      toolResult: "Plan: T",
    }),
  );
  assertEquals(c.currentPlan?.title, "T");
  assertEquals(c.store.toolResults[0]?.plan?.title, "T");
});

test("lead streaming events feed the transcript store", () => {
  const { c } = controller("lead");
  c.attachRun(runHandle().handle);
  c.handleAgentEvent(ev({ type: EVENT_TURN_START }));
  c.handleAgentEvent(ev({ type: EVENT_TEXT_DELTA, textDelta: "hel" }));
  c.handleAgentEvent(ev({ type: EVENT_TEXT_DELTA, textDelta: "lo" }));
  c.handleAgentEvent(ev({ type: EVENT_THINK_DELTA, thinkDelta: "hmm" }));
  c.handleAgentEvent(ev({ type: EVENT_TURN_END }));
  // Turn start reserved slot 0; think converted it; assistant slot 1 empty;
  // turn end committed both.
  assertEquals(c.store.currentAssistantIdx, -1);
  assertEquals(c.store.currentThinkIdx, -1);
  assertEquals(c.store.messages.length, 2);
});

test("background events route to the activity store, not the transcript", () => {
  const { c } = controller("lead");
  c.handleAgentEvent(
    ev({ type: EVENT_TEXT_DELTA, agentId: "sub-1", textDelta: "sub text" }),
  );
  assertEquals(c.store.messages.length, 0);
  assertEquals(c.activities.size, 1);
  assertEquals(c.activities.get("sub-1")?.fullText, "sub text");
  // Lead's own events never become background activity
  c.handleAgentEvent(
    ev({ type: EVENT_TEXT_DELTA, agentId: "lead", textDelta: "x" }),
  );
  assertEquals(c.activities.size, 1);
});

test("tool events open and terminalize rows", () => {
  const { c } = controller("lead");
  c.handleAgentEvent(ev({
    type: EVENT_TOOL_EXECUTION_START,
    toolCallId: "t1",
    toolName: "bash",
    toolArgs: { cmd: "ls" },
  }));
  assertEquals(c.store.toolResults[0].status, "running");
  c.handleAgentEvent(ev({
    type: EVENT_TOOL_RESULT,
    toolCallId: "t1",
    toolName: "bash",
    toolResult: "out",
  }));
  assertEquals(c.store.toolResults[0].status, "completed");
});

test("tool terminal state distinguishes failed and interrupted results", () => {
  const { c } = controller("lead");
  c.handleAgentEvent(ev({
    type: EVENT_TOOL_EXECUTION_START,
    toolCallId: "failed-tool",
    toolName: "read",
  }));
  c.handleAgentEvent(ev({
    type: EVENT_TOOL_EXECUTION_END,
    toolCallId: "failed-tool",
    toolName: "read",
    toolResult: "tool failed",
    toolExecutionState: "failed",
  }));
  assertEquals(c.store.toolResults[0].status, "completed");
  assertEquals(c.store.toolResults[0].executionState, "failed");

  c.handleAgentEvent(ev({
    type: EVENT_TOOL_EXECUTION_START,
    toolCallId: "stopped-tool",
    toolName: "read",
  }));
  c.handleAgentEvent(ev({
    type: EVENT_TOOL_EXECUTION_END,
    toolCallId: "stopped-tool",
    toolName: "read",
    toolResult: "stopped",
    toolExecutionState: "interrupted",
  }));
  assertEquals(c.store.toolResults[1].status, "interrupted");
  assertEquals(c.store.toolResults[1].executionState, "interrupted");
});

test("tool call event uses the embedded ToolCallBlock id/name", () => {
  const { c } = controller("lead");
  c.handleAgentEvent(ev({
    type: EVENT_TOOL_CALL,
    toolCall: { id: "tc-1", name: "read" },
  }));
  assertEquals(c.store.toolResults[0].toolCallID, "tc-1");
  assertEquals(c.store.toolResults[0].toolName, "read");
});

test("status messages become transcript rows; retry-status skipped", () => {
  const { c, messages } = controller("lead");
  c.handleAgentEvent(ev({ type: EVENT_STATUS, statusMessage: "thinking..." }));
  assertEquals(messages, ["thinking..."]);
  c.handleAgentEvent(ev({
    type: EVENT_STATUS,
    retryStatus: true,
    statusMessage: "internal",
  }));
  assertEquals(messages.length, 1);
});

test("routine lifecycle rows are full-view-only, important ones are not", () => {
  const { c, messages } = controller("lead");
  c.handleAgentEvent(ev({
    type: EVENT_STATUS,
    statusMessage: "Context compacted: 1200 tokens",
  }));
  c.handleAgentEvent(ev({
    type: EVENT_STATUS,
    statusMessage: "Tool failed: permission denied",
  }));
  assertEquals(messages.length, 2);
  // The simple view drops routine lifecycle rows, but keeps them in the
  // transcript so the full view can replay them.
  assertEquals(c.store.isFullOnly(0), true);
  assertEquals(c.store.isFullOnly(1), false);
  assertEquals(c.store.messageKinds.get(0), "status");
  assertEquals(c.store.messageKinds.get(1), "status");
});

test("hosted items only stay visible in the simple view once terminal", () => {
  const { c } = controller("lead");
  c.handleAgentEvent(ev({
    type: EVENT_HOSTED_ITEM,
    hostedItem: { type: "image", status: "running" },
  }));
  c.handleAgentEvent(ev({
    type: EVENT_HOSTED_ITEM,
    hostedItem: { type: "image", status: "completed" },
  }));
  assertEquals(c.store.isFullOnly(0), true);
  assertEquals(c.store.isFullOnly(1), false);
  assertEquals(c.store.messages[1], "hosted item [image]: completed");
});

test("clearing the transcript forgets kinds and full-view-only rows", () => {
  const { c } = controller("lead");
  c.handleAgentEvent(ev({ type: EVENT_STATUS, statusMessage: "compacting" }));
  const generation = c.store.generation;
  c.store.resetTranscriptState();
  assertEquals(c.store.messages, []);
  assertEquals(c.store.isFullOnly(0), false);
  assertEquals(c.store.messageKinds.size, 0);
  assertEquals(c.store.generation, generation + 1);
});

test("run finished terminalizes the run and interrupted tools", () => {
  const { c, messages } = controller("lead");
  const { handle, finished } = runHandle();
  c.attachRun(handle);
  c.isThinking = true;
  c.handleAgentEvent(
    ev({
      type: EVENT_TOOL_EXECUTION_START,
      toolCallId: "t1",
      toolName: "bash",
    }),
  );
  c.handleAgentEvent(
    ev({
      type: EVENT_RUN_FINISHED,
      status: TASK_FAILED,
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
  c.handleAgentEvent(ev({ type: EVENT_RUN_FINISHED, status: "success" }));
  assertEquals(f2, ["completed"]);
});

test("cancellation maps to cancelled and adds a message", () => {
  const { c, messages } = controller("lead");
  const { handle, finished } = runHandle();
  c.attachRun(handle);
  c.handleAgentEvent(ev({ type: EVENT_RUN_FINISHED, status: TASK_CANCELED }));
  assertEquals(finished, ["cancelled"]);
  assertEquals(messages.some((m) => m.toLowerCase().includes("cancel")), true);
});

test("legacy EVENT_DONE/EVENT_ERROR terminalize when RunFinished is absent", () => {
  const { c } = controller("lead");
  const { handle, finished } = runHandle();
  c.attachRun(handle);
  c.handleAgentEvent(ev({ type: EVENT_ERROR, error: new Error("legacy") }));
  assertEquals(finished, ["failed"]);
  assertEquals(c.runTerminalHandled, true);
  // A trailing legacy EVENT_DONE is ignored
  c.handleAgentEvent(ev({ type: EVENT_DONE }));
  assertEquals(finished, ["failed"]);
});

test("legacy EVENT_DONE terminalizes the run as completed", () => {
  const { c } = controller("lead");
  const { handle, finished } = runHandle();
  c.attachRun(handle);
  c.handleAgentEvent(ev({ type: EVENT_DONE }));
  assertEquals(finished, ["completed"]);
  assertEquals(c.runTerminalHandled, true);
});

test("approval requests register a decision and queue", () => {
  const { c } = controller("lead");
  const { handle, registrations } = runHandle();
  c.attachRun(handle);
  c.handleAgentEvent(ev({
    type: 15, // EVENT_TOOL_APPROVAL_REQUEST
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

test("member questions route to the lead mailbox path, not the human", () => {
  const { c, messages } = controller("lead");
  const { handle, registrations } = runHandle();
  c.attachRun(handle);
  c.handleAgentEvent(ev({
    type: 17, // EVENT_QUESTION_REQUEST
    agentId: "sub-1",
    memberDisplayName: "Worker",
    questionText: "what next?",
  }));
  assertEquals(registrations.length, 0); // never registered as human decision
  assertEquals(c.questionQueue.length, 0);
  assertEquals(messages.some((m) => m.includes("Worker")), true);
});

test("human questions register and queue", () => {
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

test("duplicate approval registration surfaces an error message", () => {
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
import { test } from "#testing";

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

test({
  name: "App renders controller transcript, header, and approval panel",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { c } = controller("lead");
    c.handleAgentEvent(
      ev({ type: EVENT_TEXT_DELTA, textDelta: "streaming answer" }),
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
      // eslint-disable-next-line no-control-regex
      /\u001B\[[0-9;]*m/g,
      "",
    );
    assert(out.includes("streaming answer"), out);
    assert(out.includes("Approval required"), out);
    assert(out.includes("OpenSAC (test)"), out);
  },
});

test({
  name: "overlay freezes new scrollback and hides live activity",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { c } = controller("lead");
    const view = (overlayOpen: boolean) =>
      App({
        controller: c,
        header: {
          version: "test",
          providerName: "p",
          modelName: "m",
          cwd: "/w",
        },
        width: 90,
        overlayOpen,
      });
    const stdout = new FakeStdout();
    const instance = render(view(false), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    c.handleAgentEvent(ev({ type: EVENT_TURN_START }));
    c.handleAgentEvent(
      ev({ type: EVENT_TEXT_DELTA, textDelta: "before overlay" }),
    );
    c.handleAgentEvent(ev({ type: EVENT_TURN_END }));
    instance.rerender(view(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const overlayStart = stdout.output.length;

    c.handleAgentEvent(ev({ type: EVENT_TURN_START }));
    c.handleAgentEvent(
      ev({ type: EVENT_TEXT_DELTA, textDelta: "hidden while open" }),
    );
    c.handleAgentEvent(ev({
      type: EVENT_TOOL_EXECUTION_START,
      toolCallId: "live-tool",
      toolName: "bash",
      toolArgs: { command: "never-render-behind-overlay" },
    }));
    c.handleAgentEvent(ev({ type: EVENT_TURN_END }));
    instance.rerender(view(true));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const hidden = stdout.output.slice(overlayStart);
    assert(!hidden.includes("hidden while open"), hidden);
    assert(!hidden.includes("never-render-behind-overlay"), hidden);

    const closeStart = stdout.output.length;
    instance.rerender(view(false));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const closed = stdout.output.slice(closeStart);
    assert(closed.includes("hidden while open"), closed);
    instance.unmount();
  },
});

test({
  name: "terminal tool rows remain scrollback-only after overlay close",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { c } = controller("lead");
    const view = (overlayOpen: boolean) =>
      App({
        controller: c,
        header: {
          version: "test",
          providerName: "p",
          modelName: "m",
          cwd: "/w",
        },
        width: 90,
        overlayOpen,
      });
    const stdout = new FakeStdout();
    const instance = render(view(false), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    c.handleAgentEvent(ev({ type: EVENT_TURN_START }));
    c.handleAgentEvent(ev({
      type: EVENT_TOOL_EXECUTION_START,
      toolCallId: "failed-tool",
      toolName: "bash",
      toolArgs: { command: "overlay-tool-failure" },
    }));
    instance.rerender(view(true));
    await new Promise((resolve) => setTimeout(resolve, 20));

    c.handleAgentEvent(ev({
      type: EVENT_TOOL_EXECUTION_END,
      toolCallId: "failed-tool",
      toolName: "bash",
      toolResult: "failed",
      toolExecutionState: TOOL_EXECUTION_FAILED,
    }));
    instance.rerender(view(true));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const closeStart = stdout.output.length;
    instance.rerender(view(false));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const closed = stdout.output.slice(closeStart);
    assertEquals(
      closed.match(/overlay-tool-failure/g)?.length ?? 0,
      1,
      closed,
    );
    instance.unmount();
  },
});

test("lead activity timeline tracks thinking and tools per turn", () => {
  const { c } = controller("lead");
  c.attachRun(runHandle().handle);
  c.handleAgentEvent(ev({ type: EVENT_TURN_START }));
  c.handleAgentEvent(ev({ type: EVENT_THINK_DELTA, thinkDelta: "hmm" }));
  c.handleAgentEvent(ev({
    type: EVENT_TOOL_CALL,
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
    type: EVENT_TOOL_RESULT,
    toolCallId: "t1",
    toolResult: "ok",
  }));
  items = c.activityManager.buildTimeline();
  assertEquals(items.find((i) => i.type === "tool")?.status, "completed");
  assertEquals(items.find((i) => i.type === "tool")?.content, "ok");

  // Turn end finalizes the open thinking block.
  // After completion, thinking is removed from timeline (now in transcript).
  c.handleAgentEvent(ev({ type: EVENT_TURN_END }));
  assertEquals(
    c.activityManager.buildTimeline().find((i) => i.type === "thinking"),
    undefined,
  );
});

test("run finish interrupts tools that never returned", () => {
  const { c } = controller("lead");
  const { handle } = runHandle();
  c.attachRun(handle);
  c.handleAgentEvent(ev({ type: EVENT_TURN_START }));
  c.handleAgentEvent(ev({
    type: EVENT_TOOL_EXECUTION_START,
    toolCallId: "t9",
    toolName: "bash",
  }));
  c.handleAgentEvent(ev({ type: EVENT_RUN_FINISHED, status: TASK_CANCELED }));
  const tool = c.activityManager.buildTimeline().find((i) => i.type === "tool");
  assertEquals(tool?.status, "interrupted");
  // No thinking block was opened, so none is finalized.
  assertEquals(
    c.activityManager.buildTimeline().filter((i) => i.type === "thinking")
      .length,
    0,
  );
});

test("new turn resets the activity timeline", () => {
  const { c } = controller("lead");
  c.handleAgentEvent(ev({ type: EVENT_TURN_START }));
  c.handleAgentEvent(ev({
    type: EVENT_TOOL_CALL,
    toolCall: { id: "a", name: "grep" },
  }));
  assertEquals(c.activityManager.buildTimeline().length, 1);
  c.handleAgentEvent(ev({ type: EVENT_TURN_START }));
  assertEquals(c.activityManager.buildTimeline().length, 0);
});

test({
  name: "live activity rows render each tool's single-line call",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { c } = controller("lead");
    c.handleAgentEvent(ev({ type: EVENT_TURN_START }));
    c.handleAgentEvent(ev({
      type: EVENT_TOOL_EXECUTION_START,
      toolCallId: "t-bash",
      toolName: "bash",
      toolArgs: { command: "cd /a/b & ls" },
    }));
    const stdout = new FakeStdout();
    const view = () =>
      App({
        controller: c,
        header: {
          version: "test",
          providerName: "p",
          modelName: "m",
          cwd: "/w",
        },
        width: 90,
      });
    const instance = render(view(), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert(stdout.output.includes("bash: cd /a/b & ls"), stdout.output);

    // Only a lone running call stays on the activity timeline: a call that
    // starts while a sibling runs joins the sibling's tree block instead
    // (see tool_group_test.ts).
    c.handleAgentEvent(ev({
      type: EVENT_TOOL_RESULT,
      toolCallId: "t-bash",
      toolName: "bash",
      toolResult: "ok",
    }));
    c.handleAgentEvent(ev({
      type: EVENT_TOOL_EXECUTION_START,
      toolCallId: "t-read",
      toolName: "read",
      toolArgs: { path: "src/main.ts" },
    }));
    instance.rerender(view());
    await new Promise((resolve) => setTimeout(resolve, 50));
    instance.unmount();
    const out = stdout.output;
    assert(out.includes("read: src/main.ts"), out);
  },
});
