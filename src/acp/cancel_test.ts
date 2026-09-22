// Translated from the cancellation cases of internal/acp/acp_mcp_test.go plus
// focused admission coverage for the ACP prompt-admission fence
// (`acquirePromptAdmission`). Fixtures construct an `AcpServer`, bind an
// in-memory sink, and call the handlers directly.

import { assertEquals, assertRejects } from "@std/assert";
import * as path from "@std/path";
import {
  ACPActiveSessionRunError,
  AcpServer,
  type AcpServerSink,
  ACPSessionRuntime,
} from "./server.ts";
import type { ACPRPCRequest } from "./wire.ts";
import type { Settings } from "../config/settings.ts";
import { createSession } from "../agentruntime/session_lifecycle.ts";

class SyncBuffer implements AcpServerSink {
  #buf = "";

  write(data: string): void {
    this.#buf += data;
  }

  toString(): string {
    return this.#buf;
  }
}

function rpc(
  id: number | string,
  method: string,
  params?: unknown,
): ACPRPCRequest {
  return {
    jsonrpc: "2.0",
    idRaw: JSON.stringify(id),
    method,
    params,
  };
}

function parseMessages(output: string): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    messages.push(JSON.parse(trimmed) as Record<string, unknown>);
  }
  return messages;
}

Deno.test("$/cancel_request cancels the matching prompt", () => {
  let cancelled = false;
  const server = new AcpServer();
  const rt = new ACPSessionRuntime();
  rt.promptID = "prompt-1";
  rt.cancel = () => {
    cancelled = true;
  };
  server.sessions.set("session-1", rt);
  server.handleCancelRequest(
    rpc(1, "$/cancel_request", { requestId: "prompt-1" }),
  );
  assertEquals(cancelled, true);
});

Deno.test("$/cancel_request releases a pending reverse request", () => {
  const server = new AcpServer();
  let payload: unknown;
  server.pending.set("prompt-1", (value) => {
    payload = value;
  });
  server.handleCancelRequest(
    rpc(1, "$/cancel_request", { requestId: "prompt-1" }),
  );
  assertEquals(payload, { outcome: { outcome: "cancelled" } });
  assertEquals(server.pending.has("prompt-1"), false);
});

Deno.test("session/cancel rejects invalid and unknown sessions", () => {
  const output = new SyncBuffer();
  const server = new AcpServer();
  server.sink = output;
  server.handleCancel(rpc(1, "session/cancel", {}));
  let message = parseMessages(output.toString())[0];
  let err = message.error as Record<string, unknown>;
  assertEquals(err.code, -32602);
  const output2 = new SyncBuffer();
  server.sink = output2;
  server.handleCancel(rpc(2, "session/cancel", { sessionId: "missing" }));
  message = parseMessages(output2.toString())[0];
  err = message.error as Record<string, unknown>;
  assertEquals(err.code, -32000);
});

Deno.test("session/cancel aborts the session's cancel handle", () => {
  const output = new SyncBuffer();
  const server = new AcpServer();
  server.sink = output;
  let cancelled = false;
  const rt = new ACPSessionRuntime();
  rt.id = "session-1";
  rt.cancel = () => {
    cancelled = true;
  };
  server.sessions.set("session-1", rt);
  server.handleCancel(rpc(1, "session/cancel", { sessionId: "session-1" }));
  assertEquals(cancelled, true);
  const message = parseMessages(output.toString())[0];
  assertEquals(message.result, {});
});

Deno.test("acquirePromptAdmission fences concurrent local runs", async () => {
  const root = Deno.makeTempDirSync({ prefix: "opensac-acp-admission-" });
  const sessionDir = path.join(root, "sessions");
  Deno.mkdirSync(sessionDir, { recursive: true });
  createSession({ workDir: root, sessionDir, id: "session-1" });
  const server = new AcpServer();
  server.settings = { sessionDir } as unknown as Settings;
  const rt = new ACPSessionRuntime();
  rt.id = "session-1";

  const release = await server.acquirePromptAdmission(rt);
  rt.cancel = () => {};
  await assertRejects(
    () => server.acquirePromptAdmission(rt),
    ACPActiveSessionRunError,
  );
  release();
  rt.cancel = null;
  const releaseAgain = await server.acquirePromptAdmission(rt);
  releaseAgain();
  Deno.removeSync(root, { recursive: true });
});

Deno.test("acquirePromptAdmission rejects an unbound runtime", async () => {
  const server = new AcpServer();
  const rt = new ACPSessionRuntime();
  await assertRejects(
    () => server.acquirePromptAdmission(rt),
    Error,
  );
});
