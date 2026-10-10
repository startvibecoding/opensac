//
// The Go tool delegates to the `go-fd` SDK. This port implements an equivalent
// native filesystem walk: basename glob matching with smart-case, honoring
// `.gitignore`/`.ignore`/`.rgignore` and hidden-file rules through the ported
// `ignore.ts` stack. Paths are emitted as absolute paths sorted
// lexicographically. This is registered as a deliberate deviation from the
// external SDK dependency.

import * as path from "../compat/path.ts";
import { compileGeneratedRegExp } from "../util/regex.ts";
import { globToRegex } from "./globset.ts";
import { IgnoreStack } from "./ignore.ts";
import {
  createTextToolResult,
  type Registry,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./tool.ts";

/** Searches for files by name pattern. */
export class FindTool implements Tool {
  #registry: Registry;

  constructor(r: Registry) {
    this.#registry = r;
  }

  name(): string {
    return "find";
  }

  description(): string {
    return "Search for files by name pattern. Supports glob patterns. Use for finding files by name, extension, or path pattern.";
  }

  promptSnippet(): string {
    return "Find files by glob pattern (preferred for locating files, respects .gitignore)";
  }

  promptGuidelines(): string[] {
    return [];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Glob pattern to match file names (e.g. '*.go', '*.test.*')",
        },
        path: {
          type: "string",
          description: "Directory to search in (default: current directory)",
        },
        maxDepth: {
          type: "integer",
          description: "Maximum directory depth (default: unlimited)",
        },
        maxResults: {
          type: "integer",
          description: "Maximum number of results (default 100)",
        },
      },
      required: ["pattern"],
    };
  }

  async execute(
    _ctx: ToolContext,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    const pattern = typeof params["pattern"] === "string"
      ? params["pattern"] as string
      : "";
    if (pattern === "") {
      throw new Error("pattern is required");
    }

    let searchPath = this.#registry.getWorkDir();
    const pv = params["path"];
    if (typeof pv === "string" && pv !== "") {
      try {
        searchPath = this.#registry.resolvePath(pv);
      } catch (err) {
        throw new Error(`invalid path: ${messageOf(err)}`);
      }
    }
    try {
      Deno.statSync(searchPath);
    } catch (err) {
      throw new Error(`invalid path: ${messageOf(err)}`);
    }

    let maxDepth = 0;
    const dv = params["maxDepth"];
    if (typeof dv === "number" && dv > 0) maxDepth = Math.trunc(dv);

    let maxResults = 100;
    const rv = params["maxResults"];
    if (typeof rv === "number" && rv > 0) maxResults = Math.trunc(rv);

    const caseSensitive = hasUppercase(pattern);
    const flags = caseSensitive ? "" : "i";
    let regex: RegExp;
    try {
      regex = compileGeneratedRegExp(globToRegex(pattern), flags);
    } catch (err) {
      throw new Error(`find search failed: ${messageOf(err)}`);
    }

    const results: string[] = [];
    await walk(
      searchPath,
      searchPath,
      1,
      maxDepth,
      regex,
      maxResults,
      results,
      null,
    );

    results.sort();
    if (results.length === 0) {
      return createTextToolResult("(no files found)");
    }
    return createTextToolResult(results.join("\n"));
  }
}

async function walk(
  root: string,
  dir: string,
  depth: number,
  maxDepth: number,
  regex: RegExp,
  maxResults: number,
  out: string[],
  parentStack: IgnoreStack | null,
): Promise<void> {
  if (out.length >= maxResults) return;

  let stack: IgnoreStack;
  if (parentStack === null) {
    stack = new IgnoreStack(false, false, 0);
    stack.loadBaseRules(dir);
  } else {
    stack = parentStack.clone();
  }
  stack.push(dir);

  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    if (out.length >= maxResults) return;
    const full = path.join(dir, entry.name);
    const isDir = entry.isDirectory;
    if (stack.isIgnored(full, isDir)) continue;

    if (isDir) {
      if (maxDepth > 0 && depth + 1 > maxDepth) continue;
      await walk(
        root,
        full,
        depth + 1,
        maxDepth,
        regex,
        maxResults,
        out,
        stack,
      );
      continue;
    }

    if (regex.test(entry.name)) {
      out.push(full);
    }
  }
}

function hasUppercase(s: string): boolean {
  for (const ch of s) {
    if (ch !== ch.toLowerCase() && ch === ch.toUpperCase()) return true;
  }
  return false;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
