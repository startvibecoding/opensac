import type { Manager as SkillsManager } from "../skills/mod.ts";
import {
  createTextToolResult,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./tool.ts";

/** Loads on-demand reference files from skills. */
export class SkillRefTool implements Tool {
  #skillsMgr: SkillsManager;

  constructor(skillsMgr: SkillsManager) {
    this.#skillsMgr = skillsMgr;
  }

  name(): string {
    return "skill_ref";
  }

  description(): string {
    return "Load a reference file from an active skill. Use this to access on-demand knowledge from skills that have reference files (e.g. references/audio.md).";
  }

  promptSnippet(): string {
    return "Load reference files from skills";
  }

  promptGuidelines(): string[] {
    return [];
  }

  parameters(): unknown {
    return {
      type: "object",
      properties: {
        skill: {
          type: "string",
          description: "The skill name (directory name)",
        },
        ref: {
          type: "string",
          description:
            "The reference file path relative to the skill directory (e.g. 'references/audio.md')",
        },
      },
      required: ["skill", "ref"],
    };
  }

  execute(_ctx: ToolContext, params: Record<string, unknown>): ToolResult {
    const skillName = params["skill"];
    if (typeof skillName !== "string" || skillName === "") {
      throw new Error("missing required parameter: skill");
    }

    const refPath = params["ref"];
    if (typeof refPath !== "string" || refPath === "") {
      throw new Error("missing required parameter: ref");
    }

    const content = this.#skillsMgr.loadReference(skillName, refPath);
    if (content === undefined) {
      const refs = this.#skillsMgr.listReferences(skillName);
      if (refs === undefined) {
        throw new Error(`skill '${skillName}' not found`);
      }
      let available = "";
      for (const r of refs) {
        let status = "on-demand";
        if (r.autoLoad) status = "auto-loaded";
        if (r.loaded) status = "loaded";
        available += `  - ${r.path} (${status}): ${r.label}\n`;
      }
      throw new Error(
        `reference '${refPath}' not found in skill '${skillName}'. Available references:\n${available}`,
      );
    }

    return createTextToolResult(content);
  }
}
