//
// Inserts content at one structural position in a text file. The in-memory path
// mirrors Go byte-for-byte; files larger than `insertInMemoryLimit` use the
// streaming path (`Deno.FsFile` seek/read plus a temp-file rename). Go's
// `utf8.Valid` maps to `TextDecoder({fatal:true})` and `io` copy loops map to
// `readSync`/`writeSync`.

import * as path from "../compat/path.ts";
import {
  buildFileDiff,
  formatFileDiffSummary,
  writeFileAtomicWithMode,
} from "./io_helpers.ts";
import {
  createInsertToolResult,
  type InsertResult,
  type Registry,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./tool.ts";

const insertInMemoryLimit = 32 * 1024 * 1024;

interface InsertPosition {
  type: string;
  line: number;
}

interface InsertDedupe {
  enabled: boolean;
  mode: string;
}

interface LineRange {
  number: number;
  start: number;
  end: number;
}

/** Inserts content at one structural position in a text file. */
export class InsertTool implements Tool {
  #registry: Registry;

  constructor(r: Registry) {
    this.#registry = r;
  }

  name(): string {
    return "insert";
  }

  description(): string {
    return "Insert content into an existing UTF-8 text file at the beginning, end, before a line, or after a line. Only inserts at one structural position; use edit for exact text replacement or deletion and write for whole-file creation or overwrite.";
  }

  promptSnippet(): string {
    return "Insert content at a structural file position";
  }

  promptGuidelines(): string[] {
    return [
      "Use insert only for one insertion at the file head, tail, before a 1-based line, or after a 1-based line",
      "Use edit for exact text replacements, deletions, or text-matched insertions",
      "Use write for creating or completely rewriting a file",
    ];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        position: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["head", "tail", "before_line", "after_line"],
            },
            line: { type: "integer", minimum: 1 },
          },
          required: ["type"],
        },
        create_if_missing: { type: "boolean", default: false },
        ensure_newline: { type: "boolean", default: true },
        dedupe: {
          type: "object",
          properties: {
            enabled: { type: "boolean", default: false },
            mode: {
              type: "string",
              enum: ["exact", "trimmed", "line"],
              default: "exact",
            },
          },
        },
        dry_run: { type: "boolean", default: false },
      },
      required: ["path", "content", "position"],
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
    const content = params["content"];
    if (typeof content !== "string" || content === "") {
      throw new Error("content is required and must not be empty");
    }
    if (!isValidUTF8(content)) {
      throw new Error("content is not valid UTF-8");
    }
    const position = parseInsertPosition(params["position"]);
    const createIfMissing = boolParam(params, "create_if_missing", false);
    const ensureNewline = boolParam(params, "ensure_newline", true);
    if (
      createIfMissing && position.type !== "head" && position.type !== "tail"
    ) {
      throw new Error("create_if_missing only supports head or tail");
    }
    const dedupe = parseInsertDedupe(params["dedupe"]);
    const dryRun = boolParam(params, "dry_run", false);
    for (const key of ["match", "match_mode", "occurrence"]) {
      if (Object.prototype.hasOwnProperty.call(params, key)) {
        throw new Error(
          `${key} is not supported; use edit for text-matched insertion`,
        );
      }
    }

    let p: string;
    try {
      p = this.#registry.resolvePath(pathParam);
    } catch (err) {
      throw new Error(`invalid path: ${messageOf(err)}`);
    }

    const release = await this.#registry.acquireFileLock(ctx, p, this.name());
    try {
      let infoBefore: Deno.FileInfo | null = null;
      try {
        infoBefore = Deno.statSync(p);
      } catch {
        infoBefore = null;
      }
      if (
        infoBefore !== null && infoBefore.isFile &&
        infoBefore.size > insertInMemoryLimit
      ) {
        return this.#executeLargeInsert(
          ctx,
          p,
          content,
          position,
          createIfMissing,
          ensureNewline,
          dedupe,
          dryRun,
          infoBefore,
        );
      }

      let data: Uint8Array | null = null;
      let info: Deno.FileInfo | null = null;
      try {
        data = Deno.readFileSync(p);
        info = Deno.statSync(p);
        if (!info.isFile) {
          throw new Error(`path is not a regular file: ${p}`);
        }
        if (!isValidUTF8Bytes(data)) {
          throw new Error(`file is not valid UTF-8: ${p}`);
        }
        if (data.includes(0)) {
          throw new Error(`refusing to modify binary file: ${p}`);
        }
      } catch (err) {
        if (!isNotFound(err) || !createIfMissing) {
          throw new Error(`read file: ${messageOf(err)}`);
        }
        data = null;
        info = null;
      }
      const existing = data ?? new Uint8Array(0);

      let contentStr = content;
      if (dedupe.enabled) {
        const { content: c, matched } = applyInsertDedupe(
          decode(existing),
          contentStr,
          dedupe.mode,
        );
        contentStr = c;
        if (matched && contentStr === "") {
          const result: InsertResult = {
            path: p,
            changed: false,
            dryRun: false,
            insertedBytes: 0,
            position: position.type,
            line: position.line,
            offset: 0,
            deduped: true,
          };
          return createInsertToolResult(
            `Content already exists; no changes made to ${p}`,
            null,
            result,
          );
        }
      }

      const offset = computeInsertOffset(existing, position);
      const inserted = normalizeInsertContent(
        existing,
        offset,
        new TextEncoder().encode(contentStr),
        position.type,
        ensureNewline,
      );
      const newData = new Uint8Array(existing.length + inserted.length);
      newData.set(existing.subarray(0, offset), 0);
      newData.set(inserted, offset);
      newData.set(existing.subarray(offset), offset + inserted.length);

      const diff = buildFileDiff(
        p,
        decode(existing),
        decode(newData),
      );
      const result: InsertResult = {
        path: p,
        changed: true,
        dryRun,
        insertedBytes: inserted.length,
        position: position.type,
        line: position.line,
        offset,
        deduped: false,
      };
      if (dryRun) {
        return createInsertToolResult(
          `Would insert ${inserted.length} bytes into ${p}\n${
            formatFileDiffSummary(diff)
          }`,
          diff,
          result,
        );
      }

      let mode = 0o644;
      if (info !== null) {
        const currentInfo = Deno.statSync(p);
        const currentData = Deno.readFileSync(p);
        if (
          !bytesEqual(currentData, existing) ||
          (currentInfo.mode ?? 0) !== (info.mode ?? 0)
        ) {
          throw new Error(`concurrent modification detected: ${p}`);
        }
        mode = (info.mode ?? 0) & 0o777;
      }
      try {
        writeFileAtomicWithMode(p, newData, mode);
      } catch (err) {
        throw new Error(`atomic write failed: ${messageOf(err)}`);
      }
      return createInsertToolResult(
        `Inserted ${inserted.length} bytes into ${p}\n${
          formatFileDiffSummary(diff)
        }`,
        diff,
        result,
      );
    } finally {
      release();
    }
  }

  #executeLargeInsert(
    ctx: ToolContext,
    p: string,
    content: string,
    position: InsertPosition,
    create: boolean,
    ensure: boolean,
    d: InsertDedupe,
    dry: boolean,
    info: Deno.FileInfo,
  ): ToolResult {
    if (create) {
      throw new Error("large-file create_if_missing is not supported");
    }
    if (d.enabled) {
      throw new Error(
        `dedupe is not supported for files larger than ${insertInMemoryLimit} bytes`,
      );
    }
    if (ctx.signal?.aborted) {
      throw new Error("operation aborted");
    }

    const file = Deno.openSync(p, { read: true });
    try {
      validateLargeText(file, info.size);
      const off = scanLargeInsertOffset(file, position, info.size);
      let before = 0;
      if (off > 0) {
        file.seekSync(off - 1, Deno.SeekMode.Start);
        const buf = new Uint8Array(1);
        file.readSync(buf);
        before = buf[0];
      }
      const inserted = normalizeLargeInsertContent(
        new TextEncoder().encode(content),
        before,
        off,
        info.size,
        position.type,
        ensure,
      );
      const result: InsertResult = {
        path: p,
        changed: true,
        dryRun: dry,
        insertedBytes: inserted.length,
        position: position.type,
        line: position.line,
        offset: off,
        deduped: false,
      };
      if (dry) {
        return createInsertToolResult(
          `Would insert ${inserted.length} bytes into ${p} (large file; diff omitted)`,
          null,
          result,
        );
      }
      try {
        streamAtomicInsert(p, file, off, inserted, (info.mode ?? 0) & 0o777);
      } catch (err) {
        throw new Error(`atomic write failed: ${messageOf(err)}`);
      }
      return createInsertToolResult(
        `Inserted ${inserted.length} bytes into ${p} (large file; diff omitted)`,
        null,
        result,
      );
    } finally {
      file.close();
    }
  }
}

function isValidUTF8(s: string): boolean {
  // JS strings are valid Unicode; surrogate-only sequences would fail encoding.
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isValidUTF8Bytes(data: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

function decode(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function boolParam(
  params: Record<string, unknown>,
  name: string,
  def: boolean,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(params, name)) return def;
  const v = params[name];
  if (typeof v !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return v;
}

function parseInsertPosition(raw: unknown): InsertPosition {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("position is required and must be an object");
  }
  const m = raw as Record<string, unknown>;
  for (const key of Object.keys(m)) {
    if (key !== "type" && key !== "line") {
      throw new Error(`unsupported position field: ${key}`);
    }
  }
  const typ = typeof m["type"] === "string" ? m["type"] as string : "";
  if (
    typ !== "head" && typ !== "tail" && typ !== "before_line" &&
    typ !== "after_line"
  ) {
    throw new Error(`invalid position type: ${typ}`);
  }
  const has = Object.prototype.hasOwnProperty.call(m, "line");
  if (typ === "head" || typ === "tail") {
    if (has) {
      throw new Error(`line is not allowed for position type ${typ}`);
    }
    return { type: typ, line: 0 };
  }
  if (!has) {
    throw new Error(`line is required for position type ${typ}`);
  }
  const n = integerParam(m["line"]);
  if (n === null || n < 1) {
    throw new Error("line must be an integer greater than or equal to 1");
  }
  return { type: typ, line: n };
}

function integerParam(v: unknown): number | null {
  if (typeof v === "number") {
    return Number.isInteger(v) ? v : null;
  }
  return null;
}

function parseInsertDedupe(raw: unknown): InsertDedupe {
  if (raw === null || raw === undefined) {
    return { enabled: false, mode: "exact" };
  }
  if (typeof raw !== "object") {
    throw new Error("dedupe must be an object");
  }
  const m = raw as Record<string, unknown>;
  for (const key of Object.keys(m)) {
    if (key !== "enabled" && key !== "mode") {
      throw new Error(`unsupported dedupe field: ${key}`);
    }
  }
  let enabled = false;
  if (Object.prototype.hasOwnProperty.call(m, "enabled")) {
    if (typeof m["enabled"] !== "boolean") {
      throw new Error("dedupe.enabled must be a boolean");
    }
    enabled = m["enabled"];
  }
  let mode = typeof m["mode"] === "string" ? m["mode"] as string : "";
  if (mode === "") mode = "exact";
  if (mode !== "exact" && mode !== "trimmed" && mode !== "line") {
    throw new Error(`invalid dedupe mode: ${mode}`);
  }
  return { enabled, mode };
}

function buildInsertLineIndex(data: Uint8Array): LineRange[] {
  if (data.length === 0) return [];
  const lines: LineRange[] = [];
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0a) {
      lines.push({ number: lines.length + 1, start, end: i + 1 });
      start = i + 1;
    }
  }
  if (start < data.length) {
    lines.push({ number: lines.length + 1, start, end: data.length });
  }
  return lines;
}

function computeInsertOffset(data: Uint8Array, p: InsertPosition): number {
  switch (p.type) {
    case "head":
      return 0;
    case "tail":
      return data.length;
    case "before_line":
    case "after_line": {
      const lines = buildInsertLineIndex(data);
      if (p.line < 1 || p.line > lines.length) {
        throw new Error(
          `line ${p.line} out of range; file has ${lines.length} lines`,
        );
      }
      if (p.type === "before_line") return lines[p.line - 1].start;
      return lines[p.line - 1].end;
    }
    default:
      throw new Error(`invalid position type: ${p.type}`);
  }
}

function normalizeInsertContent(
  data: Uint8Array,
  offset: number,
  content: Uint8Array,
  typ: string,
  ensure: boolean,
): Uint8Array {
  if (!ensure) return content;
  let r: Uint8Array = content.slice();
  const has = r.length > 0 && r[r.length - 1] === 0x0a;
  switch (typ) {
    case "head":
    case "before_line":
      if (data.length > 0 && !has) {
        r = concat(r, new Uint8Array([0x0a]));
      }
      break;
    case "tail":
      if (offset > 0 && data[offset - 1] !== 0x0a) {
        r = concat(new Uint8Array([0x0a]), r);
      }
      break;
    case "after_line":
      if (offset > 0 && data[offset - 1] !== 0x0a) {
        r = concat(new Uint8Array([0x0a]), r);
      }
      if (!has) {
        r = concat(r, new Uint8Array([0x0a]));
      }
      break;
  }
  return r;
}

function applyInsertDedupe(
  existing: string,
  content: string,
  mode: string,
): { content: string; matched: boolean } {
  switch (mode) {
    case "trimmed":
      if (existing.trim().includes(content.trim())) {
        return { content: "", matched: true };
      }
      break;
    case "line": {
      const set = new Set<string>();
      for (const l of stripTrailingNewline(existing).split("\n")) {
        if (l !== "") set.add(l.trim());
      }
      const missing: string[] = [];
      for (const l of stripTrailingNewline(content).split("\n")) {
        if (l === "" || !set.has(l.trim())) missing.push(l);
      }
      if (missing.length === 0) return { content: "", matched: true };
      return { content: missing.join("\n"), matched: false };
    }
    default:
      if (existing.includes(content)) return { content: "", matched: true };
  }
  return { content, matched: false };
}

function stripTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function validateLargeText(file: Deno.FsFile, size: number): void {
  file.seekSync(0, Deno.SeekMode.Start);
  const chunk = new Uint8Array(128 * 1024);
  let read = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (read < size) {
    const n = file.readSync(chunk);
    if (n === null || n === 0) break;
    read += n;
    const slice = chunk.subarray(0, n);
    if (slice.includes(0)) {
      throw new Error("refusing to modify binary file");
    }
    try {
      decoder.decode(slice, { stream: true });
    } catch {
      throw new Error("file is not valid UTF-8");
    }
  }
  try {
    decoder.decode();
  } catch {
    throw new Error("file is not valid UTF-8");
  }
}

function scanLargeInsertOffset(
  file: Deno.FsFile,
  p: InsertPosition,
  size: number,
): number {
  if (p.type === "head") return 0;
  if (p.type === "tail") return size;

  file.seekSync(0, Deno.SeekMode.Start);
  const chunk = new Uint8Array(128 * 1024);
  let off = 0;
  let line = 1;
  for (;;) {
    const n = file.readSync(chunk);
    if (n === null || n === 0) break;
    const slice = chunk.subarray(0, n);
    let idx = 0;
    while (idx < slice.length) {
      const nl = slice.indexOf(0x0a, idx);
      if (nl === -1) {
        off += slice.length - idx;
        break;
      }
      const end = off + (nl - idx) + 1;
      if (line === p.line) {
        if (p.type === "before_line") return off;
        return end;
      }
      off = end;
      line++;
      idx = nl + 1;
    }
  }
  throw new Error(`line ${p.line} out of range; file has ${line} lines`);
}

function normalizeLargeInsertContent(
  c: Uint8Array,
  b: number,
  off: number,
  size: number,
  typ: string,
  ensure: boolean,
): Uint8Array {
  if (!ensure) return c;
  let r: Uint8Array = c.slice();
  const endsNl = r.length > 0 && r[r.length - 1] === 0x0a;
  if ((typ === "head" || typ === "before_line") && size > 0 && !endsNl) {
    r = concat(r, new Uint8Array([0x0a]));
  }
  if ((typ === "tail" || typ === "after_line") && off > 0 && b !== 0x0a) {
    r = concat(new Uint8Array([0x0a]), r);
  }
  if (typ === "after_line" && (r.length === 0 || r[r.length - 1] !== 0x0a)) {
    r = concat(r, new Uint8Array([0x0a]));
  }
  return r;
}

function streamAtomicInsert(
  p: string,
  src: Deno.FsFile,
  off: number,
  inserted: Uint8Array,
  mode: number,
): void {
  const dir = path.dirname(p);
  const tmpPath = Deno.makeTempFileSync({ dir, prefix: ".opensac-insert-" });
  let tmp: Deno.FsFile | null = null;
  try {
    tmp = Deno.openSync(tmpPath, { write: true, create: true, truncate: true });
    Deno.chmodSync(tmpPath, mode & 0o777);

    src.seekSync(0, Deno.SeekMode.Start);
    copyN(src, tmp, off);
    tmp.writeSync(inserted);
    src.seekSync(off, Deno.SeekMode.Start);
    copyAll(src, tmp);
    tmp.syncSync();
    tmp.close();
    tmp = null;
    Deno.renameSync(tmpPath, p);
  } catch (err) {
    if (tmp !== null) {
      try {
        tmp.close();
      } catch {
        // ignore
      }
    }
    try {
      Deno.removeSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

function copyN(src: Deno.FsFile, dst: Deno.FsFile, count: number): void {
  let remaining = count;
  const buf = new Uint8Array(128 * 1024);
  while (remaining > 0) {
    const want = Math.min(remaining, buf.length);
    const n = src.readSync(buf.subarray(0, want));
    if (n === null || n === 0) break;
    dst.writeSync(buf.subarray(0, n));
    remaining -= n;
  }
}

function copyAll(src: Deno.FsFile, dst: Deno.FsFile): void {
  const buf = new Uint8Array(128 * 1024);
  for (;;) {
    const n = src.readSync(buf);
    if (n === null || n === 0) break;
    dst.writeSync(buf.subarray(0, n));
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof Deno.errors.NotFound;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
