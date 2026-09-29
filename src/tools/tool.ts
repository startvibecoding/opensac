//
// The tool contract, result types, and the per-session tool Registry. This is
// the hub the agent/runtime uses to enumerate and construct tools.
//
// Deviations from Go: the `sync.RWMutex` is dropped (Deno is single-threaded);
// `context.Context` maps to a `ToolContext` carrying an `AbortSignal`, the
// stable operation ID, and the interactive question asker; `json.RawMessage`
// parameter schemas map to plain JSON values; and `Execute` is uniformly
// `async` so filesystem/child-process tools share one signature.

import * as path from "@std/path";
import type { AgentID } from "../../sdk/agent/types.ts";
import type { IterationBudget } from "../agent/iteration_budget.ts";
import type { EventSink, RunContext } from "../agent/run_context.ts";
import { envList, loadEnv } from "../config/env.ts";
import type { Settings } from "../config/settings.ts";
import {
  type Hint,
  type Mode,
  type Policy,
  policyForHint,
} from "../imageproc/mod.ts";
import { homeDir } from "../platform/platform.ts";
import type {
  ContentBlock,
  ImageContent,
  ToolDefinition,
} from "../provider/types.ts";
import { type Sandbox } from "../sandbox/mod.ts";
import type { Manager as SkillsManager } from "../skills/mod.ts";
import { createBashTool } from "./bash.ts";
import { EditTool } from "./edit.ts";
import { FindTool } from "./find.ts";
import { defaultFileLockManager, FileLockManager } from "./file_lock.ts";
import { InsertTool } from "./insert.ts";
import type { FileDiff } from "./io_helpers.ts";
import { GrepTool } from "./grep.ts";
import { createJobManager, type JobManager } from "./jobmanager.ts";
import { JobsTool } from "./jobstool.ts";
import { KillTool } from "./killtool.ts";
import { LsTool } from "./ls.ts";
import { PlanTool } from "./plan.ts";
import type { QuestionAsker } from "./question.ts";
import { ReadTool } from "./read.ts";
import { SkillRefTool } from "./skill_ref.ts";
import { WriteTool } from "./write.ts";

/** Runtime context threaded through a tool invocation. */
export interface ToolContext {
  /** Cancellation signal, mirroring Go's `context.Context`. */
  signal?: AbortSignal;
  /** Stable Runtime-owned operation ID for idempotency-aware targets. */
  operationId?: string;
  /** Interactive question handler for the `question` tool. */
  questionAsker?: QuestionAsker;
  /** Identity of the owning agent, for agent-owned sub-tools. */
  agentID?: AgentID;
  /** The owning run's canonical event sink. */
  eventSink?: EventSink;
  /** The owning run's context, carried through tool timeouts. */
  parentRunContext?: RunContext;
  /** The owning agent's execution mode for sub-agent inheritance. */
  parentMode?: string;
  /** The per-run iteration budget handle owned by the agent loop. */
  iterationBudget?: IterationBudget;
}

/**
 * Attaches the Runtime-owned stable operation ID to a tool invocation. External
 * tools may pass it to an idempotency-aware target.
 */
export function contextWithOperationID(
  ctx: ToolContext,
  operationID: string,
): ToolContext {
  if (operationID === "") return ctx;
  return { ...ctx, operationId: operationID };
}

/** Extracts the stable operation ID, when the Runtime claimed a record. */
export function operationIDFromContext(
  ctx: ToolContext | undefined,
): string | undefined {
  if (!ctx) return undefined;
  const value = ctx.operationId ?? "";
  return value === "" ? undefined : value;
}

/** Attaches a `QuestionAsker` to the context. */
export function contextWithQuestionAsker(
  ctx: ToolContext,
  asker: QuestionAsker,
): ToolContext {
  return { ...ctx, questionAsker: asker };
}

/** Extracts the attached `QuestionAsker`. */
export function questionAskerFromContext(
  ctx: ToolContext | undefined,
): QuestionAsker | undefined {
  return ctx?.questionAsker;
}

/** The result of a tool execution. */
export interface ToolResult {
  /** Plain text result (always populated for display/logging). */
  text: string;
  /** Rich content blocks (text + images) for the LLM. */
  contents?: ContentBlock[];
  /** Optional structured file diff for UI/reporting. */
  diff?: FileDiff;
  /** Optional structured task plan for UI/reporting. */
  plan?: TaskPlan;
  /** Optional structured result for the insert tool. */
  insert?: InsertResult;
}

/** Describes a structural insertion independently of its human-readable text. */
export interface InsertResult {
  path: string;
  changed: boolean;
  dryRun: boolean;
  insertedBytes: number;
  position: string;
  line: number;
  offset: number;
  deduped: boolean;
}

/** Describes a structured task plan emitted by the plan tool. */
export interface TaskPlan {
  title: string;
  steps: PlanStep[];
  note: string;
}

/** Describes one step in a task plan. */
export interface PlanStep {
  title: string;
  status: string;
}

/** Creates a plain text tool result. */
export function createTextToolResult(text: string): ToolResult {
  return { text };
}

/** Creates a text tool result with structured diff metadata. */
export function createDiffToolResult(text: string, diff: FileDiff): ToolResult {
  return { text, diff };
}

/** Creates a tool result with insert metadata and an optional diff. */
export function createInsertToolResult(
  text: string,
  diff: FileDiff | null,
  result: InsertResult,
): ToolResult {
  return { text, diff: diff ?? undefined, insert: result };
}

/** Creates a tool result carrying a structured task plan. */
export function createPlanToolResult(
  text: string,
  plan: TaskPlan,
): ToolResult {
  return { text, plan };
}

/** Creates a tool result that includes a fully populated image payload. */
export function createImageToolResult(
  text: string,
  image: ImageContent,
): ToolResult {
  return {
    text,
    contents: [
      { type: "text", text },
      { type: "image", image },
    ],
  };
}

/** The interface all tools implement. */
export interface Tool {
  name(): string;
  description(): string;
  /** A short one-line snippet for the system prompt's Available tools section. */
  promptSnippet(): string;
  /** Guideline bullets for the system prompt's Guidelines section. */
  promptGuidelines(): string[];
  /** JSON Schema for the tool's parameters. */
  parameters(): unknown;
  /** Runs the tool with the given parameters. */
  execute(
    ctx: ToolContext,
    params: Record<string, unknown>,
  ): ToolResult | Promise<ToolResult>;
}

/**
 * Lets a tool override the agent's default execution timeout. `provided` reports
 * whether an override is given; a non-positive duration disables the
 * agent-level deadline while preserving parent cancellation.
 */
export interface ExecutionTimeoutProvider {
  executionTimeout(
    params: Record<string, unknown>,
  ): { durationMs: number; provided: boolean };
}

/** Converts a Tool to a provider `ToolDefinition`. */
export function toolDefinition(t: Tool): ToolDefinition {
  return {
    name: t.name(),
    description: t.description(),
    parameters: t.parameters(),
  };
}

function copyEnvVars(
  input: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (input === undefined) return undefined;
  return { ...input };
}

/** Configures a Registry instance. */
export interface RegistryConfig {
  workDir: string;
  sandbox?: Sandbox;
  /** Only register these tools (empty = all). */
  toolFilter?: string[];
  /** Skills manager for the skill_ref tool. */
  skillsMgr?: SkillsManager;
  /** Defaults to true when undefined. */
  enablePlanTool?: boolean;
  fileLocks?: FileLockManager;
  /** Provider/model hint for image preprocessing. */
  imageHint?: Hint;
  /** Extra environment variables for bash/skills. */
  envVars?: Record<string, string>;
  /**
   * Explicit user-configured shell (`settings.shellPath`). Resolved once here so
   * the `bash` tool and the system prompt cannot disagree about the shell.
   */
  shellPath?: string;
}

/** Manages available tools. */
export class Registry {
  #tools = new Map<string, Tool>();
  #order: string[] = [];
  #sandbox: Sandbox | undefined;
  #workDir: string;
  #jobManager: JobManager;
  #skillsMgr: SkillsManager | undefined;
  #fileLocks: FileLockManager;
  #imageHint: Hint;
  #envVars: Record<string, string>;
  #additionalDirs: string[] = [];
  #shellPath: string;

  constructor(
    workDir: string,
    sb: Sandbox | undefined,
    init: {
      jobManager: JobManager;
      fileLocks: FileLockManager;
      skillsMgr?: SkillsManager;
      imageHint?: Hint;
      envVars: Record<string, string>;
      shellPath?: string;
    },
  ) {
    this.#workDir = workDir;
    this.#sandbox = sb;
    this.#jobManager = init.jobManager;
    this.#fileLocks = init.fileLocks;
    this.#skillsMgr = init.skillsMgr;
    this.#imageHint = init.imageHint ?? {};
    this.#envVars = init.envVars;
    this.#shellPath = init.shellPath ?? "";
  }

  /**
   * The explicit user-configured shell, or "" when unset. This is the single
   * value both the `bash` tool and the system prompt resolve against.
   */
  shellPath(): string {
    return this.#shellPath;
  }

  /** Extra environment variables for command execution. */
  envVars(): Record<string, string> {
    return copyEnvVars(this.#envVars) ?? {};
  }

  setImageHint(h: Hint): void {
    this.#imageHint = h;
  }

  /** Image preprocessing policy for the current registry context. */
  imagePolicy(mode: Mode): Policy {
    return policyForHint(this.#imageHint, mode);
  }

  jobManager(): JobManager {
    return this.#jobManager;
  }

  fileLocks(): FileLockManager {
    return this.#fileLocks;
  }

  async acquireFileLock(
    ctx: ToolContext,
    p: string,
    owner: string,
  ): Promise<() => void> {
    return await this.#fileLocks.acquire(ctx.signal, p, owner);
  }

  /** Adds a tool to the registry. */
  register(t: Tool): void {
    const name = t.name();
    if (!this.#tools.has(name)) {
      this.#order.push(name);
    }
    this.#tools.set(name, t);
  }

  /** Returns a tool by name, or undefined when not registered. */
  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  /** Removes a tool by name. No-op if not found. */
  remove(name: string): void {
    if (this.#tools.has(name)) {
      this.#tools.delete(name);
      const i = this.#order.indexOf(name);
      if (i >= 0) this.#order.splice(i, 1);
    }
  }

  /** Returns all registered tools in order. */
  all(): Tool[] {
    const result: Tool[] = [];
    for (const name of this.#order) {
      const t = this.#tools.get(name);
      if (t) result.push(t);
    }
    return result;
  }

  /** Returns tool definitions for all registered tools. */
  definitions(): ToolDefinition[] {
    return this.all().map((t) => toolDefinition(t));
  }

  getSandbox(): Sandbox | undefined {
    return this.#sandbox;
  }

  getWorkDir(): string {
    return this.#workDir;
  }

  /**
   * Grants this session's canonical workspace roots to path resolution and
   * command sandbox projection.
   */
  setAdditionalDirectories(directories: string[]): void {
    this.#additionalDirs = directories.slice();
  }

  getAdditionalDirectories(): string[] {
    return this.#additionalDirs.slice();
  }

  /** Resolves a user path to an absolute path constrained to the workspace. */
  resolvePath(p: string): string {
    const workDir = this.#workDir;
    const additionalDirs = this.#additionalDirs.slice();

    let resolved = p;
    if (resolved === "~") {
      resolved = homeDir();
    } else if (resolved.startsWith("~/")) {
      resolved = path.join(homeDir(), resolved.slice(2));
    }

    if (!path.isAbsolute(resolved)) {
      resolved = path.join(workDir, resolved);
    }
    resolved = path.normalize(resolved);

    const cleanWorkDir = path.normalize(workDir);
    const rel = relativeIfPossible(cleanWorkDir, resolved);
    if (rel !== null && !escapes(rel)) {
      return resolved;
    }
    for (const root of additionalDirs) {
      const relRoot = relativeIfPossible(path.normalize(root), resolved);
      if (relRoot !== null && !escapes(relRoot)) {
        return resolved;
      }
    }
    throw new Error(`path ${resolved} escapes session workspace roots`);
  }

  setSandbox(sb: Sandbox): void {
    this.#sandbox = sb;
  }

  /** Registers all default tools. */
  registerDefaults(): void {
    this.registerDefaultsWithPlanTool(true);
  }

  /**
   * Registers all default tools, optionally including the plan tool.
   */
  registerDefaultsWithPlanTool(enablePlanTool: boolean): void {
    this.register(new ReadTool(this));
    this.register(new LsTool(this));
    this.register(new GrepTool(this));
    this.register(new FindTool(this));
    if (enablePlanTool) {
      this.register(new PlanTool(this));
    }
    this.register(new WriteTool(this));
    this.register(new EditTool(this));
    this.register(new InsertTool(this));
    const bashTool = createBashTool(this, this.#jobManager);
    this.register(bashTool);
    this.register(new JobsTool(this, bashTool));
    this.register(new KillTool(this, bashTool));
    if (this.#skillsMgr !== undefined) {
      this.register(new SkillRefTool(this.#skillsMgr));
    }
  }

  /** Registers only the specified tools by name. */
  registerFiltered(toolNames: string[]): void {
    const bashTool = createBashTool(this, this.#jobManager);
    const factories: Record<string, () => Tool> = {
      "read": () => new ReadTool(this),
      "ls": () => new LsTool(this),
      "grep": () => new GrepTool(this),
      "find": () => new FindTool(this),
      "plan": () => new PlanTool(this),
      "write": () => new WriteTool(this),
      "edit": () => new EditTool(this),
      "insert": () => new InsertTool(this),
      "bash": () => bashTool,
      "jobs": () => new JobsTool(this, bashTool),
      "kill": () => new KillTool(this, bashTool),
    };
    if (this.#skillsMgr !== undefined) {
      factories["skill_ref"] = () =>
        new SkillRefTool(this.#skillsMgr as SkillsManager);
    }

    for (const name of toolNames) {
      const factory = factories[name];
      if (factory) this.register(factory());
    }
  }

  /** Returns tool definitions appropriate for the given mode. */
  modeTools(mode: string): ToolDefinition[] {
    switch (mode) {
      case "plan": {
        const defs: ToolDefinition[] = [];
        for (const t of this.all()) {
          switch (t.name()) {
            case "read":
            case "grep":
            case "find":
            case "ls":
            case "plan":
            case "question":
              defs.push(toolDefinition(t));
              break;
          }
        }
        return defs;
      }
      case "agent":
        return this.all().map((t) => toolDefinition(t));
      case "os": {
        for (const t of this.all()) {
          if (t.name() === "bash") return [toolDefinition(t)];
        }
        return [];
      }
      default:
        return this.all()
          .filter((t) => t.name() !== "question")
          .map((t) => toolDefinition(t));
    }
  }

  /** Returns prompt snippets for the given tool names. */
  toolSnippets(toolNames: string[]): Record<string, string> {
    const snippets: Record<string, string> = {};
    for (const name of toolNames) {
      const t = this.#tools.get(name);
      if (t) {
        const snippet = t.promptSnippet();
        if (snippet !== "") snippets[name] = snippet;
      }
    }
    return snippets;
  }

  /** Returns prompt guidelines for the given tool names. */
  toolGuidelines(toolNames: string[]): string[] {
    const guidelines: string[] = [];
    const seen = new Set<string>();
    for (const name of toolNames) {
      const t = this.#tools.get(name);
      if (t) {
        for (const g of t.promptGuidelines()) {
          if (!seen.has(g)) {
            seen.add(g);
            guidelines.push(g);
          }
        }
      }
    }
    return guidelines;
  }
}

function relativeIfPossible(from: string, to: string): string | null {
  try {
    return path.relative(from, to);
  } catch {
    return null;
  }
}

function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(".." + path.SEPARATOR);
}

/** Creates a new tool registry with a fresh job manager. */
export function createRegistry(
  workDir: string,
  sb: Sandbox | undefined,
  shellPath = "",
): Registry {
  return new Registry(workDir, sb, {
    jobManager: createJobManager(),
    fileLocks: defaultFileLockManager(),
    envVars: envList(loadEnv()),
    shellPath,
  });
}

/** Creates a Registry with the given config. */
export function createRegistryWithConfig(cfg: RegistryConfig): Registry {
  const fileLocks = cfg.fileLocks ?? defaultFileLockManager();
  let enablePlanTool = true;
  if (cfg.enablePlanTool !== undefined) enablePlanTool = cfg.enablePlanTool;

  let envVars = copyEnvVars(cfg.envVars);
  if (envVars === undefined) {
    envVars = envList(loadEnv());
  }

  const r = new Registry(cfg.workDir, cfg.sandbox, {
    jobManager: createJobManager(),
    fileLocks,
    skillsMgr: cfg.skillsMgr,
    imageHint: cfg.imageHint,
    envVars,
    shellPath: cfg.shellPath,
  });

  if (!cfg.toolFilter || cfg.toolFilter.length === 0) {
    r.registerDefaultsWithPlanTool(enablePlanTool);
  } else {
    r.registerFiltered(cfg.toolFilter);
  }
  return r;
}

// The Settings type is re-exported for callers wiring the image-generation tool.
export type { Settings };
