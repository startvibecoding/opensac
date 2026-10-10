// Repair misplaced `#testing` imports left by the Deno->node:test codemod:
// the import was sometimes inserted inside a multi-line `import { ... } from`
// block. This moves it to just after that block's closing line.
// Run with: node scripts/fix_test_imports.mjs
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const IMPORT_RE = /^import \{ test \} from "#testing";$/;
const ROOTS = ["src", "sdk", "examples", "scripts"];
const SKIP = new Set(["node_modules", "dist", ".git", "bin", "desktop"]);

function files(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

let repaired = 0;
for (const root of ROOTS) {
  for (const file of files(root)) {
    const text = readFileSync(file, "utf8");
    if (!text.includes('from "#testing"')) continue;
    const lines = text.split("\n");
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      if (!IMPORT_RE.test(lines[i])) continue;
      // Walk backwards: are we inside an unterminated import block?
      let depth = 0;
      for (let j = i - 1; j >= 0; j--) {
        const l = lines[j];
        depth += count(l, "{") - count(l, "}");
        if (depth > 0) break;
        if (l.trim() === "" || l.trimStart().startsWith("//")) continue;
        if (!(l.trimStart().startsWith("import") || l.includes("} from") ||
              l.trimEnd().endsWith(",") || l.trim().startsWith('"') ||
              l.trim().startsWith("'") || l.trim().startsWith("*"))) break;
      }
      if (depth <= 0) continue;
      // Find the block terminator at/after i+1 (we must not have skipped lines;
      // the codemod kept all original lines and inserted this one).
      let k = i + 1;
      while (k < lines.length && !lines[k].includes("} from")) k++;
      if (k >= lines.length) continue;
      const [line] = lines.splice(i, 1);
      lines.splice(k, 0, line);
      changed = true;
    }
    if (changed) {
      writeFileSync(file, lines.join("\n"));
      repaired++;
    }
  }
}
console.log(`repaired ${repaired} files`);

function count(s, ch) {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}
