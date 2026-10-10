#!/usr/bin/env node
// One-shot Deno -> Node source migration, idempotent and re-runnable.
//
// The repository used to run on the Deno CLI: `Deno.test` declarations, a
// `deno.json` import map for the project-owned `@opensac/*` compat modules, and
// TypeScript that relied on Deno's full type checker. It now runs on Node with
// npm tooling, which imposes three mechanical constraints this script satisfies
// in one pass over `src/`, `sdk/`, `examples/`, and `scripts/`:
//
//   1. Test declarations move from `Deno.test(...)` to `test(...)` imported
//      from `#testing` (the node:test adapter in `src/testing/mod.ts`).
//   2. Import-map specifiers (`@opensac/path`, `@opensac/assert`, …) become
//      relative paths into `src/compat/`, because Node's package `imports` field
//      only accepts `#`-prefixed specifiers and the published bundle must not
//      depend on a resolver map.
//   3. Syntax Node's type-stripping loader cannot erase is rewritten:
//        * parameter properties -> explicit field + constructor assignment;
//        * `enum` -> frozen `const` object + union type;
//        * type-only names imported/re-exported in value position get a `type`
//          marker, so erasure does not leave a dangling binding.
//   4. `// deno-lint-ignore*` comments become their ESLint equivalents.
//
// Every step is guarded by an exact-match check, so re-running the script on an
// already-migrated tree reports zero changes. Run with:
//   node scripts/migrate_to_node.mjs [--dry-run]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DRY = process.argv.includes("--dry-run");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "bin", "desktop"]);
/**
 * The testing adapter itself must never be rewritten: it defines `test`, so an
 * inserted `import { test } from "#testing"` would collide with its own export.
 */
const SELF_EXCLUDED = new Set([
  join(ROOT, "src/testing/mod.ts"),
  join(ROOT, "src/testing/process.ts"),
]);
const SCAN_ROOTS = ["src", "sdk", "examples", "scripts"];

/** Import-map alias -> repository-relative target of the compat module. */
const COMPAT_TARGETS = {
  "@opensac/path/posix": "src/compat/path_posix.ts",
  "@opensac/path": "src/compat/path.ts",
  "@opensac/assert": "src/compat/assert.ts",
  "@opensac/encoding/base64": "src/compat/encoding.ts",
  "@opensac/encoding/base64url": "src/compat/encoding.ts",
};

/** Leading access-modifier sequence on a constructor parameter. */
const MODIFIER_RE = /^(?:public\s+|private\s+|protected\s+|readonly\s+)+/;

const stats = {
  files: 0,
  tests: 0,
  compat: 0,
  paramProps: 0,
  enums: 0,
  typeMarkers: 0,
  lintDirectives: 0,
};

/** file path -> current text. Loaded up front so later passes see earlier edits. */
const sources = new Map();

for (const root of SCAN_ROOTS) walk(join(ROOT, root));
collect(join(ROOT, "bootstrap.ts"));

// Pass A: compat specifiers -> relative paths (must precede the export analysis,
// which resolves relative specifiers).
for (const [file, text] of sources) put(file, rewriteCompatImports(file, text));

// Pass B: type-only import/export markers.
for (const [file, text] of [...sources]) put(file, markTypeOnly(text, file));

// Pass C: unerasable syntax.
for (const [file, text] of [...sources]) {
  let next = rewriteParameterProperties(text);
  next = rewriteEnums(next);
  put(file, next);
}

// Pass D: test declarations + lint directives.
for (const [file, text] of [...sources]) {
  let next = rewriteTestDeclarations(text);
  next = rewriteLintDirectives(next);
  put(file, next);
}

// Pass E: platform layer rewiring (the Deno global's single owner).
put(
  join(ROOT, "src/platform/node_compat.ts"),
  rewriteNodeCompat(read(join(ROOT, "src/platform/node_compat.ts"))),
);

writeOut();
report();

/** Reads a file that may not be in the scanned set yet. */
function read(file) {
  return readFileSync(file, "utf8");
}

// ─── Pass E: node_compat.ts rewiring ───────────────────────────────────────

/**
 * Points `node_compat.ts` at the repository-owned Deno namespace instead of the
 * removed `@deno/shim-deno` package, and makes installation unconditional (there
 * is no Deno host to detect any more). Idempotent: every replacement is guarded
 * by an exact match, so a second run finds nothing to do.
 */
function rewriteNodeCompat(text) {
  let out = text;
  const headerOld = `// Node runtime compatibility for the Deno APIs that \`@deno/shim-deno\` omits.
//
// \`@deno/shim-deno\` covers only the file/env/process surface.
// The product also uses \`Deno.Command\`, \`Deno.execPath\`, \`Deno.args\`,
// \`Deno.exit\`, \`Deno.serve\`, \`Deno.upgradeWebSocket\`, \`Deno.connect\`,
// \`Deno.createHttpClient\`, \`Deno.SeekMode\`, \`Deno.unrefTimer\`,
// \`Deno.resolveDns\`, and the Web \`Worker\` global. This module installs those on
// top of Node built-ins so the same sources run unmodified under Node.
//
// It is imported for its side effect from the CLI entry. Under Deno every
// needed API already exists, so installation returns immediately and this file
// is a no-op there.`;
  const headerNew = `// The single owner of the \`Deno.*\` API vocabulary for this repository.
//
// There is no Deno runtime or registry dependency here: \`src/platform/deno_shim.ts\`
// provides the file/env/process namespace backed by Node built-ins, and this
// module adds the richer APIs the product uses — \`Deno.Command\`, \`Deno.execPath\`,
// \`Deno.args\`, \`Deno.exit\`, \`Deno.serve\`, \`Deno.upgradeWebSocket\`, \`Deno.connect\`,
// \`Deno.createHttpClient\`, \`Deno.SeekMode\`, \`Deno.unrefTimer\`, \`Deno.resolveDns\`,
// and the Web \`Worker\` global — then installs the result as a process global
// before any application module loads.
//
// Every entry point must import it first: the whole source tree reads \`Deno.*\`
// as a global, and under Node only this module makes that true.`;
  if (out.includes(headerOld)) out = out.replace(headerOld, headerNew);

  const importOld = `// The Deno global the sources read at runtime. esbuild leaves \`Deno\` as a
// global reference; this module assigns it (from the shim) and extends it.
import { Deno as denoGlobal } from "@deno/shim-deno";`;
  const importNew = `// The Deno namespace the sources read at runtime. esbuild leaves \`Deno\` as a
// global reference; this module installs the shim object globally and extends it.
import { denoNamespace } from "./deno_shim.ts";`;
  if (out.includes(importOld)) out = out.replace(importOld, importNew);

  const guardOld = `/** True when running under Node rather than Deno (no native \`Deno.serve\`). */
function isNodeRuntime(deno: AnyDeno | undefined): boolean {
  return deno === undefined || typeof deno.serve !== "function";
}
`;
  if (out.includes(guardOld)) out = out.replace(guardOld, "");

  const installOld = `/** Installs the missing Deno APIs onto the shim's \`Deno\` global. No-op on Deno. */
export function installNodeDenoCompat(): void {
  const deno = denoGlobal as AnyDeno;
  if (!isNodeRuntime(deno)) return;

  // Expose it globally too, for code that reaches \`globalThis.Deno\`.
  if (typeof (globalThis as any).Deno === "undefined") {
    (globalThis as any).Deno = deno;
  }`;
  const installNew = `/** Installs the Deno namespace (shim + extensions) as a process global. */
export function installNodeDenoCompat(): void {
  const deno = denoNamespace as AnyDeno;

  // Expose it globally, for code that reaches \`Deno.*\` as a global reference.
  (globalThis as any).Deno = deno;`;
  if (out.includes(installOld)) out = out.replace(installOld, installNew);

  const tailOld = `if (isNodeRuntime(denoGlobal as AnyDeno)) {
  installNodeDenoCompat();
}`;
  if (out.includes(tailOld)) out = out.replace(tailOld, "installNodeDenoCompat();");

  return out;
}

// ─── Driver helpers ────────────────────────────────────────────────────────

function walk(dir) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else collect(p);
  }
}

function collect(file) {
  if (!/\.tsx?$/.test(file)) return;
  if (SELF_EXCLUDED.has(file)) return;
  sources.set(file, readFileSync(file, "utf8"));
}

function put(file, text) {
  if (sources.get(file) !== text) sources.set(file, text);
}

function writeOut() {
  for (const [file, text] of sources) {
    const original = readFileSync(file, "utf8");
    if (original === text) continue;
    stats.files++;
    if (!DRY) writeFileSync(file, text);
  }
}

function report() {
  console.log(
    [
      `${stats.files} file(s)${DRY ? " would change" : " changed"}`,
      `${stats.compat} compat specifier(s)`,
      `${stats.tests} test declaration(s)`,
      `${stats.paramProps} parameter propert(y/ies)`,
      `${stats.enums} enum(s)`,
      `${stats.typeMarkers} type marker(s)`,
      `${stats.lintDirectives} lint directive(s)`,
    ].join(", "),
  );
}

// ─── Pass A: compat import map -> relative paths ───────────────────────────

function rewriteCompatImports(file, text) {
  if (!text.includes("@opensac/")) return text;
  return text.replace(
    /from\s+(["'])(@opensac\/[^"']+)\1/g,
    (_m, quote, specifier) => {
      const target = COMPAT_TARGETS[specifier];
      if (!target) throw new Error(`unknown compat specifier: ${specifier}`);
      stats.compat++;
      let rel = relative(dirname(file), join(ROOT, target)).split(sep).join("/");
      if (!rel.startsWith(".")) rel = "./" + rel;
      return `from ${quote}${rel}${quote}`;
    },
  );
}

// ─── Pass B: type-only markers ─────────────────────────────────────────────

/** Per-file `{ types:Set, values:Set }` derived from declarations + exports. */
function analyzeExports() {
  const info = new Map();
  for (const [file, text] of sources) {
    const types = new Set();
    const values = new Set();
    for (const m of text.matchAll(
      /^\s*(?:export\s+)?(?:declare\s+)?(type|interface)\s+([A-Za-z_$][\w$]*)/gm,
    )) {
      types.add(m[2]);
    }
    for (const m of text.matchAll(
      /^\s*export\s+(?:declare\s+)?(?:abstract\s+)?(class|function|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/gm,
    )) {
      values.add(m[2]);
    }
    // Non-inline type imports are erased too: `import type { X } from …`.
    for (const m of text.matchAll(
      /^\s*import\s+type\s+\{([\s\S]*?)\}\s+from/gm,
    )) {
      for (const part of splitList(m[1])) {
        types.add(part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim());
      }
    }
    for (const m of text.matchAll(/^\s*export\s+type\s+\{([\s\S]*?)\}/gm)) {
      for (const part of splitList(m[1])) {
        types.add(part.trim().split(/\s+as\s+/)[0].trim());
      }
    }
    info.set(file, { types, values });
  }
  // Value declarations win: a class/const sharing a type's name is a runtime binding.
  for (const entry of info.values()) {
    for (const v of entry.values) entry.types.delete(v);
  }

  // Barrel files re-export names they do not declare. Resolve each
  // `export { X } from "./y.ts"` clause transitively so a downstream importer of
  // the barrel learns that X is type-only in the original module. Iterate to a
  // fixpoint: barrels nest, and one pass over an arbitrary map order is not
  // enough when a re-export chain points backwards.
  const resolved = new Map();
  for (const [file] of sources) {
    resolved.set(file, { types: new Set(info.get(file)?.types), values: new Set(info.get(file)?.values) });
  }
  const clauses = new Map();
  for (const [file, text] of sources) {
    const list = [];
    for (const m of text.matchAll(/\bexport\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+(['"])([^'"]+?)\2/g)) {
      list.push({ wholeIsType: false, spec: m[3], names: splitList(m[1]) });
    }
    // Star re-exports forward every upstream name; record them so the fixpoint
    // below can copy the whole types/values sets.
    for (const m of text.matchAll(/^\s*export\s+(type\s+)?\*\s+from\s+(['"])([^'"]+?)\2;?$/gm)) {
      list.push({ star: true, wholeIsType: Boolean(m[1]), spec: m[3], names: [] });
    }
    clauses.set(file, list);
  }
  for (let pass = 0; pass < 16; pass++) {
    let changed = false;
    for (const [file, list] of clauses) {
      const own = resolved.get(file);
      for (const clause of list) {
        const target = resolve(dirname(file), clause.spec);
        const upstream = resolved.get(target);
        if (!upstream) continue;
        if (clause.star) {
          for (const name of upstream.types) {
            if (!own.types.has(name)) {
              own.types.add(name);
              changed = true;
            }
          }
          for (const name of upstream.values) {
            if (!own.values.has(name)) {
              own.values.add(name);
              changed = true;
            }
          }
          if (clause.wholeIsType) {
            for (const name of upstream.values) {
              own.types.add(name);
              own.values.delete(name);
              changed = true;
            }
          }
          continue;
        }
        for (const piece of clause.names) {
          const trimmed = piece.trim();
          const explicitType = clause.wholeIsType || /^type\s+/.test(trimmed);
          const local = trimmed.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
          const exported = trimmed.split(/\s+as\s+/)[1]?.trim() || local;
          if (explicitType || upstream.types.has(local)) {
            if (!own.types.has(exported)) {
              own.types.add(exported);
              changed = true;
            }
          } else if (upstream.values.has(local)) {
            if (!own.values.has(exported)) {
              own.values.add(exported);
              changed = true;
            }
          }
        }
      }
    }
    for (const entry of resolved.values()) {
      for (const v of entry.values) entry.types.delete(v);
    }
    if (!changed) break;
  }
  return resolved;
}

function markTypeOnly(text, file) {
  const info = analyzeExports();
  let out = text;
  // Local re-exports without a clause: `export { X, Y };` where X/Y are types
  // declared in this same file. Erasure removes them, so the braces must say `type`.
  out = out.replace(/^([ \t]*)export\s+\{([^}]*)\};[ \t]*$/gm, (whole, indent, list) => {
    const localTypes = info.get(file)?.types ?? new Set();
    const parts = splitList(list);
    let touched = false;
    const marked = parts.map((piece) => {
      const trimmed = piece.trim();
      if (!trimmed || /^type\s+/.test(trimmed)) return piece;
      const local = trimmed.split(/\s+as\s+/)[0].trim();
      if (localTypes.has(local)) {
        touched = true;
        stats.typeMarkers++;
        return piece.replace(trimmed, `type ${trimmed}`);
      }
      return piece;
    });
    if (!touched) return whole;
    // A clause of only type specifiers must use `export type { ... }`.
    const allTypes = marked.every((m) => /^\s*type\s+/.test(m));
    return `${indent}export ${allTypes ? "type " : ""}{${marked.join(",")}};`;
  });
  out = out.replace(
    /\bimport\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+(['"])([^'"]+?)\2/g,
    (whole, list, quote, spec) =>
      markList(whole, list, quote, spec, file, info, "import"),
  );
  out = out.replace(
    /\bexport\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+(['"])([^'"]+?)\2/g,
    (whole, list, quote, spec) =>
      markList(whole, list, quote, spec, file, info, "export"),
  );
  return out;
}

function markList(whole, list, quote, spec, file, info, kind) {
  const target = resolve(dirname(file), spec);
  if (!info.has(target)) return whole;
  const targetInfo = info.get(target);
  let touched = false;
  const parts = splitList(list).map((piece) => {
    const trimmed = piece.trim();
    if (!trimmed || /^type\s+/.test(trimmed) || /^\*\s+as\s+/.test(trimmed)) {
      return piece;
    }
    const local = trimmed.split(/\s+as\s+/)[0].trim();
    if (targetInfo.types.has(local)) {
      touched = true;
      stats.typeMarkers++;
      return piece.replace(trimmed, `type ${trimmed}`);
    }
    return piece;
  });
  if (!touched) return whole;
  const keyword = kind === "import" ? "import" : "export";
  return `${keyword} {${parts.join(",")}} from ${quote}${spec}${quote}`;
}

/** Splits a specifier list on top-level commas, preserving each piece verbatim. */
function splitList(list) {
  const out = [];
  let depth = 0;
  let current = "";
  let quote = null;
  for (const ch of list) {
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
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.filter((piece) => piece.trim().length > 0);
}

// ─── Pass C: unerasable syntax ─────────────────────────────────────────────

function rewriteParameterProperties(text) {
  if (!/\bconstructor\s*\(/.test(text)) return text;
  const ctorRe = /\bconstructor\s*\(/g;
  const edits = [];
  let m;
  while ((m = ctorRe.exec(text)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(text, open);
    if (close < 0) continue;
    const pieces = splitList(text.slice(open + 1, close));
    const props = [];
    const ordered = [];
    for (const piece of pieces) {
      const prop = parseParamProp(piece);
      if (prop) {
        props.push(prop);
        // Keep the parameter exactly as written minus its access modifiers, so
        // defaults and annotations survive into the new signature.
        const stripped = piece.replace(/^\s+/, "").replace(MODIFIER_RE, "");
        ordered.push({
          text: (piece.match(/^\s*/)?.[0] ?? "") + stripped,
          isProp: true,
        });
      } else {
        ordered.push({ text: piece, isProp: false });
      }
    }
    if (props.length === 0) continue;

    let braceStart = close + 1;
    while (braceStart < text.length && /\s/.test(text[braceStart])) braceStart++;
    if (text[braceStart] !== "{") continue;
    const bodyEnd = matchBrace(text, braceStart);
    if (bodyEnd < 0) continue;

    const indent = lineIndent(text, m.index);
    const decls = props.map((x) =>
      `${indent}${x.modifiers}${x.name}${x.optional ? "?" : ""}: ${x.type};`
    ).join("\n");
    // Assignments must run after `super(...)`, so they go at the end of the body.
    const assigns = props.map((x) => `${indent}  this.${x.name} = ${x.name};`)
      .join("\n");
    const params = ordered.map((x) => x.text.trim()).filter(Boolean).join(", ");
    const bodyInner = text.slice(braceStart + 1, bodyEnd);
    const rebuilt = `${decls}\n\n${indent}constructor(${params}) {${trimTrailing(bodyInner)}\n${assigns}\n${indent}}`;
    edits.push({ start: m.index, end: bodyEnd + 1, text: rebuilt });
    stats.paramProps += props.length;
  }
  return applyEdits(text, edits);
}

/** Removes leading/trailing blank lines but keeps the body's own indentation. */
function trimTrailing(body) {
  return body.replace(/\s*$/, "");
}

/** Applies non-overlapping splice edits, back-to-front. */
function applyEdits(text, edits) {
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

function parseParamProp(piece) {
  const trimmed = piece.trim().replace(/^\.\.\./, "");
  const m = new RegExp(
    `^(${MODIFIER_RE.source})([A-Za-z_$][\\w$]*)(\\?)?\\s*:\\s*([\\s\\S]+)$`,
  ).exec(trimmed);
  if (!m) return null;
  const [, modifiers, name, optional, type] = m;
  if (!/\b(private|public|protected|readonly)\b/.test(modifiers)) return null;
  return {
    modifiers: modifiers.replace(/\s+/g, " "),
    name,
    optional: Boolean(optional),
    type: type.trim(),
  };
}

function rewriteEnums(text) {
  if (!/^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+[A-Za-z_$]/m.test(text)) {
    return text;
  }
  return text.replace(
    /^(\s*)(export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)\s*\{([\s\S]*?)\n\1\}/gm,
    (_m, indent, exported, name, body) => {
      stats.enums++;
      const members = [];
      for (const rawLine of body.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("//") || line.startsWith("/*")) {
          members.push(rawLine);
          continue;
        }
        const m = /^([A-Za-z_$][\w$]*)\s*=\s*([^,]+?),?\s*$/.exec(line);
        if (!m) {
          members.push(rawLine);
          continue;
        }
        const value = m[2].trim().replace(/,$/, "");
        members.push(`${rawLine.match(/^\s*/)[0]}${m[1]}: ${value},`);
      }
      const inner = members.join("\n");
      const kw = exported ? "export " : "";
      return [
        `${indent}${kw}const ${name} = {`,
        inner,
        `${indent}} as const;`,
        `${indent}${kw}type ${name} = (typeof ${name})[keyof typeof ${name}];`,
      ].join("\n");
    },
  );
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

function matchBrace(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Indentation (leading whitespace) of the line containing `index`. */
function lineIndent(text, index) {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const m = /^[ \t]*/.exec(text.slice(lineStart));
  return m ? m[0] : "  ";
}

// ─── Pass D: test declarations and lint directives ─────────────────────────

function rewriteTestDeclarations(text) {
  if (!/\bDeno\.test\b/.test(text)) return text;
  let count = 0;
  let next = text.replace(/\bDeno\.test\./g, () => {
    count++;
    return "test.";
  });
  next = next.replace(/\bDeno\.test\b(?=\s*\()/g, () => {
    count++;
    return "test";
  });
  if (count === 0) return text;
  stats.tests += count;
  return ensureTestingImport(next);
}

/**
 * Adds `import { test } from "#testing";` after the last complete import
 * statement. Anchored at column 0 and terminated by `from <spec>;` so a line
 * inside a multi-line import list can never be mistaken for a statement end.
 */
function ensureTestingImport(text) {
  if (/^import\s+\{[^}]*\btest\b[^}]*\}\s+from\s+["']#testing["'];?$/m.test(text)) {
    return text;
  }
  const stmt = `import { test } from "#testing";`;
  const statementRe = /^import[\s\S]*?;$/gm;
  let lastEnd = -1;
  let m;
  while ((m = statementRe.exec(text)) !== null) {
    // Only count statements that start at column 0 (not continuation lines).
    if (m.index === 0 || text[m.index - 1] === "\n") lastEnd = m.index + m[0].length;
  }
  if (lastEnd < 0) {
    // No terminating semicolon anywhere: fall back to the final `export ...;`
    // or prepend, which keeps the module valid.
    const exportRe = /^export[\s\S]*?;$/gm;
    let e;
    let lastExport = -1;
    while ((e = exportRe.exec(text)) !== null) {
      if (e.index === 0 || text[e.index - 1] === "\n") lastExport = e.index + e[0].length;
    }
    if (lastExport < 0) return `${stmt}\n${text}`;
    return text.slice(0, lastExport) + "\n" + stmt + text.slice(lastExport);
  }
  return text.slice(0, lastEnd) + "\n" + stmt + text.slice(lastEnd);
}

function rewriteLintDirectives(text) {
  if (!text.includes("deno-lint-ignore")) return text;
  let count = 0;
  let next = text.replace(
    /^\/\/ deno-lint-ignore-file((?: [a-z0-9-]+)*)$/gm,
    (_m, rules) => {
      count++;
      const mapped = String(rules || "").trim().split(/\s+/).filter(Boolean)
        .map(mapLintRule);
      return mapped.length
        ? `/* eslint-disable ${mapped.join(", ")} */`
        : "/* eslint-disable */";
    },
  );
  next = next.replace(
    /^([^\S\n]*)\/\/ deno-lint-ignore((?: [a-z0-9-]+(?:\[[^\]]*\])?)*)$/gm,
    (_m, indent, rules) => {
      count++;
      const mapped = String(rules || "").trim().split(/\s+/).filter(Boolean)
        .map((r) => mapLintRule(r.split("[")[0]));
      return mapped.length
        ? `${indent}// eslint-disable-next-line ${mapped.join(", ")}`
        : `${indent}// eslint-disable-next-line`;
    },
  );
  stats.lintDirectives += count;
  return next;
}

function mapLintRule(rule) {
  switch (rule) {
    case "no-explicit-any":
      return "@typescript-eslint/no-explicit-any";
    case "ban-types":
      return "@typescript-eslint/ban-types";
    case "no-unused-vars":
      return "@typescript-eslint/no-unused-vars";
    case "require-await":
      return "@typescript-eslint/require-await";
    case "no-empty-interface":
      return "@typescript-eslint/no-empty-object-type";
    case "camelcase":
      return "@typescript-eslint/naming-convention";
    default:
      return rule;
  }
}
