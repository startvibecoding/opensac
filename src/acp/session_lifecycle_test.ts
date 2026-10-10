// Focused tests for the ACP session catalog and lifecycle-mutation slice of
// src/acp/server.ts (translated from the session/close, opensac/session/delete,
// opensac/session/setTitle, opensac/session/setWorkDir, opensac/session/history,
// session/list, opensac/session/listAll, and decision-ledger paths of
// internal/acp/acp.go). Fixtures create real persisted sessions in a temp
// session directory and call the handlers directly.

import { runtime as nodeRuntime } from "../platform/runtime.ts";
import { assert, assertEquals } from "../compat/assert.ts";
import * as path from "../compat/path.ts";
import {
  acpFailureRPCError,
  AcpServer,
  type AcpServerSink,
  ACPSessionRuntime,
  SessionProviderMismatchError,
} from "./server.ts";
import { type ACPRPCRequest, encodeSessionCursor } from "./mod.ts";
import { type Settings } from "../config/settings.ts";
import { createSession } from "../agentruntime/session_lifecycle.ts";
import {
  DECISION_QUESTION,
  DecisionService,
} from "../agentruntime/decision.ts";
import type { ExecutionRuntime } from "../agentruntime/execution.ts";
import { PHASE_PERSISTENCE } from "../agentruntime/error_info.ts";
import { listAllDetailed, openByIDExact } from "../session/manager.ts";
import { test } from "#testing";

class SyncBuffer implements AcpServerSink {
  #buf = "";

  write(data: string): void {
    this.#buf += data;
  }

  toString(): string {
    return this.#buf;
  }

  reset(): void {
    this.#buf = "";
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

/** Returns the JSON-RPC response (the message carrying result/error). */
function responseOf(output: string): Record<string, unknown> {
  const response = parseMessages(output).find(
    (m) => "result" in m || "error" in m,
  );
  assert(response !== undefined, `no response in ${output}`);
  return response;
}

interface Fixture {
  server: AcpServer;
  sink: SyncBuffer;
  sessionDir: string;
  root: string;
}

function createFixture(): Fixture {
  const root = nodeRuntime.makeTempDirSync({ prefix: "opensac-acp-life-" });
  const sessionDir = path.join(root, "sessions");
  nodeRuntime.mkdirSync(sessionDir, { recursive: true });
  const server = new AcpServer();
  server.settings = { sessionDir } as unknown as Settings;
  const sink = new SyncBuffer();
  server.sink = sink;
  return { server, sink, sessionDir, root };
}

function makeSession(sessionDir: string, workDir: string, id: string): string {
  nodeRuntime.mkdirSync(workDir, { recursive: true });
  const mgr = createSession({ workDir, sessionDir, id });
  return mgr.getHeader()!.id;
}

function errorOf(message: Record<string, unknown>): Record<string, unknown> {
  const err = message.error as Record<string, unknown> | undefined;
  assert(err !== undefined, `response = ${JSON.stringify(message)}`);
  return err;
}

test("session/list scopes to the workspace and projects additive _meta", () => {
  const { server, sink, sessionDir, root } = createFixture();
  const workA = path.join(root, "a");
  const workB = path.join(root, "b");
  const idA = makeSession(sessionDir, workA, "sess-a");
  makeSession(sessionDir, workB, "sess-b");

  server.handleListSessions(rpc(1, "session/list", { cwd: workA }));
  const result = responseOf(sink.toString()).result as {
    sessions: Record<string, unknown>[];
    nextCursor?: string;
  };
  assertEquals(result.sessions.length, 1);
  const listed = result.sessions[0];
  assertEquals(listed.sessionId, idA);
  assertEquals(listed.cwd, workA);
  const meta = listed._meta as Record<string, unknown>;
  assertEquals(meta.pinned, false);
  assertEquals(meta.projectId, null);
  assertEquals("lastRun" in meta, false);
  assert(typeof meta.messageCount === "number");
  assertEquals(result.nextCursor, undefined);
});

test("session/list rejects a cwd outside the negotiated workspace", () => {
  const { server, sink, root } = createFixture();
  const workA = path.join(root, "a");
  const workB = path.join(root, "b");
  nodeRuntime.mkdirSync(workA, { recursive: true });
  nodeRuntime.mkdirSync(workB, { recursive: true });
  server.workspaceCwd = workA;

  server.handleListSessions(rpc(1, "session/list", { cwd: workB }));
  const err = errorOf(responseOf(sink.toString()));
  assertEquals(err.code, -32602);
  assert((err.message as string).includes("outside the negotiated workspace"));
});

test("session/list rejects an invalid cursor and pages by offset", () => {
  const { server, sink, sessionDir, root } = createFixture();
  const workA = path.join(root, "a");
  makeSession(sessionDir, workA, "sess-a");

  sink.reset();
  server.handleListSessions(
    rpc(1, "session/list", { cwd: workA, cursor: "@@@" }),
  );
  const err = errorOf(responseOf(sink.toString()));
  assertEquals(err.code, -32602);
  assertEquals(err.message, "invalid cursor");

  sink.reset();
  server.handleListSessions(
    rpc(2, "session/list", { cwd: workA, cursor: encodeSessionCursor(1) }),
  );
  const result = responseOf(sink.toString()).result as {
    sessions: unknown[];
  };
  assertEquals(result.sessions.length, 0);
});

test("opensac/session/listAll validates scope and filters by query", () => {
  const { server, sink, sessionDir, root } = createFixture();
  const workA = path.join(root, "a");
  const workB = path.join(root, "b");
  makeSession(sessionDir, workA, "sess-a");
  makeSession(sessionDir, workB, "sess-b");

  sink.reset();
  server.handleListAllSessions(
    rpc(1, "opensac/session/listAll", { scope: "project" }),
  );
  assert(
    (errorOf(responseOf(sink.toString())).message as string).includes(
      "projectId is required",
    ),
  );

  sink.reset();
  server.handleListAllSessions(
    rpc(2, "opensac/session/listAll", { scope: "bogus" }),
  );
  assert(
    (errorOf(responseOf(sink.toString())).message as string).includes(
      "invalid session list scope",
    ),
  );

  sink.reset();
  server.handleListAllSessions(
    rpc(3, "opensac/session/listAll", { query: "sess-a" }),
  );
  const result = responseOf(sink.toString()).result as {
    sessions: Record<string, unknown>[];
  };
  assertEquals(result.sessions.length, 1);
  assertEquals(result.sessions[0].sessionId, "sess-a");
});

test("opensac/session/setTitle persists and notifies", () => {
  const { server, sink, sessionDir, root } = createFixture();
  const workA = path.join(root, "a");
  const id = makeSession(sessionDir, workA, "sess-title");

  sink.reset();
  server.handleSetSessionTitle(
    rpc(1, "opensac/session/setTitle", { sessionId: id, title: "Renamed" }),
  );
  const messages = parseMessages(sink.toString());
  const response = messages[messages.length - 1];
  assertEquals(response.result, {});
  const update = messages.find((m) => m.method === "session/update")!;
  const params = update.params as Record<string, unknown>;
  const payload = params.update as Record<string, unknown>;
  assertEquals(payload.sessionUpdate, "session_info_update");
  assertEquals(payload.title, "Renamed");

  sink.reset();
  server.handleSetSessionTitle(
    rpc(2, "opensac/session/setTitle", { sessionId: id }),
  );
  assertEquals(errorOf(responseOf(sink.toString())).code, -32602);
});

test("opensac/session/setWorkDir guards and moves the session", async () => {
  const { server, sink, sessionDir, root } = createFixture();
  const workA = path.join(root, "a");
  const workB = path.join(root, "b");
  const workD = path.join(root, "d");
  nodeRuntime.mkdirSync(workD, { recursive: true });
  const id = makeSession(sessionDir, workA, "sess-wd");

  // Same cwd short-circuits without a mutation.
  sink.reset();
  await server.handleSetSessionWorkDir(
    rpc(1, "opensac/session/setWorkDir", { sessionId: id, cwd: workA }),
  );
  assertEquals(
    (responseOf(sink.toString()).result as Record<string, unknown>).cwd,
    workA,
  );

  // A running session cannot be moved.
  server.sessions.set(id, activeRuntime(id));
  sink.reset();
  await server.handleSetSessionWorkDir(
    rpc(2, "opensac/session/setWorkDir", { sessionId: id, cwd: workD }),
  );
  assert(
    (errorOf(responseOf(sink.toString())).message as string).includes(
      "while the session is running",
    ),
  );

  // An idle session moves and persists the new cwd.
  server.sessions.delete(id);
  sink.reset();
  await server.handleSetSessionWorkDir(
    rpc(3, "opensac/session/setWorkDir", { sessionId: id, cwd: workD }),
  );
  assertEquals(
    (responseOf(sink.toString()).result as Record<string, unknown>).cwd,
    workD,
  );
  assertEquals(openByIDExact(sessionDir, id).getHeader()!.cwd, workD);

  // A directory outside the negotiated window is refused.
  server.workspaceCwd = root;
  sink.reset();
  await server.handleSetSessionWorkDir(
    rpc(4, "opensac/session/setWorkDir", { sessionId: id, cwd: workB }),
  );
  assertEquals(errorOf(responseOf(sink.toString())).code, -32602);
});

test("session/close shuts down an open runtime and is workspace-guarded", async () => {
  const { server, sink, sessionDir, root } = createFixture();
  const workA = path.join(root, "a");
  const id = makeSession(sessionDir, workA, "sess-close");

  // No open runtime: the durable session closes as a no-op.
  sink.reset();
  await server.handleCloseSession(rpc(1, "session/close", { sessionId: id }));
  assertEquals(responseOf(sink.toString()).result, {});

  // An open runtime is shut down and forgotten.
  server.sessions.set(id, new ACPSessionRuntime());
  sink.reset();
  await server.handleCloseSession(rpc(2, "session/close", { sessionId: id }));
  assertEquals(responseOf(sink.toString()).result, {});
  assertEquals(server.sessions.has(id), false);

  // A workspace outside the negotiated window is refused.
  server.workspaceCwd = path.join(root, "elsewhere");
  sink.reset();
  await server.handleCloseSession(rpc(3, "session/close", { sessionId: id }));
  assertEquals(errorOf(responseOf(sink.toString())).code, -32000);
});

test("opensac/session/delete removes an idle session and rejects an active one", () => {
  const { server, sink, sessionDir, root } = createFixture();
  const workA = path.join(root, "a");
  const id = makeSession(sessionDir, workA, "sess-del");

  server.sessions.set(id, new ACPSessionRuntime());
  sink.reset();
  server.handleDeleteSession(
    rpc(1, "opensac/session/delete", { sessionId: id }),
  );
  assert(
    (errorOf(responseOf(sink.toString())).message as string).includes(
      "cannot delete an active session",
    ),
  );

  server.sessions.delete(id);
  sink.reset();
  server.handleDeleteSession(
    rpc(2, "opensac/session/delete", { sessionId: id }),
  );
  assertEquals(responseOf(sink.toString()).result, {});
  assertEquals(
    listAllDetailed(sessionDir).some((detail) => detail.id === id),
    false,
  );

  // Re-deleting a session whose row is gone reports the structured failure
  // (Go's `OpenByIDExact` returns "not registered in DB" for a missing row).
  sink.reset();
  server.handleDeleteSession(
    rpc(3, "opensac/session/delete", { sessionId: id }),
  );
  assertEquals(errorOf(responseOf(sink.toString())).code, -32000);
});

test("opensac/session/history pages the canonical transcript", () => {
  const { server, sink, sessionDir, root } = createFixture();
  const workA = path.join(root, "a");
  const id = makeSession(sessionDir, workA, "sess-hist");
  const mgr = openByIDExact(sessionDir, id);
  mgr.appendMessage({ role: "user", content: "hello", timestamp: new Date() });
  const rt = new ACPSessionRuntime();
  rt.id = id;
  rt.mgr = mgr;
  server.sessions.set(id, rt);

  sink.reset();
  server.handleSessionHistory(
    rpc(1, "opensac/session/history", { sessionId: id }),
  );
  const result = responseOf(sink.toString()).result as {
    sessionId: string;
    updates: Record<string, unknown>[];
  };
  assertEquals(result.sessionId, id);
  assertEquals(result.updates.length, 1);
  assertEquals(result.updates[0].sessionUpdate, "user_message_chunk");

  sink.reset();
  server.handleSessionHistory(
    rpc(2, "opensac/session/history", { sessionId: "nope" }),
  );
  assertEquals(errorOf(responseOf(sink.toString())).code, -32000);

  sink.reset();
  server.handleSessionHistory(rpc(3, "opensac/session/history", 42));
  assertEquals(errorOf(responseOf(sink.toString())).code, -32602);
});

test("decision ledger persists, replays, and terminalizes on close", () => {
  const { server, sink, sessionDir, root } = createFixture();
  const workA = path.join(root, "a");
  const id = makeSession(sessionDir, workA, "sess-dec");
  const rt = new ACPSessionRuntime();
  rt.id = id;
  rt.runID = "run-1";
  rt.decisions = new DecisionService();
  server.sessions.set(id, rt);

  server.persistDecisionRecord(
    id,
    "run-1",
    "q1",
    DECISION_QUESTION,
    "pending",
    "",
    {
      sessionId: id,
      question: "Proceed?",
      options: ["yes", "no"],
      timeoutMs: 1000,
    },
  );
  const records = server.loadPersistedDecisionRecords(id);
  assertEquals(records.length, 1);
  assertEquals(records[0].status, "pending");
  rt.decisions.rehydrate(records);
  assertEquals(rt.decisions.pending().length, 1);

  sink.reset();
  server.replayPendingDecisionRequests(id);
  const request = parseMessages(sink.toString()).find(
    (m) => m.method === "_opensac/request_question",
  );
  assert(request !== undefined);

  server.clearSessionDecisions(id);
  const terminal = server.loadPersistedDecisionRecords(id);
  assertEquals(terminal[terminal.length - 1].status, "cancelled");
});

test("acpFailureRPCError projects mismatch and generic envelopes", () => {
  const mismatch = new SessionProviderMismatchError("p1", "m1", "p2");
  const mismatchError = acpFailureRPCError(mismatch, null, PHASE_PERSISTENCE);
  assertEquals(mismatchError.code, -32002);
  const data = mismatchError.data as Record<string, unknown>;
  assertEquals(data.sessionProvider, "p1");
  assertEquals(data.currentProvider, "p2");

  const generic = acpFailureRPCError(
    new Error("boom"),
    null,
    PHASE_PERSISTENCE,
  );
  assertEquals(generic.code, -32000);
  assert(generic.message.trim() !== "");
});

/** A minimal runtime whose execution reports an active run. */
function activeRuntime(id: string): ACPSessionRuntime {
  const rt = new ACPSessionRuntime();
  rt.id = id;
  rt.execution = {
    active: () => ({ runId: "run-1", active: true }),
  } as unknown as ExecutionRuntime;
  return rt;
}
