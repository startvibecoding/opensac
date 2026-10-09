// Shared-API implementations behind the TUI {@link CommandHost}. Each method is
// a thin translation of the Go handler to the Deno port's shared modules
// (config, session, skills, expert, workflow, skillhub, esm, stats). It never
// constructs an Agent, opens a database directly, or builds SQL.

import {
  addEditPath,
  type AllowConfig,
  clearEditPaths,
  editPathList,
  getAutoEdit,
  loadAllow,
  removeEditPath,
  saveGlobalAutoEditValue,
  saveProject,
  setGlobalAutoEdit,
  setProjectAutoEdit,
} from "../config/allow.ts";
import { saveEnv } from "../config/env.ts";
import {
  defaultMCPConfig,
  fullMCPConfigTemplate,
  globalMCPPath,
  loadMCPConfig,
  normalizeMCPConfig,
  projectMCPPath,
  saveMCPConfig,
} from "../config/mcp.ts";
import {
  getGlobalSkillsDir,
  isProjectDir,
  type Settings,
} from "../config/settings.ts";
import { ensureRuleFile, ruleFilePath } from "../contextfiles/contextfiles.ts";
import type {
  TUIAgentView,
  TUIEsmObjectiveView,
  TUIExpertBundleView,
  TUISessionListEntry,
  TUISessionView,
} from "./service.ts";
import type { CoreRuntimeEvent } from "../core/runtime.ts";
import { CONFIG_OPTION_BROWSER } from "../agentruntime/session_options.ts";
import { Service as SkillHubService } from "../skillhub/service.ts";
import { projectSkillDirs } from "../skills/skills.ts";
import { createLocalIndex } from "../skillhub/local.ts";
import type { Market } from "../skillhub/types.ts";
import { clientsForSettings } from "../skillhub/factory.ts";
import { defaultStore as workflowStore } from "../workflow/tools.ts";
import { defaultActiveRegistry } from "../workflow/active.ts";
import { DB as StatsDB } from "../stats/stats.ts";
import { Server as StatsServer } from "../stats/server.ts";
import { formatDuration } from "./formatters.ts";
import { renderSessionList } from "./session_commands.ts";
import type { CommandResult } from "./commands.ts";
import type { TUISession } from "./tui_session.ts";

/** Default dashboard listen address (Go defaultStatsAddr). */
const DEFAULT_STATS_ADDR = "127.0.0.1:7878";

interface TUIHost {
  workDir: string;
  translator: TUISession["translator"];
  service: TUISession["service"];
  controller: TUISession["controller"];
  currentSessionID(): string;
  /** Adopts one Core-owned session view as the live session (switch/fork). */
  adoptSession(view: TUISessionView): void;
  /** Creates one fresh Core-owned session and adopts its view. */
  createFreshSession(): Promise<TUISessionView>;
  /**
   * Opens one persisted session, adopts it, and reprints its durable
   * conversation (the shared `-c`/`-r`/`/sessions` resume projection).
   */
  resumePersistedSession(
    sessionId: string,
    workDir?: string,
    resolvedView?: TUISessionView,
  ): Promise<void>;
  setMode(mode: string): void;
  /** Starts (or reports) the Core-owned ESM continuation worker. */
  startESMContinuationIfIdle(): Promise<void>;
  /** Stops the Core-owned ESM continuation worker, if any. */
  abortESMWorker(): Promise<void>;
  /**
   * Consumes one service run's canonical events into the controller and
   * resolves with the terminal event (if any).
   */
  consumeRunEvents(
    sessionId: string,
    runId: string,
  ): Promise<CoreRuntimeEvent | undefined>;
}

export class TuiCommands {
  #host: TUIHost;
  #activeAgent = "main";
  #reloadRequested = false;
  #statsServer: StatsServer | undefined;
  #statsServerURL = "";

  constructor(host: TUIHost) {
    this.#host = host;
  }

  #tr() {
    return this.#host.translator;
  }

  // --- Skills ---------------------------------------------------------------

  async activateSkill(name: string): Promise<string> {
    const tr = this.#tr();
    const sessionId = this.#host.currentSessionID();
    const skills = await this.#host.service.listSkills({ sessionId });
    const skill = skills.find((entry) => entry.name === name);
    if (skill === undefined) return tr.text("skill.not_found", name);
    if (skill.active) return tr.text("skill.already_active", name);
    // Skill activation is Runtime-owned: the Core refreshes the session
    // resources instead of appending skill context to adapter-local state.
    await this.#host.service.setSkillActive({
      sessionId,
      name,
      active: true,
    });
    return tr.text("skill.activated", name, skill.source, skill.description);
  }

  /**
   * Clears skill activations (Go /clear rebuilds activeSkills). Deactivation
   * is service-owned and runs in the background while the UI resets now.
   */
  clearActiveSkills(): void {
    const sessionId = this.#host.currentSessionID();
    void this.#host.service
      .listSkills({ sessionId })
      .then((skills) =>
        Promise.all(
          skills
            .filter((skill) => skill.active)
            .map((skill) =>
              this.#host.service.setSkillActive({
                sessionId,
                name: skill.name,
                active: false,
              })
            ),
        )
      )
      .catch((error) => {
        this.#host.controller.addMessage(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      });
  }

  // --- MCP ------------------------------------------------------------------

  listMCPServers(): string {
    const sources: Array<{ label: string; path: string }> = [
      { label: "Global", path: globalMCPPath() },
      { label: "Project", path: projectMCPPath() },
    ];
    const lines = ["MCP servers:"];
    let foundAny = false;
    for (const src of sources) {
      lines.push("", `${src.label} (${src.path}):`);
      let cfg;
      try {
        cfg = loadMCPConfig(src.path);
        normalizeMCPConfig(cfg);
      } catch (err) {
        if (
          (err as Error & { code?: string }).code === "ENOENT" ||
          (err as Error).message.includes("No such file")
        ) {
          lines.push("  (not configured)");
        } else {
          lines.push(`  (invalid: ${(err as Error).message})`);
        }
        continue;
      }
      const servers = cfg.mcpServers ?? [];
      if (servers.length === 0) {
        lines.push("  (empty)");
        continue;
      }
      for (const srv of servers) {
        foundAny = true;
        const target = srv.command ?? srv.url ?? "-";
        lines.push(`  - ${srv.name} [${srv.type ?? "stdio"}] ${target}`);
      }
    }
    if (!foundAny) lines.push("", "Use /init_mcp to create project mcp.json.");
    return lines.join("\n");
  }

  initMCPConfig(scope: string, full: boolean, force: boolean): CommandResult {
    const tr = this.#tr();
    const target = scope === "global" ? globalMCPPath() : projectMCPPath();
    if (!force) {
      try {
        Deno.statSync(target);
        return { message: tr.text("init_mcp.exists", scope) };
      } catch {
        // Not present: write it.
      }
    }
    try {
      const cfg = full ? fullMCPConfigTemplate() : defaultMCPConfig();
      saveMCPConfig(target, cfg);
      return { message: tr.text("init_mcp.created", target) };
    } catch (err) {
      return {
        message: tr.text("init_mcp.failed", (err as Error).message),
        error: true,
      };
    }
  }

  // --- Experts --------------------------------------------------------------

  async listExperts(): Promise<string> {
    const tr = this.#tr();
    const sessionId = this.#host.currentSessionID();
    const experts = await this.#host.service.listExperts({ sessionId });
    if (experts.length === 0) return tr.text("expert.empty");
    const boundID = (await this.#host.service.expertState({ sessionId }))
      .expertId;
    const lines = ["Experts:", ""];
    for (const e of experts) {
      const marker = e.name === boundID ? "*" : " ";
      const name = tr.language === "zh" ? e.displayName.zh : e.displayName.en;
      let line =
        `  [${marker}] ${e.name}  ${name} (${e.expertType}, ${e.source})`;
      if (e.invalid) line += `: invalid — ${e.invalidReason ?? ""}`;
      lines.push(line);
    }
    lines.push(
      "",
      "Use /expert show <id> to inspect, or /expert bind <id> to bind this session.",
    );
    return lines.join("\n");
  }

  /** Shows one expert bundle's full details (Go formatExpertBundle). */
  async showExpert(id: string): Promise<string> {
    try {
      const bundle = await this.#host.service.showExpert({
        sessionId: this.#host.currentSessionID(),
        expertId: id,
      });
      return this.#formatExpertBundle(bundle);
    } catch (err) {
      return this.#tr().text(
        "expert.show_failed",
        (err as Error).message,
      );
    }
  }

  #formatExpertBundle(bundle: TUIExpertBundleView): string {
    const tr = this.#tr();
    const lines = [`Expert: ${bundle.name}`];
    const displayName = tr.language === "zh"
      ? bundle.displayName.zh
      : bundle.displayName.en;
    lines.push(`Name: ${displayName}`);
    lines.push(`Type: ${bundle.expertType}`);
    if (bundle.invalid) {
      lines.push(`Status: invalid — ${bundle.invalidReason}`);
      return lines.join("\n");
    }
    lines.push("Status: available");
    if (bundle.expertType === "team") {
      lines.push("Members:");
      for (const member of bundle.members) {
        let line = `  - ${member.id}`;
        const name = tr.language === "zh" ? member.name.zh : member.name.en;
        if (name !== "" && name !== member.id) {
          line += ` (${name})`;
        }
        const profession = tr.language === "zh"
          ? member.profession.zh
          : member.profession.en;
        if (profession !== "") {
          line += `: ${profession}`;
        }
        if (member.role !== "") {
          line += ` [${member.role}]`;
        }
        lines.push(line);
      }
    }
    return lines.join("\n");
  }

  async bindExpert(id: string): Promise<CommandResult> {
    const tr = this.#tr();
    try {
      await this.#host.service.setExpert({
        sessionId: this.#host.currentSessionID(),
        expertId: id,
      });
    } catch (err) {
      // Includes the Core's expert-switch-requires-fork failure: the raw cause
      // keeps its message through the service projection.
      return { message: (err as Error).message, error: true };
    }
    return {
      message: id === ""
        ? tr.text("expert.unbound")
        : tr.text("expert.bound", id),
    };
  }

  async forkSwitchExpert(id: string): Promise<CommandResult> {
    const tr = this.#tr();
    const sessionID = this.#host.currentSessionID();
    if (sessionID === "") {
      return { message: tr.text("sessions.no_match", id), error: true };
    }
    try {
      // The Core-owned fork preserves the source identity and history while
      // applying the expert binding only to the child branch.
      const child = await this.#host.service.forkSession({
        sessionId: sessionID,
        expertId: id,
        titleMode: "",
      });
      this.#host.adoptSession(child);
      this.#host.controller.store.resetTranscriptState();
      this.#host.controller.resetContextUsage();
      return {
        message: tr.text("expert.switched", child.sessionId, id),
      };
    } catch (err) {
      return { message: (err as Error).message, error: true };
    }
  }

  // --- Sessions -------------------------------------------------------------

  async listSessions(): Promise<string> {
    const tr = this.#tr();
    const details = await this.#host.service.listPersistedSessions({
      workDir: this.#host.workDir,
    });
    return renderSessionList(
      details,
      this.#host.currentSessionID(),
      (n) => tr.text("sessions.list_title", n),
      tr.text("sessions.no_sessions"),
    );
  }

  /** Forks the current session into a child branch (Go forkCurrentSession). */
  async forkSession(): Promise<CommandResult> {
    const tr = this.#tr();
    const sessionID = this.#host.currentSessionID();
    if (sessionID === "") {
      return { message: tr.text("sessions.no_match", ""), error: true };
    }
    try {
      // The Core-owned fork preserves the source identity and history and
      // creates the child branch as a Core-owned session.
      const child = await this.#host.service.forkSession({
        sessionId: sessionID,
        titleMode: "",
      });
      this.#host.adoptSession(child);
      this.#host.controller.store.resetTranscriptState();
      this.#host.controller.resetContextUsage();
      const detail = (await this.#host.service.listPersistedSessions({
        workDir: this.#host.workDir,
      })).find((entry) => entry.sessionId === child.sessionId);
      return {
        message: tr.text(
          "sessions.switched",
          child.sessionId,
          detail?.messageCount ?? 0,
        ),
      };
    } catch (err) {
      return { message: (err as Error).message, error: true };
    }
  }

  async #resolveSession(
    query: string,
  ): Promise<TUISessionListEntry | undefined> {
    const details = await this.#host.service.listPersistedSessions({
      workDir: this.#host.workDir,
    });
    const exact = details.find((d) => d.sessionId === query);
    if (exact !== undefined) return exact;
    const matches = details.filter((d) => d.sessionId.startsWith(query));
    if (matches.length === 1) return matches[0];
    return undefined;
  }

  async switchSession(id: string): Promise<CommandResult> {
    const tr = this.#tr();
    if (this.#host.currentSessionID() === id) {
      return { message: tr.text("sessions.already_current") };
    }
    const detail = await this.#resolveSession(id);
    if (detail === undefined) {
      return { message: tr.text("sessions.no_match", id), error: true };
    }
    try {
      // Scope the open to the directory the listing found the session in, so a
      // shared Core whose startup directory differs still resolves it. The
      // switch then reprints the durable conversation through the same
      // resume projection as `-c`/`-r`: an adopted session whose history stays
      // invisible is not a continuation.
      const view = await this.#host.service.openSession({
        sessionId: detail.sessionId,
        workDir: detail.workDir,
      });
      await this.#host.resumePersistedSession(
        detail.sessionId,
        detail.workDir,
        view,
      );
      return {
        message: tr.text(
          "sessions.switched",
          detail.sessionId,
          detail.messageCount,
        ),
      };
    } catch (err) {
      return { message: (err as Error).message, error: true };
    }
  }

  async clearSession(): Promise<CommandResult> {
    const tr = this.#tr();
    try {
      await this.#host.createFreshSession();
      this.#host.controller.store.resetTranscriptState();
      this.#host.controller.resetContextUsage();
      return { message: tr.text("sessions.clear_hint") };
    } catch (err) {
      return { message: (err as Error).message, error: true };
    }
  }

  async deleteSession(id: string): Promise<CommandResult> {
    const tr = this.#tr();
    if (id === this.#host.currentSessionID()) {
      return {
        message: tr.text("sessions.cannot_delete_current"),
        error: true,
      };
    }
    const detail = await this.#resolveSession(id);
    if (detail === undefined) {
      return { message: tr.text("sessions.no_match", id), error: true };
    }
    try {
      await this.#host.service.deleteSession({ sessionId: detail.sessionId });
      return { message: tr.text("sessions.deleted", detail.sessionId) };
    } catch (err) {
      return {
        message: tr.text("sessions.delete_failed", (err as Error).message),
        error: true,
      };
    }
  }

  // --- Workflows ------------------------------------------------------------

  async listWorkflows(): Promise<CommandResult> {
    const tr = this.#tr();
    try {
      const store = workflowStore();
      const runs = await store.list();
      if (runs.length === 0) return { message: tr.text("workflows.empty") };
      const lines = [tr.text("workflows.list_title", runs.length)];
      for (const run of runs) {
        lines.push(
          tr.text(
            "workflows.entry",
            run.status,
            run.id,
            run.name,
            run.updatedAt.toISOString(),
          ),
        );
      }
      return { message: lines.join("\n") };
    } catch (err) {
      return {
        message: tr.text("workflows.failed", (err as Error).message),
        error: true,
      };
    }
  }

  async showWorkflow(id: string): Promise<CommandResult> {
    const tr = this.#tr();
    try {
      const run = await workflowStore().load(id);
      if (run === null || run === undefined) {
        return {
          message: tr.text("workflows.show_failed", "not found"),
          error: true,
        };
      }
      const lines = [tr.text("workflows.show_title", run.id, run.status)];
      if (run.name !== "") lines.push(tr.text("workflows.name", run.name));
      for (const phase of run.phases ?? []) {
        lines.push(
          tr.text(
            "workflows.phase",
            phase.status,
            phase.name,
            phase.tasks?.length ?? 0,
          ),
        );
      }
      if (run.error !== undefined && run.error !== "") {
        lines.push(tr.text("workflows.error", run.error));
      }
      return { message: lines.join("\n") };
    } catch (err) {
      return {
        message: tr.text("workflows.show_failed", (err as Error).message),
        error: true,
      };
    }
  }

  /** Cancels an active workflow run (Go handleWorkflowsCommand cancel). */
  cancelWorkflow(id: string): Promise<CommandResult> {
    const tr = this.#tr();
    const target = id.trim();
    if (!defaultActiveRegistry().cancel(target)) {
      return Promise.resolve({
        message: tr.text("workflows.not_active", target),
        error: true,
      });
    }
    return Promise.resolve({
      message: tr.text("workflows.cancel_requested", target),
    });
  }

  // --- ESM ------------------------------------------------------------------

  async handleESM(cmd: string): Promise<CommandResult> {
    const tr = this.#tr();
    const sessionID = this.#host.currentSessionID();
    if (sessionID === "") return { message: tr.text("esm.panel.no_objective") };
    const service = this.#host.service;
    const raw = cmd.trim().replace(/^\/esm/, "").trim();
    const [sub, ...restArr] = raw === "" ? ["status"] : raw.split(/\s+/);
    const rest = restArr.join(" ");
    // Go: pause/resume/clear cannot mutate an active run; only objective
    // creation, edit, and guide may update while the agent is thinking.
    if (
      this.#host.controller.isThinking &&
      (sub === "pause" || sub === "resume" || sub === "clear")
    ) {
      return {
        message:
          "Only /esm <objective>, /esm edit, and /esm guide may update an active run. " +
          "Pause, resume, and clear require the current run to finish or be aborted.",
        error: true,
      };
    }
    try {
      switch (sub) {
        case "status":
          return {
            message: this.#formatESM(
              (await service.esmState({ sessionId: sessionID })).objective,
            ),
          };
        case "edit": {
          if (rest === "") {
            return {
              message: tr.text("commands.usage", "/esm edit <objective>"),
              error: true,
            };
          }
          const view = await service.esmCommand({
            sessionId: sessionID,
            action: "edit",
            objective: rest,
          });
          return { message: this.#formatESM(view.objective) };
        }
        case "pause": {
          if (rest !== "") {
            return {
              message: tr.text("commands.usage", "/esm pause"),
              error: true,
            };
          }
          const view = await service.esmCommand({
            sessionId: sessionID,
            action: "pause",
          });
          return { message: this.#formatESM(view.objective) };
        }
        case "resume": {
          if (rest !== "") {
            return {
              message: tr.text("commands.usage", "/esm resume"),
              error: true,
            };
          }
          const view = await service.esmCommand({
            sessionId: sessionID,
            action: "resume",
          });
          await this.#host.startESMContinuationIfIdle();
          return { message: this.#formatESM(view.objective) };
        }
        case "guide": {
          if (rest === "") {
            return {
              message: tr.text("commands.usage", "/esm guide <text>"),
              error: true,
            };
          }
          await service.esmCommand({
            sessionId: sessionID,
            action: "guide",
            guide: rest,
          });
          await this.#host.startESMContinuationIfIdle();
          return { message: "Guidance queued for the next ESM role run." };
        }
        case "clear": {
          if (rest !== "") {
            return {
              message: tr.text("commands.usage", "/esm clear"),
              error: true,
            };
          }
          await service.esmCommand({ sessionId: sessionID, action: "clear" });
          await this.#host.abortESMWorker();
          return { message: "Enable Supervisor Mode cleared." };
        }
        default: {
          const view = await service.esmCommand({
            sessionId: sessionID,
            action: "create",
            objective: raw,
          });
          await this.#host.startESMContinuationIfIdle();
          return { message: this.#formatESM(view.objective) };
        }
      }
    } catch (err) {
      return { message: this.#formatESMError(err), error: true };
    }
  }

  /** Maps ESM service errors to the Go command messages. */
  #formatESMError(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("esm objective not found")) {
      return "No ESM objective. Create one with /esm <objective>.";
    }
    if (message.includes("esm objective already exists")) {
      return "An unfinished ESM objective already exists. Use /esm edit <objective> or /esm clear.";
    }
    if (message.includes("esm objective cannot be empty")) {
      return "ESM objective cannot be empty.";
    }
    if (message.includes("invalid esm status transition")) {
      return "ESM status cannot be changed that way.";
    }
    return message;
  }

  #formatESM(obj: TUIEsmObjectiveView | null): string {
    const tr = this.#tr();
    if (obj === null || obj.esmId === "") {
      return [
        tr.text("esm.panel.title"),
        "Status: none",
        "",
        tr.text("esm.panel.create_hint"),
      ].join("\n");
    }
    const lines = [
      tr.text("esm.panel.title"),
      `Status: ${obj.status}`,
      `Phase: ${obj.phase}`,
      `Objective: ${obj.objective}`,
      `Tokens: ${obj.tokensUsed}`,
    ];
    if (obj.timeUsedMs > 0) {
      lines.push(`Time: ${formatDuration(obj.timeUsedMs)}`);
    }
    if (obj.progressSummary !== "") {
      lines.push(`Latest progress: ${obj.progressSummary}`);
    }
    if (obj.remainingWork.length > 0) {
      lines.push(
        `Remaining work (${obj.remainingWork.length}): ${
          obj.remainingWork.join("; ")
        }`,
      );
    }
    return lines.join("\n");
  }

  // --- Environment ----------------------------------------------------------

  async listEnv(): Promise<string> {
    const tr = this.#tr();
    const vars = await this.#host.service.listEnv();
    const keys = Object.keys(vars).sort();
    if (keys.length === 0) return tr.text("env.empty");
    const lines = [tr.text("env.title", keys.length)];
    for (const key of keys) lines.push(tr.text("env.entry", key, vars[key]));
    return lines.join("\n");
  }

  async setEnv(key: string, value: string): Promise<CommandResult> {
    const tr = this.#tr();
    try {
      const vars = await this.#host.service.listEnv();
      vars[key] = value;
      await this.#host.service.updateEnv({ vars });
      return { message: tr.text("env.set", key) };
    } catch (err) {
      return {
        message: tr.text("env.failed", (err as Error).message),
        error: true,
      };
    }
  }

  async unsetEnv(key: string): Promise<CommandResult> {
    const tr = this.#tr();
    try {
      const vars = await this.#host.service.listEnv();
      delete vars[key];
      await this.#host.service.updateEnv({ vars });
      return { message: tr.text("env.unset", key) };
    } catch (err) {
      return {
        message: tr.text("env.failed", (err as Error).message),
        error: true,
      };
    }
  }

  async clearEnv(): Promise<CommandResult> {
    const tr = this.#tr();
    try {
      await this.#host.service.updateEnv({ vars: {} });
      return { message: tr.text("env.cleared") };
    } catch (err) {
      return {
        message: tr.text("env.failed", (err as Error).message),
        error: true,
      };
    }
  }

  // --- Allow lists ----------------------------------------------------------

  allowEditPath(parts: string[]): CommandResult {
    const tr = this.#tr();
    const allow: AllowConfig = loadAllow();
    if (parts.length < 2) {
      const paths = editPathList(allow);
      if (paths.length === 0) {
        return {
          message: tr.text(
            "commands.usage",
            "/alloweditpath add|remove <glob>|clear",
          ),
        };
      }
      return {
        message: [tr.text("alloweditpath.title"), ...paths.map((p) => `  ${p}`)]
          .join("\n"),
      };
    }
    switch (parts[1]) {
      case "add": {
        if (parts.length < 3) {
          return {
            message: tr.text("commands.usage", "/alloweditpath add <glob>"),
            error: true,
          };
        }
        const glob = parts.slice(2).join(" ");
        if (!addEditPath(allow, glob)) {
          return { message: tr.text("alloweditpath.already", glob) };
        }
        saveProject(allow);
        return {
          message: tr.text(
            "alloweditpath.saved",
            tr.text("alloweditpath.added"),
            glob,
          ),
        };
      }
      case "remove":
      case "rm": {
        if (parts.length < 3) {
          return {
            message: tr.text("commands.usage", "/alloweditpath remove <glob>"),
            error: true,
          };
        }
        const glob = parts.slice(2).join(" ");
        if (!removeEditPath(allow, glob)) {
          return { message: tr.text("alloweditpath.not_found", glob) };
        }
        saveProject(allow);
        return {
          message: tr.text(
            "alloweditpath.saved",
            tr.text("alloweditpath.removed"),
            glob,
          ),
        };
      }
      case "clear":
        clearEditPaths(allow);
        saveProject(allow);
        return { message: tr.text("alloweditpath.cleared") };
      default:
        return {
          message: tr.text(
            "commands.usage",
            "/alloweditpath add|remove <glob>|clear",
          ),
          error: true,
        };
    }
  }

  allowAutoEdit(parts: string[]): CommandResult {
    const tr = this.#tr();
    const allow = loadAllow();
    if (parts.length < 2) {
      return {
        message: [
          tr.text(
            "allowautoedit.status",
            getAutoEdit(allow) ? "ON" : "OFF",
          ),
          tr.text("commands.usage", "/allowautoedit [on|off] [global]"),
        ].join("\n"),
      };
    }
    const globalScope = parts.slice(2).includes("global");
    let enable: boolean;
    if (parts[1] === "on") enable = true;
    else if (parts[1] === "off") enable = false;
    else {
      return {
        message: tr.text("commands.usage", "/allowautoedit [on|off] [global]"),
        error: true,
      };
    }
    try {
      let effective = enable;
      const scope = globalScope ? "global" : "project";
      if (globalScope) {
        effective = setGlobalAutoEdit(allow, enable);
        saveGlobalAutoEditValue(enable);
      } else {
        setProjectAutoEdit(allow, enable);
        saveProject(allow);
      }
      let msg = `Auto-edit (agent mode): ${enable ? "ON" : "OFF"} [${scope}]`;
      if (globalScope && effective !== enable) {
        msg += ` (effective here: ${
          effective ? "ON" : "OFF"
        } due to project override)`;
      }
      return { message: msg };
    } catch (err) {
      return {
        message: tr.text("alloweditpath.save_failed", (err as Error).message),
        error: true,
      };
    }
  }

  // --- Modes ----------------------------------------------------------------

  async delegateMode(arg: string): Promise<CommandResult> {
    const tr = this.#tr();
    const sessionId = this.#host.currentSessionID();
    if (arg === "status") {
      const state = await this.#host.service.delegateState({ sessionId });
      return {
        message: tr.text("delegate.status", state.enabled ? "ON" : "OFF"),
      };
    }
    if (this.#host.controller.isThinking) {
      return { message: tr.text("delegate.running"), error: true };
    }
    switch (arg) {
      case "on":
        return await this.#enableDelegate();
      case "off": {
        await this.#host.service.setDelegate({
          sessionId,
          enabled: false,
        });
        return { message: tr.text("delegate.changed", "OFF") };
      }
      default:
        return {
          message: tr.text("commands.usage", "/delegate [on|off|status]"),
          error: true,
        };
    }
  }

  /** Enables the blocking delegate tool on the Core-owned shared manager. */
  async #enableDelegate(): Promise<CommandResult> {
    const tr = this.#tr();
    const sessionId = this.#host.currentSessionID();
    try {
      await this.#host.service.setDelegate({
        sessionId,
        enabled: true,
      });
    } catch (err) {
      return { message: (err as Error).message, error: true };
    }
    return { message: tr.text("delegate.changed", "ON") };
  }

  async browserMode(arg: string): Promise<CommandResult> {
    const tr = this.#tr();
    const sessionId = this.#host.currentSessionID();
    if (arg === "status") {
      const caps = await this.#host.service.capabilities({ sessionId });
      return {
        message: tr.text(
          "browser.status",
          caps.browser?.enabled === true ? "ON" : "OFF",
        ),
      };
    }
    if (this.#host.controller.isThinking) {
      return { message: tr.text("browser.running"), error: true };
    }
    if (arg !== "on" && arg !== "off") {
      return {
        message: tr.text("commands.usage", "/browser [on|off|status]"),
        error: true,
      };
    }
    try {
      await this.#host.service.setCapability({
        sessionId,
        id: CONFIG_OPTION_BROWSER,
        enabled: arg === "on",
      });
    } catch (err) {
      return { message: (err as Error).message, error: true };
    }
    return { message: tr.text("browser.status", arg === "on" ? "ON" : "OFF") };
  }

  async statusLine(parts: string[]): Promise<CommandResult> {
    const tr = this.#tr();
    const sub = (parts[1] ?? "status").toLowerCase();
    switch (sub) {
      case "status":
        return await this.#statusLineStatus();
      case "on":
      case "off":
        return await this.#statusLineToggle(
          sub === "on",
          parts[2] ?? "project",
        );
      case "command":
        return await this.#statusLineCommand(parts);
      case "refresh":
        return await this.#statusLineRefresh(parts);
      default:
        return {
          message: tr.text(
            "commands.usage",
            "/statusline [status|on|off|command|refresh] ...",
          ),
          error: true,
        };
    }
  }

  /** Renders the status-line configuration (Go showStatusLineStatus). */
  async #statusLineStatus(): Promise<CommandResult> {
    const settings = await this.#host.service.getSettings();
    const cfg = settings.statusLine ?? {};
    if (cfg.enabled !== true) {
      return { message: "Status line: OFF\nFooter: builtin" };
    }
    const lines = [
      "Status line: ON",
      `  Type: ${cfg.type ?? "command"}`,
      `  Command: ${(cfg.command ?? "").trim() || "ccstatusline"}`,
      `  Timeout: ${cfg.timeoutMs ?? 800}ms`,
      cfg.refreshInterval !== undefined && cfg.refreshInterval > 0
        ? `  Refresh: ${cfg.refreshInterval}s`
        : "  Refresh: event-driven",
    ];
    return { message: lines.join("\n") };
  }

  /** Toggles the status line on/off in a project/global scope. */
  async #statusLineToggle(
    enabled: boolean,
    scopeRaw: string,
  ): Promise<CommandResult> {
    const tr = this.#tr();
    const scope = scopeRaw.toLowerCase();
    if (scope !== "project" && scope !== "global") {
      return {
        message: tr.text(
          "commands.usage",
          "/statusline [status|on|off] [project|global]",
        ),
        error: true,
      };
    }
    const current = (await this.#host.service.getSettings()).statusLine ?? {};
    const next = {
      ...current,
      enabled,
      ...(enabled && !current.command
        ? {
          command: "ccstatusline",
          type: "command",
          timeoutMs: 800,
          fallback: "builtin",
        }
        : {}),
    };
    try {
      await this.#host.service.updateSettings({
        scope: scope as "global" | "project",
        updates: { statusLine: next },
      });
    } catch (err) {
      return {
        message: tr.text("statusline.failed", (err as Error).message),
        error: true,
      };
    }
    return {
      message: enabled
        ? tr.text("statusline.on", scope)
        : tr.text("statusline.off"),
    };
  }

  /** Sets the status-line command (Go setStatusLineCommand). */
  async #statusLineCommand(parts: string[]): Promise<CommandResult> {
    const tr = this.#tr();
    if (parts.length < 3) {
      return {
        message: tr.text(
          "commands.usage",
          "/statusline command <cmd> [project|global]",
        ),
        error: true,
      };
    }
    let scope = "project";
    let end = parts.length;
    const last = parts[parts.length - 1].toLowerCase();
    if (last === "project" || last === "global") {
      scope = last;
      end--;
    }
    const cmd = parts.slice(2, end).join(" ").trim();
    if (cmd === "") {
      return {
        message: tr.text(
          "commands.usage",
          "/statusline command <cmd> [project|global]",
        ),
        error: true,
      };
    }
    const current = (await this.#host.service.getSettings()).statusLine ?? {};
    const next = {
      ...current,
      type: "command",
      command: cmd,
      timeoutMs: current.timeoutMs ?? 800,
      fallback: current.fallback ?? "builtin",
    };
    try {
      await this.#host.service.updateSettings({
        scope: scope as "global" | "project",
        updates: { statusLine: next },
      });
    } catch (err) {
      return {
        message: tr.text("statusline.failed", (err as Error).message),
        error: true,
      };
    }
    return {
      message: `Status line command updated (${scope} settings): ${cmd}`,
    };
  }

  /** Sets the status-line refresh interval in seconds (Go setStatusLineRefresh). */
  async #statusLineRefresh(parts: string[]): Promise<CommandResult> {
    const tr = this.#tr();
    if (parts.length < 3) {
      return {
        message: tr.text(
          "commands.usage",
          "/statusline refresh <sec> [project|global]",
        ),
        error: true,
      };
    }
    let scope = "project";
    if (parts.length > 3) {
      const last = parts[parts.length - 1].toLowerCase();
      if (last === "project" || last === "global") scope = last;
    }
    const refresh = Number.parseInt(parts[2], 10);
    if (Number.isNaN(refresh) || refresh < 0 || refresh > 60) {
      return {
        message: tr.text(
          "commands.usage",
          "/statusline refresh <0-60> [project|global]",
        ),
        error: true,
      };
    }
    const current = (await this.#host.service.getSettings()).statusLine ?? {};
    const next = { ...current, refreshInterval: refresh };
    try {
      await this.#host.service.updateSettings({
        scope: scope as "global" | "project",
        updates: { statusLine: next },
      });
    } catch (err) {
      return {
        message: tr.text("statusline.failed", (err as Error).message),
        error: true,
      };
    }
    return {
      message: refresh === 0
        ? `Status line refresh updated (${scope} settings): event-driven`
        : `Status line refresh updated (${scope} settings): ${refresh}s`,
    };
  }

  // --- Rule -----------------------------------------------------------------

  async handleRule(parts: string[]): Promise<CommandResult> {
    const tr = this.#tr();
    if (this.#host.controller.isThinking) {
      return { message: tr.text("rule.running"), error: true };
    }
    const overwrite = parts.length > 1 &&
      (parts[1] === "force" || parts[1] === "--force");
    if (parts.length > 2 || (parts.length === 2 && !overwrite)) {
      return {
        message: tr.text("commands.usage", "/rule [force|--force]"),
        error: true,
      };
    }
    try {
      const { path: filePath, content, written } = ensureRuleFile(
        this.#host.workDir,
        overwrite,
      );
      // The rule text is Core-owned session context: update it through the
      // service so Core-run prompts see it immediately.
      await this.#host.service.setSessionContext({
        sessionId: this.#host.currentSessionID(),
        ruleContent: content,
      });
      if (written) {
        return {
          message: [
            tr.text(
              "rule.created",
              tr.text(overwrite ? "rule.overwrote" : "rule.created_verb"),
              filePath,
            ),
            tr.text("rule.loaded"),
          ].join("\n"),
        };
      }
      return {
        message: tr.text("rule.exists", ruleFilePath(this.#host.workDir)),
      };
    } catch (err) {
      return {
        message: tr.text("rule.write_failed", (err as Error).message),
        error: true,
      };
    }
  }

  // --- SkillHub -------------------------------------------------------------

  #skillHub(settings: Settings): SkillHubService {
    return new SkillHubService(
      "",
      projectSkillDirs(this.#host.workDir),
      settings.skillHub?.officialHandles ?? [],
      ...clientsForSettings(settings.skillHub ?? {}),
    );
  }

  #skillHubScope(): string {
    return isProjectDir(this.#host.workDir) ? "project" : "global";
  }

  /** Parses a `<market>/<id>` reference (Go parseSkillHubID). */
  static #parseSkillHubID(value: string): { market: string; id: string } {
    const trimmed = value.trim();
    if (trimmed === "") throw new Error("skill reference is required");
    const slash = trimmed.indexOf("/");
    if (slash <= 0 || slash === trimmed.length - 1) {
      throw new Error(
        `invalid skill reference ${JSON.stringify(trimmed)}; use <market>/<id>`,
      );
    }
    return {
      market: trimmed.slice(0, slash),
      id: trimmed.slice(slash + 1),
    };
  }

  async handleSkillHub(parts: string[]): Promise<CommandResult> {
    const tr = this.#tr();
    const settings = await this.#host.service.getSettings();
    const service = this.#skillHub(settings);
    const sub = parts[1] ?? "list";
    try {
      switch (sub) {
        case "search": {
          if (parts.length < 3) {
            return {
              message: tr.text("commands.usage", "/skillhub search <query>"),
              error: true,
            };
          }
          const query = parts.slice(2).join(" ");
          const market = service.markets()[0]?.id ?? "skillhub";
          const page = await service.search(undefined, market, {
            query,
            limit: 20,
          });
          const lines = [`Skills (${page.items.length}):`];
          for (const item of page.items) {
            lines.push(`  ${item.id} — ${item.name}`);
          }
          return { message: lines.join("\n") };
        }
        case "detail": {
          if (parts.length < 3) {
            return {
              message: tr.text(
                "commands.usage",
                "/skillhub detail <market>/<id>",
              ),
              error: true,
            };
          }
          const { market, id } = TuiCommands.#parseSkillHubID(parts[2]);
          const detail = await service.detail(
            undefined,
            market as Market,
            id,
          );
          const lines = [
            `${detail.name} (${detail.id})`,
            detail.description ?? "",
            `version: ${detail.version ?? ""}`,
          ];
          return { message: lines.filter((l) => l !== "").join("\n") };
        }
        case "install": {
          if (parts.length < 3) {
            return {
              message: tr.text(
                "commands.usage",
                "/skillhub install <market>/<id>",
              ),
              error: true,
            };
          }
          const { market, id } = TuiCommands.#parseSkillHubID(parts[2]);
          const result = await service.install(undefined, {
            market: market as Market,
            id,
            scope: this.#skillHubScope(),
            targetDir: this.#skillHubTargetDir(settings),
            overwrite: parts.includes("--force"),
          });
          return { message: `Installed ${result.name}` };
        }
        case "uninstall": {
          if (parts.length < 3) {
            return {
              message: tr.text(
                "commands.usage",
                "/skillhub uninstall <market>/<id>",
              ),
              error: true,
            };
          }
          const { market, id } = TuiCommands.#parseSkillHubID(parts[2]);
          service.uninstall(market as Market, id, this.#skillHubScope());
          return { message: `Uninstalled ${id}` };
        }
        case "skillset": {
          if (parts.length < 3) {
            return {
              message: tr.text(
                "commands.usage",
                "/skillhub skillset <market>/<id>... [--global|--project|--activate]",
              ),
              error: true,
            };
          }
          let scope = this.#skillHubScope();
          let activate = false;
          const requests: Array<{
            market: Market;
            id: string;
            scope: string;
            targetDir: string;
          }> = [];
          for (const value of parts.slice(2)) {
            if (value === "--global") {
              scope = "global";
              continue;
            }
            if (value === "--project") {
              scope = "project";
              continue;
            }
            if (value === "--activate") {
              activate = true;
              continue;
            }
            const { market, id } = TuiCommands.#parseSkillHubID(value);
            requests.push({
              market: market as Market,
              id,
              scope,
              targetDir: this.#skillHubTargetDir(settings),
            });
          }
          const results = await service.installSkillSet(undefined, requests);
          if (activate) {
            for (const result of results) {
              await this.activateSkill(result.name);
            }
          }
          return {
            message: `Installed ${results.length} skills${
              activate ? " and activated them in the current session" : ""
            }.`,
          };
        }
        case "installed": {
          const index = createLocalIndex(
            this.#skillHubTargetDir(settings),
            projectSkillDirs(this.#host.workDir),
          );
          const states = index.list();
          if (states.length === 0) {
            return { message: "No marketplace skills installed." };
          }
          const lines = ["Installed marketplace skills:"];
          for (const state of states) {
            lines.push(
              `  ${state.dir} (${state.scope}, ${state.version})`,
            );
          }
          return { message: lines.join("\n") };
        }
        default: {
          // Default view: list installed skills (no network).
          const query = parts.slice(1).join(" ");
          const market = service.markets()[0]?.id ?? "skillhub";
          const page = await service.search(undefined, market, {
            query,
            limit: 20,
          });
          const lines = [`Skills (${page.items.length}):`];
          for (const item of page.items) {
            lines.push(`  ${item.id} — ${item.name}`);
          }
          return { message: lines.join("\n") };
        }
      }
    } catch (err) {
      return { message: (err as Error).message, error: true };
    }
  }

  #skillHubTargetDir(settings: Settings): string {
    if (this.#skillHubScope() === "project") {
      return projectSkillDirs(this.#host.workDir)[0];
    }
    return getGlobalSkillsDir(settings);
  }

  // --- Stats ----------------------------------------------------------------

  async listStats(parts: string[]): Promise<CommandResult> {
    const tr = this.#tr();
    const sub = (parts[1] ?? "tui").toLowerCase();
    switch (sub) {
      case "server":
        return this.#startStatsServer();
      case "stop-server":
        return await this.#stopStatsServer();
      case "tui":
        break;
      default:
        return { message: tr.text("stats.usage"), error: true };
    }
    try {
      const db = StatsDB.openDefault();
      const summary = db.summary({});
      const lines = [
        tr.text("stats.title"),
        `Requests: ${summary.totalRequests}`,
        `Input tokens: ${summary.inputTokens}`,
        `Output tokens: ${summary.outputTokens}`,
        `Total tokens: ${summary.totalTokens}`,
      ];
      const byProvider = db.byProvider({});
      if (byProvider.length > 0) {
        lines.push("", tr.text("stats.by_provider"));
        for (const row of byProvider.slice(0, 5)) {
          const label = row.vendor === "" ? "-" : row.vendor;
          lines.push(
            `  ${label}  req:${row.requests}  in:${row.inputTokens}  out:${row.outputTokens}  total:${row.totalTokens}`,
          );
        }
      }
      const byModel = db.byModel({});
      if (byModel.length > 0) {
        lines.push("", tr.text("stats.by_model"));
        for (const row of byModel.slice(0, 5)) {
          const label = row.model !== "" ? row.model : (row.label || "-");
          lines.push(
            `  ${label}  req:${row.requests}  in:${row.inputTokens}  out:${row.outputTokens}  total:${row.totalTokens}`,
          );
        }
      }
      const recent = db.recent(1, 10);
      if (recent.items.length > 0) {
        lines.push("", tr.text("stats.recent"));
        for (const item of recent.items) {
          const t =
            item.timestamp?.toISOString().slice(0, 16).replace("T", " ") ??
              "-";
          lines.push(
            `  ${t}  ${item.vendor || "-"}  ${
              item.model || "-"
            }  in:${item.inputTokens} out:${item.outputTokens}  ${
              formatStatsDuration(item.durationMs)
            }`,
          );
        }
      }
      return { message: lines.join("\n") };
    } catch (err) {
      return { message: (err as Error).message, error: true };
    }
  }

  /** Starts the in-process usage dashboard (Go startStatsServer). */
  #startStatsServer(): CommandResult {
    const tr = this.#tr();
    if (this.#statsServer !== undefined) {
      return {
        message: tr.text("stats.server.already_running", this.#statsServerURL),
      };
    }
    try {
      const db = StatsDB.openDefault();
      const server = new StatsServer(db, DEFAULT_STATS_ADDR);
      server.start();
      this.#statsServer = server;
      this.#statsServerURL = `http://${server.boundAddr()}`;
      return {
        message: `${tr.text("stats.starting")}\n${this.#statsServerURL}`,
      };
    } catch (err) {
      return {
        message: tr.text("stats.start_failed", (err as Error).message),
        error: true,
      };
    }
  }

  /** Stops the in-process usage dashboard. */
  async #stopStatsServer(): Promise<CommandResult> {
    const tr = this.#tr();
    const server = this.#statsServer;
    if (server === undefined) {
      return { message: tr.text("stats.server.not_running") };
    }
    try {
      await server.shutdown();
      this.#statsServer = undefined;
      this.#statsServerURL = "";
      return { message: tr.text("stats.server.stopped") };
    } catch (err) {
      return {
        message: tr.text("stats.server.stop_failed", (err as Error).message),
        error: true,
      };
    }
  }

  // --- Agents ---------------------------------------------------------------

  /**
   * Lists agents (Go listAgents) from the Core-owned managed-agent registry.
   * The Core owns every AgentManager; the TUI only renders the projection.
   */
  async listAgents(): Promise<string> {
    const tr = this.#tr();
    const lines = [tr.text("agent.multi_status", "main")];
    let agents: TUIAgentView[];
    try {
      agents = await this.#host.service.listAgents({
        sessionId: this.#host.currentSessionID(),
      });
    } catch {
      lines.push(`  ${tr.text("agent.manager_unavailable")}`);
      return lines.join("\n");
    }
    if (agents.length === 0) {
      lines.push(`  ${tr.text("agent.no_agents")}`);
      return lines.join("\n");
    }
    for (const agent of agents) {
      const state = agent.state !== "" ? agent.state : "running";
      let info = `  ${agent.id} [${state}]`;
      if (agent.parent !== "") info += ` parent=${agent.parent}`;
      if (agent.children.length > 0) {
        info += ` children=${agent.children.length}`;
      }
      lines.push(info);
    }
    return lines.join("\n");
  }

  /** Switches the focused agent (Go switchAgent). */
  async switchAgent(id: string): Promise<CommandResult> {
    const tr = this.#tr();
    let agents: TUIAgentView[];
    try {
      agents = await this.#host.service.listAgents({
        sessionId: this.#host.currentSessionID(),
      });
    } catch {
      return { message: tr.text("agent.manager_unavailable"), error: true };
    }
    const existing = agents.find((agent) => agent.id === id);
    if (existing === undefined) {
      return { message: tr.text("agent.not_found", id), error: true };
    }
    this.#activeAgent = id;
    return { message: tr.text("agent.focused", id) };
  }

  /** Destroys a sub-agent (Go destroyAgent) through the Core-owned manager. */
  async destroyAgent(id: string): Promise<CommandResult> {
    const tr = this.#tr();
    try {
      await this.#host.service.destroyAgent({
        sessionId: this.#host.currentSessionID(),
        agentId: id,
      });
    } catch {
      return { message: tr.text("agent.not_found", id), error: true };
    }
    return { message: tr.text("agent.destroyed", id) };
  }

  // --- Compaction -----------------------------------------------------------

  /** Forces one Core-owned conversation compaction and projects its events. */
  async compact(): Promise<CommandResult> {
    const tr = this.#tr();
    const sessionId = this.#host.currentSessionID();
    let runId: string;
    try {
      const accepted = await this.#host.service.compact({ sessionId });
      runId = accepted.runId;
    } catch (err) {
      return { message: (err as Error).message, error: true };
    }
    try {
      const terminal = await this.#host.consumeRunEvents(sessionId, runId);
      const payload = terminal?.payload ?? {};
      const status = String(payload.status ?? "completed");
      const compacted = String(payload.compact ?? "");
      if (status === "failed") {
        const error = payload.error;
        return {
          message: typeof error === "string" && error !== ""
            ? error
            : tr.text("compact.done"),
          error: true,
        };
      }
      if (compacted === "skipped") {
        return { message: tr.text("compact.skipped"), error: true };
      }
      return { message: tr.text("compact.done") };
    } catch (err) {
      return { message: (err as Error).message, error: true };
    }
  }

  // --- Reload ---------------------------------------------------------------

  get reloadRequested(): boolean {
    return this.#reloadRequested;
  }

  requestReload(): CommandResult {
    this.#reloadRequested = true;
    return { message: this.#tr().text("reload.requested"), quit: true };
  }
}

/** Formats a duration like the Go stats overlay (e.g. "350ms", "1.5s"). */
function formatStatsDuration(ms: number): string {
  if (ms <= 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export { defaultActiveRegistry, saveEnv };
