// Public surface of src/agent (ported from internal/agent).
//
// The core loop (`Agent.Run*`/`loop`), the event-producing pipeline, the
// Agent-bound approval/question coordination, the request-assembly and
// compaction/recovery paths, the tool-execution/durable-claim paths, and the
// AgentAdapter bridge are ported. `manager.ts` (AgentManager), `factory.ts`
// (AgentFactory + public Builder registration), and `subagent.ts` (the
// sub-agent tools) complete the Agent Core; the background Responses tool-call
// methods remain deferred. See docs/proposal/go-to-deno-migration.md backlog
// #19.

export * from "./events.ts";
export * from "./agent.ts";
export * from "./bridge.ts";
export * from "./agent_approval.ts";
export * from "./agent_context.ts";
export * from "./agent_support.ts";
export * from "./compaction.ts";
export * from "./eventloop.ts";
export * from "./followup.ts";
export * from "./iteration_budget.ts";
export * from "./iteration_budget_tool.ts";
export * from "./mailbox.ts";
export * from "./max_tokens.ts";
export * from "./memberdef.ts";
export * from "./parallel.ts";
export * from "./router.ts";
export * from "./run_context.ts";
export * from "./subagent_wait.ts";
export * from "./subagent_support.ts";
export * from "./system_prompt.ts";
export * from "./tool_launch.ts";
export * from "./provider.ts";
export * from "./external_tool_adapter.ts";
export * from "./manager.ts";
export * from "./factory.ts";
export * from "./subagent.ts";
