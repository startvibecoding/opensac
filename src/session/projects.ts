//
// Project and session-metadata registry. These are short administrative writes:
// they intentionally skip the runtime lease fence and rely on single-statement
// SQLite transactions for correctness, so they stay usable while a Run lease is
// held.

import { ProjectDAO, type SessionMetadataRecord } from "../dao/mod.ts";
import { generateID } from "./entry.ts";
import { openExistingSessionDB, openRootDB } from "./root_db.ts";

/** A durable project a session can be assigned to. */
export interface Project {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

/** The persisted project/pin metadata of one session. */
export interface SessionMetadata {
  projectId?: string;
  pinned: boolean;
  /**
   * The persisted revision time of the metadata row. It is read-only output;
   * `setSessionMetadata` always stamps the write time itself.
   */
  updatedAt?: Date;
}

export function parseProjectTime(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (match) {
    return new Date(
      Date.UTC(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        Number(match[6]),
      ),
    );
  }
  return new Date(value);
}

export function boolToInt(v: boolean): number {
  return v ? 1 : 0;
}

/** Lists every project in updated-descending order. */
export function listProjects(sessionDir: string): Project[] {
  const db = openExistingSessionDB(sessionDir);
  if (db === null) return [];
  const records = new ProjectDAO(db.db).list();
  return records.map((record) => ({
    id: record.id,
    name: record.name,
    createdAt: parseProjectTime(record.createdAt),
    updatedAt: parseProjectTime(record.updatedAt),
  }));
}

/** Creates a project and returns its persisted projection. */
export function createProject(sessionDir: string, name: string): Project {
  name = name.trim();
  if (name === "") throw new Error("project name is required");
  const db = openRootDB(sessionDir);
  const now = new Date();
  const id = generateID();
  new ProjectDAO(db.db).insert({
    id,
    name,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  return { id, name, createdAt: now, updatedAt: now };
}

/** Renames a project, rejecting an unknown ID. */
export function renameProject(
  sessionDir: string,
  id: string,
  name: string,
): Project {
  id = id.trim();
  name = name.trim();
  if (id === "" || name === "") {
    throw new Error("project ID and name are required");
  }
  const db = openRootDB(sessionDir);
  const now = new Date();
  const changed = new ProjectDAO(db.db).updateName(id, name, now.toISOString());
  if (changed === 0) throw new Error("project not found");
  // Go returns a zero CreatedAt here; an invalid Date mirrors that.
  return { id, name, createdAt: new Date(NaN), updatedAt: now };
}

/** Deletes a project, first detaching every session metadata row. */
export function deleteProject(sessionDir: string, id: string): void {
  if (id.trim() === "") throw new Error("project ID is required");
  const db = openRootDB(sessionDir);
  const dao = new ProjectDAO(db.db);
  // Realize the declared ON DELETE SET NULL reference semantics explicitly so
  // session assignments never outlive their project, regardless of SQLite
  // foreign-key enforcement.
  dao.clearMetadataProject(id);
  dao.delete(id);
}

/** Upserts the project/pin metadata of one session. */
export function setSessionMetadata(
  sessionDir: string,
  sessionId: string,
  metadata: SessionMetadata,
): void {
  if (sessionId.trim() === "") throw new Error("session ID is required");
  const db = openRootDB(sessionDir);
  const dao = new ProjectDAO(db.db);
  const projectId = (metadata.projectId ?? "").trim();
  if (projectId !== "") {
    if (!dao.exists(projectId)) throw new Error("project not found");
  }
  const record: SessionMetadataRecord = {
    sessionId,
    projectId: projectId !== "" ? projectId : null,
    pinned: boolToInt(metadata.pinned),
    updatedAt: new Date().toISOString(),
  };
  dao.upsertMetadata(record);
}

/** Returns the latest persisted session title and its source. */
export function latestSessionTitle(
  sessionDir: string,
  sessionId: string,
): { name: string; source: string } {
  const db = openExistingSessionDB(sessionDir);
  if (db === null) return { name: "", source: "" };
  const data = new ProjectDAO(db.db).latestSessionInfoData(sessionId);
  if (data === undefined) return { name: "", source: "" };
  const entry = JSON.parse(data) as { name?: string; source?: string };
  return { name: entry.name ?? "", source: entry.source ?? "" };
}

/** Returns the persisted project/pin metadata of one session. */
export function getSessionMetadata(
  sessionDir: string,
  sessionId: string,
): SessionMetadata {
  const db = openExistingSessionDB(sessionDir);
  if (db === null) return { pinned: false };
  const record = new ProjectDAO(db.db).metadata(sessionId);
  if (record === null) return { pinned: false };
  const metadata: SessionMetadata = {
    pinned: record.pinned !== 0,
    updatedAt: parseProjectTime(record.updatedAt),
  };
  if (record.projectId !== null) metadata.projectId = record.projectId;
  return metadata;
}

/**
 * Returns the persisted project/pin metadata of the given sessions in one
 * read-only query, keyed by session ID. Sessions without a metadata row are
 * absent from the result.
 */
export function listSessionMetadata(
  sessionDir: string,
  sessionIds: string[],
): Map<string, SessionMetadata> {
  const result = new Map<string, SessionMetadata>();
  if (sessionIds.length === 0) return result;
  const db = openExistingSessionDB(sessionDir);
  if (db === null) return result;
  const records = new ProjectDAO(db.db).metadataForSessions(sessionIds);
  for (const record of records) {
    const metadata: SessionMetadata = {
      pinned: record.pinned !== 0,
      updatedAt: parseProjectTime(record.updatedAt),
    };
    if (record.projectId !== null) metadata.projectId = record.projectId;
    result.set(record.sessionId, metadata);
  }
  return result;
}

/**
 * Returns how many sessions are currently assigned to each project. It is a
 * read-only projection for project listings.
 */
export function projectSessionCounts(sessionDir: string): Map<string, number> {
  const db = openExistingSessionDB(sessionDir);
  if (db === null) return new Map();
  return new ProjectDAO(db.db).sessionCountsByProject();
}
