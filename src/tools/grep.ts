//
// The Go tool delegates to the `go-ripgrep` SDK. This port reuses the ported
// `globset.ts`/`ignore.ts` for the `include` filter and ignore handling and
// runs a native per-line regex search (falling back to a literal substring
// search when the regex is invalid). Go's concurrent worker pool maps to a
// sequential async traversal that awaits directory scans and file reads so a
// long search cannot freeze the single-threaded runtime. Oversized files are
// skipped instead of being buffered whole into memory. This is registered as
// a deliberate deviation from the external SDK dependency.

import { runtime as nodeRuntime } from "../platform/runtime.ts";
import type { DirEntry } from "../platform/runtime.ts";
import * as path from "../compat/path.ts";
import { compileUserRegExp } from "../util/regex.ts";
import {
  createUserRegExpMatcher,
  RegExpMatchTimeoutError,
  type UserRegExpMatcher,
} from "../util/regex_match.ts";
import { GlobSet } from "./globset.ts";
import { IgnoreStack } from "./ignore.ts";
import {
  createTextToolResult,
  type Registry,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./tool.ts";

const maxGrepOutputBytes = 200000;
/** Files larger than this are skipped: the scan buffers whole files. */
const maxGrepFileBytes = 16 * 1024 * 1024;

/** Options for {@link GrepTool}. */
export interface GrepToolOptions {
  /** Wall-clock budget for one worker match request (tests use small values). */
  matchTimeoutMs?: number;
}

/** Searches file contents using regex patterns. */
export class GrepTool implements Tool {
  #registry: Registry;
  #matchTimeoutMs: number | undefined;

  constructor(r: Registry, options: GrepToolOptions = {}) {
    this.#registry = r;
    this.#matchTimeoutMs = options.matchTimeoutMs;
  }

  name(): string {
    return "grep";
  }

  description(): string {
    return "Search file contents using regex patterns. Returns matching lines with file paths and line numbers. If the pattern is an invalid or unsafe regex, it automatically falls back to a literal search. Use for finding code patterns, function definitions, etc. Files over 16MB are skipped.";
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
            "Regex pattern to search for. Invalid or unsafe regex patterns automatically fall back to literal search.",
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
    const pattern =
      typeof params["pattern"] === "string"
        ? (params["pattern"] as string)
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
      nodeRuntime.statSync(searchPath);
    } catch (err) {
      throw new Error(`invalid path: ${messageOf(err)}`);
    }

    const include =
      typeof params["include"] === "string"
        ? (params["include"] as string)
        : "";
    let maxResults = 100;
    const rv = params["maxResults"];
    if (typeof rv === "number" && rv > 0) maxResults = Math.trunc(rv);

    let matcher: UserRegExpMatcher;
    let fallbackNote: string | null = null;
    try {
      compileUserRegExp(pattern);
      matcher = createUserRegExpMatcher(pattern, "", {
        timeoutMs: this.#matchTimeoutMs,
      });
    } catch {
      // Literal fallback: an escaped literal has no quantifiers, so matching it
      // cannot backtrack. It runs in the same bounded worker for one uniform
      // code path (and one chunked yield cadence) across both modes.
      let literalSource: string;
      try {
        literalSource = escapeRegExp(pattern);
        new RegExp(literalSource);
      } catch (err) {
        throw new Error(`grep search failed: ${messageOf(err)}`);
      }
      fallbackNote = "(invalid regex; fell back to literal search)";
      matcher = createUserRegExpMatcher(literalSource, "", {
        timeoutMs: this.#matchTimeoutMs,
      });
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

    let scan: GrepScan;
    try {
      scan = await scanGrepFiles(
        files,
        (lines) => matcher.match(lines),
        maxResults,
      );
    } catch (err) {
      if (!(err instanceof RegExpMatchTimeoutError)) throw err;
      // A pattern that survived the shape screen still timed out in the
      // bounded worker: that is the "unsafe regex" half of the tool contract,
      // so restart the whole scan as a literal search (results from the two
      // modes must never mix).
      fallbackNote = "(regex matching timed out; fell back to literal search)";
      matcher.close();
      matcher = createUserRegExpMatcher(escapeRegExp(pattern), "", {
        timeoutMs: this.#matchTimeoutMs,
      });
      scan = await scanGrepFiles(
        files,
        (lines) => matcher.match(lines),
        maxResults,
      );
    } finally {
      matcher.close();
    }

    const skippedNote =
      scan.skipped > 0
        ? `\n... (skipped ${scan.skipped} files over ${Math.floor(
            maxGrepFileBytes / (1024 * 1024),
          )}MB)`
        : "";
    if (scan.lines.length === 0) {
      const empty = "(no matches found)" + skippedNote;
      return createTextToolResult(
        fallbackNote === null ? empty : `${fallbackNote}\n${empty}`,
      );
    }

    let output = scan.lines.join("\n");
    if (fallbackNote !== null) output = `${fallbackNote}\n` + output;
    if (scan.truncated) {
      if (maxResults > 0 && scan.count >= maxResults) {
        output += `\n... (truncated, showing first ${maxResults} results)`;
      } else {
        output += `\n... (truncated at ${maxGrepOutputBytes} bytes)`;
      }
    }
    output += skippedNote;

    return createTextToolResult(output);
  }
}

interface GrepScan {
  lines: string[];
  count: number;
  truncated: boolean;
  skipped: number;
}

/**
 * Runs the per-file content scan. Matching happens in batches so the worker
 * request cadence doubles as the event-loop yield cadence: a 16MB file can no
 * longer monopolize the thread the way the old per-line loop did.
 */
async function scanGrepFiles(
  files: GrepFile[],
  matchLines: (lines: string[]) => Promise<number[]>,
  maxResults: number,
): Promise<GrepScan> {
  const scan: GrepScan = { lines: [], count: 0, truncated: false, skipped: 0 };
  let bytesUsed = 0;
  for (const file of files) {
    let size: number;
    try {
      size = (await nodeRuntime.stat(file.path)).size;
    } catch {
      continue;
    }
    if (size > maxGrepFileBytes) {
      scan.skipped++;
      continue;
    }
    let data: Uint8Array;
    try {
      data = await nodeRuntime.readFile(file.path);
    } catch {
      continue;
    }
    if (isBinary(data)) continue;
    const text = new TextDecoder().decode(data);
    const fileLines = text.split("\n").map((line) => line.replace(/\r$/, ""));
    const matched = await matchLines(fileLines);
    for (const i of matched) {
      if (maxResults > 0 && scan.count >= maxResults) {
        scan.truncated = true;
        break;
      }
      const out = `${file.path}:${i + 1}:${fileLines[i]}`;
      if (bytesUsed + out.length > maxGrepOutputBytes) {
        scan.truncated = true;
        break;
      }
      scan.lines.push(out);
      bytesUsed += out.length;
      scan.count++;
    }
    if (scan.truncated) break;
  }
  return scan;
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
    const info = nodeRuntime.lstatSync(root);
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
    const entries: DirEntry[] = [];
    for await (const entry of nodeRuntime.readDir(dir)) {
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
