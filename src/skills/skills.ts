//
// Go's io/fs + go:embed is replaced by a small `SkillFS` interface (used for
// embedded built-in skills) plus direct Deno FS access for project/global dirs.

import * as path from "@std/path";
import * as posix from "@std/path/posix";
import { loadGlobalSettingsSparse, skillsDisabled } from "../config/mod.ts";
import { builtinFS as defaultBuiltinFS } from "./builtin.ts";

/** A directory entry returned by a SkillFS. */
export interface SkillFSEntry {
  name: string;
  isDir: boolean;
}

/** Minimal filesystem abstraction for embedded (non-OS) skill sources. */
export interface SkillFS {
  /** Lists entries below `dir`, or undefined when the directory is missing. */
  readDir(dir: string): SkillFSEntry[] | undefined;
  /** Reads a file, or undefined when it is missing. */
  readFile(file: string): string | undefined;
}

/** A reference file within a skill. */
export interface SkillReference {
  /** Relative path (e.g. "references/audio.md"). */
  path: string;
  /** Absolute (or FS) path. */
  fullPath: string;
  /** Display label (e.g. "音频"). */
  label: string;
  /** True if marked [已加载], false if [待按需加载]. */
  autoLoad: boolean;
  /** Whether this reference has been loaded. */
  loaded: boolean;
  /** Loaded content. */
  content: string;
  /** Backing FS when the skill came from an embedded source. */
  fs?: SkillFS;
}

/** A loaded skill. */
export interface Skill {
  /** Skill name (directory name). */
  name: string;
  /** Path to SKILL.md. */
  path: string;
  /** Skill directory. */
  dir: string;
  /** First line or heading description. */
  description: string;
  /** Full SKILL.md content. */
  content: string;
  /** "global" or "project" (or "builtin"). */
  source: string;
  /** Parsed references. */
  references: SkillReference[];
  /** Backing FS when the skill came from an embedded source. */
  fs?: SkillFS;
  /** FS-relative skill directory. */
  fsDir?: string;
}

/** Name of the built-in expert-creater guide skill. */
export const expertCreaterSkillName = "expert-creater";

// ── OS helpers ──────────────────────────────────────────────────────────────

function readFileOS(p: string): string | undefined {
  try {
    return Deno.readTextFileSync(p);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    return undefined;
  }
}

function readDirOS(dir: string): SkillFSEntry[] | undefined {
  try {
    const out: SkillFSEntry[] = [];
    for (const entry of Deno.readDirSync(dir)) {
      out.push({ name: entry.name, isDir: entry.isDirectory });
    }
    return out;
  } catch {
    return undefined;
  }
}

function isDirOS(p: string): boolean {
  try {
    return Deno.statSync(p).isDirectory;
  } catch {
    return false;
  }
}

// ── Manager ─────────────────────────────────────────────────────────────────

/** Manages skill discovery and loading. */
export class Manager {
  readonly globalDir: string;
  readonly projectDir: string;
  readonly projectDirs: string[];
  readonly skills: Map<string, Skill> = new Map();
  disabled = new Set<string>();

  constructor(globalDir: string, projectDirs: string[]) {
    this.globalDir = globalDir;
    this.projectDirs = dedupeDirs(projectDirs);
    this.projectDir = this.projectDirs.length > 0 ? this.projectDirs[0] : "";
  }

  /** Discovers built-in, global, and project skills (project > global > builtin). */
  load(builtinFS: SkillFS = defaultBuiltinFS): void {
    this.loadFS(builtinFS, "builtin", "builtin");

    if (this.globalDir !== "") {
      // Non-fatal on error.
      this.loadFromDir(this.globalDir, "global");
    }

    for (let i = this.projectDirs.length - 1; i >= 0; i--) {
      const dir = this.projectDirs[i];
      if (dir === "") continue;
      this.loadFromDir(dir, "project");
    }

    this.applyConfiguredDisabledSkills();
  }

  private applyConfiguredDisabledSkills(): void {
    try {
      const settings = loadGlobalSettingsSparse();
      this.setDisabledSkills(skillsDisabled(settings) ?? []);
    } catch {
      // ignore
    }
  }

  /** Replaces the disabled-skill set. */
  setDisabledSkills(names: string[]): void {
    const next = new Set<string>();
    for (const name of names) {
      const trimmed = name.trim();
      if (trimmed !== "") next.add(trimmed);
    }
    this.disabled = next;
  }

  /** Returns the sorted disabled-skill names. */
  disabledSkills(): string[] {
    return [...this.disabled].sort();
  }

  /** Reports whether a skill name is toggled off. */
  isSkillDisabled(name: string): boolean {
    return this.disabled.has(name);
  }

  private loadFromDir(dir: string, source: string): void {
    if (!isDirOS(dir)) return;
    const entries = readDirOS(dir);
    if (entries === undefined) return;

    for (const entry of entries) {
      if (!entry.isDir) continue;
      const skillDir = path.join(dir, entry.name);
      let skillFile = path.join(skillDir, "SKILL.md");
      let data = readFileOS(skillFile);
      if (data === undefined) {
        skillFile = path.join(skillDir, "skill.md");
        data = readFileOS(skillFile);
        if (data === undefined) continue;
      }
      const skill: Skill = {
        name: entry.name,
        path: skillFile,
        dir: skillDir,
        content: data,
        source,
        description: extractDescription(data),
        references: parseReferences(data, skillDir, undefined),
      };
      this.skills.set(entry.name, skill);
    }
  }

  /** Discovers skills below `dir` in an embedded filesystem. */
  loadFS(fsys: SkillFS | undefined, dir: string, source: string): void {
    if (!fsys) throw new Error("skills filesystem is required");
    dir = posix.normalize(dir);
    if (dir === "." || dir.startsWith("../") || posix.isAbsolute(dir)) {
      throw new Error(
        `invalid skills filesystem directory ${JSON.stringify(dir)}`,
      );
    }
    const entries = fsys.readDir(dir);
    if (entries === undefined) return;
    for (const entry of entries) {
      if (!entry.isDir) continue;
      const skillDir = posix.join(dir, entry.name);
      let skillFile = posix.join(skillDir, "SKILL.md");
      let data = fsys.readFile(skillFile);
      if (data === undefined) {
        skillFile = posix.join(skillDir, "skill.md");
        data = fsys.readFile(skillFile);
        if (data === undefined) continue;
      }
      const skill: Skill = {
        name: entry.name,
        path: skillFile,
        dir: skillDir,
        content: data,
        source,
        description: extractDescription(data),
        references: parseReferences(data, skillDir, fsys),
        fs: fsys,
        fsDir: skillDir,
      };
      this.skills.set(entry.name, skill);
    }
  }

  /** Returns an enabled skill by name. */
  get(name: string): Skill | undefined {
    if (this.isSkillDisabled(name)) return undefined;
    return this.skills.get(name);
  }

  /** Returns all enabled skills sorted by name. */
  list(): Skill[] {
    const result: Skill[] = [];
    for (const s of this.skills.values()) {
      if (this.isSkillDisabled(s.name)) continue;
      result.push(s);
    }
    return result.sort((
      a,
      b,
    ) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Returns every discovered skill sorted by name, including disabled ones. */
  listAll(): Skill[] {
    return [...this.skills.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
  }

  /** Returns enabled skills filtered by source. */
  listBySource(source: string): Skill[] {
    const result: Skill[] = [];
    for (const s of this.skills.values()) {
      if (s.source === source && !this.isSkillDisabled(s.name)) result.push(s);
    }
    return result.sort((
      a,
      b,
    ) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Returns all enabled skill names sorted. */
  names(): string[] {
    const names: string[] = [];
    for (const name of this.skills.keys()) {
      if (this.isSkillDisabled(name)) continue;
      names.push(name);
    }
    return names.sort();
  }

  /** Returns the content of a skill for injection into the system prompt. */
  buildSkillContext(name: string): string {
    const skill = this.get(name);
    if (!skill) return "";

    let out = `\n## Active Skill: ${skill.name}\n\n${skill.content}\n`;

    for (const ref of skill.references) {
      if (ref.autoLoad) {
        const content = loadReferenceContent(ref);
        if (content !== "") {
          ref.loaded = true;
          ref.content = content;
          out += `\n### Reference: ${ref.label}\n\n${content}\n`;
        }
      }
    }

    let hasOnDemand = false;
    const onDemandRefs: string[] = [];
    for (const ref of skill.references) {
      if (!ref.autoLoad) {
        if (!hasOnDemand) {
          out += "\n### On-Demand References\n\n";
          out +=
            "The following references are available but not loaded. Use the `skill_ref` tool to load them when needed:\n\n";
          hasOnDemand = true;
        }
        onDemandRefs.push(`- \`${ref.path}\` (${ref.label})`);
      }
    }
    if (hasOnDemand) out += onDemandRefs.join("\n") + "\n";

    return out;
  }

  /** Loads a specific reference file by path for a skill. */
  loadReference(skillName: string, refPath: string): string | undefined {
    const skill = this.get(skillName);
    if (!skill) return undefined;

    refPath = path.normalize(refPath);
    for (const ref of skill.references) {
      if (ref.path === refPath || path.normalize(ref.path) === refPath) {
        if (ref.loaded) return ref.content;
        const content = loadReferenceContent(ref);
        if (content !== "") {
          ref.loaded = true;
          ref.content = content;
          return content;
        }
        return undefined;
      }
    }

    let data: string | undefined;
    let fullPath: string;
    if (skill.fs) {
      const rel = posix.normalize(refPath.replaceAll("\\", "/"));
      if (
        rel === "." || rel === ".." || rel.startsWith("../") ||
        posix.isAbsolute(rel)
      ) {
        return undefined;
      }
      fullPath = posix.join(skill.fsDir ?? "", rel);
      data = skill.fs.readFile(fullPath);
    } else {
      fullPath = path.normalize(path.join(skill.dir, refPath));
      const rel = path.relative(path.normalize(skill.dir), fullPath);
      if (
        rel === ".." || rel.startsWith(".." + path.SEPARATOR) ||
        path.isAbsolute(rel)
      ) {
        return undefined;
      }
      data = readFileOS(fullPath);
    }
    if (data === undefined) return undefined;

    skill.references.push({
      path: refPath,
      fullPath,
      label: refPath,
      autoLoad: false,
      loaded: true,
      content: data,
      fs: skill.fs,
    });
    return data;
  }

  /** Returns the reference files for a skill with their load status. */
  listReferences(skillName: string): SkillReference[] | undefined {
    return this.get(skillName)?.references;
  }

  /** Returns a summary of all available skills for the system prompt. */
  buildAllSkillsContext(): string {
    const skills = this.list();
    if (skills.length === 0) return "";

    let out = "\n## Available Skills\n\n";
    out += "Use `/skill:<name>` to load a skill. Available skills:\n\n";
    for (const s of skills) {
      out += `- **${s.name}** (${s.source}): ${s.description}\n`;
    }
    out += "\n";
    return out;
  }
}

/** Creates a new skills manager from an explicit project directory list. */
export function createManager(
  globalDir: string,
  projectDirs: string[],
): Manager {
  return new Manager(globalDir, projectDirs);
}

/** Returns project-local skill directories in priority order. */
export function projectSkillDirs(projectRoot: string): string[] {
  if (projectRoot === "") return [];
  return [
    path.join(projectRoot, ".opensac", "skills"),
    path.join(projectRoot, ".skills"),
    path.join(projectRoot, ".agents", "skills"),
    path.join(projectRoot, "skills"),
  ];
}

function dedupeDirs(dirs: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (dir === "") continue;
    const clean = path.normalize(dir);
    if (seen.has(clean)) continue;
    seen.add(clean);
    result.push(dir);
  }
  return result;
}

function loadReferenceContent(ref: SkillReference): string {
  if (ref.fs) return ref.fs.readFile(ref.fullPath) ?? "";
  return readFileOS(ref.fullPath) ?? "";
}

/** Parses reference links from SKILL.md content. */
export function parseReferences(
  content: string,
  skillDir: string,
  fsys: SkillFS | undefined,
): SkillReference[] {
  const refs: SkillReference[] = [];
  const seen = new Set<string>();

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();

    if (line.startsWith("###")) {
      const pathStart = line.indexOf("(");
      const pathEnd = line.indexOf(")");
      if (pathStart > 0 && pathEnd > pathStart) {
        const refPath = line.slice(pathStart + 1, pathEnd);
        if (refPath.endsWith(".md") || refPath.endsWith(".txt")) {
          const fullPath = skillReferencePath(skillDir, refPath, fsys);
          if (!seen.has(refPath)) {
            seen.add(refPath);
            let label = line.replace(/^#+/, "").trim();
            const idx = label.indexOf("(");
            if (idx > 0) {
              label = label.slice(0, idx).trim();
              label = label.replace(/^[0-9. ]+/, "");
            }
            const autoLoad = line.includes("[已加载]");
            refs.push({
              path: refPath,
              fullPath,
              label,
              autoLoad,
              loaded: false,
              content: "",
              fs: fsys,
            });
          }
        }
      }
    }

    if (
      line.startsWith("-") && line.includes("[") && line.includes("](")
    ) {
      const linkStart = line.indexOf("](");
      const linkEnd = line.slice(linkStart + 2).indexOf(")");
      if (linkStart > 0 && linkEnd > 0) {
        const refPath = line.slice(linkStart + 2, linkStart + 2 + linkEnd);
        if (
          (refPath.endsWith(".md") || refPath.endsWith(".txt")) &&
          !seen.has(refPath)
        ) {
          seen.add(refPath);
          const fullPath = skillReferencePath(skillDir, refPath, fsys);
          const labelStart = line.indexOf("[");
          let label = "";
          if (labelStart >= 0 && labelStart < linkStart) {
            label = line.slice(labelStart + 1, linkStart);
          }
          refs.push({
            path: refPath,
            fullPath,
            label,
            autoLoad: false,
            loaded: false,
            content: "",
            fs: fsys,
          });
        }
      }
    }
  }

  return refs;
}

function skillReferencePath(
  skillDir: string,
  referencePath: string,
  fsys: SkillFS | undefined,
): string {
  if (fsys) return posix.join(skillDir, referencePath.replaceAll("\\", "/"));
  return path.join(skillDir, referencePath);
}

/** Extracts a short description from skill content. */
export function extractDescription(content: string): string {
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith("#")) return line.replace(/^[# ]+/, "");
    return line;
  }
  return "(no description)";
}

/** Creates the .skills directory in the project root. */
export function createProjectSkillsDir(projectDir: string): void {
  Deno.mkdirSync(path.join(projectDir, ".skills"), { recursive: true });
}
