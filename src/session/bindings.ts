//
// Channel/session bindings and channel-tool selections. These are short
// administrative writes that intentionally skip the runtime lease fence.
//
// The Manager-returning helpers (`rotateBoundSession`, `createBound`) and the
// `Manager.setSessionBinding`/`setExpertBinding`/`setWorkDir` methods now live
// with the Manager in `manager.ts`.

import { BindingDAO, isNoRows } from "../dao/mod.ts";
import { openRootDB } from "./root_db.ts";

/** A current external channel binding. */
export interface Binding {
  sessionId: string;
  channelType: string;
  channelId: string;
}

/** One persisted tool selection for a channel session. */
export interface ChannelToolConfig {
  toolName: string;
  enabled: boolean;
}

/**
 * Validates a channel binding identity. An empty channel type normalizes to
 * "local".
 */
export function validateBinding(
  channelType: string,
  channelId: string,
): void {
  if (channelType === "") channelType = "local";
  if (channelType === "local" && channelId !== "") {
    throw new Error("local session cannot have channel ID");
  }
  if (
    channelType !== "local" && channelType !== "wechat" &&
    channelType !== "feishu"
  ) {
    throw new Error(`unsupported channel type ${JSON.stringify(channelType)}`);
  }
  if (channelType !== "local" && channelId === "") {
    throw new Error(`channel ID is required for ${channelType} session`);
  }
}

/** Lists the persisted channel-tool selections of a session. */
export function listChannelTools(
  sessionDir: string,
  sessionId: string,
): ChannelToolConfig[] {
  const db = openRootDB(sessionDir);
  const records = new BindingDAO(db.db).listChannelTools(sessionId);
  return records.map((record) => ({
    toolName: record.toolName,
    enabled: record.enabled,
  }));
}

/** Replaces the persisted channel-tool selections of a session. */
export function setChannelTools(
  sessionDir: string,
  sessionId: string,
  tools: ChannelToolConfig[],
): void {
  if (sessionId === "") throw new Error("session ID is required");
  const db = openRootDB(sessionDir);
  const records = tools
    .map((item) => ({
      sessionId,
      toolName: item.toolName.trim(),
      enabled: item.enabled,
    }))
    .filter((item) => item.toolName !== "");
  new BindingDAO(db.db).setChannelTools(sessionId, records);
}

/** Returns the generation counter of a session's channel-tool selections. */
export function getChannelToolGeneration(
  sessionDir: string,
  sessionId: string,
): number {
  const db = openRootDB(sessionDir);
  return new BindingDAO(db.db).channelToolGeneration(sessionId);
}

/** Lists every current external channel binding. */
export function listBindings(sessionDir: string): Binding[] {
  const db = openRootDB(sessionDir);
  let records;
  try {
    records = new BindingDAO(db.db).list();
  } catch (err) {
    throw new Error(`list session bindings: ${message(err)}`);
  }
  return records.map((record) => ({
    sessionId: record.sessionId,
    channelType: record.channelType,
    channelId: record.channelId,
  }));
}

/** Finds the session bound to a channel identity, or null. */
export function findBinding(
  sessionDir: string,
  channelType: string,
  channelId: string,
): Binding | null {
  validateBinding(channelType, channelId);
  const db = openRootDB(sessionDir);
  try {
    const record = new BindingDAO(db.db).find(channelType, channelId);
    return {
      sessionId: record.sessionId,
      channelType: record.channelType,
      channelId: record.channelId,
    };
  } catch (err) {
    if (isNoRows(err)) return null;
    throw new Error(`find session binding: ${message(err)}`);
  }
}

/** Returns the current external binding for a session, or null. */
export function findBindingBySessionId(
  sessionDir: string,
  sessionId: string,
): Binding | null {
  if (sessionId === "") throw new Error("session ID is required");
  const db = openRootDB(sessionDir);
  try {
    const record = new BindingDAO(db.db).findBySession(sessionId);
    return {
      sessionId: record.sessionId,
      channelType: record.channelType,
      channelId: record.channelId,
    };
  } catch (err) {
    if (isNoRows(err)) return null;
    throw new Error(`find session binding: ${message(err)}`);
  }
}

/** Binds a session to an external channel identity. */
export function bindSession(
  sessionDir: string,
  sessionId: string,
  channelType: string,
  channelId: string,
): void {
  if (sessionId === "") throw new Error("session ID is required");
  validateBinding(channelType, channelId);
  if (channelType === "local") {
    throw new Error("use unbindSession to make a session local");
  }
  const db = openRootDB(sessionDir);
  new BindingDAO(db.db).bind(sessionId, channelType, channelId);
}

/** Makes a channel-bound session local while retaining its history. */
export function unbindSession(sessionDir: string, sessionId: string): void {
  if (sessionId === "") throw new Error("session ID is required");
  const db = openRootDB(sessionDir);
  new BindingDAO(db.db).unbind(sessionId);
}

/** Atomically moves a channel identity from one session to another. */
export function transferBinding(
  sessionDir: string,
  channelType: string,
  channelId: string,
  fromSessionId: string,
  toSessionId: string,
): void {
  if (channelType !== "wechat" && channelType !== "feishu") {
    throw new Error(`unsupported channel type ${JSON.stringify(channelType)}`);
  }
  if (channelId === "" || fromSessionId === "" || toSessionId === "") {
    throw new Error("channel ID and session IDs are required");
  }
  if (fromSessionId === toSessionId) {
    throw new Error("source and target sessions must differ");
  }
  const db = openRootDB(sessionDir);
  new BindingDAO(db.db).transfer(
    channelType,
    channelId,
    fromSessionId,
    toSessionId,
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
