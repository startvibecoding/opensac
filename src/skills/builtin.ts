//
// Go embeds builtin/* with go:embed. Deno has no equivalent embed API, so the
// built-in SKILL.md files are inlined into `builtin_content.ts` (generated from
// src/skills/builtin) and served through an in-memory SkillFS. The content
// mirrors that directory; regenerate it whenever the builtin skills change.

import { builtinFiles } from "./builtin_content.ts";
import type { SkillFS, SkillFSEntry } from "./skills.ts";

/** Builds an in-memory SkillFS over the embedded built-in skills. */
export function createBuiltinFS(): SkillFS {
  return {
    readFile(p: string): string | undefined {
      return builtinFiles[p];
    },
    readDir(dir: string): SkillFSEntry[] | undefined {
      const prefix = dir.endsWith("/") ? dir : dir + "/";
      const seen = new Map<string, boolean>();
      for (const key of Object.keys(builtinFiles)) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        const name = slash < 0 ? rest : rest.slice(0, slash);
        const isDir = slash >= 0;
        if (!seen.has(name)) seen.set(name, isDir);
      }
      if (seen.size === 0) return undefined;
      return [...seen].map(([name, isDir]) => ({ name, isDir }));
    },
  };
}

/** The built-in skills filesystem (first-party skills compiled into every runtime). */
export const builtinFS: SkillFS = createBuiltinFS();
