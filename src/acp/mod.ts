// Public surface of src/acp (ported from internal/acp).
//
// This module ports the front-end-neutral ACP wire vocabulary, the
// event/output projection helpers, the request-metadata vocabulary, the
// prompt/input normalization layer, the stdio JSON-RPC transport, the
// deterministic server-support helpers, and the ACP server shell
// (`AcpServer`: transport/notification glue, `initialize`/`doctor`, the
// §4.1–§4.8 additive extensions, the session catalog/lifecycle-mutation
// handlers, the agent-event projection, and prompt admission/cancellation).
// `manage.ts` ports the first `mothx/manage/*` slice (shared helpers plus the
// env/experts/application families). The stdio dispatch loop, the prompt run,
// MCP sampling, and the remaining `mothx/manage/*` families land in later
// slices. See docs/proposal/go-to-deno-migration.md backlog #35.

export * from "./protocol.ts";
export * from "./projection.ts";
export * from "./metadata.ts";
export * from "./input.ts";
export * from "./wire.ts";
export * from "./support.ts";
export * from "./extensions.ts";
export * from "./manage.ts";
export * from "./manage_skillhub.ts";
export * from "./server.ts";
export * from "./run.ts";
