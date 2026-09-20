// Translated/focused tests for internal/agentruntime/input.go's
// `AttachmentService`. The Go tests that require `SessionRuntime`
// (`AcceptProviderAttachment`, artifact collection) land with the
// `SessionRuntime` slice; these cover the Runtime-owned private store directly.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  AttachmentFile,
  AttachmentImage,
  defaultAttachmentPolicy,
  type SessionAttachment,
} from "./attachment.ts";
import { AttachmentService } from "./input.ts";
import { writeRootDatabase } from "../session/database.ts";
import { newManager } from "../session/manager.ts";
import { closeDatabases } from "../session/root_db.ts";

function inputTestSession(): {
  root: string;
  workDir: string;
  sessionId: string;
} {
  const root = Deno.makeTempDirSync({ prefix: "mothx-input-" });
  const workDir = Deno.makeTempDirSync({ prefix: "mothx-work-" });
  const manager = newManager(workDir, root);
  manager.init();
  return { root, workDir, sessionId: manager.getHeader()!.id };
}

async function publishTestArtifact(
  service: AttachmentService,
  sessionId: string,
  runId: string,
  filename: string,
  content: string,
): Promise<SessionAttachment> {
  const bytes = new TextEncoder().encode(content);
  const record = await service.acceptArtifact(sessionId, runId, {
    origin: "test",
    reference: "runtime-artifact",
    kind: AttachmentFile,
    filename,
    mediaType: "text/plain",
    sizeHint: bytes.length,
    open: () => ({ bytes, filename, mediaType: "text/plain" }),
  });
  service.SetStatus(sessionId, record.id, "generated");
  record.status = "generated";
  return record;
}

async function readAll(file: Deno.FsFile): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const buf = new Uint8Array(64 * 1024);
  while (true) {
    const n = await file.read(buf);
    if (n === null) break;
    chunks.push(buf.slice(0, n));
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

Deno.test("AcceptArtifactStoresPrivateContentAndReopensIt", async () => {
  const { root, sessionId } = inputTestSession();
  try {
    const service = new AttachmentService(root, defaultAttachmentPolicy());
    const record = await publishTestArtifact(
      service,
      sessionId,
      "run-output",
      "report.txt",
      "generated report",
    );
    assertEquals(record.status, "generated");
    assertEquals(record.origin, "test");
    assertEquals(record.kind, AttachmentFile);
    assert(record.storageKey.startsWith("artifacts/"));
    assert(!record.storageKey.startsWith(".mothx/"));
    assertEquals(record.bytes, "generated report".length);
    assertEquals(record.sha256.length, 64);

    const { file } = await service.Open(sessionId, record.id);
    const data = new TextDecoder().decode(await readAll(file));
    file.close();
    assertEquals(data, "generated report");
  } finally {
    closeDatabases();
  }
});

Deno.test("ArtifactOpenRejectsPrivateStoreTampering", async () => {
  const { root, sessionId } = inputTestSession();
  try {
    const service = new AttachmentService(root, defaultAttachmentPolicy());
    const record = await publishTestArtifact(
      service,
      sessionId,
      "run-1",
      "result.txt",
      "original",
    );
    const path = service.storagePath(record.storageKey);
    await Deno.writeTextFile(path, "tampered");
    const err = await assertRejects(() => service.Open(sessionId, record.id));
    assert(String(err).includes("hash mismatch"));
  } finally {
    closeDatabases();
  }
});

Deno.test("ArtifactCleanupExpiresPrivateContent", async () => {
  const { root, sessionId } = inputTestSession();
  try {
    const service = new AttachmentService(root, {
      maxImageBytes: 1 << 20,
      maxFileBytes: 1 << 20,
      retention: 60 * 60 * 1000,
    });
    const record = await publishTestArtifact(
      service,
      sessionId,
      "run-1",
      "expired.txt",
      "expired",
    );
    writeRootDatabase(root, (tx) => {
      const past = new Date(Date.now() - 60_000).toISOString();
      tx.run(
        `UPDATE session_attachments SET expires_at = ? WHERE id = ?`,
        past,
        record.id,
      );
    });
    const { count } = await service.CleanupExpired();
    assertEquals(count, 1);
    const err = await assertRejects(() => service.Open(sessionId, record.id));
    assert(String(err).includes("expired"));
    // The content file is gone.
    let exists = true;
    try {
      await Deno.stat(service.storagePath(record.storageKey));
    } catch {
      exists = false;
    }
    assertEquals(exists, false);
  } finally {
    closeDatabases();
  }
});

Deno.test("AcceptArtifactRejectsUnsupportedKindAndKindMismatch", async () => {
  const { root, sessionId } = inputTestSession();
  try {
    const service = new AttachmentService(root, defaultAttachmentPolicy());
    await assertRejects(() =>
      service.acceptArtifact(sessionId, "run-1", {
        origin: "test",
        reference: "",
        kind: "bogus" as never,
        filename: "x",
        mediaType: "text/plain",
        sizeHint: 1,
        open: () => ({ bytes: new Uint8Array([1]) }),
      })
    );
    // Non-image bytes requested as an image are rejected by sniffing.
    await assertRejects(() =>
      service.acceptArtifact(sessionId, "run-1", {
        origin: "test",
        reference: "",
        kind: AttachmentImage,
        filename: "not-an-image.txt",
        mediaType: "image/png",
        sizeHint: 5,
        open: () => ({ bytes: new TextEncoder().encode("hello") }),
      })
    );
  } finally {
    closeDatabases();
  }
});

Deno.test("SetStatusRejectsUnknownStatusAndMissingRow", () => {
  const { root, sessionId } = inputTestSession();
  try {
    const service = new AttachmentService(root, defaultAttachmentPolicy());
    assertEquals(
      (() => {
        try {
          service.SetStatus(sessionId, "0123456789abcdef", "bogus");
          return false;
        } catch {
          return true;
        }
      })(),
      true,
    );
    assertEquals(
      (() => {
        try {
          service.SetStatus(sessionId, "0123456789abcdef", "generated");
          return false;
        } catch {
          return true;
        }
      })(),
      true,
    );
  } finally {
    closeDatabases();
  }
});
