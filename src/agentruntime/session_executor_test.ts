// deno-lint-ignore-file require-await -- async fake driver models the Promise-based executor seam
import { assertEquals } from "../compat/assert.ts";
import {
  EVENT_QUESTION_REQUEST,
  EVENT_RUN_FINISHED,
  EVENT_TEXT_DELTA,
  EVENT_TOOL_APPROVAL_REQUEST,
} from "../agent/events.ts";
import {
  fromAgentEvent,
  type SessionExecutionDriver,
  SessionExecutor,
  type SessionExecutorEvent,
} from "./session_executor.ts";
import { test } from "#testing";

class FakeDriver implements SessionExecutionDriver {
  released = 0;
  cancelled = 0;
  finished: string[] = [];

  async admit(): Promise<() => void> {
    return () => this.released++;
  }

  async createRun(): Promise<{
    runId: string;
    events: AsyncIterable<SessionExecutorEvent>;
    cancel: () => void;
  }> {
    const runId = "run-1";
    return {
      runId,
      cancel: () => this.cancelled++,
      events: (async function* () {
        yield {
          type: EVENT_TEXT_DELTA,
          payload: { text: "hello" },
          terminal: false,
        };
        yield {
          type: EVENT_RUN_FINISHED,
          payload: { status: "success" },
          terminal: true,
        };
        yield {
          type: EVENT_RUN_FINISHED,
          payload: { status: "success" },
          terminal: true,
        };
      })(),
    };
  }

  finish(_runId: string, state: string): void {
    this.finished.push(state);
  }
}

test("fromAgentEvent preserves stream deltas and terminal status", () => {
  const delta = fromAgentEvent({
    type: EVENT_TEXT_DELTA,
    textDelta: "hello",
  });
  assertEquals(delta.payload.text, "hello");
  assertEquals(delta.terminal, false);

  const finished = fromAgentEvent({
    type: EVENT_RUN_FINISHED,
    status: "success",
    stopReason: "end_turn",
  });
  assertEquals(finished.terminal, true);
  assertEquals(finished.payload.status, "success");
});
test("fromAgentEvent preserves interactive approval and question fields", () => {
  const approval = fromAgentEvent({
    type: EVENT_TOOL_APPROVAL_REQUEST,
    approvalId: "approval-1",
    approvalTool: "bash",
    approvalArgs: { command: "pwd" },
  });
  assertEquals(approval.payload.approvalId, "approval-1");
  assertEquals(approval.payload.approvalTool, "bash");
  assertEquals(approval.payload.approvalArgs, { command: "pwd" });

  const question = fromAgentEvent({
    type: EVENT_QUESTION_REQUEST,
    questionId: "question-1",
    questionText: "Continue?",
    questionOptions: ["yes", "no"],
  });
  assertEquals(question.payload.questionId, "question-1");
  assertEquals(question.payload.questionText, "Continue?");
  assertEquals(question.payload.questionOptions, ["yes", "no"]);
});

test("SessionExecutor consumes one terminal event and releases admission", async () => {
  const driver = new FakeDriver();
  const events: SessionExecutorEvent[] = [];
  const executor = new SessionExecutor({
    driver,
    newId: () => "run-1",
    publish: (event) => {
      events.push(event);
    },
  });

  const accepted = await executor.prompt("hello");
  await executor.waitForIdle();

  assertEquals(accepted.runId, "run-1");
  assertEquals(driver.released, 1);
  assertEquals(driver.finished, ["completed"]);
  assertEquals(events.filter((event) => event.terminal).length, 1);
  assertEquals(events[1].payload.text, "hello");
});
