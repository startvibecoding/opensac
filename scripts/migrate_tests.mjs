// One-shot migration codemod: Deno CLI test surface -> node:test via #testing.
// Run with: node scripts/migrate_tests.mjs
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["src", "sdk", "examples", "scripts"];
const EXCLUDE = new Set(["node_modules", "dist", "bin", ".git"]);

function files(dir) {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (EXCLUDE.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

let changed = 0;
let decls = 0;
for (const root of ROOTS) {
  for (const file of files(root)) {
    const original = readFileSync(file, "utf8");
    let text = original;

    // 1. `Deno.test(` -> `test(`
    const before = (text.match(/\bDeno\.test\s*[.(]/g) || []).length;
    text = text.replace(/\bDeno\.test\./g, "test.");
    text = text.replace(/\bDeno\.test\b(?=\s*\()/g, "test");
    decls += before;

    if (before > 0) {
      // 2. Ensure `import { test } from "#testing";` exists (after last import).
      if (!/^import .*["']#testing["'];?$/m.test(text)) {
        const names = new Set();
        const existing = text.match(/^import \{([^}]*)\} from ["']#testing["'];?$/m);
        if (existing) {
          for (const n of existing[1].split(",")) {
            const t = n.trim();
            if (t) names.add(t);
          }
          text = text.replace(existing[0], "");
        }
        names.add("test");
        const stmt = `import { ${[...names].sort().join(", ")} } from "#testing";`;
        const imports = [...text.matchAll(/^[^\S\n]*import[^\n]*$/gm)];
        const last = imports[imports.length - 1];
        if (last) {
          const end = last.index + last[0].length;
          text = text.slice(0, end) + "\n" + stmt + text.slice(end);
        } else {
          text = stmt + "\n" + text;
        }
      }
    }

    // 3. Deno lint directives -> eslint equivalents.
    text = text.replace(
      /^\/\/ deno-lint-ignore-file((?: [a-z0-9-]+)*)$/gm,
      (_m, rules) => {
        const list = String(rules || "").trim().split(/\s+/).filter(Boolean);
        const mapped = list.map(mapRule).filter(Boolean);
        return mapped.length
          ? `/* eslint-disable ${mapped.join(", ")} */`
          : "/* eslint-disable */";
      },
    );
    text = text.replace(
      /^([^\S\n]*)\/\/ deno-lint-ignore((?: [a-z0-9-]+(?:\[[^\]]*\])?)*)$/gm,
      (_m, indent, rules) => {
        const list = String(rules || "").trim().split(/\s+/).filter(Boolean);
        const mapped = list.map((r) => mapRule(r.split("[")[0])).filter(Boolean);
        return mapped.length
          ? `${indent}// eslint-disable-next-line ${mapped.join(", ")}`
          : `${indent}// eslint-disable-next-line`;
      },
    );

    // 4. Prose mentions of the removed shim.
    text = text.replace(/@deno\/shim-deno/g, "src/platform/node_compat.ts");

    if (text !== original) {
      writeFileSync(file, text);
      changed++;
    }
  }
}
console.log(`rewrote ${changed} files, ${decls} test declarations`);

function mapRule(rule) {
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
    case "prefer-as-const":
      return "@typescript-eslint/as-const-satisfies";
    case "camelcase":
      return "@typescript-eslint/naming-convention";
    case "no-var":
      return "no-var";
    default:
      return rule;
  }
}
