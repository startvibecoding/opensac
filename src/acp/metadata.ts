// (the ACP request-metadata vocabulary).
//
// ACP clients exchange workspace/parent/editor metadata in `_meta` under both
// the `opensac` and the namespaced `opensac.dev` keys. Unknown metadata is ignored
// by design so clients can roll out optional fields independently.

import {
  MODE_AGENT,
  MODE_OS,
  MODE_PLAN,
  MODE_YOLO,
} from "../agentruntime/source.ts";
import type { SessionRuntime } from "../agentruntime/session_runtime.ts";

/** One editor cursor selection snapshot carried by prompt metadata. */
export interface EditorSelection {
  startLine?: number;
  endLine?: number;
  text?: string;
}

/** One editor diagnostic carried by prompt metadata. */
export interface EditorDiagnostic {
  severity?: string;
  line?: number;
  startLine?: number;
  endLine?: number;
  message?: string;
}

/** The optional editor snapshot carried by prompt metadata. */
export interface EditorContext {
  uri?: string;
  path?: string;
  language?: string;
  selection?: EditorSelection;
  diagnostics?: EditorDiagnostic[];
}

/**
 * The protocol-neutral workspace window exchanged in `_meta.opensac`. It is
 * deliberately kept separate from session additional directories: `cwd` is the
 * session's primary root, while the latter are extra roots granted to that
 * session.
 */
export interface WorkspaceSpec {
  cwd?: string;
  additionalDirectories?: string[];
}

/** The `opensac` / `opensac.dev` request metadata envelope. */
export interface OpensacRequestMeta {
  workspace?: WorkspaceSpec;
  parentSessionId?: string;
  surface?: string;
  editorContext?: EditorContext;
}

/** The ACP `_meta` object accepting both metadata namespaces. */
export interface RequestMeta {
  opensac?: OpensacRequestMeta;
  "opensac.dev"?: OpensacRequestMeta;
}

/** Returns the negotiated workspace spec (`opensac` wins over `opensac.dev`). */
export function requestWorkspace(
  meta: RequestMeta | undefined | null,
): WorkspaceSpec | undefined {
  if (meta === undefined || meta === null) return undefined;
  if (meta.opensac?.workspace !== undefined) return meta.opensac.workspace;
  if (meta["opensac.dev"]?.workspace !== undefined) {
    return meta["opensac.dev"].workspace;
  }
  return undefined;
}

/** Returns the optional parent session ID carried by prompt metadata. */
export function requestParentSessionID(
  meta: RequestMeta | undefined | null,
): string {
  if (meta === undefined || meta === null) return "";
  if (
    meta.opensac !== undefined &&
    (meta.opensac.parentSessionId ?? "").trim() !== ""
  ) {
    return meta.opensac.parentSessionId ?? "";
  }
  if (meta["opensac.dev"] !== undefined) {
    return meta["opensac.dev"].parentSessionId ?? "";
  }
  return "";
}

/** Returns the optional editor snapshot carried by prompt metadata. */
export function requestEditorContext(
  meta: RequestMeta | undefined | null,
): EditorContext | undefined {
  if (meta === undefined || meta === null) return undefined;
  if (meta.opensac?.editorContext !== undefined) {
    return meta.opensac.editorContext;
  }
  if (meta["opensac.dev"] !== undefined) {
    return meta["opensac.dev"].editorContext;
  }
  return undefined;
}

/** Returns the trimmed client surface label carried by prompt metadata. */
export function requestSurface(
  meta: RequestMeta | undefined | null,
): string {
  if (meta === undefined || meta === null) return "";
  if (
    meta.opensac !== undefined && (meta.opensac.surface ?? "").trim() !== ""
  ) {
    return (meta.opensac.surface ?? "").trim();
  }
  if (meta["opensac.dev"] !== undefined) {
    return (meta["opensac.dev"].surface ?? "").trim();
  }
  return "";
}

/** One ACP session mode projection. */
export interface SessionMode {
  id: string;
  name: string;
  description?: string;
}

/** The ACP session mode state projection. */
export interface SessionModeState {
  currentModeId: string;
  availableModes: SessionMode[];
}

/** Projects the standard ACP session modes for one Runtime session. */
export function sessionModes(
  runtime: SessionRuntime | null | undefined,
): SessionModeState | undefined {
  if (runtime === null || runtime === undefined) return undefined;
  const mode = runtime.configSnapshot().mode;
  return {
    currentModeId: mode,
    availableModes: [
      { id: MODE_AGENT, name: "Agent" },
      { id: MODE_PLAN, name: "Plan" },
      { id: MODE_YOLO, name: "Yolo" },
      { id: MODE_OS, name: "OS" },
    ],
  };
}

/**
 * Turns the optional editor snapshot into an explicit, bounded context block.
 * The snapshot is user-provided metadata, so it is labeled untrusted and is
 * never interpreted as an instruction by ACP itself.
 */
export function formatEditorContext(
  ctx: EditorContext | undefined | null,
): string {
  if (ctx === undefined || ctx === null) return "";
  const lines: string[] = [];
  if ((ctx.path ?? "").trim() !== "") {
    lines.push("Path: " + (ctx.path ?? "").trim());
  } else if ((ctx.uri ?? "").trim() !== "") {
    lines.push("URI: " + (ctx.uri ?? "").trim());
  }
  if ((ctx.language ?? "").trim() !== "") {
    lines.push("Language: " + (ctx.language ?? "").trim());
  }
  if (ctx.selection !== undefined) {
    let selection = ctx.selection.text ?? "";
    if (utf8Length(selection) > 80000) {
      selection = utf8Prefix(selection, 80000) + "\n[selection truncated]";
    }
    if (selection.trim() !== "") {
      lines.push(
        `Selection (lines ${ctx.selection.startLine ?? 0}-${
          ctx.selection.endLine ?? 0
        }):\n${selection}`,
      );
    }
  }
  for (const diagnostic of ctx.diagnostics ?? []) {
    const message = (diagnostic.message ?? "").trim();
    if (message === "") continue;
    let startLine = diagnostic.startLine ?? 0;
    let endLine = diagnostic.endLine ?? 0;
    if (startLine === 0) startLine = diagnostic.line ?? 0;
    if (endLine === 0) endLine = startLine;
    lines.push(
      `Diagnostic (${diagnostic.severity}, lines ${startLine}-${endLine}): ${message}`,
    );
  }
  if (lines.length === 0) return "";
  return "## Editor context (untrusted metadata)\n" + lines.join("\n");
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** Go's `len(string)`: the UTF-8 byte length. */
export function utf8Length(value: string): number {
  return utf8Encoder.encode(value).length;
}

/**
 * Go's byte-slice prefix `value[:maxBytes]`. A split multi-byte sequence is
 * replaced by U+FFFD, matching Go's `encoding/json` invalid-UTF-8 handling.
 */
export function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = utf8Encoder.encode(value);
  if (bytes.length <= maxBytes) return value;
  return utf8Decoder.decode(bytes.subarray(0, maxBytes));
}
