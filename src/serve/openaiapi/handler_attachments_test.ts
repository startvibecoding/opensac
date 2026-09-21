// Translated from internal/serve/openaiapi/handler_attachments_test.go,
// adapted to the Response-returning handler projection with duck-typed
// resolvers instead of the Go test's openai provider against an upstream
// stub (the resolver contract is what the handler consumes).
import { assertEquals } from "@std/assert";
import { Server } from "./server.ts";
import { SessionPool } from "./session_mgr.ts";
import {
  archivedFileAttachment,
  attachmentFilename,
  attachmentMediaType,
  handleAttachmentAPI,
} from "./handler_attachments.ts";
import type { Settings } from "../../config/settings.ts";
import { closeAll } from "../../db/mod.ts";
import { ConversationTurnDAO } from "../../dao/mod.ts";
import { createSession } from "../../agentruntime/session_lifecycle.ts";
import { openRootDB } from "../../session/root_db.ts";
import type { AttachmentContent } from "../../provider/attachments.ts";
import type { Provider } from "../../provider/provider.ts";
import type { Attachment } from "../../provider/types.ts";

function tempDir(): string {
  return Deno.makeTempDirSync({ prefix: "mothx-openaiapi-attach-" });
}

function settingsFor(dir: string): Settings {
  return { sessionDir: dir } as unknown as Settings;
}

function serverFor(dir: string): Server {
  return new Server({
    pool: new SessionPool(0, 0),
    settings: settingsFor(dir),
  });
}

function appendAttachmentMessage(
  dir: string,
  sessionId: string,
  id: string,
  attachment: Record<string, unknown>,
) {
  const db = openRootDB(dir);
  new ConversationTurnDAO(null).appendEntry(db.db!, {
    seq: 0,
    sessionId,
    id,
    type: "message",
    parentId: null,
    timestamp: new Date("2026-01-01T00:00:00Z").toISOString(),
    data: JSON.stringify({
      type: "message",
      id,
      parentId: null,
      timestamp: new Date("2026-01-01T00:00:00Z").toISOString(),
      message: { role: "assistant", attachments: [attachment] },
    }),
  });
}

function getRequest(ref: string, sessionId?: string): Request {
  const suffix = sessionId === undefined ? "" : `?session_id=${sessionId}`;
  return new Request(`http://localhost/api/attachments/${ref}${suffix}`);
}

Deno.test("attachmentFilename sanitizes path and control characters", () => {
  assertEquals(
    attachmentFilename('../report\\"\\n.csv', "fallback"),
    ".._report__n.csv",
  );
  assertEquals(attachmentFilename("", "file_1"), "file_1");
});

Deno.test("attachmentMediaType sniffs when the provider type is missing or unsound", () => {
  const data = new TextEncoder().encode("file body");
  assertEquals(
    attachmentMediaType("text/plain; charset=utf-16", data),
    "text/plain",
  );
  assertEquals(attachmentMediaType("", data), "text/plain; charset=utf-8");
  assertEquals(
    attachmentMediaType("noslash", data),
    "text/plain; charset=utf-8",
  );
  assertEquals(attachmentMediaType("text/plain\r\n", data), "text/plain");
});

Deno.test("handleAttachmentAPI rejects invalid references before the archive lookup", async () => {
  const dir = tempDir();
  try {
    createSession({ workDir: "/tmp", sessionDir: dir, id: "s1" });
    const server = serverFor(dir);
    for (
      const ref of [
        "..%2Fsecret",
        "file%2Fsecret",
        "file%5Cnsecret",
        "x".repeat(129),
      ]
    ) {
      const resp = await handleAttachmentAPI(server, getRequest(ref, "s1"));
      assertEquals(resp.status, 400, ref);
    }
  } finally {
    closeAll();
  }
});

Deno.test("handleAttachmentAPI authorizes archived file references through a resolver", async () => {
  const dir = tempDir();
  try {
    createSession({ workDir: "/tmp", sessionDir: dir, id: "s1" });
    appendAttachmentMessage(dir, "s1", "e1", {
      kind: "file",
      providerRef: "file_123",
    });
    const server = serverFor(dir);
    server.provider = {
      resolveAttachment: (
        _signal: AbortSignal | undefined,
        ref: string,
      ): Promise<AttachmentContent> => {
        assertEquals(ref, "file_123");
        return Promise.resolve({
          data: new TextEncoder().encode("file body"),
          mediaType: "text/plain",
          filename: "",
        });
      },
    } as unknown as Provider;
    const resp = await handleAttachmentAPI(
      server,
      getRequest("file_123", "s1"),
    );
    assertEquals(resp.status, 200);
    assertEquals(await resp.text(), "file body");
    assertEquals(resp.headers.get("content-type"), "text/plain");
    assertEquals(resp.headers.get("x-content-type-options"), "nosniff");
    assertEquals(resp.headers.get("cache-control"), "no-store");
    assertEquals(
      resp.headers.get("content-security-policy"),
      "default-src 'none'; sandbox",
    );
    assertEquals(
      resp.headers.get("content-disposition"),
      'attachment; filename="file_123"',
    );

    // A ref that is not archived for this session is refused.
    const missing = await handleAttachmentAPI(
      server,
      getRequest("file_other", "s1"),
    );
    assertEquals(missing.status, 404);
    assertIncludes(await missing.text(), "not archived");
  } finally {
    closeAll();
  }
});

Deno.test("handleAttachmentAPI prefers the metadata resolver and passes provenance", async () => {
  const dir = tempDir();
  try {
    createSession({ workDir: "/tmp", sessionDir: dir, id: "s1" });
    appendAttachmentMessage(dir, "s1", "e1", {
      kind: "file",
      providerRef: "file_123",
      metadata: { containerId: "container_123" },
    });
    const server = serverFor(dir);
    server.provider = {
      resolveAttachment: () => {
        throw new Error("plain resolver must not be used");
      },
      resolveAttachmentWithMetadata: (
        _signal: AbortSignal | undefined,
        attachment: Attachment,
      ) => {
        assertEquals(attachment.providerRef, "file_123");
        assertEquals(attachment.metadata, { containerId: "container_123" });
        return Promise.resolve({
          data: new TextEncoder().encode("a,b\n1,2\n"),
          mediaType: "text/csv",
          filename: "",
        });
      },
    } as unknown as Provider;
    const resp = await handleAttachmentAPI(
      server,
      getRequest("file_123", "s1"),
    );
    assertEquals(resp.status, 200);
    assertEquals(await resp.text(), "a,b\n1,2\n");
    assertEquals(resp.headers.get("content-type"), "text/csv");
  } finally {
    closeAll();
  }
});

Deno.test("handleAttachmentAPI validates method, session, and capability", async () => {
  const dir = tempDir();
  try {
    createSession({ workDir: "/tmp", sessionDir: dir, id: "s1" });
    const server = serverFor(dir);
    const method = await handleAttachmentAPI(
      server,
      new Request("http://localhost/api/attachments/file_1", {
        method: "POST",
      }),
    );
    assertEquals(method.status, 405);

    const noSession = await handleAttachmentAPI(
      server,
      getRequest("file_1"),
    );
    assertEquals(noSession.status, 400);

    const unknownSession = await handleAttachmentAPI(
      server,
      getRequest("file_1", "missing"),
    );
    assertEquals(unknownSession.status, 404);

    // The archive hit requires a resolver-capable provider.
    appendAttachmentMessage(dir, "s1", "e1", {
      kind: "file",
      providerRef: "vendor_file_1",
    });
    const noResolver = await handleAttachmentAPI(
      server,
      getRequest("vendor_file_1", "s1"),
    );
    assertEquals(noResolver.status, 501);

    // Resolver failures surface as upstream errors.
    server.provider = {
      resolveAttachment: () => Promise.reject(new Error("boom")),
    } as unknown as Provider;
    const upstream = await handleAttachmentAPI(
      server,
      getRequest("vendor_file_1", "s1"),
    );
    assertEquals(upstream.status, 502);
    assertIncludes(await upstream.text(), "download attachment: boom");
  } finally {
    closeAll();
  }
});

Deno.test("archivedFileAttachment returns the archived attachment or null", () => {
  const dir = tempDir();
  try {
    createSession({ workDir: "/tmp", sessionDir: dir, id: "s1" });
    const server = serverFor(dir);
    assertEquals(archivedFileAttachment(server, "s1", "file_1"), null);
    appendAttachmentMessage(dir, "s1", "e1", {
      kind: "file",
      providerRef: "file_123",
    });
    const found = archivedFileAttachment(server, "s1", "file_123");
    assertEquals(found?.providerRef, "file_123");
    assertEquals(found?.kind, "file");
  } finally {
    closeAll();
  }
});

function assertIncludes(body: string, needle: string) {
  if (!body.includes(needle)) {
    throw new Error(
      `body ${JSON.stringify(body)} lacks ${JSON.stringify(needle)}`,
    );
  }
}
