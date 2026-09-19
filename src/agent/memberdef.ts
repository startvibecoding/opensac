// Ported from internal/agent/memberdef.go.
//
// MemberDef is the agent-package view of one expert-team member: a persona
// prompt plus optional capability overrides. internal/agent never parses bundle
// files.

/** One expert-team member definition. */
export interface MemberDef {
  id: string;
  displayName: string;
  emoji: string;
  role: string; // "lead" | "member"
  description: string;
  prompt: string; // persona system prompt, injected via SystemPromptExtra
  mode: string; // ""|plan|agent|yolo|os
  tools: string[];
  maxIterations: number;
  workDir: string;
}

/**
 * MemberDefRegistry is an insertion-ordered, concurrency-safe lookup table of
 * member definitions keyed by id.
 */
export class MemberDefRegistry {
  private defs = new Map<string, MemberDef>();
  private idList: string[] = [];

  /**
   * Builds a registry from defs, preserving insertion order. undefined entries
   * and entries with an empty id are skipped; for duplicate ids the first
   * definition wins.
   */
  constructor(defs: (MemberDef | null | undefined)[]) {
    for (const def of defs) {
      if (def == null || def.id === "") continue;
      if (this.defs.has(def.id)) continue;
      this.defs.set(def.id, def);
      this.idList.push(def.id);
    }
  }

  /** Returns the member definition registered for id. */
  get(id: string): MemberDef | undefined {
    return this.defs.get(id);
  }

  /** Returns the registered member ids in insertion order (a copy). */
  ids(): string[] {
    return [...this.idList];
  }
}

/** Creates a MemberDefRegistry from defs, preserving insertion order. */
export function newMemberDefRegistry(
  defs: (MemberDef | null | undefined)[],
): MemberDefRegistry {
  return new MemberDefRegistry(defs);
}
