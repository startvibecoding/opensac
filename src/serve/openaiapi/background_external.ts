// Ported from internal/serve/openaiapi/background_external.go —
// SubmitExternalResponsesBackground hands an external runtime message to the
// same durable coordinator used by WebUI. The caller does not retain a
// session/runtime lock while the background run executes.
//
// Deviations: Go's `(value, error)` returns map to resolved promises and
// thrown errors; the request-context field becomes the explicit
// `BackgroundRequest` contract from src/serve/runtime; `errors.Is` matching
// for `ErrIdempotencyKeyConflict` stays sentinel-identity based through the
// cause chain (the sentinel is owned by the shared agentruntime idempotency
// module). The bound closures (submitExternalResponsesBackgroundFn /
// executeResponsesBackgroundRunFn in background_run_coordinator.ts) fill the
// corresponding Server fields when the serve assembly or tests wire a
// coordinator-bearing Server.

import { acquireExecutionAdmission } from "../../agentruntime/execution_admission.ts";
import { resourceIds } from "../../agentruntime/input_materializer.ts";
import { SourceUnknown } from "../../agentruntime/source.ts";
import type { RunEvent } from "../../agentruntime/run_event.ts";
import { type DurableRun, RunStore } from "../../agentruntime/run_store.ts";
import type { ExecutionIntent } from "../../session/execution_intent.ts";
import { runUserEntryID } from "../../session/mod.ts";
import type { Attachment, Message, Model } from "../../provider/types.ts";
import { formatAttachmentSummary } from "../runtime/attachments.ts";
import type { BackgroundRequest } from "../runtime/background.ts";
import { getWorkDir } from "./config.ts";
import {
  executeResponsesBackgroundRunWithConfig,
  type ResponsesBackgroundCompleteFn,
} from "./background_run_coordinator.ts";
import {
  findIdempotentRun,
  idempotencyKeyFingerprint,
  newExecutionIntentID,
  newRunID,
  rawEventData,
  requestFingerprint,
} from "./events.ts";
import { getOrCreateSession } from "./handler_chat_session.ts";
import { marshalRunPolicySnapshot } from "./handler_run_submit.ts";
import { resolveSessionPolicy } from "./session_capabilities.ts";
import { runtimeRunEventSink } from "./runtime_run_events.ts";
import { buildAgentOptionsForSession } from "./session_patch.ts";
import { PoolFullError } from "./session_mgr.ts";
import { cloneModel, safeAgentErrorMessage } from "./chat_support.ts";
import type { Server } from "./server.ts";

/**
 * submitExternalResponsesBackground ports SubmitExternalResponsesBackground
 * and resolves with the canonical run ID.
 */
export async function submitExternalResponsesBackground(
  server: Server,
  req: BackgroundRequest,
): Promise<string> {
  if (!server.pool || !responsesBackgroundEnabledOf(server)) {
    throw new Error("Responses background runtime is unavailable");
  }
  if (
    req.sessionId.trim() === "" ||
    (req.input.text.trim() === "" && req.input.resources.length === 0)
  ) {
    throw new Error("session ID and message are required");
  }
  if (req.idempotencyKey.trim().length > 256) {
    throw new Error("Idempotency-Key is too long");
  }
  let idempotencyScope = (req.idempotencyScope ?? "").trim();
  if (idempotencyScope === "") idempotencyScope = "external";
  const requestFP = requestFingerprint({
    platform: req.platform,
    model: req.modelId,
    mode: req.mode,
    input: req.input,
  });
  let workDir = req.workDir;
  if (workDir === "") workDir = getWorkDir(server.cfg!);
  let sess;
  try {
    sess = await getOrCreateSession(server, req.sessionId, workDir);
  } catch (err) {
    if (err instanceof PoolFullError) {
      throw new Error("session pool is at capacity");
    }
    throw err;
  }
  const existing = findIdempotentRun(
    server.sessionDir(),
    sess.id,
    req.idempotencyKey,
    requestFP,
    idempotencyScope,
  );
  if (existing) return existing.id;
  if (!server.pool.pin(sess)) {
    throw new Error("session pool is at capacity");
  }
  let unpin = true;
  try {
    const runtimeGuard = await acquireExecutionAdmission(
      req.signal,
      server.sessionDir(),
      sess.id,
      {},
    );
    const runtimeRelease = () => runtimeGuard.release();
    if (!sess.mu.tryLock()) {
      runtimeRelease();
      throw new Error("session already has an active run");
    }
    let locked = true;
    try {
      try {
        sess.manager!.reload();
      } catch (err) {
        throw new Error(
          `reload session before background run: ${(err as Error).message}`,
        );
      }
      // Repeat the idempotency lookup under the session/runtime admission
      // locks. The pre-lock lookup is only a fast path; this check closes the
      // concurrent duplicate-submit window while the durable submission table
      // is pending.
      const lockedExisting = findIdempotentRun(
        server.sessionDir(),
        sess.id,
        req.idempotencyKey,
        requestFP,
        idempotencyScope,
      );
      if (lockedExisting) {
        sess.mu.unlock();
        locked = false;
        runtimeRelease();
        return lockedExisting.id;
      }

      let model: Model = server.model!;
      if (!server.provider || !server.model) {
        throw new Error("provider and model are required");
      }
      if (req.modelId !== "" && req.modelId !== "default") {
        const selected = server.provider.getModel(req.modelId);
        if (selected) model = selected;
      }
      model = cloneModel(model)!;
      if (req.temperature !== undefined) {
        model.temperature = req.temperature;
      }
      if (req.topP !== undefined) {
        model.topP = req.topP;
      }
      const resolution = resolveSessionPolicy(server, sess, req.mode.trim());
      if (resolution.err) throw resolution.err;
      const mode = resolution.mode;
      let runSource = "channel:" + req.platform;
      if (resolution.resolution.source !== SourceUnknown) {
        runSource = String(resolution.resolution.source);
      }
      let runId = req.runId.trim();
      if (runId === "") runId = newRunID();
      let message: Message;
      try {
        message = await sess.runtime!.buildUserMessage(req.signal, req.input);
      } catch (err) {
        throw new Error(
          `build Runtime user message: ${(err as Error).message}`,
        );
      }
      const now = new Date();
      const requestSnapshot = JSON.stringify({
        platform: req.platform,
        model: req.modelId,
        mode: req.mode,
        input: req.input,
        systemPrompt: req.systemPrompt,
        maxTokens: req.maxTokens,
      });
      const policySnapshot = marshalRunPolicySnapshot(
        server,
        sess,
        {
          message: req.input.text,
          model: req.modelId,
          mode,
          workDir,
          transcript: false,
        },
        runSource,
        mode,
      );
      const intent: ExecutionIntent = {
        id: newExecutionIntentID(),
        sessionId: sess.id,
        source: runSource,
        model: model.id,
        mode,
        workDir: sess.workDir,
        requestFingerprint: requestFP,
        request: requestSnapshot,
        policy: policySnapshot,
        createdAt: now,
      };
      const execution = sess.ensureExecution();
      execution.setRunStore(new RunStore(server.sessionDir()));
      execution.setEventSink(runtimeRunEventSink(server, sess));
      if (sess.runtime) sess.runtime.setExecution(execution);
      sess.beginRunBookkeeping(runId);
      const keyHash = idempotencyKeyFingerprint(req.idempotencyKey);
      const durableRun: DurableRun = {
        id: runId,
        sessionId: sess.id,
        intentId: intent.id,
        retryOf: "",
        attempt: 1,
        workDir: sess.workDir,
        source: runSource,
        model: model.id,
        mode,
        status: "queued",
        startedAt: now,
        finishedAt: null,
        error: "",
        errorInfo: {},
        progress: {},
        usage: null,
        contextUsage: null,
        inputResourceIds: resourceIds(req.input),
        submissionKeyHash: keyHash,
        submissionScope: idempotencyScope,
        submissionFingerprint: requestFP,
        userEntryId: runUserEntryID(runId),
        userMessage: message,
        assistantEntryId: "",
        conversationTurnId: "turn-" + intent.id,
        conversationTurn: true,
      };
      const startEvent: RunEvent = {
        sessionId: sess.id,
        runId,
        eventType: "started",
        source: runSource,
        status: "queued",
        model: model.id,
        mode,
        timestamp: now,
        data: rawEventData({
          source: "channel",
          idempotencyKeyHash: keyHash,
          idempotencyScope,
          requestFingerprint: requestFP,
          intentId: intent.id,
          attempt: 1,
        }),
      };
      try {
        execution.beginIntentDurable(undefined, intent, durableRun, startEvent);
      } catch (err) {
        sess.finishRun(runId);
        throw err;
      }
      // BeginIntentDurable atomically writes the turn boundary and the run's
      // user entry. Reload the shared manager so the background coordinator
      // sees the admitted user entry in its replay state and reuses it instead
      // of appending a duplicate.
      try {
        sess.manager!.reload();
      } catch (err) {
        sess.finishRun(runId);
        throw new Error(
          `reload session after background admission: ${
            (err as Error).message
          }`,
        );
      }
      sess.markDurableRun(runId);
      if (server.runManager) {
        server.runManager.register({
          id: runId,
          sessionId: sess.id,
          intentId: intent.id,
          retryOf: "",
          attempt: 1,
          workDir: "",
          source: "",
          model: "",
          mode: "",
          status: "",
          startedAt: now,
          updatedAt: now,
          finishedAt: null,
          error: "",
          errorInfo: null,
          progress: null,
          usage: null,
          contextUsage: null,
          inputResourceIds: [],
          submissionKeyHash: "",
          submissionScope: "",
          submissionFingerprint: "",
          userEntryId: "",
          assistantEntryId: "",
        });
      }

      const agentOpts = buildAgentOptionsForSession(server, sess, model, mode);
      agentOpts.intentId = intent.id;
      agentOpts.runId = runId;
      agentOpts.conversationTurnId = "turn-" + intent.id;
      agentOpts.conversationTurn = true;
      agentOpts.runtimeOwnsTurnEnd = true;
      if ((req.systemPrompt ?? "").trim() !== "") {
        agentOpts.extraContext = (agentOpts.extraContext ?? "") +
          "\n## Client Instructions\n" + req.systemPrompt!.trim();
      }
      if ((req.maxTokens ?? 0) > 0) {
        agentOpts.maxTokens = req.maxTokens;
        agentOpts.maxTokensSet = true;
      }
      let artifacts: { close(): void };
      try {
        artifacts = sess.runtime!.beginArtifactCollection(runId)!;
      } catch (err) {
        try {
          await execution.finishDurableWithRetry(
            undefined,
            runId,
            "failed",
            (err as Error).message,
            {
              sessionId: sess.id,
              runId,
              eventType: "failed",
              source: runSource,
              status: "failed",
              model: model.id,
              mode,
              timestamp: new Date(),
            } satisfies RunEvent,
          );
        } catch {
          // Go ignores the finish error (`_ =`).
        }
        sess.finishRun(runId);
        throw new Error(
          `begin Runtime artifact collection: ${(err as Error).message}`,
        );
      }
      // Keep the pin until the coordinator has released the session/runtime
      // locks; lock and release ownership transfer to the coordinator task.
      unpin = false;
      locked = false;
      const release = () => {
        runtimeRelease();
        server.pool!.unpin(sess);
      };
      const onComplete: ResponsesBackgroundCompleteFn = (
        response: string,
        attachments: Attachment[],
        runErr: Error | null,
      ) => {
        if (!req.progress) return;
        if (runErr) {
          req.progress(
            "Responses background run failed: " +
              safeAgentErrorMessage(runErr),
          );
          return;
        }
        const summary = formatAttachmentSummary(attachments);
        if (summary !== "") {
          if (response.trim() !== "") response += "\n\n";
          response += summary;
        }
        if (response.trim() !== "") req.progress(response);
      };
      void (async () => {
        try {
          artifacts.close();
        } catch {
          // Go defers artifacts.Close inside the goroutine; errors are ignored.
        }
        await executeResponsesBackgroundRunWithConfig(
          server,
          sess,
          runId,
          release,
          model,
          mode,
          message,
          true,
          agentOpts,
          req.initialHistory ?? [],
          onComplete,
          req.progress,
        );
      })();
      return runId;
    } catch (err) {
      if (locked) {
        sess.mu.unlock();
        runtimeRelease();
      }
      throw err;
    }
  } finally {
    if (unpin) server.pool.unpin(sess);
  }
}

/** Lazy import-free capability check (avoids a coordinator import cycle). */
function responsesBackgroundEnabledOf(server: Server): boolean {
  const provider = server.provider as
    | { responsesBackgroundEnabled?: () => boolean }
    | undefined;
  return server.responsesRuns !== undefined &&
    typeof provider?.responsesBackgroundEnabled === "function" &&
    provider.responsesBackgroundEnabled();
}

/**
 * Binds the external submitter to a Server (Go's method value
 * `s.SubmitExternalResponsesBackground`).
 */
export function submitExternalResponsesBackgroundFn(
  server: Server,
): (req: BackgroundRequest) => Promise<string> {
  return (req) => submitExternalResponsesBackground(server, req);
}
