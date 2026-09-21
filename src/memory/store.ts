// Ported from internal/memory/store.go
//
// Package memory implements persistent memory storage for serve channels.
// Memory is stored as a human-readable Markdown file (memory.md).

import * as path from "@std/path";
import { configDir, projectPath, projectPathFor } from "../config/mod.ts";

/** The initial content for a new memory.md file. */
export const defaultTemplate = `# Agent Memory

## User Profile

## Working Memory

## Lessons Learned
`;

function isNotExist(err: unknown): boolean {
  return err instanceof Deno.errors.NotFound;
}

function statExists(p: string): boolean {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function trimRightNewlines(s: string): string {
  return s.replace(/\n+$/, "");
}

/** Manages reading and writing of memory.md files. */
export class Store {
  // explicitPath overrides auto-discovery when set via config.
  #explicitPath: string;
  // workDir is the project working directory, used as fallback for the default
  // write path.
  #workDir: string;

  /**
   * Creates a memory store. If explicitPath is non-empty, it overrides the
   * default discovery logic. workDir is used as the fallback directory for
   * creating new memory files.
   */
  constructor(explicitPath: string, workDir: string) {
    this.#explicitPath = explicitPath;
    this.#workDir = workDir;
  }

  /**
   * Finds the memory.md file to use. Priority: explicit path →
   * .opensac/memory.md → <GLOBAL_DIR>/memory.md. Returns the path and source,
   * where source is "explicit", "project", "global", or "".
   */
  resolve(): { path: string; source: string } {
    return this.#resolveNoLock();
  }

  #resolveNoLock(): { path: string; source: string } {
    // 1. Explicit path from config
    if (this.#explicitPath !== "") {
      // For an explicit path, existence does not matter: it will be created
      // here on write.
      return { path: this.#explicitPath, source: "explicit" };
    }

    // 2. Project-level: .opensac/memory.md
    let projectPathValue = projectPath("memory.md");
    if (this.#workDir !== "") {
      projectPathValue = projectPathFor(this.#workDir, "memory.md");
    }
    if (statExists(projectPathValue)) {
      return { path: projectPathValue, source: "project" };
    }

    // 3. Global: <GLOBAL_DIR>/memory.md
    const globalPath = path.join(configDir(), "memory.md");
    if (statExists(globalPath)) {
      return { path: globalPath, source: "global" };
    }

    // None exists — will be created on first write.
    return { path: "", source: "" };
  }

  /** Returns the full content of memory.md. */
  read(): { content: string; path: string; source: string } {
    return this.#readNoLock();
  }

  #readNoLock(): { content: string; path: string; source: string } {
    const { path: p, source } = this.#resolveNoLock();
    if (p === "") {
      return { content: "", path: "", source: "" }; // no memory file exists
    }

    let data: string;
    try {
      data = Deno.readTextFileSync(p);
    } catch (err) {
      if (isNotExist(err)) {
        return { content: "", path: p, source };
      }
      throw new Error(`read memory file: ${(err as Error).message}`);
    }

    return { content: data, path: p, source };
  }

  /** Returns the content of a specific ## section. */
  readSection(section: string): string {
    const { content } = this.#readNoLock();
    if (content === "") {
      return "";
    }
    return extractSection(content, section);
  }

  /** Appends a line to a specific section. */
  add(section: string, entry: string): void {
    const { content: current, path: p } = this.#readNoLock();

    let content = current;
    let target = p;
    if (target === "") {
      // Create new file
      target = this.#defaultWritePath();
      content = defaultTemplate;
    }

    const updated = addToSection(content, section, entry);
    this.#writeFile(target, updated);
  }

  /** Replaces old text with new text in a section. */
  update(section: string, oldText: string, newText: string): void {
    const { content, path: p } = this.#readNoLock();
    if (p === "" || content === "") {
      throw new Error("no memory file to update");
    }

    const sectionContent = extractSection(content, section);
    if (sectionContent === "") {
      throw new Error(`section '${section}' not found`);
    }

    if (!sectionContent.includes(oldText)) {
      throw new Error(`text not found in section '${section}'`);
    }

    const replaced = replaceInSection(content, section, oldText, newText);
    if (!replaced.ok) {
      throw new Error(`text not found in section '${section}'`);
    }
    this.#writeFile(p, replaced.content);
  }

  /** Removes a line from a section. */
  delete(section: string, entry: string): void {
    const { content, path: p } = this.#readNoLock();
    if (p === "" || content === "") {
      throw new Error("no memory file to delete from");
    }

    const result = deleteFromSection(content, section, entry);
    if (!result.found) {
      throw new Error(`entry not found in section '${section}'`);
    }

    this.#writeFile(p, result.content);
  }

  /** Overwrites the entire memory.md content. */
  writeAll(content: string): void {
    const { path: p } = this.#readNoLock();
    let target = p;
    if (target === "") {
      target = this.#defaultWritePath();
    }
    this.#writeFile(target, content);
  }

  /**
   * Determines where to create a new memory.md. Default: project-level
   * (.opensac/memory.md). Only uses global if explicitly configured.
   */
  #defaultWritePath(): string {
    if (this.#explicitPath !== "") {
      return this.#explicitPath;
    }
    // Default to project-level: workDir/.opensac/memory.md
    if (this.#workDir !== "") {
      return projectPathFor(this.#workDir, "memory.md");
    }
    // Fallback: cwd/.opensac/memory.md
    return projectPath("memory.md");
  }

  /** Writes content to path, creating parent dirs as needed. */
  #writeFile(p: string, content: string): void {
    Deno.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    Deno.writeTextFileSync(p, content, { mode: 0o600 });
  }
}

export function replaceInSection(
  content: string,
  section: string,
  oldText: string,
  newText: string,
): { content: string; ok: boolean } {
  const bounds = sectionBounds(content, section);
  if (!bounds.ok) {
    return { content, ok: false };
  }
  const { start, end } = bounds;
  let segment = content.slice(start, end);
  if (!segment.includes(oldText)) {
    return { content, ok: false };
  }
  segment = segment.replace(oldText, newText); // replace first occurrence
  return {
    content: content.slice(0, start) + segment + content.slice(end),
    ok: true,
  };
}

export function deleteFromSection(
  content: string,
  section: string,
  entry: string,
): { content: string; found: boolean } {
  const bounds = sectionBounds(content, section);
  if (!bounds.ok) {
    return { content, found: false };
  }
  const { start, end } = bounds;
  const segment = content.slice(start, end);
  const lines = segment.split("\n");
  const result: string[] = [];
  let found = false;
  const cleanEntry = trimPrefix(entry.trim(), "- ");
  for (const line of lines) {
    const trimmed = line.trim();
    // Match "- entry" or "entry" (with or without bullet).
    const cleanLine = trimPrefix(trimmed, "- ");
    if (cleanLine === cleanEntry && !found) {
      found = true;
      continue; // skip this line
    }
    result.push(line);
  }
  if (!found) {
    return { content, found: false };
  }
  return {
    content: content.slice(0, start) + result.join("\n") + content.slice(end),
    found: true,
  };
}

function trimPrefix(s: string, prefix: string): string {
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

export function sectionBounds(
  content: string,
  section: string,
): { start: number; end: number; ok: boolean } {
  const header = "## " + section;
  const idx = content.indexOf(header);
  if (idx < 0) {
    return { start: 0, end: 0, ok: false };
  }
  const afterHeader = content.slice(idx + header.length);
  const nlIdx = afterHeader.indexOf("\n");
  if (nlIdx < 0) {
    return { start: content.length, end: content.length, ok: true };
  }
  const start = idx + header.length + nlIdx + 1;
  const rest = content.slice(start);
  const nextSection = rest.indexOf("\n## ");
  if (nextSection >= 0) {
    return { start, end: start + nextSection, ok: true };
  }
  return { start, end: content.length, ok: true };
}

/** Extracts content under a ## heading. */
export function extractSection(content: string, section: string): string {
  const header = "## " + section;
  const idx = content.indexOf(header);
  if (idx < 0) {
    return "";
  }

  // Find the start of content after the header line.
  let afterHeader = content.slice(idx + header.length);
  const nlIdx = afterHeader.indexOf("\n");
  if (nlIdx < 0) {
    return "";
  }
  afterHeader = afterHeader.slice(nlIdx + 1);

  // Find the next ## heading or end of file.
  const nextSection = afterHeader.indexOf("\n## ");
  if (nextSection >= 0) {
    afterHeader = afterHeader.slice(0, nextSection);
  }

  return afterHeader.trim();
}

/** Appends an entry to a section. Creates the section if missing. */
export function addToSection(
  content: string,
  section: string,
  entry: string,
): string {
  const header = "## " + section;

  // Ensure the entry has a bullet prefix.
  let trimmedEntry = entry.trim();
  if (!trimmedEntry.startsWith("- ")) {
    trimmedEntry = "- " + trimmedEntry;
  }

  const idx = content.indexOf(header);
  if (idx < 0) {
    // Section doesn't exist — append at end.
    return trimRightNewlines(content) + "\n\n" + header + "\n\n" +
      trimmedEntry + "\n";
  }

  // Find the end of this section (next ## or EOF).
  const afterHeader = content.slice(idx + header.length);
  const nlIdx = afterHeader.indexOf("\n");
  if (nlIdx < 0) {
    return content + "\n\n" + trimmedEntry + "\n";
  }

  const sectionStart = idx + header.length + nlIdx + 1;
  const rest = content.slice(sectionStart);

  const nextSection = rest.indexOf("\n## ");
  if (nextSection >= 0) {
    // Insert before the next section.
    const insertPoint = sectionStart + nextSection;
    return content.slice(0, insertPoint) + trimmedEntry + "\n" +
      content.slice(insertPoint);
  }

  // Append at end.
  return trimRightNewlines(content) + "\n" + trimmedEntry + "\n";
}
