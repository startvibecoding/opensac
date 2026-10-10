import { assertEquals } from "../compat/assert.ts";
import { type ACPRPCRequest } from "./wire.ts";
import {
  type ACPBridgeContext,
  mapACPExtensionToCore,
} from "./bridge_extensions.ts";
import { test } from "#testing";

const context: ACPBridgeContext = { source: "acp", workDir: "/tmp" };

function request(
  method: string,
  params: Record<string, unknown>,
): ACPRPCRequest {
  return { jsonrpc: "2.0", idRaw: '"ext-1"', method, params };
}

test("mapACPExtensionToCore maps attachment and project extensions", () => {
  assertEquals(
    mapACPExtensionToCore(
      request("fs/read_text_file", {
        sessionId: "session-1",
        attachmentId: "attachment-1",
      }),
      context,
    ).method,
    "attachment.fetch",
  );
  assertEquals(
    mapACPExtensionToCore(
      request("opensac/attachment/list", {
        sessionId: "session-1",
      }),
      context,
    ).method,
    "attachment.list",
  );
  assertEquals(
    mapACPExtensionToCore(request("opensac/projects/list", {}), context).method,
    "project.list",
  );
  assertEquals(
    mapACPExtensionToCore(request("opensac/doctor", {}), context).method,
    "doctor",
  );
});

test("mapACPExtensionToCore carries workspace cwd to memory handlers", () => {
  assertEquals(
    mapACPExtensionToCore(
      request("opensac/manage/memory/get", {}),
      { source: "acp", workDir: "/workspace/project" },
    ),
    {
      jsonrpc: "2.0",
      id: "ext-1",
      method: "manage.memory.get",
      params: { cwd: "/workspace/project" },
    },
  );
});

test("mapACPExtensionToCore carries workspace cwd to cron creation", () => {
  assertEquals(
    mapACPExtensionToCore(
      request("opensac/manage/cron/create", {
        name: "Daily",
        prompt: "Run",
        schedule: "@daily",
      }),
      { source: "acp", workDir: "/workspace/project" },
    ),
    {
      jsonrpc: "2.0",
      id: "ext-1",
      method: "manage.cron.create",
      params: {
        name: "Daily",
        prompt: "Run",
        schedule: "@daily",
        cwd: "/workspace/project",
      },
    },
  );
});

test("mapACPExtensionToCore carries workspace cwd to SkillHub catalog handlers", () => {
  assertEquals(
    mapACPExtensionToCore(
      request("opensac/manage/skillhub/search", {}),
      { source: "acp", workDir: "/workspace/project" },
    ),
    {
      jsonrpc: "2.0",
      id: "ext-1",
      method: "manage.skillhub.search",
      params: { cwd: "/workspace/project" },
    },
  );
  assertEquals(
    mapACPExtensionToCore(
      request("opensac/manage/skillhub/get", {}),
      { source: "acp", workDir: "/workspace/project" },
    ).params,
    {},
  );
});

test("mapACPExtensionToCore maps manage and decision responses", () => {
  assertEquals(
    mapACPExtensionToCore(request("opensac/manage/env/get", {}), context),
    {
      jsonrpc: "2.0",
      id: "ext-1",
      method: "manage.env.get",
      params: {},
    },
  );
  assertEquals(
    mapACPExtensionToCore(
      request("permission/request", {
        requestId: "approval-1",
        optionId: "allow",
      }),
      context,
    ).method,
    "approval.resolve",
  );
  assertEquals(
    mapACPExtensionToCore(
      request("question/request", {
        requestId: "question-1",
        answer: "yes",
      }),
      context,
    ).method,
    "question.resolve",
  );
});
