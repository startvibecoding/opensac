// Ported from internal/serve/runtime/background.go.
//
// The serve-owned durable Responses coordinator submits external messages
// through the same background-run path the WebUI uses. These types are the
// front-end-neutral contract: a caller hands over one message and the
// coordinator owns locks, tools, approvals and transcript updates.
//
// Deviations: `context.Context` maps to an optional `AbortSignal`;
// `[]provider.Message` maps to `Message[]`; `Progress func(string)` maps to an
// optional callback; `Input agentruntime.RunInput` maps to the Runtime-owned
// `RunInput` alias of `InputSubmission`.

import type { RunInput } from "../../agentruntime/input_materializer.ts";
import type { Message } from "../../provider/types.ts";
import type { ResponseRun } from "../../session/mod.ts";
import type { ChatParams } from "../../provider/types.ts";

/**
 * BackgroundRequest is an external message handed to the serve-owned durable
 * Responses coordinator. It is independent of a concrete UI or channel.
 */
export interface BackgroundRequest {
  signal: AbortSignal | undefined;
  sessionId: string;
  workDir: string;
  platform: string;
  userId?: string;
  modelId: string;
  mode: string;
  /**
   * runId and input are Runtime-owned identity/content. Callers must accept
   * any attachment streams through their SessionRuntime before submitting.
   */
  runId: string;
  input: RunInput;
  /**
   * initialHistory and systemPrompt carry client-owned chat context when an
   * OpenAI-compatible chat request is handed to the durable coordinator.
   */
  initialHistory?: Message[];
  systemPrompt?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /**
   * idempotencyKey lets an at-least-once caller safely retry submission.
   * The key is persisted in the existing run-event data, so no schema change
   * is required.
   */
  idempotencyKey: string;
  /**
   * idempotencyScope aligns external submissions that can use more than one
   * execution driver. Empty preserves the generic "external" scope.
   */
  idempotencyScope?: string;
  progress?: (text: string) => void;
}

/**
 * BackgroundSubmitter transfers ownership of a request to a durable
 * background coordinator and returns its local run ID.
 */
export type BackgroundSubmitter = (
  req: BackgroundRequest,
) => Promise<string>;

/**
 * BackgroundRunDriver is the remote lifecycle implemented by a provider
 * runtime. Serve coordinates locks, tools, approvals and transcript updates;
 * a driver owns only provider-specific start/continue/poll/cancel operations.
 * Go's leading `context.Context` maps to a trailing optional `AbortSignal`.
 */
export interface BackgroundRunDriver {
  start(
    sessionId: string,
    localTurnId: string,
    params: ChatParams,
    signal?: AbortSignal,
  ): Promise<ResponseRun>;
  continue(
    sessionId: string,
    localTurnId: string,
    previous: ResponseRun | undefined,
    outputs: Message[],
    params: ChatParams,
    signal?: AbortSignal,
  ): Promise<ResponseRun>;
  get(
    sessionId: string,
    localRunId: string,
    signal?: AbortSignal,
  ): Promise<ResponseRun | null>;
  cancel(
    sessionId: string,
    remoteRunId: string,
    signal?: AbortSignal,
  ): Promise<void>;
}
