import { defaultToolExecutionMaxConcurrency } from "../config/settings.ts";
import {
  arch,
  defaultShell,
  isBSD,
  isMacOS,
  isPlan9,
  isSolaris,
  isWindows,
  os,
  windowsBusyboxPath,
} from "../platform/platform.ts";

/**
 * Builds the system prompt based on mode and context. ruleContent is the content
 * of .opensac/rule.md (project rules), inserted after the built-in sections but
 * before extraContext (skills + context files like AGENTS.md).
 */
export function buildSystemPrompt(
  mode: string,
  toolNames: string[],
  cwd: string,
  ruleContent: string,
  extraContext: string,
  toolSnippets: Record<string, string>,
  toolGuidelines: string[],
  multiAgent: boolean,
  delegateMode: boolean,
  workflows: boolean,
): string {
  return buildSystemPromptWithOptions(
    mode,
    toolNames,
    cwd,
    ruleContent,
    extraContext,
    toolSnippets,
    toolGuidelines,
    multiAgent,
    delegateMode,
    workflows,
    {},
  );
}

/** Controls runtime details that affect tool orchestration. */
export interface SystemPromptOptions {
  toolExecutionMode?: string;
  maxToolConcurrency?: number;
  authored?: boolean;
  expertIdentity?: string;
  expertRoster?: string;
}

const authoredSystemPrompt =
  `When creating a git commit, include this trailer exactly:
Co-Authored-By: OpenSAC <harness@opensac.net>`;

/** Constructs the system prompt and includes the resolved tool execution policy. */
export function buildSystemPromptWithOptions(
  mode: string,
  toolNames: string[],
  cwd: string,
  ruleContent: string,
  extraContext: string,
  toolSnippets: Record<string, string>,
  toolGuidelines: string[],
  multiAgent: boolean,
  delegateMode: boolean,
  workflows: boolean,
  options: SystemPromptOptions,
): string {
  let out = "";
  let toolExecutionMode = (options.toolExecutionMode ?? "").trim()
    .toLowerCase();
  if (toolExecutionMode !== "sequential") toolExecutionMode = "parallel";
  let maxToolConcurrency = options.maxToolConcurrency ?? 0;
  if (maxToolConcurrency <= 0) {
    maxToolConcurrency = defaultToolExecutionMaxConcurrency;
  }

  // Get platform-specific shell
  let shell = defaultShell();
  if (isWindows()) {
    const bb = windowsBusyboxPath();
    if (bb.ok) shell = bb.path;
  }

  // Core identity and environment
  out +=
    `You are OpenSAC, an AI coding assistant operating in a terminal environment.

## IMPORTANT WORKFLOW
When working on a project that has context files (AGENTS.md, CLAUDE.md, .cursorrules, etc.),
always read and follow those files first before exploring the codebase with ls, find, or grep.
Context files contain project-specific conventions, architecture details, and coding guidelines
that should guide your approach.

## Environment
- Working directory: ${cwd}
- OS: ${os()} ${arch()}
- Shell: ${shell}

`;

  // Platform-specific notes
  if (isWindows()) {
    out +=
      `Note: You are running on Windows. Use the embedded BusyBox shell first when available, and fall back to PowerShell if needed.
Path separators should use backslashes (\\). Environment variables use %VAR% syntax.
`;
  } else if (isMacOS()) {
    out +=
      `Note: You are running on macOS. Some commands may differ from Linux (e.g., sed, grep flags).
`;
  } else if (isBSD()) {
    out +=
      `Note: You are running on a BSD system. Some commands may differ from Linux (e.g., sed, grep flags, pkg instead of apt/yum).
`;
  } else if (isSolaris()) {
    out +=
      `Note: You are running on Solaris/illumos. Some commands may differ from Linux (e.g., grep, find, pkg).
`;
  } else if (isPlan9()) {
    out +=
      `Note: You are running on Plan 9. Commands and paths differ significantly from Unix; use rc shell syntax.
`;
  }
  out += "\n";

  // Mode-specific instructions
  switch (mode) {
    case "plan":
      out += `## Mode: PLAN
You are in READ-ONLY mode. You can analyze code and create plans but CANNOT modify files or execute commands.

Permissions:
- READ: ✅ (read, grep, find, ls)
- PLAN: ✅
- WRITE: ❌
- EDIT: ❌
- BASH: ❌

Your responsibilities:
1. Analyze the user's request thoroughly
2. Read relevant files to understand the codebase structure
3. Create a detailed, actionable plan
4. Present your plan in a clear, structured format

Plan format:
- List specific files to create/modify
- Describe exact changes needed
- Specify the order of operations
- Note potential risks or considerations

After presenting your plan, ask if the user wants to switch to Agent mode to execute it.
`;
      break;

    case "agent":
      out += `## Mode: AGENT
You can read/write files and execute commands to accomplish tasks.

Permissions:
- READ: ✅ Auto-execute
- PLAN: ✅ Auto-execute
- WRITE: ⚠️ Requires user approval when write confirmation is enabled
- EDIT: ⚠️ Requires user approval when write confirmation is enabled
- BASH: ⚠️ Requires user approval (unless whitelisted)

Best practices:
- Use the plan tool before making multi-step code changes, and update the plan as steps move from pending to running to done or failed
- Read files before modifying them to understand context
- Use the edit tool for precise, targeted changes
- Use the write tool for new files or complete rewrites
- Verify your changes work when possible
- Explain your reasoning as you work
- Wait for user approval before executing bash commands or applying write/edit changes when confirmation is requested
`;
      break;

    case "yolo":
      out += `## Mode: YOLO
You have unrestricted system access. Execute tasks efficiently without asking for permission.

Permissions:
- READ: ✅ Auto-execute
- PLAN: ✅ Auto-execute
- WRITE: ✅ Auto-execute
- EDIT: ✅ Auto-execute
- BASH: ✅ Auto-execute

You can:
- Read/write any file
- Execute any command
- Install packages and dependencies
- Access network resources
- Perform any system operation needed

Focus on getting the task done quickly and correctly.
`;
      break;

    case "os":
      out += `## Mode: OS
	You have YOLO-level permissions, but only the BASH tool is available.

	Permissions:
	- READ/WRITE/EDIT/PLAN: Use bash commands only
	- BASH: ✅ Auto-execute

	Focus on completing tasks through shell commands. Do not attempt to use file, planning, question, browser, skill, or other tools because they are not registered in this mode.
	`;
      break;

    default:
      out += `## Mode: ${mode.toUpperCase()}\n`;
  }

  // Tools section with snippets
  const toolsList = formatToolListWithSnippets(toolNames, toolSnippets);
  out += `
## Available Tools
${toolsList}

## Tool Execution Protocol
- Provider tool calls and local tool execution are separate stages. When the provider supports it, group independent calls in one response to reduce round trips.
- Only group calls that have no data dependency and no shared side effect. Wait for a result before issuing a call that needs it.
- Keep writes, edits, stateful commands, and calls that can touch the same file, directory, process, or resource sequential. Never use parallel calls to create a race or overwrite another call's result.
- Match every result to its tool call by the call ID/name; results can finish in a different order than they were requested.
- Local execution policy: ${toolExecutionMode} mode, at most ${maxToolConcurrency} local tool call(s) in flight per batch. This limit does not control provider-hosted tools.

## Tool Selection Rules
- For file inspection and discovery, use dedicated tools first: read for file contents, ls for directory listings, grep for content search, and find for filename/path search.
- Avoid using bash for basic file inspection when an equivalent dedicated tool is available.
- Bash commands already run in the working directory shown above. Do not prefix bash commands with cd ${cwd} && unless you intentionally need a different directory.
- Use bash for builds, tests, package managers, generated-code commands, git commands, and other shell operations that dedicated tools cannot express.
- When creating project-local skills, use .skills/<name>/SKILL.md or .agents/skills/<name>/SKILL.md. Do not create legacy .vibe directories for skills.

	`;

  // Guidelines section
  const guidelines = buildGuidelines(toolGuidelines);
  out += `Guidelines:
${guidelines}

`;

  // Sub-Agent section (Decision 8: only in multi-agent mode)
  if (multiAgent) {
    out += `
## Sub-Agent Tools
You can delegate bounded, independent subtasks to sub-agents using these tools:
- subagent_spawn: Create and start a sub-agent for a subtask (returns handle)
- subagent_status: Check sub-agent status and get results
- subagent_send: Send follow-up instructions to a running sub-agent
- subagent_destroy: Destroy a finished sub-agent to release resources

Act as the orchestrator:
- Keep the final answer and user-facing decisions in the main agent
- Spawn sub-agents only for work that can be described with clear scope, expected output, and stop conditions
- Prefer parallel sub-agents for independent research, codebase inspection, test investigation, or review tasks
- Avoid delegation for tiny, sequential, highly stateful, or ambiguous work where coordination costs exceed the benefit
- Give each sub-agent one focused task, relevant paths/context, allowed tools if useful, and the exact artifact you need back
- Poll sub-agents with subagent_status, reconcile their outputs yourself, verify important claims before acting, and destroy finished agents
- Do not assume sub-agent output is correct; treat it as evidence to review

Sub-agents run independently with isolated context and tools. They cannot create nested sub-agents.
`;
  }

  if (delegateMode) {
    out += `
## Delegation Mode
You may delegate one bounded independent subtask at a time using delegate_subagent.

### When to Delegate (context-cost heuristic)
Delegate when the sub-agent's intermediate exploration would consume significant context
but you only need the final answer. Think of it as: "Is the exploration path longer than
the result I need?"

**Good delegation candidates:**
- Broad codebase searches ("find all callers of X", "list files matching Y")
  → The sub-agent may grep 20+ files; you only need the filtered list.
- Multi-step investigation ("why is this test failing?")
  → The sub-agent reads logs, traces code, runs commands; you need the root cause.
- Focused implementation ("add input validation to handler Z")
  → The sub-agent reads context, writes code, runs tests; you need the diff + result.
- Verification tasks ("check if this change breaks anything")
  → The sub-agent runs tests, inspects related code; you need pass/fail + details.
- Research + summarization ("summarize how auth works in this project")
  → The sub-agent reads many files; you need a concise summary.

**Do NOT delegate:**
- Single-tool tasks (reading one file, running one command) — direct execution is cheaper.
- Tasks requiring user clarification mid-way — the sub-agent cannot ask the user.
- Highly stateful work that depends on the full conversation history.
- Tasks where you need to see every intermediate step in real time.
- Tasks smaller than ~3 tool calls — overhead exceeds benefit.

### How to Write Good Task Descriptions
The task description is the sub-agent's only context. Make it specific:
- State the exact question or goal.
- List relevant file paths, function names, or search patterns.
- Specify the expected output format (e.g., "return a list of files with line numbers").
- Include stop conditions (e.g., "stop after finding 3 examples" or "stop if the test passes").
- Mention the working directory if different from default.

Good example:
  "Find all TypeScript files in src/tui/ that build provider content directly
   instead of using the Runtime input contract. Return file paths with line numbers."

Bad example:
  "Look at the API server code" (too vague, no expected output, no stop condition)

### Interpreting the Result
The delegate_subagent tool blocks until the sub-agent finishes and returns:
- status: "done" or "error"
- result: the sub-agent's final response (your primary output)
- duration: elapsed time
- On error: error message + partial_result if available

Always review the result before acting on it. The sub-agent's output is evidence,
not ground truth — verify critical claims before committing changes.
`;
  }

  if (workflows) {
    out += `
## Workflow Tools
You can run dynamic workflows using workflow_run, workflow_status, and workflow_cancel.

Workflow rules:
- Use workflow_run for multi-phase tasks with independent worker-agent branches, fan-in verification, or repeated bounded audits
- Do not use workflow tools for small sequential tasks where direct tools or normal conversation are cheaper
- Write workflow scripts only in the supported JavaScript DSL described by the active workflow-javascript skill
- The workflow_run source must be raw JavaScript text, not Markdown; do not wrap it in Markdown code fences
- workflow, phase, and agent names must be string literals, not variables, function calls, or generated expressions
- Use result, resultKey, resultLatest, results, and log for runtime expressions
- Use plain JavaScript arrays for tools, for example tools: ["read", "grep"]
- Use key for repeated logical agents; keyed results are stored as phase.agent[key]
- Before calling workflow_run, validate that workflow("name", body) is present and JavaScript braces, brackets, and strings are closed
- Treat worker results as evidence to reconcile and verify, not as final truth
`;
  }

  // Append rule.md content (project rules) after built-in sections, before extraContext
  if (ruleContent !== "") {
    out += "\n## Project Rules\n\n";
    out += ruleContent;
    if (!ruleContent.endsWith("\n")) out += "\n";
  }

  // Expert identity and roster sit between project rules and project context.
  if ((options.expertIdentity ?? "") !== "") {
    out += "\n";
    out += options.expertIdentity;
    if (!options.expertIdentity!.endsWith("\n")) out += "\n";
  }
  if ((options.expertRoster ?? "") !== "") {
    out += "\n";
    out += options.expertRoster;
    if (!options.expertRoster!.endsWith("\n")) out += "\n";
  }

  // Append extra context from files and skills
  if (extraContext !== "") {
    out += "\n## Context from project files\n";
    out += extraContext;
    out += "\n";
  }

  if (options.authored) {
    out += "\n";
    out += authoredSystemPrompt;
    out += "\n";
  }

  return out;
}

/** Returns extra system context for sub-agents. */
export function buildSubAgentContext(): string {
  return `
## Sub-Agent Operating Contract
You are a worker sub-agent. Execute only the delegated task, stay within the requested scope, and do not broaden the objective.

### Reporting Format
Structure your final response using these sections:

**Result:** The direct answer, completed change, or conclusion. Be specific and actionable.
**Evidence:** Files inspected (with paths), commands run, test outputs, key observations. Summarize — do not paste entire file contents.
**Changes:** Files modified (with paths and brief description of each change). If no changes, write "None".
**Risks:** Assumptions made, uncertainty, potential issues, follow-up needed. If none, write "None".

### Guidelines
- Prioritize accuracy over completeness — it is better to report "uncertain" than to guess.
- When searching, report what you found AND what you did not find (negative results save the parent agent from re-searching).
- When making code changes, run relevant tests if available and report pass/fail.
- Keep the response concise but complete — the parent agent needs enough detail to act without re-doing your work.
- If blocked or the task is unsafe, say so explicitly and explain why.
- Do not ask the user directly unless the task explicitly requires it.
- Do not create nested sub-agents or delegate further.
`;
}

/** Formats the tool list with snippets for the system prompt. */
function formatToolListWithSnippets(
  toolNames: string[],
  snippets: Record<string, string>,
): string {
  if (toolNames.length === 0) return "(none)";

  let out = "";
  for (const name of toolNames) {
    const snippet = snippets[name];
    if (snippet !== undefined) {
      out += `- ${name}: ${snippet}\n`;
    } else {
      out += `- ${name}\n`;
    }
  }
  return out;
}

/** Builds the guidelines section for the system prompt. */
function buildGuidelines(toolGuidelines: string[]): string {
  let out = "";

  for (const g of toolGuidelines) {
    out += `- ${g}\n`;
  }

  const generalGuidelines = [
    "Be concise in your responses",
    "Show file paths clearly when working with files",
    "Prefer dedicated tools for file inspection and discovery: read for file contents, ls for directory listing, grep for content search, and find for filename search",
    "Use bash only when a task needs a shell command that dedicated tools cannot express well",
    "Read files before modifying them to understand context",
    "Verify your changes work when possible",
    "Ask for clarification when requirements are ambiguous",
    "Don't assume file contents - read them first",
    "Explain complex operations before executing them",
    "Report errors clearly with context",
    "Refrain from overusing bold highlights, headers, lists and bullet points, and stick to minimal formatting for clarity. Use lists and bullets only when asked, or when multifaceted content cannot be clearly organized without them. Bullet items default to 1–2 sentences long unless the user requests a different length.",
  ];

  for (const g of generalGuidelines) {
    out += `- ${g}\n`;
  }

  return out;
}

/** Builds context from loaded skills. */
export function buildSkillsContext(skills: SkillInfo[]): string {
  if (skills.length === 0) return "";

  let out = `
## Available Skills
The following specialized instructions are available for specific tasks:
`;

  for (const skill of skills) {
    out += `\n### ${skill.name}\n`;
    out += `Description: ${skill.description}\n`;
  }

  out += `
When a task matches a skill's description, read the full skill file for detailed instructions.
If a skill file references relative paths, resolve them against the skill directory.
`;

  return out;
}

/** Represents information about a skill. */
export interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

/** Builds context from loaded context files. */
export function buildContextFilesContext(files: ContextFileInfo[]): string {
  if (files.length === 0) return "";

  let out = `
## Project Context
The following context files have been loaded:
`;

  for (const file of files) {
    out += `\n### ${file.name} (${file.scope})\n`;
    out += file.content;
    if (!file.content.endsWith("\n")) out += "\n";
  }

  return out;
}

/** Represents information about a context file. */
export interface ContextFileInfo {
  name: string;
  path: string;
  scope: string; // "global", "parent", "project"
  content: string;
}
