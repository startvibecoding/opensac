// Public surface of src/acp (ported from internal/acp).
//
// This module ports the front-end-neutral ACP wire vocabulary, the
// event/output projection helpers, the request-metadata vocabulary, the
// prompt/input normalization layer, the stdio JSON-RPC transport, the
// deterministic server-support helpers, and the ACP server shell
// (`AcpServer`: transport/notification glue, `initialize`/`doctor`, the
// §4.1–§4.8 additive extensions, the session catalog/lifecycle-mutation
// handlers, the agent-event projection, and prompt admission/cancellation).
// The management plane is owned by the shared Core Runtime. ACP only maps
// front-end-neutral wire methods to Core methods; it does not export the
// legacy direct management router.

export * from "./protocol.ts";
export * from "./projection.ts";
export * from "./metadata.ts";
export * from "./input.ts";
export * from "./wire.ts";
export * from "./support.ts";
export * from "./extensions.ts";
export * from "./server.ts";
export * from "./run.ts";
