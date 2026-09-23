// Focused tests for the public ExternalTool -> internal Tool adapter.

import { assert, assertEquals, assertRejects } from "@std/assert";
import type {
  ExternalTool,
  ExternalToolPromptInfo,
} from "../../sdk/agent/external_tool.ts";
import { createExternalToolAdapter } from "./external_tool_adapter.ts";

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

Deno.test("external adapter maps name/description and snippet fallback", () => {
  const tool: ExternalTool = {
    name: () => "host_tool",
    description: () => "does host things",
    parameters: () => encode({ type: "object", properties: {} }),
    execute: () => Promise.resolve({ text: "ok" }),
  };
  const adapted = createExternalToolAdapter(tool);
  assertEquals(adapted.name(), "host_tool");
  assertEquals(adapted.description(), "does host things");
  assertEquals(adapted.promptSnippet(), "does host things");
  assertEquals(adapted.promptGuidelines(), []);
});

Deno.test("external adapter honors prompt info interface", () => {
  const tool: ExternalTool & ExternalToolPromptInfo = {
    name: () => "host_tool",
    description: () => "does host things",
    parameters: () => encode({ type: "object" }),
    execute: () => Promise.resolve({ text: "ok" }),
    promptSnippet: () => "short",
    promptGuidelines: () => ["one", "two"],
  };
  const adapted = createExternalToolAdapter(tool);
  assertEquals(adapted.promptSnippet(), "short");
  assertEquals(adapted.promptGuidelines(), ["one", "two"]);
});

Deno.test("external adapter defaults empty parameters", () => {
  const tool: ExternalTool = {
    name: () => "t",
    description: () => "d",
    parameters: () => new Uint8Array(),
    execute: () => Promise.resolve({ text: "" }),
  };
  const adapted = createExternalToolAdapter(tool);
  assertEquals(adapted.parameters(), { type: "object", properties: {} });
});

Deno.test("external adapter maps results and errors", async () => {
  const ok: ExternalTool = {
    name: () => "t",
    description: () => "d",
    parameters: () => encode({ type: "object" }),
    execute: () => Promise.resolve({ text: "hello" }),
  };
  const req = { signal: undefined };
  assertEquals(await createExternalToolAdapter(ok).execute(req, {}), {
    text: "hello",
  });

  const failing: ExternalTool = {
    name: () => "t",
    description: () => "d",
    parameters: () => encode({ type: "object" }),
    execute: () => Promise.resolve({ text: "", isError: true }),
  };
  await assertRejects(
    async () => {
      await createExternalToolAdapter(failing).execute(req, {});
    },
    Error,
    "tool reported an error",
  );
});

Deno.test("external adapter maps image contents", async () => {
  const tool: ExternalTool = {
    name: () => "t",
    description: () => "d",
    parameters: () => encode({ type: "object" }),
    execute: () =>
      Promise.resolve({
        text: "with image",
        contents: [
          {
            type: "image",
            image: { mimeType: "image/png", data: "AAAA" },
          },
        ],
      }),
  };
  const result = await createExternalToolAdapter(tool).execute(
    { signal: undefined },
    {},
  );
  assert(result.contents != null);
  assertEquals(result.contents![0].type, "image");
  assertEquals(result.contents![0].image?.data, "AAAA");
});
