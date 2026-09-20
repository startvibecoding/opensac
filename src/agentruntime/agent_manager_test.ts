// Translated from internal/agentruntime/agent_manager_test.go plus focused
// checks on the shared-construction guards.
//
// The Go integration case (`TestAgentManagerAppliesBoundSessionPolicyWithoutParent`)
// runs a real provider/Agent against a bound source and lands with the
// SessionRuntime slice; here we cover the dependency guards that do not build an
// Agent.

import { assertThrows } from "@std/assert";
import { defaultSettings } from "../config/settings.ts";
import type { Provider } from "../provider/provider.ts";
import {
  type AgentManagerOptions,
  type AgentManagerRuntime,
  newAgentManager,
} from "./agent_manager.ts";
import { SourceUnknown } from "./source.ts";

function stubRuntime(): AgentManagerRuntime {
  return {
    id: "s",
    manager: undefined,
    execution: undefined,
    entrySource: SourceUnknown,
    sandboxMgr: undefined,
    extraContext: "",
    ruleContent: "",
    skillsMgr: undefined,
    resolvedExecutionPolicy: () => {
      throw new Error("must not be reached");
    },
    expertState: () => ({ binding: null, mailbox: null }),
  };
}

Deno.test("newAgentManagerRequiresSharedDependencies", () => {
  assertThrows(
    () => newAgentManager({} as unknown as AgentManagerOptions),
    Error,
    "agent runtime is required",
  );
  assertThrows(
    () =>
      newAgentManager(
        { runtime: stubRuntime() } as unknown as AgentManagerOptions,
      ),
    Error,
    "agent runtime settings are required",
  );
  assertThrows(
    () =>
      newAgentManager(
        {
          runtime: stubRuntime(),
          settings: defaultSettings(),
        } as unknown as AgentManagerOptions,
      ),
    Error,
    "agent provider is required",
  );
  assertThrows(
    () =>
      newAgentManager(
        {
          runtime: stubRuntime(),
          settings: defaultSettings(),
          provider: {} as Provider,
        } as unknown as AgentManagerOptions,
      ),
    Error,
    "agent model is required",
  );
});
