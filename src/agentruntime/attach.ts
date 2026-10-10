//
// `AttachedResources` are adapter-policy-selected resources attached to the
// common runtime. Use this only when protocol-specific registry or MCP policy
// cannot yet be represented by `Builder`; the Runtime retains all lifecycle
// ownership.

import { createMemberMailbox } from "../agent/mod.ts";
import { type Settings } from "../config/settings.ts";
import { Center } from "../expert/center.ts";
import type { Client } from "../mcp/mcp.ts";
import type { Manager as SandboxManager } from "../sandbox/sandbox.ts";
import type { Manager as SessionManager } from "../session/manager.ts";
import type { Manager as SkillsManager } from "../skills/mod.ts";
import type { Registry } from "../tools/tool.ts";
import { defaultAttachmentPolicy } from "./attachment.ts";
import { AttachmentService } from "./input.ts";
import { defaultInputPolicy, InputMaterializer } from "./input_materializer.ts";
import { normalizeAdditionalDirectories } from "./session_directories.ts";
import { SessionRuntime } from "./session_runtime.ts";
import { type ProviderCatalog } from "./session_options.ts";
import { resolveManagerSource } from "./session_source.ts";
import {
  policyForSource,
  type RuntimeSource,
  SOURCE_UNKNOWN,
} from "./source.ts";

/** Adapter-policy-selected resources attached to the common runtime. */
export interface AttachedResources {
  id?: string;
  source?: RuntimeSource;
  entrySource?: RuntimeSource;
  workDir: string;
  manager?: SessionManager;
  registry?: Registry;
  sandboxMgr?: SandboxManager;
  skillsMgr?: SkillsManager;
  mcpClients?: Client[];
  providers?: ProviderCatalog;
  extraContext?: string;
  ruleContent?: string;
  additionalDirectories?: string[];
  settings?: Settings;
  workflows?: boolean;
  browser?: boolean;
  artifactEnabled?: boolean;
}

/**
 * Creates a SessionRuntime around already-selected resources. It validates the
 * session ownership boundary and is the sole compatibility bridge for adapters
 * with protocol-specific Registry/MCP policy.
 */
export async function attachSessionResources(
  resources: AttachedResources,
): Promise<SessionRuntime> {
  const manager = resources.manager;
  const registry = resources.registry;
  if (
    (resources.workDir ?? "") === "" || manager === undefined ||
    registry === undefined
  ) {
    throw new Error(
      "runtime work directory, session manager, and registry are required",
    );
  }
  let id = resources.id ?? "";
  if (id === "" && manager.getHeader() !== null) {
    id = manager.getHeader()!.id;
  }
  if (id === "") {
    throw new Error("runtime session ID is required");
  }
  const additionalDirectories = normalizeAdditionalDirectories(
    resources.additionalDirectories ?? [],
  );
  const resolved = resolveManagerSource(manager, {
    requested: resources.source ?? SOURCE_UNKNOWN,
  });
  let entrySource = resources.entrySource ?? SOURCE_UNKNOWN;
  if (entrySource === SOURCE_UNKNOWN) {
    entrySource = resources.source ?? SOURCE_UNKNOWN;
  }
  const attachments = new AttachmentService(
    manager.getSessionDir(),
    defaultAttachmentPolicy(),
  );
  const inputs = new InputMaterializer(
    manager.getSessionDir(),
    resources.workDir,
    defaultInputPolicy(),
  );
  const runtime = new SessionRuntime({
    id,
    source: resolved.source,
    entrySource,
    policy: policyForSource(resolved.source, ""),
    workDir: resources.workDir,
    manager,
    inputs,
    attachments,
    registry,
    sandboxMgr: resources.sandboxMgr,
    skillsMgr: resources.skillsMgr,
    mcpClients: resources.mcpClients ?? [],
    providers: resources.providers ?? {},
    extraContext: resources.extraContext ?? "",
    ruleContent: resources.ruleContent ?? "",
    additionalDirectories,
    artifactEnabled: resources.artifactEnabled ?? false,
    resourceSettings: resources.settings ?? null,
    resourceWorkflows: resources.workflows ?? false,
    resourceBrowser: resources.browser ?? false,
  });
  runtime.mailbox = createMemberMailbox();
  runtime.expertCenter = new Center(resources.workDir);
  await runtime.rehydrateBoundResources();
  runtime.reloadAdditionalDirectories(manager);
  return runtime;
}
