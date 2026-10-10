//
// Package systeminit builds the prompt used by the /systeminit command to
// generate (or refresh) a project-level AGENTS.md guide for AI agents.

/** The slash command that triggers system initialization. */
export const COMMAND = "/systeminit";

const baseInstructions = `You are setting up this project for future AI coding agents by creating a high-quality AGENTS.md file at the repository root.

First, investigate the project thoroughly:
- Detect the primary language(s), frameworks, and project layout.
- Identify build, test, run, and lint commands (look at Makefile, package.json scripts, go.mod, pyproject.toml, Cargo.toml, etc.).
- Note important directories and what they contain.
- Infer coding conventions, architecture patterns, and any existing rules (.editorconfig, linters, existing AGENTS.md/CLAUDE.md/.cursorrules).

Then write a concise, actionable AGENTS.md at the project root with sections such as:
- Project snapshot (language, frameworks, purpose)
- Important directories
- Architecture notes
- Build / test / run commands
- Coding conventions and working rules
- Anything an agent must NOT do

Keep it focused and practical. Prefer real, verified commands and paths over guesses. If an AGENTS.md already exists, improve it in place rather than discarding useful content.`;

const interactiveInstructions = `

Before writing the file, use the \`question\` tool to ask the user a few (3-6) high-value clarifying questions about things you cannot reliably infer from the code alone, for example:
- The project's main purpose and target users
- Preferred build/test/release workflow and any commands to always or never run
- Coding conventions, formatting, or review expectations
- Constraints or guardrails agents must respect (files to avoid, no auto-commit, etc.)
- Priorities (performance, readability, backward compatibility, etc.)

Ask one focused question at a time with clear predefined options (the user can always type a custom answer). Skip questions whose answers are already obvious from the codebase. After the user answers, incorporate their guidance and write the final AGENTS.md.`;

const finalNote = `

When done, briefly summarize what you wrote and where.`;

/**
 * Returns the system-init instruction prompt. When `interactive` is true the
 * agent is told to use the question tool to clarify with the user first. `extra`
 * carries optional user-provided guidance appended as additional instructions.
 */
export function prompt(interactive: boolean, extra: string): string {
  let out = baseInstructions;
  if (interactive) out += interactiveInstructions;
  if (extra.trim() !== "") {
    out += "\n\nAdditional user instructions (follow these closely):\n";
    out += extra.trim();
  }
  out += finalNote;
  return out;
}
