//
// The Runtime-owned transcript identity and admission helpers for a Run's
// canonical user/assistant entries. Deterministic IDs make terminal retries and
// recovery idempotent.
//
// Deviations from Go: `provider.Message` maps to the TS `Message` interface and
// the assistant-message fingerprint uses `node:crypto` SHA-256.

import { createHash } from "node:crypto";
import { ConversationTurnDAO } from "../dao/mod.ts";
import { type Tx } from "../dao/mod.ts";
import { type Message } from "../provider/types.ts";
import { entryMessage, type MessageEntry } from "./entry.ts";
import {
  appendTurnEntryTx,
  currentLeafTx,
  stringPtr,
} from "./conversation_turn.ts";
import { type SessionRun } from "./run_store.ts";

/**
 * The deterministic transcript identity for a Run's admitted user message.
 * Retries do not create another user entry.
 */
export function runUserEntryID(runId: string): string {
  if (runId === "") return "";
  return "run-user-" + runId;
}

/**
 * The deterministic transcript identity for the final assistant entry
 * committed by a Runtime-owned conversation Run.
 */
export function runAssistantEntryID(runId: string): string {
  if (runId === "") return "";
  return "run-assistant-" + runId;
}

/**
 * The deterministic lifecycle event identity for a terminal Run. The event type
 * is included so a cancelled recovery cannot collide with a previously selected
 * terminal outcome.
 */
export function runTerminalEventID(runId: string, eventType: string): string {
  if (runId === "" || eventType === "") return "";
  return "run-terminal-" + runId + "-" + eventType;
}

/**
 * Returns a stable digest for an assistant message, so a recovery payload can
 * be validated without persisting the message in a separate table.
 */
export function runAssistantMessageFingerprint(
  runId: string,
  message: Message,
): string {
  try {
    const encoded = JSON.stringify({ runId, message });
    if (encoded === undefined) return "";
    const digest = createHash("sha256").update(encoded).digest("hex");
    return "sha256:" + digest;
  } catch {
    return "";
  }
}

/**
 * Appends the admitted user entry for a Run in the caller's transaction.
 */
export function appendRunUserMessageTx(tx: Tx, run: SessionRun): void {
  if (run.userMessage === undefined) return;
  if (run.sessionId === "" || run.id === "") {
    throw new Error("session run identity is required for user entry");
  }
  const message: Message = { ...run.userMessage };
  if (message.systemInjected) {
    throw new Error("runtime-admitted user entry cannot be system injected");
  }
  if (message.role === "") message.role = "user";
  if (message.role !== "user") {
    throw new Error("runtime-admitted entry must have user role");
  }
  if (
    !(message.timestamp instanceof Date) ||
    isNaN(message.timestamp.getTime())
  ) {
    message.timestamp = run.startedAt;
    if (
      !(message.timestamp instanceof Date) ||
      isNaN(message.timestamp.getTime())
    ) {
      message.timestamp = new Date();
    }
  }
  let entryId = run.userEntryId;
  if (entryId === "") entryId = runUserEntryID(run.id);
  const parentId = currentLeafTx(tx, run.sessionId);
  const entry: MessageEntry = {
    type: entryMessage,
    id: entryId,
    parentId: stringPtr(parentId),
    timestamp: message.timestamp,
    message,
  };
  try {
    appendTurnEntryTx(tx, run.sessionId, entry, parentId);
  } catch (err) {
    throw new Error(`append runtime user entry: ${errorMessage(err)}`);
  }
}

/**
 * Appends the final assistant message during the same transaction that closes
 * the Run/turn and creates delivery operations. Existing deterministic IDs are
 * treated as an idempotent retry.
 */
export function appendRunAssistantMessageTx(tx: Tx, run: SessionRun): void {
  if (run.assistantMessage === undefined) return;
  if (run.sessionId === "" || run.id === "") {
    throw new Error("session run identity is required for assistant entry");
  }
  const message: Message = { ...run.assistantMessage };
  if (message.systemInjected) {
    throw new Error("runtime assistant entry cannot be system injected");
  }
  if (message.role === "") message.role = "assistant";
  if (message.role !== "assistant") {
    throw new Error("runtime assistant entry must have assistant role");
  }
  if (
    !(message.timestamp instanceof Date) ||
    isNaN(message.timestamp.getTime())
  ) {
    if (
      run.finishedAt !== null &&
      run.finishedAt !== undefined &&
      !isNaN(run.finishedAt.getTime())
    ) {
      message.timestamp = run.finishedAt;
    } else if (
      run.startedAt instanceof Date &&
      !isNaN(run.startedAt.getTime())
    ) {
      message.timestamp = run.startedAt;
    } else {
      // A recovery payload without lifecycle timestamps still needs a
      // deterministic value so an idempotent retry cannot change its fingerprint.
      message.timestamp = new Date(0);
    }
  }
  let entryId = run.assistantEntryId;
  if (entryId === "") entryId = runAssistantEntryID(run.id);
  const dao = new ConversationTurnDAO(null);
  const existingRecord = dao.entry(tx, entryId);
  if (existingRecord !== undefined) {
    if (
      existingRecord.sessionId !== run.sessionId ||
      existingRecord.type !== entryMessage
    ) {
      throw new Error(
        `assistant entry ${entryId} belongs to another session or entry type`,
      );
    }
    let existing: MessageEntry;
    try {
      existing = JSON.parse(existingRecord.data) as MessageEntry;
    } catch {
      throw new Error(
        `assistant entry ${entryId} has invalid persisted content`,
      );
    }
    if (
      runAssistantMessageFingerprint(run.id, existing.message) !==
      runAssistantMessageFingerprint(run.id, message)
    ) {
      throw new Error(
        `assistant entry ${entryId} conflicts with the terminal message`,
      );
    }
    return;
  }
  const parentId = currentLeafTx(tx, run.sessionId);
  const entry: MessageEntry = {
    type: entryMessage,
    id: entryId,
    parentId: stringPtr(parentId),
    timestamp: message.timestamp,
    message,
  };
  try {
    appendTurnEntryTx(tx, run.sessionId, entry, parentId);
  } catch (err) {
    throw new Error(`append runtime assistant entry: ${errorMessage(err)}`);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
