import { computeIDs, newNode, Node, NodeType } from "./node.ts";

// ── Preprocessor (LaTeX) ────────────────────────────────────────────────────

const reDollarBlockMath = /^\s*\$\$([\s\S]*?)\$\$\s*$/gm;
const reDollarInline = /\$([^$\n]+?)\$/g;
const reSlashBracket = /^\s*\\\[([\s\S]*?)\\\]\s*$/gm;
const reInlineParen = /\\\([\s\S]*?\\\)/g;

const reBoxed = /\\boxed\s*\{/g;
const reDfrac = /\\dfrac/g;
const reTfrac = /\\tfrac/g;
const rePrime = /'/g;
const reOverright = /\\overrightarrow/g;
const reImplies = /\\implies/g;
const reHarpoons = /\\rightleftharpoons/g;
const reDots = /\\dots/g;
const reBracketSz = /\\(?:big|Big|bigg|Bigg)[lr]?/g;

function preprocessLaTeX(src: string): string {
  src = src.replace(reDollarBlockMath, (_m, inner: string) => {
    const code = filterLatexSyntax(inner);
    return "```blockmath\n" + code.trim() + "\n```";
  });
  src = src.replace(reSlashBracket, (_m, inner: string) => {
    const code = filterLatexSyntax(inner);
    return "```blockmath\n" + code.trim() + "\n```";
  });
  src = src.replace(reInlineParen, (m) => {
    const code = filterLatexSyntax(m);
    return "`" + code + "`";
  });
  src = src.replace(reDollarInline, (_m, inner: string) => {
    const code = filterLatexSyntax(inner);
    return "`$" + code + "$`";
  });
  return src;
}

function filterLatexSyntax(s: string): string {
  s = s.replace(reBoxed, "{");
  s = s.replace(reDfrac, "\\frac");
  s = s.replace(reTfrac, "\\frac");
  s = s.replace(rePrime, "\\prime");
  s = s.replace(reOverright, "\\vec");
  s = s.replace(reImplies, "\\Rightarrow");
  s = s.replace(reHarpoons, "\\Leftrightarrow");
  s = s.replace(reDots, "\\ldots");
  s = s.replace(reBracketSz, "");
  return s;
}

// ── Speculative Rewriting ────────────────────────────────────────────────────

const rePartialStrong = /(?:\*\*|__)\S*$/;
const rePartialItalic = /(?:\*|_)\S*$/;

function rewriteSpeculative(doc: Node): void {
  rewriteSpeculativeEmphasis(doc);
  rewriteSpeculativeTable(doc);
}

function rewriteSpeculativeEmphasis(doc: Node): void {
  const textNode = doc.rightmostDescendant();
  if (!textNode || textNode.type !== NodeType.Text) return;
  const text = textNode.text;
  if (text === "") return;

  const parent = textNode.parent;
  if (!parent) return;

  // Partial strong: **text or __text at end.
  const strong = rePartialStrong.exec(text);
  if (strong && strong.index + strong[0].length === text.length) {
    const delimLen = 2;
    const inner = text.slice(strong.index + delimLen);
    const prefix = text.slice(0, strong.index);
    const idx = textNode.indexInParent();
    if (idx < 0) return;
    const newNodes: Node[] = [];
    if (prefix !== "") {
      const pn = newNode(NodeType.Text);
      pn.text = prefix;
      newNodes.push(pn);
    }
    const sn = newNode(NodeType.Strong);
    const inn = newNode(NodeType.Text);
    inn.text = inner;
    sn.append(inn);
    newNodes.push(sn);
    parent.children = [
      ...parent.children.slice(0, idx),
      ...newNodes,
      ...parent.children.slice(idx + 1),
    ];
    for (const c of newNodes) c.parent = parent;
    return;
  }

  // Partial italic: *text or _text at end.
  const italic = rePartialItalic.exec(text);
  if (italic && italic.index + italic[0].length === text.length) {
    const delimLen = 1;
    const inner = text.slice(italic.index + delimLen);
    const prefix = text.slice(0, italic.index);
    const idx = textNode.indexInParent();
    if (idx < 0) return;
    const newNodes: Node[] = [];
    if (prefix !== "") {
      const pn = newNode(NodeType.Text);
      pn.text = prefix;
      newNodes.push(pn);
    }
    const en = newNode(NodeType.Emphasis);
    const inn = newNode(NodeType.Text);
    inn.text = inner;
    en.append(inn);
    newNodes.push(en);
    parent.children = [
      ...parent.children.slice(0, idx),
      ...newNodes,
      ...parent.children.slice(idx + 1),
    ];
    for (const c of newNodes) c.parent = parent;
  }
}

function rewriteSpeculativeTable(doc: Node): void {
  const para = findRightmostParagraph(doc);
  if (!para) return;
  const text = para.textContent();
  if (isPartialTable(text)) {
    para.children = [];
  }
}

function findRightmostParagraph(n: Node): Node | undefined {
  const leaf = n.rightmostDescendant();
  let p: Node | undefined = leaf;
  while (p) {
    if (p.type === NodeType.Paragraph) return p;
    p = p.parent;
  }
  return undefined;
}

function isPartialTable(text: string): boolean {
  const lines = text.trim().split("\n");
  if (lines.length === 0) return false;
  if (lines.length === 1) {
    const trimmed = lines[0].trim();
    return trimmed.length > 1 && trimmed[0] === "|" && !trimmed.includes("\n");
  }
  if (lines.length === 2) {
    const first = lines[0].trim();
    const second = lines[1].trim();
    if (first.length > 0 && first[0] === "|") {
      if (
        second.length > 0 &&
        (second[0] === "|" || second[0] === "-" || second[0] === ":")
      ) {
        return true;
      }
    }
  }
  return false;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Controls parsing behavior. */
export interface ParseOption {
  speculativeRewrite: boolean;
  preprocessLaTeX: boolean;
}

/** Returns sensible defaults. */
export function defaultOption(): ParseOption {
  return { speculativeRewrite: false, preprocessLaTeX: true };
}

/** Returns options suitable for streaming/incremental rendering. */
export function streamOption(): ParseOption {
  return { speculativeRewrite: true, preprocessLaTeX: true };
}

/** Parses markdown text into an AST. */
export function parse(src: string, opt: ParseOption): Node {
  if (opt.preprocessLaTeX) src = preprocessLaTeX(src);
  const lines = src.split("\n");
  const doc = parseDocument(lines);
  computeIDs(doc);
  if (opt.speculativeRewrite) rewriteSpeculative(doc);
  return doc;
}

function parseDocument(lines: string[]): Node {
  const bp = new BlockParser(lines);
  const doc = newNode(NodeType.Document);
  bp.parseBlocks(doc);
  return doc;
}

/** Removes the given characters from the right of `s`. */
function trimRightCutset(s: string, cutset: string): string {
  let i = s.length;
  while (i > 0 && cutset.includes(s[i - 1])) i--;
  return s.slice(0, i);
}

/** Removes leading space characters (Go strings.TrimLeft(s, " ")). */
function trimLeftSpaces(s: string): string {
  let i = 0;
  while (i < s.length && s[i] === " ") i++;
  return s.slice(i);
}

// ── Block Parser ────────────────────────────────────────────────────────────

class BlockParser {
  #lines: string[];
  pos = 0;

  constructor(lines: string[]) {
    this.#lines = lines;
  }

  get lines(): string[] {
    return this.#lines;
  }

  parseBlocks(parent: Node): void {
    while (this.pos < this.#lines.length) {
      this.parseBlock(parent);
    }
  }

  private parseBlock(parent: Node): void {
    if (this.pos >= this.#lines.length) return;
    const line = this.#lines[this.pos];
    const trimmed = trimLeftSpaces(line);

    if (trimmed === "") {
      this.pos++;
      return;
    }
    if (isThematicBreak(trimmed)) {
      parent.append(newNode(NodeType.ThematicBreak));
      this.pos++;
      return;
    }
    const heading = this.tryParseHeading();
    if (heading.node) {
      this.pos += heading.consumed;
      parent.append(heading.node);
      return;
    }
    if (isFenceStart(trimmed)) {
      this.parseFencedCodeBlock(parent, trimmed[0]);
      return;
    }
    if (trimmed[0] === ">") {
      this.parseBlockquote(parent, 0);
      return;
    }
    if (isUnorderedListStart(trimmed)) {
      this.parseUnorderedList(parent);
      return;
    }
    if (isOrderedListStart(trimmed)) {
      this.parseOrderedList(parent);
      return;
    }
    if (
      trimmed[0] === "|" && this.pos + 1 < this.#lines.length &&
      isTableSeparator(this.#lines[this.pos + 1])
    ) {
      this.parseTable(parent);
      return;
    }
    if (isIndentedCodeStart(line)) {
      this.parseIndentedCodeBlock(parent);
      return;
    }
    this.parseParagraph(parent);
  }

  private tryParseHeading(): { node?: Node; consumed: number } {
    const line = this.#lines[this.pos];
    let i = 0;
    while (i < line.length && line[i] === "#") i++;
    if (i === 0 || i > 6) return { consumed: 0 };
    if (i < line.length && line[i] !== " ") return { consumed: 0 };
    let j = i;
    while (j < line.length && line[j] === " ") j++;
    let text = line.slice(j).trim();
    text = trimRightCutset(text, "# ");
    text = trimRightCutset(text, " ");

    const node = newNode(NodeType.Heading);
    node.level = i;
    parseInline(node, text);
    return { node, consumed: 1 };
  }

  private parseFencedCodeBlock(parent: Node, fenceChar: string): void {
    const firstLine = this.#lines[this.pos];
    const trimmed = trimLeftSpaces(firstLine);
    let fenceLen = 0;
    while (fenceLen < trimmed.length && trimmed[fenceLen] === fenceChar) {
      fenceLen++;
    }
    const info = trimmed.slice(fenceLen).trim();
    let lang: string;
    const idx = info.search(/[ \t]/);
    if (idx >= 0) lang = info.slice(0, idx);
    else lang = info;
    this.pos++;

    const codeLines: string[] = [];
    while (this.pos < this.#lines.length) {
      const line = this.#lines[this.pos];
      const trimmedLine = trimLeftSpaces(line);
      if (trimmedLine.length >= fenceLen) {
        let allFence = true;
        for (let k = 0; k < fenceLen; k++) {
          if (trimmedLine[k] !== fenceChar) {
            allFence = false;
            break;
          }
        }
        if (allFence && trimmedLine.slice(fenceLen).trim() === "") {
          this.pos++;
          break;
        }
      }
      codeLines.push(line);
      this.pos++;
    }

    const node = newNode(NodeType.FencedCodeBlock);
    node.language = lang;
    node.code = codeLines.join("\n");
    parent.append(node);
  }

  private parseIndentedCodeBlock(parent: Node): void {
    const codeLines: string[] = [];
    while (this.pos < this.#lines.length) {
      const line = this.#lines[this.pos];
      if (line.trim() === "") {
        let peek = this.pos + 1;
        while (peek < this.#lines.length && this.#lines[peek].trim() === "") {
          peek++;
        }
        if (
          peek < this.#lines.length && isIndentedCodeStart(this.#lines[peek])
        ) {
          codeLines.push("");
          this.pos++;
          continue;
        }
        break;
      }
      if (!isIndentedCodeStart(line)) break;
      if (line.length >= 4 && line.slice(0, 4) === "    ") {
        codeLines.push(line.slice(4));
      } else if (line[0] === "\t") {
        codeLines.push(line.slice(1));
      } else {
        codeLines.push(line);
      }
      this.pos++;
    }
    if (codeLines.length === 0) return;
    const node = newNode(NodeType.IndentedCodeBlock);
    node.code = codeLines.join("\n");
    parent.append(node);
  }

  private parseBlockquote(parent: Node, depth: number): void {
    const node = newNode(NodeType.Blockquote);
    node.quoteLevel = depth;

    const innerLines: string[] = [];
    while (this.pos < this.#lines.length) {
      const line = this.#lines[this.pos];
      const trimmed = trimLeftSpaces(line);
      if (trimmed === "") {
        if (this.pos + 1 < this.#lines.length) {
          const nextTrim = trimLeftSpaces(this.#lines[this.pos + 1]);
          if (nextTrim.length > 0 && nextTrim[0] === ">") {
            this.pos++;
            innerLines.push("");
            continue;
          }
        }
        break;
      }
      if (trimmed[0] !== ">") break;
      let content = trimmed.slice(1);
      if (content.length > 0 && content[0] === " ") content = content.slice(1);
      innerLines.push(content);
      this.pos++;
    }

    const subParser = new BlockParser(innerLines);
    subParser.parseBlocks(node);
    parent.append(node);
  }

  private parseUnorderedList(parent: Node): void {
    const node = newNode(NodeType.UnorderedList);
    node.ordered = false;

    while (this.pos < this.#lines.length) {
      const line = this.#lines[this.pos];
      const trimmed = trimLeftSpaces(line);
      if (trimmed === "") {
        if (
          this.pos + 1 < this.#lines.length &&
          isUnorderedListStart(this.#lines[this.pos + 1])
        ) {
          this.pos++;
          continue;
        }
        break;
      }
      if (!isUnorderedListStart(trimmed)) {
        if (node.children.length > 0) {
          const lastItem = node.children[node.children.length - 1];
          const contText = trimLeftSpaces(line);
          const contNode = newNode(NodeType.Text);
          contNode.text = "\n" + contText;
          lastItem.append(contNode);
          this.pos++;
          continue;
        }
        break;
      }
      const markerLen = 1;
      let content = trimmed.slice(markerLen);
      if (content.length > 0 && content[0] === " ") content = content.slice(1);
      const listItem = newNode(NodeType.ListItem);

      if (content.startsWith("[ ] ")) {
        listItem.checked = false;
        listItem.isTaskItem = true;
        content = content.slice(4);
      } else if (content.startsWith("[x] ") || content.startsWith("[X] ")) {
        listItem.checked = true;
        listItem.isTaskItem = true;
        content = content.slice(4);
      }

      const para = newNode(NodeType.Paragraph);
      parseInline(para, content);
      listItem.append(para);

      if (
        para.children.length > 0 && para.children[0].type === NodeType.Strong
      ) {
        listItem.startsWithBold = true;
      }

      node.append(listItem);
      this.pos++;
    }
    parent.append(node);
  }

  private parseOrderedList(parent: Node): void {
    const node = newNode(NodeType.OrderedList);
    node.ordered = true;
    let first = true;

    while (this.pos < this.#lines.length) {
      const line = this.#lines[this.pos];
      const trimmed = trimLeftSpaces(line);
      if (trimmed === "") {
        if (
          this.pos + 1 < this.#lines.length &&
          isOrderedListStart(this.#lines[this.pos + 1])
        ) {
          this.pos++;
          continue;
        }
        break;
      }
      if (!isOrderedListStart(trimmed)) {
        if (node.children.length > 0) {
          const lastItem = node.children[node.children.length - 1];
          const contText = trimLeftSpaces(line);
          const contNode = newNode(NodeType.Text);
          contNode.text = "\n" + contText;
          lastItem.append(contNode);
          this.pos++;
          continue;
        }
        break;
      }
      const { num, content: rawContent } = parseOrderedListStart(trimmed);
      let content = rawContent;
      if (first) {
        node.startNum = num;
        first = false;
      }
      const listItem = newNode(NodeType.ListItem);

      if (content.startsWith("[ ] ")) {
        listItem.checked = false;
        listItem.isTaskItem = true;
        content = content.slice(4);
      } else if (content.startsWith("[x] ") || content.startsWith("[X] ")) {
        listItem.checked = true;
        listItem.isTaskItem = true;
        content = content.slice(4);
      }

      const para = newNode(NodeType.Paragraph);
      parseInline(para, content);
      listItem.append(para);

      if (
        para.children.length > 0 && para.children[0].type === NodeType.Strong
      ) {
        listItem.startsWithBold = true;
      }

      node.append(listItem);
      this.pos++;
    }
    parent.append(node);
  }

  private parseTable(parent: Node): void {
    const node = newNode(NodeType.Table);

    const headerCells = parseTableRow(this.#lines[this.pos]);
    this.pos++;

    if (
      this.pos < this.#lines.length && isTableSeparator(this.#lines[this.pos])
    ) {
      this.pos++;
    }

    const rows: string[][] = [];
    while (this.pos < this.#lines.length) {
      const line = this.#lines[this.pos];
      const trimmed = line.trim();
      if (trimmed === "" || !trimmed.includes("|")) break;
      let cells = parseTableRow(line);
      while (cells.length < headerCells.length) cells.push("");
      if (cells.length > headerCells.length) {
        cells = cells.slice(0, headerCells.length);
      }
      rows.push(cells);
      this.pos++;
    }

    const headerNode = newNode(NodeType.TableRow);
    headerNode.isTableHeader = true;
    for (const cell of headerCells) {
      const cellNode = newNode(NodeType.TableCell);
      cellNode.isTableHeader = true;
      parseInline(cellNode, cell);
      headerNode.append(cellNode);
    }
    node.append(headerNode);

    for (const row of rows) {
      const rowNode = newNode(NodeType.TableRow);
      for (const cell of row) {
        const cellNode = newNode(NodeType.TableCell);
        parseInline(cellNode, cell);
        rowNode.append(cellNode);
      }
      node.append(rowNode);
    }
    parent.append(node);
  }

  private parseParagraph(parent: Node): void {
    const lines: string[] = [];
    while (this.pos < this.#lines.length) {
      const line = this.#lines[this.pos];
      const trimmed = line.trim();
      if (trimmed === "") break;
      if (isThematicBreak(trimmed)) break;
      if (isAtxHeading(trimmed)) break;
      if (isFenceStart(trimmed)) break;
      if (trimmed[0] === ">") break;
      if (isUnorderedListStart(trimmed)) break;
      if (isOrderedListStart(trimmed)) break;
      if (isIndentedCodeStart(line)) break;
      if (
        trimmed[0] === "|" && this.pos + 1 < this.#lines.length &&
        isTableSeparator(this.#lines[this.pos + 1])
      ) {
        break;
      }
      lines.push(line);
      this.pos++;
    }
    if (lines.length === 0) return;
    const node = newNode(NodeType.Paragraph);
    parseInline(node, lines.join("\n"));
    parent.append(node);
  }
}

// ── Block helpers ───────────────────────────────────────────────────────────

function isThematicBreak(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3) return false;
  const ch = trimmed[0];
  if (ch !== "-" && ch !== "*" && ch !== "_") return false;
  let count = 0;
  for (const r of trimmed) {
    if (r === ch) count++;
    else if (r !== " " && r !== "\t") return false;
  }
  return count >= 3;
}

function isFenceStart(line: string): boolean {
  const trimmed = trimLeftSpaces(line);
  if (trimmed.length < 3) return false;
  const ch = trimmed[0];
  if (ch !== "`" && ch !== "~") return false;
  let count = 0;
  while (count < trimmed.length && trimmed[count] === ch) count++;
  return count >= 3;
}

function isIndentedCodeStart(line: string): boolean {
  if (line.length === 0) return false;
  if (line.length >= 4 && line.slice(0, 4) === "    ") return true;
  if (line[0] === "\t") return true;
  return false;
}

function isUnorderedListStart(line: string): boolean {
  const trimmed = trimLeftSpaces(line);
  if (trimmed.length < 2) return false;
  const ch = trimmed[0];
  if (ch !== "-" && ch !== "*" && ch !== "+") return false;
  return trimmed.length > 1 && (trimmed[1] === " " || trimmed[1] === "\t");
}

function isOrderedListStart(line: string): boolean {
  const trimmed = trimLeftSpaces(line);
  let i = 0;
  while (i < trimmed.length && trimmed[i] >= "0" && trimmed[i] <= "9") i++;
  if (i === 0 || i > 9 || i >= trimmed.length) return false;
  return (trimmed[i] === "." || trimmed[i] === ")") && i + 1 < trimmed.length &&
    trimmed[i + 1] === " ";
}

function parseOrderedListStart(
  line: string,
): { num: number; markerLen: number; content: string } {
  const trimmed = trimLeftSpaces(line);
  let i = 0;
  while (i < trimmed.length && trimmed[i] >= "0" && trimmed[i] <= "9") i++;
  let num = 0;
  for (let j = 0; j < i; j++) {
    num = num * 10 + (trimmed.charCodeAt(j) - "0".charCodeAt(0));
  }
  const delimLen = 2;
  const content = trimmed.slice(i + delimLen);
  return { num, markerLen: i + delimLen, content };
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3) return false;
  let hasDash = false;
  let hasPipe = false;
  for (const r of trimmed) {
    if (r === "-") hasDash = true;
    else if (r === "|") hasPipe = true;
    else if (r !== " " && r !== ":") return false;
  }
  return hasDash && hasPipe;
}

function parseTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.length > 0 && trimmed[0] === "|") trimmed = trimmed.slice(1);
  if (trimmed.length > 0 && trimmed[trimmed.length - 1] === "|") {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed.split("|").map((p) => p.trim());
}

function isAtxHeading(line: string): boolean {
  let i = 0;
  while (i < line.length && line[i] === "#") i++;
  return i >= 1 && i <= 6 && i < line.length && line[i] === " ";
}

// ── Inline Parser ───────────────────────────────────────────────────────────

class InlineParser {
  #text: string;
  pos = 0;

  constructor(text: string) {
    this.#text = text;
  }

  get text(): string {
    return this.#text;
  }

  parse(parent: Node): void {
    while (this.pos < this.#text.length) {
      const ch = this.#text[this.pos];
      switch (ch) {
        case "`":
          this.parseCodeSpan(parent);
          break;
        case "*":
          this.parseEmphasis(parent, "*");
          break;
        case "_":
          this.parseEmphasis(parent, "_");
          break;
        case "~":
          if (
            this.pos + 1 < this.#text.length && this.#text[this.pos + 1] === "~"
          ) {
            this.parseStrikethrough(parent);
          } else {
            this.emitText(parent, "~");
          }
          break;
        case "[":
          this.parseLinkOrImage(parent);
          break;
        case "!":
          if (
            this.pos + 1 < this.#text.length && this.#text[this.pos + 1] === "["
          ) {
            this.parseImage(parent);
          } else {
            this.emitText(parent, "!");
          }
          break;
        case "<":
          if (!this.tryParseAutolink(parent)) this.emitText(parent, "<");
          break;
        case "\\":
          if (this.pos + 1 < this.#text.length) {
            const next = this.#text[this.pos + 1];
            if (next === "\n") {
              parent.append(newNode(NodeType.HardBreak));
              this.pos += 2;
            } else {
              this.emitText(parent, next);
              this.pos += 2;
            }
          } else {
            this.emitText(parent, "\\");
          }
          break;
        case "\n":
          if (
            this.pos >= 2 && this.#text[this.pos - 2] === " " &&
            this.#text[this.pos - 1] === " "
          ) {
            removeTrailingSpaces(parent);
            parent.append(newNode(NodeType.HardBreak));
            this.pos++;
          } else {
            parent.append(newNode(NodeType.SoftBreak));
            this.pos++;
          }
          break;
        default: {
          const start = this.pos;
          while (this.pos < this.#text.length) {
            const c = this.#text[this.pos];
            if (
              c === "`" || c === "*" || c === "_" || c === "~" || c === "[" ||
              c === "!" || c === "<" || c === "\\" || c === "\n"
            ) {
              break;
            }
            this.pos++;
          }
          if (this.pos > start) {
            const node = newNode(NodeType.Text);
            node.text = this.#text.slice(start, this.pos);
            parent.append(node);
          }
        }
      }
    }
  }

  emitText(parent: Node, text: string): void {
    const node = newNode(NodeType.Text);
    node.text = text;
    parent.append(node);
    this.pos += text.length;
  }

  private parseCodeSpan(parent: Node): void {
    const start = this.pos;
    let backtickCount = 0;
    while (this.pos < this.#text.length && this.#text[this.pos] === "`") {
      backtickCount++;
      this.pos++;
    }
    while (this.pos < this.#text.length) {
      if (this.#text[this.pos] === "`") {
        let endCount = 0;
        let endPos = this.pos;
        while (endPos < this.#text.length && this.#text[endPos] === "`") {
          endCount++;
          endPos++;
        }
        if (endCount === backtickCount) {
          let code = this.#text.slice(start + backtickCount, this.pos);
          if (
            code.length > 0 && code[0] === " " &&
            code[code.length - 1] === " " && code.length > 2
          ) {
            code = code.slice(1, -1);
          }
          const node = newNode(NodeType.CodeSpan);
          node.text = code;
          parent.append(node);
          this.pos = endPos;
          return;
        }
        this.pos = endPos;
      } else {
        this.pos++;
      }
    }
    this.pos = start;
    this.emitText(parent, "`");
  }

  private parseEmphasis(parent: Node, delim: string): void {
    const start = this.pos;
    let count = 0;
    while (this.pos < this.#text.length && this.#text[this.pos] === delim) {
      count++;
      this.pos++;
    }
    if (count > 2) {
      this.pos = start + 1;
      const node = newNode(NodeType.Text);
      node.text = delim;
      parent.append(node);
      return;
    }
    const delimStr = delim.repeat(count);

    let searchPos = this.pos;
    let found = false;
    while (searchPos < this.#text.length) {
      if (this.#text[searchPos] === delim) {
        let endCount = 0;
        const endStart = searchPos;
        while (
          searchPos < this.#text.length && this.#text[searchPos] === delim
        ) {
          endCount++;
          searchPos++;
        }
        if (endCount >= count) {
          const innerText = this.#text.slice(this.pos, endStart);
          if (innerText !== "") {
            const node = count === 2
              ? newNode(NodeType.Strong)
              : newNode(NodeType.Emphasis);
            parseInline(node, innerText);
            parent.append(node);
          }
          this.pos = searchPos;
          found = true;
          break;
        }
      } else {
        searchPos++;
      }
    }
    if (!found) {
      const node = newNode(NodeType.Text);
      node.text = delimStr;
      parent.append(node);
    }
  }

  private parseStrikethrough(parent: Node): void {
    this.pos += 2;
    const idx = this.#text.indexOf("~~", this.pos);
    if (idx < 0) {
      const node = newNode(NodeType.Text);
      node.text = "~~";
      parent.append(node);
      return;
    }
    const innerText = this.#text.slice(this.pos, idx);
    const node = newNode(NodeType.Strikethrough);
    parseInline(node, innerText);
    parent.append(node);
    this.pos = idx + 2;
  }

  private parseLinkOrImage(parent: Node): void {
    const innerStart = this.pos + 1;
    const closeBracket = findClosingBracket(this.#text, this.pos);
    if (closeBracket < 0) {
      this.emitText(parent, "[");
      return;
    }
    if (
      closeBracket + 1 < this.#text.length &&
      this.#text[closeBracket + 1] === "("
    ) {
      const urlStart = closeBracket + 2;
      const urlEnd = this.#text.indexOf(")", urlStart);
      if (urlEnd < 0) {
        this.emitText(parent, "[");
        return;
      }
      let url = this.#text.slice(urlStart, urlEnd);
      let title = "";
      const spaceIdx = url.lastIndexOf(' "');
      if (spaceIdx >= 0 && url.endsWith('"')) {
        title = url.slice(spaceIdx + 2, url.length - 1);
        url = url.slice(0, spaceIdx);
      }
      const node = newNode(NodeType.Link);
      node.url = url;
      node.title = title;
      parseInline(node, this.#text.slice(innerStart, closeBracket));
      parent.append(node);
      this.pos = urlEnd + 1;
      return;
    }
    this.emitText(parent, "[");
  }

  private parseImage(parent: Node): void {
    const innerStart = this.pos + 2;
    let closeBracket = -1;
    let depth = 0;
    for (let i = innerStart; i < this.#text.length; i++) {
      if (this.#text[i] === "[") depth++;
      else if (this.#text[i] === "]") {
        if (depth === 0) {
          closeBracket = i;
          break;
        }
        depth--;
      }
    }
    if (closeBracket < 0) {
      this.emitText(parent, "!");
      return;
    }
    if (
      closeBracket + 1 < this.#text.length &&
      this.#text[closeBracket + 1] === "("
    ) {
      const urlStart = closeBracket + 2;
      const urlEnd = this.#text.indexOf(")", urlStart);
      if (urlEnd < 0) {
        this.emitText(parent, "!");
        return;
      }
      let url = this.#text.slice(urlStart, urlEnd);
      let title = "";
      const spaceIdx = url.lastIndexOf(' "');
      if (spaceIdx >= 0 && url.endsWith('"')) {
        title = url.slice(spaceIdx + 2, url.length - 1);
        url = url.slice(0, spaceIdx);
      }
      const node = newNode(NodeType.Image);
      node.url = url;
      node.title = title;
      const altNode = newNode(NodeType.Text);
      altNode.text = this.#text.slice(innerStart, closeBracket);
      node.append(altNode);
      parent.append(node);
      this.pos = urlEnd + 1;
      return;
    }
    this.emitText(parent, "!");
  }

  private tryParseAutolink(parent: Node): boolean {
    if (this.#text[this.pos] !== "<") return false;
    const end = this.#text.indexOf(">", this.pos + 1);
    if (end < 0) return false;
    const inner = this.#text.slice(this.pos + 1, end);
    if (isURL(inner) || isEmail(inner)) {
      const node = newNode(NodeType.Autolink);
      node.url = inner;
      node.text = inner;
      parent.append(node);
      this.pos = end + 1;
      return true;
    }
    return false;
  }
}

function parseInline(parent: Node, text: string): void {
  const ip = new InlineParser(text);
  ip.parse(parent);
}

function findClosingBracket(text: string, openPos: number): number {
  let depth = 0;
  for (let i = openPos; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function isURL(s: string): boolean {
  return s.startsWith("http://") || s.startsWith("https://") ||
    s.startsWith("ftp://");
}

function isEmail(s: string): boolean {
  const at = s.indexOf("@");
  return at > 0 && at < s.length - 1;
}

function removeTrailingSpaces(parent: Node): void {
  if (parent.children.length === 0) return;
  const last = parent.children[parent.children.length - 1];
  if (last.type === NodeType.Text) {
    last.text = trimRightCutset(last.text, " ");
    if (last.text === "") parent.children = parent.children.slice(0, -1);
  }
}
