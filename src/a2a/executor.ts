// Ported from internal/a2a/executor.go.
//
// Deviation: the Go `AgentFactory.CreateForA2A` returns a concrete
// `*agent.Agent` whose `Run` produces a `<-chan Event`. Until the core agent
// loop lands in `src/agent` (backlog #19), the factory here returns a narrow
// `A2AAgent` contract (`id()` + `run()` yielding an `AsyncIterable<Event>`),
// which is protocol-compatible and lets the A2A executor be fully ported.

import type { AgentID } from "../../sdk/agent/types.ts";
import type { Event, TaskStatus } from "../agent/events.ts";
import {
  EventDone,
  EventError,
  EventRunFinished,
  EventTextDelta,
  EventToolCall,
  EventToolExecutionEnd,
  EventToolExecutionStart,
  TaskCanceled,
  TaskFailed,
  TaskIncomplete,
  TaskSuccess,
} from "../agent/events.ts";
import type { AgentExecutor } from "./handler.ts";
import type { Message, Task, TaskEvent } from "./task.ts";

/** A2AAgent is the narrow agent surface the A2A executor depends on. */
export interface A2AAgent {
  id(): AgentID;
  run(signal: AbortSignal, input: string): AsyncIterable<Event>;
}

/** AgentFactory creates agent instances for A2A task execution. */
export interface AgentFactory {
  createForA2A(workDir: string, mode: string): Promise<A2AAgent>;
}

/** DefaultExecutor implements AgentExecutor by running tasks through the loop. */
export class DefaultExecutor implements AgentExecutor {
  private agentFactory: AgentFactory;

  constructor(factory: AgentFactory) {
    this.agentFactory = factory;
  }

  /** ExecuteTask runs an A2A task through the agent loop. */
  async executeTask(
    ctx: AbortSignal,
    task: Task,
    msg: Message,
  ): Promise<AsyncIterable<TaskEvent>> {
    let userInput = "";
    for (const part of msg.parts) {
      if (part.type === "text" && part.text !== undefined && part.text !== "") {
        userInput = part.text;
        break;
      }
    }
    if (userInput === "") {
      throw new Error("no text content in message");
    }

    let a: A2AAgent;
    try {
      a = await this.agentFactory.createForA2A("", "yolo");
    } catch (err) {
      throw new Error(`create agent: ${(err as Error).message}`);
    }

    const agentEvents = a.run(ctx, userInput);
    return convertAgentEvents(ctx, task, agentEvents);
  }
}

/** NewDefaultExecutor creates a new default executor. */
export function newDefaultExecutor(factory: AgentFactory): DefaultExecutor {
  return new DefaultExecutor(factory);
}

/** Converts an agent event stream into A2A task events. */
async function* convertAgentEvents(
  ctx: AbortSignal,
  task: Task,
  events: AsyncIterable<Event>,
): AsyncGenerator<TaskEvent> {
  let response = "";
  let terminalSent = false;
  for await (const ev of events) {
    // Child-agent failures are isolated and must not fail the parent A2A task.
    if (ev.agentId !== undefined && ev.agentId !== "") continue;
    void ctx;
    const now = new Date().toISOString();
    switch (ev.type) {
      case EventTextDelta:
        response += ev.textDelta ?? "";
        yield {
          task_id: task.id,
          state: "working",
          message: {
            role: "agent",
            parts: [{ type: "text", text: ev.textDelta ?? "" }],
          },
          timestamp: now,
        };
        break;

      case EventRunFinished: {
        terminalSent = true;
        const status: TaskStatus = ev.status ?? "";
        if (status === TaskFailed) {
          yield {
            task_id: task.id,
            state: "failed",
            error: {
              code: -32000,
              message: ev.error?.message ?? "unknown error",
            },
            timestamp: now,
          };
        } else if (status === TaskCanceled) {
          yield {
            task_id: task.id,
            state: "canceled",
            timestamp: now,
          };
        } else if (status === TaskIncomplete) {
          yield {
            task_id: task.id,
            state: "incomplete",
            artifact: {
              name: "response",
              parts: [{ type: "text", text: response }],
            },
            timestamp: now,
          };
        } else if (status === TaskSuccess) {
          yield {
            task_id: task.id,
            state: "completed",
            artifact: {
              name: "response",
              parts: [{ type: "text", text: response }],
            },
            timestamp: now,
          };
        }
        break;
      }

      case EventDone:
        if (terminalSent) continue;
        terminalSent = true;
        yield {
          task_id: task.id,
          state: "completed",
          artifact: {
            name: "response",
            parts: [{ type: "text", text: response }],
          },
          timestamp: now,
        };
        break;

      case EventError:
        if (terminalSent) continue;
        terminalSent = true;
        yield {
          task_id: task.id,
          state: "failed",
          error: {
            code: -32000,
            message: ev.error?.message ?? "unknown error",
          },
          timestamp: now,
        };
        break;

      case EventToolCall:
      case EventToolExecutionStart:
      case EventToolExecutionEnd: {
        let toolName = ev.toolName ?? "";
        if (toolName === "" && ev.toolCall !== undefined) {
          toolName = ev.toolCall.name;
        }
        if (toolName !== "") {
          yield {
            task_id: task.id,
            state: "working",
            message: {
              role: "agent",
              parts: [{ type: "text", text: `[tool: ${toolName}]` }],
            },
            timestamp: now,
          };
        }
        break;
      }
    }
  }
  if (!terminalSent) {
    // Event stream closed without a terminal event — protocol failure, never a
    // successful completion.
    yield {
      task_id: task.id,
      state: "failed",
      error: {
        code: -32000,
        message: "event stream closed without terminal result",
      },
      timestamp: new Date().toISOString(),
    };
  }
}
