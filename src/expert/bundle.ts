import * as path from "@std/path";
import {
  type AgentDef,
  type Bundle,
  expertSchemaVersion,
  type Frontmatter,
  type LocalizedText,
  type Manifest,
  type MemberMeta,
  roleLead,
  roleMember,
  typeAgent,
  typeTeam,
} from "./expert.ts";
import { cleanSlashPath, type ExpertFS } from "./fs.ts";
import { parseFrontmatter } from "./frontmatter.ts";

export const manifestFileName = "expert.json";
export const agentsDirName = "agents";
export const skillsDirName = "skills";

/** The allowed frontmatter mode set ("" = inherit session policy resolution). */
export const validModes = new Set(["", "plan", "agent", "yolo", "os"]);

/** Loads and validates an expert bundle from an OS directory. */
export function loadBundle(dir: string): Bundle {
  const cleaned = path.normalize(dir);
  return loadBundleFrom(new OsSource(cleaned), path.basename(cleaned));
}

/**
 * Loads and validates an expert bundle from dir inside fsys,
 * e.g. loadBundleFS(builtinFS, "software-company"). When dir is "." or empty
 * the bundle name is taken from the manifest itself and the directory-name
 * consistency check is skipped.
 */
export function loadBundleFS(fsys: ExpertFS, dir: string): Bundle {
  if (!fsys) {
    throw new Error("expert: filesystem is required");
  }
  const cleaned = cleanSlashPath("/" + dir.trim());
  const base = path.basename(cleaned);
  return loadBundleFrom(new FsSource(fsys, cleaned), base);
}

/** Abstracts bundle file access for OS directories and ExpertFS. */
export interface BundleSource {
  /** Returns file content, or null when the file does not exist. */
  readFile(name: string): string | null;
  /** Returns directory entry names, or null when the directory is absent. */
  listDir(name: string): string[] | null;
  statDir(name: string): boolean;
  /** Returns an externally meaningful location for a bundle-relative dir. */
  resolve(name: string): string;
  /** Returns the backing ExpertFS for FS-based sources, null otherwise. */
  fsHandle(): ExpertFS | null;
}

class OsSource implements BundleSource {
  constructor(private readonly root: string) {}

  readFile(name: string): string | null {
    try {
      return Deno.readTextFileSync(path.join(this.root, name));
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return null;
      throw err;
    }
  }

  listDir(name: string): string[] | null {
    try {
      return [...Deno.readDirSync(path.join(this.root, name))]
        .map((entry) => entry.name)
        .sort();
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return null;
      throw err;
    }
  }

  statDir(name: string): boolean {
    try {
      return Deno.statSync(path.join(this.root, name)).isDirectory;
    } catch {
      return false;
    }
  }

  resolve(name: string): string {
    return path.join(this.root, name);
  }

  fsHandle(): ExpertFS | null {
    return null;
  }
}

class FsSource implements BundleSource {
  constructor(
    private readonly fsys: ExpertFS,
    private readonly root: string,
  ) {}

  private join(name: string): string {
    return this.root === "" ? name : this.root + "/" + name;
  }

  readFile(name: string): string | null {
    return this.fsys.readFile(this.join(name)) ?? null;
  }

  listDir(name: string): string[] | null {
    const entries = this.fsys.readDir(this.join(name));
    return entries ? entries.map((entry) => entry.name).sort() : null;
  }

  statDir(name: string): boolean {
    return this.fsys.stat(this.join(name))?.isDir ?? false;
  }

  resolve(name: string): string {
    return this.join(name);
  }

  fsHandle(): ExpertFS | null {
    return this.fsys;
  }
}

/** Returns a zero-value Manifest. */
function emptyManifest(): Manifest {
  return {
    schemaVersion: 0,
    name: "",
    expertType: "",
    displayName: { zh: "", en: "" },
  };
}

function normalizeLocalized(v: unknown): LocalizedText {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    zh: typeof o.zh === "string" ? o.zh : "",
    en: typeof o.en === "string" ? o.en : "",
  };
}

function normalizeMember(v: unknown): MemberMeta {
  const o = (v ?? {}) as Record<string, unknown>;
  const member: MemberMeta = {
    id: typeof o.id === "string" ? o.id : "",
    name: normalizeLocalized(o.name),
    role: typeof o.role === "string" ? o.role : "",
  };
  if (o.profession !== undefined) {
    member.profession = normalizeLocalized(o.profession);
  }
  if (typeof o.avatar === "string") member.avatar = o.avatar;
  return member;
}

/** Normalizes raw JSON into a Manifest with zero values for absent fields. */
export function normalizeManifest(raw: unknown): Manifest {
  const o = (raw ?? {}) as Record<string, unknown>;
  const manifest: Manifest = {
    schemaVersion: typeof o.schemaVersion === "number" ? o.schemaVersion : 0,
    name: typeof o.name === "string" ? o.name : "",
    expertType: typeof o.expertType === "string" ? o.expertType : "",
    displayName: normalizeLocalized(o.displayName),
  };
  if (typeof o.agentName === "string") manifest.agentName = o.agentName;
  if (typeof o.categoryId === "string") manifest.categoryId = o.categoryId;
  if (Array.isArray(o.quickPrompts)) {
    manifest.quickPrompts = o.quickPrompts.map(normalizeLocalized);
  }
  if (o.defaultInitPrompt !== undefined) {
    manifest.defaultInitPrompt = normalizeLocalized(o.defaultInitPrompt);
  }
  if (o.teamInfo !== undefined) {
    const t = o.teamInfo as Record<string, unknown>;
    manifest.teamInfo = {
      leadAgent: typeof t.leadAgent === "string" ? t.leadAgent : "",
      memberAgents: Array.isArray(t.memberAgents)
        ? t.memberAgents.filter((x): x is string => typeof x === "string")
        : [],
    };
  }
  if (Array.isArray(o.members)) {
    manifest.members = o.members.map(normalizeMember);
  }
  return manifest;
}

/** The shared load+validation core. */
function loadBundleFrom(src: BundleSource, dirName: string): Bundle {
  if (dirName === "." || dirName === "/") {
    dirName = "";
  }
  const data = src.readFile(manifestFileName);
  if (data === null) {
    return invalidBundle(
      dirName,
      emptyManifest(),
      manifestFileName + " 不存在",
    );
  }
  let manifest: Manifest;
  try {
    manifest = normalizeManifest(JSON.parse(data));
  } catch (err) {
    return invalidBundle(
      dirName,
      emptyManifest(),
      `${manifestFileName} 解析失败: ${err}`,
    );
  }
  // Rule 1: schemaVersion, non-empty name, directory-name consistency.
  {
    const reason = validateManifest(manifest, dirName);
    if (reason !== "") {
      const name = manifest.name !== "" ? manifest.name : dirName;
      return invalidBundle(name, manifest, reason);
    }
  }
  const agentIDs = listAgentIDs(src);
  // Rules 2-4: expertType-specific structural checks.
  const have = new Set(agentIDs);
  {
    const reason = validateStructure(manifest, have);
    if (reason !== "") return invalidBundle(manifest.name, manifest, reason);
  }
  // Rules 5-6: parse every agents/*.md; unreferenced files load into defs
  // without affecting validity.
  const defs = new Map<string, AgentDef>();
  for (const id of agentIDs) {
    const { def, reason } = loadAgentDef(src, id);
    if (reason !== "") return invalidBundle(manifest.name, manifest, reason);
    defs.set(id, def as AgentDef);
  }
  assignRoles(manifest, defs);
  applyDisplayNames(manifest, defs);
  const bundle: Bundle = {
    name: manifest.name,
    manifest,
    defs,
    invalid: false,
    invalidReason: "",
    skillsDir: "",
    skillsFS: null,
  };
  // Rule 7: expose the optional skills/ source.
  if (src.statDir(skillsDirName)) {
    bundle.skillsDir = src.resolve(skillsDirName);
    bundle.skillsFS = src.fsHandle();
  }
  return bundle;
}

/** Applies manifest-level checks that do not require the agents/ directory. */
export function validateManifest(m: Manifest, dirName: string): string {
  if (m.schemaVersion !== expertSchemaVersion) {
    return `schemaVersion 必须为 ${expertSchemaVersion}，实际为 ${m.schemaVersion}`;
  }
  if (m.name.trim() === "") {
    return "manifest name 不能为空";
  }
  if (dirName !== "" && m.name !== dirName) {
    return `manifest name ${quote(m.name)} 与包目录名 ${quote(dirName)} 不一致`;
  }
  return "";
}

/** Applies the expertType-specific checks (spec rules 2-4). */
export function validateStructure(
  m: Manifest,
  haveAgentFile: Set<string>,
): string {
  switch (m.expertType) {
    case typeTeam: {
      if (m.teamInfo === undefined) {
        return "expertType team 必须提供 teamInfo";
      }
      const lead = m.teamInfo.leadAgent.trim();
      if (lead === "") {
        return "teamInfo.leadAgent 不能为空";
      }
      if (!haveAgentFile.has(lead)) {
        return `teamInfo.leadAgent ${quote(lead)} 缺少对应的 agents/${lead}.md`;
      }
      const seen = new Set<string>();
      for (const member of m.teamInfo.memberAgents) {
        if (member === lead) {
          return `memberAgents 不能包含 leadAgent ${quote(lead)}`;
        }
        if (member === "") {
          return "memberAgents 含空项";
        }
        if (seen.has(member)) {
          return `memberAgents 含重复项 ${quote(member)}`;
        }
        seen.add(member);
        if (!haveAgentFile.has(member)) {
          return `memberAgents ${quote(member)} 缺少对应的 agents/${member}.md`;
        }
      }
      return "";
    }
    case typeAgent: {
      const name = (m.agentName ?? "").trim();
      if (name === "") {
        return "expertType agent 必须提供 agentName";
      }
      if (!haveAgentFile.has(name)) {
        return `agentName ${quote(name)} 缺少对应的 agents/${name}.md`;
      }
      return "";
    }
    case "skill":
      return '不支持 expertType "skill"：skill 型由 skills/skillhub 承载，请走技能机制分发';
    default:
      return `不支持的 expertType ${quote(m.expertType)}（仅支持 agent/team）`;
  }
}

/** Returns sorted ids (md file names without extension) present in agents/. */
export function listAgentIDs(src: BundleSource): string[] {
  const names = src.listDir(agentsDirName);
  if (names === null) return [];
  const ids = names
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3));
  ids.sort();
  return ids;
}

/** Parses one agents/<id>.md (spec rule 5). */
export function loadAgentDef(
  src: BundleSource,
  id: string,
): { def: AgentDef | null; reason: string } {
  const fileName = id + ".md";
  const data = src.readFile(agentsDirName + "/" + fileName);
  if (data === null) {
    return { def: null, reason: `agents/${fileName} 不存在` };
  }
  let parsed: { frontmatter: Frontmatter; prompt: string };
  try {
    parsed = parseFrontmatter(data, id);
  } catch (err) {
    return {
      def: null,
      reason: `agents/${fileName}: frontmatter 解析失败: ${err}`,
    };
  }
  const fm = parsed.frontmatter;
  if (fm.name !== id) {
    return {
      def: null,
      reason: `agents/${fileName}: frontmatter name ${
        quote(fm.name)
      } 与文件名不一致`,
    };
  }
  if (!validModes.has(fm.mode)) {
    return {
      def: null,
      reason: `agents/${fileName}: mode ${
        quote(fm.mode)
      } 非法（允许：空、plan、agent、yolo、os）`,
    };
  }
  if (fm.maxIterations < 0) {
    return {
      def: null,
      reason:
        `agents/${fileName}: max_iterations 不能为负数（${fm.maxIterations}）`,
    };
  }
  const def: AgentDef = {
    id,
    displayName: "",
    emoji: fm.emoji,
    role: "",
    description: fm.description,
    prompt: parsed.prompt,
    meta: fm,
  };
  return { def, reason: "" };
}

/**
 * Resolves def.role: manifest decision first (team leadAgent / memberAgents,
 * agent agentName), frontmatter role only as fallback.
 */
export function assignRoles(
  m: Manifest,
  defs: Map<string, AgentDef>,
): void {
  switch (m.expertType) {
    case typeTeam: {
      if (m.teamInfo !== undefined) {
        const lead = defs.get(m.teamInfo.leadAgent);
        if (lead) lead.role = roleLead;
        for (const id of m.teamInfo.memberAgents) {
          const def = defs.get(id);
          if (def) def.role = roleMember;
        }
      }
      break;
    }
    case typeAgent: {
      const def = defs.get(m.agentName ?? "");
      if (def) def.role = roleLead;
      break;
    }
  }
  for (const def of defs.values()) {
    if (def.role === "") def.role = def.meta.role;
  }
}

/** Resolves def.displayName: manifest members[] name.zh, else name.en, else ID. */
export function applyDisplayNames(
  m: Manifest,
  defs: Map<string, AgentDef>,
): void {
  for (const meta of m.members ?? []) {
    const def = defs.get(meta.id);
    if (!def) continue;
    const zh = meta.name.zh.trim();
    if (zh !== "") {
      def.displayName = zh;
      continue;
    }
    const en = meta.name.en.trim();
    if (en !== "") {
      def.displayName = en;
    }
  }
  for (const [id, def] of defs) {
    if (def.displayName === "") def.displayName = id;
  }
}

function invalidBundle(
  name: string,
  manifest: Manifest,
  reason: string,
): Bundle {
  return {
    name,
    manifest,
    defs: new Map(),
    invalid: true,
    invalidReason: reason,
    skillsDir: "",
    skillsFS: null,
  };
}

/** Formats a value in the Go %q style used by validation messages. */
function quote(s: string): string {
  return JSON.stringify(s);
}
