// Finds TypeScript syntax that Node's type-stripping loader cannot erase:
// parameter properties (including multi-line signatures), enums, and namespaces.
// Run with: node scripts/find_unerasable_syntax.mjs
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", "dist", ".git", "bin", "desktop"]);
const FIX = process.argv.includes("--fix");

const MODIFIER_RE = /^(?:public\s+|private\s+|protected\s+|readonly\s+)+/;
const hits = [];
let fixed = 0;
for (const root of ["src", "sdk", "examples", "scripts"]) {
  walk(join(ROOT, root));
}
scanFile(join(ROOT, "bootstrap.ts"));

if (FIX) {
  console.log(`fixed ${fixed} constructor(s)`);
} else {
  for (const h of hits) console.log(h);
  console.log(`${hits.length} hit(s)`);
}

function walk(dir) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e.name)) scanFile(p);
  }
}

function scanFile(file) {
  const text = readFileSync(file, "utf8");
  const rel = file.slice(ROOT.length + 1);
  const found = [];

  for (const m of text.matchAll(/^\s*(export\s+)?(declare\s+)?(const\s+)?enum\s+[A-Za-z_$]/gm)) {
    found.push(`${rel}:${lineOf(text, m.index)} enum`);
  }
  for (const m of text.matchAll(/^\s*(export\s+)?namespace\s+[A-Za-z_$]/gm)) {
    found.push(`${rel}:${lineOf(text, m.index)} namespace`);
  }
  for (const m of text.matchAll(/\bconstructor\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(text, open);
    if (close < 0) continue;
    const params = text.slice(open + 1, close);
    const parsed = splitParams(params).filter(Boolean);
    const props = parsed.filter(isParamProp);
    if (props.length === 0) continue;
    found.push(
      `${rel}:${lineOf(text, m.index)} parameter property: ${props.join(" | ")}`,
    );
    if (FIX) found.pop();
  }

  if (found.length > 0) hits.push(...found);
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function matchParen(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitParams(params) {
  const out = [];
  let depth = 0;
  let current = "";
  let quote = null;
  for (const ch of params) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if ("([{<".includes(ch)) depth++;
    else if (")]}>".includes(ch)) depth--;
    if (ch === "," && depth <= 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function isParamProp(param) {
  return MODIFIER_RE.test(param.replace(/^\.\.\./, ""));
}
