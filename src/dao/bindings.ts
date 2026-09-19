// Ported from internal/dao/bindings.go

import type { DB } from "../db/mod.ts";
import { runInTx } from "../db/mod.ts";
import {
  ErrNoRows,
  execChanges,
  isNoRows,
  queryAll,
  queryOne,
  queryOptional,
} from "./database.ts";

export interface BindingRecord {
  sessionId: string;
  channelType: string;
  channelId: string;
}

export interface ChannelToolRecord {
  sessionId: string;
  toolName: string;
  enabled: boolean;
}

export interface ChannelToolGenerationRecord {
  sessionId: string;
  generation: number;
  updatedAt: string;
}

/** Owns session/channel binding and channel-tool persistence. */
export class BindingDAO {
  constructor(private readonly db: DB | null) {}

  listChannelTools(sessionId: string): ChannelToolRecord[] {
    return queryAll<Record<string, unknown>>(
      this.requireDb(),
      `SELECT session_id AS sessionId, tool_name AS toolName, enabled
       FROM session_channel_tools WHERE session_id = ? ORDER BY tool_name`,
      [sessionId],
    ).map((row) => ({
      sessionId: String(row.sessionId),
      toolName: String(row.toolName),
      enabled: Number(row.enabled) !== 0,
    }));
  }

  setChannelTools(sessionId: string, tools: ChannelToolRecord[]): void {
    runInTx(this.requireDb(), (tx) => {
      const session = queryOne<Record<string, unknown>>(
        tx,
        `SELECT id FROM sessions WHERE id = ? LIMIT 1`,
        [sessionId],
      );
      void session;
      execChanges(
        tx,
        `DELETE FROM session_channel_tools WHERE session_id = ?`,
        [
          sessionId,
        ],
      );
      for (const tool of tools) {
        execChanges(
          tx,
          `INSERT INTO session_channel_tools (session_id, tool_name, enabled)
           VALUES (?, ?, ?)`,
          [sessionId, tool.toolName, tool.enabled ? 1 : 0],
        );
      }
      const changed = execChanges(
        tx,
        `UPDATE session_channel_tool_generations
         SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ?`,
        [sessionId],
      );
      if (changed === 0) {
        execChanges(
          tx,
          `INSERT INTO session_channel_tool_generations
             (session_id, generation, updated_at) VALUES (?, ?, ?)`,
          [sessionId, 1, nowRFC3339Nano()],
        );
      }
    });
  }

  channelToolGeneration(sessionId: string): number {
    let row: Record<string, unknown>;
    try {
      row = queryOne<Record<string, unknown>>(
        this.requireDb(),
        `SELECT generation FROM session_channel_tool_generations
         WHERE session_id = ? LIMIT 1`,
        [sessionId],
      );
    } catch (err) {
      if (isNoRows(err)) return 0;
      throw err;
    }
    return Number(row.generation);
  }

  list(): BindingRecord[] {
    return queryAll<BindingRecord>(
      this.requireDb(),
      `SELECT id AS sessionId, channel_type AS channelType, channel_id AS channelId
       FROM sessions
       WHERE channel_type IN ('wechat', 'feishu') AND channel_id <> ''
       ORDER BY channel_type, channel_id`,
    );
  }

  find(channelType: string, channelId: string): BindingRecord {
    return queryOne<BindingRecord>(
      this.requireDb(),
      `SELECT id AS sessionId, channel_type AS channelType, channel_id AS channelId
       FROM sessions WHERE channel_type = ? AND channel_id = ? LIMIT 1`,
      [channelType, channelId],
    );
  }

  findBySession(sessionId: string): BindingRecord {
    return queryOne<BindingRecord>(
      this.requireDb(),
      `SELECT id AS sessionId, channel_type AS channelType, channel_id AS channelId
       FROM sessions
       WHERE id = ? AND channel_type IN ('wechat', 'feishu') AND channel_id <> ''
       LIMIT 1`,
      [sessionId],
    );
  }

  bind(sessionId: string, channelType: string, channelId: string): void {
    runInTx(this.requireDb(), (tx) => {
      let current: BindingRecord;
      try {
        current = queryOne<BindingRecord>(
          tx,
          `SELECT id AS sessionId, channel_type AS channelType, channel_id AS channelId
           FROM sessions WHERE id = ? LIMIT 1`,
          [sessionId],
        );
      } catch (err) {
        if (isNoRows(err)) {
          throw new Error(`session "${sessionId}" not found`);
        }
        throw new Error(`read session binding: ${message(err)}`);
      }
      if (current.channelType !== "local" || current.channelId !== "") {
        throw new Error(
          `session "${sessionId}" is already bound to ${current.channelType}/${current.channelId}`,
        );
      }
      const other = queryOptional<Record<string, unknown>>(
        tx,
        `SELECT id FROM sessions
         WHERE channel_type = ? AND channel_id = ? AND id <> ? LIMIT 1`,
        [channelType, channelId, sessionId],
      );
      if (other) {
        throw new Error(`identity is already bound to session "${other.id}"`);
      }
      execChanges(
        tx,
        `UPDATE sessions SET channel_type = ?, channel_id = ? WHERE id = ?`,
        [channelType, channelId, sessionId],
      );
    });
  }

  unbind(sessionId: string): void {
    const changed = execChanges(
      this.requireDb(),
      `UPDATE sessions SET channel_type = ?, channel_id = ? WHERE id = ?`,
      ["local", "", sessionId],
    );
    if (changed === 0) throw new Error(`session "${sessionId}" not found`);
  }

  transfer(
    channelType: string,
    channelId: string,
    fromSessionId: string,
    toSessionId: string,
  ): void {
    runInTx(this.requireDb(), (tx) => {
      let source: BindingRecord;
      try {
        source = queryOne<BindingRecord>(
          tx,
          `SELECT id AS sessionId, channel_type AS channelType, channel_id AS channelId
           FROM sessions WHERE id = ? LIMIT 1`,
          [fromSessionId],
        );
      } catch (err) {
        throw new Error(`read source binding: ${message(err)}`);
      }
      if (
        source.channelType !== channelType || source.channelId !== channelId
      ) {
        throw new Error(
          `source session is not bound to ${channelType}/${channelId}`,
        );
      }
      let target: BindingRecord;
      try {
        target = queryOne<BindingRecord>(
          tx,
          `SELECT id AS sessionId, channel_type AS channelType, channel_id AS channelId
           FROM sessions WHERE id = ? LIMIT 1`,
          [toSessionId],
        );
      } catch (err) {
        throw new Error(`read target session: ${message(err)}`);
      }
      if (target.channelType !== "local" || target.channelId !== "") {
        throw new Error("target session is already bound");
      }
      execChanges(
        tx,
        `UPDATE sessions SET channel_type = ?, channel_id = ? WHERE id = ?`,
        ["local", "", fromSessionId],
      );
      execChanges(
        tx,
        `UPDATE sessions SET channel_type = ?, channel_id = ? WHERE id = ?`,
        [channelType, channelId, toSessionId],
      );
    });
  }

  rotate(
    workDir: string,
    channelType: string,
    channelId: string,
    oldSessionId: string,
    version: number,
    id: string,
    timestamp: string,
  ): void {
    runInTx(this.requireDb(), (tx) => {
      const current = queryOne<BindingRecord>(
        tx,
        `SELECT id AS sessionId, channel_type AS channelType, channel_id AS channelId
         FROM sessions WHERE id = ? LIMIT 1`,
        [oldSessionId],
      );
      if (
        current.channelType !== channelType || current.channelId !== channelId
      ) {
        throw new Error(
          `session is no longer bound to ${channelType}/${channelId}`,
        );
      }
      execChanges(
        tx,
        `UPDATE sessions SET channel_type = ?, channel_id = ? WHERE id = ?`,
        ["local", "", oldSessionId],
      );
      execChanges(
        tx,
        `INSERT INTO sessions
          (id, cwd, timestamp, parent_session, version, channel_type, channel_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, workDir, timestamp, null, version, channelType, channelId],
      );
    });
  }

  private requireDb(): DB {
    if (this.db === null) throw new Error("binding database is nil");
    return this.db;
  }
}

function nowRFC3339Nano(): string {
  return new Date().toISOString();
}

function message(err: unknown): string {
  if (err === ErrNoRows) return "sql: no rows in result set";
  return err instanceof Error ? err.message : String(err);
}
