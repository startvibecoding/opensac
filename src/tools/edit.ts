import {
  buildFileDiff,
  formatFileDiffSummary,
  writeFileAtomic,
} from "./io_helpers.ts";
import {
  newDiffToolResult,
  type Registry,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./tool.ts";

interface Edit {
  oldText: string;
  newText: string;
}

interface EditPos {
  edit: Edit;
  start: number;
  end: number;
}

/** Performs precise text replacements in files. */
export class EditTool implements Tool {
  #registry: Registry;

  constructor(r: Registry) {
    this.#registry = r;
  }

  name(): string {
    return "edit";
  }

  description(): string {
    return "Edit a file using exact text replacement. Each edit must match a unique, non-overlapping region of the file. For multiple changes to the same file, use multiple edits in one call.";
  }

  promptSnippet(): string {
    return "Make precise file edits with exact text replacement, including multiple disjoint edits in one call";
  }

  promptGuidelines(): string[] {
    return [
      "Use edit for precise changes (edits[].oldText must match exactly)",
      "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
      "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
      "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
    ];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to edit" },
        edits: {
          type: "array",
          description:
            "Array of edits. Each edit has oldText (exact match) and newText (replacement).",
          items: {
            type: "object",
            properties: {
              oldText: {
                type: "string",
                description: "Exact text to find and replace",
              },
              newText: {
                type: "string",
                description: "Replacement text",
              },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path", "edits"],
    };
  }

  async execute(
    ctx: ToolContext,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    const pathParam = params["path"];
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
    let locked = true;
    try {
      let data: Uint8Array;
      try {
        data = Deno.readFileSync(p);
      } catch (err) {
        throw new Error(`read file: ${messageOf(err)}`);
      }
      const originalContent = new TextDecoder().decode(data);
      const content = originalContent;

      const editsRaw = params["edits"];
      if (!Array.isArray(editsRaw) || editsRaw.length === 0) {
        throw new Error("edits array is required and must not be empty");
      }

      const edits: Edit[] = [];
      for (const e of editsRaw) {
        if (typeof e !== "object" || e === null) {
          throw new Error("invalid edit format");
        }
        const editMap = e as Record<string, unknown>;
        const oldText = typeof editMap["oldText"] === "string"
          ? editMap["oldText"] as string
          : "";
        const newText = typeof editMap["newText"] === "string"
          ? editMap["newText"] as string
          : "";
        if (oldText === "") {
          throw new Error("oldText is required for each edit");
        }
        edits.push({ oldText, newText });
      }

      const positions: EditPos[] = [];
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i];
        const count = countOccurrences(content, e.oldText);
        if (count === 0) {
          throw new Error(`edit ${i}: oldText not found in file`);
        }
        if (count > 1) {
          throw new Error(
            `edit ${i}: oldText matches ${count} times (must be unique). Make the match text more specific`,
          );
        }
        const start = content.indexOf(e.oldText);
        positions.push({ edit: e, start, end: start + e.oldText.length });
      }

      positions.sort((a, b) => a.start - b.start);

      for (let i = 1; i < positions.length; i++) {
        if (positions[i].start < positions[i - 1].end) {
          throw new Error(`edit ${i - 1} and edit ${i} overlap`);
        }
      }

      let newContent = "";
      let lastEnd = 0;
      for (const pos of positions) {
        newContent += content.slice(lastEnd, pos.start);
        newContent += pos.edit.newText;
        lastEnd = pos.end;
      }
      newContent += content.slice(lastEnd);

      try {
        writeFileAtomic(p, new TextEncoder().encode(newContent));
      } catch (err) {
        throw new Error(`write file: ${messageOf(err)}`);
      }
      release();
      locked = false;

      const diff = buildFileDiff(p, originalContent, newContent);
      return newDiffToolResult(
        `Applied ${edits.length} edit(s) to ${p}\n${
          formatFileDiffSummary(diff)
        }`,
        diff,
      );
    } finally {
      if (locked) release();
    }
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) break;
    count++;
    idx = found + needle.length;
  }
  return count;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
