// Concrete interactive dialogs for the Ink TUI, ported from the Go TUI's
// model_dialog.go, default_model_dialog.go, env_dialog.go, commands_session.go
// (sessions dialog), and auth_dialog.go (provider/settings editing).
//
// Every dialog is a real editor: it reads the current configuration, lets the
// user pick and type values, validates them, persists through the shared config
// and session APIs, and applies the change to the live session. None of them is
// a status display.

import {
  type AllowConfig,
  loadAllow,
  saveProject,
  setProjectAutoEdit,
} from "../config/allow.ts";
import { clearEnv, envList, loadEnv, setEnv, unsetEnv } from "../config/env.ts";
import {
  defaultProviderConfigsAll,
  getProviderConfig,
  loadGlobalSettingsSparse,
  loadProjectSettingsSparse,
  resolveKey,
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

type AuthView = "main" | "providers" | "provider" | "key" | "custom-id";

/** The `/auth` provider editor: pick a provider, then set its API key. */
export class AuthDialog implements DialogController {
  #host: DialogHost;
  #dialog: Dialog;
  #view: AuthView = "main";
  #providerID = "";
  #error = "";
  #pendingCustomID = "";

  constructor(host: DialogHost, dialog: Dialog) {
    this.#host = host;
    this.#dialog = dialog;
  }

  page(): DialogPage {
    const tr = this.#host.translator;
    switch (this.#view) {
      case "main":
        return {
          title: tr.text("dialog.auth.title"),
          items: [
            {
              label: tr.text("dialog.auth.existing"),
              description: tr.text("dialog.auth.existing_desc"),
              value: "existing",
            },
            {
              label: tr.text("dialog.auth.custom"),
              description: tr.text("dialog.auth.custom_desc"),
              value: "custom",
            },
          ],
          hint: tr.text("dialog.auth.hint"),
          error: this.#error,
        };
      case "providers":
        return {
          title: tr.text("dialog.auth.providers_title"),
          search: true,
          items: providerIDs(this.#host.settings).map((id) => ({
            label: id,
            description: this.#providerState(id),
            value: `provider:${id}`,
            current: id === this.#host.settings.defaultProvider,
          })),
          hint: tr.text("dialog.auth.providers_hint"),
          error: this.#error,
        };
      case "provider": {
        const configured =
          resolveKey(this.#host.settings, this.#providerID) !== "";
        return {
          title: tr.text("dialog.auth.provider_title", this.#providerID),
          body: [
            tr.text(
              "dialog.auth.provider_state",
              configured
                ? tr.text("auth.provider_configured")
                : tr.text("auth.provider_unconfigured"),
            ),
          ],
          items: [
            {
              label: tr.text("dialog.auth.set_key"),
              description: tr.text("dialog.auth.set_key_desc"),
              value: "set-key",
            },
            {
              label: tr.text("dialog.auth.use_as_default"),
              value: "set-default",
              current: this.#host.settings.defaultProvider === this.#providerID,
            },
          ],
          hint: tr.text("dialog.auth.provider_hint"),
          error: this.#error,
        };
      }
      case "key":
        return {
          title: tr.text("dialog.auth.key_title", this.#providerID),
          items: [],
          input: {
            prompt: tr.text("dialog.auth.key_prompt"),
            value: this.#dialog.inputValue,
            placeholder: tr.text("dialog.auth.key_placeholder"),
            masked: true,
          },
          hint: tr.text("dialog.auth.key_hint"),
          error: this.#error,
        };
      case "custom-id":
        return {
          title: tr.text("dialog.auth.custom_title"),
          items: [],
          input: {
            prompt: tr.text("dialog.auth.custom_prompt"),
            value: this.#dialog.inputValue,
            placeholder: tr.text("dialog.auth.custom_placeholder"),
          },
          hint: tr.text("dialog.auth.custom_hint"),
          error: this.#error,
        };
    }
  }

  #providerState(id: string): string {
    const pc = getProviderConfig(this.#host.settings, id);
    const configured = resolveKey(this.#host.settings, id) !== "";
    const models = pc?.models.length ?? 0;
    return `${
      configured
        ? this.#host.translator.text("auth.provider_configured")
        : this.#host.translator.text("auth.provider_unconfigured")
    } · ${models} models`;
  }

  select(value: string): void {
    switch (value) {
      case "existing":
        this.#view = "providers";
        this.#error = "";
        this.#dialog.resetCursor();
        return;
      case "custom":
        this.#view = "custom-id";
        this.#error = "";
        this.#dialog.openInput("");
        return;
      case "set-key":
        this.#view = "key";
        this.#error = "";
        this.#dialog.openInput("");
        return;
      case "set-default":
        this.#setDefault();
        return;
      default:
        if (value.startsWith("provider:")) {
          this.#providerID = value.slice("provider:".length);
          this.#view = "provider";
          this.#error = "";
          this.#dialog.resetCursor();
        }
        return;
    }
  }

  /** Persists a provider API key into the global settings. */
  submit(value: string): void {
    const tr = this.#host.translator;
    if (this.#view === "custom-id") {
      const id = value.trim();
      if (id === "") {
        this.#error = tr.text("dialog.auth.custom_required");
        return;
      }
      this.#pendingCustomID = id;
      this.#providerID = id;
      this.#view = "key";
      this.#error = "";
      this.#dialog.openInput("");
      return;
    }
    if (this.#view === "key") {
      const key = value.trim();
      if (key === "") {
        this.#error = tr.text("dialog.auth.key_required");
        return;
      }
      try {
        const sparse = loadGlobalSettingsSparse();
        const providers = { ...(sparse.providers ?? {}) };
        const existing = providers[this.#providerID] ?? {
          models: [],
        };
        providers[this.#providerID] = { ...existing, apiKey: key };
        sparse.providers = providers;
        saveGlobalSettings(sparse);
      } catch (err) {
        this.#error = tr.text(
          "settings.save_failed",
          (err as Error).message,
        );
        return;
      }
      this.#host.reloadSettings();
      this.#dialog.close(
        tr.text("dialog.auth.key_saved", this.#providerID),
      );
    }
  }

  #setDefault(): void {
    const tr = this.#host.translator;
    try {
      const sparse = loadGlobalSettingsSparse();
      const models = resolvedModels(this.#host.settings, this.#providerID);
      const modelID = models[0]?.id ?? "";
      sparse.defaultProvider = this.#providerID;
      if (modelID !== "") sparse.defaultModel = modelID;
      saveGlobalSettings(sparse);
      this.#host.reloadSettings();
      if (modelID !== "") this.#host.applyModel(this.#providerID, modelID);
      this.#dialog.close(
        tr.text("settings.default_model_saved", this.#providerID, "global"),
      );
    } catch (err) {
      this.#error = tr.text("settings.save_failed", (err as Error).message);
    }
  }

  key(): void {}

  back(): void {
    switch (this.#view) {
      case "main":
        this.#dialog.close();
        return;
      case "providers":
        this.#view = "main";
        break;
      case "provider":
        this.#view = "providers";
        break;
      case "key":
        this.#view = this.#pendingCustomID === "" ? "provider" : "custom-id";
        this.#dialog.closeInput();
        break;
      case "custom-id":
        this.#view = "main";
        this.#dialog.closeInput();
        break;
    }
    this.#error = "";
    this.#dialog.resetCursor();
  }
}

// --- /settings --------------------------------------------------------------

/** The `/settings` browser: inspect settings and toggle key switches. */
export class SettingsDialog implements DialogController {
  #host: DialogHost;
  #dialog: Dialog;
  #view: "root" | "defaults" | "behavior" = "root";
  #error = "";
  #message = "";

  constructor(host: DialogHost, dialog: Dialog) {
    this.#host = host;
    this.#dialog = dialog;
  }

  page(): DialogPage {
    const tr = this.#host.translator;
    switch (this.#view) {
      case "root":
        return {
          title: tr.text("dialog.settings.title"),
          items: [
            {
              label: tr.text("dialog.settings.defaults"),
              description: `${this.#host.settings.defaultProvider ?? ""}/${
                this.#host.settings.defaultModel ?? ""
              }`,
              value: "defaults",
            },
            {
              label: tr.text("dialog.settings.behavior"),
              description: tr.text("dialog.settings.behavior_desc"),
              value: "behavior",
            },
          ],
          hint: tr.text("dialog.settings.hint"),
          error: this.#error !== "" ? this.#error : this.#message,
        };
      case "defaults":
        return {
          title: tr.text("dialog.settings.defaults"),
          items: [
            {
              label: tr.text("dialog.settings.default_provider"),
              description: this.#host.settings.defaultProvider ?? "",
              value: "edit-default",
            },
            {
              label: tr.text("dialog.settings.default_model"),
              description: this.#host.settings.defaultModel ?? "",
              value: "edit-default",
            },
          ],
          hint: tr.text("dialog.settings.defaults_hint"),
          error: this.#error !== "" ? this.#error : this.#message,
        };
      case "behavior": {
        const allow = this.#host.allow;
        return {
          title: tr.text("dialog.settings.behavior"),
          items: [
            {
              label: tr.text("dialog.settings.auto_edit"),
              description: allow.autoEdit === true ? "ON" : "OFF",
              value: "toggle-auto-edit",
              current: allow.autoEdit === true,
            },
            {
              label: tr.text("dialog.settings.plan_tool"),
              description: this.#host.settings.enablePlanTool === false
                ? "OFF"
                : "ON",
              value: "toggle-plan-tool",
              current: this.#host.settings.enablePlanTool !== false,
            },
          ],
          hint: tr.text("dialog.settings.behavior_hint"),
          error: this.#error !== "" ? this.#error : this.#message,
        };
      }
    }
  }

  select(value: string): void {
    switch (value) {
      case "defaults":
        this.#view = "defaults";
        this.#dialog.resetCursor();
        return;
      case "behavior":
        this.#view = "behavior";
        this.#dialog.resetCursor();
        return;
      case "edit-default":
        // Hand off to the default-model picker.
        this.#dialog.close(undefined);
        return;
      case "toggle-auto-edit":
        this.#toggleAutoEdit();
        return;
      case "toggle-plan-tool":
        this.#togglePlanTool();
        return;
      default:
        return;
    }
  }

  #toggleAutoEdit(): void {
    const tr = this.#host.translator;
    const next = !(this.#host.allow.autoEdit === true);
    try {
      const allow = loadAllow();
      setProjectAutoEdit(allow, next);
      saveProject(allow);
      this.#host.reloadSettings();
      this.#message = tr.text(
        "allowautoedit.saved",
        next ? "ON" : "OFF",
        "project",
      );
      this.#error = "";
    } catch (err) {
      this.#error = tr.text(
        "alloweditpath.save_failed",
        (err as Error).message,
      );
    }
  }

  #togglePlanTool(): void {
    const tr = this.#host.translator;
    const next = this.#host.settings.enablePlanTool === false;
    try {
      const sparse = loadGlobalSettingsSparse();
      sparse.enablePlanTool = next;
      saveGlobalSettings(sparse);
      this.#host.reloadSettings();
      this.#message = tr.text(
        "dialog.settings.plan_tool_saved",
        next ? "ON" : "OFF",
      );
      this.#error = "";
    } catch (err) {
      this.#error = tr.text("settings.save_failed", (err as Error).message);
    }
  }

  submit(): void {}
  key(): void {}

  back(): void {
    if (this.#view !== "root") {
      this.#view = "root";
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
