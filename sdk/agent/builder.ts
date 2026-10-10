// (agent/builder.go).
//
// The public SDK boundary lives in `sdk/`; this module must not import from
// `src/`.

import { type Agent } from "./types.ts";
import { type ExternalTool } from "./external_tool.ts";
import { type Provider, type ThinkingLevel } from "./provider.ts";
import { thinkingMedium } from "./provider.ts";

/**
 * Builder provides a fluent API for creating Agent instances. External
 * developers use this to instantiate the built-in Agent without depending on
 * internal packages.
 *
 * Usage:
 *
 *   const a = await newBuilder()
 *     .withProvider(myProvider)
 *     .withModel("gpt-4")
 *     .withMode("yolo")
 *     .withWorkDir("/home/user/project")
 *     .build();
 */
export class Builder {
  private provider: Provider | undefined;
  private modelID = "";
  private mode = "yolo";
  private workDir = "";
  private thinkingLevel: ThinkingLevel = thinkingMedium;
  private maxTokens = 16384;
  private systemPromptExtra = "";
  private maxIterations = 200;
  private toolExecutionMode = "parallel";
  private maxToolConcurrency = defaultMaxToolConcurrency;
  private toolNames: string[] | undefined;
  private sandboxEnabled = false;
  private sessionDir = "";
  private compactionEnabled = true;
  private compactionReserve = 16384;
  private multiAgent = false;
  private delegateMode = false;
  private approvalHandler:
    | ((
        toolCallId: string,
        toolName: string,
        args: Record<string, unknown>,
      ) => boolean)
    | undefined;
  private externalTools: ExternalTool[] = [];
  private disableBuiltinTools = false;
  private err: Error | undefined;

  /** Sets the LLM provider. */
  withProvider(p: Provider): this {
    this.provider = p;
    this.err = undefined;
    return this;
  }

  /** Sets the model ID. */
  withModel(modelID: string): this {
    this.modelID = modelID;
    return this;
  }

  /** Sets the agent mode: "plan", "agent", "yolo", or "os". */
  withMode(mode: string): this {
    this.mode = mode;
    return this;
  }

  /** Sets the working directory. */
  withWorkDir(dir: string): this {
    this.workDir = dir;
    return this;
  }

  /** Sets the thinking/reasoning level. */
  withThinkingLevel(level: ThinkingLevel): this {
    this.thinkingLevel = level;
    return this;
  }

  /** Sets the maximum output tokens. */
  withMaxTokens(n: number): this {
    this.maxTokens = n;
    return this;
  }

  /** Adds extra context to the system prompt. */
  withSystemPromptExtra(extra: string): this {
    this.systemPromptExtra = extra;
    return this;
  }

  /** Sets the safety limit for agent loop iterations. */
  withMaxIterations(n: number): this {
    this.maxIterations = n;
    return this;
  }

  /** Sets how tool calls are executed: "sequential" or "parallel". */
  withToolExecutionMode(mode: string): this {
    this.toolExecutionMode = mode;
    return this;
  }

  /**
   * Sets the maximum number of local tool calls that may execute concurrently
   * in one agent turn. Non-positive values use the default.
   */
  withMaxToolConcurrency(n: number): this {
    this.maxToolConcurrency = n;
    return this;
  }

  /** Sets a filter for available tools. Empty means all tools. */
  withTools(tools: string[]): this {
    this.toolNames = tools;
    return this;
  }

  /** Enables or disables sandboxing. */
  withSandbox(enabled: boolean): this {
    this.sandboxEnabled = enabled;
    return this;
  }

  /**
   * Sets the session persistence directory. Empty keeps the platform default,
   * which the internal builder resolves at build time.
   */
  withSessionDir(dir: string): this {
    this.sessionDir = dir;
    return this;
  }

  /** Configures context compaction. */
  withCompaction(enabled: boolean, reserveTokens: number): this {
    this.compactionEnabled = enabled;
    this.compactionReserve = reserveTokens;
    return this;
  }

  /** Enables multi-agent mode. */
  withMultiAgent(enabled: boolean): this {
    this.multiAgent = enabled;
    return this;
  }

  /** Enables blocking single sub-agent delegation mode. */
  withDelegateMode(enabled: boolean): this {
    this.delegateMode = enabled;
    return this;
  }

  /** Sets a custom approval handler for tool calls. */
  withApprovalHandler(
    h: (
      toolCallId: string,
      toolName: string,
      args: Record<string, unknown>,
    ) => boolean,
  ): this {
    this.approvalHandler = h;
    return this;
  }

  /**
   * Registers host-provided custom tools. These are exposed to the agent in
   * addition to the built-in tools, unless `withoutBuiltinTools` is also set,
   * in which case only the external tools are available.
   */
  withExternalTools(...tools: ExternalTool[]): this {
    this.externalTools.push(...tools);
    return this;
  }

  /**
   * Disables all built-in coding tools (read/write/edit/bash/...). Use together
   * with `withExternalTools` to run an agent that may only use the host-provided
   * tools. This is the recommended mode for embedding the agent as a controlled
   * orchestration layer over an application's own tool set.
   */
  withoutBuiltinTools(): this {
    this.disableBuiltinTools = true;
    return this;
  }

  /**
   * Creates and returns an Agent instance. Throws if required fields are
   * missing.
   */
  build(): Agent {
    if (this.err !== undefined) {
      throw this.err;
    }
    if (this.provider === undefined) {
      throw new Error("agent: provider is required (use withProvider)");
    }
    if (this.workDir === "") {
      try {
        this.workDir = process.cwd();
      } catch (e) {
        throw new Error(`agent: get working directory: ${errorMessage(e)}`);
      }
    }
    if (this.modelID === "") {
      const models = this.provider.models();
      if (models.length === 0) {
        throw new Error(
          `agent: no models available from provider "${this.provider.name()}"`,
        );
      }
      this.modelID = models[0].id;
    }

    // Delegate to the internal builder registered by src/bootstrap.
    if (buildInternal === undefined) {
      throw new Error(
        "agent: internal builder is not registered; import the bootstrap package before calling build",
      );
    }
    return buildInternal(this);
  }

  /**
   * Returns a read-only snapshot of the Builder's current configuration. Called
   * by the internal builder function to extract settings.
   */
  config(): BuilderConfig {
    return {
      provider: this.provider,
      modelID: this.modelID,
      mode: this.mode,
      workDir: this.workDir,
      thinkingLevel: this.thinkingLevel,
      maxTokens: this.maxTokens,
      maxTokensUserSet: this.maxTokens > 0,
      systemPromptExtra: this.systemPromptExtra,
      maxIterations: this.maxIterations,
      toolExecutionMode: this.toolExecutionMode,
      maxToolConcurrency: this.maxToolConcurrency,
      tools: this.toolNames,
      sandboxEnabled: this.sandboxEnabled,
      sessionDir: this.sessionDir,
      compactionEnabled: this.compactionEnabled,
      compactionReserve: this.compactionReserve,
      multiAgent: this.multiAgent,
      delegateMode: this.delegateMode,
      approvalHandler: this.approvalHandler,
      externalTools: this.externalTools,
      disableBuiltinTools: this.disableBuiltinTools,
    };
  }

  /**
   * Creates a provider from vendor/baseURL/api/apiKey configuration. This
   * delegates to the internal provider registry.
   */
  withProviderByName(
    vendor: string,
    baseURL: string,
    api: string,
    apiKey: string,
  ): this {
    if (resolveProviderFunc === undefined) {
      this.err = new Error(
        "agent: provider resolution is not registered; import the bootstrap package before calling withProviderByName",
      );
      this.provider = undefined;
      return this;
    }
    try {
      const p = resolveProviderFunc(vendor, baseURL, api, apiKey);
      this.err = undefined;
      this.provider = p;
    } catch (e) {
      this.err = new Error(`agent: resolve provider: ${errorMessage(e)}`);
      this.provider = undefined;
    }
    return this;
  }
}

/**
 * Default number of local tool calls that may execute concurrently in one agent
 * turn.
 */
export const defaultMaxToolConcurrency = 10;

/** Creates a new Builder with sensible defaults. */
export function newBuilder(): Builder {
  return new Builder();
}

/**
 * The internal builder function registered by `src/bootstrap`. Kept in a module
 * variable to avoid an import cycle between the public SDK and the internal
 * agent package.
 */
let buildInternal: ((b: Builder) => Agent) | undefined;

/** Registers the internal builder function. Called by the bootstrap package. */
export function setBuilderFunc(fn: ((b: Builder) => Agent) | undefined): void {
  buildInternal = fn;
}

/** Read-only snapshot of Builder state used by the internal package. */
export interface BuilderConfig {
  provider: Provider | undefined;
  modelID: string;
  mode: string;
  workDir: string;
  thinkingLevel: ThinkingLevel;
  maxTokens: number;
  maxTokensUserSet: boolean;
  systemPromptExtra: string;
  maxIterations: number;
  toolExecutionMode: string;
  maxToolConcurrency: number;
  tools: string[] | undefined;
  sandboxEnabled: boolean;
  sessionDir: string;
  compactionEnabled: boolean;
  compactionReserve: number;
  multiAgent: boolean;
  delegateMode: boolean;
  approvalHandler:
    | ((
        toolCallId: string,
        toolName: string,
        args: Record<string, unknown>,
      ) => boolean)
    | undefined;
  externalTools: ExternalTool[];
  disableBuiltinTools: boolean;
}

/**
 * The provider resolution function registered by `src/bootstrap`. Kept in a
 * module variable to avoid an import cycle between the public SDK and the
 * internal provider package.
 */
let resolveProviderFunc:
  | ((vendor: string, baseURL: string, api: string, apiKey: string) => Provider)
  | undefined;

/**
 * Registers the provider resolution function. Called by the bootstrap package.
 */
export function setResolveProviderFunc(
  fn:
    | ((
        vendor: string,
        baseURL: string,
        api: string,
        apiKey: string,
      ) => Provider)
    | undefined,
): void {
  resolveProviderFunc = fn;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
