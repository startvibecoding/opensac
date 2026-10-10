import { type CoreRpcParams } from "./protocol.ts";
import { type CorePreparedInput } from "./runtime.ts";

/** Domain methods exposed by the Core Runtime Host. */
export const CORE_RUNTIME_METHODS = {
  sessionCreate: "session.create",
  sessionOpen: "session.open",
  sessionClose: "session.close",
  sessionDelete: "session.delete",
  sessionList: "session.list",
  sessionListPersisted: "session.listPersisted",
  sessionHistory: "session.history",
  sessionTranscript: "session.transcript",
  sessionConfigGet: "session.config.get",
  sessionConfigSet: "session.config.set",
  sessionPrompt: "session.prompt",
  sessionSkillsList: "session.skills.list",
  sessionSkillSet: "session.skill.set",
  sessionSkillState: "session.skill.state",
  sessionCapabilities: "session.capabilities",
  sessionContextGet: "session.context.get",
  sessionContextSet: "session.context.set",
  expertList: "expert.list",
  expertShow: "expert.show",
  expertState: "expert.state",
  expertSet: "expert.set",
  sessionFork: "session.fork",
  agentList: "agent.list",
  agentDestroy: "agent.destroy",
  delegateSet: "delegate.set",
  delegateGet: "delegate.get",
  capabilitySet: "session.capability.set",
  esmState: "esm.state",
  esmUpdate: "esm.update",
  esmContinue: "esm.continue",
  esmStop: "esm.stop",
  transientPrompt: "transient.prompt",
  sessionCompact: "session.compact",
  inputPrepare: "input.prepare",
  settingsGet: "settings.get",
  settingsUpdate: "settings.update",
  modelCatalog: "model.catalog",
  modelValidate: "model.validate",
  envList: "env.list",
  envUpdate: "env.update",
  runStatus: "run.status",
  runCancel: "run.cancel",
  runEventsSubscribe: "run.events.subscribe",
  runEventsReplay: "run.events.replay",
  approvalRequest: "approval.request",
  approvalResolve: "approval.resolve",
  questionRequest: "question.request",
  questionResolve: "question.resolve",
  doctor: "doctor",
  attachmentList: "attachment.list",
  attachmentFetch: "attachment.fetch",
  attachmentStore: "attachment.store",
  projectList: "project.list",
} as const;

export type CoreRuntimeMethod =
  (typeof CORE_RUNTIME_METHODS)[keyof typeof CORE_RUNTIME_METHODS];

const ACP_ONLY_KEYS = new Set([
  "sessionUpdate",
  "agent_message_chunk",
  "tool_call",
  "permissionOptions",
]);

export function runtimeParamsObject(
  params: CoreRpcParams | undefined,
): Record<string, unknown> | undefined {
  if (params === undefined || Array.isArray(params) || params === null) {
    return undefined;
  }
  const object = { ...params } as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (ACP_ONLY_KEYS.has(key)) return undefined;
  }
  return object;
}

function requiredString(
  object: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = object[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalString(
  object: Record<string, unknown>,
  key: string,
): string | undefined | null {
  // null marks a present non-string value (invalid), undefined marks absence;
  // present strings pass through even when empty (thinkingLevel may be "").
  const value = object[key];
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

function optionalStringArray(
  object: Record<string, unknown>,
  key: string,
): string[] | undefined | null {
  const value = object[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (typeof entry !== "string") return null;
  }
  return [...value] as string[];
}

function optionalRecord(
  object: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined | null {
  const value = object[key];
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return { ...(value as Record<string, unknown>) };
}

function optionalCapabilities(
  object: Record<string, unknown>,
): Record<string, boolean> | undefined | null {
  const capabilities = optionalRecord(object, "capabilities");
  if (capabilities === undefined || capabilities === null) return capabilities;
  const parsed: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(capabilities)) {
    if (typeof value !== "boolean") return null;
    parsed[key] = value;
  }
  return parsed;
}

function optionalPreparedInputs(
  object: Record<string, unknown>,
): CorePreparedInput[] | undefined | null {
  const value = object.preparedInputs;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const parsed: CorePreparedInput[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const record = entry as Record<string, unknown>;
    const strings: string[] = [];
    for (const key of ["resourceId", "relativePath", "filename", "mediaType"]) {
      if (typeof record[key] !== "string") return null;
      strings.push(record[key] as string);
    }
    const kind = record.kind;
    if (typeof kind !== "string") return null;
    const bytes = record.bytes;
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
      return null;
    }
    parsed.push({
      resourceId: strings[0],
      kind,
      relativePath: strings[1],
      filename: strings[2],
      mediaType: strings[3],
      bytes,
    });
  }
  return parsed;
}

/**
 * JSON-RPC error code for a session that is persisted but not resident in the
 * Core process serving the request.
 *
 * The Core answers this before it performs any work, so a client that still
 * holds the session ID may re-open the session and replay the request exactly
 * once. It is the stable signal for "the Core restarted underneath this
 * client"; adapters must not match on the error message.
 */
export const CORE_ERROR_SESSION_NOT_RESIDENT = -32004;

/** Runtime-host error carrying the Core error code of a not-resident session. */
export class CoreSessionNotResidentError extends Error {
  override name = "CoreSessionNotResidentError";
  readonly code = CORE_ERROR_SESSION_NOT_RESIDENT;

    readonly sessionId: string;

  constructor(sessionId: string) {
    super(`session not found: ${sessionId}`);
    this.sessionId = sessionId;
  }
}

/** Optional policy fields shared by session creation and config updates. */
export interface CoreSessionConfigFields {
  providerName?: string;
  modelID?: string;
  mode?: string;
  thinkingLevel?: string;
  capabilities?: Record<string, boolean>;
}

function parseSessionConfigFields(
  object: Record<string, unknown>,
): CoreSessionConfigFields | undefined {
  const result: CoreSessionConfigFields = {};
  for (
    const key of ["providerName", "modelID", "mode", "thinkingLevel"] as const
  ) {
    const value = optionalString(object, key);
    if (value === null) return undefined;
    if (value !== undefined) result[key] = value;
  }
  const capabilities = optionalCapabilities(object);
  if (capabilities === null) return undefined;
  if (capabilities !== undefined) result.capabilities = capabilities;
  return result;
}

export function parseSessionCreateParams(
  params: CoreRpcParams | undefined,
):
  | ({
    workDir: string;
    sessionId?: string;
    source?: string;
    approvalPolicy?: string;
    questionPolicy?: string;
  } & CoreSessionConfigFields)
  | undefined {
  const object = runtimeParamsObject(params);
  const workDir = object === undefined
    ? undefined
    : requiredString(object, "workDir");
  if (object === undefined || workDir === undefined) return undefined;
  const fields = parseSessionConfigFields(object);
  if (fields === undefined) return undefined;
  const sessionId = optionalString(object, "sessionId");
  const source = optionalString(object, "source");
  const approvalPolicy = optionalString(object, "approvalPolicy");
  const questionPolicy = optionalString(object, "questionPolicy");
  if (
    sessionId === null || source === null || approvalPolicy === null ||
    questionPolicy === null
  ) {
    return undefined;
  }
  return {
    workDir,
    ...fields,
    ...(sessionId === undefined || sessionId.trim() === ""
      ? {}
      : { sessionId }),
    ...(source === undefined || source.trim() === "" ? {} : { source }),
    ...(approvalPolicy === undefined || approvalPolicy.trim() === ""
      ? {}
      : { approvalPolicy }),
    ...(questionPolicy === undefined || questionPolicy.trim() === ""
      ? {}
      : { questionPolicy }),
  };
}

export function parseSessionIdParams(
  params: CoreRpcParams | undefined,
): { sessionId: string } | undefined {
  const object = runtimeParamsObject(params);
  const sessionId = object === undefined
    ? undefined
    : requiredString(object, "sessionId");
  return sessionId === undefined ? undefined : { sessionId };
}

/**
 * Parses one session-open request.
 *
 * `workDir` is optional: a caller that knows the session's own directory sends
 * it so the Core resolves the session scoped to that directory, exactly like
 * ACP's `session/load`. Omitting it keeps the previous behaviour of using the
 * Core's startup directory.
 */
export function parseSessionOpenParams(
  params: CoreRpcParams | undefined,
): { sessionId: string; workDir?: string } | undefined {
  const base = parseSessionIdParams(params);
  if (base === undefined) return undefined;
  const object = runtimeParamsObject(params)!;
  const workDir = optionalString(object, "workDir");
  if (workDir === null) return undefined;
  // An empty or blank `workDir` means "not supplied", exactly like omitting the
  // key: a front end that serializes an unset directory must not silently scope
  // the open to a path that cannot match any session's cwd.
  const trimmed = (workDir ?? "").trim();
  return trimmed === "" ? base : { ...base, workDir: trimmed };
}

/** Parses one persisted-session listing request (optional work directory). */
export function parseSessionListPersistedParams(
  params: CoreRpcParams | undefined,
): { workDir?: string } | undefined {
  if (params === undefined) return {};
  const object = runtimeParamsObject(params);
  if (object === undefined) return undefined;
  const workDir = optionalString(object, "workDir");
  if (workDir === null) return undefined;
  return workDir === undefined ? {} : { workDir };
}

export function parseRunParams(
  params: CoreRpcParams | undefined,
): { sessionId: string; runId: string } | undefined {
  const object = runtimeParamsObject(params);
  if (object === undefined) return undefined;
  const sessionId = requiredString(object, "sessionId");
  const runId = requiredString(object, "runId");
  return sessionId === undefined || runId === undefined
    ? undefined
    : { sessionId, runId };
}

export function parsePromptParams(
  params: CoreRpcParams | undefined,
): {
  sessionId: string;
  text: string;
  attachments?: string[];
  metadata?: Record<string, unknown>;
  providerName?: string;
  modelID?: string;
  mode?: string;
  thinkingLevel?: string;
  preparedInputs?: CorePreparedInput[];
} | undefined {
  const object = runtimeParamsObject(params);
  if (object === undefined) return undefined;
  const sessionId = requiredString(object, "sessionId");
  const text = object.text;
  if (sessionId === undefined || typeof text !== "string") return undefined;
  const attachments = optionalStringArray(object, "attachments");
  if (attachments === null) return undefined;
  const metadata = optionalRecord(object, "metadata");
  if (metadata === null) return undefined;
  const fields = parseSessionConfigFields(object);
  if (fields === undefined) return undefined;
  const preparedInputs = optionalPreparedInputs(object);
  if (preparedInputs === null) return undefined;
  return {
    sessionId,
    text,
    ...fields,
    ...(attachments === undefined ? {} : { attachments }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(preparedInputs === undefined ? {} : { preparedInputs }),
  };
}

/** Parses one skill activation request. */
export function parseSkillParams(
  params: CoreRpcParams | undefined,
): { sessionId: string; name: string; active: boolean } | undefined {
  const object = runtimeParamsObject(params);
  if (object === undefined) return undefined;
  const sessionId = requiredString(object, "sessionId");
  const name = requiredString(object, "name");
  const active = object.active;
  if (
    sessionId === undefined || name === undefined ||
    typeof active !== "boolean"
  ) {
    return undefined;
  }
  return { sessionId, name, active };
}

/** Parses one prepared-input materialization request. */
export function parsePrepareParams(
  params: CoreRpcParams | undefined,
): {
  sessionId: string;
  name: string;
  mediaType: string;
  contentBase64: string;
  kind?: string;
} | undefined {
  const object = runtimeParamsObject(params);
  if (object === undefined) return undefined;
  const sessionId = requiredString(object, "sessionId");
  const name = requiredString(object, "name");
  const mediaType = optionalString(object, "mediaType");
  const contentBase64 = optionalString(object, "contentBase64");
  const kind = optionalString(object, "kind");
  if (
    sessionId === undefined || name === undefined || mediaType === null ||
    contentBase64 === null || contentBase64 === undefined || kind === null
  ) {
    return undefined;
  }
  return {
    sessionId,
    name,
    mediaType: mediaType ?? "",
    contentBase64,
    ...(kind === undefined ? {} : { kind }),
  };
}

export function parseCursor(
  object: Record<string, unknown>,
): number | undefined {
  const cursor = object.cursor;
  if (cursor === undefined) return 0;
  return typeof cursor === "number" && Number.isInteger(cursor) && cursor >= 0
    ? cursor
    : undefined;
}

export function parseEventParams(
  params: CoreRpcParams | undefined,
): { sessionId: string; runId: string; cursor: number } | undefined {
  const object = runtimeParamsObject(params);
  if (object === undefined) return undefined;
  const sessionId = requiredString(object, "sessionId");
  const runId = requiredString(object, "runId");
  const cursor = parseCursor(object);
  return sessionId === undefined || runId === undefined || cursor === undefined
    ? undefined
    : { sessionId, runId, cursor };
}

/** Parses one managed-agent request (`agent.list`/`agent.destroy`). */
export function parseAgentParams(
  params: CoreRpcParams | undefined,
): { sessionId: string; agentId?: string } | undefined {
  const object = runtimeParamsObject(params);
  if (object === undefined) return undefined;
  const sessionId = requiredString(object, "sessionId");
  if (sessionId === undefined) return undefined;
  const agentId = optionalString(object, "agentId");
  if (agentId === null) return undefined;
  return {
    sessionId,
    ...(agentId === undefined || agentId === "" ? {} : { agentId }),
  };
}

/** Parses one delegate-tool toggle request. */
export function parseDelegateParams(
  params: CoreRpcParams | undefined,
): { sessionId: string; enabled: boolean } | undefined {
  const object = runtimeParamsObject(params);
  if (object === undefined) return undefined;
  const sessionId = requiredString(object, "sessionId");
  const enabled = object.enabled;
  if (sessionId === undefined || typeof enabled !== "boolean") {
    return undefined;
  }
  return { sessionId, enabled };
}

/** Parses one capability-option toggle request. */
export function parseCapabilitySetParams(
  params: CoreRpcParams | undefined,
): { sessionId: string; id: string; enabled: boolean } | undefined {
  const object = runtimeParamsObject(params);
  if (object === undefined) return undefined;
  const sessionId = requiredString(object, "sessionId");
  const id = requiredString(object, "id");
  const enabled = object.enabled;
  if (
    sessionId === undefined || id === undefined ||
    typeof enabled !== "boolean"
  ) {
    return undefined;
  }
  return { sessionId, id, enabled };
}

const ESM_ACTIONS = new Set([
  "create",
  "edit",
  "pause",
  "resume",
  "guide",
  "clear",
]);

/** Parses one ESM supervisor mutation request. */
export function parseEsmCommandParams(
  params: CoreRpcParams | undefined,
):
  | {
    sessionId: string;
    action: "create" | "edit" | "pause" | "resume" | "guide" | "clear";
    objective?: string;
    guide?: string;
  }
  | undefined {
  const object = runtimeParamsObject(params);
  if (object === undefined) return undefined;
  const sessionId = requiredString(object, "sessionId");
  const action = object.action;
  if (
    sessionId === undefined || typeof action !== "string" ||
    !ESM_ACTIONS.has(action)
  ) {
    return undefined;
  }
  const objective = optionalString(object, "objective");
  const guide = optionalString(object, "guide");
  if (objective === null || guide === null) return undefined;
  return {
    sessionId,
    action: action as
      | "create"
      | "edit"
      | "pause"
      | "resume"
      | "guide"
      | "clear",
    ...(objective === undefined ? {} : { objective }),
    ...(guide === undefined ? {} : { guide }),
  };
}

/** Parses one transient side-query request. */
export function parseTransientPromptParams(
  params: CoreRpcParams | undefined,
):
  | {
    sessionId: string;
    question: string;
    providerName?: string;
    modelID?: string;
    thinkingLevel?: string;
  }
  | undefined {
  const object = runtimeParamsObject(params);
  if (object === undefined) return undefined;
  const sessionId = requiredString(object, "sessionId");
  const question = object.question;
  if (sessionId === undefined || typeof question !== "string") {
    return undefined;
  }
  const providerName = optionalString(object, "providerName");
  const modelID = optionalString(object, "modelID");
  const thinkingLevel = optionalString(object, "thinkingLevel");
  if (providerName === null || modelID === null || thinkingLevel === null) {
    return undefined;
  }
  return {
    sessionId,
    question,
    ...(providerName === undefined ? {} : { providerName }),
    ...(modelID === undefined ? {} : { modelID }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  };
}

export function parseConfigParams(
  params: CoreRpcParams | undefined,
): {
  sessionId: string;
  mode?: string;
  thinkingLevel?: string;
  providerName?: string;
  modelID?: string;
  capabilities?: Record<string, boolean>;
} | undefined {
  const object = runtimeParamsObject(params);
  if (object === undefined) return undefined;
  const sessionId = requiredString(object, "sessionId");
  if (sessionId === undefined) return undefined;
  const result: {
    sessionId: string;
    mode?: string;
    thinkingLevel?: string;
    providerName?: string;
    modelID?: string;
    capabilities?: Record<string, boolean>;
  } = { sessionId };
  for (
    const key of ["mode", "thinkingLevel", "providerName", "modelID"] as const
  ) {
    const value = object[key];
    if (value !== undefined) {
      if (typeof value !== "string") return undefined;
      result[key] = value;
    }
  }
  const capabilities = object.capabilities;
  if (capabilities !== undefined) {
    if (
      capabilities === null || typeof capabilities !== "object" ||
      Array.isArray(capabilities)
    ) return undefined;
    const parsed: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(capabilities)) {
      if (typeof value !== "boolean") return undefined;
      parsed[key] = value;
    }
    result.capabilities = parsed;
  }
  return result;
}

/** Scope of a settings-document read (effective merge or global sparse). */
export type CoreSettingsReadScope = "effective" | "global";

/** Scope of a settings-document write (global or project settings file). */
export type CoreSettingsWriteScope = "global" | "project";

/** Parses the optional work directory carried by config-level requests. */
function parseOptionalWorkDir(
  object: Record<string, unknown>,
): string | null {
  const value = optionalString(object, "workDir");
  if (value === null) return null;
  return value ?? "";
}

/** Parses one config-level request carrying only an optional work directory. */
export function parseWorkDirParams(
  params: CoreRpcParams | undefined,
): { workDir: string } | undefined {
  const object = runtimeParamsObject(params);
  if (object === undefined) {
    return params === undefined ? { workDir: "" } : undefined;
  }
  const workDir = parseOptionalWorkDir(object);
  if (workDir === null) return undefined;
  return { workDir };
}

/** Parses one settings-document read request. */
export function parseSettingsReadParams(
  params: CoreRpcParams | undefined,
): { scope: CoreSettingsReadScope; workDir: string } | undefined {
  const object = runtimeParamsObject(params);
  if (object === undefined) {
    return params === undefined
      ? { scope: "effective", workDir: "" }
      : undefined;
  }
  const scope = optionalString(object, "scope");
  if (scope === null) return undefined;
  if (scope !== undefined && scope !== "effective" && scope !== "global") {
    return undefined;
  }
  const workDir = parseOptionalWorkDir(object);
  if (workDir === null) return undefined;
  return { scope: scope ?? "effective", workDir };
}

/** Parses one settings-document sparse patch request. */
export function parseSettingsUpdateParams(
  params: CoreRpcParams | undefined,
):
  | {
    scope: CoreSettingsWriteScope;
    updates: Record<string, unknown>;
    workDir: string;
  }
  | undefined {
  const object = runtimeParamsObject(params);
  if (object === undefined) return undefined;
  const scope = optionalString(object, "scope");
  if (scope === null) return undefined;
  if (scope !== "global" && scope !== "project") return undefined;
  const updates = optionalRecord(object, "updates");
  if (updates === null || updates === undefined) return undefined;
  if (Object.keys(updates).length === 0) return undefined;
  const workDir = parseOptionalWorkDir(object);
  if (workDir === null) return undefined;
  return { scope, updates, workDir };
}

/** Parses one provider/model validation request. */
export function parseProviderValidateParams(
  params: CoreRpcParams | undefined,
): { providerID: string; modelID: string; workDir: string } | undefined {
  const object = runtimeParamsObject(params);
  if (object === undefined) return undefined;
  const providerID = requiredString(object, "providerID");
  const modelID = requiredString(object, "modelID");
  if (providerID === undefined || modelID === undefined) return undefined;
  const workDir = parseOptionalWorkDir(object);
  if (workDir === null) return undefined;
  return { providerID, modelID, workDir };
}

/** Parses one environment-variable document replacement request. */
export function parseEnvUpdateParams(
  params: CoreRpcParams | undefined,
): { vars: Record<string, string> } | undefined {
  const object = runtimeParamsObject(params);
  if (object === undefined) return undefined;
  const vars = optionalRecord(object, "vars");
  if (vars === null || vars === undefined) return undefined;
  const parsed: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (typeof value !== "string") return undefined;
    parsed[key] = value;
  }
  return { vars: parsed };
}

/** Parses one session rule/extra context update request. */
export function parseContextUpdateParams(
  params: CoreRpcParams | undefined,
):
  | { sessionId: string; ruleContent?: string; extraContext?: string }
  | undefined {
  const object = runtimeParamsObject(params);
  if (object === undefined) return undefined;
  const sessionId = requiredString(object, "sessionId");
  if (sessionId === undefined) return undefined;
  const ruleContent = optionalString(object, "ruleContent");
  const extraContext = optionalString(object, "extraContext");
  if (ruleContent === null || extraContext === null) return undefined;
  return {
    sessionId,
    ...(ruleContent === undefined ? {} : { ruleContent }),
    ...(extraContext === undefined ? {} : { extraContext }),
  };
}

/** Parses one session-scoped expert request (expert id optional). */
export function parseExpertParams(
  params: CoreRpcParams | undefined,
): { sessionId: string; expertId: string } | undefined {
  const object = runtimeParamsObject(params);
  if (object === undefined) return undefined;
  const sessionId = requiredString(object, "sessionId");
  if (sessionId === undefined) return undefined;
  const expertId = optionalString(object, "expertId");
  if (expertId === null) return undefined;
  return { sessionId, expertId: expertId ?? "" };
}

/** Parses one session fork request (optional expert binding on the child). */
export function parseForkParams(
  params: CoreRpcParams | undefined,
): { sessionId: string; expertId?: string; titleMode: string } | undefined {
  const object = runtimeParamsObject(params);
  if (object === undefined) return undefined;
  const sessionId = requiredString(object, "sessionId");
  if (sessionId === undefined) return undefined;
  const expertId = optionalString(object, "expertId");
  const titleMode = optionalString(object, "titleMode");
  if (expertId === null || titleMode === null) return undefined;
  return {
    sessionId,
    ...(expertId === undefined ? {} : { expertId }),
    titleMode: titleMode ?? "",
  };
}
