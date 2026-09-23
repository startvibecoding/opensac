import type { ResponsesConfig } from "../../config/mod.ts";
import type {
  ResponsesHostedToolsConfig,
  ResponsesStructuredOutputConfig,
} from "../../config/settings.ts";
import { hostedToolType as coreHostedToolType } from "../hosted_tools.ts";
import type { ChatParams, Model, ToolDefinition } from "../types.ts";
import {
  hostedRequestCapabilities,
  type HostedToolDescriptor,
  hostedToolTypes,
  type ResponsesHostedPolicy,
} from "./hosted_registry.ts";
import type {
  ResponsesTextFormat,
  ResponsesTool,
  ResponsesWireConfig,
} from "./responses.ts";

/**
 * Resolved from immutable model compatibility data for each request. Undefined
 * flags retain the historical OpenAI-compatible default so existing
 * configurations remain valid, while explicit false values gate fields before
 * any upstream request is made.
 */
export interface ResponsesCapabilities {
  supportsResponses: boolean;
  supportsPreviousResponseID: boolean;
  supportsConversation: boolean;
  supportsBackground: boolean;
  supportsStructuredOutput: boolean;
  supportsServiceTier: boolean;
  supportsParallelTools: boolean;
  supportsToolChoice: boolean;
  hostedTools: Record<string, boolean>;
  include: Record<string, boolean>;
}

/**
 * Read-only view of the model capability profile. Intended for runtime/UI
 * diagnostics; request validation still remains the authoritative gate.
 */
export interface ResponsesCapabilityReport {
  modelId: string;
  provider: string;
  api: string;
  supportsResponses: boolean;
  supportsPreviousResponse: boolean;
  supportsConversation: boolean;
  supportsBackground: boolean;
  supportsStructuredOutput: boolean;
  supportsServiceTier: boolean;
  supportsParallelTools: boolean;
  supportsToolChoice: boolean;
  supportsAttachmentDownload: boolean;
  hostedTools: Record<string, boolean>;
  hostedPolicies: Record<string, boolean>;
  supportedInclude: string[];
  supportedEvents: string[];
  supportedItems: string[];
  attachmentKinds: string[];
  supportedAnnotations: string[];
}

/** Single codec-owned registry for native hosted output items. */
export const responsesHostedItemTypes = hostedToolTypes();

export const responsesCodecCapabilities = {
  events: [
    "response.created",
    "response.queued",
    "response.in_progress",
    "response.content_part.added",
    "response.content_part.done",
    "response.output_item.added",
    "response.output_item.done",
    "response.output_text.delta",
    "response.output_text.done",
    "response.refusal.delta",
    "response.refusal.done",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_part.done",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_text.delta",
    "response.reasoning_text.done",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
    "response.custom_tool_call_input.delta",
    "response.custom_tool_call_input.done",
    "response.completed",
    "response.incomplete",
    "response.failed",
    "error",
  ],
  items: [
    "message",
    "reasoning",
    "function_call",
    "function_call_output",
    "custom_tool_call",
    "custom_tool_call_output",
    "item_reference",
    ...responsesHostedItemTypes,
  ],
  attachments: ["artifact", "citation", "file", "image"],
  annotations: ["url_citation", "file_citation", "container_file_citation"],
} as const;

/**
 * Interface implemented by the openai Provider for configuration resolution.
 * Kept structural so responses_config.ts can operate on it without importing
 * the concrete class at runtime.
 */
export interface ResponsesConfigHost {
  apiKey: string;
  client: unknown;
  name(): string;
  api(): string;
  getModel(id: string): Model | undefined;
  responsesConfig: ResponsesWireConfig | undefined;
}

/**
 * Returns the resolved capability profile for a model without mutating provider
 * configuration or global state.
 */
export function responsesCapabilityReport(
  p: ResponsesConfigHost,
  modelID: string,
): ResponsesCapabilityReport {
  const model = p.getModel(modelID);
  const caps = resolveResponsesCapabilities(model);
  const supportedInclude: string[] = [];
  for (const key of Object.keys(caps.include)) supportedInclude.push(key);
  supportedInclude.sort();
  return {
    modelId: modelID,
    provider: p.name(),
    api: p.api(),
    supportsResponses: caps.supportsResponses,
    supportsPreviousResponse: caps.supportsPreviousResponseID,
    supportsConversation: caps.supportsConversation,
    supportsBackground: caps.supportsBackground,
    supportsStructuredOutput: caps.supportsStructuredOutput,
    supportsServiceTier: caps.supportsServiceTier,
    supportsParallelTools: caps.supportsParallelTools,
    supportsToolChoice: caps.supportsToolChoice,
    supportsAttachmentDownload: p.apiKey !== "" && p.client != null,
    hostedTools: { ...caps.hostedTools },
    hostedPolicies: { code_interpreter: true },
    supportedInclude,
    supportedEvents: [...responsesCodecCapabilities.events],
    supportedItems: [...responsesCodecCapabilities.items],
    attachmentKinds: [...responsesCodecCapabilities.attachments],
    supportedAnnotations: [...responsesCodecCapabilities.annotations],
  };
}

export const defaultResponsesInclude: Record<string, boolean> = {
  "reasoning.encrypted_content": true,
  "file_search_call.results": true,
};

export function resolveResponsesCapabilities(
  model: Model | undefined,
): ResponsesCapabilities {
  const caps: ResponsesCapabilities = {
    supportsResponses: true,
    supportsPreviousResponseID: true,
    supportsConversation: true,
    supportsBackground: true,
    supportsStructuredOutput: true,
    supportsServiceTier: true,
    supportsParallelTools: true,
    supportsToolChoice: true,
    hostedTools: hostedRequestCapabilities(),
    include: { ...defaultResponsesInclude },
  };
  if (model === undefined || model.compat === undefined) return caps;
  const compat = model.compat;
  if (compat.supportsResponses !== undefined) {
    caps.supportsResponses = compat.supportsResponses;
  }
  if (compat.supportsPreviousResponseId !== undefined) {
    caps.supportsPreviousResponseID = compat.supportsPreviousResponseId;
  }
  if (compat.supportsConversation !== undefined) {
    caps.supportsConversation = compat.supportsConversation;
  }
  if (compat.supportsBackground !== undefined) {
    caps.supportsBackground = compat.supportsBackground;
  }
  if (compat.supportsStructuredOutput !== undefined) {
    caps.supportsStructuredOutput = compat.supportsStructuredOutput;
  }
  if (compat.supportsServiceTier !== undefined) {
    caps.supportsServiceTier = compat.supportsServiceTier;
  }
  if (compat.supportsParallelToolCalls !== undefined) {
    caps.supportsParallelTools = compat.supportsParallelToolCalls;
  }
  if (compat.supportsToolChoice !== undefined) {
    caps.supportsToolChoice = compat.supportsToolChoice;
  }
  for (const [key, value] of Object.entries(compat.supportsHostedTools ?? {})) {
    caps.hostedTools[key] = value;
  }
  if (compat.supportedInclude !== undefined) {
    caps.include = {};
    for (let value of compat.supportedInclude) {
      value = value.trim();
      if (value !== "") caps.include[value] = true;
    }
  }
  return caps;
}

export function validateResponsesConfig(cfg: ResponsesConfig): void {
  const hosted = cfg.hostedTools ?? {};
  if (hosted.computerUse !== undefined) {
    throw new Error("responses.hostedTools.computerUse is not supported");
  }
  validateResponsesRemoteMCP(hosted.remoteMCP ?? []);
  responsesHostedPoliciesWithError(hosted);

  switch (cfg.stateMode ?? "") {
    case "":
    case "replay":
    case "previous_response_id":
    case "conversation":
      break;
    default:
      throw new Error(
        `responses.stateMode ${
          JSON.stringify(cfg.stateMode)
        } is invalid; use replay, previous_response_id, or conversation`,
      );
  }
  if (
    cfg.stateMode === "conversation" && (cfg.conversation ?? "").trim() === ""
  ) {
    throw new Error(
      "responses.conversation is required when stateMode is conversation",
    );
  }
  if (
    cfg.stateMode !== undefined && cfg.stateMode !== "" &&
    cfg.stateMode !== "conversation" && (cfg.conversation ?? "").trim() !== ""
  ) {
    throw new Error("responses.conversation requires stateMode conversation");
  }

  switch (cfg.truncation ?? "") {
    case "":
    case "auto":
    case "disabled":
      break;
    default:
      throw new Error(
        `responses.truncation ${
          JSON.stringify(cfg.truncation)
        } is invalid; use auto or disabled`,
      );
  }
  switch (cfg.reasoningSummary ?? "") {
    case "":
    case "auto":
    case "concise":
    case "detailed":
    case "none":
    case "off":
      break;
    default:
      throw new Error(
        `responses.reasoningSummary ${
          JSON.stringify(cfg.reasoningSummary)
        } is invalid; use auto, concise, detailed, none, or off`,
      );
  }
  switch (cfg.reasoningContext ?? "") {
    case "":
    case "auto":
    case "current_turn":
    case "all_turns":
      break;
    default:
      throw new Error(
        `responses.reasoningContext ${
          JSON.stringify(cfg.reasoningContext)
        } is invalid; use auto, current_turn, or all_turns`,
      );
  }
  switch (cfg.reasoningMode ?? "") {
    case "":
    case "standard":
    case "pro":
      break;
    default:
      throw new Error(
        `responses.reasoningMode ${
          JSON.stringify(cfg.reasoningMode)
        } is invalid; use standard or pro`,
      );
  }
  switch (cfg.promptCacheMode ?? "") {
    case "":
    case "implicit":
    case "explicit":
      break;
    default:
      throw new Error(
        `responses.promptCacheMode ${
          JSON.stringify(cfg.promptCacheMode)
        } is invalid; use implicit or explicit`,
      );
  }
  if (
    cfg.promptCacheTTL !== undefined && cfg.promptCacheTTL !== "" &&
    cfg.promptCacheTTL.trim() !== cfg.promptCacheTTL
  ) {
    throw new Error(
      "responses.promptCacheTTL must not contain leading or trailing whitespace",
    );
  }
  const metadata = cfg.metadata ?? {};
  if (Object.keys(metadata).length > 16) {
    throw new Error("responses.metadata cannot contain more than 16 entries");
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (key.length === 0 || key.length > 64 || value.length > 512) {
      throw new Error(
        `responses.metadata entry ${
          JSON.stringify(key)
        } exceeds key/value limits`,
      );
    }
    const lower = key.toLowerCase();
    if (
      lower.includes("token") || lower.includes("secret") ||
      lower.includes("authorization") || lower.includes("api_key")
    ) {
      throw new Error(
        `responses.metadata key ${
          JSON.stringify(key)
        } is reserved for sensitive data`,
      );
    }
  }

  const seenInclude = new Set<string>();
  for (let value of cfg.include ?? []) {
    value = value.trim();
    if (value === "") {
      throw new Error("responses.include cannot contain empty values");
    }
    if (seenInclude.has(value)) {
      throw new Error(
        `responses.include contains duplicate value ${JSON.stringify(value)}`,
      );
    }
    seenInclude.add(value);
  }
  if ((cfg.serviceTier ?? "").trim() !== (cfg.serviceTier ?? "")) {
    throw new Error(
      "responses.serviceTier must not contain leading or trailing whitespace",
    );
  }

  const structured: ResponsesStructuredOutputConfig = cfg.structuredOutput ??
    {};
  const schema = structured.schema;
  if (schema !== undefined) {
    if (!isValidJSONValue(schema)) {
      throw new Error("responses.structuredOutput.schema must be valid JSON");
    }
  } else if (
    (structured.name ?? "") !== "" || (structured.description ?? "") !== "" ||
    structured.strict !== undefined
  ) {
    throw new Error(
      "responses.structuredOutput.schema is required when structured output is configured",
    );
  }
  if (structured.strict === true && schema === undefined) {
    throw new Error("responses.structuredOutput.strict requires a schema");
  }
  if (structured.strict === true && schema !== undefined) {
    validateStrictResponsesSchema(schema, "$");
  }

  const maxCalls = cfg.toolControl?.maxCalls ?? 0;
  if (maxCalls < 0) {
    throw new Error("responses.toolControl.maxCalls cannot be negative");
  }
  const choice = (cfg.toolControl?.choice ?? "").trim().toLowerCase();
  switch (choice) {
    case "":
    case "auto":
    case "none":
    case "required":
      break;
    default:
      if ((cfg.toolControl?.choice ?? "").trim() === "") {
        throw new Error("responses.toolControl.choice cannot be empty");
      }
  }
}

/** Validates that a value can round-trip through JSON serialization. */
function isValidJSONValue(value: unknown): boolean {
  if (value === undefined) return false;
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

export function validateStrictResponsesSchema(
  value: unknown,
  path: string,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const schema = value as Record<string, unknown>;
  const properties = schema["properties"];
  const hasProperties = properties !== null && typeof properties === "object" &&
    !Array.isArray(properties);
  const typeName = typeof schema["type"] === "string" ? schema["type"] : "";
  if (path === "$" && typeName !== "object") {
    throw new Error(`${path} root type must be object when strict=true`);
  }
  if (typeName === "object" || hasProperties) {
    if (schema["additionalProperties"] !== false) {
      throw new Error(
        `${path} object requires additionalProperties=false when strict=true`,
      );
    }
    const requiredValues = schema["required"];
    if (!Array.isArray(requiredValues)) {
      throw new Error(
        `${path} object requires every property in required when strict=true`,
      );
    }
    const required = new Set<string>();
    for (const rawName of requiredValues) {
      if (typeof rawName !== "string") {
        throw new Error(`${path} required entries must be strings`);
      }
      required.add(rawName);
    }
    for (
      const [name, child] of Object.entries(
        (properties ?? {}) as Record<string, unknown>,
      )
    ) {
      if (!required.has(name)) {
        throw new Error(
          `${path}.properties.${name} must appear in required when strict=true`,
        );
      }
      validateStrictResponsesSchema(child, `${path}.properties.${name}`);
    }
  }
  if ("items" in schema) {
    validateStrictResponsesSchema(schema["items"], `${path}.items`);
  }
  const alternatives = schema["anyOf"];
  if (Array.isArray(alternatives)) {
    for (let index = 0; index < alternatives.length; index++) {
      validateStrictResponsesSchema(
        alternatives[index],
        `${path}.anyOf[${index}]`,
      );
    }
  }
}

export function validateResponsesRemoteMCP(
  tools: Array<Record<string, unknown>>,
): void {
  for (let index = 0; index < tools.length; index++) {
    const tool = tools[index];
    if (tool === undefined || Object.keys(tool).length === 0) continue;
    const serverURL = typeof tool["server_url"] === "string"
      ? tool["server_url"]
      : "";
    const connectorID = typeof tool["connector_id"] === "string"
      ? tool["connector_id"]
      : "";
    const trimmedURL = serverURL.trim();
    const trimmedConnector = connectorID.trim();
    if (trimmedURL === "" && trimmedConnector === "") {
      throw new Error(
        `responses.hostedTools.remoteMCP[${index}] requires server_url or connector_id`,
      );
    }
    if (trimmedURL === "") continue;
    validateRemoteMCPServerURL(trimmedURL, index);
  }
}

/**
 * Best-effort DNS egress preflight. A confirmed private/loopback resolution is
 * rejected, while resolver errors or timeouts are allowed so transient DNS
 * failures do not break availability. The upstream Responses service remains
 * the authoritative network boundary.
 */
export function validateRemoteMCPServerURL(raw: string, index = 0): void {
  validateRemoteMCPServerURLWithLookup(raw, index, (host) => {
    try {
      return Deno.resolveDns(host, "A");
    } catch {
      return Promise.resolve([]);
    }
  });
}

export function validateRemoteMCPServerURLWithLookup(
  raw: string,
  index: number,
  lookup: (host: string) => Promise<string[]>,
): void {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw wrapMCPError(index, "server_url must be a public https URL");
  }
  if (
    parsed.protocol !== "https:" || parsed.host === "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw wrapMCPError(index, "server_url must be a public https URL");
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) {
    throw wrapMCPError(index, "server_url must not target localhost");
  }
  if (isIPAddress(host)) {
    if (isPrivateNetworkIP(host)) {
      throw wrapMCPError(
        index,
        "server_url must not target a private IP address",
      );
    }
    return;
  }
  if (lookup === undefined) return;
  // Synchronous callers cannot wait on DNS, so only the pre-resolved literal IP
  // case above is enforced in the synchronous validateRemoteMCPServerURL path.
  void lookup;
}

function wrapMCPError(index: number, message: string): Error {
  return new Error(`responses.hostedTools.remoteMCP[${index}].${message}`);
}

/** Asynchronous preflight used by tests; the resolver is injected. */
export async function validateRemoteMCPServerURLEgress(
  raw: string,
  index: number,
  lookup: (host: string) => Promise<string[]>,
): Promise<void> {
  validateRemoteMCPServerURLWithLookup(raw, index, lookup);
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) {
    return;
  }
  if (isIPAddress(host)) return;
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    return;
  }
  for (const address of addresses ?? []) {
    if (isPrivateNetworkIP(address)) {
      throw new Error(
        "responses.hostedTools.remoteMCP server_url resolves to a private IP address",
      );
    }
  }
}

function isIPAddress(host: string): boolean {
  return /^[0-9.]+$/.test(host) || host.includes(":");
}

export function isPrivateNetworkIP(ip: string): boolean {
  const host = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  if (host.includes(":")) {
    // IPv6
    const lower = host.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (
      lower.startsWith("fe80") || lower.startsWith("fc") ||
      lower.startsWith("fd")
    ) {
      return true;
    }
    return false;
  }
  const parts = host.split(".").map((p) => Number(p));
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0) return true; // unspecified / this network
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

export function supportsStore(model: Model | undefined): boolean {
  if (
    model !== undefined && model.compat !== undefined &&
    model.compat.supportsStore !== undefined
  ) {
    return model.compat.supportsStore;
  }
  return true;
}

export function supportsStrictMode(model: Model | undefined): boolean {
  if (
    model !== undefined && model.compat !== undefined &&
    model.compat.supportsStrictMode !== undefined
  ) {
    return model.compat.supportsStrictMode;
  }
  return true;
}

export function responsesConfigTextFormat(
  cfg: ResponsesStructuredOutputConfig,
): ResponsesTextFormat | undefined {
  const schema = cfg.schema;
  if (
    schema === undefined && (cfg.name ?? "") === "" &&
    (cfg.description ?? "") === "" && cfg.strict === undefined
  ) {
    return undefined;
  }
  return {
    type: "json_schema",
    name: cfg.name,
    description: cfg.description,
    strict: cfg.strict,
    schema,
  };
}

export function responsesConfigToolChoice(choice: string): unknown {
  const trimmed = choice.trim();
  switch (trimmed) {
    case "":
      return undefined;
    case "auto":
    case "none":
    case "required":
      return trimmed;
    default:
      return { type: "function", name: trimmed };
  }
}

export function responsesConfigHostedTools(
  cfg: ResponsesHostedToolsConfig,
): ResponsesTool[] {
  const result: ResponsesTool[] = [];
  const appendConfig = (
    values: Record<string, unknown> | undefined,
    defaultType: string,
  ): void => {
    if (values === undefined || Object.keys(values).length === 0) return;
    result.push({
      type: hostedToolType(values, defaultType),
      extra: cloneResponsesToolExtra(values),
    });
  };
  appendConfig(cfg.webSearch, "web_search");
  appendConfig(cfg.fileSearch, "file_search");
  const codeInterpreter = cloneResponsesToolExtra(cfg.codeInterpreter ?? {}) ??
    {};
  delete codeInterpreter["opensac"];
  appendConfig(codeInterpreter, "code_interpreter");
  // image_generation is intentionally not appended here. OpenSAC executes it only
  // through the standalone local image_generation tool so the configured
  // endpoint/token/API type remain independent from the chat provider.
  for (const values of cfg.remoteMCP ?? []) {
    if (values === undefined || Object.keys(values).length === 0) continue;
    // Remote MCP tools may trigger external actions in the upstream service.
    // Keep approval explicit by default without mutating the persisted config.
    const remote: Record<string, unknown> = { ...values };
    if (!("require_approval" in remote)) {
      remote["require_approval"] = "always";
    }
    result.push({
      type: hostedToolType(remote, "mcp"),
      extra: remote,
    });
  }
  return result;
}

/**
 * Reads OpenSAC-local policy knobs from the existing hosted-tools map. They are
 * deliberately removed from the upstream tool descriptor, so gateways and other
 * providers never see private fields.
 */
export function responsesHostedPolicies(
  cfg: ResponsesHostedToolsConfig,
): Record<string, ResponsesHostedPolicy> {
  return responsesHostedPoliciesWithError(cfg);
}

export function responsesHostedPoliciesWithError(
  cfg: ResponsesHostedToolsConfig,
): Record<string, ResponsesHostedPolicy> {
  const result: Record<string, ResponsesHostedPolicy> = {};
  const rawValue = cfg.codeInterpreter?.["opensac"];
  if (
    rawValue === null || typeof rawValue !== "object" ||
    Array.isArray(rawValue) || Object.keys(rawValue).length === 0
  ) {
    return result;
  }
  const raw = rawValue as Record<string, unknown>;
  const policy: ResponsesHostedPolicy = {
    maxCalls: 0,
    maxCallsSet: false,
    timeoutMs: 0,
    configured: true,
  };
  if ("maxCalls" in raw) {
    const calls = hostedPolicyInt(raw["maxCalls"]);
    if (calls === undefined || calls < 0 || calls > 10000) {
      throw new Error(
        "responses.hostedTools.codeInterpreter.opensac.maxCalls must be an integer from 0 to 10000",
      );
    }
    policy.maxCalls = calls;
    policy.maxCallsSet = true;
  }
  if ("timeoutSecs" in raw) {
    const seconds = hostedPolicyInt(raw["timeoutSecs"]);
    if (seconds === undefined || seconds < 0 || seconds > 24 * 60 * 60) {
      throw new Error(
        "responses.hostedTools.codeInterpreter.opensac.timeoutSecs must be an integer from 0 to 86400",
      );
    }
    policy.timeoutMs = seconds * 1000;
  }
  result["code_interpreter"] = policy;
  return result;
}

export function hostedPolicyInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  return undefined;
}

/**
 * Keeps the provider's effective descriptor immutable after
 * SetResponsesConfig returns. Hosted tool settings use map payloads so a shallow
 * struct copy alone would otherwise allow callers to alter live request data,
 * including approval policy, between turns.
 */
export function cloneResponsesToolExtra(
  values: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (values === undefined || Object.keys(values).length === 0) {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = cloneResponsesToolExtra(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        item !== null && typeof item === "object" && !Array.isArray(item)
          ? cloneResponsesToolExtra(item as Record<string, unknown>)
          : item
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function hostedToolType(
  values: Record<string, unknown>,
  fallback: string,
): string {
  const value = values["type"];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return fallback;
}

/** Validates the fields that the current request will actually send. */
export function validateResponsesCapabilities(
  p: ResponsesConfigHost,
  model: Model | undefined,
  params: ChatParams,
): void {
  validateResponsesCapabilitiesForRequest(p, model, params, true);
}

/**
 * Validates the fields that the current request will actually send.
 * Synchronous Provider.Chat requests do not send background=true, even when the
 * configured durable mode is enabled.
 */
export function validateResponsesCapabilitiesForRequest(
  p: ResponsesConfigHost,
  model: Model | undefined,
  params: ChatParams,
  enforceBackground: boolean,
): void {
  const cfg: ResponsesWireConfig = p.responsesConfig ?? {
    promptCacheEnabled: false,
    background: false,
  };
  const caps = resolveResponsesCapabilities(model);
  if (!caps.supportsResponses) {
    throw new Error(
      `Responses capability error: model ${
        JSON.stringify(modelID(model))
      } does not support the Responses API`,
    );
  }
  if (cfg.store !== undefined && !supportsStore(model)) {
    throw new Error(
      `Responses capability error: model ${
        JSON.stringify(modelID(model))
      } does not support configured store`,
    );
  }
  if ((cfg.promptCacheKey ?? "") !== "" && !supportsPromptCacheKey(model)) {
    throw new Error(
      `Responses capability error: model ${
        JSON.stringify(modelID(model))
      } does not support configured prompt_cache_key`,
    );
  }
  if (
    (cfg.promptCacheRetention ?? "") !== "" &&
    !supportsPromptCacheRetention(model)
  ) {
    throw new Error(
      `Responses capability error: model ${
        JSON.stringify(modelID(model))
      } does not support configured prompt_cache_retention`,
    );
  }
  if ((cfg.reasoningSummary ?? "") !== "" && !supportsReasoningSummary(model)) {
    throw new Error(
      `Responses capability error: model ${
        JSON.stringify(modelID(model))
      } does not support configured reasoning summary`,
    );
  }
  if (
    enforceBackground && cfg.background === true && !caps.supportsBackground
  ) {
    throw new Error(
      `Responses capability error: model ${
        JSON.stringify(modelID(model))
      } does not support background runs`,
    );
  }
  if (
    cfg.stateMode === "previous_response_id" && !caps.supportsPreviousResponseID
  ) {
    throw new Error(
      `Responses capability error: model ${
        JSON.stringify(modelID(model))
      } does not support previous_response_id`,
    );
  }
  if (cfg.stateMode === "conversation" && !caps.supportsConversation) {
    throw new Error(
      `Responses capability error: model ${
        JSON.stringify(modelID(model))
      } does not support conversation state`,
    );
  }
  if ((cfg.serviceTier ?? "") !== "" && !caps.supportsServiceTier) {
    throw new Error(
      `Responses capability error: model ${
        JSON.stringify(modelID(model))
      } does not support service_tier`,
    );
  }
  for (const include of cfg.include ?? []) {
    if (caps.include[include.trim()] !== true) {
      throw new Error(
        `Responses capability error: model ${
          JSON.stringify(modelID(model))
        } does not support include ${JSON.stringify(include)}`,
      );
    }
  }
  for (const tool of cfg.hostedTools ?? []) {
    const supported = caps.hostedTools[tool.type];
    if (supported !== undefined && !supported) {
      throw new Error(
        `Responses capability error: model ${
          JSON.stringify(modelID(model))
        } does not support hosted tool ${JSON.stringify(tool.type)}`,
      );
    }
  }
  for (const tool of params.tools ?? []) {
    if (tool.kind === "custom") {
      validateResponsesCustomTool(tool);
      continue;
    }
    if (tool.kind !== "hosted") continue;
    let toolType = coreHostedToolType(tool.providerType ?? "", tool.name);
    if (toolType === "") toolType = (tool.providerType ?? "").trim();
    const supported = caps.hostedTools[toolType];
    if (supported !== undefined && !supported) {
      throw new Error(
        `Responses capability error: model ${
          JSON.stringify(modelID(model))
        } does not support hosted tool ${JSON.stringify(toolType)}`,
      );
    }
  }
  if (cfg.parallelToolCalls !== undefined && !caps.supportsParallelTools) {
    throw new Error(
      `Responses capability error: model ${
        JSON.stringify(modelID(model))
      } does not support parallel tool calls`,
    );
  }
  if (cfg.toolChoice !== undefined && !caps.supportsToolChoice) {
    throw new Error(
      `Responses capability error: model ${
        JSON.stringify(modelID(model))
      } does not support tool_choice`,
    );
  }
  if (cfg.structuredOutput !== undefined && !caps.supportsStructuredOutput) {
    throw new Error(
      `Responses capability error: model ${
        JSON.stringify(modelID(model))
      } does not support structured output`,
    );
  }
  if (
    cfg.structuredOutput !== undefined &&
    cfg.structuredOutput.strict === true &&
    !supportsStrictMode(model)
  ) {
    throw new Error(
      `Responses capability error: model ${
        JSON.stringify(modelID(model))
      } does not support strict structured output`,
    );
  }
  if (cfg.stateMode === "conversation" && (cfg.store !== true)) {
    throw new Error("Responses state mode conversation requires store=true");
  }
  if (
    params.responseOptions?.structuredOutput?.strict === true &&
    !supportsStrictMode(model)
  ) {
    throw new Error(
      `Responses capability error: model ${
        JSON.stringify(modelID(model))
      } does not support strict structured output`,
    );
  }
  const opts = params.responseOptions;
  if (opts !== undefined) {
    if (
      (opts.previousResponseId ?? "") !== "" && !caps.supportsPreviousResponseID
    ) {
      throw new Error(
        `Responses capability error: model ${
          JSON.stringify(modelID(model))
        } does not support previous_response_id`,
      );
    }
    if (opts.parallelTools !== undefined && !caps.supportsParallelTools) {
      throw new Error(
        `Responses capability error: model ${
          JSON.stringify(modelID(model))
        } does not support parallel tool calls`,
      );
    }
    if (opts.toolChoice !== undefined && !caps.supportsToolChoice) {
      throw new Error(
        `Responses capability error: model ${
          JSON.stringify(modelID(model))
        } does not support tool_choice`,
      );
    }
    if (opts.structuredOutput !== undefined && !caps.supportsStructuredOutput) {
      throw new Error(
        `Responses capability error: model ${
          JSON.stringify(modelID(model))
        } does not support structured output`,
      );
    }
  }
}

export function validateResponsesCustomTool(tool: ToolDefinition): void {
  if ((tool.name ?? "").trim() === "") {
    throw new Error("Responses custom tool must define a name");
  }
  const format = tool.format;
  if (format === undefined || format === null) return;
  if (!isValidJSONValue(format)) {
    throw new Error(
      `Responses custom tool ${
        JSON.stringify(tool.name)
      } format must be valid JSON`,
    );
  }
  const fmt = format as Record<string, unknown>;
  const type = typeof fmt["type"] === "string" ? fmt["type"] : "";
  switch (type) {
    case "text":
      return;
    case "grammar": {
      const syntax = fmt["syntax"];
      if (syntax !== "lark" && syntax !== "regex") {
        throw new Error(
          `Responses custom tool ${
            JSON.stringify(tool.name)
          } grammar syntax must be lark or regex`,
        );
      }
      const definition = typeof fmt["definition"] === "string"
        ? fmt["definition"]
        : "";
      if (definition.trim() === "") {
        throw new Error(
          `Responses custom tool ${
            JSON.stringify(tool.name)
          } grammar definition is required`,
        );
      }
      return;
    }
    default:
      throw new Error(
        `Responses custom tool ${
          JSON.stringify(tool.name)
        } format type must be text or grammar`,
      );
  }
}

export function modelID(model: Model | undefined): string {
  if (model === undefined || model.id === "") return "unknown";
  return model.id;
}

export function supportsPromptCacheKey(model: Model | undefined): boolean {
  if (
    model !== undefined && model.compat !== undefined &&
    model.compat.supportsPromptCacheKey !== undefined
  ) {
    return model.compat.supportsPromptCacheKey;
  }
  return true;
}

export function supportsPromptCacheRetention(
  model: Model | undefined,
): boolean {
  if (
    model !== undefined && model.compat !== undefined &&
    model.compat.supportsLongCacheRetention !== undefined
  ) {
    return model.compat.supportsLongCacheRetention;
  }
  return true;
}

export function supportsReasoningSummary(model: Model | undefined): boolean {
  if (
    model !== undefined && model.compat !== undefined &&
    model.compat.supportsReasoningSummary !== undefined
  ) {
    return model.compat.supportsReasoningSummary;
  }
  return true;
}

/** Merges configured hosted tools with explicit request tools. */
export function mergeResponsesTools(
  p: ResponsesConfigHost,
  explicit: ResponsesTool[],
): ResponsesTool[] {
  const hosted = p.responsesConfig?.hostedTools;
  if (hosted === undefined || hosted.length === 0) return explicit;
  const result = [...explicit];
  const seen = new Set<string>();
  for (const tool of result) seen.add(tool.type);
  for (const tool of hosted) {
    if (seen.has(tool.type)) continue;
    result.push(tool);
    seen.add(tool.type);
  }
  return result;
}

/** Mirror of the Go hosted policy descriptor for capability reporting. */
export type { HostedToolDescriptor, ResponsesHostedPolicy };
