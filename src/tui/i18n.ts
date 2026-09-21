// Ported from internal/tui/i18n: language resolution (language.go), the
// immutable Translator with fallback chain zh → en → message id (catalog.go),
// and the bilingual message catalogs (messages.go).
//
// The catalogs are populated per TUI component slice, mirroring the Go
// bundle's message IDs exactly; missing keys fall back to English and then to
// the raw ID, so partial tables are safe during migration.

/** The settings value: "auto" | "zh" | "en". */
export type ConfiguredLanguage = "auto" | "zh" | "en";
/** A render-time language: always "zh" or "en". */
export type Language = "zh" | "en";

/** Stable message identifier (mirrors the Go i18n MessageID constants). */
export type MessageID = string;

/** Parses a settings value; unknown values fall back to auto (valid=false). */
export function parseConfigured(
  value: string,
): { configured: ConfiguredLanguage; valid: boolean } {
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "auto") {
    return { configured: "auto", valid: true };
  }
  if (normalized === "zh") return { configured: "zh", valid: true };
  if (normalized === "en") return { configured: "en", valid: true };
  return { configured: "auto", valid: false };
}

/**
 * Resolves a configured language using the current UTC offset: zh when the
 * zone is UTC+8, en otherwise (Go i18n.Resolve). A null timezone falls back
 * to en.
 */
export function resolveLanguage(
  configured: ConfiguredLanguage,
  now: Date,
  timeZone: string | null,
): Language {
  if (configured === "zh") return "zh";
  if (configured === "en") return "en";
  if (timeZone === null) return "en";
  return utcOffsetHours(now, timeZone) === 8 ? "zh" : "en";
}

/** Formats the zone offset as "UTC+08:00" / "UTC-05:30" ("unknown" if null). */
export function utcOffset(now: Date, timeZone: string | null): string {
  if (timeZone === null) return "unknown";
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  });
  const part = formatter.formatToParts(now).find(
    (p) => p.type === "timeZoneName",
  )?.value ?? "";
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(part);
  if (m === null) return "unknown";
  return `UTC${m[1]}${m[2]}:${m[3]}`;
}

/**
 * The host's local IANA zone (Go time.Local); null when the runtime cannot
 * resolve one (Go falls back to UTC, which Resolve treats as non-UTC+8).
 */
export function localTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

function utcOffsetHours(now: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  });
  const part = formatter.formatToParts(now).find(
    (p) => p.type === "timeZoneName",
  )?.value ?? "";
  const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(part);
  if (m === null) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) + Number(m[3] ?? "0") / 60);
}

/** Minimal Go fmt.Sprintf subset used by message catalogs: %s %d %v %% %0Nd. */
export function sprintf(format: string, args: unknown[] = []): string {
  let argIndex = 0;
  return format.replace(
    /%((\d+)[dv]|[sdv%])/g,
    (match: string, _outer: string, innerDigits: string | undefined) => {
      if (match === "%%") return "%";
      const arg = args[argIndex++];
      if (match.endsWith("d")) {
        const n = Math.trunc(Number(arg));
        if (innerDigits !== undefined) {
          const width = Number(innerDigits);
          const body = String(Math.abs(n)).padStart(width, "0");
          return n < 0 ? `-${body}` : body;
        }
        return String(n);
      }
      return String(arg);
    },
  );
}

/**
 * Bilingual catalogs. Message IDs and texts mirror the Go bundle exactly;
 * populate per component slice during migration.
 */
export const catalogs: Record<Language, Record<MessageID, string>> = {
  en: {
    "tool.modal.state.running": "running",
    "tool.modal.state.ready": "ready",
    "tool.modal.state.done": "done",
    "tool.modal.state.error": "error",
    "tool.modal.state.canceled": "canceled",
    "tool.modal.state.unknown": "unknown",
    "tool.modal.agent_tab": "[ %s %s ]",
    "tool.modal.main": "Main",
    "tool.modal.title": "Agent details",
    "tool.modal.position": "lines %d-%d/%d",
    "tool.modal.position_empty": "lines 0-0/0",
    "tool.modal.switch_target_hint": "Left/Right:switch target",
    "tool.modal.page_hint": "PgUp/PgDn:page",
    "tool.modal.scroll_hint": "Up/Down:scroll",
    "tool.modal.close_hint": "Esc:close",
    "activity.hosted_item": "hosted item",
    "activity.tool_started": "tool started: %s",
    "activity.tool_result": "tool result",
    "activity.done": "done",
    "activity.error": "error: %s",
    "activity.canceled": "canceled",
    "activity.no_activity": "no activity captured yet",
    "activity.latest_tool": "Latest tool:",
    "activity.thinking": "Thinking:",
    "activity.response": "Response:",
    "activity.latest_result": "Latest result:",
    "activity.timeline": "Activity timeline:",
    "activity.updated": "updated %s",
    "tool.result.lines": "%d lines",
    "tool.result.applied": "Applied",
    "activity.ago_seconds": "%ds ago",
    "activity.ago_minutes": "%dm ago",
    "esm.panel.load_failed": "Failed to load ESM progress: %v",
    "esm.panel.no_objective":
      "No Enable Supervisor Mode objective for this session.",
    "esm.panel.create_hint": "Create one with /esm <objective>.",
    "esm.panel.title": "Enable Supervisor Mode",
    "esm.panel.now": "Now: %s",
    "esm.panel.next": "Next: %s",
    "esm.panel.status": "Status: %s",
    "esm.panel.stage": "Stage: %s",
    "esm.panel.pipeline": "Pipeline: %s",
    "esm.panel.objective": "Objective",
    "esm.panel.latest_worker_progress": "Latest worker progress",
    "esm.panel.remaining_work": "Remaining work (%d):",
    "esm.panel.blocker": "Blocker",
    "esm.panel.repeated_blocker_audit": "Repeated blocker audit: %d/3",
    "esm.panel.latest_completion_review": "Latest completion review",
    "esm.panel.completion_rejections": "Consecutive completion rejections: %d",
    "esm.panel.automatic_recoveries": "Consecutive automatic recoveries: %d",
    "esm.panel.latest_recovery_reason": "Latest recovery reason",
    "esm.panel.completion_candidate": "Completion candidate",
    "esm.panel.live_details": "Live details:",
    "esm.panel.tokens": "Tokens: %d",
    "esm.panel.time": "Time: %s",
    "esm.panel.last_saved": "Last saved update: %s",
    "esm.panel.subagent_starting": "sub-agent is starting",
    "esm.panel.latest_tool": "latest tool: %s",
    "esm.panel.latest_result": "latest result: %s",
    "esm.panel.latest_response": "latest response: %s",
    "esm.panel.thinking": "Thinking: %s",
    "esm.panel.no_further_work": "No further ESM work is scheduled",
    "esm.panel.progress": "Progress: %d/3 pipeline stages completed",
    "esm.panel.work_remaining": "; %d work item(s) remaining",
    "esm.panel.activity_starting": "  %s [starting]",
    "esm.panel.activity_state": "  %s [%s]",
    "esm.panel.tool": "  Tool: %s",
    "esm.panel.latest": "  Latest: %s",
    "esm.panel.phase.critic_review": "Critic review",
    "esm.panel.phase.final_audit": "Final audit",
    "esm.panel.phase.complete": "Complete",
    "esm.panel.phase.worker_execution": "Worker execution",
    "esm.panel.activity.paused": "ESM is paused",
    "esm.panel.activity.blocked": "ESM is blocked",
    "esm.panel.activity.usage_limited":
      "ESM is waiting for the provider limit to clear",
    "esm.panel.activity.audit_passed": "The objective has passed final audit",
    "esm.panel.activity.critic_reviewing":
      "Critic is independently reviewing the worker evidence",
    "esm.panel.activity.auditing":
      "Audit is independently verifying completion",
    "esm.panel.activity.worker_investigating":
      "Worker is investigating and implementing the objective",
    "esm.panel.next.paused":
      "Review the outstanding work, then run /esm resume",
    "esm.panel.next.blocked": "Resolve the blocker, then run /esm resume",
    "esm.panel.next.usage_limited":
      "Resolve the provider usage limit, then run /esm resume",
    "esm.panel.next.complete": "No further ESM work is scheduled",
    "esm.panel.next.critic":
      "A passing critic review advances the candidate to final audit",
    "esm.panel.next.audit":
      "A passing audit marks the objective complete; a failure returns it to the worker",
    "esm.panel.next.worker":
      "Worker will record concrete progress and remaining work before the next run",
    "esm.panel.shortcut_hint":
      "Up/Down:scroll  PgUp/PgDn:page  Ctrl+E/Esc:close",
    "esm.panel.position": "lines %d-%d/%d",
    "esm.panel.position_empty": "lines 0-0/0",
    "input.placeholder": "Type a message...",
    "commands.title": "Commands:",
    "commands.usage": "Usage: %s",
    "dialog.model.title": "Switch Model",
    "dialog.model.hint":
      "Enter to switch · type to filter · ↑↓ navigate · Esc close",
    "dialog.default_model.title": "Set Default Model (%s)",
    "dialog.default_model.provider_hint":
      "Enter to choose a provider · type to filter · Esc back",
    "dialog.default_model.model_hint":
      "Enter to save · type to filter · Esc back",
    "dialog.default_model.validation_failed": "Invalid provider/model: %v",
    "dialog.default_model.save_failed": "Failed to save default model: %v",
    "dialog.default_model.saved": "✅ Default model set to %s/%s (%s settings)",
    "dialog.env.title": "Environment Variables",
    "dialog.env.add": "+ Add Variable",
    "dialog.env.done": "✓ Done",
    "dialog.env.prompt_key": "Variable name:",
    "dialog.env.prompt_value": "Value for %s:",
    "dialog.env.placeholder_key": "environment variable name",
    "dialog.env.placeholder_value": "value",
    "dialog.env.hint":
      "Enter edit/select · Backspace deletes in the input · Esc close",
    "dialog.env.input_hint": "Enter to confirm · Esc to cancel",
    "dialog.env.invalid_name": "Invalid environment variable name",
    "dialog.env.save_failed": "Save env: %v",
    "dialog.sessions.title": "Sessions",
    "dialog.sessions.cwd": "%s",
    "dialog.sessions.hint":
      "Enter switch · n new · d delete · q close · Esc close",
    "dialog.auth.title": "Connect Provider",
    "dialog.auth.existing": "Existing Provider",
    "dialog.auth.existing_desc":
      "Configure a built-in or already-added provider",
    "dialog.auth.custom": "Custom Provider",
    "dialog.auth.custom_desc":
      "Add a provider that is not in the built-in list",
    "dialog.auth.hint": "Enter to select · Esc close",
    "dialog.auth.providers_title": "Choose Provider",
    "dialog.auth.providers_hint":
      "Enter to configure · type to filter · Esc back",
    "dialog.auth.provider_title": "Provider: %s",
    "dialog.auth.provider_state": "Status: %s",
    "dialog.auth.set_key": "Set API Key",
    "dialog.auth.set_key_desc": "Store the credential in the global settings",
    "dialog.auth.use_as_default": "Use as Default Provider",
    "dialog.auth.provider_hint": "Enter to select · Esc back",
    "dialog.auth.key_title": "API Key for %s",
    "dialog.auth.key_prompt": "API key:",
    "dialog.auth.key_placeholder": "paste the provider API key",
    "dialog.auth.key_hint": "Enter to save · Esc back",
    "dialog.auth.key_required": "An API key is required",
    "dialog.auth.key_saved": "✅ API key saved for %s",
    "dialog.auth.custom_title": "Custom Provider ID",
    "dialog.auth.custom_prompt": "Provider ID:",
    "dialog.auth.custom_placeholder": "provider id (e.g. my-gateway)",
    "dialog.auth.custom_hint": "Enter to continue · Esc back",
    "dialog.auth.custom_required": "A provider ID is required",
    "dialog.settings.title": "Settings",
    "dialog.settings.defaults": "Default Model",
    "dialog.settings.behavior": "Behavior",
    "dialog.settings.behavior_desc": "Auto-edit and plan-tool switches",
    "dialog.settings.hint": "Enter to open · Esc close",
    "dialog.settings.default_provider": "Default Provider",
    "dialog.settings.default_model": "Default Model",
    "dialog.settings.defaults_hint":
      "Enter opens the default-model picker · Esc back",
    "dialog.settings.auto_edit": "Auto-edit (agent mode)",
    "dialog.settings.plan_tool": "Plan tool",
    "dialog.settings.behavior_hint": "Enter toggles the switch · Esc back",
    "dialog.settings.plan_tool_saved": "✅ Plan tool: %s",
    "dialog.tuilang.title": "TUI Language",
    "dialog.tuilang.global": "Global",
    "dialog.tuilang.global_desc": "Apply to every project",
    "dialog.tuilang.project": "Project",
    "dialog.tuilang.project_desc": "Apply only to this project",
    "dialog.tuilang.scope_hint": "Enter to choose the scope · Esc close",
    "dialog.tuilang.language_hint": "Enter to save · Esc back",
    "cron.requires_multi_agent":
      "Cron commands require multi-agent mode. Restart with --multi-agent to enable.",
    "cron.store_unavailable": "Cron store not initialized.",
    "cron.created": "✅ Cron task created: %s (id: %s)",
    "cron.list_empty": "Cron tasks: (none configured)",
    "cron.list_title": "Cron tasks (%d):",
    "cron.entry": "  %s [%s] %s (runs: %d)",
    "cron.changed": "Cron task %s %s",
    "cron.changed.enabled": "enabled",
    "cron.changed.disabled": "disabled",
    "cron.changed.removed": "removed",
    "cron.triggered":
      "▶ Cron task %s triggered (will run on next scheduler tick)",
    "cron.scheduler_unavailable": "Scheduler not running.",
    "cron.unknown_command": "Unknown cron command: %s",
    "cron.create_failed": "Failed to create cron task: %v",
    "cron.list_failed": "Failed to list cron tasks: %v",
    "stats.starting": "Starting statistics server...",
    "stats.server.already_running": "Statistics server already running: %s",
    "stats.server.not_running": "Statistics server is not running.",
    "stats.server.stopped": "Statistics server stopped.",
    "stats.server.stop_failed": "Failed to stop statistics server: %v",
    "stats.start_failed": "Failed to start statistics server: %v",
    "stats.title": "Usage statistics",
    "stats.requests": "Requests: %d",
    "stats.input_tokens": "Input tokens: %d",
    "stats.output_tokens": "Output tokens: %d",
    "stats.total_tokens": "Total tokens: %d",
    "stats.by_provider": "By provider:",
    "stats.by_model": "By model:",
    "stats.no_data": "No usage statistics recorded yet.",
    "stats.load_failed": "Failed to load usage statistics: %v",
    "stats.usage": "Usage: /stats server|stop-server|tui",
    "systeminit.running": "Cannot run /systeminit while the agent is running.",
    "systeminit.compacting":
      "Cannot run /systeminit while context compaction is running.",
    "systeminit.switched_mode":
      "Switched to AGENT mode for /systeminit (AGENTS.md needs write access).",
    "systeminit.interactive":
      "🛠 /systeminit: analyzing the project; I'll ask a few questions, then write AGENTS.md.",
    "systeminit.automatic":
      "🛠 /systeminit: analyzing the project and writing AGENTS.md...",
    "settings.usage": "Usage: /defaultModel [project|global]",
    "settings.default_model_saved": "✅ Default model set to %s (%s settings)",
    "settings.save_failed": "Failed to save settings: %v",
    "settings.project_unavailable":
      "Project scope is unavailable outside a project directory.",
    "auth.no_providers": "No providers are configured.",
    "auth.providers_title": "Providers (%d):",
    "auth.provider_entry": "  %s [%s] %s",
    "auth.provider_configured": "configured",
    "auth.provider_unconfigured": "missing API key",
    "auth.usage":
      "Usage: /auth — edit settings.json providers section to configure a provider",
    "tuilang.status": "TUI language: configured=%s effective=%s %s",
    "tuilang.saved": "✅ TUI language saved to %s: %s (effective: %s)",
    "tuilang.save_failed": "Failed to save TUI language: %v",
    "tuilang.usage": "Usage: /tuilang [global|project] [auto|zh|en]",
    "tuilang.project_unavailable":
      "Project scope is unavailable outside a project directory.",
    "paste_image.failed": "Failed to read the clipboard image: %v",
    "paste_image.no_png": "Clipboard does not contain a PNG image.",
    "paste_image.path": "[Image #%d: %s]",
    "paste_image.pasted": "✅ Clipboard image attached: %s",
    "paste_image.preview_hint": "Press Ctrl+R to preview.",
    "paste_image.no_image": "No image has been pasted yet.",
    "paste_image.open_failed": "Failed to open %s: %v",
    "paste_image.opened": "Opened %s",
    "btw.usage":
      "Usage: /btw <question> — ask a side question without touching the main task",
    "btw.already_running":
      "A /btw query is already running. Close it (Esc) before starting another.",
    "btw.build_failed": "Failed to build side query agent: %v",
    "btw.title": "💬 /btw: %s",
    "btw.thinking": "Thinking…",
    "btw.error": "Error: %v",
    "shell.hint":
      "enter send · alt+enter newline · tab mode · ctrl+o details · ctrl+e esm · ctrl+c exit",
    "shell.busy": "working… — ctrl+c cancel run",
    "reload.requested":
      "↻ Reloading: starting a fresh process with a new session...",
    "tool.modal.no_details": "No tool details captured yet.",
    "agent.multi_on": "Multi-agent mode: ON",
    "commands.unknown": "Unknown: %s",
    "commands.unsupported": "%s is not available in this build yet.",
    "commands.mode": "Mode: %s",
    "commands.current_mode": "Current mode: %s",
    "commands.invalid_mode": "Invalid mode. Use: plan, agent, yolo, os",
    "commands.permissions.plan": "  Permissions: READ only (no modifications)",
    "commands.permissions.agent":
      "  Permissions: READ/WRITE/EDIT auto | BASH requires approval",
    "commands.permissions.yolo": "  Permissions: ALL tools auto-execute",
    "commands.permissions.os":
      "  Permissions: BASH only, auto-execute (no sandbox; blacklisted commands still require approval)",
    "commands.model.not_found": "Model %s not found — available: %s",
    "commands.model.switched": "✅ Model switched to: %s (%s)",
    "commands.model.current": "Current model: %s (%s)",
    "commands.mode.change_aborted": "⏹ Aborted (mode change)",
    "commands.running_cannot_change":
      "Cannot change %s while the agent is running.",
    "keyboard.shortcuts.title": "Keyboard shortcuts:",
    "keyboard.shortcut.submit": "Submit input",
    "keyboard.shortcut.newline": "Insert newline in input",
    "keyboard.shortcut.cycle_mode": "Cycle mode (plan/agent/yolo/os)",
    "keyboard.shortcut.abort": "Abort current operation",
    "keyboard.shortcut.tool_details": "Open latest tool details",
    "keyboard.shortcut.esm_progress": "Open Supervisor Mode progress",
    "keyboard.shortcut.preview_image": "Preview latest pasted image",
    "keyboard.shortcut.compact_tools": "Toggle simple/full event display",
    "keyboard.shortcut.move_history":
      "Move in multiline input; history at boundaries",
    "keyboard.shortcut.switch_detail_target":
      "Switch detail target when Ctrl+O modal is open",
    "keyboard.shortcut.page_panel":
      "Page an open details or ESM progress panel",
    "conversation.cleared": "✅ Conversation cleared",
    "compact.running": "Cannot compact while the agent is running.",
    "compact.empty": "Nothing to compact: no active conversation.",
    "compact.skipped":
      "Compaction is not possible for the current conversation.",
    "compact.done": "✅ Context compacted",
    "skills.unavailable": "No skills manager available.",
    "skills.empty": "No skills found.",
    "skill.not_found": "Skill not found: %s",
    "skill.already_active": "Skill '%s' is already active.",
    "skill.activated": "✅ Skill '%s' activated (%s): %s",
    "skill.available_title": "Available skills:",
    "alloweditpath.title": "Auto-edit path whitelist (agent mode):",
    "alloweditpath.already": "Already in whitelist: %s",
    "alloweditpath.not_found": "Not in whitelist: %s",
    "alloweditpath.saved": "✅ %s auto-edit whitelist: %s",
    "alloweditpath.added": "added to",
    "alloweditpath.removed": "removed from",
    "alloweditpath.cleared": "✅ Auto-edit path whitelist cleared",
    "alloweditpath.save_failed": "Failed to save allow.json: %v",
    "allowautoedit.status": "Auto-edit (agent mode): %s",
    "allowautoedit.saved": "✅ Auto-edit (agent mode): %s [%s]",
    "delegate.status": "Delegation mode: %s",
    "delegate.changed": "Delegation mode: %s",
    "delegate.running":
      "Cannot change delegation mode while the agent is running.",
    "browser.status": "Browser tool: %s",
    "browser.running": "Cannot change browser tool while the agent is running.",
    "agent.manager_unavailable": "Agent manager is not initialized.",
    "agent.disabled":
      "Multi-agent mode is disabled. Restart with --multi-agent to enable it.",
    "agent.none": "No agents running.",
    "agent.not_found": "Agent %s not found.",
    "agent.focused": "Focused agent tab: %s",
    "agent.input_hint":
      "Input still goes to the main agent; use subagent_send for follow-up instructions.",
    "agent.cannot_destroy_main": "Cannot destroy the main agent",
    "agent.destroyed": "Agent %s destroyed",
    "agent.destroy_failed": "Failed to destroy agent %s: %v",
    "sessions.list_title": "Sessions (%d):",
    "sessions.no_sessions": "No sessions found for this directory.",
    "sessions.switched": "✅ Switched to session %s (%d messages)",
    "sessions.cannot_switch_running":
      "Cannot switch sessions while the agent is running.",
    "sessions.already_current": "Already on this session.",
    "sessions.unsupported_switch":
      "Switching sessions is not available in this build yet (requested %s).",
    "sessions.unknown_subcommand": "Unknown sessions subcommand: %s",
    "sessions.error_listing": "Failed to list sessions: %v",
    "sessions.delete_failed": "Failed to delete session: %v",
    "sessions.deleted": "✅ Session %s deleted",
    "sessions.cannot_delete_current": "Cannot delete the current session",
    "sessions.no_match": "Session not found: %s",
    "sessions.ambiguous_id": "Session ID is ambiguous: %s",
    "sessions.clear_hint": "A new session will be created on the next message.",
    "mcps.title": "MCP servers (%d):",
    "mcps.empty": "No MCP servers configured.",
    "mcps.entry": "  %s [%s] %s",
    "mcps.enabled": "enabled",
    "mcps.disabled": "disabled",
    "init_mcp.created": "✅ Wrote MCP config: %s",
    "init_mcp.exists": "MCP config already exists (scope: %s)",
    "init_mcp.failed": "Failed to write MCP config: %v",
    "rule.running": "Cannot change /rule while the agent is running.",
    "rule.write_failed": "Failed to write rule file: %v",
    "rule.created": "%s rule file: %s",
    "rule.overwrote": "Overwrote",
    "rule.created_verb": "Created",
    "rule.loaded": "Loaded into the current session.",
    "rule.exists": "Rule file already exists: %s",
    "expert.list_title": "Experts (%d):",
    "expert.empty": "No experts found.",
    "expert.entry": "  %s (%s): %s",
    "expert.bound": "✅ Expert bound: %s",
    "expert.unbound": "✅ Expert unbound",
    "expert.not_found": "Expert not found: %s",
    "expert.switch_requires_fork":
      "Switching from %s to %s requires a fork; use /expert switch %s to fork.",
    "expert.switched": "✅ Forked to session %s with expert %s",
    "env.title": "Environment variables (%d):",
    "env.empty": "No extra environment variables configured.",
    "env.entry": "  %s=%s",
    "env.set": "✅ %s set",
    "env.unset": "✅ %s unset",
    "env.cleared": "✅ Extra environment variables cleared",
    "env.failed": "Failed to update environment: %v",
    "env.usage": "Usage: /env [list|set KEY VALUE|unset KEY|clear]",
    "statusline.off": "Status line: OFF (builtin footer)",
    "statusline.on": "Status line: ON (%s settings)",
    "statusline.status": "Status line: %s  refresh=%s  command=%s",
    "statusline.failed": "Failed to update status line: %v",
    "workflows.list_title": "Workflow runs (%d):",
    "workflows.empty": "Workflow runs: (none)",
    "workflows.entry": "  [%s] %s %s (%s)",
    "workflows.failed": "Failed to list workflows: %v",
    "workflows.show_title": "Workflow %s: %s",
    "workflows.show_failed": "Failed to load workflow: %v",
    "workflows.name": "Name: %s",
    "workflows.phase": "Phase [%s] %s tasks=%d",
    "workflows.error": "Error: %s",
    "clipboard.failed": "Failed to read the clipboard image: %v",
    "clipboard.no_png": "Clipboard does not contain a PNG image.",
    "clipboard.saved": "✅ Clipboard image saved: %s",
    "commands.mode.description":
      "Switch or show execution mode (plan/agent/yolo/os)",
    "commands.esm.description": "Enable or inspect Supervisor Mode",
    "commands.model.description": "Switch or show model",
    "commands.default_model.description": "Set the default provider/model",
    "commands.auth.description":
      "Configure provider token, base URL and models",
    "commands.settings.description":
      "Configure settings.json groups, including providers",
    "commands.tuilang.description": "Set the TUI language (global by default)",
    "commands.skills.description": "List available skills",
    "commands.skillhub.description":
      "Browse, search and install marketplace skills",
    "commands.env.description": "Manage extra environment variables",
    "commands.skill.description": "Activate a skill",
    "commands.paste_image.description":
      "Save a clipboard image and insert its local path",
    "commands.clear.description": "Clear conversation",
    "commands.compact.description": "Trigger context compaction",
    "commands.sessions.description": "List, switch, create or delete sessions",
    "commands.expert.description":
      "List, inspect, bind or fork-switch expert personas",
    "commands.init_mcp.description": "Initialize mcp.json",
    "commands.mcps.description": "List MCP servers",
    "commands.delegate.description": "Toggle delegation mode",
    "commands.browser.description": "Toggle browser automation",
    "commands.stats.description": "Manage or display usage statistics",
    "commands.statusline.description": "Inspect or toggle the TUI status line",
    "commands.alloweditpath.description": "Manage the auto-edit path whitelist",
    "commands.allowautoedit.description": "Toggle full auto-edit in agent mode",
    "commands.btw.description":
      "Ask a side question without touching the main task",
    "commands.systeminit.description": "Generate or refresh AGENTS.md",
    "commands.rule.description": "Create safe default project rules",
    "commands.reload.description":
      "Restart as a fresh process with a new session",
    "commands.workflows.description": "Inspect workflow runs",
    "commands.agent.description": "Manage multi-agent workers",
    "commands.cron.description": "Manage scheduled tasks",
    "commands.quit.description": "Exit",
    "commands.help.description": "Show this help",
  },
  zh: {
    "tool.modal.state.running": "运行中",
    "tool.modal.state.ready": "就绪",
    "tool.modal.state.done": "完成",
    "tool.modal.state.error": "错误",
    "tool.modal.state.canceled": "已取消",
    "tool.modal.state.unknown": "未知",
    "tool.modal.agent_tab": "[ %s %s ]",
    "tool.modal.main": "主界面",
    "tool.modal.title": "Agent 详情",
    "tool.modal.position": "第 %d-%d/%d 行",
    "tool.modal.position_empty": "第 0-0/0 行",
    "tool.modal.switch_target_hint": "←/→：切换目标",
    "tool.modal.page_hint": "PgUp/PgDn：翻页",
    "tool.modal.scroll_hint": "↑/↓：滚动",
    "tool.modal.close_hint": "Esc：关闭",
    "activity.hosted_item": "托管项目",
    "activity.tool_started": "工具已开始：%s",
    "activity.tool_result": "工具结果",
    "activity.done": "完成",
    "activity.error": "错误：%s",
    "activity.canceled": "已取消",
    "activity.no_activity": "暂无活动记录",
    "activity.latest_tool": "最新工具：",
    "activity.thinking": "思考：",
    "activity.response": "回复：",
    "activity.latest_result": "最新结果：",
    "activity.timeline": "活动时间线：",
    "activity.updated": "更新于 %s",
    "tool.result.lines": "%d 行",
    "tool.result.applied": "已应用",
    "activity.ago_seconds": "%d 秒前",
    "activity.ago_minutes": "%d 分钟前",
    "esm.panel.load_failed": "加载 ESM 进度失败：%v",
    "esm.panel.no_objective": "此会话没有 Enable Supervisor Mode 目标。",
    "esm.panel.create_hint": "使用 /esm <objective> 创建目标。",
    "esm.panel.title": "Enable Supervisor Mode",
    "esm.panel.now": "当前：%s",
    "esm.panel.next": "下一步：%s",
    "esm.panel.status": "状态：%s",
    "esm.panel.stage": "阶段：%s",
    "esm.panel.pipeline": "流水线：%s",
    "esm.panel.objective": "目标",
    "esm.panel.latest_worker_progress": "Worker 最新进度",
    "esm.panel.remaining_work": "剩余工作（%d）：",
    "esm.panel.blocker": "阻塞原因",
    "esm.panel.repeated_blocker_audit": "重复阻塞审计：%d/3",
    "esm.panel.latest_completion_review": "最新完成审查",
    "esm.panel.completion_rejections": "连续完成拒绝：%d",
    "esm.panel.automatic_recoveries": "连续自动恢复：%d",
    "esm.panel.latest_recovery_reason": "最新恢复原因",
    "esm.panel.completion_candidate": "完成候选",
    "esm.panel.live_details": "实时详情：",
    "esm.panel.tokens": "Token：%d",
    "esm.panel.time": "时间：%s",
    "esm.panel.last_saved": "最近保存更新：%s",
    "esm.panel.subagent_starting": "子 Agent 正在启动",
    "esm.panel.latest_tool": "最新工具：%s",
    "esm.panel.latest_result": "最新结果：%s",
    "esm.panel.latest_response": "最新回复：%s",
    "esm.panel.thinking": "思考：%s",
    "esm.panel.no_further_work": "没有安排更多 ESM 工作",
    "esm.panel.progress": "进度：已完成 %d/3 个流水线阶段",
    "esm.panel.work_remaining": "；剩余 %d 项工作",
    "esm.panel.activity_starting": "  %s [启动中]",
    "esm.panel.activity_state": "  %s [%s]",
    "esm.panel.tool": "  工具：%s",
    "esm.panel.latest": "  最新：%s",
    "esm.panel.phase.critic_review": "Critic 审查",
    "esm.panel.phase.final_audit": "最终审计",
    "esm.panel.phase.complete": "已完成",
    "esm.panel.phase.worker_execution": "Worker 执行",
    "esm.panel.activity.paused": "ESM 已暂停",
    "esm.panel.activity.blocked": "ESM 已阻塞",
    "esm.panel.activity.usage_limited": "ESM 正在等待 Provider 限制解除",
    "esm.panel.activity.audit_passed": "目标已通过最终审计",
    "esm.panel.activity.critic_reviewing": "Critic 正在独立审查 Worker 证据",
    "esm.panel.activity.auditing": "Audit 正在独立验证完成状态",
    "esm.panel.activity.worker_investigating": "Worker 正在调查并实现目标",
    "esm.panel.next.paused": "检查未完成工作后运行 /esm resume",
    "esm.panel.next.blocked": "解决阻塞原因后运行 /esm resume",
    "esm.panel.next.usage_limited": "解决 Provider 使用限制后运行 /esm resume",
    "esm.panel.next.complete": "没有安排更多 ESM 工作",
    "esm.panel.next.critic": "通过 Critic 审查后将进入最终审计",
    "esm.panel.next.audit": "通过审计后目标完成；失败则返回 Worker",
    "esm.panel.next.worker": "Worker 将在下次运行前记录具体进度和剩余工作",
    "esm.panel.shortcut_hint": "上/下：滚动  PgUp/PgDn：翻页  Ctrl+E/Esc：关闭",
    "esm.panel.position": "行 %d-%d/%d",
    "esm.panel.position_empty": "行 0-0/0",
    "input.placeholder": "输入消息...",
    "commands.title": "命令：",
    "commands.usage": "用法：%s",
    "dialog.model.title": "切换模型",
    "dialog.model.hint": "回车切换 · 输入筛选 · ↑↓ 选择 · Esc 关闭",
    "dialog.default_model.title": "设置默认模型（%s）",
    "dialog.default_model.provider_hint":
      "回车选择 Provider · 输入筛选 · Esc 返回",
    "dialog.default_model.model_hint": "回车保存 · 输入筛选 · Esc 返回",
    "dialog.default_model.validation_failed": "Provider/模型无效：%v",
    "dialog.default_model.save_failed": "保存默认模型失败：%v",
    "dialog.default_model.saved": "✅ 默认模型已设为 %s/%s（%s 设置）",
    "dialog.env.title": "环境变量",
    "dialog.env.add": "+ 添加变量",
    "dialog.env.done": "✓ 完成",
    "dialog.env.prompt_key": "变量名：",
    "dialog.env.prompt_value": "%s 的值：",
    "dialog.env.placeholder_key": "环境变量名",
    "dialog.env.placeholder_value": "值",
    "dialog.env.hint": "回车编辑/选择 · 输入框内退格删除 · Esc 关闭",
    "dialog.env.input_hint": "回车确认 · Esc 取消",
    "dialog.env.invalid_name": "环境变量名无效",
    "dialog.env.save_failed": "保存 env：%v",
    "dialog.sessions.title": "会话",
    "dialog.sessions.cwd": "%s",
    "dialog.sessions.hint": "回车切换 · n 新建 · d 删除 · q 关闭 · Esc 关闭",
    "dialog.auth.title": "连接 Provider",
    "dialog.auth.existing": "已有 Provider",
    "dialog.auth.existing_desc": "配置内置或已添加的 Provider",
    "dialog.auth.custom": "自定义 Provider",
    "dialog.auth.custom_desc": "添加不在内置列表中的 Provider",
    "dialog.auth.hint": "回车选择 · Esc 关闭",
    "dialog.auth.providers_title": "选择 Provider",
    "dialog.auth.providers_hint": "回车配置 · 输入筛选 · Esc 返回",
    "dialog.auth.provider_title": "Provider：%s",
    "dialog.auth.provider_state": "状态：%s",
    "dialog.auth.set_key": "设置 API Key",
    "dialog.auth.set_key_desc": "将凭据保存到全局设置",
    "dialog.auth.use_as_default": "设为默认 Provider",
    "dialog.auth.provider_hint": "回车选择 · Esc 返回",
    "dialog.auth.key_title": "%s 的 API Key",
    "dialog.auth.key_prompt": "API Key：",
    "dialog.auth.key_placeholder": "粘贴 Provider API Key",
    "dialog.auth.key_hint": "回车保存 · Esc 返回",
    "dialog.auth.key_required": "必须填写 API Key",
    "dialog.auth.key_saved": "✅ 已保存 %s 的 API Key",
    "dialog.auth.custom_title": "自定义 Provider ID",
    "dialog.auth.custom_prompt": "Provider ID：",
    "dialog.auth.custom_placeholder": "Provider ID（例如 my-gateway）",
    "dialog.auth.custom_hint": "回车继续 · Esc 返回",
    "dialog.auth.custom_required": "必须填写 Provider ID",
    "dialog.settings.title": "设置",
    "dialog.settings.defaults": "默认模型",
    "dialog.settings.behavior": "行为",
    "dialog.settings.behavior_desc": "自动编辑与计划工具开关",
    "dialog.settings.hint": "回车打开 · Esc 关闭",
    "dialog.settings.default_provider": "默认 Provider",
    "dialog.settings.default_model": "默认模型",
    "dialog.settings.defaults_hint": "回车打开默认模型选择器 · Esc 返回",
    "dialog.settings.auto_edit": "自动编辑（agent 模式）",
    "dialog.settings.plan_tool": "计划工具",
    "dialog.settings.behavior_hint": "回车切换开关 · Esc 返回",
    "dialog.settings.plan_tool_saved": "✅ 计划工具：%s",
    "dialog.tuilang.title": "TUI 语言",
    "dialog.tuilang.global": "全局",
    "dialog.tuilang.global_desc": "应用于所有项目",
    "dialog.tuilang.project": "项目",
    "dialog.tuilang.project_desc": "仅应用于当前项目",
    "dialog.tuilang.scope_hint": "回车选择范围 · Esc 关闭",
    "dialog.tuilang.language_hint": "回车保存 · Esc 返回",
    "cron.requires_multi_agent":
      "Cron 命令需要多 Agent 模式，请使用 --multi-agent 启动。",
    "cron.store_unavailable": "Cron 存储未初始化。",
    "cron.created": "✅ 已创建定时任务：%s（id：%s）",
    "cron.list_empty": "定时任务：（未配置）",
    "cron.list_title": "定时任务（%d）：",
    "cron.entry": "  %s [%s] %s（运行：%d）",
    "cron.changed": "定时任务 %s %s",
    "cron.changed.enabled": "已启用",
    "cron.changed.disabled": "已禁用",
    "cron.changed.removed": "已移除",
    "cron.triggered": "▶ 已触发定时任务 %s（将在下次调度时运行）",
    "cron.scheduler_unavailable": "调度器未运行。",
    "cron.unknown_command": "未知 cron 子命令：%s",
    "cron.create_failed": "创建定时任务失败：%v",
    "cron.list_failed": "列出定时任务失败：%v",
    "stats.starting": "正在启动统计服务器...",
    "stats.server.already_running": "统计服务器已在运行：%s",
    "stats.server.not_running": "统计服务器未运行。",
    "stats.server.stopped": "统计服务器已停止。",
    "stats.server.stop_failed": "停止统计服务器失败：%v",
    "stats.start_failed": "启动统计服务器失败：%v",
    "stats.title": "用量统计",
    "stats.requests": "请求数：%d",
    "stats.input_tokens": "输入 Token：%d",
    "stats.output_tokens": "输出 Token：%d",
    "stats.total_tokens": "总 Token：%d",
    "stats.by_provider": "按 Provider：",
    "stats.by_model": "按模型：",
    "stats.no_data": "尚无用量统计记录。",
    "stats.load_failed": "加载用量统计失败：%v",
    "stats.usage": "用法：/stats server|stop-server|tui",
    "systeminit.running": "Agent 运行中，无法执行 /systeminit。",
    "systeminit.compacting": "上下文压缩进行中，无法执行 /systeminit。",
    "systeminit.switched_mode":
      "已切换到 AGENT 模式以执行 /systeminit（写入 AGENTS.md 需要写权限）。",
    "systeminit.interactive":
      "🛠 /systeminit：正在分析项目；我会先问几个问题，然后写入 AGENTS.md。",
    "systeminit.automatic": "🛠 /systeminit：正在分析项目并写入 AGENTS.md...",
    "settings.usage": "用法：/defaultModel [project|global]",
    "settings.default_model_saved": "✅ 默认模型已设为 %s（%s 设置）",
    "settings.save_failed": "保存设置失败：%v",
    "settings.project_unavailable": "非项目目录下无法使用 project 范围。",
    "auth.no_providers": "未配置任何 Provider。",
    "auth.providers_title": "Provider（%d）：",
    "auth.provider_entry": "  %s [%s] %s",
    "auth.provider_configured": "已配置",
    "auth.provider_unconfigured": "缺少 API Key",
    "auth.usage":
      "用法：/auth — 请编辑 settings.json 的 providers 段以配置 Provider",
    "tuilang.status": "TUI 语言：configured=%s effective=%s %s",
    "tuilang.saved": "✅ TUI 语言已保存到 %s：%s（生效：%s）",
    "tuilang.save_failed": "保存 TUI 语言失败：%v",
    "tuilang.usage": "用法：/tuilang [global|project] [auto|zh|en]",
    "tuilang.project_unavailable": "非项目目录下无法使用 project 范围。",
    "paste_image.failed": "读取剪贴板图片失败：%v",
    "paste_image.no_png": "剪贴板中没有 PNG 图片。",
    "paste_image.path": "[图片 #%d：%s]",
    "paste_image.pasted": "✅ 已附加剪贴板图片：%s",
    "paste_image.preview_hint": "按 Ctrl+R 预览。",
    "paste_image.no_image": "尚未粘贴过图片。",
    "paste_image.open_failed": "打开 %s 失败：%v",
    "paste_image.opened": "已打开 %s",
    "btw.usage": "用法：/btw <问题> —— 提问旁支问题，不影响主任务",
    "btw.already_running": "已有 /btw 查询在运行，请先用 Esc 关闭。",
    "btw.build_failed": "构建旁支查询 Agent 失败：%v",
    "btw.title": "💬 /btw：%s",
    "btw.thinking": "思考中…",
    "btw.error": "错误：%v",
    "shell.hint":
      "回车发送 · alt+回车换行 · tab 切换模式 · ctrl+o 详情 · ctrl+e esm · ctrl+c 退出",
    "shell.busy": "运行中… — ctrl+c 取消运行",
    "reload.requested": "↻ 正在重载：以新会话启动新进程...",
    "tool.modal.no_details": "暂无工具详情。",
    "agent.multi_on": "多 Agent 模式：开启",
    "commands.unknown": "未知命令：%s",
    "commands.unsupported": "%s 在当前版本尚不可用。",
    "commands.mode": "模式：%s",
    "commands.current_mode": "当前模式：%s",
    "commands.invalid_mode": "无效模式。可用：plan、agent、yolo、os",
    "commands.permissions.plan": "  权限：仅只读（不可修改）",
    "commands.permissions.agent": "  权限：读/写/编辑自动执行 | Bash 需审批",
    "commands.permissions.yolo": "  权限：全部工具自动执行",
    "commands.permissions.os":
      "  权限：仅 Bash，自动执行（无沙箱；黑名单命令仍需审批）",
    "commands.model.not_found": "未找到模型 %s —— 可用：%s",
    "commands.model.switched": "✅ 已切换模型：%s（%s）",
    "commands.model.current": "当前模型：%s（%s）",
    "commands.mode.change_aborted": "⏹ 已中止（模式变更）",
    "commands.running_cannot_change": "Agent 运行中，无法修改 %s。",
    "keyboard.shortcuts.title": "键盘快捷键：",
    "keyboard.shortcut.submit": "提交输入",
    "keyboard.shortcut.newline": "在输入中插入换行",
    "keyboard.shortcut.cycle_mode": "循环切换模式（plan/agent/yolo/os）",
    "keyboard.shortcut.abort": "中止当前操作",
    "keyboard.shortcut.tool_details": "打开最新工具详情",
    "keyboard.shortcut.esm_progress": "打开 Supervisor Mode 进度",
    "keyboard.shortcut.preview_image": "预览最近粘贴的图片",
    "keyboard.shortcut.compact_tools": "切换简洁/完整事件显示",
    "keyboard.shortcut.move_history": "在多行输入内移动；边界处浏览历史",
    "keyboard.shortcut.switch_detail_target": "在 Ctrl+O 详情弹窗中切换目标",
    "keyboard.shortcut.page_panel": "翻阅详情或 ESM 进度面板",
    "conversation.cleared": "✅ 会话已清空",
    "compact.running": "Agent 运行中，无法压缩。",
    "compact.empty": "无可压缩内容：当前没有活跃会话。",
    "compact.skipped": "当前会话无法压缩。",
    "compact.done": "✅ 上下文已压缩",
    "skills.unavailable": "没有可用的 Skill 管理器。",
    "skills.empty": "未找到 Skill。",
    "skill.not_found": "未找到 Skill：%s",
    "skill.already_active": "Skill '%s' 已启用。",
    "skill.activated": "✅ 已启用 Skill '%s'（%s）：%s",
    "skill.available_title": "可用 Skill：",
    "alloweditpath.title": "自动编辑路径白名单（agent 模式）：",
    "alloweditpath.already": "已在白名单中：%s",
    "alloweditpath.not_found": "不在白名单中：%s",
    "alloweditpath.saved": "✅ %s自动编辑白名单：%s",
    "alloweditpath.added": "已加入",
    "alloweditpath.removed": "已移除",
    "alloweditpath.cleared": "✅ 自动编辑路径白名单已清空",
    "alloweditpath.save_failed": "保存 allow.json 失败：%v",
    "allowautoedit.status": "自动编辑（agent 模式）：%s",
    "allowautoedit.saved": "✅ 自动编辑（agent 模式）：%s [%s]",
    "delegate.status": "委派模式：%s",
    "delegate.changed": "委派模式：%s",
    "delegate.running": "Agent 运行中，无法切换委派模式。",
    "browser.status": "浏览器工具：%s",
    "browser.running": "Agent 运行中，无法切换浏览器工具。",
    "agent.manager_unavailable": "Agent 管理器未初始化。",
    "agent.disabled": "多 Agent 模式未启用，请使用 --multi-agent 启动。",
    "agent.none": "没有运行中的 Agent。",
    "agent.not_found": "未找到 Agent %s。",
    "agent.focused": "已聚焦 Agent 标签：%s",
    "agent.input_hint": "输入仍发送给主 Agent；后续指令请使用 subagent_send。",
    "agent.cannot_destroy_main": "无法销毁主 Agent",
    "agent.destroyed": "Agent %s 已销毁",
    "agent.destroy_failed": "销毁 Agent %s 失败：%v",
    "sessions.list_title": "会话（%d）：",
    "sessions.no_sessions": "该目录下没有会话。",
    "sessions.switched": "✅ 已切换到会话 %s（%d 条消息）",
    "sessions.cannot_switch_running": "Agent 运行中，无法切换会话。",
    "sessions.already_current": "已在当前会话。",
    "sessions.unsupported_switch": "切换会话在当前版本尚不可用（请求 %s）。",
    "sessions.unknown_subcommand": "未知 sessions 子命令：%s",
    "sessions.error_listing": "列会话失败：%v",
    "sessions.delete_failed": "删除会话失败：%v",
    "sessions.deleted": "✅ 会话 %s 已删除",
    "sessions.cannot_delete_current": "无法删除当前会话",
    "sessions.no_match": "未找到会话：%s",
    "sessions.ambiguous_id": "会话 ID 不唯一：%s",
    "sessions.clear_hint": "将在下一条消息时创建新会话。",
    "mcps.title": "MCP 服务器（%d）：",
    "mcps.empty": "未配置 MCP 服务器。",
    "mcps.entry": "  %s [%s] %s",
    "mcps.enabled": "启用",
    "mcps.disabled": "禁用",
    "init_mcp.created": "✅ 已写入 MCP 配置：%s",
    "init_mcp.exists": "MCP 配置已存在（范围：%s）",
    "init_mcp.failed": "写入 MCP 配置失败：%v",
    "rule.running": "Agent 运行中，无法修改 /rule。",
    "rule.write_failed": "写入规则文件失败：%v",
    "rule.created": "%s规则文件：%s",
    "rule.overwrote": "已覆盖",
    "rule.created_verb": "已创建",
    "rule.loaded": "已载入当前会话。",
    "rule.exists": "规则文件已存在：%s",
    "expert.list_title": "专家（%d）：",
    "expert.empty": "未找到专家。",
    "expert.entry": "  %s（%s）：%s",
    "expert.bound": "✅ 已绑定专家：%s",
    "expert.unbound": "✅ 已解绑专家",
    "expert.not_found": "未找到专家：%s",
    "expert.switch_requires_fork":
      "从 %s 切换到 %s 需要分叉；使用 /expert switch %s 进行分叉。",
    "expert.switched": "✅ 已分叉到会话 %s，专家 %s",
    "env.title": "环境变量（%d）：",
    "env.empty": "未配置额外环境变量。",
    "env.entry": "  %s=%s",
    "env.set": "✅ 已设置 %s",
    "env.unset": "✅ 已移除 %s",
    "env.cleared": "✅ 额外环境变量已清空",
    "env.failed": "更新环境变量失败：%v",
    "env.usage": "用法：/env [list|set KEY VALUE|unset KEY|clear]",
    "statusline.off": "状态栏：关闭（内置页脚）",
    "statusline.on": "状态栏：开启（%s 设置）",
    "statusline.status": "状态栏：%s  refresh=%s  command=%s",
    "statusline.failed": "更新状态栏失败：%v",
    "workflows.list_title": "Workflow 运行（%d）：",
    "workflows.empty": "Workflow 运行：（无）",
    "workflows.entry": "  [%s] %s %s（%s）",
    "workflows.failed": "列出 Workflow 失败：%v",
    "workflows.show_title": "Workflow %s：%s",
    "workflows.show_failed": "加载 Workflow 失败：%v",
    "workflows.name": "名称：%s",
    "workflows.phase": "阶段 [%s] %s 任务数=%d",
    "workflows.error": "错误：%s",
    "clipboard.failed": "读取剪贴板图片失败：%v",
    "clipboard.no_png": "剪贴板中没有 PNG 图片。",
    "clipboard.saved": "✅ 剪贴板图片已保存：%s",
    "commands.mode.description": "切换或显示执行模式（plan/agent/yolo/os）",
    "commands.esm.description": "启用或查看 Supervisor Mode",
    "commands.model.description": "切换或显示模型",
    "commands.default_model.description": "设置默认 Provider/模型",
    "commands.auth.description": "配置 Provider token、Base URL 和模型",
    "commands.settings.description": "配置 settings.json 设置组，包括 Provider",
    "commands.tuilang.description": "设置 TUI 语言（默认全局）",
    "commands.skills.description": "列出可用 Skill",
    "commands.skillhub.description": "浏览、搜索并安装市场 Skill",
    "commands.env.description": "管理额外环境变量",
    "commands.skill.description": "启用 Skill",
    "commands.paste_image.description": "保存剪贴板图片并插入本地路径",
    "commands.clear.description": "清空会话",
    "commands.compact.description": "触发上下文压缩",
    "commands.sessions.description": "列出、切换、新建或删除会话",
    "commands.expert.description": "列出、查看、绑定或通过分叉切换主角人设",
    "commands.init_mcp.description": "初始化 mcp.json",
    "commands.mcps.description": "列出 MCP 服务器",
    "commands.delegate.description": "切换委派模式",
    "commands.browser.description": "切换浏览器自动化工具",
    "commands.stats.description": "管理或显示用量统计",
    "commands.statusline.description": "查看或切换 TUI 状态栏",
    "commands.alloweditpath.description": "管理自动编辑路径白名单",
    "commands.allowautoedit.description": "切换 agent 模式完整自动编辑",
    "commands.btw.description": "提问旁支问题，不影响主任务",
    "commands.systeminit.description": "生成或刷新 AGENTS.md",
    "commands.rule.description": "创建安全的默认项目规则",
    "commands.reload.description": "以新会话重启进程",
    "commands.workflows.description": "查看 Workflow 运行",
    "commands.agent.description": "管理多 Agent 工作器",
    "commands.cron.description": "管理定时任务",
    "commands.quit.description": "退出",
    "commands.help.description": "显示此帮助",
  },
};

/** Immutable Translator, safe to share across TUI components. */
export class Translator {
  #language: Language;

  constructor(language: Language) {
    this.#language = language !== "zh" ? "en" : "zh";
  }

  /** Creates a Translator from the settings value, resolved once. */
  static fromConfig(
    value: string,
    now: () => Date = () => new Date(),
    timeZone: string | null = null,
  ): {
    translator: Translator;
    configured: ConfiguredLanguage;
    valid: boolean;
  } {
    const { configured, valid } = parseConfigured(value);
    return {
      translator: new Translator(resolveLanguage(configured, now(), timeZone)),
      configured,
      valid,
    };
  }

  get language(): Language {
    return this.#language;
  }

  /** Formats a message: zh → en → raw id fallback, then sprintf. */
  text(id: MessageID, ...args: unknown[]): string {
    let text = catalogs[this.#language][id];
    if (text === undefined || text === "") {
      text = catalogs.en[id];
    }
    if (text === undefined || text === "") {
      text = id;
    }
    if (args.length === 0) return text;
    return sprintf(text, args);
  }
}
