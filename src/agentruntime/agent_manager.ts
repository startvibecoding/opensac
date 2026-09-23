//
// `newAgentManager` is the shared construction path that binds a
// provider-specific execution to a front-end-neutral Runtime: it builds an
// `AgentFactory` and `AgentManager` from the Runtime's sandbox, context, rules,
// and skills, installs the Runtime ownership fences, and resolves every mode
// through the one source-of-truth policy. Adapters must call this instead of
// assembling an `AgentFactory` independently.
//
// The Go `*SessionRuntime` receiver maps to the narrow `AgentManagerRuntime`
// view so the constructor can land before the SessionRuntime slice and so the
// function has no import cycle with it.

import {
  type AgentManager,
  type BeforeToolCallContext,
  compactionSettingsFromConfig,
  type MemberDef,
  type MemberMailbox,
  newAgentFactoryWithOptions,
  newMemberDefRegistry,
  type ToolCallBlockResult,
} from "../agent/mod.ts";
import { newAgentManager as buildAgentManagerImpl } from "../agent/manager.ts";
import type { AgentFactoryOptions } from "../agent/factory.ts";
import type { AllowConfig } from "../config/allow.ts";
import type { Settings } from "../config/settings.ts";
import type { Model } from "../provider/types.ts";
import type { Provider } from "../provider/provider.ts";
import type { Manager as SessionManager } from "../session/manager.ts";
import type { Manager as SandboxManager } from "../sandbox/sandbox.ts";
import type { Manager as SkillsManager } from "../skills/mod.ts";
import {
  type ExecutionPolicy,
  MODE_YOLO,
  policyForSource,
  type RuntimeSource,
  SOURCE_UNKNOWN,
  type SourceResolutionInput,
} from "./source.ts";
import {
  resolveManagerPolicy,
  resolveManagerSource,
} from "./session_source.ts";
import { beforeToolCallForPolicy } from "./tool_policy.ts";
import {
  beforeToolExecuteForRuntime,
  type ToolFenceRuntime,
} from "./tool_fence.ts";

/**
 * The Runtime view `newAgentManager` consumes. A SessionRuntime satisfies it
 * structurally; tests may supply a minimal stand-in.
 */
export interface AgentManagerRuntime extends ToolFenceRuntime {
  readonly entrySource: RuntimeSource;
  readonly sandboxMgr: SandboxManager | undefined;
  readonly extraContext: string;
  readonly ruleContent: string;
  readonly skillsMgr: SkillsManager | undefined;
  resolvedExecutionPolicy(defaultMode: string): ExecutionPolicy;
  expertState(): {
    binding: AgentManagerExpertBinding | null;
    mailbox: MemberMailbox | null;
  };
}

/** The expert identity fields the manager constructor consumes. */
export interface AgentManagerExpertBinding {
  id: string;
  team: boolean;
  identityPrompt: string;
  rosterPrompt: string;
  memberDefs: MemberDef[];
}

/** Binds provider-specific execution dependencies to a shared Runtime. */
export interface AgentManagerOptions {
  runtime: AgentManagerRuntime;
  provider: Provider;
  model: Model;
  settings: Settings;
  providerName?: string;
  allow?: AllowConfig;
  multiAgentEnabled?: boolean;
  delegateEnabled?: boolean;
  workflowsEnabled?: boolean;
}

/**
 * Constructs an AgentFactory and AgentManager using the shared runtime's
 * sandbox, context, rules and skills. All entry points should use this path
 * instead of assembling AgentFactory arguments independently.
 */
export function newAgentManager(opts: AgentManagerOptions): AgentManager {
  if (!opts || !opts.runtime) {
    throw new Error("agent runtime is required");
  }
  if (!opts.settings) {
    throw new Error("agent runtime settings are required");
  }
  if (!opts.provider) {
    throw new Error("agent provider is required");
  }
  if (!opts.model) {
    throw new Error("agent model is required");
  }
  const runtime = opts.runtime;
  const policy = runtime.resolvedExecutionPolicy(MODE_YOLO);
  const runtimeManager = runtime.manager;
  const entrySource = runtime.entrySource;
  // The Runtime's session manager is authoritative. Do not let a caller's
  // settings pointer redirect sub-agents to the platform-default session DB:
  // that would split child execution and durable state from the parent run.
  const effectiveSettings: Settings = { ...opts.settings };
  if (
    runtimeManager !== undefined && runtimeManager.getSessionDir() !== ""
  ) {
    effectiveSettings.sessionDir = runtimeManager.getSessionDir();
  }
  // A team expert binding forces multi-agent capability for the session at the
  // shared manager boundary; adapters may not downgrade it.
  const expertState = runtime.expertState();
  const expertBinding = expertState.binding;
  const mailbox = expertState.mailbox;
  const multiAgentEnabled = (opts.multiAgentEnabled ?? false) ||
    (expertBinding !== null && expertBinding.team);
  let expertIdentity = "";
  let expertRoster = "";
  if (expertBinding !== null) {
    expertIdentity = expertBinding.identityPrompt;
    expertRoster = expertBinding.rosterPrompt;
  }
  const currentSourceFor = (
    manager: SessionManager | undefined,
  ): RuntimeSource => {
    if (manager !== undefined && manager === runtimeManager) {
      return policy.source;
    }
    return SOURCE_UNKNOWN;
  };
  const compaction = compactionSettingsFromConfig(
    effectiveSettings.compaction ??
      { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
  );
  const factoryOptions: AgentFactoryOptions = {
    multiAgentEnabled,
    delegateEnabled: opts.delegateEnabled ?? false,
    workflowsEnabled: opts.workflowsEnabled ?? false,
    providerName: opts.providerName,
    allow: opts.allow,
    beforeToolCall: beforeToolCallForPolicy(policy, undefined) ?? undefined,
    beforeToolExecute: beforeToolExecuteForRuntime(runtime),
    forcedMode: policy.forcedMode(),
    resolveMode: (
      manager: SessionManager | undefined,
      requestedMode: string,
    ): string => {
      if (manager === undefined) {
        return policy.resolveMode("", requestedMode);
      }
      const input: SourceResolutionInput = {
        current: currentSourceFor(manager),
        requested: entrySource,
      };
      return resolveManagerPolicy(manager, input, "", requestedMode, MODE_YOLO)
        .mode;
    },
    beforeToolCallForSession: (
      manager: SessionManager | undefined,
    ):
      | ((ctx: BeforeToolCallContext) => ToolCallBlockResult | undefined)
      | undefined => {
      if (manager === undefined) {
        return undefined;
      }
      const input: SourceResolutionInput = {
        current: currentSourceFor(manager),
        requested: entrySource,
      };
      try {
        const resolved = resolveManagerSource(manager, input);
        return beforeToolCallForPolicy(
          policyForSource(resolved.source, MODE_YOLO),
          undefined,
        ) ?? undefined;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return () => ({ block: true, reason });
      }
    },
    expertIdentity,
    expertRoster,
  };
  const factory = newAgentFactoryWithOptions(
    opts.provider,
    opts.model,
    effectiveSettings,
    runtime.sandboxMgr,
    runtime.extraContext,
    runtime.ruleContent,
    runtime.skillsMgr,
    compaction,
    undefined,
    factoryOptions,
  );
  const manager = buildAgentManagerImpl(factory);
  // The session mailbox is installed for every session, not only for teams: a
  // member's question or completion must reach an active lead wherever members
  // can run (multi-agent, delegate, or workflow modes), and subagent_wait must
  // not be a dead tool outside a team binding. Only a bound team may hold its
  // run open for members, so the wrap-up wait stays team-only and unattended
  // entry points never gain a multi-minute wait.
  let members: ReturnType<typeof newMemberDefRegistry> | undefined;
  let expertID = "";
  let teamBound = false;
  if (expertBinding !== null) {
    members = newMemberDefRegistry(expertBinding.memberDefs);
    expertID = expertBinding.id;
    teamBound = expertBinding.team;
  }
  if (mailbox !== null || expertBinding !== null) {
    manager.setMemberContext(members, mailbox ?? undefined, expertID);
    manager.setMemberWaitEnabled(teamBound);
  }
  return manager;
}
