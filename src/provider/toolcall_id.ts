// Ported from internal/provider/toolcall_id.go

let toolCallFallbackCounter = 0;

/** Returns a process-wide unique fallback ID for tool calls. */
export function nextToolCallFallbackId(prefix: string): string {
  toolCallFallbackCounter += 1;
  return `${prefix}_${toolCallFallbackCounter}`;
}
