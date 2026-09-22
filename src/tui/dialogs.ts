// Concrete interactive dialogs for the Ink TUI, ported from the Go TUI's
// model_dialog.go, default_model_dialog.go, env_dialog.go, commands_session.go
// (sessions dialog), and auth_dialog.go (provider/settings editing).
//
// Every dialog is a real editor: it reads the current configuration, lets the
// user pick and type values, validates them, persists through the shared config
// and session APIs, and applies the change to the live session. None of them is
// a status display.

import { type AllowConfig } from "../config/allow.ts";
import { clearEnv, envList, loadEnv, setEnv, unsetEnv } from "../config/env.ts";
import {
  defaultProviderConfigsAll,
  getProviderConfig,
  isProjectDir,
  loadGlobalSettingsSparse,
  loadProjectSettingsSparse,
  saveGlobalSettings,
  saveGlobalSettingsPatch,
  saveProjectSettings,
  saveProjectSettingsPatch,
  type Settings,
} from "../config/settings.ts";
import {
  create as createProvider,
  providerSortPriority,
  resolvedModels,
  sortProviderIDs,
} from "../provider/factory/factory.ts";
import type {
  Manager as SessionManager,
  SessionDetail,
} from "../session/manager.ts";
import { listForDirDetailed } from "../session/manager.ts";
import {
  Dialog,
  type DialogController,
  type DialogItem,
  type DialogPage,
  formatAge,
} from "./dialog.ts";
import type { Translator } from "./i18n.ts";

/** The session surface a dialog may read and mutate. */
export interface DialogHost {
  readonly translator: Translator;
  readonly settings: Settings;
  readonly workDir: string;
  readonly providerName: string;
  readonly modelID: string;
  readonly allow: AllowConfig;
  /** Session directory holding sessions.db. */
  sessionDir(): string;
  currentSessionID(): string;
  /** Applies a new provider/model binding to the live session. */
  applyModel(providerName: string, modelID: string): void;
  /** Re-reads settings into the live session after an edit. */
  reloadSettings(): void;
  /** Switches to another session and replays it. */
  switchSession(detail: SessionDetail): Promise<void>;
  /** Creates a fresh session for the current work directory. */
  newSession(): Promise<void>;
  /** Deletes a session by exact ID. */
  deleteSession(id: string): Promise<void>;
}

/** Every built-in provider preset plus configured ones, sorted. */
export function providerIDs(settings: Settings): string[] {
  const ids = new Set<string>();
  for (const id of Object.keys(defaultProviderConfigsAll())) ids.add(id);
  for (const id of Object.keys(settings.providers ?? {})) ids.add(id);
  const list = [...ids];
  sortProviderIDs(list);
  return list;
}

// --- /model -----------------------------------------------------------------

/** The `/model` switcher: filter and select a model ID. */
export class ModelDialog implements DialogController {
  #host: DialogHost;
  #dialog: Dialog;

  constructor(host: DialogHost, dialog: Dialog) {
    this.#host = host;
    this.#dialog = dialog;
  }

  page(): DialogPage {
    const ids = resolvedModels(this.#host.settings, this.#host.providerName)
      .map((m) => m.id);
    return {
      title: this.#host.translator.text("dialog.model.title"),
      search: true,
      items: ids.map((id) => ({
        label: id,
        value: id,
        current: id === this.#host.modelID,
      })),
      hint: this.#host.translator.text("dialog.model.hint"),
    };
  }

  select(value: string): void {
    const tr = this.#host.translator;
    const model = this.#host.settings.providers?.[this.#host.providerName]
      ?.models.find((m) => m.id === value);
    this.#host.applyModel(this.#host.providerName, value);
    this.#dialog.close(
      tr.text(
        "commands.model.switched",
        model?.name ?? value,
        value,
      ),
    );
  }

  submit(): void {}
  key(): void {}

  back(): void {
    this.#dialog.close();
  }
}

// --- /defaultModel ----------------------------------------------------------

/** The `/defaultModel` two-step picker: provider, then model, then persist. */
export class DefaultModelDialog implements DialogController {
  #host: DialogHost;
  #dialog: Dialog;
  #scope: string;
  #view: "provider" | "model" = "provider";
  #providerID = "";
  #error = "";

  constructor(host: DialogHost, dialog: Dialog, scope: string) {
    this.#host = host;
    this.#dialog = dialog;
    this.#scope = scope === "project" ? "project" : "global";
  }

  page(): DialogPage {
    const tr = this.#host.translator;
    const settings = this.#host.settings;
    if (this.#view === "provider") {
      return {
        title: tr.text("dialog.default_model.title", this.#scope),
        search: true,
        items: providerIDs(settings).map((id) => ({
          label: id,
          description: this.#providerDescription(id),
          value: id,
          current: id === settings.defaultProvider,
        })),
        hint: tr.text("dialog.default_model.provider_hint"),
        error: this.#error,
      };
    }
    const models = resolvedModels(settings, this.#providerID).map((m) => m.id);
    return {
      title: `${
        tr.text("dialog.default_model.title", this.#scope)
      } · ${this.#providerID}`,
      search: true,
      items: models.map((id) => ({
        label: id,
        value: id,
        current: id === settings.defaultModel,
      })),
      hint: tr.text("dialog.default_model.model_hint"),
      error: this.#error,
    };
  }

  #providerDescription(id: string): string {
    const pc = getProviderConfig(this.#host.settings, id);
    if (pc === undefined) return "";
    return `${pc.api ?? "openai-chat"} · ${
      pc.baseUrl ?? ""
    } · ${pc.models.length} models`;
  }

  select(value: string): void {
    if (this.#view === "provider") {
      this.#providerID = value;
      this.#view = "model";
      this.#error = "";
      this.#dialog.resetCursor();
      return;
    }
    this.#save(value);
  }

  #save(modelID: string): void {
    const tr = this.#host.translator;
    // Validate the pair through the shared factory before persisting.
    try {
      createProvider(
        {
          ...this.#host.settings,
          defaultProvider: this.#providerID,
          defaultModel: modelID,
        },
        this.#providerID,
        modelID,
      );
    } catch (err) {
      this.#error = tr.text(
        "dialog.default_model.validation_failed",
        (err as Error).message,
      );
      return;
    }
    try {
      const sparse = this.#scope === "global"
        ? loadGlobalSettingsSparse()
        : loadProjectSettingsSparse();
      sparse.defaultProvider = this.#providerID;
      sparse.defaultModel = modelID;
      if (this.#scope === "global") saveGlobalSettings(sparse);
      else saveProjectSettings(sparse);
    } catch (err) {
      this.#error = tr.text(
        "dialog.default_model.save_failed",
        (err as Error).message,
      );
      return;
    }
    this.#host.applyModel(this.#providerID, modelID);
    this.#dialog.close(
      tr.text(
        "dialog.default_model.saved",
        this.#scope,
        this.#providerID,
        modelID,
      ),
    );
  }

  submit(): void {}
  key(): void {}

  back(): void {
    if (this.#view === "model") {
      this.#view = "provider";
      this.#error = "";
      this.#dialog.resetCursor();
      return;
    }
    this.#dialog.close();
  }
}

// --- /env -------------------------------------------------------------------

/** The `/env` editor: add, edit, and delete environment variables. */
export class EnvDialog implements DialogController {
  #host: DialogHost;
  #dialog: Dialog;
  #vars: Record<string, string>;
  #error = "";
  #editing = "";
  #editKind: "key" | "value" | "" = "";
  /** Index of the trailing "+ Add Variable" row. */
  #addIndex = 0;
  #doneIndex = 0;

  constructor(host: DialogHost, dialog: Dialog) {
    this.#host = host;
    this.#dialog = dialog;
    this.#vars = envList(loadEnv());
  }

  #keys(): string[] {
    return Object.keys(this.#vars).sort();
  }

  page(): DialogPage {
    const tr = this.#host.translator;
    const keys = this.#keys();
    this.#addIndex = keys.length;
    this.#doneIndex = keys.length + 1;
    const items: DialogItem[] = keys.map((key) => ({
      label: `${key} = ${this.#vars[key]}`,
      value: `var:${key}`,
    }));
    items.push({ label: tr.text("dialog.env.add"), value: "add" });
    items.push({ label: tr.text("dialog.env.done"), value: "done" });
    const input = this.#dialog.inputActive
      ? {
        prompt: this.#editKind === "key"
          ? tr.text("dialog.env.prompt_key")
          : tr.text("dialog.env.prompt_value", this.#editing),
        value: this.#dialog.inputValue,
        placeholder: tr.text(
          this.#editKind === "key"
            ? "dialog.env.placeholder_key"
            : "dialog.env.placeholder_value",
        ),
      }
      : undefined;
    return {
      title: tr.text("dialog.env.title"),
      items,
      input,
      hint: this.#dialog.inputActive
        ? tr.text("dialog.env.input_hint")
        : tr.text("dialog.env.hint"),
      error: this.#error,
    };
  }

  select(value: string): void {
    if (value.startsWith("var:")) {
      const key = value.slice("var:".length);
      this.#editing = key;
      this.#editKind = "value";
      this.#dialog.openInput(this.#vars[key] ?? "");
      return;
    }
    if (value === "add") {
      this.#editing = "";
      this.#editKind = "key";
      this.#dialog.openInput("");
      return;
    }
    // "done": persist the whole set.
    try {
      const current = loadEnv();
      const existing = envList(current);
      for (const key of Object.keys(existing)) {
        if (!(key in this.#vars)) unsetEnv(current, key);
      }
      for (const [key, val] of Object.entries(this.#vars)) {
        setEnv(current, key, val);
      }
      if (Object.keys(this.#vars).length === 0) clearEnv(current);
    } catch (err) {
      this.#error = this.#host.translator.text(
        "dialog.env.save_failed",
        (err as Error).message,
      );
      return;
    }
    this.#dialog.close(this.#host.translator.text("env.cleared"));
  }

  submit(value: string): void {
    const tr = this.#host.translator;
    if (this.#editKind === "key") {
      const key = value.trim();
      // deno-lint-ignore no-control-regex
      if (key === "" || /[=\u0000\r\n]/.test(key)) {
        this.#error = tr.text("dialog.env.invalid_name");
        return;
      }
      this.#vars[key] = "";
      this.#editing = key;
      this.#editKind = "value";
      this.#error = "";
      this.#dialog.openInput("");
      return;
    }
    this.#vars[this.#editing] = value;
    this.#editing = "";
    this.#editKind = "";
    this.#error = "";
    this.#dialog.closeInput();
  }

  key(): void {}

  back(): void {
    if (this.#dialog.inputActive) {
      this.#dialog.closeInput();
      this.#editKind = "";
      return;
    }
    this.#dialog.close();
  }
}

// --- /sessions --------------------------------------------------------------

/** The `/sessions` browser: switch, create, or delete sessions. */
export class SessionsDialog implements DialogController {
  #host: DialogHost;
  #dialog: Dialog;
  #items: SessionDetail[];
  #error = "";
  #message = "";

  constructor(host: DialogHost, dialog: Dialog) {
    this.#host = host;
    this.#dialog = dialog;
    this.#items = listForDirDetailed(host.workDir, host.sessionDir());
  }

  page(): DialogPage {
    const tr = this.#host.translator;
    const currentID = this.#host.currentSessionID();
    const now = new Date();
    const items: DialogItem[] = this.#items.map((detail) => {
      const preview = detail.preview.trim().replace(/\s+/g, " ");
      return {
        label: `${detail.id}  ${detail.messageCount} msgs  ${
          formatAge(detail.modTime, now, tr)
        }${preview === "" ? "" : `  ${preview}`}`,
        value: `session:${detail.id}`,
        current: detail.id === currentID,
      };
    });
    return {
      title: tr.text("dialog.sessions.title"),
      body: [tr.text("dialog.sessions.cwd", this.#host.workDir)],
      items,
      hint: tr.text("dialog.sessions.hint"),
      error: this.#error !== "" ? this.#error : this.#message,
    };
  }

  select(value: string): void {
    void this.#switchTo(value.slice("session:".length));
  }

  async #switchTo(id: string): Promise<void> {
    const tr = this.#host.translator;
    const detail = this.#items.find((d) => d.id === id);
    if (detail === undefined) {
      this.#error = tr.text("sessions.no_match", id);
      return;
    }
    if (id === this.#host.currentSessionID()) {
      this.#dialog.close(tr.text("sessions.already_current"));
      return;
    }
    try {
      await this.#host.switchSession(detail);
      this.#dialog.close(
        tr.text("sessions.switched", detail.id, detail.messageCount),
      );
    } catch (err) {
      this.#error = tr.text("sessions.error_listing", (err as Error).message);
    }
  }

  submit(): void {}

  key(name: string): void {
    switch (name.toLowerCase()) {
      case "q":
        this.#dialog.close();
        return;
      case "n":
        void this.#newSession();
        return;
      case "d":
        void this.#deleteSelected();
        return;
      default:
        return;
    }
  }

  async #newSession(): Promise<void> {
    const tr = this.#host.translator;
    try {
      await this.#host.newSession();
      this.#dialog.close(tr.text("sessions.clear_hint"));
    } catch (err) {
      this.#error = tr.text("sessions.error_listing", (err as Error).message);
    }
  }

  async #deleteSelected(): Promise<void> {
    const tr = this.#host.translator;
    const detail = this.#items[this.#dialog.cursor];
    if (detail === undefined) return;
    if (detail.id === this.#host.currentSessionID()) {
      this.#error = tr.text("sessions.cannot_delete_current");
      return;
    }
    try {
      await this.#host.deleteSession(detail.id);
      this.#items = this.#items.filter((d) => d.id !== detail.id);
      this.#message = tr.text("sessions.deleted", detail.id);
      this.#error = "";
      this.#dialog.resetCursor();
    } catch (err) {
      this.#error = tr.text("sessions.delete_failed", (err as Error).message);
    }
  }

  back(): void {
    this.#dialog.close();
  }
}

// --- /auth ------------------------------------------------------------------

import { AuthDialog as StructuredAuthDialog } from "./auth_dialog.ts";

/**
 * Adapter bridging the generic {@link Dialog} panel (DialogController) to the
 * structured /auth editor. All navigation, drafts, and persistence are owned
 * by StructuredAuthDialog; this class only maps the panel protocol.
 */
export class AuthDialog implements DialogController {
  #auth: StructuredAuthDialog;

  constructor(host: DialogHost, dialog: Dialog, initialProvider = "") {
    this.#auth = new StructuredAuthDialog(host, dialog, initialProvider);
  }

  page(): DialogPage {
    return this.#auth.page();
  }

  select(value: string): void {
    this.#auth.select(value);
  }

  submit(value: string): void {
    this.#auth.submit(value);
  }

  key(name: string): void {
    this.#auth.key(name);
  }

  back(): void {
    this.#auth.back();
  }
}

// --- /settings --------------------------------------------------------------

/** The second-level settings category views (Go authViewSettings*). */
type SettingsView =
  | "root"
  | "defaults"
  | "behavior"
  | "webSearch"
  | "contextFiles"
  | "statusLine"
  | "compaction"
  | "sandbox"
  | "paths"
  | "retry"
  | "approval";

/** Cycle lists for enum-like fields (Go cycleString lists). */
const SETTINGS_CYCLES: Record<string, { values: string[]; def: string }> = {
  defaultThinkingLevel: {
    values: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    def: "medium",
  },
  defaultMode: { values: ["plan", "agent", "yolo", "os"], def: "yolo" },
  "sandbox.level": {
    values: ["none", "standard", "strict"],
    def: "none",
  },
};

/** Fields edited through the single-line input box (Go authSettingsInputPrompt). */

/**
 * The `/settings` browser: a full category tree with second- and third-level
 * fields, mirroring the Go auth settings dialog (auth_settings_top.go). Each
 * row shows the current effective value; Enter cycles enums, flips switches,
 * opens the text input for free-form fields, or hands off to another dialog
 * (providers → /auth, defaults → the model picker). All changes persist to the
 * global settings through the shared config API and reload the live session.
 */
export class SettingsDialog implements DialogController {
  #host: DialogHost;
  #dialog: Dialog;
  #view: SettingsView = "root";
  #field = "";
  #tuiScope: "global" | "project" = "global";
  #error = "";

  constructor(host: DialogHost, dialog: Dialog) {
    this.#host = host;
    this.#dialog = dialog;
  }

  // --- Page rendering -------------------------------------------------------

  page(): DialogPage {
    return this.#withInput(this.#rawPage());
  }

  #rawPage(): DialogPage {
    const tr = this.#host.translator;
    const s = this.#host.settings;
    switch (this.#view) {
      case "root":
        return this.#rootPage();
      case "defaults":
        return {
          title: tr.text("settings.category.defaults"),
          items: [
            {
              label: tr.text("settings.field.default_model"),
              description: `${this.#value(s.defaultProvider)} / ${
                this.#value(s.defaultModel)
              }`,
              value: "defaults.modelPicker",
            },
            this.#item(
              "defaultThinkingLevel",
              tr.text("settings.field.default_thinking"),
              this.#value(s.defaultThinkingLevel ?? "medium"),
            ),
            this.#item(
              "defaultMode",
              tr.text("settings.field.default_mode"),
              this.#value(s.defaultMode ?? "yolo"),
            ),
            this.#doneItem(),
          ],
          hint: tr.text("dialog.settings.hint"),
          error: this.#error,
        };
      case "behavior":
        return {
          title: tr.text("settings.category.behavior"),
          items: [
            this.#inputItem(
              "theme",
              tr.text("settings.field.theme"),
              this.#value(s.theme ?? "dark"),
            ),
            this.#item(
              "enablePlanTool",
              tr.text("settings.field.enable_plan_tool"),
              this.#boolPtrSummary(s.enablePlanTool, true),
            ),
            this.#item(
              "enableArtifact",
              tr.text("settings.field.enable_artifact"),
              this.#boolPtrSummary(s.enableArtifact, false),
            ),
            this.#item(
              "authored",
              tr.text("settings.field.authored"),
              this.#yesNo(s.authored === true),
            ),
            this.#inputItem(
              "maxContextTokens",
              tr.text("settings.field.max_context_tokens"),
              s.maxContextTokens
                ? `${s.maxContextTokens}`
                : tr.text("settings.value.unset"),
            ),
            this.#item(
              "updateCheck",
              tr.text("settings.field.update_check"),
              this.#boolPtrSummary(s.updateCheck, true),
            ),
            this.#item(
              "toolExecution.mode",
              tr.text("settings.field.tool_execution_mode"),
              this.#toolExecutionMode(),
            ),
            this.#inputItem(
              "toolExecution.maxConcurrency",
              tr.text("settings.field.tool_max_concurrency"),
              `${this.#toolExecutionMaxConcurrency()}`,
            ),
            this.#doneItem(),
          ],
          hint: tr.text("dialog.settings.hint"),
          error: this.#error,
        };
      case "webSearch":
        return {
          title: tr.text("settings.category.web_search"),
          items: [
            this.#item(
              "webSearch.enabled",
              tr.text("settings.label.enabled"),
              this.#boolPtrSummary(s.webSearch?.enabled, false),
            ),
            this.#inputItem(
              "webSearch.provider",
              tr.text("settings.field.provider"),
              this.#value(s.webSearch?.provider ?? "openai"),
            ),
            this.#inputItem(
              "webSearch.providerType",
              tr.text("settings.field.provider_type"),
              this.#value(s.webSearch?.providerType ?? "responses"),
            ),
            this.#inputItem(
              "webSearch.model",
              tr.text("settings.field.model"),
              this.#value(s.webSearch?.model ?? ""),
            ),
            this.#item(
              "imageGeneration.enabled",
              tr.text("settings.field.image_generation_enabled"),
              this.#boolPtrSummary(s.imageGeneration?.enabled, false),
            ),
            this.#inputItem(
              "imageGeneration.provider",
              tr.text("settings.field.image_generation_provider"),
              this.#value(s.imageGeneration?.provider ?? "openai"),
            ),
            this.#inputItem(
              "imageGeneration.apiType",
              tr.text("settings.field.image_generation_api_type"),
              this.#value(s.imageGeneration?.apiType ?? "openai-images"),
            ),
            this.#inputItem(
              "imageGeneration.baseUrl",
              tr.text("settings.field.image_generation_base_url"),
              this.#value(s.imageGeneration?.baseUrl ?? ""),
            ),
            this.#inputItem(
              "imageGeneration.token",
              tr.text("settings.field.image_generation_token"),
              tr.text("settings.value.hidden"),
            ),
            this.#inputItem(
              "imageGeneration.model",
              tr.text("settings.field.image_generation_model"),
              this.#value(s.imageGeneration?.model ?? "gpt-image-1"),
            ),
            this.#doneItem(),
          ],
          hint: tr.text("dialog.settings.hint"),
          error: this.#error,
        };
      case "contextFiles":
        return {
          title: tr.text("settings.category.context_files"),
          items: [
            this.#item(
              "contextFiles.enabled",
              tr.text("settings.label.enabled"),
              this.#yesNo(s.contextFiles?.enabled === true),
            ),
            this.#inputItem(
              "contextFiles.extraFiles",
              tr.text("settings.field.extra_files"),
              this.#listSummary(s.contextFiles?.extraFiles),
            ),
            this.#doneItem(),
          ],
          hint: tr.text("dialog.settings.hint"),
          error: this.#error,
        };
      case "statusLine":
        return {
          title: tr.text("settings.category.status_line"),
          items: [
            this.#item(
              "statusLine.enabled",
              tr.text("settings.label.enabled"),
              this.#yesNo(s.statusLine?.enabled === true),
            ),
            this.#inputItem(
              "statusLine.type",
              tr.text("settings.label.type"),
              this.#value(s.statusLine?.type ?? "command"),
            ),
            this.#inputItem(
              "statusLine.command",
              tr.text("settings.label.command"),
              this.#value(s.statusLine?.command ?? "ccstatusline"),
            ),
            this.#inputItem(
              "statusLine.padding",
              tr.text("settings.label.padding"),
              `${s.statusLine?.padding ?? 0}`,
            ),
            this.#inputItem(
              "statusLine.refreshInterval",
              tr.text("settings.label.refresh_interval"),
              `${s.statusLine?.refreshInterval ?? 0}s`,
            ),
            this.#inputItem(
              "statusLine.timeoutMs",
              tr.text("settings.label.timeout"),
              `${s.statusLine?.timeoutMs ?? 800}ms`,
            ),
            this.#inputItem(
              "statusLine.fallback",
              tr.text("settings.label.fallback"),
              this.#value(s.statusLine?.fallback ?? "builtin"),
            ),
            this.#doneItem(),
          ],
          hint: tr.text("dialog.settings.hint"),
          error: this.#error,
        };
      case "compaction":
        return {
          title: tr.text("settings.category.compaction"),
          items: [
            this.#item(
              "compaction.enabled",
              tr.text("settings.label.enabled"),
              this.#yesNo(s.compaction?.enabled === true),
            ),
            this.#inputItem(
              "compaction.reserveTokens",
              tr.text("settings.field.reserve_tokens"),
              `${s.compaction?.reserveTokens ?? 0}`,
            ),
            this.#inputItem(
              "compaction.keepRecentTokens",
              tr.text("settings.field.keep_recent_tokens"),
              `${s.compaction?.keepRecentTokens ?? 0}`,
            ),
            this.#inputItem(
              "compaction.tokenizer",
              tr.text("settings.field.tokenizer"),
              this.#value(s.compaction?.tokenizer ?? "") ||
                tr.text("settings.value.auto"),
            ),
            this.#inputItem(
              "compaction.tokenizerModel",
              tr.text("settings.field.tokenizer_model"),
              this.#value(s.compaction?.tokenizerModel ?? "") ||
                tr.text("settings.value.auto"),
            ),
            this.#inputItem(
              "compaction.template",
              tr.text("settings.field.template"),
              this.#value(s.compaction?.template ?? ""),
            ),
            this.#doneItem(),
          ],
          hint: tr.text("dialog.settings.hint"),
          error: this.#error,
        };
      case "sandbox":
        return {
          title: tr.text("settings.category.sandbox"),
          items: [
            this.#item(
              "sandbox.enabled",
              tr.text("settings.label.enabled"),
              this.#yesNo(s.sandbox?.enabled === true),
            ),
            this.#item(
              "sandbox.level",
              tr.text("settings.field.level"),
              this.#value(s.sandbox?.level ?? "none"),
            ),
            this.#inputItem(
              "sandbox.bwrapPath",
              tr.text("settings.field.bwrap_path"),
              this.#value(s.sandbox?.bwrapPath ?? "") ||
                tr.text("settings.value.auto"),
            ),
            this.#inputItem(
              "sandbox.allowedRead",
              tr.text("settings.field.allowed_read"),
              this.#listSummary(s.sandbox?.allowedRead),
            ),
            this.#inputItem(
              "sandbox.allowedWrite",
              tr.text("settings.field.allowed_write"),
              this.#listSummary(s.sandbox?.allowedWrite),
            ),
            this.#inputItem(
              "sandbox.deniedPaths",
              tr.text("settings.field.denied_paths"),
              this.#listSummary(s.sandbox?.deniedPaths),
            ),
            this.#inputItem(
              "sandbox.passEnv",
              tr.text("settings.field.pass_env"),
              this.#listSummary(s.sandbox?.passEnv),
            ),
            this.#inputItem(
              "sandbox.tmpSize",
              tr.text("settings.field.tmp_size"),
              this.#value(s.sandbox?.tmpSize ?? "100m"),
            ),
            this.#doneItem(),
          ],
          hint: tr.text("dialog.settings.hint"),
          error: this.#error,
        };
      case "paths":
        return {
          title: tr.text("settings.category.paths"),
          items: [
            this.#inputItem(
              "sessionDir",
              tr.text("settings.field.session_dir"),
              this.#value(s.sessionDir ?? ""),
            ),
            this.#inputItem(
              "skillsDir",
              tr.text("settings.field.skills_dir"),
              this.#value(s.skillsDir ?? ""),
            ),
            this.#inputItem(
              "shellPath",
              tr.text("settings.field.shell_path"),
              this.#value(s.shellPath ?? "") ||
                tr.text("settings.value.default_shell"),
            ),
            this.#inputItem(
              "shellCommandPrefix",
              tr.text("settings.field.shell_command_prefix"),
              this.#value(s.shellCommandPrefix ?? "") ||
                tr.text("settings.value.none"),
            ),
            this.#doneItem(),
          ],
          hint: tr.text("dialog.settings.hint"),
          error: this.#error,
        };
      case "retry":
        return {
          title: tr.text("settings.category.retry"),
          items: [
            this.#item(
              "retry.enabled",
              tr.text("settings.label.enabled"),
              this.#yesNo(s.retry?.enabled === true),
            ),
            this.#inputItem(
              "retry.maxRetries",
              tr.text("settings.field.max_retries"),
              `${s.retry?.maxRetries ?? 0}`,
            ),
            this.#inputItem(
              "retry.baseDelayMs",
              tr.text("settings.field.base_delay"),
              `${s.retry?.baseDelayMs ?? 0}ms`,
            ),
            this.#doneItem(),
          ],
          hint: tr.text("dialog.settings.hint"),
          error: this.#error,
        };
      case "approval":
        return {
          title: tr.text("settings.category.approval"),
          items: [
            this.#item(
              "approval.confirmBeforeWrite",
              tr.text("settings.field.confirm_before_write"),
              this.#boolPtrSummary(s.approval?.confirmBeforeWrite, true),
            ),
            this.#inputItem(
              "approval.bashWhitelist",
              tr.text("settings.field.bash_whitelist"),
              this.#listSummary(s.approval?.bashWhitelist),
            ),
            this.#inputItem(
              "approval.bashBlacklist",
              tr.text("settings.field.bash_blacklist"),
              this.#listSummary(s.approval?.bashBlacklist),
            ),
            this.#doneItem(),
          ],
          hint: tr.text("dialog.settings.hint"),
          error: this.#error,
        };
    }
  }

  #rootPage(): DialogPage {
    const tr = this.#host.translator;
    const s = this.#host.settings;
    const providers = Object.keys(s.providers ?? {});
    return {
      title: tr.text("dialog.settings.title"),
      items: [
        {
          label: tr.text("settings.category.providers"),
          description: tr.text(
            "settings.summary.providers",
            providers.length,
            this.#value(s.defaultProvider),
            this.#value(s.defaultModel),
          ),
          value: "providers",
        },
        {
          label: tr.text("settings.category.defaults"),
          description: tr.text(
            "settings.summary.defaults",
            this.#value(s.defaultMode ?? "yolo"),
            this.#value(s.defaultThinkingLevel ?? "medium"),
          ),
          value: "defaults",
        },
        {
          label: tr.text("settings.category.behavior"),
          description: tr.text(
            "settings.summary.behavior",
            this.#value(s.theme ?? "dark"),
            this.#boolPtrSummary(s.enablePlanTool, true),
          ),
          value: "behavior",
        },
        {
          label: tr.text("settings.category.web_search"),
          description: tr.text(
            "settings.summary.web_search",
            this.#boolPtrSummary(s.webSearch?.enabled, false),
            this.#value(s.webSearch?.provider ?? "openai"),
          ),
          value: "webSearch",
        },
        {
          label: tr.text("settings.category.context_files"),
          description: tr.text(
            "settings.summary.context_files",
            this.#yesNo(s.contextFiles?.enabled === true),
            (s.contextFiles?.extraFiles ?? []).length,
          ),
          value: "contextFiles",
        },
        {
          label: tr.text("settings.category.status_line"),
          description: tr.text(
            "settings.summary.status_line",
            this.#yesNo(s.statusLine?.enabled === true),
            this.#value(s.statusLine?.type ?? "command"),
          ),
          value: "statusLine",
        },
        {
          label: tr.text("settings.category.compaction"),
          description: tr.text(
            "settings.summary.compaction",
            this.#yesNo(s.compaction?.enabled === true),
            `${s.compaction?.reserveTokens ?? 0}`,
            `${s.compaction?.keepRecentTokens ?? 0}`,
          ),
          value: "compaction",
        },
        {
          label: tr.text("settings.category.sandbox"),
          description: tr.text(
            "settings.summary.sandbox",
            this.#yesNo(s.sandbox?.enabled === true),
            this.#value(s.sandbox?.level ?? "none"),
          ),
          value: "sandbox",
        },
        {
          label: tr.text("settings.category.paths"),
          description: tr.text(
            "settings.summary.paths",
            this.#value(s.sessionDir ?? ""),
          ),
          value: "paths",
        },
        {
          label: tr.text("settings.category.retry"),
          description: tr.text(
            "settings.summary.retry",
            this.#yesNo(s.retry?.enabled === true),
            s.retry?.maxRetries ?? 0,
            s.retry?.baseDelayMs ?? 0,
          ),
          value: "retry",
        },
        {
          label: tr.text("settings.category.approval"),
          description: tr.text(
            "settings.summary.approval",
            this.#boolPtrSummary(s.approval?.confirmBeforeWrite, true),
            (s.approval?.bashWhitelist ?? []).length,
            (s.approval?.bashBlacklist ?? []).length,
          ),
          value: "approval",
        },
        {
          label: tr.text("settings.language"),
          description: tr.text(
            "settings.language.description",
            this.#value(s.tuilang ?? "auto"),
            tr.language,
            this.#value(s.tuilang ?? "auto"),
            this.#tuiScope,
          ),
          value: "tuilang",
        },
        {
          label: tr.text("settings.language.scope"),
          description: tr.text(
            "settings.language.scope.description",
            this.#tuiScope,
          ),
          value: "tuilang.scope",
        },
        {
          label: tr.text("settings.language.save"),
          description: tr.text("settings.language.save.description"),
          value: "tuilang.save",
        },
      ],
      hint: tr.text("dialog.settings.hint"),
      error: this.#error,
    };
  }

  // --- Row helpers -----------------------------------------------------------

  /** Adds the input box to a page while a field is being edited. */
  #withInput(page: DialogPage): DialogPage {
    if (this.#field === "") return page;
    const tr = this.#host.translator;
    const prompt = this.#inputPrompt(this.#field);
    return {
      ...page,
      input: {
        prompt: tr.text(prompt),
        value: this.#dialog.inputActive
          ? this.#dialog.inputValue
          : this.#inputValue(this.#field),
        placeholder: "",
        masked: this.#field === "imageGeneration.token",
      },
    };
  }

  /** The input prompt message id for a field (Go authSettingsInputPrompt). */
  #inputPrompt(field: string): string {
    switch (field) {
      case "theme":
        return "settings.prompt.theme";
      case "maxContextTokens":
        return "settings.prompt.max_context_tokens";
      case "webSearch.provider":
        return "settings.prompt.web_provider";
      case "webSearch.providerType":
        return "settings.prompt.web_provider_type";
      case "webSearch.model":
        return "settings.prompt.web_model";
      case "toolExecution.maxConcurrency":
        return "settings.prompt.tool_max_concurrency";
      case "imageGeneration.provider":
        return "settings.prompt.image_provider";
      case "imageGeneration.apiType":
        return "settings.prompt.image_api_type";
      case "imageGeneration.baseUrl":
        return "settings.prompt.image_base_url";
      case "imageGeneration.token":
        return "settings.prompt.image_token";
      case "imageGeneration.model":
        return "settings.prompt.image_model";
      case "contextFiles.extraFiles":
        return "settings.prompt.extra_files";
      case "statusLine.type":
        return "settings.prompt.status_line_type";
      case "statusLine.command":
        return "settings.prompt.status_line_command";
      case "statusLine.padding":
        return "settings.prompt.status_line_padding";
      case "statusLine.refreshInterval":
        return "settings.prompt.refresh_interval";
      case "statusLine.timeoutMs":
        return "settings.prompt.timeout_ms";
      case "statusLine.fallback":
        return "settings.prompt.status_line_fallback";
      case "compaction.reserveTokens":
        return "settings.prompt.reserve_tokens";
      case "compaction.keepRecentTokens":
        return "settings.prompt.keep_recent_tokens";
      case "compaction.tokenizer":
        return "settings.prompt.tokenizer";
      case "compaction.tokenizerModel":
        return "settings.prompt.tokenizer_model";
      case "compaction.template":
        return "settings.prompt.template";
      case "sandbox.bwrapPath":
        return "settings.prompt.bwrap_path";
      case "sandbox.allowedRead":
      case "sandbox.allowedWrite":
      case "sandbox.deniedPaths":
      case "sandbox.passEnv":
        return "settings.prompt.list_values";
      case "sandbox.tmpSize":
        return "settings.prompt.tmp_size";
      case "sessionDir":
        return "settings.prompt.session_dir";
      case "skillsDir":
        return "settings.prompt.skills_dir";
      case "shellPath":
        return "settings.prompt.shell_path";
      case "shellCommandPrefix":
        return "settings.prompt.shell_prefix";
      case "retry.maxRetries":
        return "settings.prompt.max_retries";
      case "retry.baseDelayMs":
        return "settings.prompt.base_delay";
      case "approval.bashWhitelist":
      case "approval.bashBlacklist":
        return "settings.prompt.approval_prefixes";
      default:
        return "settings.prompt.list_values";
    }
  }

  #item(field: string, label: string, description: string): DialogItem {
    return { label, description, value: field };
  }

  #inputItem(
    field: string,
    label: string,
    description: string,
  ): DialogItem {
    return { label, description, value: `input:${field}` };
  }

  #doneItem(): DialogItem {
    return {
      label: this.#host.translator.text("settings.done"),
      description: this.#host.translator.text("settings.return"),
      value: "done",
    };
  }

  #value(v: string | undefined): string {
    const tr = this.#host.translator;
    const t = (v ?? "").trim();
    if (t === "") return tr.text("settings.value.unset");
    return t;
  }

  #yesNo(v: boolean): string {
    return this.#host.translator.text(
      v ? "settings.value.yes" : "settings.value.no",
    );
  }

  #boolPtrSummary(v: boolean | undefined, def: boolean): string {
    const tr = this.#host.translator;
    if (v === undefined) {
      return tr.text(
        def ? "settings.value.auto_enabled" : "settings.value.auto_disabled",
      );
    }
    return tr.text(v ? "settings.value.enabled" : "settings.value.disabled");
  }

  #listSummary(values: string[] | undefined): string {
    const tr = this.#host.translator;
    const list = (values ?? []).filter((v) => v.trim() !== "");
    if (list.length === 0) return tr.text("settings.value.empty");
    if (list.length === 1) return this.#value(list[0]);
    return `${list.length} entries`;
  }

  #toolExecutionMode(): string {
    const te = this.#host.settings.toolExecution;
    return this.#value(te?.mode ?? "parallel");
  }

  #toolExecutionMaxConcurrency(): number {
    return this.#host.settings.toolExecution?.maxConcurrency ?? 10;
  }

  // --- Selection -------------------------------------------------------------

  select(value: string): void {
    this.#error = "";
    if (value === "done") {
      this.back();
      return;
    }
    if (value === "providers") {
      this.#dialog.close(undefined, false, "auth");
      return;
    }
    if (value === "defaults.modelPicker") {
      this.#dialog.close(undefined, false, "defaultModel");
      return;
    }
    if (value === "tuilang.scope") {
      this.#cycleTuiScope();
      return;
    }
    if (value === "tuilang.save") {
      this.#saveTuiLang();
      return;
    }
    if (value.startsWith("input:")) {
      const field = value.slice("input:".length);
      this.#field = field;
      this.#dialog.openInput(this.#inputValue(field));
      return;
    }
    // Category entry.
    if (this.#isView(value)) {
      this.#view = value;
      this.#dialog.resetCursor();
      return;
    }
    if (value === "tuilang") {
      this.#cycleTuiLang();
      return;
    }
    if (SETTINGS_CYCLES[value] !== undefined) {
      this.#cycleField(value);
      return;
    }
    if (value === "enablePlanTool") {
      this.#cycleOptionalBool("enablePlanTool", true);
      return;
    }
    if (value === "enableArtifact") {
      this.#cycleOptionalBool("enableArtifact", false);
      return;
    }
    if (value === "updateCheck") {
      this.#cycleOptionalBool("updateCheck", true);
      return;
    }
    if (value === "webSearch.enabled") {
      this.#cycleOptionalBool("webSearch.enabled", false);
      return;
    }
    if (value === "imageGeneration.enabled") {
      this.#cycleOptionalBool("imageGeneration.enabled", false);
      return;
    }
    if (value === "approval.confirmBeforeWrite") {
      this.#cycleOptionalBool("approval.confirmBeforeWrite", true);
      return;
    }
    // Plain booleans: flip and save.
    switch (value) {
      case "authored":
        this.#save({ authored: this.#host.settings.authored !== true });
        return;
      case "contextFiles.enabled":
        this.#save({
          contextFiles: {
            ...(this.#host.settings.contextFiles ?? { enabled: false }),
            enabled: this.#host.settings.contextFiles?.enabled !== true,
          },
        });
        return;
      case "statusLine.enabled": {
        const next = {
          ...(this.#host.settings.statusLine ?? {}),
          enabled: this.#host.settings.statusLine?.enabled !== true,
        };
        if (next.enabled) this.#normalizeStatusLine(next);
        this.#save({ statusLine: next });
        return;
      }
      case "compaction.enabled":
        this.#save({
          compaction: {
            ...(this.#host.settings.compaction ??
              { enabled: false, reserveTokens: 0, keepRecentTokens: 0 }),
            enabled: this.#host.settings.compaction?.enabled !== true,
          },
        });
        return;
      case "sandbox.enabled":
        this.#save({
          sandbox: {
            ...(this.#host.settings.sandbox ??
              { enabled: false, level: "none", allowNetwork: false }),
            enabled: this.#host.settings.sandbox?.enabled !== true,
          },
        });
        return;
      case "retry.enabled":
        this.#save({
          retry: {
            ...(this.#host.settings.retry ??
              { enabled: false, maxRetries: 0, baseDelayMs: 0 }),
            enabled: this.#host.settings.retry?.enabled !== true,
          },
        });
        return;
      default:
        return;
    }
  }

  #isView(value: string): value is SettingsView {
    return [
      "defaults",
      "behavior",
      "webSearch",
      "contextFiles",
      "statusLine",
      "compaction",
      "sandbox",
      "paths",
      "retry",
      "approval",
    ].includes(value);
  }

  // --- Cycle / toggle helpers ------------------------------------------------

  #cycleField(field: string): void {
    const spec = SETTINGS_CYCLES[field];
    if (spec === undefined) return;
    const current = this.#readField(field) ?? spec.def;
    const idx = spec.values.indexOf(current);
    const next = spec.values[(idx + 1) % spec.values.length];
    this.#save({ [field]: next });
  }

  #cycleOptionalBool(field: string, def: boolean): void {
    const current = this.#readOptionalBool(field);
    let next: boolean | undefined;
    if (current === undefined) next = !def;
    else if (current !== def) next = def;
    else next = undefined;
    if (field === "webSearch.enabled") {
      this.#save({
        webSearch: {
          ...(this.#host.settings.webSearch ?? {}),
          enabled: next,
        },
      });
    } else if (field === "imageGeneration.enabled") {
      this.#save({
        imageGeneration: {
          ...(this.#host.settings.imageGeneration ?? {}),
          enabled: next,
        },
      });
    } else if (field === "approval.confirmBeforeWrite") {
      this.#save({
        approval: {
          ...(this.#host.settings.approval ?? {}),
          confirmBeforeWrite: next,
        },
      });
    } else {
      this.#save({ [field]: next });
    }
  }

  #readField(field: string): string | undefined {
    const s = this.#host.settings;
    switch (field) {
      case "defaultThinkingLevel":
        return s.defaultThinkingLevel;
      case "defaultMode":
        return s.defaultMode;
      case "sandbox.level":
        return s.sandbox?.level;
      default:
        return undefined;
    }
  }

  #readOptionalBool(field: string): boolean | undefined {
    const s = this.#host.settings;
    switch (field) {
      case "enablePlanTool":
        return s.enablePlanTool;
      case "enableArtifact":
        return s.enableArtifact;
      case "updateCheck":
        return s.updateCheck;
      case "webSearch.enabled":
        return s.webSearch?.enabled;
      case "imageGeneration.enabled":
        return s.imageGeneration?.enabled;
      case "approval.confirmBeforeWrite":
        return s.approval?.confirmBeforeWrite;
      default:
        return undefined;
    }
  }

  #cycleTuiLang(): void {
    const order = ["auto", "zh", "en"];
    const current = this.#host.settings.tuilang ?? "auto";
    const idx = order.indexOf(current);
    const next = order[(idx + 1) % order.length];
    this.#saveTuiLangValue(next);
  }

  #cycleTuiScope(): void {
    if (this.#tuiScope === "project") {
      this.#tuiScope = "global";
      return;
    }
    if (!isProjectDir(this.#host.workDir)) {
      this.#error = this.#host.translator.text(
        "settings.language.project_unavailable",
      );
      return;
    }
    this.#tuiScope = "project";
  }

  #saveTuiLang(): void {
    this.#saveTuiLangValue(this.#host.settings.tuilang ?? "auto");
  }

  #saveTuiLangValue(value: string): void {
    try {
      if (this.#tuiScope === "project") {
        if (!isProjectDir(this.#host.workDir)) {
          this.#error = this.#host.translator.text(
            "settings.language.project_unavailable",
          );
          return;
        }
        saveProjectSettingsPatch({ tuilang: value });
      } else {
        saveGlobalSettingsPatch({ tuilang: value });
      }
      this.#host.settings.tuilang = value;
      this.#host.reloadSettings();
    } catch (err) {
      this.#error = this.#host.translator.text(
        "settings.language.save_failed",
        (err as Error).message,
      );
    }
  }

  #normalizeStatusLine(next: Record<string, unknown>): void {
    if (next.type === undefined || next.type === "") next.type = "command";
    if (next.command === undefined || (next.command as string).trim() === "") {
      next.command = "ccstatusline";
    }
    if (next.timeoutMs === undefined || next.timeoutMs === 0) {
      next.timeoutMs = 800;
    }
    if (next.fallback === undefined || next.fallback === "") {
      next.fallback = "builtin";
    }
  }

  // --- Input submit ----------------------------------------------------------

  /** The current value prefilled when the input box opens. */
  #inputValue(field: string): string {
    const s = this.#host.settings;
    switch (field) {
      case "theme":
        return s.theme ?? "";
      case "maxContextTokens":
        return s.maxContextTokens ? `${s.maxContextTokens}` : "";
      case "webSearch.provider":
        return s.webSearch?.provider ?? "";
      case "webSearch.providerType":
        return s.webSearch?.providerType ?? "";
      case "webSearch.model":
        return s.webSearch?.model ?? "";
      case "toolExecution.maxConcurrency":
        return `${this.#toolExecutionMaxConcurrency()}`;
      case "imageGeneration.provider":
        return s.imageGeneration?.provider ?? "";
      case "imageGeneration.apiType":
        return s.imageGeneration?.apiType ?? "";
      case "imageGeneration.baseUrl":
        return s.imageGeneration?.baseUrl ?? "";
      case "imageGeneration.token":
        return s.imageGeneration?.token ?? "";
      case "imageGeneration.model":
        return s.imageGeneration?.model ?? "";
      case "contextFiles.extraFiles":
        return (s.contextFiles?.extraFiles ?? []).join(", ");
      case "statusLine.type":
        return s.statusLine?.type ?? "";
      case "statusLine.command":
        return s.statusLine?.command ?? "";
      case "statusLine.padding":
        return `${s.statusLine?.padding ?? 0}`;
      case "statusLine.refreshInterval":
        return `${s.statusLine?.refreshInterval ?? 0}`;
      case "statusLine.timeoutMs":
        return `${s.statusLine?.timeoutMs ?? 0}`;
      case "statusLine.fallback":
        return s.statusLine?.fallback ?? "";
      case "compaction.reserveTokens":
        return `${s.compaction?.reserveTokens ?? 0}`;
      case "compaction.keepRecentTokens":
        return `${s.compaction?.keepRecentTokens ?? 0}`;
      case "compaction.tokenizer":
        return s.compaction?.tokenizer ?? "";
      case "compaction.tokenizerModel":
        return s.compaction?.tokenizerModel ?? "";
      case "compaction.template":
        return s.compaction?.template ?? "";
      case "sandbox.bwrapPath":
        return s.sandbox?.bwrapPath ?? "";
      case "sandbox.allowedRead":
        return (s.sandbox?.allowedRead ?? []).join(", ");
      case "sandbox.allowedWrite":
        return (s.sandbox?.allowedWrite ?? []).join(", ");
      case "sandbox.deniedPaths":
        return (s.sandbox?.deniedPaths ?? []).join(", ");
      case "sandbox.passEnv":
        return (s.sandbox?.passEnv ?? []).join(", ");
      case "sandbox.tmpSize":
        return s.sandbox?.tmpSize ?? "";
      case "sessionDir":
        return s.sessionDir ?? "";
      case "skillsDir":
        return s.skillsDir ?? "";
      case "shellPath":
        return s.shellPath ?? "";
      case "shellCommandPrefix":
        return s.shellCommandPrefix ?? "";
      case "retry.maxRetries":
        return `${s.retry?.maxRetries ?? 0}`;
      case "retry.baseDelayMs":
        return `${s.retry?.baseDelayMs ?? 0}`;
      case "approval.bashWhitelist":
        return (s.approval?.bashWhitelist ?? []).join(", ");
      case "approval.bashBlacklist":
        return (s.approval?.bashBlacklist ?? []).join(", ");
      default:
        return "";
    }
  }

  submit(value: string): void {
    this.#error = "";
    const field = this.#field;
    const input = value.trim();
    try {
      const patch = this.#buildPatch(field, input);
      if (patch !== null) this.#save(patch);
    } catch (err) {
      this.#error = (err as Error).message;
    }
    this.#dialog.closeInput();
  }

  /** Builds a global-settings patch for one input field. */
  #buildPatch(field: string, input: string): Record<string, unknown> | null {
    const s = this.#host.settings;
    const tr = this.#host.translator;
    switch (field) {
      case "theme":
        return { theme: input };
      case "maxContextTokens":
        return { maxContextTokens: this.#int(input, tr) };
      case "webSearch.provider":
        return { webSearch: { ...(s.webSearch ?? {}), provider: input } };
      case "webSearch.providerType":
        return { webSearch: { ...(s.webSearch ?? {}), providerType: input } };
      case "webSearch.model":
        return { webSearch: { ...(s.webSearch ?? {}), model: input } };
      case "toolExecution.maxConcurrency":
        return {
          toolExecution: {
            ...(s.toolExecution ?? {}),
            maxConcurrency: this.#int(input, tr),
          },
        };
      case "imageGeneration.provider":
        return {
          imageGeneration: { ...(s.imageGeneration ?? {}), provider: input },
        };
      case "imageGeneration.apiType":
        return {
          imageGeneration: { ...(s.imageGeneration ?? {}), apiType: input },
        };
      case "imageGeneration.baseUrl":
        return {
          imageGeneration: { ...(s.imageGeneration ?? {}), baseUrl: input },
        };
      case "imageGeneration.token":
        return {
          imageGeneration: { ...(s.imageGeneration ?? {}), token: input },
        };
      case "imageGeneration.model":
        return {
          imageGeneration: { ...(s.imageGeneration ?? {}), model: input },
        };
      case "contextFiles.extraFiles":
        return {
          contextFiles: {
            ...(s.contextFiles ?? { enabled: false }),
            extraFiles: this.#list(input),
          },
        };
      case "statusLine.type":
        return { statusLine: { ...(s.statusLine ?? {}), type: input } };
      case "statusLine.command":
        return { statusLine: { ...(s.statusLine ?? {}), command: input } };
      case "statusLine.padding":
        return {
          statusLine: {
            ...(s.statusLine ?? {}),
            padding: this.#int(input, tr),
          },
        };
      case "statusLine.refreshInterval":
        return {
          statusLine: {
            ...(s.statusLine ?? {}),
            refreshInterval: this.#int(input, tr),
          },
        };
      case "statusLine.timeoutMs":
        return {
          statusLine: {
            ...(s.statusLine ?? {}),
            timeoutMs: this.#int(input, tr),
          },
        };
      case "statusLine.fallback":
        return { statusLine: { ...(s.statusLine ?? {}), fallback: input } };
      case "compaction.reserveTokens":
        return {
          compaction: {
            ...(s.compaction ??
              { enabled: false, reserveTokens: 0, keepRecentTokens: 0 }),
            reserveTokens: this.#int(input, tr),
          },
        };
      case "compaction.keepRecentTokens":
        return {
          compaction: {
            ...(s.compaction ??
              { enabled: false, reserveTokens: 0, keepRecentTokens: 0 }),
            keepRecentTokens: this.#int(input, tr),
          },
        };
      case "compaction.tokenizer":
        return {
          compaction: { ...(s.compaction ?? {}), tokenizer: input },
        };
      case "compaction.tokenizerModel":
        return {
          compaction: { ...(s.compaction ?? {}), tokenizerModel: input },
        };
      case "compaction.template":
        return {
          compaction: { ...(s.compaction ?? {}), template: input },
        };
      case "sandbox.bwrapPath":
        return { sandbox: { ...(s.sandbox ?? {}), bwrapPath: input } };
      case "sandbox.allowedRead":
        return {
          sandbox: { ...(s.sandbox ?? {}), allowedRead: this.#list(input) },
        };
      case "sandbox.allowedWrite":
        return {
          sandbox: { ...(s.sandbox ?? {}), allowedWrite: this.#list(input) },
        };
      case "sandbox.deniedPaths":
        return {
          sandbox: { ...(s.sandbox ?? {}), deniedPaths: this.#list(input) },
        };
      case "sandbox.passEnv":
        return {
          sandbox: { ...(s.sandbox ?? {}), passEnv: this.#list(input) },
        };
      case "sandbox.tmpSize":
        return { sandbox: { ...(s.sandbox ?? {}), tmpSize: input } };
      case "sessionDir":
        return { sessionDir: input };
      case "skillsDir":
        return { skillsDir: input };
      case "shellPath":
        return { shellPath: input };
      case "shellCommandPrefix":
        return { shellCommandPrefix: input };
      case "retry.maxRetries":
        return {
          retry: {
            ...(s.retry ?? { enabled: false, maxRetries: 0, baseDelayMs: 0 }),
            maxRetries: this.#int(input, tr),
          },
        };
      case "retry.baseDelayMs":
        return {
          retry: {
            ...(s.retry ?? { enabled: false, maxRetries: 0, baseDelayMs: 0 }),
            baseDelayMs: this.#int(input, tr),
          },
        };
      case "approval.bashWhitelist":
        return {
          approval: {
            ...(s.approval ?? {}),
            bashWhitelist: this.#list(input, true),
          },
        };
      case "approval.bashBlacklist":
        return {
          approval: {
            ...(s.approval ?? {}),
            bashBlacklist: this.#list(input, true),
          },
        };
      default:
        return null;
    }
  }

  #int(input: string, tr: Translator): number {
    if (!/^\d+$/.test(input.trim())) {
      throw new Error(tr.text("settings.error.non_negative_integer"));
    }
    return Number.parseInt(input, 10);
  }

  /** Splits comma/newline separated values; `keepTrailing` preserves trailing spaces. */
  #list(input: string, keepTrailing = false): string[] {
    return input
      .split(/[,\n]/)
      .map((v) => (keepTrailing ? v.replace(/^\s+/u, "") : v.trim()))
      .filter((v) => v !== "");
  }

  /** Persists a patch to global settings and refreshes the live session. */
  #save(patch: Record<string, unknown>): void {
    try {
      saveGlobalSettingsPatch(patch);
      this.#host.reloadSettings();
    } catch (err) {
      this.#error = this.#host.translator.text(
        "settings.save_failed",
        (err as Error).message,
      );
    }
  }

  key(): void {}

  back(): void {
    if (this.#view !== "root") {
      this.#view = "root";
      this.#error = "";
      this.#dialog.resetCursor();
      return;
    }
    this.#dialog.close();
  }
}

// --- /tuilang ---------------------------------------------------------------

/** The `/tuilang` picker: choose the language and save scope. */
export class TuiLangDialog implements DialogController {
  #host: DialogHost;
  #dialog: Dialog;
  #scope: "global" | "project";
  #view: "scope" | "language" = "scope";
  #error = "";

  constructor(host: DialogHost, dialog: Dialog, scope: "global" | "project") {
    this.#host = host;
    this.#dialog = dialog;
    this.#scope = scope;
  }

  page(): DialogPage {
    const tr = this.#host.translator;
    if (this.#view === "scope") {
      return {
        title: tr.text("dialog.tuilang.title"),
        items: [
          {
            label: tr.text("dialog.tuilang.global"),
            description: tr.text("dialog.tuilang.global_desc"),
            value: "global",
            current: this.#scope === "global",
          },
          {
            label: tr.text("dialog.tuilang.project"),
            description: tr.text("dialog.tuilang.project_desc"),
            value: "project",
            current: this.#scope === "project",
          },
        ],
        hint: tr.text("dialog.tuilang.scope_hint"),
        error: this.#error,
      };
    }
    const configured = this.#host.settings.tuilang ?? "auto";
    return {
      title: tr.text("dialog.tuilang.title"),
      items: ["auto", "zh", "en"].map((value) => ({
        label: value,
        value,
        current: value === configured,
      })),
      hint: tr.text("dialog.tuilang.language_hint"),
      error: this.#error,
    };
  }

  select(value: string): void {
    if (this.#view === "scope") {
      this.#scope = value === "project" ? "project" : "global";
      this.#view = "language";
      this.#error = "";
      this.#dialog.resetCursor();
      return;
    }
    this.#save(value);
  }

  #save(value: string): void {
    const tr = this.#host.translator;
    try {
      if (this.#scope === "global") {
        saveGlobalSettingsPatch({ tuilang: value });
      } else {
        saveProjectSettingsPatch({ tuilang: value });
      }
      this.#host.settings.tuilang = value;
    } catch (err) {
      this.#error = tr.text("tuilang.save_failed", (err as Error).message);
      return;
    }
    this.#host.reloadSettings();
    this.#dialog.close(tr.text("tuilang.saved", this.#scope, value, value));
  }

  submit(): void {}
  key(): void {}

  back(): void {
    if (this.#view === "language") {
      this.#view = "scope";
      this.#error = "";
      this.#dialog.resetCursor();
      return;
    }
    this.#dialog.close();
  }
}

/** Orders provider IDs so well-known vendors come first (shared ranking). */
export function compareProviderIDs(a: string, b: string): number {
  const pa = providerSortPriority(a);
  const pb = providerSortPriority(b);
  if (pa !== pb) return pa - pb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Exposed for tests: the session manager directory helper. */
export function sessionDirectory(manager: SessionManager): string {
  return manager.getSessionDir();
}
