// Reports `export { X }` / `import { X } from` statements that mix in names
// which are types/interfaces only. Node's type-stripping loader erases type
// declarations, so re-exporting one without `export type` produces an
// "Export ... is not defined" link error at runtime.
// Run with: node scripts/find_type_reexports.mjs [--fix]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", "dist", ".git", "bin", "desktop"]);
const FIX = process.argv.includes("--fix");

const texts = new Map();
const files = [];
for (const root of ["src", "sdk", "examples"]) walk(join(ROOT, root));
maybe(join(ROOT, "bootstrap.ts"));

// Collect every locally-declared type name per file.
const typeNames = new Map();
for (const [file, text] of texts) {
  const set = new Set();
  for (const m of text.matchAll(
    /^\s*(?:export\s+)?(?:declare\s+)?(?:type|interface)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    set.add(m[1]);
  }
  // Imported-as-type names are also erased when re-exported.
  for (const m of text.matchAll(/,\s*type\s+([A-Za-z_$][\w$]*)/g)) {
    set.add(m[1]);
  }
  typeNames.set(file, set);
}

let issues = 0;
let fixed = 0;
for (const [file, text] of texts) {
  const rel = file.slice(ROOT.length + 1);
  const localTypes = typeNames.get(file);
  const lines = text.split("\n");
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^(\s*)(export\s+)\{([^}]*)\};?\s*$/.exec(line);
    if (!m) continue;
    const parts = m[3].split(",").map((s) => s.trim()).filter(Boolean);
    const valueParts = [];
    const typeParts = [];
    for (const part of parts) {
      const name = part.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      const isType = /^type\s+/.test(part) || localTypes.has(name);
      (isType ? typeParts : valueParts).push(part);
    }
    if (typeParts.length === 0 || valueParts.length > 0) continue;
    issues++;
    console.log(`${rel}:${i + 1} all-type export braces: ${line.trim()}`);
    if (FIX) {
      lines[i] = `${m[1]}export type {${m[3]}};`;
      changed = true;
      fixed++;
    }
  }

  if (changed) writeFileSync(file, lines.join("\n"));
}
console.log(FIX ? `fixed ${fixed}/${issues}` : `${issues} issue(s)`);

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
    else maybe(p);
  }
}

function maybe(file) {
  if (!/\.tsx?$/.test(file)) return;
  texts.set(file, readFileSync(file, "utf8"));
  files.push(file);
}
