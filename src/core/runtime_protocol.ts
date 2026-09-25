import type { CoreRpcParams } from "./protocol.ts";

/** Domain methods exposed by the Core Runtime Host. */
export const CORE_RUNTIME_METHODS = {
  sessionCreate: "session.create",
  sessionOpen: "session.open",
  sessionClose: "session.close",
  sessionList: "session.list",
  sessionHistory: "session.history",
  sessionConfigGet: "session.config.get",
  sessionConfigSet: "session.config.set",
  sessionPrompt: "session.prompt",
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

export function parseSessionCreateParams(
  params: CoreRpcParams | undefined,
): { workDir: string; providerName?: string; modelID?: string } | undefined {
  const object = runtimeParamsObject(params);
  const workDir = object === undefined
    ? undefined
    : requiredString(object, "workDir");
  if (object === undefined || workDir === undefined) return undefined;
  const providerName = object.providerName;
  const modelID = object.modelID;
  if (
    providerName !== undefined && typeof providerName !== "string"
  ) return undefined;
  if (modelID !== undefined && typeof modelID !== "string") return undefined;
  return {
    workDir,
    ...(providerName === undefined ? {} : { providerName }),
    ...(modelID === undefined ? {} : { modelID }),
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
): { sessionId: string; text: string } | undefined {
  const object = runtimeParamsObject(params);
  if (object === undefined) return undefined;
  const sessionId = requiredString(object, "sessionId");
  const text = object.text;
  return sessionId === undefined || typeof text !== "string"
    ? undefined
    : { sessionId, text };
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
