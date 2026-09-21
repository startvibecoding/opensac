// Ported from internal/serve/openaiapi/chat_background.go — the
// x_background branch of /v1/chat/completions. It reuses the default session
// and delegates the durable run to the background coordinator through the
// `submitExternalResponsesBackground` Server hook (Go's
// s.SubmitExternalResponsesBackground, owned by background_external.go).
//
// `BackgroundRequest` is the serve/runtime contract
// (src/serve/runtime/background.ts); `ErrIdempotencyKeyConflict` is owned by
// the shared agentruntime idempotency module and is matched by sentinel
// identity through the error cause chain.

import type {
  InputIngress,
  RunInput,
} from "../../agentruntime/input_materializer.ts";
import type { Model } from "../../provider/types.ts";
import { writeError, writeJSON } from "./auth.ts";
import { convertHistoryMessages } from "./chat_support.ts";
import { newRunID } from "./events.ts";
import type { ChatCompletionRequest, RequestMessage } from "./types.ts";
import type { Server } from "./server.ts";
import { getOrCreateSession } from "./handler_chat_session.ts";
import { ErrIdempotencyKeyConflict } from "./events.ts";
import type { BackgroundRequest } from "../runtime/background.ts";

/**
 * BackgroundRequest re-exports the serve/runtime background submission
 * contract (Go: serviceruntime.BackgroundRequest) for adapter callers.
 */
export type { BackgroundRequest };

/**
 * The background coordinator hook owned by background_external.go. Resolves
 * with the canonical run ID or rejects with the classified submission error.
 */
export type SubmitExternalResponsesBackgroundFn = (
  req: BackgroundRequest,
) => Promise<string>;

/** errIsIdempotencyKeyConflict ports Go's errors.Is(err, ErrIdempotencyKeyConflict). */
export function errIsIdempotencyKeyConflict(err: unknown): boolean {
  let current: unknown = err;
  while (current instanceof Error) {
    if (current === ErrIdempotencyKeyConflict) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** submitChatCompletionBackground ports chat_background.go verbatim. */
export async function submitChatCompletionBackground(
  server: Server,
  request: Request,
  req: ChatCompletionRequest,
  workDir: string,
  _model: Model | undefined,
  inputSpec: RunInput,
  ingresses: InputIngress[],
  systemMsgs: string[],
  history: RequestMessage[],
): Promise<Response> {
  const signal = request.signal;
  const idempotencyKey = (request.headers.get("idempotency-key") ?? "").trim();
  let sessionID = server.defaultSessionIDs.get(workDir) ?? "";
  let sess;
  try {
    sess = await getOrCreateSession(server, sessionID, workDir);
  } catch (err) {
    if (err instanceof Error && err.name === "PoolFullError") {
      return writeError(503, "session pool is at capacity", "server_error");
    }
    return writeError(500, (err as Error).message, "server_error");
  }
  sessionID = sess.id;
  let runId = newRunID();
  let input: RunInput;
  try {
    input = await sess.runtime!.acceptInput(
      signal,
      runId,
      inputSpec.text,
      ingresses,
    );
  } catch (err) {
    return writeError(400, (err as Error).message, "invalid_request_error");
  }
  const initialHistory = convertHistoryMessages(history);
  const submit = server.submitExternalResponsesBackground;
  if (!submit) {
    return writeError(
      500,
      "background run coordinator is not configured",
      "server_error",
    );
  }
  try {
    runId = await submit({
      signal,
      sessionId: sessionID,
      workDir,
      platform: "chat-completions",
      modelId: req.model ?? "",
      mode: "",
      runId,
      input,
      initialHistory,
      systemPrompt: systemMsgs.join("\n"),
      temperature: req.temperature,
      topP: req.top_p,
      maxTokens: req.max_tokens,
      idempotencyKey,
    });
  } catch (err) {
    let status = 500;
    let errType = "server_error";
    if (errIsIdempotencyKeyConflict(err)) {
      status = 409;
      errType = "idempotency_conflict";
    } else if (
      err instanceof Error && err.message.includes("active run")
    ) {
      status = 409;
    }
    return writeError(status, (err as Error).message, errType);
  }
  return writeJSON(202, {
    id: runId,
    object: "chat.completion",
    status: "queued",
    sessionId: sessionID,
    runId,
  });
}
