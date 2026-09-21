// Ported from internal/serve/openaiapi/commands.go — the full slash-command
// cluster. handleCommand processes a /xxx command and returns null when the
// input is not a command (it should go to the agent instead).
//
// Deviations: Go's sync handlers become async where a collaborator is async in
// the Deno port (patchActiveSessionCapabilities, the runtime-owned session
// delete, attachSessionResources, agent compaction, and the workflow file
// store); handleCommand therefore returns a promise. Go's `s.provider`,
// `s.model`, and allow accessors map to the Server fields directly (Deno is
// single-threaded, so the mutex pairs collapse). The ESM command lives in
// commands_esm.ts and the Server ESM operations in esm_api.ts.
import {
  addEditPath,
  clearEditPaths,
  editPathList,
  getAutoEdit,
  removeEditPath,
  saveGlobalAutoEditValue,
  saveProject,
  setGlobalAutoEdit,
  setProjectAutoEdit,
} from "../../config/allow.ts";
import {
  loadGlobalSettingsSparse,
  loadProjectSettingsSparse,
  saveGlobalSettings,
  saveProjectSettings,
  type Settings,
} from "../../config/settings.ts";
import { listForDirDetailed } from "../../session/manager.ts";
import { deleteSession } from "../../agentruntime/session_lifecycle.ts";
import { ModeYolo, SourceWebUI } from "../../agentruntime/source.ts";
import { attachSessionResources } from "../../agentruntime/attach.ts";
import { subAgentToolsEnabled } from "../../agentruntime/session_runtime.ts";
import { ensureRuleFile, ruleFile } from "../../contextfiles/contextfiles.ts";
import {
  registerDelegateSubAgentTool,
  registerSubAgentTools,
} from "../../agent/subagent.ts";
import { defaultStore, registerWorkflowTools } from "../../workflow/tools.ts";
import { defaultActiveRegistry } from "../../workflow/active.ts";
import type { RunState } from "../../workflow/types.ts";
import { create } from "../../provider/factory/factory.ts";
import type { Provider } from "../../provider/provider.ts";
import type { Model } from "../../provider/types.ts";
import { newRunContext } from "../../agent/run_context.ts";
import { newRegistry } from "../../tools/tool.ts";
import type { Skill } from "../../skills/skills.ts";
import type { SessionRuntime } from "../../agentruntime/session_runtime.ts";
import type { Agent } from "../../agent/agent.ts";
import type { APISession } from "./session_mgr.ts";
import type { Server } from "./server.ts";
import { getWorkDir } from "./config.ts";
import { modelIDs } from "./chat_support.ts";
import {
  esmSteeringMessages,
  newAgentManagerForSession,
  settingsForSession,
} from "./handler_chat_session.ts";
import { cmdESM } from "./commands_esm.ts";
import { activateSkillForSession } from "./skillhub_session.ts";
import type { SessionCapabilityPatch } from "./types.ts";
import { patchActiveSessionCapabilities } from "./session_patch.ts";

/** CommandResult holds the output of a slash command. */
export interface CommandResult {
  message: string;
  error: boolean;
}

/**
 * handleCommandFn binds the Server slash-command cluster into the
 * `server.handleCommand` hook (Go's `s.handleCommand` method). Returns null
 * for non-command input so the caller submits it to the agent.
 */
export function handleCommandFn(
  server: Server,
): (
  sess: APISession,
  input: string,
  ...runIds: string[]
) => Promise<CommandResult | null> {
  return async (
    sess: APISession,
    input: string,
    ...runIds: string[]
  ): Promise<CommandResult | null> => {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return null;

    const parts = trimmed.split(/\s+/).filter((p) => p !== "");
    if (parts.length === 0) return null;

    const runID = runIds.length > 0 ? runIds[0] : "";
    const cmd = parts[0];
    switch (cmd) {
      case "/clear":
        return cmdClear(sess);
      case "/mode":
        return await cmdMode(server, sess, parts, runID);
      case "/model":
        return cmdModel(server, parts);
      case "/defaultModel":
        return await cmdDefaultModel(server, parts);
      case "/models":
        return cmdModels(server);
      case "/sessions":
        return await cmdSessionsForSession(server, sess, parts);
      case "/status":
        return cmdStatus(server, sess);
      case "/compact":
        return await cmdCompact(server, sess);
      case "/delegate":
        return await cmdDelegate(server, sess, parts, runID);
      case "/alloweditpath":
        return cmdAllowEditPath(server, parts);
      case "/allowautoedit":
        return cmdAllowAutoEdit(server, parts);
      case "/workflows":
        return cmdWorkflows(parts);
      case "/skill":
        return cmdSkill(server, sess, parts);
      case "/skills":
        return cmdSkills(server, sess);
      case "/rule":
        return await cmdRule(server, sess, parts);
      case "/esm":
        return await cmdESM(server, sess, trimmed);
      case "/help":
        return cmdHelp();
      default:
        return {
          message:
            `Unknown command: ${cmd}. Type /help for available commands.`,
          error: true,
        };
    }
  };
}

export function cmdClear(sess: APISession | null): CommandResult {
  if (!sess) {
    return { message: "No active session to clear.", error: true };
  }
  // The session manager keeps persisted SQLite state, but we reset the
  // in-memory state. The caller will set agent=null so the next request builds
  // a fresh agent.
  return { message: "✅ Conversation cleared", error: false };
}

export async function cmdMode(
  server: Server,
  sess: APISession | null,
  parts: string[],
  runId = "",
): Promise<CommandResult> {
  if (parts.length > 1) {
    switch (parts[1]) {
      case "plan":
      case "agent":
      case "yolo":
      case "os":
        if (sess) {
          const mode = parts[1];
          const patch: SessionCapabilityPatch = { mode };
          try {
            await patchActiveSessionCapabilities(
              server,
              sess,
              patch,
              "slash_mode",
              "user",
              runId,
              { command: "/mode" },
            );
          } catch (err) {
            return {
              message: `Failed to save mode: ${(err as Error).message}`,
              error: true,
            };
          }
        }
        return { message: `Mode: ${parts[1].toUpperCase()}`, error: false };
      default:
        return {
          message: "Invalid mode. Use: plan, agent, yolo, os",
          error: true,
        };
    }
  }
  let mode = server.cfg?.defaultMode ?? "";
  if (sess && sess.mode !== "") mode = sess.mode;
  return { message: `Current mode: ${mode.toUpperCase()}`, error: false };
}

export function cmdModel(server: Server, parts: string[]): CommandResult {
  if (parts.length > 1) {
    const modelID = parts[1];
    const newModel = server.provider?.getModel(modelID);
    if (!newModel) {
      return {
        message: `Model "${modelID}" not found — available: ${
          modelIDs(server.provider?.models() ?? [])
        }`,
        error: true,
      };
    }
    server.model = newModel;
    return {
      message: `✅ Model switched to: ${newModel.name} (${newModel.id})`,
      error: false,
    };
  }
  const m = server.model!;
  return { message: `Current model: ${m.name} (${m.id})`, error: false };
}

export function cmdDefaultModel(
  server: Server,
  parts: string[],
): CommandResult {
  if (parts.length !== 3 && parts.length !== 4) {
    return {
      message: "Usage: /defaultModel <provider> <model> [project|global]",
      error: true,
    };
  }
  const providerID = parts[1];
  const modelID = parts[2];
  let scope = "global";
  if (parts.length === 4) {
    switch (parts[3]) {
      case "project":
      case "global":
        scope = parts[3];
        break;
      default:
        return {
          message: "Usage: /defaultModel <provider> <model> [project|global]",
          error: true,
        };
    }
  }

  if (!server.settings) {
    return { message: "Settings are unavailable.", error: true };
  }
  const runtime: Settings = { ...server.settings };
  runtime.defaultProvider = providerID;
  runtime.defaultModel = modelID;

  let p: Provider;
  let m: Model;
  try {
    ({ provider: p, model: m } = create(runtime, providerID, modelID));
  } catch (err) {
    return {
      message: `Provider validation failed: ${(err as Error).message}`,
      error: true,
    };
  }

  let scoped: Settings;
  try {
    scoped = loadDefaultModelSettings(scope);
  } catch (err) {
    return {
      message: `Failed to load ${scope} settings: ${(err as Error).message}`,
      error: true,
    };
  }
  scoped.defaultProvider = providerID;
  scoped.defaultModel = modelID;
  try {
    saveDefaultModelSettings(scope, scoped);
  } catch (err) {
    return {
      message: `Failed to save ${scope} settings: ${(err as Error).message}`,
      error: true,
    };
  }

  server.settings = runtime;
  server.provider = p;
  server.model = m;
  return {
    message: `✅ Default model saved (${scope}): ${providerID} / ${modelID}`,
    error: false,
  };
}

function loadDefaultModelSettings(scope: string): Settings {
  switch (scope) {
    case "global":
      return loadGlobalSettingsSparse();
    default:
      return loadProjectSettingsSparse();
  }
}

function saveDefaultModelSettings(scope: string, settings: Settings): void {
  switch (scope) {
    case "global":
      saveGlobalSettings(settings);
      return;
    default:
      saveProjectSettings(settings);
  }
}

export function cmdModels(server: Server): CommandResult {
  const models = server.provider?.models() ?? [];
  if (models.length === 0) {
    return { message: "No models available.", error: false };
  }
  const lines: string[] = ["Available models:"];
  const currentID = server.model?.id ?? "";
  for (const m of models) {
    const marker = m.id === currentID ? "*" : " ";
    lines.push(`  [${marker}] ${m.name} (${m.id})`);
  }
  return { message: lines.join("\n"), error: false };
}

export async function cmdSessionsForSession(
  server: Server,
  sess: APISession | null,
  parts: string[],
): Promise<CommandResult> {
  const sub = parts.length > 1 ? parts[1].toLowerCase() : "ls";
  switch (sub) {
    case "ls":
    case "list": {
      const cwd = sess && sess.workDir !== ""
        ? sess.workDir
        : (server.cfg ? getWorkDir(server.cfg) : "");
      const ids = server.pool?.listForWorkDir(cwd) ?? [];
      if (ids.length === 0) {
        return { message: "No active sessions.", error: false };
      }
      const lines = [`Active sessions (${ids.length}):`];
      for (const id of ids) lines.push(`  - ${id}`);
      return { message: lines.join("\n"), error: false };
    }
    case "clear":
    case "new":
      return {
        message: "✅ Start a new request context to begin a fresh session.",
        error: false,
      };
    case "del":
    case "delete":
    case "rm": {
      if (parts.length < 3) {
        return { message: "Usage: /sessions del <id>", error: true };
      }
      const id = parts[2].trim();
      let currentID = "";
      let cwd = "";
      if (sess) {
        currentID = sess.id;
        if (sess.manager?.getHeader()) cwd = sess.manager.getHeader()!.cwd;
      }
      if (cwd === "") cwd = server.cfg ? getWorkDir(server.cfg) : "";
      const sessDir = server.sessionDir();
      let details;
      try {
        details = listForDirDetailed(cwd, sessDir);
      } catch (err) {
        return {
          message: `Failed to list sessions: ${(err as Error).message}`,
          error: true,
        };
      }
      let match: (typeof details)[number] | null = null;
      for (const d of details) {
        if (d.id.startsWith(id)) {
          if (match !== null) {
            return {
              message: `Ambiguous ID '${id}'. Be more specific.`,
              error: true,
            };
          }
          match = d;
        }
      }
      if (match !== null) {
        if (currentID !== "" && match.id === currentID) {
          return {
            message:
              "Cannot delete the current session. Switch to another session first, or use /clear to start fresh.",
            error: true,
          };
        }
        try {
          await deleteSession(sessDir, match.id);
        } catch (err) {
          return {
            message: `Failed to delete session: ${(err as Error).message}`,
            error: true,
          };
        }
        server.pool?.removeByWorkDir(cwd, match.id);
        for (const [workDir, sessID] of server.defaultSessionIDs) {
          if (sessID === match.id) server.defaultSessionIDs.delete(workDir);
        }
        return {
          message: `✅ Session ${match.id} deleted.`,
          error: false,
        };
      }
      return { message: `Session not found: ${id}`, error: true };
    }
    default:
      return {
        message: "Usage: /sessions [ls|clear|del <id>]",
        error: true,
      };
  }
}

export function cmdStatus(
  server: Server,
  sess: APISession | null,
): CommandResult {
  if (!sess) {
    return { message: "No active session.", error: true };
  }
  let mode = server.cfg?.defaultMode ?? "";
  if (sess.mode !== "") mode = sess.mode;
  const modelID = server.model?.id ?? "";
  const msgCount = sess.manager ? sess.manager.getMessages().length : 0;
  const msg =
    `Session: ${sess.id}\nMode: ${mode.toUpperCase()}\nModel: ${modelID}\nMessages: ${msgCount}\nWorkDir: ${sess.workDir}`;
  return { message: msg, error: false };
}

export function cmdDelegate(
  server: Server,
  sess: APISession | null,
  parts: string[],
  runId = "",
): Promise<CommandResult> {
  if (!sess) {
    return Promise.resolve({ message: "No active session.", error: true });
  }
  if (parts.length < 2 || parts[1] === "status") {
    const state = sess.delegateMode ? "ON" : "OFF";
    return Promise.resolve({
      message: `Delegation mode: ${state}`,
      error: false,
    });
  }
  switch (parts[1]) {
    case "on":
    case "off": {
      const enabled = parts[1] === "on";
      const patch: SessionCapabilityPatch = { delegateMode: enabled };
      return patchActiveSessionCapabilities(
        server,
        sess,
        patch,
        "slash_delegate",
        "user",
        runId,
        { command: `/delegate ${parts[1]}` },
      ).then(() => ({
        message: "Delegation mode: " + (enabled ? "ON" : "OFF"),
        error: false,
      })).catch((err: unknown) => ({
        message: `Failed to save delegation mode: ${(err as Error).message}`,
        error: true,
      }));
    }
    default:
      return Promise.resolve({
        message: "Usage: /delegate [on|off|status]",
        error: true,
      });
  }
}

export function cmdAllowEditPath(
  server: Server,
  parts: string[],
): CommandResult {
  const allow = server.getAllow();
  if (parts.length < 2) {
    const paths = editPathList(allow);
    if (paths.length === 0) {
      return {
        message:
          "Auto-edit path whitelist is empty. Usage: /alloweditpath add|remove <glob>|clear",
        error: false,
      };
    }
    const lines = ["Auto-edit path whitelist (agent mode):"];
    for (const p of paths) lines.push(`  ${p}`);
    return { message: lines.join("\n").replace(/\n$/, ""), error: false };
  }
  switch (parts[1]) {
    case "add": {
      if (parts.length < 3) {
        return { message: "Usage: /alloweditpath add <glob>", error: true };
      }
      const glob = parts.slice(2).join(" ");
      if (!addEditPath(allow, glob)) {
        return { message: `Already in whitelist: ${glob}`, error: false };
      }
      try {
        saveProject(allow);
      } catch (err) {
        return {
          message: `Failed to save allow.json: ${(err as Error).message}`,
          error: true,
        };
      }
      return {
        message: `✅ Added to auto-edit whitelist: ${glob}`,
        error: false,
      };
    }
    case "remove":
    case "rm": {
      if (parts.length < 3) {
        return {
          message: "Usage: /alloweditpath remove <glob>",
          error: true,
        };
      }
      const glob = parts.slice(2).join(" ");
      if (!removeEditPath(allow, glob)) {
        return { message: `Not in whitelist: ${glob}`, error: false };
      }
      try {
        saveProject(allow);
      } catch (err) {
        return {
          message: `Failed to save allow.json: ${(err as Error).message}`,
          error: true,
        };
      }
      return {
        message: `✅ Removed from auto-edit whitelist: ${glob}`,
        error: false,
      };
    }
    case "clear":
      clearEditPaths(allow);
      try {
        saveProject(allow);
      } catch (err) {
        return {
          message: `Failed to save allow.json: ${(err as Error).message}`,
          error: true,
        };
      }
      return { message: "✅ Auto-edit path whitelist cleared", error: false };
    default:
      return {
        message: "Usage: /alloweditpath [add <glob>|remove <glob>|clear]",
        error: true,
      };
  }
}

export function cmdAllowAutoEdit(
  server: Server,
  parts: string[],
): CommandResult {
  const allow = server.getAllow();
  if (parts.length < 2) {
    const state = getAutoEdit(allow) ? "ON" : "OFF";
    return {
      message:
        `Auto-edit (agent mode): ${state}\nUsage: /allowautoedit [on|off] [global]`,
      error: false,
    };
  }
  let globalScope = false;
  for (const p of parts.slice(2)) {
    if (p === "global") globalScope = true;
  }
  let enable: boolean;
  switch (parts[1]) {
    case "on":
      enable = true;
      break;
    case "off":
      enable = false;
      break;
    default:
      return {
        message: "Usage: /allowautoedit [on|off] [global]",
        error: true,
      };
  }
  let err: unknown = undefined;
  let scope = "project";
  let effective = enable;
  if (globalScope) {
    scope = "global";
    effective = setGlobalAutoEdit(allow, enable);
    try {
      saveGlobalAutoEditValue(enable);
    } catch (e) {
      err = e;
    }
  } else {
    setProjectAutoEdit(allow, enable);
    try {
      saveProject(allow);
    } catch (e) {
      err = e;
    }
  }
  if (err !== undefined) {
    return {
      message: `Failed to save allow.json: ${(err as Error).message}`,
      error: true,
    };
  }
  const state = enable ? "ON" : "OFF";
  let msg = `✅ Auto-edit (agent mode): ${state} [${scope}]`;
  if (globalScope && effective !== enable) {
    const effectiveState = effective ? "ON" : "OFF";
    msg += ` (effective here: ${effectiveState} due to project override)`;
  }
  return { message: msg, error: false };
}

export async function cmdCompact(
  server: Server,
  sess: APISession | null,
): Promise<CommandResult> {
  if (!sess) {
    return { message: "No active session.", error: true };
  }
  if (!sess.manager) {
    return { message: "No active session.", error: true };
  }

  let a: Agent;
  try {
    a = await agentForCommandCompaction(server, sess);
  } catch (err) {
    return {
      message: `Context compaction failed: ${(err as Error).message}`,
      error: true,
    };
  }
  const replayState = sess.manager.getReplayState();
  if (replayState.messages.length > 0) {
    a.loadHistoryState(replayState.messages, replayState.entryIDs);
  }
  // Go uses a buffered channel and drains it afterwards; the events are
  // collected and dropped the same way here.
  const events: unknown[] = [];
  try {
    const err = await a.compact(
      newRunContext(),
      () => (events.push(null), true),
      true,
    );
    if (err !== undefined) {
      return {
        message: `Context compaction failed: ${err.message}`,
        error: true,
      };
    }
  } catch (err) {
    return {
      message: `Context compaction failed: ${(err as Error).message}`,
      error: true,
    };
  }
  return { message: "✅ Context compacted.", error: false };
}

export async function buildSessionRuntimeForCommand(
  server: Server,
  sess: APISession,
): Promise<SessionRuntime> {
  if (!sess || !sess.manager || !sess.registry) {
    throw new Error("session runtime resources are unavailable");
  }
  return await attachSessionResources({
    id: sess.id,
    source: SourceWebUI,
    workDir: sess.workDir,
    manager: sess.manager,
    registry: sess.registry,
    sandboxMgr: sess.sandboxMgr,
    skillsMgr: sess.skillsMgr,
    mcpClients: sess.mcpClients,
    extraContext: sess.extraContext,
    ruleContent: sess.ruleContent,
    settings: server.settings ?? undefined,
    workflows: sess.workflows,
    browser: sess.browser,
    artifactEnabled: server.cfg?.enableArtifact ?? false,
  });
}

export async function agentForCommandCompaction(
  server: Server,
  sess: APISession,
): Promise<Agent> {
  if (!sess) throw new Error("session is unavailable");
  if (!sess.registry) {
    sess.registry = newRegistry(sess.workDir, undefined);
    sess.registry.registerDefaults();
  }
  if (!sess.runtime) {
    sess.runtime = await buildSessionRuntimeForCommand(server, sess);
  }
  const runtimeSettings = settingsForSession(server, sess)!;
  let mode = sess.mode;
  if (mode === "") mode = runtimeSettings.defaultMode ?? "";
  if (mode === "") mode = ModeYolo;
  return sess.runtime.buildAgent({
    provider: server.provider,
    providerName: server.providerName,
    model: server.model,
    settings: runtimeSettings,
    allow: server.getAllow(),
    mode,
    thinkingLevel: server.cfg?.defaultThinkingLevel ?? "",
    multiAgent: sess.multiAgent,
    delegateMode: sess.delegateMode,
    workflows: sess.workflows,
    getSteeringMessages: esmSteeringMessages(server, sess.id),
  });
}

export async function cmdRule(
  server: Server,
  sess: APISession | null,
  parts: string[],
): Promise<CommandResult> {
  if (!sess) {
    return { message: "No active session.", error: true };
  }
  if (sess.agentMgr && sess.agentMgr.hasRunning()) {
    return {
      message: "Cannot change rule while agents are running.",
      error: true,
    };
  }
  const parsed = parseRuleForce(parts);
  if (!parsed.ok) {
    return { message: "Usage: /rule [force|--force]", error: true };
  }
  const overwrite = parsed.force;

  let path: string;
  let content: string;
  let written: boolean;
  try {
    ({ path, content, written } = ensureRuleFile(sess.workDir, overwrite));
  } catch (err) {
    return {
      message: `Failed to write rule file: ${(err as Error).message}`,
      error: true,
    };
  }
  sess.ruleContent = content;
  if (sess.agentMgr) {
    sess.agentMgr = await newAgentManagerForSession(server, sess);
    if (
      subAgentToolsEnabled(sess.runtime, sess.multiAgent) && sess.agentMgr &&
      sess.registry
    ) {
      registerSubAgentTools(sess.registry, sess.agentMgr);
    }
    if (sess.delegateMode && sess.agentMgr && sess.registry) {
      registerDelegateSubAgentTool(sess.registry, sess.agentMgr);
    }
    if (sess.workflows && sess.agentMgr && sess.registry) {
      registerWorkflowTools(sess.registry, { manager: sess.agentMgr });
    }
  }

  if (written) {
    const action = overwrite ? "Overwrote" : "Created";
    return {
      message: `${action} rule file: ${path}\nLoaded into the current session.`,
      error: false,
    };
  }
  return {
    message:
      `Rule file already exists: ${path}\nNot overwritten. Use /rule force to replace it with the default template.\nLoaded existing rule into the current session.`,
    error: false,
  };
}

export function parseRuleForce(
  parts: string[],
): { force: boolean; ok: boolean } {
  if (parts.length === 1) return { force: false, ok: true };
  if (parts.length !== 2) return { force: false, ok: false };
  switch (parts[1]) {
    case "force":
    case "--force":
      return { force: true, ok: true };
    default:
      return { force: false, ok: false };
  }
}

export function cmdSkill(
  server: Server,
  sess: APISession | null,
  parts: string[],
): Promise<CommandResult> {
  const skillsMgr = sessionSkills(server, sess);
  if (!skillsMgr) {
    return Promise.resolve({ message: "No skills available.", error: true });
  }
  if (parts.length < 2) {
    return Promise.resolve(cmdSkills(server, sess));
  }
  const name = parts[1];
  const skill = skillsMgr.get(name);
  if (!skill) {
    return Promise.resolve({
      message: `Skill not found: ${name}`,
      error: true,
    });
  }
  if (!sess) {
    return Promise.resolve({ message: "No active session.", error: true });
  }
  return activateSkillForSession(server, sess, name).then(() => ({
    message: `✅ Skill '${name}' activated: ${skill.description}`,
    error: false,
  })).catch((err: unknown) => ({
    message: `Failed to activate skill: ${(err as Error).message}`,
    error: true,
  }));
}

export function cmdSkills(
  server: Server,
  sess: APISession | null,
): CommandResult {
  const skillsMgr = sessionSkills(server, sess);
  if (!skillsMgr) {
    return { message: "No skills available.", error: false };
  }
  const skillList = skillsMgr.list();
  if (skillList.length === 0) {
    return { message: "No skills found.", error: false };
  }
  const lines = ["Available skills:"];
  for (const sk of skillList) {
    lines.push(`  - ${sk.name} (${sk.source}): ${sk.description}`);
  }
  return { message: lines.join("\n"), error: false };
}

export function sessionSkills(
  server: Server,
  sess: APISession | null,
): SkillsManagerLike | undefined {
  if (sess && sess.skillsMgr) return sess.skillsMgr;
  return server.skillsMgr;
}

interface SkillsManagerLike {
  get(name: string): Skill | undefined;
  list(): Skill[];
}

export async function cmdWorkflows(parts: string[]): Promise<CommandResult> {
  const store = defaultStore();
  const sub = parts.length > 1 ? parts[1].toLowerCase() : "list";
  switch (sub) {
    case "list":
    case "ls": {
      let runs: RunState[];
      try {
        runs = await store.list();
      } catch (err) {
        return {
          message: `Failed to list workflows: ${(err as Error).message}`,
          error: true,
        };
      }
      if (runs.length === 0) {
        return { message: "Workflow runs: (none)", error: false };
      }
      const lines = [`Workflow runs (${runs.length}):`];
      for (const run of runs) {
        lines.push(`  [${run.status}] ${run.id} ${run.name}`);
      }
      return {
        message: lines.join("\n").replace(/\n$/, ""),
        error: false,
      };
    }
    case "show": {
      if (parts.length < 3) {
        return { message: "Usage: /workflows show <id>", error: true };
      }
      let run: RunState;
      try {
        run = await store.load(parts[2]);
      } catch (err) {
        return {
          message: `Failed to load workflow: ${(err as Error).message}`,
          error: true,
        };
      }
      const lines = [`Workflow ${run.id}: ${run.status}`];
      if (run.name !== "") lines.push(`Name: ${run.name}`);
      for (const phase of run.phases ?? []) {
        lines.push(
          `Phase [${phase.status}] ${phase.name} tasks=${
            (phase.tasks ?? []).length
          }`,
        );
      }
      for (const [key, result] of Object.entries(run.results ?? {})) {
        lines.push(
          `\n${key} [${result.status}]\n${(result.result ?? "").trim()}`,
        );
      }
      if (run.error) lines.push(`\nError: ${run.error}`);
      return { message: lines.join("\n").replace(/\n$/, ""), error: false };
    }
    case "cancel": {
      if (parts.length < 3) {
        return { message: "Usage: /workflows cancel <id>", error: true };
      }
      const id = parts[2].trim();
      if (!defaultActiveRegistry().cancel(id)) {
        return {
          message: `Workflow run ${id} is not active.`,
          error: true,
        };
      }
      return {
        message: `Workflow run ${id} cancellation requested.`,
        error: false,
      };
    }
    default:
      return {
        message: "Usage: /workflows [list|show <id>|cancel <id>]",
        error: true,
      };
  }
}

export function cmdHelp(): CommandResult {
  const help = `Available commands:
  /clear                  - Clear conversation context
  /mode [plan|agent|yolo|os] - Show or switch mode
  /model [model_id]       - Show or switch model
  /defaultModel <provider> <model> [project|global] - Set default provider/model (default: global)
  /models                 - List available models
  /sessions               - List active sessions
  /sessions del <id>      - Delete a session
  /compact                - Trigger context compaction
  /delegate [on|off|status] - Toggle delegation mode
  /alloweditpath [add <glob>|remove <glob>|clear] - Auto-edit path whitelist
  /allowautoedit [on|off] [global] - Toggle full auto-edit in agent mode
  /workflows [list|show <id>|cancel <id>] - Inspect workflow runs
  /status                 - Show session status
  /skill <name>           - Activate a skill
  /skills                 - List available skills
  /rule [force]           - Create ${ruleFile} with safe default project rules
  /esm <objective>        - Enable Supervisor Mode: create/status/edit/pause/resume/clear/guide
  /help                   - Show this help`;
  return { message: help, error: false };
}
