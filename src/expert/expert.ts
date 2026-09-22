// Ported from internal/expert/expert.go

import type { ExpertFS } from "./fs.ts";

// Supported expertType values in expert.json.
/** A single-persona bundle (manifest agentName points at the only agents/*.md). */
export const typeAgent = "agent";
/** A lead + members bundle (manifest teamInfo declares the roster). */
export const typeTeam = "team";

// Member roles within a bundle.
export const roleLead = "lead";
export const roleMember = "member";

// Source layer identifiers reported by Center.
export const sourceBuiltin = "builtin";
export const sourceGlobal = "global";
export const sourceProject = "project";

/** The only supported expert.json schema version. */
export const expertSchemaVersion = 1;

/** A bilingual zh/en text pair used by manifest metadata. */
export interface LocalizedText {
  zh: string;
  en: string;
}

/** A manifest members[] entry: pure UI persona metadata. */
export interface MemberMeta {
  id: string;
  name: LocalizedText;
  profession?: LocalizedText;
  avatar?: string;
  /** "lead" | "member" */
  role: string;
}

/** Declares the lead/member agent ids of a team bundle. */
export interface TeamInfo {
  leadAgent: string;
  memberAgents: string[];
}

/** The expert.json content of a bundle. */
export interface Manifest {
  schemaVersion: number;
  name: string;
  /** "agent" | "team" */
  expertType: string;
  /** Required for agent type; kept in sync with teamInfo.leadAgent for team. */
  agentName?: string;
  displayName: LocalizedText;
  categoryId?: string;
  quickPrompts?: LocalizedText[];
  defaultInitPrompt?: LocalizedText;
  teamInfo?: TeamInfo;
  members?: MemberMeta[];
}

/** The parsed agents/*.md frontmatter fields (persona + capability overrides). */
export interface Frontmatter {
  name: string;
  description: string;
  role: string;
  emoji: string;
  color: string;
  vibe: string;
  /** "" | plan | agent | yolo | os */
  mode: string;
  tools: string[];
  maxIterations: number;
  workDir: string;
}

/** Returns a zero-value Frontmatter with the given fallback name. */
export function newFrontmatter(name: string): Frontmatter {
  return {
    name,
    description: "",
    role: "",
    emoji: "",
    color: "",
    vibe: "",
    mode: "",
    tools: [],
    maxIterations: 0,
    workDir: "",
  };
}

/** One parsed persona definition (agents/<ID>.md). */
export interface AgentDef {
  /** = frontmatter name = agents/<ID>.md file name (without .md) */
  id: string;
  /** manifest members[] name.zh, else name.en, else ID */
  displayName: string;
  emoji: string;
  /** "lead" | "member"; manifest decision first, frontmatter fallback */
  role: string;
  description: string;
  /** markdown body (persona system prompt) */
  prompt: string;
  meta: Frontmatter;
}

/**
 * A loaded expert package. Validation failures are reported via
 * invalid/invalidReason instead of an error; loader errors are IO failures only.
 */
export interface Bundle {
  name: string;
  manifest: Manifest;
  /** all agents/*.md, key = ID */
  defs: Map<string, AgentDef>;
  invalid: boolean;
  invalidReason: string;
  /**
   * The skills/ location when the bundle carries one. For OS-directory loads it
   * is a filesystem path and skillsFS is null; for ExpertFS loads it is a slash
   * path inside skillsFS.
   */
  skillsDir: string;
  skillsFS: ExpertFS | null;
}

/** A lightweight List entry built from the manifest only. */
export interface Summary {
  name: string;
  expertType: string;
  displayName: LocalizedText;
  /** builtin | global | project */
  source: string;
  invalid: boolean;
  invalidReason?: string;
}
