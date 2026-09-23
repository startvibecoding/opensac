import { createFrontmatter, type Frontmatter } from "./expert.ts";

/** Opens and closes a frontmatter block. */
const frontmatterDelimiter = "---";

/**
 * Splits a persona markdown file into its frontmatter fields and the trimmed
 * body prompt. fallbackName (typically the md file name without extension) is
 * used when the frontmatter is absent or omits name. An error is reported only
 * for unparsable frontmatter: an unclosed block or an invalid integer field.
 *
 * Supported syntax (minimal, hand-written; the repo intentionally has no YAML
 * dependency):
 *   - file starting with a "---" line, closed by the next "---" line;
 *   - "key: value" with optional single/double quotes (quotes are stripped);
 *   - inline lists "key: [a, b, \"c d\"]" and block lists "key:" followed by
 *     "- item" lines;
 *   - "#" comment lines and unknown keys are ignored; CJK values are kept
 *     verbatim; keys match case-insensitively.
 */
export function parseFrontmatter(
  content: string,
  fallbackName: string,
): { frontmatter: Frontmatter; prompt: string } {
  const lines = splitLines(content);
  if (lines.length === 0 || lines[0].trim() !== frontmatterDelimiter) {
    // No frontmatter: the whole file is the prompt.
    return {
      frontmatter: createFrontmatter(fallbackName),
      prompt: lines.join("\n").trim(),
    };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === frontmatterDelimiter) {
      end = i;
      break;
    }
  }
  if (end < 0) {
    throw new Error(
      "unclosed frontmatter: missing terminating --- line",
    );
  }
  const fm = createFrontmatter(fallbackName);
  parseFrontmatterFields(lines.slice(1, end), fm);
  if (fm.name.trim() === "") {
    fm.name = fallbackName;
  }
  const prompt = lines.slice(end + 1).join("\n").trim();
  return { frontmatter: fm, prompt };
}

/** Splits content on \n and trims \r so CRLF files parse identically. */
export function splitLines(content: string): string[] {
  return content.split("\n").map((line) =>
    line.endsWith("\r") ? line.slice(0, -1) : line
  );
}

/**
 * Applies "key: value" lines to fm. Unknown keys and malformed lines are
 * ignored except for invalid integer fields, which are reported as errors.
 */
export function parseFrontmatterFields(
  lines: string[],
  fm: Frontmatter,
): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const cut = line.indexOf(":");
    if (cut < 0) {
      continue;
    }
    const key = line.slice(0, cut).trim().toLowerCase();
    const value = line.slice(cut + 1).trim();
    if (value === "") {
      // Possible block list: consume subsequent "- item" lines.
      const { items, next } = collectBlockList(lines, i + 1);
      i = next - 1;
      if (key === "tools" && items.length > 0) {
        fm.tools.push(...items);
      }
      continue;
    }
    switch (key) {
      case "name":
        fm.name = unquote(value);
        break;
      case "description":
        fm.description = unquote(value);
        break;
      case "role":
        fm.role = unquote(value);
        break;
      case "emoji":
        fm.emoji = unquote(value);
        break;
      case "color":
        fm.color = unquote(value);
        break;
      case "vibe":
        fm.vibe = unquote(value);
        break;
      case "mode":
        fm.mode = unquote(value);
        break;
      case "work_dir":
        fm.workDir = unquote(value);
        break;
      case "tools":
        fm.tools = parseInlineList(value);
        break;
      case "max_iterations": {
        const raw = unquote(value);
        if (!/^[+-]?\d+$/.test(raw)) {
          throw new Error(`invalid max_iterations ${value}`);
        }
        fm.maxIterations = Number(raw);
        break;
      }
      default:
        // Unknown keys are ignored.
        break;
    }
  }
}

/**
 * Consumes "- item" lines starting at index start and returns the unquoted
 * items plus the index of the first non-item line.
 */
export function collectBlockList(
  lines: string[],
  start: number,
): { items: string[]; next: number } {
  const items: string[] = [];
  let i = start;
  for (; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("-")) {
      break;
    }
    const item = unquote(trimmed.slice(1).trim());
    if (item !== "") {
      items.push(item);
    }
  }
  return { items, next: i };
}

/**
 * Parses "[a, b, \"c d\"]" (quote-aware comma splitting) and tolerates a bare
 * scalar value as a single-item list.
 */
export function parseInlineList(value: string): string[] {
  value = value.trim();
  if (value === "") {
    return [];
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    value = value.slice(1, -1);
  }
  const parts: string[] = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote !== "") {
      cur += ch;
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  const items: string[] = [];
  for (const part of parts) {
    const item = unquote(part.trim());
    if (item !== "") items.push(item);
  }
  if (items.length === 0) return [];
  return items;
}

/** Strips one layer of matching single or double quotes. */
export function unquote(s: string): string {
  s = s.trim();
  if (s.length >= 2) {
    if (
      (s[0] === '"' && s[s.length - 1] === '"') ||
      (s[0] === "'" && s[s.length - 1] === "'")
    ) {
      return s.slice(1, -1);
    }
  }
  return s;
}
