import { type Message } from "../provider/types.ts";
import { type ExecutionIntent } from "../session/execution_intent.ts";
import { generateID, runUserEntryID } from "../session/mod.ts";
import { type DurableRun } from "./run_store.ts";
import { type RunEvent } from "./run_event.ts";
import { ExecutionRuntime } from "./execution.ts";
import { RunStore } from "./run_store.ts";
import { SessionRunEventSink } from "./run_event.ts";

export interface SessionRunDescriptorInput {
  sessionId: string;
  runId: string;
  source: string;
  model: string;
  mode: string;
  workDir: string;
  text: string;
  userMessage: Message;
  resourceIds: string[];
  startedAt: Date;
  policy?: unknown;
}

/** Creates the shared execution lifecycle bound to one persisted session. */
export function createSessionExecutionRuntime(
  sessionDir: string,
): ExecutionRuntime {
  const execution = new ExecutionRuntime();
  execution.setRunStore(new RunStore(sessionDir));
  execution.setEventSink(new SessionRunEventSink(sessionDir));
  return execution;
}

export interface SessionRunDescriptor {
  intent: ExecutionIntent;
  run: DurableRun;
  startEvent: RunEvent;
  turnId: string;
}

/** Builds the canonical durable Run inputs shared by TUI and Core. */
export async function createSessionRunDescriptor(
  input: SessionRunDescriptorInput,
): Promise<SessionRunDescriptor> {
  const intentId = `intent_${generateID()}`;
  const turnId = `turn-${intentId}`;
  const requestSnapshot = JSON.stringify({
    message: input.text,
    model: input.model,
    mode: input.mode,
    workDir: input.workDir,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(requestSnapshot),
  );
  const fingerprint = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const intent: ExecutionIntent = {
    id: intentId,
    sessionId: input.sessionId,
    source: input.source,
    model: input.model,
    mode: input.mode,
    workDir: input.workDir,
    requestFingerprint: `sha256:${fingerprint}`,
    request: JSON.parse(requestSnapshot),
    policy: input.policy ?? {
      source: input.source,
      mode: input.mode,
      workDir: input.workDir,
      approvalPolicy: "runtime",
      questionPolicy: "runtime",
    },
    createdAt: input.startedAt,
  };
  const run: DurableRun = {
    id: input.runId,
    sessionId: input.sessionId,
    intentId,
    retryOf: "",
    attempt: 1,
    workDir: input.workDir,
    source: input.source,
    model: input.model,
    mode: input.mode,
    status: "running",
    startedAt: input.startedAt,
    finishedAt: null,
    error: "",
    errorInfo: {},
    progress: {},
    usage: null,
    contextUsage: null,
    inputResourceIds: input.resourceIds,
    submissionKeyHash: "",
    submissionScope: "",
    submissionFingerprint: "",
    assistantEntryId: "",
    userEntryId: runUserEntryID(input.runId),
    userMessage: input.userMessage,
    conversationTurnId: turnId,
    conversationTurn: true,
  };
  const startEvent: RunEvent = {
    sessionId: input.sessionId,
    runId: input.runId,
    eventType: "started",
    source: input.source,
    status: "running",
    model: input.model,
    mode: input.mode,
    timestamp: input.startedAt,
    data: JSON.stringify({ intentId, attempt: 1 }),
  };
  return { intent, run, startEvent, turnId };
}
