// Translated/focused tests for internal/agentruntime/input_materializer.go.
//
// The Go `AgentRuntime`-bound methods (`AcceptInput`/`BuildUserMessage`) are
// covered by session_runtime_test.ts; the manifest assertion here exercises
// the materializer's own deterministic `buildManifest` instead.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import * as path from "@std/path";
import { InputResourceDAO } from "../dao/mod.ts";
import { createManager } from "../session/manager.ts";
import { closeDatabases, openRootDB } from "../session/root_db.ts";
import { listInputResourceEvents } from "../session/input_resources.ts";
import { writeRootDatabase } from "../session/database.ts";
import { sanitizeAttachmentFilename } from "./attachment.ts";
import {
  defaultInputPolicy,
  type InputIngress,
  InputMaterializer,
} from "./input_materializer.ts";

const encoder = new TextEncoder();

function inputTestSession(): {
  root: string;
  workDir: string;
  sessionId: string;
} {
  const root = Deno.makeTempDirSync({ prefix: "opensac-inputmat-" });
  const workDir = Deno.makeTempDirSync({ prefix: "opensac-work-" });
  const manager = createManager(workDir, root);
  manager.init();
  return { root, workDir, sessionId: manager.getHeader()!.id };
}

function bytesIngress(
  overrides: Partial<InputIngress> & { content: Uint8Array },
): InputIngress {
  const { content, ...rest } = overrides;
  return {
    origin: "test",
    eventId: "",
    itemIndex: 0,
    reference: "",
    kind: "file",
    filenameHint: "",
    mediaTypeHint: "",
    sizeHint: 0,
    open: () => ({ bytes: content }),
    ...rest,
  };
}

function onePixelPNG(): Uint8Array {
  return decodeBase64(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl8P6sAAAAASUVORK5CYII=",
  );
}

Deno.test("InputMaterializerWritesProjectResourceAndManifest", async () => {
  const { root, workDir, sessionId } = inputTestSession();
  try {
    const materializer = new InputMaterializer(
      root,
      workDir,
      defaultInputPolicy(),
    );
    const record = await materializer.Prepare(
      sessionId,
      "run-1",
      bytesIngress({
        origin: "test",
        eventId: "message-1",
        itemIndex: 0,
        reference: "secret-reference",
        content: encoder.encode("hello input"),
        filenameHint: "notes.txt",
        mediaTypeHint: "text/plain",
      }),
    );
    assert(record.relativePath.startsWith(".opensac/tmp/inputs/"));
    assert(!path.isAbsolute(record.relativePath));
    const contentPath = path.join(workDir, ...record.relativePath.split("/"));
    assertEquals(await Deno.readTextFile(contentPath), "hello input");

    const conn = openRootDB(root).db!;
    const stored = new InputResourceDAO(null).find(conn, sessionId, record.id);
    assert(stored !== undefined);
    assert(!stored.metadata.includes("secret-reference"));

    const manifest = materializer.buildManifest([record]);
    assert(manifest.includes(record.relativePath));
    assert(manifest.includes("Use read"));
    assertEquals(
      sanitizeAttachmentFilename(record.filename),
      "notes.txt",
    );
  } finally {
    closeDatabases();
  }
});

Deno.test(
  "InputMaterializerCanonicalizesImageWithoutDirectProviderContent",
  async () => {
    const { root, workDir, sessionId } = inputTestSession();
    try {
      const materializer = new InputMaterializer(
        root,
        workDir,
        defaultInputPolicy(),
      );
      const record = await materializer.Prepare(
        sessionId,
        "run-image",
        bytesIngress({
          kind: "image",
          content: onePixelPNG(),
          filenameHint: "screen.bin",
          mediaTypeHint: "application/octet-stream",
        }),
      );
      assertEquals(record.mediaType, "image/png");
      assertEquals(path.extname(record.filename), ".png");
      const manifest = materializer.buildManifest([record]);
      assert(manifest.includes(record.relativePath));
    } finally {
      closeDatabases();
    }
  },
);

Deno.test("InputMaterializerDetectsExtensionlessWebP", async () => {
  const { root, workDir, sessionId } = inputTestSession();
  try {
    const materializer = new InputMaterializer(
      root,
      workDir,
      defaultInputPolicy(),
    );
    const data = decodeBase64(
      "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
    );
    const record = await materializer.Prepare(
      sessionId,
      "run-webp",
      bytesIngress({
        kind: "image",
        eventId: "webp-event",
        content: data,
        filenameHint: "clipboard",
      }),
    );
    assertEquals(record.mediaType, "image/webp");
    assertEquals(path.extname(record.filename), ".webp");
  } finally {
    closeDatabases();
  }
});

Deno.test("InputMaterializerDeduplicatesConcurrentEventItem", async () => {
  const { root, workDir, sessionId } = inputTestSession();
  try {
    const materializer = new InputMaterializer(
      root,
      workDir,
      defaultInputPolicy(),
    );
    const ingress = bytesIngress({
      origin: "channel:wechat",
      eventId: "event-42",
      itemIndex: 1,
      content: encoder.encode("same bytes"),
      filenameHint: "same.txt",
    });
    const [first, second] = await Promise.all([
      materializer.Prepare(sessionId, "run-1", ingress),
      materializer.Prepare(sessionId, "run-1", ingress),
    ]);
    assert(first.id !== "");
    assertEquals(first.id, second.id);

    const conn = openRootDB(root).db!;
    const count = new InputResourceDAO(null).list(conn, sessionId).length;
    assertEquals(count, 1);
  } finally {
    closeDatabases();
  }
});

Deno.test("InputMaterializerUsesStableHMACForReferenceFallback", async () => {
  const { root, workDir, sessionId } = inputTestSession();
  try {
    const materializer = new InputMaterializer(
      root,
      workDir,
      defaultInputPolicy(),
    );
    const ingress = bytesIngress({
      origin: "wechat",
      reference: "opaque-reference",
      itemIndex: 3,
      content: encoder.encode("voice"),
      filenameHint: "voice.amr",
      mediaTypeHint: "audio/amr",
    });
    const first = await materializer.Prepare(sessionId, "", ingress);
    const second = await materializer.Prepare(sessionId, "", ingress);
    assertEquals(first.id, second.id);
    assert(first.itemKey !== "");
    assertEquals(first.eventId, "");
    assert(!first.itemKey.includes("opaque-reference"));

    const other = new InputMaterializer(root, workDir, defaultInputPolicy());
    const third = await other.Prepare(sessionId, "", ingress);
    assertEquals(third.id, first.id);
  } finally {
    closeDatabases();
  }
});

Deno.test("InputResourceLifecycleEventsAndDraftCleanup", async () => {
  const { root, workDir, sessionId } = inputTestSession();
  try {
    const materializer = new InputMaterializer(root, workDir, {
      maxImageBytes: 1 << 20,
      maxFileBytes: 1 << 20,
      maxImagePixels: 100,
      draftMaxAge: 60 * 60 * 1000,
    });
    const record = await materializer.Prepare(
      sessionId,
      "",
      bytesIngress({
        origin: "tui",
        eventId: "paste-event",
        content: encoder.encode("draft"),
        filenameHint: "draft.txt",
      }),
    );
    let events = listInputResourceEvents(root, sessionId);
    assertEquals(events.length, 1);
    assertEquals(events[0].eventType, "input_resource_prepared");

    const contentPath = path.join(workDir, ...record.relativePath.split("/"));
    Deno.statSync(contentPath);

    materializer.Discard(sessionId, record.id);
    let exists = true;
    try {
      Deno.statSync(contentPath);
    } catch {
      exists = false;
    }
    assertEquals(exists, false);

    events = listInputResourceEvents(root, sessionId);
    assertEquals(events.length, 2);
    assertEquals(events[1].eventType, "input_resource_deleted");

    const old = await materializer.Prepare(
      sessionId,
      "",
      bytesIngress({
        origin: "acp",
        eventId: "old-draft",
        content: encoder.encode("old"),
        filenameHint: "old.txt",
      }),
    );
    writeRootDatabase(root, (tx) => {
      const past = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      tx.run(
        `UPDATE input_resources SET created_at = ? WHERE id = ?`,
        past,
        old.id,
      );
    });
    const removed = materializer.Cleanup(sessionId, new Date());
    assertEquals(removed, 1);
    let oldExists = true;
    try {
      Deno.statSync(path.join(workDir, ...old.relativePath.split("/")));
    } catch {
      oldExists = false;
    }
    assertEquals(oldExists, false);
  } finally {
    closeDatabases();
  }
});

Deno.test("InputMaterializerRejectsOversizedAndInvalidImage", async () => {
  const { root, workDir, sessionId } = inputTestSession();
  try {
    const materializer = new InputMaterializer(root, workDir, {
      maxImageBytes: 32,
      maxFileBytes: 4,
      maxImagePixels: 4,
      draftMaxAge: 60 * 60 * 1000,
    });
    const oversized = await assertRejects(() =>
      materializer.Prepare(
        sessionId,
        "run-1",
        bytesIngress({
          content: encoder.encode("12345"),
          filenameHint: "large.bin",
        }),
      )
    );
    assert(String(oversized).includes("exceeds 4 bytes"));

    const invalid = await assertRejects(() =>
      materializer.Prepare(
        sessionId,
        "run-2",
        bytesIngress({
          kind: "image",
          content: encoder.encode("not an image"),
          filenameHint: "broken.png",
        }),
      )
    );
    assert(String(invalid).includes("detected media type"));

    const conn = openRootDB(root).db!;
    assertEquals(new InputResourceDAO(null).list(conn, sessionId).length, 0);
  } finally {
    closeDatabases();
  }
});
