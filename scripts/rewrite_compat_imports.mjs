// One-shot migration codemod: `@opensac/*` import-map specifiers -> relative
// paths into `src/compat/`. Node's package `imports` field only accepts `#`-prefixed
// specifiers, and the published bundle must not depend on a resolver map either,
// so the compat modules are addressed directly.
// Run with: node scripts/rewrite_compat_imports.mjs
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TARGETS = {
  "@opensac/path/posix": "src/compat/path_posix.ts",
  "@opensac/path": "src/compat/path.ts",
  "@opensac/assert": "src/compat/assert.ts",
  "@opensac/encoding/base64": "src/compat/encoding.ts",
  "@opensac/encoding/base64url": "src/compat/encoding.ts",
};
const SKIP = new Set(["node_modules", "dist", ".git", "bin", "desktop"]);
const RE = /from\s+(["'])(@opensac\/[^"']+)\1/g;

let rewritten = 0;
walk(join(ROOT, "src"));
walk(join(ROOT, "sdk"));
walk(join(ROOT, "examples"));
walk(join(ROOT, "scripts"));
const bootstrap = join(ROOT, "bootstrap.ts");
maybe(bootstrap);
console.log(`rewrote ${rewritten} files`);

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
    else if (/\.tsx?$/.test(e.name)) maybe(p);
  }
}

function maybe(file) {
  const text = readFileSync(file, "utf8");
  if (!text.includes("@opensac/")) return;
  const next = text.replace(RE, (_m, quote, specifier) => {
    const target = TARGETS[specifier];
    if (!target) throw new Error(`unknown compat specifier: ${specifier}`);
    let rel = relative(dirname(file), join(ROOT, target)).split(sep).join("/");
    if (!rel.startsWith(".")) rel = "./" + rel;
    return `from ${quote}${rel}${quote}`;
  });
  if (next !== text) {
    writeFileSync(file, next);
    rewritten++;
  }
}
