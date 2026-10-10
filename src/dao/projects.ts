import type { DB } from "../db/mod.ts";
import { execChanges, inList, queryAll, queryOptional } from "./database.ts";

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionMetadataRecord {
  sessionId: string;
  projectId: string | null;
  pinned: number;
  updatedAt: string;
}

export class ProjectDAO {
  private readonly db: DB | null;

  constructor(db: DB | null) {
    this.db = db;
  }

  list(): ProjectRecord[] {
    return queryAll<ProjectRecord>(
      this.requireDb(),
      `SELECT id, name, created_at AS createdAt, updated_at AS updatedAt
       FROM projects ORDER BY updated_at DESC, name COLLATE NOCASE`,
    );
  }

  insert(record: ProjectRecord): void {
    execChanges(
      this.requireDb(),
      `INSERT INTO projects (id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
      [record.id, record.name, record.createdAt, record.updatedAt],
    );
  }

  updateName(id: string, name: string, updatedAt: string): number {
    return execChanges(
      this.requireDb(),
      `UPDATE projects SET name = ?, updated_at = ? WHERE id = ?`,
      [name, updatedAt, id],
    );
  }

  delete(id: string): void {
    execChanges(this.requireDb(), `DELETE FROM projects WHERE id = ?`, [id]);
  }

  exists(id: string): boolean {
    const row = queryOptional<Record<string, unknown>>(
      this.requireDb(),
      `SELECT 1 AS v FROM projects WHERE id = ? LIMIT 1`,
      [id],
    );
    return row !== undefined;
  }

  upsertMetadata(record: SessionMetadataRecord): void {
    execChanges(
      this.requireDb(),
      `INSERT INTO session_metadata (session_id, project_id, pinned, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         project_id = excluded.project_id,
         pinned = excluded.pinned,
         updated_at = excluded.updated_at`,
      [record.sessionId, record.projectId, record.pinned, record.updatedAt],
    );
  }

  metadata(sessionId: string): SessionMetadataRecord | null {
    return (
      queryOptional<SessionMetadataRecord>(
        this.requireDb(),
        `SELECT session_id AS sessionId, project_id AS projectId, pinned,
              updated_at AS updatedAt
       FROM session_metadata WHERE session_id = ? LIMIT 1`,
        [sessionId],
      ) ?? null
    );
  }

  /**
   * Returns the persisted metadata rows of the given sessions in one read-only
   * query, in stable session order. Sessions without a row are simply absent.
   */
  metadataForSessions(sessionIds: string[]): SessionMetadataRecord[] {
    if (sessionIds.length === 0) return [];
    const { sql, params } = inList(sessionIds);
    return queryAll<SessionMetadataRecord>(
      this.requireDb(),
      `SELECT session_id AS sessionId, project_id AS projectId, pinned,
              updated_at AS updatedAt
       FROM session_metadata WHERE session_id IN (${sql})
       ORDER BY session_id ASC`,
      params,
    );
  }

  /** Counts how many session metadata rows reference each project. */
  sessionCountsByProject(): Map<string, number> {
    const rows = queryAll<{ projectId: string; count: number }>(
      this.requireDb(),
      `SELECT project_id AS projectId, COUNT(*) AS count
       FROM session_metadata
       WHERE project_id IS NOT NULL AND project_id != ''
       GROUP BY project_id`,
    );
    return new Map(rows.map((row) => [row.projectId, Number(row.count)]));
  }

  /**
   * Detaches every session metadata row from one project, matching the
   * ON DELETE SET NULL reference semantics regardless of FK enforcement.
   */
  clearMetadataProject(projectId: string): void {
    execChanges(
      this.requireDb(),
      `UPDATE session_metadata SET project_id = NULL WHERE project_id = ?`,
      [projectId],
    );
  }

  latestSessionInfoData(sessionId: string): string | undefined {
    return queryOptional<{ data: string }>(
      this.requireDb(),
      `SELECT data FROM entries
       WHERE session_id = ? AND type = ? ORDER BY seq DESC LIMIT 1`,
      [sessionId, "session_info"],
    )?.data;
  }

  now(): string {
    return new Date().toISOString();
  }

  private requireDb(): DB {
    if (this.db === null) throw new Error("project database is not open");
    return this.db;
  }
}
