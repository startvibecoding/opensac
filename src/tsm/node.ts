//
// Zero-dependency CommonMark-compatible Markdown AST. The pipeline mirrors the
// Go/Swift original: Preprocess (LaTeX) → Parse → Rewrite (speculative
// emphasis/table) → Render.

/** Identifies the kind of AST node. Values mirror the Go iota block. */
export const NodeType = {
  // Block nodes
  Document: 0,
  Heading: 1,
  Paragraph: 2,
  FencedCodeBlock: 3,
  IndentedCodeBlock: 4,
  Blockquote: 5,
  ThematicBreak: 6,
  OrderedList: 7,
  UnorderedList: 8,
  ListItem: 9,
  Table: 10,
  TableRow: 11,
  TableCell: 12,

  // Inline nodes (>= 100)
  Text: 100,
  Emphasis: 101,
  Strong: 102,
  CodeSpan: 103,
  Link: 104,
  Image: 105,
  Strikethrough: 106,
  SoftBreak: 107,
  HardBreak: 108,
  Autolink: 109,
  LineBreak: 110,
} as const;
export type NodeType = (typeof NodeType)[keyof typeof NodeType];

/** A single node in the Markdown AST. */
export class Node {
  type: NodeType;
  children: Node[] = [];
  parent: Node | undefined;

  /** Stable ID computed from root path (e.g. "2-1"). */
  id = "";

  // Block-level fields
  /** Heading level 1-6. */
  level = 0;
  /** Fenced code block language. */
  language = "";
  /** Raw code content (for code blocks). */
  code = "";
  /** List is ordered. */
  ordered = false;
  /** Start number for ordered lists (mirrors swift-markdown). */
  startNum = 0;

  // Inline-level fields
  /** Literal text content. */
  text = "";
  /** Link/image destination. */
  url = "";
  /** Link/image title. */
  title = "";

  // Table fields
  /** True for header cells/rows. */
  isTableHeader = false;

  // List fields
  /** Task list checkbox state. */
  checked = false;
  /** This is a task list item (has [x] or [ ] checkbox). */
  isTaskItem = false;
  /** First child paragraph starts with Strong (mirrors Swift ListItem+). */
  startsWithBold = false;

  // Blockquote fields
  /** Nesting depth for blockquotes (0 = top-level). */
  quoteLevel = 0;

  constructor(t: NodeType) {
    this.type = t;
  }

  /** Adds a child node. */
  append(child: Node): void {
    child.parent = this;
    this.children.push(child);
  }

  /**
   * Traverses the AST depth-first, calling `fn` for each node. Return false
   * from `fn` to stop traversal.
   */
  walk(fn: (n: Node) => boolean): void {
    if (!fn(this)) return;
    for (const c of this.children) c.walk(fn);
  }

  /** Recursively collects all text content from this node's children. */
  textContent(): string {
    switch (this.type) {
      case NodeType.Text:
        return this.text;
      case NodeType.SoftBreak:
        return " ";
      case NodeType.HardBreak:
      case NodeType.LineBreak:
        return "\n";
      case NodeType.CodeSpan:
        return this.text;
      case NodeType.Heading: {
        let s = "";
        for (const c of this.children) s += c.textContent();
        return s + "\n";
      }
      case NodeType.Paragraph: {
        let s = "";
        for (const c of this.children) s += c.textContent();
        return s + "\n";
      }
      case NodeType.FencedCodeBlock:
      case NodeType.IndentedCodeBlock:
        return this.code + "\n";
      case NodeType.ThematicBreak:
        return "---\n";
      case NodeType.OrderedList: {
        let s = "";
        this.children.forEach((c, i) => {
          s += `${this.startNum + i}. ${c.textContent()}`;
        });
        return s;
      }
      case NodeType.UnorderedList: {
        let s = "";
        for (const c of this.children) s += `• ${c.textContent()}`;
        return s;
      }
      case NodeType.ListItem: {
        let s = "";
        for (const c of this.children) s += c.textContent();
        return s;
      }
      case NodeType.Table: {
        let s = "";
        this.children.forEach((row, i) => {
          row.children.forEach((cell, j) => {
            s += cell.textContent();
            if (j < row.children.length - 1) s += "\t";
          });
          if (i < this.children.length - 1) s += "\n";
        });
        return s + "\n";
      }
      case NodeType.Blockquote: {
        let s = "";
        for (const c of this.children) {
          for (const line of c.textContent().split("\n")) {
            if (line !== "") s += `> ${line}\n`;
          }
        }
        return s;
      }
      default: {
        let s = "";
        for (const c of this.children) s += c.textContent();
        return s;
      }
    }
  }

  /** Returns true if the node is a block-level element. */
  isBlock(): boolean {
    return this.type < 100;
  }

  /** Returns true if the node is an inline-level element. */
  isInline(): boolean {
    return this.type >= 100;
  }

  /** Returns the first child matching the given type, or undefined. */
  findChild(t: NodeType): Node | undefined {
    for (const c of this.children) {
      if (c.type === t) return c;
    }
    return undefined;
  }

  /** Returns this node's index in its parent's children, or -1. */
  indexInParent(): number {
    if (!this.parent) return -1;
    const idx = this.parent.children.indexOf(this);
    return idx;
  }

  /** Returns the deepest last-child leaf node. */
  rightmostDescendant(): Node {
    return rightmost(this);
  }
}

function rightmost(n: Node): Node {
  let cur = n;
  while (cur.children.length > 0) {
    cur = cur.children[cur.children.length - 1];
  }
  return cur;
}

/** Creates a new AST node of the given type. */
export function createNode(t: NodeType): Node {
  return new Node(t);
}

function itoa(i: number): string {
  return String(i);
}

/**
 * Assigns stable IDs to all nodes by computing the path from root. Each node's
 * ID is the concatenation of its index-in-parent chain, e.g. "2-1".
 */
export function computeIDs(root: Node): void {
  root.id = "0";
  computeIDsRec(root);
}

function computeIDsRec(n: Node): void {
  n.children.forEach((child, i) => {
    child.id = `${n.id}-${itoa(i)}`;
    computeIDsRec(child);
  });
}
