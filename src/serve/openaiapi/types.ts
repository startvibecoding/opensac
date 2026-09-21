// Ported from internal/serve/openaiapi/types.go (the OpenAI-compatible
// request/response wire vocabulary). Go's custom `RequestMessage.UnmarshalJSON`
// maps to `decodeRequestMessage` because JSON is already decoded in TS; wire
// property names keep the Go JSON tag keys so serialization is a direct
// `JSON.stringify`. The WebUI runtime-snapshot vocabulary (types.go's session
// projection structs) lands with the session manager slice.

/** ChatCompletionRequest is the OpenAI chat completions request. */
export interface ChatCompletionRequest {
  model?: string;
  messages: RequestMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  x_background?: boolean;
}

/** SessionToolOptions are per-session runtime tool toggles supplied by WebUI. */
export interface SessionToolOptions {
  webSearch?: boolean;
  browser?: boolean;
  a2aMaster?: boolean;
  delegate?: boolean;
  multiAgent?: boolean;
  workflows?: boolean;
}

/** CapabilityFeature describes serve-level capability availability/defaults. */
export interface CapabilityFeature {
  available: boolean;
  default: boolean;
  locked?: boolean;
  reason?: string;
}

/** CapabilityOverview is returned by GET /api/capabilities. */
export interface CapabilityOverview {
  modes: string[];
  features: Record<string, CapabilityFeature>;
  defaults: SessionCapabilities;
  /** Provider-neutral, reflects an optional resolver on the active provider. */
  attachmentDownload: boolean;
  responses?: ResponsesCapabilityOverview;
}

/**
 * ResponsesCapabilityOverview exposes provider-specific Responses support as a
 * read-only report without changing the common Provider interface.
 */
export interface ResponsesCapabilityOverview {
  modelId: string;
  provider?: string;
  api?: string;
  supportsResponses: boolean;
  supportsPreviousResponseId: boolean;
  supportsConversation: boolean;
  supportsBackground: boolean;
  supportsStructuredOutput: boolean;
  supportsServiceTier: boolean;
  supportsParallelToolCalls: boolean;
  supportsToolChoice: boolean;
  supportsAttachmentDownload: boolean;
  hostedTools?: Record<string, boolean>;
  hostedPolicies?: Record<string, boolean>;
  supportedInclude?: string[];
  supportedEvents?: string[];
  supportedItems?: string[];
  attachmentKinds?: string[];
  supportedAnnotations?: string[];
}

/** SessionCapabilities are the effective runtime capabilities for a session. */
export interface SessionCapabilities {
  id?: string;
  workDir?: string;
  active: boolean;
  mode: string;
  displayMode: string;
  delegateMode: boolean;
  delegate: boolean;
  multiAgent: boolean;
  workflows: boolean;
  webSearch: boolean;
  browser: boolean;
  a2aMaster: boolean;
  model?: string;
  thinkingLevel?: string;
  persisted: boolean;
  runtimeOnly?: boolean;
  persistenceNote?: string;
}

/** SessionCapabilityPatch updates mutable session runtime capabilities. */
export interface SessionCapabilityPatch {
  mode?: string;
  displayMode?: string;
  delegateMode?: boolean;
  delegate?: boolean;
  multiAgent?: boolean;
  workflows?: boolean;
  webSearch?: boolean;
  browser?: boolean;
  a2aMaster?: boolean;
}

/**
 * SessionRuntimePatch is the structured WebUI runtime patch payload. Mode is
 * kept separate from capabilities while capability toggles remain session-level
 * user intent.
 */
export interface SessionRuntimePatch {
  mode?: string;
  displayMode?: string;
  capabilities?: Record<string, boolean>;
  tools?: SessionToolOptions;
}

/**
 * SessionRuntimeSnapshot is the structured WebUI view for runtime state. The
 * `execution` field takes the canonical `SessionExecutionSnapshot` when the
 * session manager slice lands; here it stays structural so this module carries
 * no runtime dependency.
 */
export interface SessionRuntimeSnapshot {
  sessionId: string;
  mode: string;
  displayMode: string;
  model?: string;
  thinkingLevel?: string;
  workDir?: string;
  capabilities: Record<string, SessionCapabilityState>;
  pendingApprovals: SessionApprovalRequest[];
  pendingQuestions: SessionQuestionRequest[];
  activeRun?: SessionActiveRun;
  execution?: unknown;
  responsesRun?: SessionResponsesRun;
  esm?: unknown;
}

/**
 * SessionCapabilityState describes availability, desired enabled state and
 * effective runtime state for one WebUI capability.
 */
export interface SessionCapabilityState {
  available: boolean;
  enabled: boolean;
  effective: boolean;
  disabledReason?: string;
}

/** SessionActiveRun describes the currently running session run, if any. */
export interface SessionActiveRun {
  runId?: string;
  status: string;
  source?: string;
  model?: string;
  mode?: string;
  /** RFC3339 string; Go's zero `time.Time` maps to "". */
  startedAt?: string;
  updatedAt?: string;
}

/**
 * SessionResponsesRun is the local projection of a durable OpenAI Responses
 * background run. The full provider-specific state remains behind the
 * Responses run API.
 */
export interface SessionResponsesRun {
  localRunId: string;
  responseId?: string;
  state: string;
  cancelRequested?: boolean;
}

/** SessionQuestionRequest is the WebUI question-center event shape. */
export interface SessionQuestionRequest {
  questionId: string;
  sessionId: string;
  runId?: string;
  question: string;
  options?: string[];
  context?: string;
  timestamp?: string;
}

/** SessionQuestionResponse is a WebUI answer for one pending question. */
export interface SessionQuestionResponse {
  answer: string;
}

/** SessionQuestionResolution is the server-confirmed question state. */
export interface SessionQuestionResolution {
  questionId: string;
  sessionId: string;
  runId?: string;
  answer?: string;
  status: string;
  message?: string;
}

export interface SessionApprovalRequest {
  approvalId: string;
  toolCallId?: string;
  sessionId: string;
  runId?: string;
  timestamp?: string;
  agentId?: string;
  mode?: string;
  risk?: string;
  summary?: string;
  reason?: string;
  tool?: Record<string, unknown>;
  context?: Record<string, unknown>;
  actions?: string[];
}

/** SessionApprovalResolution is the server-confirmed approval state. */
export interface SessionApprovalResolution {
  approvalId: string;
  sessionId: string;
  action: string;
  status: string;
  message?: string;
}

/** RequestMessage represents a message in the OpenAI request. */
export interface RequestMessage {
  role: string;
  content: string;
  /** Populated only when the request sent an OpenAI-style content array. */
  contentParts?: RequestContentPart[];
  name?: string;
}

/** RequestContentPart represents one OpenAI-compatible multimodal content part. */
export interface RequestContentPart {
  type: string;
  text?: string;
  image_url?: RequestImageURL;
  image?: RequestImageData;
}

/** RequestImageURL represents an OpenAI image_url content part. */
export interface RequestImageURL {
  url: string;
  detail?: string;
}

/** RequestImageData represents an internal image content part shape. */
export interface RequestImageData {
  data: string;
  mimeType: string;
  detail?: string;
}

/**
 * Decodes one request message from already-decoded JSON. Ports the custom
 * `UnmarshalJSON`: classic string content and OpenAI-style content arrays are
 * both accepted, text parts are merged into `content` with "\n", and anything
 * else throws Go's "content must be a string or content array".
 */
export function decodeRequestMessage(raw: unknown): RequestMessage {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("message must be a JSON object");
  }
  const body = raw as {
    role?: unknown;
    content?: unknown;
    name?: unknown;
  };
  const message: RequestMessage = {
    role: typeof body.role === "string" ? body.role : "",
    content: "",
  };
  if (typeof body.name === "string" && body.name !== "") {
    message.name = body.name;
  }
  const content = body.content;
  if (content === undefined || content === null) {
    return message;
  }
  if (typeof content === "string") {
    message.content = content;
    return message;
  }
  if (!Array.isArray(content)) {
    throw new Error("content must be a string or content array");
  }
  const parts: RequestContentPart[] = [];
  for (const entry of content) {
    parts.push(decodeRequestContentPart(entry));
  }
  message.contentParts = parts;
  for (const part of parts) {
    if (part.type === "text" && part.text !== "") {
      if (message.content !== "") message.content += "\n";
      message.content += part.text;
    }
  }
  return message;
}

function decodeRequestContentPart(raw: unknown): RequestContentPart {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("content part must be a JSON object");
  }
  const body = raw as {
    type?: unknown;
    text?: unknown;
    image_url?: unknown;
    image?: unknown;
  };
  const part: RequestContentPart = {
    type: typeof body.type === "string" ? body.type : "",
  };
  if (typeof body.text === "string" && body.text !== "") part.text = body.text;
  if (typeof body.image_url === "object" && body.image_url !== null) {
    const url = body.image_url as { url?: unknown; detail?: unknown };
    const image_url: RequestImageURL = {
      url: typeof url.url === "string" ? url.url : "",
    };
    if (typeof url.detail === "string" && url.detail !== "") {
      image_url.detail = url.detail;
    }
    part.image_url = image_url;
  }
  if (typeof body.image === "object" && body.image !== null) {
    const image = body.image as {
      data?: unknown;
      mimeType?: unknown;
      detail?: unknown;
    };
    const data: RequestImageData = {
      data: typeof image.data === "string" ? image.data : "",
      mimeType: typeof image.mimeType === "string" ? image.mimeType : "",
    };
    if (typeof image.detail === "string" && image.detail !== "") {
      data.detail = image.detail;
    }
    part.image = data;
  }
  return part;
}

/** ChatCompletionResponse is the non-streaming response. */
export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: CompletionUsage;
}

/** ChatCompletionChoice is a single choice in the response. */
export interface ChatCompletionChoice {
  index: number;
  message?: ResponseMessage;
  delta?: ResponseMessage;
  finish_reason: string | null;
}

/** ResponseMessage is the assistant's response message. */
export interface ResponseMessage {
  role?: string;
  content?: string;
}

/** CompletionUsage tracks token counts. */
export interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

/**
 * ToolCallSummary is an internal run summary. It is not serialized by the
 * OpenAI-compatible endpoint.
 */
export interface ToolCallSummary {
  name: string;
  args?: Record<string, unknown>;
  status: string;
}

/** ChatCompletionChunk is the streaming chunk response. */
export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: CompletionUsage;
}

/** ToolStatusEvent is sent via SSE event: tool_status. */
export interface ToolStatusEvent {
  sessionId?: string;
  runId?: string;
  timestamp?: string;
  tool: string;
  toolCallId?: string;
  agentId?: string;
  /** "running", "completed", "failed" */
  status: string;
  args?: Record<string, unknown>;
  summary?: string;
  isError?: boolean;
  hasDetail?: boolean;
}

/**
 * TranscriptStreamEvent is a WebUI-oriented SSE event that mirrors the
 * /api/sessions/{id}/messages entry shape while the response is still running.
 */
export interface TranscriptStreamEvent {
  /** "assistant_delta" or "message" */
  type: string;
  x_session_id?: string;
  runId?: string;
  timestamp?: string;
  message?: unknown;
  hostedItem?: HostedItemEvent;
}

/**
 * HostedItemEvent is the safe lifecycle projection of a native hosted tool.
 * Canonical provider output remains in the response archive.
 */
export interface HostedItemEvent {
  id?: string;
  type?: string;
  status?: string;
  outputIndex?: number;
  metadata?: Record<string, unknown>;
}

/** SessionRunEventEntry is the Web/API view of a run lifecycle event. */
export interface SessionRunEventEntry {
  seq?: number;
  id: string;
  sessionId: string;
  runId: string;
  eventType: string;
  source?: string;
  status?: string;
  model?: string;
  mode?: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

/** SessionCapabilityEventEntry is the Web/API view of a capability transition. */
export interface SessionCapabilityEventEntry {
  seq?: number;
  id: string;
  sessionId: string;
  runId?: string;
  eventType: string;
  source?: string;
  actor?: string;
  capability: string;
  oldValue: string;
  newValue: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

/** ModelListResponse is the response for GET /v1/models. */
export interface ModelListResponse {
  object: string;
  data: ModelItem[];
}

/** ModelItem represents one model in the list. */
export interface ModelItem {
  id: string;
  name?: string;
  object: string;
  created: number;
  owned_by: string;
  provider?: string;
  input?: string[];
}

/**
 * ModelCatalogResponse is the response for GET /api/models/catalog. It lists
 * every usable provider with its factory-resolved models — the same
 * resolution the TUI uses when constructing a provider — so the WebUI model
 * picker never re-derives the catalog from raw settings JSON.
 */
export interface ModelCatalogResponse {
  object: string;
  defaultProvider?: string;
  defaultModel?: string;
  providers: string[];
  data: ModelItem[];
}

/** HealthResponse is the response for GET /health. */
export interface HealthResponse {
  status: string;
  version: string;
  sessions: number;
}

/** ErrorResponse is the standard OpenAI error format. */
export interface ErrorResponse {
  error: ErrorDetail;
}

/** ErrorDetail contains error information. */
export interface ErrorDetail {
  message: string;
  type: string;
  code?: string;
  failureClass?: string;
  phase?: string;
  messageKey?: string;
  detail?: string;
  retryMode?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  attempt?: number;
  maxAttempts?: number;
  sideEffectState?: string;
  partialOutput?: boolean;
  runId?: string;
  intentId?: string;
  requestId?: string;
}

let completionIDCounter = 0;

function nextUnixNano(): string {
  // Go uses time.Now().UnixNano(); a millisecond clock plus a per-process
  // counter keeps generated IDs unique without losing integer precision.
  completionIDCounter += 1;
  return `${Date.now()}${completionIDCounter}`;
}

export function newCompletionID(): string {
  return `chatcmpl-${nextUnixNano()}`;
}

export function newCommandCompletionID(): string {
  return `chatcmpl-cmd-${nextUnixNano()}`;
}

export function stringPtr(s: string): string {
  return s;
}

export function marshalJSON(v: unknown): string {
  return JSON.stringify(v);
}
