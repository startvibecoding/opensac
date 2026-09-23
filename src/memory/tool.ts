import {
  createTextToolResult,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "../tools/tool.ts";
import type { Store } from "./store.ts";

/** Provides persistent memory read/write via memory.md. */
export class MemoryTool implements Tool {
  #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  name(): string {
    return "memory";
  }

  description(): string {
    return "Read and write persistent memory (memory.md). Use to recall user preferences, project context, and lessons learned. Memory persists across sessions.";
  }

  promptSnippet(): string {
    return "Read/write persistent memory across sessions";
  }

  promptGuidelines(): string[] {
    return [
      "A persistent memory file (memory.md) is available via the `memory` tool. Read it at the start of complex tasks to recall user preferences and prior context. Update it when you learn important facts about the user or project.",
    ];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The action to perform: read, add, update, delete",
          enum: ["read", "add", "update", "delete"],
        },
        section: {
          type: "string",
          description:
            "The section name (e.g. 'User Profile', 'Working Memory', 'Lessons Learned'). Required for add/update/delete. Optional for read (omit to read all).",
        },
        content: {
          type: "string",
          description:
            "The content to add or delete. Required for add and delete actions.",
        },
        old: {
          type: "string",
          description: "The old text to replace. Required for update action.",
        },
        new: {
          type: "string",
          description:
            "The new text to replace with. Required for update action.",
        },
      },
      required: ["action"],
    };
  }

  execute(_ctx: ToolContext, params: Record<string, unknown>): ToolResult {
    const action = typeof params["action"] === "string"
      ? params["action"] as string
      : "";
    const section = typeof params["section"] === "string"
      ? params["section"] as string
      : "";
    const content = typeof params["content"] === "string"
      ? params["content"] as string
      : "";
    const old = typeof params["old"] === "string"
      ? params["old"] as string
      : "";
    const newText = typeof params["new"] === "string"
      ? params["new"] as string
      : "";

    switch (action) {
      case "read":
        return this.#executeRead(section);
      case "add":
        return this.#executeAdd(section, content);
      case "update":
        return this.#executeUpdate(section, old, newText);
      case "delete":
        return this.#executeDelete(section, content);
      default:
        throw new Error(
          `unknown action: ${action} (use: read, add, update, delete)`,
        );
    }
  }

  #executeRead(section: string): ToolResult {
    if (section !== "") {
      const content = this.#store.readSection(section);
      if (content === "") {
        return createTextToolResult(
          `Section '${section}' is empty or not found.`,
        );
      }
      return createTextToolResult(content);
    }

    // Read all.
    const { content, path, source } = this.#store.read();
    if (content === "") {
      return createTextToolResult(
        'No memory file found. Use memory(action="add", section="...", content="...") to create one.',
      );
    }

    const header = `[source: ${source} — ${path}]\n\n`;
    return createTextToolResult(header + content);
  }

  #executeAdd(section: string, content: string): ToolResult {
    if (section === "") {
      throw new Error("section is required for add action");
    }
    if (content === "") {
      throw new Error("content is required for add action");
    }

    this.#store.add(section, content);
    return createTextToolResult(`Added to '${section}': ${content}`);
  }

  #executeUpdate(section: string, old: string, newText: string): ToolResult {
    if (section === "") {
      throw new Error("section is required for update action");
    }
    if (old === "") {
      throw new Error("old text is required for update action");
    }
    if (newText === "") {
      throw new Error("new text is required for update action");
    }

    this.#store.update(section, old, newText);
    return createTextToolResult(
      `Updated in '${section}': '${old}' → '${newText}'`,
    );
  }

  #executeDelete(section: string, content: string): ToolResult {
    if (section === "") {
      throw new Error("section is required for delete action");
    }
    if (content === "") {
      throw new Error("content is required for delete action");
    }

    this.#store.delete(section, content);
    return createTextToolResult(`Deleted from '${section}': ${content}`);
  }
}
