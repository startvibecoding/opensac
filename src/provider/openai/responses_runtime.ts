// Ported from internal/provider/openai/responses_runtime.go
//
// `ResponsesRunManager` owns background Responses runs. It is intentionally
// separate from `chatResponses`: background requests have a durable lifecycle
// and cannot be represented by a single synchronous stream.
//
// Deviations: `context.Context` maps to an optional `AbortSignal`; the Go
// `http.Client.Do` maps to `HttpClient.fetch`; `session.GenerateID` maps to the
// Runtime-owned `generateID`.

import { providerUserAgent } from "../../ua/ua.ts";
import { applyHeaders } from "../http_client.ts";
import { isRetryable, retryDelay } from "../retry.ts";
import type { ChatParams, Message } from "../types.ts";
import type { ResponsesHostedPolicy } from "./hosted_registry.ts";
import type { Provider } from "./provider.ts";
import {
  buildResponsesRequest,
  convertResponsesUsage,
  type ResponsesCompletedObject,
} from "./responses.ts";
import {
  decodeResponsesOutputItem,
  newResponsesNormalizer,
  responsesConversationID,
} from "./responses_codec.ts";
import { validateResponsesCapabilities } from "./responses_config.ts";
import { generateID } from "../../session/mod.ts";
import {
  getResponseRun,
  listResponseRuns,
  type ResponseItemArchive,
  type ResponseRun,
  type ResponseTurn,
  saveResponseItem,
  saveResponseRun,
  saveResponseTurn,
} from "../../session/mod.ts";

/** Owns background Responses runs for one session directory. */
export class ResponsesRunManager {
  private provider: Provider;
  private sessionDir: string;

  constructor(provider: Provider, sessionDir: string) {
    this.provider = provider;
    this.sessionDir = sessionDir;
  }

  /** Starts a new background Responses run and persists its durable state. */
  async start(
    sessionId: string,
    localTurnId: string,
    params: ChatParams,
    signal?: AbortSignal,
  ): Promise<ResponseRun> {
    if (this.provider === undefined || this.provider === null) {
      throw new Error("responses run manager is not configured");
    }
    if (sessionId === "" || localTurnId === "") {
      throw new Error("session ID and local turn ID are required");
    }
    if (this.provider.apiKey === "") {
      throw new Error("OPENAI_API_KEY not set");
    }
    signal = signal ?? params.abort;
    let modelId = params.modelId;
    if (modelId === "") {
      const models = this.provider.models();
      if (models.length === 0) {
        throw new Error(
          `no models available from provider ${
            JSON.stringify(
              this.provider.name(),
            )
          }`,
        );
      }
      modelId = models[0].id;
    }
    const model = this.provider.getModel(modelId);
    validateResponsesCapabilities(this.provider, model, params);
    const reqBody = buildResponsesRequest(
      this.provider,
      params,
      modelId,
      model,
      false,
      true,
    );
    const body = JSON.stringify(reqBody);

    const now = new Date();
    const run: ResponseRun = {
      id: 0,
      sessionId,
      localRunId: generateID(),
      localTurnId,
      messageId: null,
      responseId: "",
      provider: this.provider.name(),
      api: "openai-responses",
      state: "queued",
      pollingUrl: "",
      lastEventSequence: null,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
    };
    try {
      saveResponseRun(this.sessionDir, run);
    } catch (err) {
      throw new Error(`persist background run: ${(err as Error).message}`);
    }

    let response: ResponsesCompletedObject;
    try {
      response = await this.doJSON(
        "POST",
        "/responses",
        body,
        run.localRunId,
        signal,
      );
    } catch (err) {
      run.state = "failed";
      run.updatedAt = new Date();
      try {
        saveResponseRun(this.sessionDir, run);
      } catch {
        // Best-effort failure-state persistence, matching the Go error path.
      }
      throw err;
    }
    if ((response.id ?? "") === "") {
      run.state = "failed";
      run.updatedAt = new Date();
      try {
        saveResponseRun(this.sessionDir, run);
      } catch {
        // Best-effort.
      }
      throw new Error("background response did not return an id");
    }
    run.responseId = response.id ?? "";
    run.state = response.status ?? "";
    if (run.state === "") run.state = "queued";
    run.updatedAt = new Date();
    if (isResponsesTerminalStatus(run.state)) {
      run.updatedAt = new Date();
      const policies = this.provider.responsesConfig?.hostedPolicies;
      if (responsesHostedPolicyExceeded(response, policies)) {
        run.state = "incomplete";
      }
      try {
        archiveBackgroundResponseWithPolicy(
          this.sessionDir,
          run,
          response,
          policies,
        );
      } catch (err) {
        throw new Error(
          `archive background response: ${(err as Error).message}`,
        );
      }
    }
    try {
      saveResponseRun(this.sessionDir, run);
    } catch (err) {
      throw new Error(
        `persist background response: ${(err as Error).message}`,
      );
    }
    return run;
  }

  /**
   * Submits tool outputs against a completed/terminal response. Each
   * continuation receives its own local turn id so response archive rows stay
   * immutable and replayable while the caller keeps the same user-facing run.
   */
  async continue(
    sessionId: string,
    localTurnId: string,
    previous: ResponseRun | undefined,
    outputs: Message[],
    params: ChatParams,
    signal?: AbortSignal,
  ): Promise<ResponseRun> {
    if (
      previous === undefined || previous === null ||
      (previous.responseId ?? "").trim() === ""
    ) {
      throw new Error("previous Responses response ID is required");
    }
    if (localTurnId === "") {
      throw new Error("continuation local turn ID is required");
    }
    params.messages = outputs;
    params.responseOptions = {
      ...(params.responseOptions ?? {}),
      replayItems: undefined,
      previousResponseId: previous.responseId,
    };
    return await this.start(sessionId, localTurnId, params, signal);
  }

  /** Refreshes and returns the durable state for one background run. */
  async get(
    sessionId: string,
    localRunId: string,
    signal?: AbortSignal,
  ): Promise<ResponseRun | null> {
    const run = getResponseRun(this.sessionDir, sessionId, localRunId);
    if (run === null) return null;
    if (run.responseId === "" || isResponsesTerminalStatus(run.state)) {
      return run;
    }
    const response = await this.doJSON(
      "GET",
      `/responses/${encodeURIComponent(run.responseId)}`,
      null,
      "",
      signal,
    );
    applyResponsesRemoteState(run, response);
    if (isResponsesTerminalStatus(run.state)) {
      const policies = this.provider.responsesConfig?.hostedPolicies;
      if (responsesHostedPolicyExceeded(response, policies)) {
        run.state = "incomplete";
      }
      try {
        archiveBackgroundResponseWithPolicy(
          this.sessionDir,
          run,
          response,
          policies,
        );
      } catch (err) {
        throw new Error(
          `archive background response: ${(err as Error).message}`,
        );
      }
    }
    try {
      saveResponseRun(this.sessionDir, run);
    } catch (err) {
      throw new Error(
        `persist background response state: ${(err as Error).message}`,
      );
    }
    return run;
  }

  /** Requests cancellation of a non-terminal background run. */
  async cancel(
    sessionId: string,
    localRunId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const run = getResponseRun(this.sessionDir, sessionId, localRunId);
    if (run === null) {
      throw new Error(`background run ${JSON.stringify(localRunId)} not found`);
    }
    if (run.responseId === "" || isResponsesTerminalStatus(run.state)) {
      return;
    }
    await this.doJSON(
      "POST",
      `/responses/${encodeURIComponent(run.responseId)}/cancel`,
      null,
      `cancel-${run.localRunId}`,
      signal,
    );
    run.cancelRequested = true;
    run.state = "cancelling";
    run.updatedAt = new Date();
    saveResponseRun(this.sessionDir, run);
  }

  /**
   * Refreshes every non-terminal local run for a session. Callers can invoke it
   * during process startup before accepting new work.
   */
  async recover(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<ResponseRun[]> {
    const runs = listResponseRuns(this.sessionDir, sessionId, 500);
    for (let i = 0; i < runs.length; i++) {
      if (
        isResponsesTerminalStatus(runs[i].state) || runs[i].responseId === ""
      ) {
        continue;
      }
      const refreshed = await this.get(sessionId, runs[i].localRunId, signal);
      if (refreshed !== null) runs[i] = refreshed;
    }
    return runs;
  }

  private async doJSON(
    method: string,
    path: string,
    body: string | null,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ResponsesCompletedObject> {
    let maxRetries = 0;
    let baseDelayMs = 2000;
    const retry = this.provider.retryConfig;
    if (retry !== undefined && retry.enabled) {
      maxRetries = retry.maxRetries;
      baseDelayMs = retry.baseDelayMs;
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw abortError(signal);
      const headers = new Headers();
      headers.set("Authorization", `Bearer ${this.provider.apiKey}`);
      headers.set("User-Agent", providerUserAgent());
      if (body !== null && body.length > 0) {
        headers.set("Content-Type", "application/json");
      }
      applyHeaders(headers, this.provider.headers);
      if (idempotencyKey !== "") {
        headers.set("Idempotency-Key", idempotencyKey);
      }

      let resp: Response;
      try {
        resp = await this.provider.client.fetch(
          `${this.provider.baseURL}${path}`,
          {
            method,
            ...(body !== null && body.length > 0 ? { body } : {}),
            headers,
            signal,
          },
        );
      } catch (err) {
        if (attempt < maxRetries && isRetryable(err, 0)) {
          await waitForBackgroundRetry(signal, attempt, baseDelayMs);
          continue;
        }
        throw new Error(`background request: ${(err as Error).message}`);
      }
      let responseBody: string;
      try {
        responseBody = await resp.text();
      } catch (err) {
        if (attempt < maxRetries && isRetryable(err, 0)) {
          await waitForBackgroundRetry(signal, attempt, baseDelayMs);
          continue;
        }
        throw new Error(
          `read background response: ${(err as Error).message}`,
        );
      }
      if (resp.status < 200 || resp.status >= 300) {
        if (
          attempt < maxRetries &&
          isRetryable(
            new Error(`HTTP ${resp.status}: ${responseBody.trim()}`),
            resp.status,
          )
        ) {
          await waitForBackgroundRetry(signal, attempt, baseDelayMs);
          continue;
        }
        throw new Error(
          `background API error ${resp.status}: ${responseBody.trim()}`,
        );
      }
      if (responseBody.length > 0) {
        try {
          return JSON.parse(responseBody) as ResponsesCompletedObject;
        } catch {
          throw new Error("decode background response: invalid JSON");
        }
      }
      return {};
    }
    throw new Error(`all ${maxRetries} background retry attempts exhausted`);
  }
}

/** Returns a Provider-bound background run manager. */
export function newResponsesRunManager(
  provider: Provider,
  sessionDir: string,
): ResponsesRunManager {
  return new ResponsesRunManager(provider, sessionDir);
}

/** Archives a terminal background response without hosted-tool policy. */
export function archiveBackgroundResponse(
  sessionDir: string,
  run: ResponseRun,
  response: ResponsesCompletedObject | undefined | null,
): void {
  archiveBackgroundResponseWithPolicy(sessionDir, run, response, undefined);
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

function responsesHostedPolicyExceeded(
  response: ResponsesCompletedObject | undefined | null,
  policies: Record<string, ResponsesHostedPolicy> | undefined,
): boolean {
  if (response === undefined || response === null) return false;
  if (policies === undefined || Object.keys(policies).length === 0) {
    return false;
  }
  const normalizer = newResponsesNormalizer();
  normalizer.hostedPolicies = policies;
  const output = response.output ?? [];
  for (let index = 0; index < output.length; index++) {
    const item = decodeResponsesOutputItem(output[index], index);
    if (item !== undefined) normalizer.upsertDecodedItem(item);
  }
  return normalizer.hostedPolicyError() !== undefined;
}

function archiveBackgroundResponseWithPolicy(
  sessionDir: string,
  run: ResponseRun,
  response: ResponsesCompletedObject | undefined | null,
  policies: Record<string, ResponsesHostedPolicy> | undefined,
): void {
  if (
    response === undefined || response === null ||
    run.sessionId === "" || run.localTurnId === ""
  ) {
    return;
  }
  const now = new Date();
  let status = response.status ?? "";
  if (status === "") status = run.state;
  let incompleteReason = "";
  if (response.incomplete_details !== undefined) {
    incompleteReason = response.incomplete_details?.reason ?? "";
  }
  const normalizer = newResponsesNormalizer();
  normalizer.hostedPolicies = policies;
  const output = response.output ?? [];
  for (let index = 0; index < output.length; index++) {
    const item = decodeResponsesOutputItem(output[index], index);
    if (item !== undefined) normalizer.upsertDecodedItem(item);
  }
  if (normalizer.hostedPolicyError() !== undefined) {
    status = "incomplete";
    incompleteReason = "opensac_code_interpreter_quota";
  }
  const summary = {
    responseId: response.id ?? "",
    status,
    itemCount: output.length,
    incompleteReason,
    usage: convertResponsesUsage(response.usage),
    attachments: normalizer.attachments(),
  };
  saveResponseTurn(
    sessionDir,
    {
      id: 0,
      sessionId: run.sessionId,
      localTurnId: run.localTurnId,
      messageId: null,
      requestId: "",
      responseId: response.id ?? "",
      previousResponseId: response.previous_response_id ?? "",
      conversationId: responsesConversationID(response),
      provider: run.provider,
      api: run.api,
      model: "background",
      stateMode: "replay",
      status,
      incompleteReason,
      requestSummary: undefined,
      responseSummary: summary,
      createdAt: run.createdAt,
      completedAt: now,
    } satisfies ResponseTurn,
  );
  for (let index = 0; index < output.length; index++) {
    const item = decodeResponsesOutputItem(output[index], index);
    if (item === undefined || item.type === "") continue;
    const archive: ResponseItemArchive = {
      id: 0,
      sessionId: run.sessionId,
      localTurnId: run.localTurnId,
      responseId: response.id ?? "",
      itemId: item.id,
      outputIndex: index,
      itemType: item.type,
      itemStatus: item.status,
      itemKey: "",
      sanitizedJson: parseCanonicalText(item.canonical),
      createdAt: now,
    };
    saveResponseItem(sessionDir, archive);
  }
}

/** Parses a canonical redacted item JSON text back into a JSON value. */
function parseCanonicalText(raw: string | undefined): unknown {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function applyResponsesRemoteState(
  run: ResponseRun | undefined | null,
  response: ResponsesCompletedObject | undefined | null,
): void {
  if (run === undefined || run === null) return;
  if (response === undefined || response === null) return;
  if ((response.id ?? "") !== "") run.responseId = response.id ?? "";
  if ((response.status ?? "") !== "") run.state = response.status ?? "";
  run.updatedAt = new Date();
}

function isResponsesTerminalStatus(status: string): boolean {
  switch (status.toLowerCase()) {
    case "completed":
    case "failed":
    case "incomplete":
    case "cancelled":
    case "canceled":
    case "expired":
      return true;
    default:
      return false;
  }
}

function waitForBackgroundRetry(
  signal: AbortSignal | undefined,
  attempt: number,
  baseDelayMs: number,
): Promise<void> {
  const delay = retryDelay(attempt, baseDelayMs);
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delay);
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
