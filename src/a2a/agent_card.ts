// Ported from internal/a2a/agent_card.go.

/** Capabilities describes what the agent can do. */
export interface Capabilities {
  streaming: boolean;
  pushNotifications: boolean;
}

/** Skill describes a specific capability. */
export interface Skill {
  id: string;
  name: string;
  description: string;
}

/** AgentCard represents the A2A Agent Card (/.well-known/agent.json). */
export interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: Capabilities;
  skills: Skill[];
}

/** DefaultAgentCard returns the default Agent Card for VibeCoding. */
export function defaultAgentCard(
  version: string,
  serverURL: string,
): AgentCard {
  return {
    name: "VibeCoding",
    description:
      "AI coding assistant with file editing, terminal, and search capabilities",
    url: serverURL + "/a2a",
    version,
    capabilities: {
      streaming: true,
      pushNotifications: false,
    },
    skills: [
      {
        id: "code-edit",
        name: "Code Editing",
        description:
          "Read, write, and edit code files with precise text replacement",
      },
      {
        id: "terminal",
        name: "Terminal Execution",
        description: "Execute shell commands, run tests, build projects",
      },
      {
        id: "code-search",
        name: "Code Search",
        description: "Search codebases with ripgrep and fd",
      },
    ],
  };
}

/** HandleAgentCard serves the Agent Card at /.well-known/agent.json. */
export function handleAgentCard(
  card: AgentCard,
): (req: Request) => Response {
  return (req: Request): Response => {
    if (req.method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }
    return new Response(JSON.stringify(card), {
      headers: { "Content-Type": "application/json" },
    });
  };
}
