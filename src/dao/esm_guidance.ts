import type { DB } from "../db/mod.ts";
import { execChanges, queryAll } from "./database.ts";

export interface ESMGuidanceRecord {
  id: string;
  sessionId: string;
  objectiveVersion: string;
  guidance: string;
  status: string;
  createdAt: string;
  consumedAt: string | null;
}

const columns = `id, session_id AS sessionId,
  objective_version AS objectiveVersion, guidance, status,
  created_at AS createdAt, consumed_at AS consumedAt`;

export class ESMGuidanceDAO {
    private readonly db: DB | null;

  constructor(db: DB | null) {
    this.db = db;
  }

  insert(executor: DB, record: ESMGuidanceRecord): void {
    execChanges(
      executor,
      `INSERT INTO session_esm_guidance
        (id, session_id, objective_version, guidance, status, created_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.sessionId,
        record.objectiveVersion,
        record.guidance,
        record.status,
        record.createdAt,
        record.consumedAt,
      ],
    );
  }

  list(sessionId: string, status: string, limit: number): ESMGuidanceRecord[] {
    const db = this.requireDb();
    if (status !== "") {
      return queryAll<ESMGuidanceRecord>(
        db,
        `SELECT ${columns} FROM session_esm_guidance
         WHERE session_id = ? AND status = ?
         ORDER BY created_at ASC LIMIT ?`,
        [sessionId, status, limit],
      );
    }
    return queryAll<ESMGuidanceRecord>(
      db,
      `SELECT ${columns} FROM session_esm_guidance
       WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`,
      [sessionId, limit],
    );
  }

  consume(
    executor: DB,
    sessionId: string,
    id: string,
    consumedAt: string,
  ): void {
    execChanges(
      executor,
      `UPDATE session_esm_guidance SET status = ?, consumed_at = ?
       WHERE id = ? AND session_id = ? AND status = ?`,
      ["consumed", consumedAt, id, sessionId, "pending"],
    );
  }

  private requireDb(): DB {
    if (this.db === null) throw new Error("esm guidance database is not open");
    return this.db;
  }
}
