import { assert, assertEquals } from "../../compat/assert.ts";
import { type Attachment } from "../types.ts";
import {
  resolveAttachment,
  resolveAttachmentWithMetadata,
} from "./attachments.ts";
import { createOpenAIProvider } from "./provider.ts";
import { mockClient } from "./test_helpers.ts";
import { test } from "#testing";

test("ResolveAttachmentDownloadsAuthorizedProviderFile", async () => {
  const p = createOpenAIProvider("test-key", "https://api.test/v1", []);
  p.client = mockClient((req) => {
    if (req.url !== "https://api.test/v1/files/file_123/content") {
      throw new Error(`unexpected url ${req.url}`);
    }
    if (req.headers.get("Authorization") !== "Bearer test-key") {
      throw new Error(`authorization = ${req.headers.get("Authorization")}`);
    }
    return new Response("downloaded", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  });

  const content = await resolveAttachment(p, undefined, "file_123");
  assertEquals(new TextDecoder().decode(content.data), "downloaded");
  assertEquals(content.mediaType, "text/plain");

  let rejected = false;
  try {
    await resolveAttachment(p, undefined, "../secret");
  } catch {
    rejected = true;
  }
  assert(rejected, "invalid attachment reference was accepted");
});

test("ResolveAttachmentWithMetadataUsesCodeInterpreterContainer", async () => {
  const p = createOpenAIProvider("test-key", "https://api.test/v1", []);
  p.client = mockClient((req) => {
    if (
      req.url !==
        "https://api.test/v1/containers/container_123/files/file_123/content"
    ) {
      throw new Error(`request path = ${req.url}`);
    }
    return new Response("a,b\n1,2\n", {
      status: 200,
      headers: { "Content-Type": "text/csv" },
    });
  });

  const attachment: Attachment = {
    kind: "file",
    providerRef: "file_123",
    metadata: { containerId: "container_123" },
  };
  const content = await resolveAttachmentWithMetadata(p, undefined, attachment);
  assertEquals(content.mediaType, "text/csv");
  assertEquals(new TextDecoder().decode(content.data), "a,b\n1,2\n");
});
