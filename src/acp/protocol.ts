// (the ACP wire vocabulary) and
//
// The Agent Client Protocol wire shapes. Go struct tags are preserved as the
// serialized keys (camelCase where the tags are camelCase), so `JSON.stringify`
// of these objects is a direct projection. This module owns only the vocabulary
// and its strict union encoding; the ACP server (handleInitialize/handlePrompt
// and the stdio loop) lands in a later slice.

/** One ACP content block (text/image/resource/…). */
export interface ContentBlock {
  type: string;
  text?: string;
  mimeType?: string;
  data?: string;
  name?: string;
  title?: string;
  description?: string;
  uri?: string;
  size?: number;
}

/**
 * One ACP ToolCallContent union entry.
 *
 * Go customizes `MarshalJSON` so the union stays strict: a `diff` entry always
 * encodes `path`, `oldText` (JSON `null` for a newly-created file), and
 * `newText`, while every other entry carries only `type` + optional `content`.
 * `toJSON` reproduces that contract so `JSON.stringify` of a session update is
 * byte-compatible with the Go server.
 */
export class ToolCallContent {
  type: string;
  content?: ContentBlock;
  path?: string;
  oldText?: string | null;
  newText?: string;

  constructor(init: {
    type: string;
    content?: ContentBlock;
    path?: string;
    oldText?: string | null;
    newText?: string;
  }) {
    this.type = init.type;
    this.content = init.content;
    this.path = init.path;
    this.oldText = init.oldText;
    this.newText = init.newText;
  }

  toJSON(): unknown {
    if (this.type === "diff") {
      return {
        type: this.type,
        path: this.path ?? "",
        oldText: this.oldText ?? null,
        newText: this.newText ?? "",
      };
    }
    const out: Record<string, unknown> = { type: this.type };
    if (this.content !== undefined) out.content = this.content;
    return out;
  }
}

/** One ACP tool-call location. */
export interface ToolCallLocation {
  path: string;
}

/** One ACP plan entry. */
export interface PlanEntry {
  content: string;
  priority: string;
  status: string;
}

/** One ACP usage cost. */
export interface UsageCost {
  amount: number;
  currency: string;
}

/** The `sessionUpdate` notification body. */
export interface SessionUpdate {
  sessionUpdate: string;
  messageId?: string;
  configId?: string;
  value?: string;
  configOptions?: unknown[];
  currentModeId?: string;
  content?: unknown;
  toolCallId?: string;
  locations?: ToolCallLocation[];
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  used?: number;
  size?: number;
  cost?: UsageCost;
  entries?: PlanEntry[];
  availableCommands?: unknown[];
  updatedAt?: string;
  /**
   * Additive projection fields for `sessionUpdate="artifact"` carrying the
   * canonical Runtime attachment identity.
   */
  artifactId?: string;
  filename?: string;
  mediaType?: string;
  runId?: string;
  _meta?: Record<string, unknown>;
}

/** One selectable option in the `opensac/requestQuestion` payload. */
export interface RequestQuestionOption {
  id: string;
  label: string;
}

/** The `opensac/requestQuestion` payload. */
export interface RequestQuestionPayload {
  prompt: string;
  options?: RequestQuestionOption[];
  multi: boolean;
  title?: string;
  placeholder?: string;
}
