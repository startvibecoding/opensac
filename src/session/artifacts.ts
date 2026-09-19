// Ported from internal/session/artifacts.go
//
// Read-only projections of persisted session attachment rows for adapter replay
// surfaces. The bytes stay in the Runtime-owned private store referenced by the
// attachment row and are never embedded here; all SQL stays in the DAO.

import { AttachmentDAO, type AttachmentRecord } from "../dao/mod.ts";
import { openRootDB, parseSessionTimestamp } from "./root_db.ts";

/**
 * The canonical read-only projection of one persisted session attachment row.
 * Despite the artifact-oriented name it projects any attachment origin/status.
 */
export interface GeneratedArtifact {
  id: string;
  sessionId: string;
  runId: string;
  origin: string;
  kind: string;
  filename: string;
  mediaType: string;
  bytes: number;
  status: string;
  createdAt: Date;
}

/**
 * Returns every attachment persisted for sessionId whose lifecycle status is
 * "generated", in durable creation order. Adapters use it for replay
 * projections (for example ACP session/load).
 */
export function listGeneratedArtifacts(
  sessionDir: string,
  sessionId: string,
): GeneratedArtifact[] {
  if (sessionId === "") return [];
  const db = openRootDB(sessionDir);
  const records = new AttachmentDAO(db.db).listBySessionStatus(
    sessionId,
    "generated",
  );
  return records.map(generatedArtifactFromRecord);
}

/**
 * Returns metadata-only projections of the persisted attachment rows of one
 * session, optionally filtered by lifecycle status (an empty status returns
 * every row), in durable creation order. Adapters use it for listing surfaces
 * (for example ACP mothx/attachment/list).
 */
export function listSessionAttachments(
  sessionDir: string,
  sessionId: string,
  status: string,
): GeneratedArtifact[] {
  if (sessionId === "") return [];
  const db = openRootDB(sessionDir);
  const records = new AttachmentDAO(db.db).listBySession(sessionId, status);
  return records.map(generatedArtifactFromRecord);
}

function generatedArtifactFromRecord(
  record: AttachmentRecord,
): GeneratedArtifact {
  return {
    id: record.id,
    sessionId: record.sessionId,
    runId: record.runId,
    origin: record.origin,
    kind: record.kind,
    filename: record.filename,
    mediaType: record.mediaType,
    bytes: record.bytes,
    status: record.status,
    createdAt: parseSessionTimestamp(record.createdAt),
  };
}
