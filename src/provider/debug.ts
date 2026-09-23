import type { ToolCallBlock, Usage } from "./types.ts";

/**
 * Suppresses debug stderr output while retaining debug.log. The interactive TUI
 * sets it so asynchronous provider output cannot disrupt Ink rendering.
 */
export const debugLogOnlyEnv = "VIBECODING_DEBUG_LOG_ONLY";

const debugEnv = "VIBECODING_DEBUG";

/**
 * DebugResponse is the complete response reconstructed from a streamed provider
 * response. It intentionally records the final result rather than individual SSE
 * fragments.
 */
export interface DebugResponse {
  provider: string;
  api: string;
  content?: string;
  reasoning?: string;
  toolCalls?: ToolCallBlock[];
  stopReason?: string;
  usage?: Usage;
  error?: string;
}

/**
 * Writes a JSON request or complete response to debug.log when --debug has
 * enabled VIBECODING_DEBUG. Non-TUI callers also receive it on stderr unless
 * debugLogOnlyEnv is set.
 */
export function debugJSON(label: string, body: string | Uint8Array): void {
  if ((Deno.env.get(debugEnv) ?? "") === "") return;

  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  const line = `[DEBUG] ${label}: ${text}\n`;

  try {
    Deno.writeTextFileSync("debug.log", line, { append: true, create: true });
  } catch {
    // best-effort logging; a missing/permission-denied file must not throw
  }
  if ((Deno.env.get(debugLogOnlyEnv) ?? "") === "") {
    try {
      Deno.stderr.writeSync(new TextEncoder().encode(line));
    } catch {
      // ignore
    }
  }
}

/**
 * Writes a diagnostic line to debug.log when --debug is enabled. Callers must
 * not include credentials or other secrets in the formatted values.
 */
export function debugLogf(format: string, ...args: unknown[]): void {
  if ((Deno.env.get(debugEnv) ?? "") === "") return;
  debugJSON("diagnostic", goSprintf(format, args));
}

/** Marshals a reconstructed non-SSE response for debug logging. */
export function debugCompleteResponse(response: DebugResponse): void {
  let body: string;
  try {
    body = JSON.stringify(response);
    if (body === undefined) throw new Error("response is not serializable");
  } catch (err) {
    const fallback = JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      response: debugResponseDump(response),
    });
    debugJSON("Response JSON marshal error", fallback);
    return;
  }
  debugJSON("Response JSON", body);
}

/**
 * Preserves fields that JSON marshaling cannot encode, notably tool arguments
 * reconstructed from a stream.
 */
function debugResponseDump(response: DebugResponse): string {
  const parts: string[] = [];
  parts.push(
    `provider=${fmtQ(response.provider)} api=${fmtQ(response.api)} ` +
      `content=${fmtQ(response.content ?? "")} ` +
      `reasoning=${fmtQ(response.reasoning ?? "")} ` +
      `stopReason=${fmtQ(response.stopReason ?? "")} ` +
      `usage=${fmtV(response.usage)} error=${fmtQ(response.error ?? "")}`,
  );
  const calls = response.toolCalls ?? [];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    parts.push(
      ` toolCall[${i}]={id=${fmtQ(call.id)} name=${fmtQ(call.name)} ` +
        `arguments=${fmtQ(stringifyArgs(call.arguments))} ` +
        `invalidArguments=${fmtQ(call.invalidArguments ?? "")} ` +
        `thoughtSignature=${fmtQ(call.thoughtSignature ?? "")}}`,
    );
  }
  return parts.join("");
}

function stringifyArgs(args: unknown): string {
  if (args === undefined) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args) ?? "";
  } catch {
    return String(args);
  }
}

function fmtQ(v: string): string {
  return JSON.stringify(v);
}

function fmtV(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (v instanceof Error) return v.message;
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/** Minimal Go fmt.Sprintf covering the verbs used by provider diagnostics. */
export function goSprintf(format: string, args: unknown[]): string {
  let out = "";
  let argIndex = 0;
  for (let i = 0; i < format.length; i++) {
    const ch = format[i];
    if (ch !== "%") {
      out += ch;
      continue;
    }
    // Handle width/precision like %.2f before the verb.
    let j = i + 1;
    let spec = "";
    while (j < format.length && /[0-9.]/.test(format[j])) {
      spec += format[j];
      j++;
    }
    const verb = format[j];
    if (verb === undefined) {
      out += "%";
      break;
    }
    i = j;
    if (verb === "%") {
      out += "%";
      continue;
    }
    const value = args[argIndex++];
    switch (verb) {
      case "q":
        out += typeof value === "string"
          ? JSON.stringify(value)
          : fmtQ(String(value));
        break;
      case "s":
      case "v":
        out += value === undefined || value === null
          ? "null"
          : typeof value === "string"
          ? value
          : fmtV(value);
        break;
      case "d":
      case "i":
        out += String(Math.trunc(Number(value)));
        break;
      case "f": {
        const digits = spec.startsWith(".") ? Number(spec.slice(1)) : 6;
        out += Number(value).toFixed(Number.isFinite(digits) ? digits : 6);
        break;
      }
      default:
        out += `%${spec}${verb}`;
    }
  }
  return out;
}
