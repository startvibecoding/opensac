import { type CoreRpcId, type CoreRpcRequest } from "../core/protocol.ts";
import { type ACPBridgeContext } from "./bridge_protocol.ts";
import { type ACPRPCRequest } from "./wire.ts";

export { type ACPBridgeContext } from "./bridge_protocol.ts";

/** Maps ACP extension methods to front-end-neutral Core methods. */
export function mapACPExtensionToCore(
  request: ACPRPCRequest,
  context: ACPBridgeContext,
): CoreRpcRequest {
  const params = objectParams(request.params);
  const id = parseID(request.idRaw);
  switch (request.method) {
    case "fs/read_text_file":
      return requestCore(id, "attachment.fetch", params);
    case "fs/write_text_file":
      return requestCore(id, "attachment.store", params);
    case "opensac/attachment/list":
      return requestCore(id, "attachment.list", params);
    case "opensac/projects/list":
      return requestCore(id, "project.list", params);
    case "opensac/doctor":
      return requestCore(id, "doctor", params);
    case "opensac/session/listAll":
      return requestCore(id, "session.list", params);
    case "permission/request":
      return requestCore(id, "approval.resolve", params);
    case "question/request":
      return requestCore(id, "question.resolve", params);
  }
  if (request.method === "opensac/manage/cron/create") {
    const cronParams = { ...params };
    if (
      cronParams.cwd === undefined && cronParams.workDir === undefined &&
      context.workDir !== ""
    ) {
      cronParams.cwd = context.workDir;
    }
    return requestCore(id, "manage.cron.create", cronParams);
  }
  if (
    request.method === "opensac/manage/memory/get" ||
    request.method === "opensac/manage/memory/put"
  ) {
    const memoryParams = { ...params };
    if (
      memoryParams.cwd === undefined && memoryParams.workDir === undefined &&
      context.workDir !== ""
    ) {
      memoryParams.cwd = context.workDir;
    }
    return requestCore(
      id,
      `manage.${
        request.method.slice("opensac/manage/".length).replaceAll("/", ".")
      }`,
      memoryParams,
    );
  }
  if (request.method.startsWith("opensac/manage/skillhub/")) {
    const skillHubMethod = request.method.slice(
      "opensac/manage/skillhub/".length,
    );
    const skillHubParams = { ...params };
    if (
      skillHubMethod !== "get" && skillHubMethod !== "patch" &&
      skillHubParams.cwd === undefined &&
      skillHubParams.workDir === undefined &&
      context.workDir !== ""
    ) {
      skillHubParams.cwd = context.workDir;
    }
    return requestCore(
      id,
      `manage.${
        request.method.slice("opensac/manage/".length).replaceAll("/", ".")
      }`,
      skillHubParams,
    );
  }
  if (request.method.startsWith("opensac/manage/")) {
    return requestCore(
      id,
      `manage.${
        request.method.slice("opensac/manage/".length).replaceAll("/", ".")
      }`,
      params,
    );
  }
  if (request.method.startsWith("opensac/projects/")) {
    return requestCore(
      id,
      `project.${
        request.method.slice("opensac/projects/".length).replaceAll("/", ".")
      }`,
      params,
    );
  }
  if (request.method.startsWith("opensac/attachment/")) {
    return requestCore(
      id,
      `attachment.${
        request.method.slice("opensac/attachment/".length).replaceAll("/", ".")
      }`,
      params,
    );
  }
  throw new Error(`unsupported ACP extension method: ${request.method}`);
}

function requestCore(
  id: CoreRpcId,
  method: string,
  params: Record<string, unknown>,
): CoreRpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

function objectParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ACP extension params must be an object");
  }
  return value as Record<string, unknown>;
}

function parseID(raw: string | null): CoreRpcId {
  if (raw === null || raw.trim() === "" || raw.trim() === "null") return null;
  const value = JSON.parse(raw);
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("ACP extension id must be a string, number, or null");
  }
  return value;
}
