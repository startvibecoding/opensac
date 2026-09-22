// Structured /auth dialog ported from the Go TUI's auth_dialog.go /
// auth_provider.go / auth_model.go.
//
// Navigation mirrors mothx:
//   main → existing providers → provider group list
//        → custom provider id → provider group list
// provider group list → credentials / protocol / network / advanced
//                        / headers / responses / API type / models
// models → add model / model group list
// model group list → basics / capabilities / sampling / cost / compat
//
// The dialog edits a deep-cloned draft only; nothing persists until the user
// confirms with "done". Confirmation writes the full provider block plus its
// models back to the global settings through the sparse patch API, then reloads
// the live session.
//

import type {
  ModelCompat,
  ModelConfig,
  ProviderConfig,
  ResponsesConfig,
  ResponsesToolControlConfig,
  Settings,
} from "../config/settings.ts";
import {
  defaultProviderConfigsAll,
  loadGlobalSettingsSparse,
  saveGlobalSettingsPatch,
} from "../config/settings.ts";
import type { DialogItem, DialogPage } from "./dialog.ts";

type TriBool = boolean | null;

// ── Draft types ──────────────────────────────────────────────────────────────

interface ProviderDraft {
  api: string;
  apiKey: string;
  baseUrl: string;
  vendor: string;
  httpProxy: string;
  forceHTTP11: boolean;
  headers: Record<string, string>;
  thinkingFormat: string;
  cacheControl: TriBool;
  maxImagesPerRequest: number;
  responses: ResponsesDraft;
}

interface ResponsesDraft {
  reasoningSummary: string;
  promptCacheEnabled: TriBool;
  promptCacheKey: string;
  promptCacheRetention: string;
  stateMode: string;
  store: TriBool;
  conversation: string;
  truncation: string;
  background: TriBool;
  include: string[];
  serviceTier: string;
  toolChoice: string;
  toolParallel: TriBool;
  toolMaxCalls: number;
}

interface ModelDraft {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: string[];
  temperature: number | null;
  topP: number | null;
  costEnabled: boolean;
  costInput: number;
  costOutput: number;
  cacheRead: number;
  cacheWrite: number;
  compat: CompatDraft;
}

interface CompatDraft {
  active: boolean;
  thinkingFormat: string;
  requiresReasoningContentOnAssistant: boolean;
  requiresReasoningContentOnAssistantMessages: boolean;
  forceAdaptiveThinking: boolean;
  parseReasoningInContent: boolean;
  supportsDeveloperRole: TriBool;
  supportsStore: TriBool;
  supportsReasoningEffort: TriBool;
  supportsStrictMode: TriBool;
  maxTokensField: string;
  disableSamplingParams: TriBool;
  supportsCacheControlOnTools: TriBool;
  supportsLongCacheRetention: TriBool;
  supportsPromptCacheKey: TriBool;
  supportsReasoningSummary: TriBool;
  sendSessionAffinityHeaders: boolean;
  supportsEagerToolInputStreaming: TriBool;
  supportsToolChoice: TriBool;
  supportsParallelToolCalls: TriBool;
}

// ── Views ────────────────────────────────────────────────────────────────────

export type AuthView =
  | "main"
  | "providers"
  | "custom-id"
  | "provider-groups"
  | "credentials"
  | "protocol"
  | "network"
  | "advanced"
  | "headers"
  | "responses"
  | "api-choice"
  | "model-list"
  | "add-model-id"
  | "model-groups"
  | "model-basics"
  | "model-capabilities"
  | "model-sampling"
  | "model-cost"
  | "model-compat";

/** Host surface required by the dialog (subset of the dialogs.ts DialogHost). */
export interface AuthHost {
  readonly translator: AuthTranslator;
  readonly settings: Settings;
  applyModel(providerName: string, modelID: string): void;
  reloadSettings(): void;
}

interface AuthTranslator {
  text(id: string, ...args: unknown[]): string;
}

interface FieldSpec {
  /** i18n key for the row label / input prompt. */
  label: string;
  kind: "text" | "int" | "float" | "bool" | "tri" | "cycle";
  /** Present for cycle fields. */
  values?: string[];
  /** Key under PARAM_STORES where the value lives. */
  store: "provider" | "responses" | "model" | "compat";
  /** Property name in the corresponding draft object. */
  key: string;
}

// ── Field tables ─────────────────────────────────────────────────────────────

const API_CHOICES = [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "google-gemini",
  "google-vertex",
];

const THINKING_FORMATS = [
  "",
  "openai",
  "anthropic",
  "deepseek",
  "xiaomi",
  "zai",
];

function fields(...specs: FieldSpec[]): FieldSpec[] {
  return specs;
}

const CREDENTIAL_FIELDS = fields(
  {
    label: "auth.field.api_key",
    kind: "text",
    store: "provider",
    key: "apiKey",
  },
  {
    label: "auth.field.vendor",
    kind: "text",
    store: "provider",
    key: "vendor",
  },
);

const PROTOCOL_FIELDS = fields(
  {
    label: "auth.field.base_url",
    kind: "text",
    store: "provider",
    key: "baseUrl",
  },
);

const NETWORK_FIELDS = fields(
  {
    label: "auth.field.http_proxy",
    kind: "text",
    store: "provider",
    key: "httpProxy",
  },
  {
    label: "auth.field.force_http11",
    kind: "bool",
    store: "provider",
    key: "forceHTTP11",
  },
);

const ADVANCED_FIELDS = fields(
  {
    label: "auth.field.thinking_format",
    kind: "cycle",
    values: THINKING_FORMATS,
    store: "provider",
    key: "thinkingFormat",
  },
  {
    label: "auth.field.cache_control",
    kind: "tri",
    store: "provider",
    key: "cacheControl",
  },
  {
    label: "auth.field.max_images",
    kind: "int",
    store: "provider",
    key: "maxImagesPerRequest",
  },
);

const RESPONSES_FIELDS = fields(
  {
    label: "auth.field.reasoning_summary",
    kind: "text",
    store: "responses",
    key: "reasoningSummary",
  },
  {
    label: "auth.field.prompt_cache",
    kind: "tri",
    store: "responses",
    key: "promptCacheEnabled",
  },
  {
    label: "auth.field.cache_key",
    kind: "text",
    store: "responses",
    key: "promptCacheKey",
  },
  {
    label: "auth.field.cache_retention",
    kind: "text",
    store: "responses",
    key: "promptCacheRetention",
  },
  {
    label: "auth.field.tool_choice",
    kind: "text",
    store: "responses",
    key: "toolChoice",
  },
  {
    label: "auth.field.tool_parallel",
    kind: "tri",
    store: "responses",
    key: "toolParallel",
  },
  {
    label: "auth.field.tool_max_calls",
    kind: "int",
    store: "responses",
    key: "toolMaxCalls",
  },
);

const MODEL_BASIC_FIELDS = fields(
  { label: "auth.field.name", kind: "text", store: "model", key: "name" },
  {
    label: "auth.field.context_window",
    kind: "int",
    store: "model",
    key: "contextWindow",
  },
  {
    label: "auth.field.max_tokens",
    kind: "int",
    store: "model",
    key: "maxTokens",
  },
);

const MODEL_CAPABILITY_FIELDS = fields(
  {
    label: "auth.field.reasoning",
    kind: "bool",
    store: "model",
    key: "reasoning",
  },
  {
    label: "auth.field.modalities",
    kind: "text",
    store: "model",
    key: "input",
  },
);

const MODEL_SAMPLING_FIELDS = fields(
  {
    label: "auth.field.temperature",
    kind: "float",
    store: "model",
    key: "temperature",
  },
  { label: "auth.field.top_p", kind: "float", store: "model", key: "topP" },
);

const MODEL_COST_FIELDS = fields(
  {
    label: "auth.field.cost_enabled",
    kind: "bool",
    store: "model",
    key: "costEnabled",
  },
);

const MODEL_COST_DETAIL_FIELDS = fields(
  {
    label: "auth.field.cost_input",
    kind: "float",
    store: "model",
    key: "costInput",
  },
  {
    label: "auth.field.cost_output",
    kind: "float",
    store: "model",
    key: "costOutput",
  },
  {
    label: "auth.field.cost_cache_read",
    kind: "float",
    store: "model",
    key: "cacheRead",
  },
  {
    label: "auth.field.cost_cache_write",
    kind: "float",
    store: "model",
    key: "cacheWrite",
  },
);

const MODEL_COMPAT_FIELDS = fields(
  {
    label: "auth.field.compat_thinking_format",
    kind: "cycle",
    values: THINKING_FORMATS,
    store: "compat",
    key: "thinkingFormat",
  },
  {
    label: "auth.field.req_reasoning_asst",
    kind: "bool",
    store: "compat",
    key: "requiresReasoningContentOnAssistant",
  },
  {
    label: "auth.field.req_reasoning_asst_msgs",
    kind: "bool",
    store: "compat",
    key: "requiresReasoningContentOnAssistantMessages",
  },
  {
    label: "auth.field.force_adaptive",
    kind: "bool",
    store: "compat",
    key: "forceAdaptiveThinking",
  },
  {
    label: "auth.field.parse_reasoning",
    kind: "bool",
    store: "compat",
    key: "parseReasoningInContent",
  },
  {
    label: "auth.field.supports_developer",
    kind: "tri",
    store: "compat",
    key: "supportsDeveloperRole",
  },
  {
    label: "auth.field.supports_store",
    kind: "tri",
    store: "compat",
    key: "supportsStore",
  },
  {
    label: "auth.field.supports_reasoning_effort",
    kind: "tri",
    store: "compat",
    key: "supportsReasoningEffort",
  },
  {
    label: "auth.field.supports_strict",
    kind: "tri",
    store: "compat",
    key: "supportsStrictMode",
  },
  {
    label: "auth.field.max_tokens_field",
    kind: "text",
    store: "compat",
    key: "maxTokensField",
  },
  {
    label: "auth.field.disable_sampling",
    kind: "tri",
    store: "compat",
    key: "disableSamplingParams",
  },
  {
    label: "auth.field.cache_control_tools",
    kind: "tri",
    store: "compat",
    key: "supportsCacheControlOnTools",
  },
  {
    label: "auth.field.long_retention",
    kind: "tri",
    store: "compat",
    key: "supportsLongCacheRetention",
  },
  {
    label: "auth.field.prompt_cache_key",
    kind: "tri",
    store: "compat",
    key: "supportsPromptCacheKey",
  },
  {
    label: "auth.field.reasoning_summary_flag",
    kind: "tri",
    store: "compat",
    key: "supportsReasoningSummary",
  },
  {
    label: "auth.field.session_affinity",
    kind: "bool",
    store: "compat",
    key: "sendSessionAffinityHeaders",
  },
  {
    label: "auth.field.eager_tool_stream",
    kind: "tri",
    store: "compat",
    key: "supportsEagerToolInputStreaming",
  },
  {
    label: "auth.field.supports_tool_choice",
    kind: "tri",
    store: "compat",
    key: "supportsToolChoice",
  },
  {
    label: "auth.field.supports_parallel_tools",
    kind: "tri",
    store: "compat",
    key: "supportsParallelToolCalls",
  },
);

// ── Controller interface used by the dialog panel ───────────────────────────

/** Minimal panel surface the controller drives (the concrete Dialog). */
export interface AuthPanel {
  close(message?: string, error?: boolean): void;
  openInput(value?: string): void;
  closeInput(): void;
  resetCursor(): void;
  readonly inputValue: string;
  readonly cursor: number;
}

const FIELD_TABLE: Partial<Record<AuthView, FieldSpec[]>> = {
  credentials: CREDENTIAL_FIELDS,
  protocol: PROTOCOL_FIELDS,
  network: NETWORK_FIELDS,
  advanced: ADVANCED_FIELDS,
  responses: RESPONSES_FIELDS,
  "model-basics": MODEL_BASIC_FIELDS,
  "model-capabilities": MODEL_CAPABILITY_FIELDS,
  "model-sampling": MODEL_SAMPLING_FIELDS,
  "model-cost": MODEL_COST_FIELDS,
  "model-compat": MODEL_COMPAT_FIELDS,
};

// ── AuthDialog controller ───────────────────────────────────────────────────

export class AuthDialog {
  #host: AuthHost;
  #panel: AuthPanel;

  #view: AuthView = "main";
  #stack: AuthView[] = [];
  #providerID = "";
  #customMode = false;
  #error = "";

  #provider = blankProvider();
  #models: ModelDraft[] = [];
  #currentModelID = "";
  /** Active editing field ("<store>:<key>") when the input box is open. */
  #paramField = "";
  /** Auxiliary state for the headers editor: "key" | "value". */
  #headerPhase: "key" | "value" = "key";
  #headerKeyDraft = "";

  constructor(
    host: AuthHost,
    panel: AuthPanel,
    initialProvider = "",
  ) {
    this.#host = host;
    this.#panel = panel;
    const provider = initialProvider.trim();
    if (provider !== "") {
      this.#providerID = provider;
      this.loadProviderDraft(provider);
      this.#view = "provider-groups";
      this.#panel.resetCursor();
    }
  }

  // ── navigation ────────────────────────────────────────────────────────────

  #push(view: AuthView): void {
    this.#stack.push(this.#view);
    this.#view = view;
    this.#paramField = "";
    this.#error = "";
    this.#panel.resetCursor();
  }

  #pop(): void {
    const previous = this.#stack.pop();
    if (previous === undefined) {
      this.#panel.close();
      return;
    }
    this.#view = previous;
    this.#paramField = "";
    this.#error = "";
    this.#panel.resetCursor();
  }

  /** Escape/back behavior per view. */
  back(): void {
    if (this.#view === "main") {
      this.#panel.close();
      return;
    }
    this.#pop();
  }

  // ── draft loading ─────────────────────────────────────────────────────────

  #resolveProviderConfig(id: string): ProviderConfig | undefined {
    const configured = this.#host.settings.providers?.[id];
    if (configured !== undefined) return configured;
    const presets = defaultProviderPresets();
    return presets[id];
  }

  loadProviderDraft(id: string): void {
    const cfg = this.#resolveProviderConfig(id);
    this.#provider = providerDraftFrom(cfg);
    this.#models = (cfg?.models ?? []).map(modelDraftFrom);
  }

  #currentModel(): ModelDraft | undefined {
    return this.#models.find((m) => m.id === this.#currentModelID);
  }

  #storeFor(spec: FieldSpec): Record<string, unknown> {
    switch (spec.store) {
      case "provider":
        return this.#provider as unknown as Record<string, unknown>;
      case "responses":
        return this.#provider.responses as unknown as Record<string, unknown>;
      case "model":
        return this.#currentModel() as unknown as Record<string, unknown>;
      case "compat":
        return this.#currentModel()?.compat as unknown as Record<
          string,
          unknown
        >;
    }
  }

  // ── page building ─────────────────────────────────────────────────────────

  page(): DialogPage {
    const tr = this.#host.translator;
    const hint = this.hint();
    switch (this.#view) {
      case "main":
        return {
          title: tr.text("dialog.auth.title"),
          hint,
          error: this.#error,
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
        };

      case "providers":
        return {
          title: tr.text("dialog.auth.providers_title"),
          search: true,
          hint,
          error: this.#error,
          items: providerIDsFromSettings(this.#host.settings).map((id) => ({
            label: id,
            description: this.#providerListState(id),
            value: `provider:${id}`,
            current: id === this.#host.settings.defaultProvider,
          })),
        };

      case "custom-id":
        return {
          title: tr.text("dialog.auth.custom_title"),
          hint,
          error: this.#error,
          items: [],
          input: {
            prompt: tr.text("dialog.auth.custom_prompt"),
            value: this.#panel.inputValue,
            placeholder: tr.text("dialog.auth.custom_placeholder"),
          },
        };

      case "provider-groups":
        return {
          title: tr.text("dialog.auth.provider_title", this.#providerID),
          hint,
          error: this.#error,
          items: this.providerGroupItems(),
        };

      case "headers":
        return {
          title: tr.text("dialog.auth.headers_title", this.#providerID),
          hint,
          error: this.#error,
          items: this.headerItems(),
        };

      case "api-choice":
        return {
          title: tr.text("dialog.auth.api_title", this.#providerID),
          hint,
          error: this.#error,
          items: API_CHOICES.map((api) => ({
            label: api,
            value: `api:${api}`,
            current: this.#provider.api === api,
          })),
        };

      case "model-list":
        return {
          title: tr.text("dialog.auth.models_title", this.#providerID),
          hint,
          error: this.#error,
          items: this.modelListItems(),
        };

      case "add-model-id":
        return {
          title: tr.text("dialog.auth.add_model_title"),
          hint,
          error: this.#error,
          items: [],
          input: {
            prompt: tr.text("dialog.auth.add_model_prompt"),
            value: this.#panel.inputValue,
            placeholder: tr.text("dialog.auth.add_model_placeholder"),
          },
        };

      case "model-groups":
        return {
          title: tr.text("dialog.auth.model_group_title", this.#currentModelID),
          hint,
          error: this.#error,
          items: this.modelGroupItems(),
        };

      default: {
        // Field-table views.
        const specs = FIELD_TABLE[this.#view] ?? [];
        const includeCostDetails = this.#view === "model-cost" &&
          this.#currentModel()?.costEnabled === true;
        const allSpecs = includeCostDetails
          ? [...specs, ...MODEL_COST_DETAIL_FIELDS]
          : specs;
        return {
          title: tr.text(fieldTitleKey(this.#view)),
          hint,
          error: this.#error,
          items: this.fieldItems(allSpecs),
          input: this.#paramField !== ""
            ? {
              prompt: tr.text(this.activeFieldLabel()),
              value: this.#panel.inputValue,
              masked: this.activeFieldMasks(),
            }
            : undefined,
        };
      }
    }
  }

  private hint(): string {
    const tr = this.#host.translator;
    if (this.#paramField !== "") return tr.text("dialog.auth.hint_input");
    return tr.text("dialog.auth.hint");
  }

  private activeFieldLabel(): string {
    const spec = this.findActiveField();
    return spec?.label ?? "dialog.auth.hint_input";
  }

  private activeFieldMasks(): boolean {
    return this.findActiveField()?.key === "apiKey";
  }

  private findActiveField(): FieldSpec | undefined {
    if (this.#paramField === "") return undefined;
    const [, key] = this.#paramField.split(":", 2);
    for (const specs of Object.values(FIELD_TABLE)) {
      const found = specs?.find((s) => s.key === key);
      if (found) return found;
    }
    return undefined;
  }

  // ── item builders ─────────────────────────────────────────────────────────

  #providerListState(id: string): string {
    const cfg = this.#resolveProviderConfig(id);
    const api = cfg?.api ?? "openai-chat";
    const url = cfg?.baseUrl ?? "";
    const count = cfg?.models.length ?? 0;
    return `${api} · ${url} · ${count} models`;
  }

  providerGroupItems(): DialogItem[] {
    const tr = this.#host.translator;
    const p = this.#provider;
    return [
      {
        label: tr.text("auth.group.api"),
        description: p.api,
        value: "api-choice",
      },
      {
        label: tr.text("auth.group.credentials"),
        description: this.credentialsSummary(),
        value: "credentials",
      },
      {
        label: tr.text("auth.group.protocol"),
        description: this.protocolSummary(),
        value: "protocol",
      },
      {
        label: tr.text("auth.group.network"),
        description: this.networkSummary(),
        value: "network",
      },
      {
        label: tr.text("auth.group.advanced"),
        description: this.advancedSummary(),
        value: "advanced",
      },
      { label: tr.text("auth.group.headers"), value: "headers" },
      { label: tr.text("auth.group.responses"), value: "responses" },
      {
        label: tr.text("auth.group.models"),
        description: tr.text("auth.models.count", this.#models.length),
        value: "model-list",
      },
      { label: tr.text("auth.group.done"), value: "done" },
    ];
  }

  private credentialsSummary(): string {
    const tr = this.#host.translator;
    const key = this.#provider.apiKey !== ""
      ? maskSecret(this.#provider.apiKey)
      : tr.text("auth.value.empty");
    const vendor = this.#provider.vendor !== ""
      ? `  vendor=${this.#provider.vendor}`
      : "";
    return `key=${key}${vendor}`;
  }

  private protocolSummary(): string {
    return shortUrl(this.#provider.baseUrl);
  }

  private networkSummary(): string {
    const tr = this.#host.translator;
    const proxy = this.#provider.httpProxy !== ""
      ? shortUrl(this.#provider.httpProxy)
      : tr.text("auth.value.none");
    const h1 = this.#provider.forceHTTP11
      ? tr.text("auth.value.force_h1")
      : tr.text("auth.value.http2");
    return `proxy=${proxy}  ${h1}`;
  }

  private advancedSummary(): string {
    const tr = this.#host.translator;
    const think = this.#provider.thinkingFormat !== ""
      ? `  think=${this.#provider.thinkingFormat}`
      : "";
    const cache = triLabel(this.#provider.cacheControl, tr);
    const images = imageLimitLabel(this.#provider.maxImagesPerRequest);
    return `cache=${cache}  images=${images}${think}`;
  }

  headerItems(): DialogItem[] {
    const tr = this.#host.translator;
    const keys = Object.keys(this.#provider.headers).sort();
    const items: DialogItem[] = keys.map((k) => ({
      label: k,
      description: this.#provider.headers[k],
      value: `header:${k}`,
    }));
    items.push({ label: tr.text("auth.headers.add"), value: "header-add" });
    items.push({ label: tr.text("auth.headers.done"), value: "done" });
    return items;
  }

  modelListItems(): DialogItem[] {
    const tr = this.#host.translator;
    const items: DialogItem[] = [
      { label: tr.text("auth.models.add"), value: "model-add" },
    ];
    for (const m of this.#models) {
      items.push({
        label: m.id,
        description: modelSummary(m),
        value: `model:${m.id}`,
      });
    }
    items.push({ label: tr.text("auth.models.done"), value: "done" });
    return items;
  }

  modelGroupItems(): DialogItem[] {
    const tr = this.#host.translator;
    const m = this.#currentModel();
    if (m === undefined) return [];
    return [
      {
        label: tr.text("auth.m_group.basics"),
        description: `ctx=${intAuto(m.contextWindow)} max=${
          intAuto(m.maxTokens)
        }`,
        value: "model-basics",
      },
      {
        label: tr.text("auth.m_group.capabilities"),
        description: `${m.reasoning ? "reasoning " : ""}in=${
          m.input.join(",")
        }`,
        value: "model-capabilities",
      },
      {
        label: tr.text("auth.m_group.sampling"),
        description: `t=${numAuto(m.temperature)} p=${numAuto(m.topP)}`,
        value: "model-sampling",
      },
      {
        label: tr.text("auth.m_group.cost"),
        description: m.costEnabled
          ? `in=${m.costInput} out=${m.costOutput}`
          : tr.text("auth.value.disabled"),
        value: "model-cost",
      },
      {
        label: tr.text("auth.m_group.compat"),
        description: compatSummary(m.compat, tr),
        value: "model-compat",
      },
      { label: tr.text("auth.m_group.done"), value: "done" },
    ];
  }

  fieldItems(specs: FieldSpec[]): DialogItem[] {
    const tr = this.#host.translator;
    return specs.map((spec) => {
      const store = this.#storeFor(spec);
      const value = store?.[spec.key];
      return {
        label: tr.text(spec.label),
        description: describeValue(spec, value, tr),
        value: `field:${spec.store}:${spec.key}`,
      };
    });
  }

  // ── selection ─────────────────────────────────────────────────────────────

  select(value: string): void {
    // Main menu
    if (value === "existing") {
      this.#push("providers");
      return;
    }
    if (value === "custom") {
      this.#customMode = true;
      this.#provider = blankProvider();
      this.#models = [];
      this.#push("custom-id");
      this.#panel.openInput("");
      return;
    }
    if (value.startsWith("provider:")) {
      const id = value.slice("provider:".length);
      this.#providerID = id;
      this.#customMode = false;
      this.loadProviderDraft(id);
      this.#push("provider-groups");
      return;
    }
    if (value.startsWith("api:")) {
      this.#provider.api = value.slice("api:".length);
      this.#pop();
      return;
    }
    if (value.startsWith("header:")) {
      const key = value.slice("header:".length);
      delete this.#provider.headers[key];
      if (Object.keys(this.#provider.headers).length === 0) {
        this.#provider.headers = {};
      }
      return;
    }
    if (value === "header-add") {
      this.#headerPhase = "key";
      this.#headerKeyDraft = "";
      this.#paramField = "header";
      this.#panel.openInput("");
      return;
    }
    if (value.startsWith("model:")) {
      this.#currentModelID = value.slice("model:".length);
      this.#push("model-groups");
      return;
    }
    if (value === "model-add") {
      this.#push("add-model-id");
      this.#panel.openInput("");
      return;
    }
    if (value.startsWith("field:")) {
      this.selectField(value.slice("field:".length));
      return;
    }
    // Direct-view navigation values.
    const directViews: AuthView[] = [
      "api-choice",
      "credentials",
      "protocol",
      "network",
      "advanced",
      "headers",
      "responses",
      "model-list",
      "model-basics",
      "model-capabilities",
      "model-sampling",
      "model-cost",
      "model-compat",
    ];
    if (directViews.includes(value as AuthView) || value === "done") {
      if (value === "done") {
        this.confirm();
        return;
      }
      this.#push(value as AuthView);
      return;
    }
  }

  private selectField(encoded: string): void {
    const sep = encoded.indexOf(":");
    const storeName = encoded.slice(0, sep) as FieldSpec["store"];
    const key = encoded.slice(sep + 1);
    const spec = this.findSpec(storeName, key);
    if (spec === undefined) return;
    const store = this.#storeFor(spec);

    switch (spec.kind) {
      case "bool":
        store[key] = !store[key];
        return;
      case "tri":
        store[key] = cycleTri(store[key] as TriBool);
        return;
      case "cycle": {
        const values = spec.values ?? [];
        const current = values.indexOf(String(store[key] ?? ""));
        store[key] = values[(current + 1) % values.length] ?? "";
        return;
      }
      case "text":
      case "int":
      case "float":
        this.#paramField = `${spec.store}:${spec.key}`;
        this.#panel.openInput(formatInputInitial(spec, store[key]));
        return;
    }
  }

  private findSpec(
    storeName: FieldSpec["store"],
    key: string,
  ): FieldSpec | undefined {
    for (const specs of Object.values(FIELD_TABLE)) {
      const found = specs?.find((s) => s.store === storeName && s.key === key);
      if (found) return found;
    }
    return undefined;
  }

  // ── text submission ───────────────────────────────────────────────────────

  submit(value: string): void {
    if (this.#view === "custom-id") {
      const id = value.trim();
      if (id === "" || /[\s/\\]/.test(id)) {
        this.#error = this.#host.translator.text("dialog.auth.custom_invalid");
        return;
      }
      this.#providerID = id;
      this.#panel.closeInput();
      this.#view = "provider-groups";
      this.#panel.resetCursor();
      return;
    }

    if (this.#view === "add-model-id") {
      const id = value.trim();
      if (id === "" || /\s/.test(id)) {
        this.#error = this.#host.translator.text(
          "dialog.auth.add_model_invalid",
        );
        return;
      }
      if (this.#models.some((m) => m.id === id)) {
        this.#error = this.#host.translator.text(
          "dialog.auth.add_model_exists",
        );
        return;
      }
      const draft = blankModel(id);
      this.#models.push(draft);
      this.#currentModelID = id;
      this.#panel.closeInput();
      this.#view = "model-groups";
      this.#panel.resetCursor();
      return;
    }

    if (this.#paramField === "header") {
      this.submitHeader(value);
      return;
    }

    if (this.#paramField !== "") {
      this.submitField(value);
    }
  }

  private submitHeader(value: string): void {
    const tr = this.#host.translator;
    if (this.#headerPhase === "key") {
      const key = value.trim();
      if (key === "") {
        this.#error = tr.text("dialog.auth.header_key_required");
        return;
      }
      this.#headerKeyDraft = key;
      this.#headerPhase = "value";
      this.#panel.openInput(this.#provider.headers[key] ?? "");
      return;
    }
    this.#provider.headers[this.#headerKeyDraft] = value;
    this.#headerKeyDraft = "";
    this.#headerPhase = "key";
    this.#paramField = "";
    this.#panel.closeInput();
  }

  private submitField(value: string): void {
    const tr = this.#host.translator;
    const [storeName, key] = this.#paramField.split(":", 2);
    const spec = this.findSpec(storeName as FieldSpec["store"], key);
    if (spec === undefined) {
      this.#paramField = "";
      this.#panel.closeInput();
      return;
    }
    const store = this.#storeFor(spec);
    const trimmed = value.trim();

    if (spec.kind === "text") {
      store[key] = parseTextValue(spec, trimmed);
    } else {
      if (trimmed === "") {
        store[key] = spec.kind === "float" ? null : 0;
      } else {
        const parsed = spec.kind === "int"
          ? Number.parseInt(trimmed, 10)
          : Number.parseFloat(trimmed);
        if (Number.isNaN(parsed)) {
          this.#error = tr.text(
            spec.kind === "int"
              ? "dialog.auth.error_int"
              : "dialog.auth.error_float",
          );
          return;
        }
        store[key] = parsed;
      }
    }
    this.#paramField = "";
    this.#panel.closeInput();
  }

  // ── printable keys (no input active) ─────────────────────────────────────

  key(_name: string): void {
    // List views rely on Enter/Esc only.
  }

  // ── confirm & persist ────────────────────────────────────────────────────

  confirm(): void {
    const tr = this.#host.translator;
    const config = providerConfigFromDraft(this.#provider, this.#models);
    try {
      // saveGlobalSettingsPatch replaces top-level keys wholesale: merge the
      // edited provider into the existing map, otherwise every other provider
      // (and its API key) would be wiped from settings.json.
      const sparse = loadGlobalSettingsSparse();
      const providers = { ...(sparse.providers ?? {}) };
      providers[this.#providerID] = config;
      saveGlobalSettingsPatch({ providers });
    } catch (err) {
      this.#error = tr.text("settings.save_failed", (err as Error).message);
      return;
    }
    const firstModel = config.models[0]?.id ?? "";
    this.#host.reloadSettings();
    if (firstModel !== "") this.#host.applyModel(this.#providerID, firstModel);
    this.#panel.close(
      tr.text("dialog.auth.saved", this.#providerID, firstModel),
    );
  }
}

// ── conversions: config → draft ──────────────────────────────────────────────

function blankProvider(): ProviderDraft {
  return {
    api: "openai-chat",
    apiKey: "",
    baseUrl: "",
    vendor: "",
    httpProxy: "",
    forceHTTP11: false,
    headers: {},
    thinkingFormat: "",
    cacheControl: null,
    maxImagesPerRequest: 0,
    responses: blankResponses(),
  };
}

function blankResponses(): ResponsesDraft {
  return {
    reasoningSummary: "",
    promptCacheEnabled: null,
    promptCacheKey: "",
    promptCacheRetention: "",
    stateMode: "",
    store: null,
    conversation: "",
    truncation: "",
    background: null,
    include: [],
    serviceTier: "",
    toolChoice: "",
    toolParallel: null,
    toolMaxCalls: 0,
  };
}

function providerDraftFrom(cfg: ProviderConfig | undefined): ProviderDraft {
  const draft = blankProvider();
  if (cfg === undefined) return draft;
  draft.api = cfg.api ?? "openai-chat";
  draft.apiKey = cfg.apiKey ?? "";
  draft.baseUrl = cfg.baseUrl ?? "";
  draft.vendor = cfg.vendor ?? "";
  draft.httpProxy = cfg.httpProxy ?? "";
  draft.forceHTTP11 = cfg.forceHTTP11 ?? false;
  draft.headers = { ...(cfg.headers ?? {}) };
  draft.thinkingFormat = cfg.thinkingFormat ?? "";
  draft.cacheControl = cfg.cacheControl === undefined ? null : cfg.cacheControl;
  draft.maxImagesPerRequest = cfg.maxImagesPerRequest ?? 0;
  draft.responses = responsesDraftFrom(cfg.responses);
  return draft;
}

function responsesDraftFrom(cfg: ResponsesConfig | undefined): ResponsesDraft {
  const draft = blankResponses();
  if (cfg === undefined) return draft;
  draft.reasoningSummary = cfg.reasoningSummary ?? "";
  draft.promptCacheEnabled = cfg.promptCacheEnabled === undefined
    ? null
    : cfg.promptCacheEnabled;
  draft.promptCacheKey = cfg.promptCacheKey ?? "";
  draft.promptCacheRetention = cfg.promptCacheRetention ?? "";
  draft.stateMode = cfg.stateMode ?? "";
  draft.store = cfg.store === undefined ? null : cfg.store;
  draft.conversation = cfg.conversation ?? "";
  draft.truncation = cfg.truncation ?? "";
  draft.background = cfg.background === undefined ? null : cfg.background;
  draft.include = [...(cfg.include ?? [])];
  draft.serviceTier = cfg.serviceTier ?? "";
  draft.toolChoice = cfg.toolControl?.choice ?? "";
  draft.toolParallel = cfg.toolControl?.parallel === undefined
    ? null
    : cfg.toolControl.parallel;
  draft.toolMaxCalls = cfg.toolControl?.maxCalls ?? 0;
  return draft;
}

function blankModel(id: string): ModelDraft {
  return {
    id,
    name: id,
    contextWindow: 0,
    maxTokens: 0,
    reasoning: false,
    input: ["text"],
    temperature: null,
    topP: null,
    costEnabled: false,
    costInput: 0,
    costOutput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    compat: blankCompat(),
  };
}

function blankCompat(): CompatDraft {
  return {
    active: false,
    thinkingFormat: "",
    requiresReasoningContentOnAssistant: false,
    requiresReasoningContentOnAssistantMessages: false,
    forceAdaptiveThinking: false,
    parseReasoningInContent: false,
    supportsDeveloperRole: null,
    supportsStore: null,
    supportsReasoningEffort: null,
    supportsStrictMode: null,
    maxTokensField: "",
    disableSamplingParams: null,
    supportsCacheControlOnTools: null,
    supportsLongCacheRetention: null,
    supportsPromptCacheKey: null,
    supportsReasoningSummary: null,
    sendSessionAffinityHeaders: false,
    supportsEagerToolInputStreaming: null,
    supportsToolChoice: null,
    supportsParallelToolCalls: null,
  };
}

function modelDraftFrom(cfg: ModelConfig): ModelDraft {
  const draft = blankModel(cfg.id);
  draft.name = cfg.name ?? cfg.id;
  draft.contextWindow = cfg.contextWindow ?? 0;
  draft.maxTokens = cfg.maxTokens ?? 0;
  draft.reasoning = cfg.reasoning ?? false;
  draft.input = cfg.input?.length ? [...cfg.input] : ["text"];
  draft.temperature = cfg.temperature === undefined ? null : cfg.temperature;
  draft.topP = cfg.top_p === undefined ? null : cfg.top_p;
  if (cfg.cost !== undefined) {
    draft.costEnabled = true;
    draft.costInput = cfg.cost.input ?? 0;
    draft.costOutput = cfg.cost.output ?? 0;
    draft.cacheRead = cfg.cost.cacheRead ?? 0;
    draft.cacheWrite = cfg.cost.cacheWrite ?? 0;
  }
  draft.compat = compatDraftFrom(cfg.compat);
  return draft;
}

function compatDraftFrom(cfg: ModelCompat | undefined): CompatDraft {
  const draft = blankCompat();
  if (cfg === undefined) return draft;
  draft.active = true;
  draft.thinkingFormat = cfg.thinkingFormat ?? "";
  draft.requiresReasoningContentOnAssistant =
    cfg.requiresReasoningContentOnAssistant ?? false;
  draft.requiresReasoningContentOnAssistantMessages =
    cfg.requiresReasoningContentOnAssistantMessages ?? false;
  draft.forceAdaptiveThinking = cfg.forceAdaptiveThinking ?? false;
  draft.parseReasoningInContent = cfg.parseReasoningInContent ?? false;
  draft.supportsDeveloperRole = triFromBool(cfg.supportsDeveloperRole);
  draft.supportsStore = triFromBool(cfg.supportsStore);
  draft.supportsReasoningEffort = triFromBool(cfg.supportsReasoningEffort);
  draft.supportsStrictMode = triFromBool(cfg.supportsStrictMode);
  draft.maxTokensField = cfg.maxTokensField ?? "";
  draft.disableSamplingParams = triFromBool(cfg.disableSamplingParams);
  draft.supportsCacheControlOnTools = triFromBool(
    cfg.supportsCacheControlOnTools,
  );
  draft.supportsLongCacheRetention = triFromBool(
    cfg.supportsLongCacheRetention,
  );
  draft.supportsPromptCacheKey = triFromBool(cfg.supportsPromptCacheKey);
  draft.supportsReasoningSummary = triFromBool(cfg.supportsReasoningSummary);
  draft.sendSessionAffinityHeaders = cfg.sendSessionAffinityHeaders ?? false;
  draft.supportsEagerToolInputStreaming = triFromBool(
    cfg.supportsEagerToolInputStreaming,
  );
  draft.supportsToolChoice = triFromBool(cfg.supportsToolChoice);
  draft.supportsParallelToolCalls = triFromBool(cfg.supportsParallelToolCalls);
  return draft;
}

// ── conversions: draft → config ─────────────────────────────────────────────

function providerConfigFromDraft(
  draft: ProviderDraft,
  models: ModelDraft[],
): ProviderConfig {
  return {
    api: draft.api,
    apiKey: draft.apiKey,
    baseUrl: draft.baseUrl,
    vendor: draft.vendor,
    httpProxy: draft.httpProxy,
    forceHTTP11: draft.forceHTTP11,
    headers: { ...draft.headers },
    thinkingFormat: draft.thinkingFormat,
    cacheControl: draft.cacheControl === null ? undefined : draft.cacheControl,
    maxImagesPerRequest: draft.maxImagesPerRequest,
    responses: responsesConfigFromDraft(draft.responses),
    models: models.map(modelConfigFromDraft),
  };
}

function responsesConfigFromDraft(draft: ResponsesDraft): ResponsesConfig {
  const toolControl: ResponsesToolControlConfig = {};
  if (draft.toolChoice !== "") toolControl.choice = draft.toolChoice;
  if (draft.toolParallel !== null) toolControl.parallel = draft.toolParallel;
  if (draft.toolMaxCalls > 0) toolControl.maxCalls = draft.toolMaxCalls;
  return {
    reasoningSummary: draft.reasoningSummary,
    promptCacheEnabled: draft.promptCacheEnabled === null
      ? undefined
      : draft.promptCacheEnabled,
    promptCacheKey: draft.promptCacheKey,
    promptCacheRetention: draft.promptCacheRetention,
    stateMode: draft.stateMode,
    store: draft.store === null ? undefined : draft.store,
    conversation: draft.conversation,
    truncation: draft.truncation,
    background: draft.background === null ? undefined : draft.background,
    include: [...draft.include],
    serviceTier: draft.serviceTier,
    toolControl,
  };
}

function modelConfigFromDraft(draft: ModelDraft): ModelConfig {
  const config: ModelConfig = {
    id: draft.id,
    name: draft.name,
    reasoning: draft.reasoning,
    contextWindow: draft.contextWindow,
    maxTokens: draft.maxTokens,
    temperature: draft.temperature === null ? undefined : draft.temperature,
    top_p: draft.topP === null ? undefined : draft.topP,
    input: [...draft.input],
  };
  if (draft.costEnabled) {
    config.cost = {
      input: draft.costInput,
      output: draft.costOutput,
      cacheRead: draft.cacheRead,
      cacheWrite: draft.cacheWrite,
    };
  }
  config.compat = compatConfigFromDraft(draft.compat);
  return config;
}

function compatConfigFromDraft(draft: CompatDraft): ModelCompat | undefined {
  if (!draft.active && !hasAnyCompatValue(draft)) return undefined;
  return {
    thinkingFormat: draft.thinkingFormat,
    requiresReasoningContentOnAssistant:
      draft.requiresReasoningContentOnAssistant,
    requiresReasoningContentOnAssistantMessages:
      draft.requiresReasoningContentOnAssistantMessages,
    forceAdaptiveThinking: draft.forceAdaptiveThinking,
    parseReasoningInContent: draft.parseReasoningInContent,
    supportsDeveloperRole: triToBool(draft.supportsDeveloperRole),
    supportsStore: triToBool(draft.supportsStore),
    supportsReasoningEffort: triToBool(draft.supportsReasoningEffort),
    supportsStrictMode: triToBool(draft.supportsStrictMode),
    maxTokensField: draft.maxTokensField,
    disableSamplingParams: triToBool(draft.disableSamplingParams),
    supportsCacheControlOnTools: triToBool(draft.supportsCacheControlOnTools),
    supportsLongCacheRetention: triToBool(draft.supportsLongCacheRetention),
    supportsPromptCacheKey: triToBool(draft.supportsPromptCacheKey),
    supportsReasoningSummary: triToBool(draft.supportsReasoningSummary),
    sendSessionAffinityHeaders: draft.sendSessionAffinityHeaders,
    supportsEagerToolInputStreaming: triToBool(
      draft.supportsEagerToolInputStreaming,
    ),
    supportsToolChoice: triToBool(draft.supportsToolChoice),
    supportsParallelToolCalls: triToBool(draft.supportsParallelToolCalls),
  };
}

function hasAnyCompatValue(draft: CompatDraft): boolean {
  return draft.thinkingFormat !== "" ||
    draft.requiresReasoningContentOnAssistant ||
    draft.requiresReasoningContentOnAssistantMessages ||
    draft.forceAdaptiveThinking ||
    draft.parseReasoningInContent ||
    draft.supportsDeveloperRole !== null ||
    draft.supportsStore !== null ||
    draft.supportsReasoningEffort !== null ||
    draft.supportsStrictMode !== null ||
    draft.maxTokensField !== "" ||
    draft.disableSamplingParams !== null ||
    draft.supportsCacheControlOnTools !== null ||
    draft.supportsLongCacheRetention !== null ||
    draft.supportsPromptCacheKey !== null ||
    draft.supportsReasoningSummary !== null ||
    draft.sendSessionAffinityHeaders ||
    draft.supportsEagerToolInputStreaming !== null ||
    draft.supportsToolChoice !== null ||
    draft.supportsParallelToolCalls !== null;
}

// ── value formatting ────────────────────────────────────────────────────────

function triFromBool(v: boolean | undefined): TriBool {
  return v === undefined ? null : v;
}

function triToBool(v: TriBool): boolean | undefined {
  return v === null ? undefined : v;
}

function cycleTri(v: TriBool): TriBool {
  if (v === null) return true;
  if (v === true) return false;
  return null;
}

function triLabel(v: TriBool, tr: AuthTranslator): string {
  if (v === null) return tr.text("auth.value.auto");
  return v ? tr.text("auth.value.on") : tr.text("auth.value.off");
}

function imageLimitLabel(v: number): string {
  if (v < 0) return "unlimited";
  if (v === 0) return "default";
  return String(v);
}

function intAuto(v: number): string {
  return v === 0 ? "auto" : String(v);
}

function numAuto(v: number | null): string {
  return v === null ? "auto" : String(v);
}

function maskSecret(s: string): string {
  if (s.startsWith("${") && s.endsWith("}")) return s;
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

function shortUrl(s: string): string {
  let v = s.replace(/^https?:\/\//, "");
  const slash = v.indexOf("/");
  if (slash > 0) v = v.slice(0, slash);
  return v.length > 30 ? `${v.slice(0, 27)}...` : v;
}

function modelSummary(m: ModelDraft): string {
  return `ctx=${intAuto(m.contextWindow)} max=${intAuto(m.maxTokens)}` +
    `${m.reasoning ? " reasoning" : ""}`;
}

function compatSummary(c: CompatDraft, tr: AuthTranslator): string {
  if (!hasAnyCompatValue(c)) return tr.text("auth.value.none_active");
  return tr.text("auth.value.flags_active");
}

function describeValue(
  spec: FieldSpec,
  value: unknown,
  tr: AuthTranslator,
): string {
  switch (spec.kind) {
    case "bool":
      return value ? tr.text("auth.value.yes") : tr.text("auth.value.no");
    case "tri":
      return triLabel(value as TriBool, tr);
    case "int": {
      const n = Number(value);
      if (spec.key === "maxImagesPerRequest") return imageLimitLabel(n);
      return intAuto(n);
    }
    case "float":
      return numAuto(value as number | null);
    case "cycle":
      return String(value ?? "") || tr.text("auth.value.auto");
    case "text": {
      const s = String(value ?? "");
      if (spec.key === "apiKey" && s !== "") return maskSecret(s);
      return s;
    }
  }
}

function formatInputInitial(spec: FieldSpec, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (spec.key === "input" && Array.isArray(value)) return value.join(",");
  return String(value);
}

function parseTextValue(spec: FieldSpec, value: string): unknown {
  if (spec.key === "input") {
    return value.split(",").map((s) => s.trim()).filter((s) => s !== "");
  }
  return value;
}

// ── provider listing (wired to config + factory) ────────────────────────────

function fieldTitleKey(view: AuthView): string {
  switch (view) {
    case "credentials":
      return "dialog.auth.credentials_title";
    case "protocol":
      return "dialog.auth.protocol_title";
    case "network":
      return "dialog.auth.network_title";
    case "advanced":
      return "dialog.auth.advanced_title";
    case "responses":
      return "dialog.auth.responses_title";
    case "model-basics":
      return "dialog.auth.m_basics_title";
    case "model-capabilities":
      return "dialog.auth.m_capabilities_title";
    case "model-sampling":
      return "dialog.auth.m_sampling_title";
    case "model-cost":
      return "dialog.auth.m_cost_title";
    case "model-compat":
      return "dialog.auth.m_compat_title";
    default:
      return "dialog.auth.title";
  }
}

function providerIDsFromSettings(settings: Settings): string[] {
  const ids = new Set<string>();
  for (const id of Object.keys(defaultProviderPresets())) ids.add(id);
  for (const id of Object.keys(settings.providers ?? {})) ids.add(id);
  return [...ids].sort();
}

// Indirection keeps presets overridable in tests.
let presets: Record<string, ProviderConfig> | undefined;

function defaultProviderPresets(): Record<string, ProviderConfig> {
  if (presets !== undefined) return presets;
  presets = defaultProviderConfigsAll();
  return presets;
}
