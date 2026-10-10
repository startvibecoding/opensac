// (agent/external_tool.go).
//
// The public SDK boundary lives in `sdk/`; this module must not import from
// `src/`.

import { type ContentBlock } from "./types.ts";

/**
 * ExternalTool is a custom tool supplied by an embedding application (for
 * example, PostgreBase's schema/data tools).
 *
 * External tools let host applications expose their own controlled capabilities
 * to the agent without depending on the agent's built-in coding tools. Combine
 * with `Builder.withoutBuiltinTools` to run an agent that may ONLY use the
 * host-provided tools.
 */
export interface ExternalTool {
  /**
   * Returns the tool's name (must match ^[a-zA-Z0-9_-]+$ for most providers).
   */
  name(): string;

  /** Returns a human-readable description of what the tool does. */
  description(): string;

  /**
   * Returns the JSON Schema (as raw JSON bytes) for the tool's input
   * parameters.
   */
  parameters(): Uint8Array;

  /** Runs the tool with the decoded parameters. */
  execute(
    params: Record<string, unknown>,
    abort?: AbortSignal,
  ): Promise<ExternalToolResult>;
}

/** ExternalToolResult is the normalized result returned by an ExternalTool. */
export interface ExternalToolResult {
  /** Plain-text result surfaced to the model and logs. */
  text: string;

  /** Marks the result as an error so the agent can react accordingly. */
  isError?: boolean;

  /**
   * Optionally carries rich content blocks (e.g. images) for multimodal
   * results. When empty, text is used.
   */
  contents?: ContentBlock[];
}

/**
 * ExternalToolPromptInfo is an optional interface an ExternalTool may implement
 * to contribute richer system-prompt hints. When not implemented, the agent
 * falls back to the tool name and description.
 */
export interface ExternalToolPromptInfo {
  /** Returns a short one-line description for the system prompt. */
  promptSnippet(): string;
  /** Returns guideline bullets for the system prompt. */
  promptGuidelines(): string[];
}
