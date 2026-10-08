// (the file-diff and atomic-write helpers).
//
// These helpers are shared by the write/edit/insert tools. Go's `os.FileMode`
// maps to Deno's Unix `mode`; the atomic writes use a temp file in the target
// directory plus a rename, preserving the existing permissions.

import * as path from "@opensac/path";

/** Writes data to `p` atomically using a temp file and rename. */
export function writeFileAtomic(p: string, data: Uint8Array): void {
  let perm = 0o644;
  try {
    const info = Deno.statSync(p);
    if (info.mode !== null) perm = info.mode & 0o777;
  } catch {
    // new file
  }

  const dir = path.dirname(p);
  Deno.mkdirSync(dir, { recursive: true });

  const tmpPath = Deno.makeTempFileSync({ dir, prefix: ".tmp-" });
  try {
    Deno.writeFileSync(tmpPath, data, { mode: perm });
    Deno.chmodSync(tmpPath, perm);
    Deno.renameSync(tmpPath, p);
  } catch (err) {
    try {
      Deno.removeSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

/** Writes data to `p` atomically, forcing the given permission bits. */
export function writeFileAtomicWithMode(
  p: string,
  data: Uint8Array,
  mode: number,
): void {
  const dir = path.dirname(p);
  Deno.mkdirSync(dir, { recursive: true });
  const tmpPath = Deno.makeTempFileSync({ dir, prefix: ".opensac-insert-" });
  try {
    Deno.chmodSync(tmpPath, mode & 0o777);
    Deno.writeFileSync(tmpPath, data);
    Deno.renameSync(tmpPath, p);
  } catch (err) {
    try {
      Deno.removeSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

/** Describes a file change produced by a write-like tool. */
export interface FileDiff {
  path: string;
  added: number;
  deleted: number;
  addedLines: number[];
  deletedLines: number[];
  unified: string;
  /**
   * Complete old/new file contents for projections that need a semantic diff.
   * `oldText` is null when the write created a previously absent file.
   */
  oldText: string | null;
  newText: string;
  truncated: boolean;
}

/** Returns a compact, structured line diff for display and audit. */
export function buildFileDiff(
  p: string,
  oldContent: string,
  newContent: string,
): FileDiff {
  const oldLines = splitDiffLines(oldContent);
  const newLines = splitDiffLines(newContent);
  const { deleted, added } = diffLineChanges(oldLines, newLines);
  const truncated = oldLines.length * newLines.length > 200000;
  return {
    path: p,
    added: added.length,
    deleted: deleted.length,
    addedLines: added,
    deletedLines: deleted,
    unified: formatUnifiedDiff(
      p,
      oldLines,
      newLines,
      deleted,
      added,
      truncated,
    ),
    oldText: oldContent,
    newText: newContent,
    truncated,
  };
}

export function formatFileDiffSummary(
  diff: FileDiff | null | undefined,
): string {
  if (!diff) {
    return "Diff: +0 -0\n- lines: none\n+ lines: none";
  }
  const suffix = diff.truncated ? " (large file; line ranges approximate)" : "";
  return `Diff: +${diff.added} -${diff.deleted}${suffix}\n- lines: ${
    formatLineRanges(diff.deletedLines)
  }\n+ lines: ${formatLineRanges(diff.addedLines)}`;
}

export function formatWriteDiffSummary(
  oldContent: string,
  newContent: string,
): string {
  return formatFileDiffSummary(buildFileDiff("", oldContent, newContent));
}

function splitDiffLines(content: string): string[] {
  if (content === "") return [];
  const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
  return trimmed.split("\n");
}

function diffLineChanges(
  oldLines: string[],
  newLines: string[],
): { deleted: number[]; added: number[] } {
  if (oldLines.length === 0 && newLines.length === 0) {
    return { deleted: [], added: [] };
  }
  if (oldLines.length * newLines.length > 200000) {
    return {
      deleted: allLineNumbers(oldLines.length),
      added: allLineNumbers(newLines.length),
    };
  }

  const lcs: number[][] = [];
  for (let i = 0; i <= oldLines.length; i++) {
    lcs.push(new Array<number>(newLines.length + 1).fill(0));
  }
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        lcs[i][j] = lcs[i + 1][j];
      } else {
        lcs[i][j] = lcs[i][j + 1];
      }
    }
  }

  const deleted: number[] = [];
  const added: number[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      deleted.push(i + 1);
      i++;
    } else {
      added.push(j + 1);
      j++;
    }
  }
  for (; i < oldLines.length; i++) deleted.push(i + 1);
  for (; j < newLines.length; j++) added.push(j + 1);
  return { deleted, added };
}

interface DiffRecord {
  kind: string;
  text: string;
  oldLine: number;
  newLine: number;
}

interface DiffHunk {
  start: number;
  end: number;
}

function formatUnifiedDiff(
  p: string,
  oldLines: string[],
  newLines: string[],
  deleted: number[],
  added: number[],
  truncated: boolean,
): string {
  let oldPath = p;
  let newPath = p;
  if (oldPath === "") {
    oldPath = "old";
    newPath = "new";
  }
  let sb = `--- ${oldPath}\n+++ ${newPath}\n`;
  if (truncated) {
    sb += "@@ large file diff omitted @@\n";
    sb += `-${formatLineRanges(deleted)}\n`;
    sb += `+${formatLineRanges(added)}\n`;
    return sb;
  }
  if (deleted.length === 0 && added.length === 0) {
    return sb;
  }
  const deletedSet = lineSet(deleted);
  const addedSet = lineSet(added);
  const records = makeDiffRecords(oldLines, newLines, deletedSet, addedSet);
  for (const hunk of selectDiffHunks(records, 3)) {
    const [oldStart, oldCount, newStart, newCount] = hunkRanges(
      records.slice(hunk.start, hunk.end),
    );
    sb += `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`;
    for (const record of records.slice(hunk.start, hunk.end)) {
      sb += record.kind + record.text + "\n";
    }
  }
  return sb;
}

function makeDiffRecords(
  oldLines: string[],
  newLines: string[],
  deletedSet: Set<number>,
  addedSet: Set<number>,
): DiffRecord[] {
  const records: DiffRecord[] = [];
  let oldIdx = 1;
  let newIdx = 1;
  while (oldIdx <= oldLines.length || newIdx <= newLines.length) {
    if (oldIdx <= oldLines.length && deletedSet.has(oldIdx)) {
      records.push({
        kind: "-",
        text: oldLines[oldIdx - 1],
        oldLine: oldIdx,
        newLine: 0,
      });
      oldIdx++;
    } else if (newIdx <= newLines.length && addedSet.has(newIdx)) {
      records.push({
        kind: "+",
        text: newLines[newIdx - 1],
        oldLine: 0,
        newLine: newIdx,
      });
      newIdx++;
    } else if (oldIdx <= oldLines.length && newIdx <= newLines.length) {
      records.push({
        kind: " ",
        text: oldLines[oldIdx - 1],
        oldLine: oldIdx,
        newLine: newIdx,
      });
      oldIdx++;
      newIdx++;
    } else if (oldIdx <= oldLines.length) {
      records.push({
        kind: "-",
        text: oldLines[oldIdx - 1],
        oldLine: oldIdx,
        newLine: 0,
      });
      oldIdx++;
    } else {
      records.push({
        kind: "+",
        text: newLines[newIdx - 1],
        oldLine: 0,
        newLine: newIdx,
      });
      newIdx++;
    }
  }
  return records;
}

function selectDiffHunks(
  records: DiffRecord[],
  contextLines: number,
): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  for (let i = 0; i < records.length; i++) {
    if (records[i].kind === " ") continue;
    let start = i - contextLines;
    if (start < 0) start = 0;
    let end = i + contextLines + 1;
    if (end > records.length) end = records.length;
    if (hunks.length > 0 && start <= hunks[hunks.length - 1].end) {
      if (end > hunks[hunks.length - 1].end) hunks[hunks.length - 1].end = end;
      continue;
    }
    hunks.push({ start, end });
  }
  return hunks;
}

function hunkRanges(records: DiffRecord[]): [number, number, number, number] {
  let oldStart = 0;
  let newStart = 0;
  let oldCount = 0;
  let newCount = 0;
  for (const record of records) {
    if (record.oldLine > 0) {
      if (oldStart === 0) oldStart = record.oldLine;
      oldCount++;
    }
    if (record.newLine > 0) {
      if (newStart === 0) newStart = record.newLine;
      newCount++;
    }
  }
  if (oldStart === 0) oldStart = 1;
  if (newStart === 0) newStart = 1;
  return [oldStart, oldCount, newStart, newCount];
}

function lineSet(lines: number[]): Set<number> {
  return new Set(lines);
}

function allLineNumbers(count: number): number[] {
  const lines: number[] = [];
  for (let i = 0; i < count; i++) lines.push(i + 1);
  return lines;
}

export function formatLineRanges(lines: number[]): string {
  if (lines.length === 0) return "none";
  const ranges: string[] = [];
  let start = lines[0];
  let prev = lines[0];
  for (const line of lines.slice(1)) {
    if (line === prev + 1) {
      prev = line;
      continue;
    }
    ranges.push(formatLineRange(start, prev));
    start = line;
    prev = line;
  }
  ranges.push(formatLineRange(start, prev));
  return ranges.join(",");
}

function formatLineRange(start: number, end: number): string {
  if (start === end) return `${start}`;
  return `${start}-${end}`;
}
