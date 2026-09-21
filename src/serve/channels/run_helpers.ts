// Ported from internal/serve/channels/dispatcher.go — the dependency-light
// failure projection, run-state, idempotency, and progress-formatting helpers
// that the Dispatcher's message path composes.
//
// Deviations: Go's errors.Is/As chains map to instanceof/`name` checks with
// the port's context mapping (`AbortError` ↔ context.Canceled,
// `TimeoutError` ↔ context.DeadlineExceeded); Go's `incompleteRunError` maps
// to the `IncompleteRunError` marker class.

import { createHash } from "node:crypto";
import {
  type Event,
  EventError,
  EventRunFinished,
  taskStatusIsSuccessful,
} from "../../agent/events.ts";
import {
  classifyError,
  type DeliveryCapability,
  displayErrorMessage,
  type ErrorInfo,
  PhaseModel,
  policyForSource,
  type RunPhase,
  type RunState,
  RunStateCancelled,
  RunStateCompleted,
  RunStateFailed,
  RunStateIncomplete,
  RunStateTimedOut,
} from "../../agentruntime/mod.ts";
import {
  ModeYolo,
  resolvePolicy,
  sourceFromChannelType,
} from "../../agentruntime/mod.ts";
import type { InboundMessage } from "../../messaging/platform.ts";
import { formatAttachmentSummary } from "../runtime/attachments.ts";

/** Marks a run that ended without a terminal agent outcome. */
export class IncompleteRunError extends Error {
  constructor() {
    super("agent run incomplete");
    this.name = "IncompleteRunError";
  }
}

export function isIncompleteRunError(err: unknown): boolean {
  if (err instanceof IncompleteRunError) return true;
  if (err instanceof Error && err.name === "IncompleteRunError") return true;
  // Unwrap chain: cause links keep markers discoverable through wrappers.
  let cause: unknown = err;
  while (cause instanceof Error && cause.cause) {
    cause = cause.cause;
    if (cause instanceof IncompleteRunError) return true;
    if (cause instanceof Error && cause.name === "IncompleteRunError") {
      return true;
    }
  }
  return false;
}

/**
 * ChannelRunFailure carries the Runtime-owned, safe error projection while
 * retaining the original cause for lifecycle checks. Its message is what the
 * messaging transport presents to users.
 */
export class ChannelRunFailure extends Error {
  override readonly cause: unknown;
  readonly info: ErrorInfo;

  constructor(cause: unknown, info: ErrorInfo) {
    super(channelRunFailureMessage(info));
    this.name = "ChannelRunFailure";
    this.cause = cause;
    this.info = info;
  }
}

function channelRunFailureMessage(info: ErrorInfo): string {
  const message = displayErrorMessage(info).trim();
  return message !== "" ? message : "The run could not be completed.";
}

export function newChannelRunFailure(
  err: unknown,
  observed: ErrorInfo | undefined,
  phase: RunPhase,
): ChannelRunFailure {
  const info = channelFailureInfo(err, observed, phase);
  return new ChannelRunFailure(err, info);
}

export function channelFailureInfo(
  err: unknown,
  observed: ErrorInfo | undefined,
  phase: RunPhase,
): ErrorInfo {
  if (observed && displayErrorMessage(observed).trim() !== "") {
    return observed;
  }
  if (err instanceof ChannelRunFailure) {
    const info = err.info;
    if (displayErrorMessage(info).trim() !== "") {
      return info;
    }
  }
  let cause: unknown = err;
  while (cause instanceof Error && cause.cause) {
    cause = cause.cause;
    if (cause instanceof ChannelRunFailure) {
      const info = cause.info;
      if (displayErrorMessage(info).trim() !== "") {
        return info;
      }
      break;
    }
  }
  return classifyError(err, { phase });
}

/**
 * Keeps observer-facing terminal failures within the same safe Runtime
 * contract as main channel runs. The original error remains available to the
 * dispatcher for logging before this projection is emitted.
 */
export function channelSafeSubAgentEvent(ev: Event): Event {
  if (ev.type === EventError) {
    const info = channelFailureInfo(ev.error, undefined, PhaseModel);
    return { ...ev, error: new Error(displayErrorMessage(info)) };
  }
  if (ev.type === EventRunFinished) {
    if (!ev.status || !taskStatusIsSuccessful(ev.status)) {
      const info = channelFailureInfo(ev.error, undefined, PhaseModel);
      return { ...ev, error: new Error(displayErrorMessage(info)) };
    }
  }
  return ev;
}

/** Maps a run failure onto the canonical RunState vocabulary. */
export function channelRunState(runErr: unknown): RunState {
  if (runErr instanceof Error && runErr.name === "TimeoutError") {
    return RunStateTimedOut;
  }
  if (isIncompleteRunError(runErr)) {
    return RunStateIncomplete;
  }
  if (runErr instanceof Error && runErr.name === "AbortError") {
    return RunStateCancelled;
  }
  if (runErr != null) {
    return RunStateFailed;
  }
  return RunStateCompleted;
}

/**
 * Resolves the effective channel mode through the shared Runtime policy.
 * Channel mode resolution is fail-closed: a malformed persisted value must
 * never be returned as an executable mode.
 */
export function effectiveChannelMode(
  platform: string,
  requestedMode: string,
): string {
  const source = sourceFromChannelType(platform);
  const result = resolvePolicy(
    { current: source, requested: source },
    "",
    requestedMode,
    ModeYolo,
  );
  if (result.error) {
    const policy = policyForSource(source, ModeYolo);
    if (policy.hasForcedMode()) {
      return policy.forcedMode();
    }
    return ModeYolo;
  }
  return result.mode;
}

/** Per-platform delivery capability for channel sessions. */
export function channelDeliveryCapability(
  platform: string,
): DeliveryCapability {
  const capability: DeliveryCapability = {
    text: true,
    sendImage: false,
    sendFile: false,
    sendVideo: false,
  };
  const name = platform.trim().toLowerCase();
  if (name === "wechat") {
    capability.sendImage = true;
    capability.sendFile = true;
    capability.sendVideo = true;
  }
  if (name === "feishu") {
    capability.sendImage = true;
    capability.sendFile = true;
  }
  return capability;
}

/**
 * Builds the idempotency key for an inbound channel message. Provider event
 * IDs are scoped to the channel identity; transports without a native ID hash
 * the stable envelope and attachment references.
 */
export function channelMessageIdempotencyKey(
  msg: InboundMessage,
): string {
  const platform = msg.platform.trim();
  const userID = msg.userID.trim();
  const messageID = (msg.messageID ?? "").trim();
  if (messageID !== "") {
    return `channel:${platform}:${userID}:${messageID}`;
  }
  const parts: string[] = [
    platform,
    userID,
    msg.chatID.trim(),
    msg.text,
  ];
  if (msg.timestamp && !Number.isNaN(msg.timestamp.getTime())) {
    parts.push(msg.timestamp.toISOString());
  }
  for (const attachment of msg.attachments ?? []) {
    parts.push("", attachment.messageID.trim(), attachment.reference.trim());
  }
  if (parts.every((p) => p === "")) {
    return "";
  }
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex");
  return `channel:${platform}:${userID}:fallback:${digest}`;
}

/** Formats a retry/continuation event into a concise progress line. */
export function formatRetryProgress(ev: Event): string {
  let message = "↻ Retrying";
  if (ev.retryContinue) {
    message = "↻ Continuing response";
  }
  if (
    ev.retryAttempt && ev.retryAttempt > 0 && ev.retryMaxAttempts &&
    ev.retryMaxAttempts > 0
  ) {
    message += ` (${ev.retryAttempt}/${ev.retryMaxAttempts})`;
  }
  if (ev.retryAfterMs && ev.retryAfterMs > 0) {
    message += `; waiting ${formatDuration(ev.retryAfterMs)}`;
  }
  return message + "...";
}

/** Go-style duration rounding used by the retry progress line. */
function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 1) return `${Math.round(ms)}ms`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  if (minutes < 60) return rem > 0 ? `${minutes}m${rem}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mrem = minutes % 60;
  return mrem > 0 ? `${hours}h${mrem}m` : `${hours}h`;
}

/**
 * Formats a tool execution event into a concise one-line progress string.
 */
export function formatToolProgress(
  ev: Event,
  args: Record<string, unknown>,
): string {
  let name = ev.toolName ?? "";
  if (name === "" && ev.toolCall) {
    name = ev.toolCall.name;
  }
  if (name === "") {
    return "";
  }

  const icon = ev.toolError ? "❌" : "✅";

  // Build a concise summary per tool type
  switch (name) {
    case "read":
    case "write":
    case "edit":
    case "insert": {
      const path = args["path"];
      if (typeof path === "string") {
        return `[${name}]: ${path} ${icon}`;
      }
      break;
    }
    case "bash": {
      const cmd = args["command"];
      if (typeof cmd === "string") {
        const short = cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd;
        return `[bash]: ${short} ${icon}`;
      }
      break;
    }
    case "grep": {
      const pat = args["pattern"];
      if (typeof pat === "string") {
        return `[grep]: ${pat} ${icon}`;
      }
      break;
    }
    case "find": {
      const pat = args["pattern"];
      if (typeof pat === "string") {
        return `[find]: ${pat} ${icon}`;
      }
      break;
    }
    case "ls": {
      const path = args["path"];
      if (typeof path === "string") {
        return `[ls]: ${path} ${icon}`;
      }
      break;
    }
  }

  return `[${name}] ${icon}`;
}

export { formatAttachmentSummary };
