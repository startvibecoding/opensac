// Ported from internal/serve/openaiapi/handler_deliveries.go. Go defines the
// handlers as *Server methods; the Deno projection takes the Server as its
// first argument.
//
// Deviations: Go's io.LimitReader caps the retry body before decoding; the
// port reads the body and rejects oversize after the fact (same slice-5
// deviation), and the Go `context.Context` arguments are dropped because the
// DAO layer is synchronous.
import type { Server } from "./server.ts";
import { getSessionDir } from "../../config/settings.ts";
import {
  type DeliveryFailure,
  ErrDeliveryOperationAbsent,
  getDeliveryOperation,
  listDeliveryFailures,
  reopenFailedDeliveryOperation,
} from "../../session/delivery_store.ts";
import { deliveryFailureRetryable } from "../../agentruntime/delivery_coordinator.ts";
import { formatRFC3339NanoUTC } from "./event_broker.ts";
import { writeError, writeJSON } from "./auth.ts";

/**
 * deliveryRequestBodyLimit caps the retry request body: the endpoint carries a
 * single operation id, never a payload.
 */
export const deliveryRequestBodyLimit = 4 << 10;

/**
 * handleDeliveryFailuresAPI lists the durable delivery operations that need
 * operator attention, most recently updated first. The Runtime owns the rows;
 * this endpoint only projects them (the same facts ACP exposes to Desktop).
 * GET /api/deliveries/failures?session_id={sessionID}&limit={n}
 */
export function handleDeliveryFailuresAPI(
  server: Server,
  req: Request,
): Response {
  if (req.method !== "GET") {
    return new Response(null, { status: 405 });
  }
  if (server.settings === null) {
    return writeError(503, "server is not ready", "server_error");
  }
  const url = new URL(req.url);
  const sessionId = (url.searchParams.get("session_id") ?? "").trim();
  let limit = 0;
  const raw = (url.searchParams.get("limit") ?? "").trim();
  if (raw !== "") {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return writeError(
        400,
        "limit must be a non-negative integer",
        "invalid_request_error",
      );
    }
    limit = parsed;
  }
  let failures: DeliveryFailure[];
  try {
    failures = listDeliveryFailures(
      getSessionDir(server.settings),
      sessionId,
      limit,
    );
  } catch (err) {
    return writeError(
      500,
      err instanceof Error ? err.message : String(err),
      "server_error",
    );
  }
  const items = failures.map(deliveryFailureJSON);
  return writeJSON(200, { deliveries: items, count: items.length });
}

/**
 * deliveryFailureJSON mirrors the ACP mothx/manage/deliveries/list projection
 * so WebUI and Desktop render the same facts, including the retryable verdict
 * that the shared Runtime predicate owns.
 */
export function deliveryFailureJSON(
  failure: DeliveryFailure,
): Record<string, unknown> {
  return {
    operationId: failure.operationId,
    intentId: failure.intentId,
    sessionId: failure.sessionId,
    runId: failure.runId,
    platform: failure.platform,
    targetId: failure.targetId,
    operationKind: failure.operationKind,
    status: failure.status,
    failureCode: failure.failureCode,
    attemptCount: failure.attemptCount,
    updatedAt: formatRFC3339NanoUTC(failure.updatedAt),
    retryable: deliveryFailureRetryable(failure.failureCode),
  };
}

/**
 * handleDeliveryRetryAPI reopens one failed transport-level delivery operation
 * so the Runtime retries it inside a fresh retry window. The same refusal
 * rules as the ACP operator entry apply: an unknown, non-failed, or
 * permanently failed operation is reported instead of being clobbered back
 * into retry_wait.
 * POST /api/deliveries/retry {"operationId":"..."}
 */
export async function handleDeliveryRetryAPI(
  server: Server,
  req: Request,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(null, { status: 405 });
  }
  if (server.settings === null) {
    return writeError(503, "server is not ready", "server_error");
  }
  let operationId = "";
  try {
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.byteLength > deliveryRequestBodyLimit) {
      throw new Error("body too large");
    }
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      operationId?: unknown;
    };
    if (typeof parsed?.operationId === "string") {
      operationId = parsed.operationId.trim();
    }
  } catch {
    operationId = "";
  }
  if (operationId === "") {
    return writeError(400, "operationId is required", "invalid_request_error");
  }
  const sessionDir = getSessionDir(server.settings);
  let operation;
  try {
    operation = getDeliveryOperation(sessionDir, operationId);
  } catch (err) {
    if (err === ErrDeliveryOperationAbsent) {
      return writeError(
        404,
        `delivery operation ${operationId} does not exist`,
        "not_found",
      );
    }
    return writeError(
      500,
      `delivery operation ${operationId} is not readable: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "server_error",
    );
  }
  if (operation === null || operation.status !== "failed") {
    return writeError(
      409,
      `delivery operation ${operationId} is ${operation?.status}, only a failed operation can be retried`,
      "invalid_request_error",
    );
  }
  if (!deliveryFailureRetryable(operation.failureCode)) {
    return writeError(
      409,
      `delivery operation ${operationId} failed permanently (${operation.failureCode})`,
      "invalid_request_error",
    );
  }
  let reopened: boolean;
  try {
    reopened = reopenFailedDeliveryOperation(
      sessionDir,
      operationId,
      new Date(),
    );
  } catch (err) {
    return writeError(
      500,
      err instanceof Error ? err.message : String(err),
      "server_error",
    );
  }
  return writeJSON(200, { operationId, retried: reopened });
}
