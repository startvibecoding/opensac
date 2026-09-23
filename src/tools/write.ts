// (the write tool; diff/atomic helpers live
// in io_helpers.ts).

import {
  buildFileDiff,
  type FileDiff,
  formatFileDiffSummary,
  writeFileAtomic,
} from "./io_helpers.ts";
import {
  createDiffToolResult,
  type Registry,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./tool.ts";

/** Writes content to files. */
export class WriteTool implements Tool {
  #registry: Registry;

  constructor(r: Registry) {
    this.#registry = r;
  }

  name(): string {
    return "write";
  }

  description(): string {
    return "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.";
  }

  promptSnippet(): string {
    return "Create or overwrite files";
  }

  promptGuidelines(): string[] {
    return ["Use write only for new files or complete rewrites."];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to write" },
        content: {
          type: "string",
          description: "Content to write to the file",
        },
      },
      required: ["path", "content"],
    };
  }

  async execute(
    ctx: ToolContext,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    const pathParam = params["path"];
    const content = params["content"];
    if (typeof content !== "string") {
      throw new Error("content is required");
    }
    if (typeof pathParam !== "string" || pathParam === "") {
      throw new Error("path is required");
    }

    let p: string;
    try {
      p = this.#registry.resolvePath(pathParam);
    } catch (err) {
      throw new Error(`invalid path: ${messageOf(err)}`);
    }

    const release = await this.#registry.acquireFileLock(ctx, p, this.name());

    let oldContent = "";
    let oldExists = false;
    try {
      oldContent = new TextDecoder().decode(Deno.readFileSync(p));
      oldExists = true;
    } catch {
      // new file
    }

    try {
      writeFileAtomic(p, new TextEncoder().encode(content));
    } catch (err) {
      release();
      throw new Error(`write file: ${messageOf(err)}`);
    }
    release();

    const diff: FileDiff = buildFileDiff(p, oldContent, content);
    if (!oldExists) {
      diff.oldText = null;
    }
    return createDiffToolResult(
      `File written: ${p} (${utf8Length(content)} bytes)\n${
        formatFileDiffSummary(diff)
      }`,
      diff,
    );
  }
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
