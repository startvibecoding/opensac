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
  createAgentManager,
} from "./agent_manager.ts";
import { SOURCE_UNKNOWN } from "./source.ts";

function stubRuntime(): AgentManagerRuntime {
  return {
    id: "s",
    manager: undefined,
    execution: undefined,
    entrySource: SOURCE_UNKNOWN,
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

Deno.test("agentManagerRequiresSharedDependencies", () => {
  assertThrows(
    () => createAgentManager({} as unknown as AgentManagerOptions),
    Error,
    "agent runtime is required",
  );
  assertThrows(
    () =>
      createAgentManager(
        { runtime: stubRuntime() } as unknown as AgentManagerOptions,
      ),
    Error,
    "agent runtime settings are required",
  );
  assertThrows(
    () =>
      createAgentManager(
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
      createAgentManager(
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
