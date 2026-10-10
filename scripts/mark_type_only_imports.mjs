// Finds imports/re-exports that pull a *type-only* name across module borders
// without the `type` marker. Node's type-stripping loader erases `interface`,
// `type`, and most `declare` exports, so a value-position import of such a name
// fails at link time ("does not provide an export named X").
//
// The fix is mechanical: mark those specifiers `type`. This script reports them
// and, with --fix, rewrites the specifier list in place.
// Run with: node scripts/mark_type_only_imports.mjs [--fix]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", "dist", ".git", "bin", "desktop"]);
const FIX = process.argv.includes("--fix");

/** file -> { exportedTypes:Set, exportedValues:Set, text } */
const modules = new Map();
for (const root of ["src", "sdk", "examples"]) walk(join(ROOT, root));
maybe(join(ROOT, "bootstrap.ts"));

// Pass 1: collect each module's type-only and value exports.
const exportsByFile = new Map();
for (const [file, entry] of modules) {
  const text = entry.text;
  const types = new Set();
  const values = new Set();
  // Declared types.
  for (const m of text.matchAll(
    /^\s*(?:export\s+)?(?:declare\s+)?(type|interface)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    if (m[1] === "type" || m[1] === "interface") types.add(m[2]);
  }
  // Value declarations that are exported.
  const valueRe =
    /^\s*export\s+(?:declare\s+)?(?:abstract\s+)?(class|function|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of text.matchAll(valueRe)) values.add(m[2]);
  // `export { a, b as c }` / `export type { ... }` / `export * from`.
  for (const m of text.matchAll(/^\s*export\s+(type\s+)?(\{|\*)\s?([\s\S]*?);$/gm)) {
    const wholeIsType = Boolean(m[1]);
    const tail = m[3];
    if (m[2] === "*") continue; // star re-export: names unknown here
    for (const part of splitList(tail)) {
      const trimmed = part.trim();
      const isType = wholeIsType || /^type\s+/.test(trimmed);
      const local = trimmed.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (isType) types.add(local);
      else values.add(local);
    }
  }
  // A declaration wins over a re-export marker: a class/function/const with the
  // same name as a type is a value binding at runtime.
  for (const v of values) types.delete(v);
  exportsByFile.set(file, { types, values });
}
void exportsByFile;

// Pass 2: report/rewrite imports of type-only names.
let issues = 0;
let fixedFiles = 0;
for (const [file, mod] of modules) {
  const rel = file.slice(ROOT.length + 1);
  let text = mod.text;
  let changed = false;
  const importRe = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s+from\s+(["'])([^"']+)\2/g;
  text = text.replace(importRe, (whole, list, quote, spec) => {
    const target = resolveSpecifier(file, spec);
    if (!target || !modules.has(target)) return whole;
    const targetMod = exportsByFile.get(target);
    const parts = splitList(list);
    let touched = false;
    const out = parts.map((part) => {
      const trimmed = part.trim();
      if (!trimmed || /^type\s+/.test(trimmed) || /^\*\s+as\s+/.test(trimmed)) {
        return part;
      }
      const local = trimmed.split(/\s+as\s+/)[0].trim();
      if (
        targetMod.types.has(local) && !targetMod.values.has(local)
      ) {
        touched = true;
        issues++;
        console.log(`${rel}: type-only import "${local}" from ${spec}`);
        return part.replace(trimmed, `type ${trimmed}`);
      }
      return part;
    });
    if (!touched) return whole;
    changed = true;
    return `import {${out.join(",")}} from ${quote}${spec}${quote}`;
  });

  // Re-exports: `export { X } from "./y.ts"` where X is type-only in y.
  const reexportRe = /\bexport\s+\{([^}]*)\}\s+from\s+(['"])([^'"]+)\2/g;
  text = text.replace(reexportRe, (whole, list, quote, spec) => {
    const target = resolveSpecifier(file, spec);
    if (!target || !modules.has(target)) return whole;
    const targetMod = exportsByFile.get(target);
    const parts = splitList(list);
    let touched = false;
    const out = parts.map((part) => {
      const trimmed = part.trim();
      if (!trimmed || /^type\s+/.test(trimmed)) return part;
      const local = trimmed.split(/\s+as\s+/)[0].trim();
      if (targetMod.types.has(local) && !targetMod.values.has(local)) {
        touched = true;
        issues++;
        console.log(`${rel}: type-only re-export "${local}" from ${spec}`);
        return part.replace(trimmed, `type ${trimmed}`);
      }
      return part;
    });
    if (!touched) return whole;
    changed = true;
    return `export {${out.join(",")}} from ${quote}${spec}${quote}`;
  });

  if (changed && FIX) {
    writeFileSync(file, text);
    fixedFiles++;
  }
}
console.log(FIX ? `fixed ${issues} specifier(s) in ${fixedFiles} file(s)` : `${issues} issue(s)`);

function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  return modules.has(base) ? base : null;
}

/** Splits a specifier list on top-level commas, preserving each piece verbatim. */
function splitList(list) {
  const out = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if ("([{<".includes(ch)) depth++;
    else if (")]}>".includes(ch)) depth--;
    if (ch === "," && depth <= 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.filter((piece) => piece.trim().length > 0);
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
    else maybe(p);
  }
}

function maybe(file) {
  if (!/\.tsx?$/.test(file)) return;
  modules.set(file, { text: readFileSync(file, "utf8"), types: new Set(), values: new Set() });
}
