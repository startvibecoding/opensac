// Ported from internal/tools/grep.go.
//
// The Go tool delegates to the `go-ripgrep` SDK. This port reuses the ported
// `globset.ts`/`ignore.ts` for the `include` filter and ignore handling and
// runs a native per-line regex search (falling back to a literal substring
// search when the regex is invalid). Go's concurrent worker pool maps to a
// sequential async traversal that awaits directory scans and file reads so a
// long search cannot freeze the single-threaded runtime. Oversized files are
// skipped instead of being buffered whole into memory. This is registered as
// a deliberate deviation from the external SDK dependency.

import * as path from "@std/path";
import { GlobSet } from "./globset.ts";
import { IgnoreStack } from "./ignore.ts";
import {
  newTextToolResult,
  type Registry,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./tool.ts";

const maxGrepOutputBytes = 200000;
/** Files larger than this are skipped: the scan buffers whole files. */
const maxGrepFileBytes = 16 * 1024 * 1024;

/** Searches file contents using regex patterns. */
export class GrepTool implements Tool {
  #registry: Registry;

  constructor(r: Registry) {
    this.#registry = r;
  }

  name(): string {
    return "grep";
  }

  description(): string {
    return "Search file contents using regex patterns. Returns matching lines with file paths and line numbers. If the pattern is an invalid regex, it automatically falls back to a literal search. Use for finding code patterns, function definitions, etc. Files over 16MB are skipped.";
  }

  promptSnippet(): string {
    return "Search file contents for patterns (preferred for code search, respects .gitignore)";
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
            "Regex pattern to search for. Invalid regex patterns automatically fall back to literal search.",
        },
        path: {
          type: "string",
          description:
            "Directory or file to search in (default: current directory)",
        },
        include: {
          type: "string",
          description: "File pattern to include (e.g. '*.go')",
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

    const include = typeof params["include"] === "string"
      ? params["include"] as string
      : "";
    let maxResults = 100;
    const rv = params["maxResults"];
    if (typeof rv === "number" && rv > 0) maxResults = Math.trunc(rv);

    let matcher: RegExp;
    let literalFallback = false;
    try {
      matcher = new RegExp(pattern);
    } catch {
      try {
        matcher = new RegExp(escapeRegExp(pattern));
        literalFallback = true;
      } catch (err) {
        throw new Error(`grep search failed: ${messageOf(err)}`);
      }
    }

    let includeGlob: GlobSet | null = null;
    if (include !== "") {
      try {
        includeGlob = GlobSet.newGlobSet([include]);
      } catch (err) {
        throw new Error(`grep search failed: ${messageOf(err)}`);
      }
    }

    let files: GrepFile[];
    try {
      files = await collectGrepFiles(searchPath, includeGlob);
    } catch (err) {
      throw new Error(`grep search failed: ${messageOf(err)}`);
    }

    const lines: string[] = [];
    let bytesUsed = 0;
    let count = 0;
    let truncated = false;
    let skipped = 0;
    for (const file of files) {
      let size: number;
      try {
        size = (await Deno.stat(file.path)).size;
      } catch {
        continue;
      }
      if (size > maxGrepFileBytes) {
        skipped++;
        continue;
      }
      let data: Uint8Array;
      try {
        data = await Deno.readFile(file.path);
      } catch {
        continue;
      }
      if (isBinary(data)) continue;
      const text = new TextDecoder().decode(data);
      const fileLines = text.split("\n");
      for (let i = 0; i < fileLines.length; i++) {
        const line = fileLines[i].replace(/\r$/, "");
        if (!matcher.test(line)) continue;
        if (maxResults > 0 && count >= maxResults) {
          truncated = true;
          break;
        }
        const out = `${file.path}:${i + 1}:${line}`;
        if (bytesUsed + out.length > maxGrepOutputBytes) {
          truncated = true;
          break;
        }
        lines.push(out);
        bytesUsed += out.length;
        count++;
      }
      if (truncated) break;
    }

    const skippedNote = skipped > 0
      ? `\n... (skipped ${skipped} files over ${
        Math.floor(maxGrepFileBytes / (1024 * 1024))
      }MB)`
      : "";
    if (lines.length === 0) {
      if (literalFallback) {
        return newTextToolResult(
          "(invalid regex; fell back to literal search)\n(no matches found)" +
            skippedNote,
        );
      }
      return newTextToolResult("(no matches found)" + skippedNote);
    }

    let output = lines.join("\n");
    if (literalFallback) {
      output = "(invalid regex; fell back to literal search)\n" + output;
    }
    if (truncated) {
      if (maxResults > 0 && count >= maxResults) {
        output += `\n... (truncated, showing first ${maxResults} results)`;
      } else {
        output += `\n... (truncated at ${maxGrepOutputBytes} bytes)`;
      }
    }
    output += skippedNote;

    return newTextToolResult(output);
  }
}

interface GrepFile {
  path: string;
  rel: string;
}

function collectGrepFiles(
  root: string,
  includeGlob: GlobSet | null,
): Promise<GrepFile[]> {
  return (async () => {
    const info = Deno.lstatSync(root);
    if (!info.isDirectory) {
      if (shouldIncludeGrepPath(root, path.basename(root), includeGlob)) {
        return [{ path: root, rel: path.basename(root) }];
      }
      return [];
    }

    const files: GrepFile[] = [];
    const stack = new IgnoreStack(false, false, 0);
    stack.loadBaseRules(root);
    await walkGrepDir(root, root, stack, includeGlob, files);
    return files;
  })();
}

async function walkGrepDir(
  root: string,
  dir: string,
  stack: IgnoreStack,
  includeGlob: GlobSet | null,
  files: GrepFile[],
): Promise<void> {
  stack.push(dir);
  try {
    const entries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(dir)) {
      entries.push(entry);
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const isDir = entry.isDirectory;
      if (stack.isIgnored(full, isDir)) continue;
      if (isDir) {
        await walkGrepDir(root, full, stack.clone(), includeGlob, files);
        continue;
      }
      let rel: string;
      try {
        rel = path.relative(root, full);
      } catch {
        rel = path.basename(full);
      }
      if (shouldIncludeGrepPath(full, rel, includeGlob)) {
        files.push({ path: full, rel });
      }
    }
  } catch {
    // unreadable directory
  } finally {
    stack.pop();
  }
}

function shouldIncludeGrepPath(
  _p: string,
  rel: string,
  includeGlob: GlobSet | null,
): boolean {
  if (includeGlob === null) return true;
  return !includeGlob.matchGlobFilter(rel.replaceAll("\\", "/"));
}

function isBinary(data: Uint8Array): boolean {
  const n = Math.min(data.length, 8192);
  for (let i = 0; i < n; i++) {
    if (data[i] === 0) return true;
  }
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
