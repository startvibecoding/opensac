import { runtime } from "../platform/runtime.ts";
import { assertEquals, assertFalse } from "../compat/assert.ts";
import { AttachmentDAO, type AttachmentRecord } from "../dao/mod.ts";
import { closeAll } from "../db/mod.ts";
import { listGeneratedArtifacts, listSessionAttachments } from "./artifacts.ts";
import { writeRootDatabase } from "./database.ts";
import { test } from "#testing";

function record(overrides: Partial<AttachmentRecord>): AttachmentRecord {
  return {
    id: "",
    sessionId: "",
    runId: "",
    origin: "",
    kind: "",
    filename: "",
    mediaType: "",
    bytes: 0,
    sha256: "",
    storageKey: "",
    status: "",
    createdAt: "",
    expiresAt: "",
    metadata: "{}",
    ...overrides,
  };
}

test("list generated artifacts filters status and session in creation order", () => {
  const sessionDir = runtime.makeTempDirSync({ prefix: "opensac-session-" });
  try {
    const sessionId = "session-artifacts";
    const otherSessionId = "session-artifacts-other";
    const now = Date.now();
    const expires = new Date(now + 3_600_000).toISOString();
    const records: AttachmentRecord[] = [
      record({
        id: "att-later",
        sessionId,
        runId: "run-2",
        origin: "tool:publish_artifact",
        kind: "file",
        filename: "later.txt",
        mediaType: "text/plain",
        bytes: 5,
        sha256: "sum-later",
        storageKey: "artifacts/att-later/content",
        status: "generated",
        createdAt: new Date(now + 1_000).toISOString(),
        expiresAt: expires,
      }),
      record({
        id: "att-first",
        sessionId,
        runId: "run-1",
        origin: "tool:publish_artifact",
        kind: "image",
        filename: "first.png",
        mediaType: "image/png",
        bytes: 3,
        sha256: "sum-first",
        storageKey: "artifacts/att-first/content",
        status: "generated",
        createdAt: new Date(now).toISOString(),
        expiresAt: expires,
      }),
      record({
        id: "att-input",
        sessionId,
        runId: "run-1",
        origin: "acp",
        kind: "file",
        filename: "input.txt",
        mediaType: "text/plain",
        bytes: 2,
        sha256: "sum-input",
        storageKey: "artifacts/att-input/content",
        status: "accepted",
        createdAt: new Date(now).toISOString(),
        expiresAt: expires,
      }),
      record({
        id: "att-foreign",
        sessionId: otherSessionId,
        runId: "run-9",
        origin: "tool:publish_artifact",
        kind: "file",
        filename: "foreign.txt",
        mediaType: "text/plain",
        bytes: 4,
        sha256: "sum-foreign",
        storageKey: "artifacts/att-foreign/content",
        status: "generated",
        createdAt: new Date(now).toISOString(),
        expiresAt: expires,
      }),
    ];
    writeRootDatabase(sessionDir, (tx) => {
      for (const row of records) new AttachmentDAO(null).insert(tx, row);
    });

    const artifacts = listGeneratedArtifacts(sessionDir, sessionId);
    assertEquals(
      artifacts.length,
      2,
      "want only the two generated rows of this session",
    );
    assertEquals(artifacts[0].id, "att-first");
    assertEquals(artifacts[1].id, "att-later");
    const first = artifacts[0];
    assertEquals(first.sessionId, sessionId);
    assertEquals(first.runId, "run-1");
    assertEquals(first.kind, "image");
    assertEquals(first.filename, "first.png");
    assertEquals(first.mediaType, "image/png");
    assertEquals(first.bytes, 3);
    assertEquals(first.status, "generated");
    assertEquals(first.origin, "tool:publish_artifact");
    assertFalse(Number.isNaN(first.createdAt.getTime()));

    assertEquals(listGeneratedArtifacts(sessionDir, ""), []);
    assertEquals(
      listGeneratedArtifacts(sessionDir, "session-without-artifacts"),
      [],
    );

    const all = listSessionAttachments(sessionDir, sessionId, "");
    assertEquals(all.length, 3, "empty status returns every row");
    const generatedOnly = listSessionAttachments(
      sessionDir,
      sessionId,
      "generated",
    );
    assertEquals(generatedOnly.length, 2);
  } finally {
    closeAll();
  }
});
