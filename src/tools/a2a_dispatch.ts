// Ported from internal/tools/a2a_dispatch.go.

import {
  newTextToolResult,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./tool.ts";

/** A minimal view of a remote A2A agent. */
export interface AgentEntry {
  name: string;
  url: string;
}

/**
 * The interface needed by the a2a_dispatch tool. It is satisfied by the
 * a2a `A2AManager`.
 */
export interface A2ADispatcher {
  list(): AgentEntry[];
  dispatch(
    ctx: ToolContext,
    name: string,
    message: string,
  ): Promise<string> | string;
}

/** Sends tasks to registered remote A2A agents. */
export class A2ADispatchTool implements Tool {
  #dispatcher: A2ADispatcher;

  constructor(dispatcher: A2ADispatcher) {
    this.#dispatcher = dispatcher;
  }

  name(): string {
    return "a2a_dispatch";
  }

  description(): string {
    return "Send a task to a registered remote A2A agent. The agent will execute the task and return the result.";
  }

  promptSnippet(): string {
    return "Dispatch tasks to remote A2A agents";
  }

  promptGuidelines(): string[] {
    return [
      "Use a2a_dispatch to delegate tasks to specialized remote agents.",
      "Each agent has specific capabilities described in its Agent Card.",
      "Long-running tasks may take up to 5 minutes to complete.",
    ];
  }

  parameters(): unknown {
    const agents = this.#dispatcher.list();
    const agentNames = agents.map((a) => a.name);

    let agentDesc = "Available agents:\n";
    for (const a of agents) {
      agentDesc += `  - ${a.name} (${a.url})\n`;
    }

    return {
      type: "object",
      properties: {
        agent_name: {
          type: "string",
          description: agentDesc,
          enum: agentNames,
        },
        message: {
          type: "string",
          description: "The task message to send to the agent",
        },
      },
      required: ["agent_name", "message"],
    };
  }

  async execute(
    ctx: ToolContext,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    const agentName = params["agent_name"];
    if (typeof agentName !== "string" || agentName === "") {
      throw new Error("missing required parameter: agent_name");
    }

    const message = params["message"];
    if (typeof message !== "string" || message === "") {
      throw new Error("missing required parameter: message");
    }

    const result = await this.#dispatcher.dispatch(ctx, agentName, message);
    return newTextToolResult(result);
  }
}
