// Ported from cmd/mothx/main_knowledge_mcp.go: the `knowledge-mcp serve`
// subcommand that exposes explicitly configured knowledge bases over the MCP
// stdio transport.

import { getSessionDir, loadSettings } from "../config/mod.ts";
import { KnowledgeMCPHandler } from "../agentruntime/knowledge_mcp.ts";
import { serveStdio } from "../mcp/server.ts";

export interface KnowledgeMCPCommandOptions {
  knowledgeBases: string[];
  sessionDir: string;
  signal?: AbortSignal;
  stdin?: ReadableStream<Uint8Array>;
  stdout?: WritableStream<Uint8Array>;
}

/** Runs until EOF or SIGINT/SIGTERM. */
function lifetimeSignal(signal?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  if (signal !== undefined) {
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
    if (signal.aborted) controller.abort(signal.reason);
  }
  const onTerminate = () => controller.abort();
  try {
    Deno.addSignalListener("SIGINT", onTerminate);
    Deno.addSignalListener("SIGTERM", onTerminate);
  } catch {
    // signal listeners are unavailable in some sandboxes; EOF still exits
  }
  return controller.signal;
}

/** Serves one stdio MCP server for the listed knowledge-base IDs. */
export async function executeKnowledgeMCPCommand(
  opts: KnowledgeMCPCommandOptions,
): Promise<void> {
  let sessionDir = opts.sessionDir.trim();
  if (sessionDir === "") {
    const settings = loadSettings();
    sessionDir = getSessionDir(settings);
  }
  if (opts.knowledgeBases.length === 0) {
    throw new Error("at least one --knowledge-base ID is required");
  }
  const handler = KnowledgeMCPHandler.create(
    sessionDir,
    opts.knowledgeBases,
  );
  await serveStdio(
    lifetimeSignal(opts.signal),
    opts.stdin ?? Deno.stdin.readable,
    opts.stdout ?? Deno.stdout.writable,
    handler,
  );
}
