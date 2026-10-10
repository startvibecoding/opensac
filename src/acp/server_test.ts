// of internal/acp/acp_mcp_test.go / acp_artifact_test.go.
//
// These exercise the ACP server shell (`src/acp/server.ts`): the transport and
// notification glue, `initialize`/`doctor`, and the server-bound §4.1–§4.8
// additive extensions. Fixtures construct an `AcpServer`, bind an in-memory
// sink, and call the handlers directly, mirroring the Go fixture server.

import {
  assert,
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "../compat/assert.ts";
import * as path from "../compat/path.ts";
import {
  acpDecisionDeadlineMarks,
  AcpServer,
  type AcpServerSink,
  workspaceAdditionalDirectoryLimit,
} from "./server.ts";
import { type ACPRPCRequest } from "./wire.ts";
import {
  DECISION_APPROVAL,
  DECISION_QUESTION,
} from "../agentruntime/decision.ts";
import {
  type Event as AgentEvent,
  EVENT_DONE,
  EVENT_ERROR,
  EVENT_RUN_FINISHED,
  EVENT_TEXT_DELTA,
  EVENT_TOOL_EXECUTION_END,
  TASK_CANCELED,
  TASK_FAILED,
  TASK_SUCCESS,
} from "../agent/events.ts";
import { run as doctorRun } from "../doctor/doctor.ts";
import { test } from "#testing";

/** A synchronous in-memory sink, the port of the Go `syncedBuffer` fixture. */
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

function createFixtureServer(sink: SyncBuffer): AcpServer {
  const server = new AcpServer();
  server.sink = sink;
  return server;
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

function sessionEventParams(
  messages: Record<string, unknown>[],
  event: string,
): Record<string, unknown>[] {
  const matches: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.method !== "_opensac/session_event") continue;
    const params = message.params as Record<string, unknown> | undefined;
    if (params?.event === event) matches.push(params);
  }
  return matches;
}

function assertRPCErrorCode(
  message: Record<string, unknown>,
  code: string,
): void {
  const err = message.error as Record<string, unknown> | undefined;
  assert(err !== undefined, `response = ${JSON.stringify(message)}`);
  const data = err.data as Record<string, unknown> | undefined;
  assertEquals(data?.code, code);
  assert(typeof err.message === "string" && err.message.trim() !== "");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEvent(
  output: SyncBuffer,
  event: string,
  want: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = sessionEventParams(parseMessages(output.toString()), event)
      .length;
    if (count >= want) return;
    await delay(5);
  }
  throw new Error(
    `timed out waiting for ${want} ${event} events: ${output.toString()}`,
  );
}

function withEnv(name: string, value: string, fn: () => void): void {
  const previous = Deno.env.get(name);
  Deno.env.set(name, value);
  try {
    fn();
  } finally {
    if (previous === undefined) Deno.env.delete(name);
    else Deno.env.set(name, previous);
  }
}

// ─── §4.1 run status ────────────────────────────────────────────────────────

test("notifyRunStatus projects a run_status session event", () => {
  const output = new SyncBuffer();
  const server = createFixtureServer(output);
  server.notifyRunStatus("session-1", "run-1", "running");
  const events = sessionEventParams(
    parseMessages(output.toString()),
    "run_status",
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].sessionId, "session-1");
  assertEquals(events[0].runId, "run-1");
  assertEquals(events[0].status, "running");
});

// ─── §4.2 session metadata and projects ─────────────────────────────────────

test("setSessionMeta validates params before storage", () => {
  const output = new SyncBuffer();
  const server = createFixtureServer(output);
  server.handleSetSessionMeta(rpc(1, "opensac/session/setMeta", {}));
  server.handleSetSessionMeta(
    rpc(2, "opensac/session/setMeta", { sessionId: "s" }),
  );
  server.handleSetSessionMeta(
    rpc(3, "opensac/session/setMeta", { sessionId: "s", projectId: 42 }),
  );
  const messages = parseMessages(output.toString());
  assertEquals(messages.length, 3);
  for (const message of messages) assertRPCErrorCode(message, "invalid_params");
});

test("project handlers return structured errors without settings", () => {
  const output = new SyncBuffer();
  const server = createFixtureServer(output);
  server.handleProjectsList(rpc(1, "opensac/projects/list"));
  server.handleProjectsCreate(rpc(2, "opensac/projects/create", { name: "x" }));
  server.handleProjectsCreate(rpc(3, "opensac/projects/create", {}));
  server.handleProjectsRename(rpc(4, "opensac/projects/rename", { id: "p" }));
  server.handleProjectsDelete(rpc(5, "opensac/projects/delete"));
  const messages = parseMessages(output.toString());
  assertEquals(messages.length, 5);
  assertRPCErrorCode(messages[0], "projects_unavailable");
  assertRPCErrorCode(messages[1], "projects_unavailable");
  assertRPCErrorCode(messages[2], "invalid_params");
  assertRPCErrorCode(messages[3], "invalid_params");
  assertRPCErrorCode(messages[4], "invalid_params");
});

test("project create/list/rename/delete round trip", () => {
  const output = new SyncBuffer();
  const server = createFixtureServer(output);
  const sessionDir = Deno.makeTempDirSync();
  server.settings = { sessionDir };

  server.handleProjectsCreate(
    rpc(1, "opensac/projects/create", { name: "Alpha" }),
  );
  const created = parseMessages(output.toString())[0].result as Record<
    string,
    unknown
  >;
  const id = created.id as string;
  assertEquals(created.name, "Alpha");

  output.reset();
  server.handleProjectsList(rpc(1, "opensac/projects/list"));
  const listed = parseMessages(output.toString())[0].result as {
    projects: { id: string }[];
  };
  assertEquals(listed.projects.length, 1);
  assertEquals(listed.projects[0].id, id);

  output.reset();
  server.handleProjectsRename(
    rpc(1, "opensac/projects/rename", { id, name: "Beta" }),
  );
  const renamed = parseMessages(output.toString())[0].result as Record<
    string,
    unknown
  >;
  assertEquals(renamed.name, "Beta");

  output.reset();
  server.handleProjectsDelete(rpc(1, "opensac/projects/delete", { id }));
  assertEquals(parseMessages(output.toString())[0].result, {});
});

// ─── §4.3 workspace extension ───────────────────────────────────────────────

test("workspace extend validates, merges, dedupes, and caps", () => {
  const output = new SyncBuffer();
  const server = createFixtureServer(output);
  server.cwd = Deno.makeTempDirSync();
  const existing = Deno.makeTempDirSync();
  const added = Deno.makeTempDirSync();

  server.handleWorkspaceExtend(
    rpc(1, "opensac/workspace/extend", {
      additionalDirectories: ["relative/dir"],
    }),
  );
  server.handleWorkspaceExtend(
    rpc(2, "opensac/workspace/extend", {
      additionalDirectories: [path.join(added, "missing")],
    }),
  );
  server.handleWorkspaceExtend(
    rpc(3, "opensac/workspace/extend", { additionalDirectories: [] }),
  );
  let messages = parseMessages(output.toString());
  assertEquals(messages.length, 3);
  assertRPCErrorCode(messages[0], "workspace_directory_invalid");
  assertRPCErrorCode(messages[1], "workspace_directory_unavailable");
  assertRPCErrorCode(messages[2], "invalid_params");
  assertEquals(server.workspaceAdditionalDirectories.length, 0);

  // A valid extend grows the window, dedupes, and responds with cwd + dirs.
  server.workspaceAdditionalDirectories = [existing];
  output.reset();
  server.handleWorkspaceExtend(
    rpc(4, "opensac/workspace/extend", {
      additionalDirectories: [added, added],
    }),
  );
  assertEquals(server.workspaceAdditionalDirectories.length, 2);
  messages = parseMessages(output.toString());
  let result: Record<string, unknown> | undefined;
  for (const message of messages) {
    if (message.id === 4) {
      result = message.result as Record<string, unknown>;
    }
  }
  assert(result !== undefined, `extend response missing: ${output.toString()}`);
  assertEquals(result.cwd, server.cwd);
  assertEquals((result.additionalDirectories as string[]).length, 2);
  const events = sessionEventParams(messages, "workspace");
  assertEquals(events.length, 1);
  assertEquals(events[0].cwd, server.cwd);

  // The window is capped at workspaceAdditionalDirectoryLimit.
  const many: string[] = [];
  for (let i = 0; i < workspaceAdditionalDirectoryLimit - 1; i++) {
    many.push(Deno.makeTempDirSync());
  }
  output.reset();
  server.handleWorkspaceExtend(
    rpc(5, "opensac/workspace/extend", { additionalDirectories: many }),
  );
  const limited = parseMessages(output.toString());
  assertEquals(limited.length, 1);
  assertRPCErrorCode(limited[0], "workspace_limit_exceeded");
  assertEquals(server.workspaceAdditionalDirectories.length, 2);
});

test("workspace extend normalizes symlinks", () => {
  const target = Deno.makeTempDirSync();
  const link = path.join(Deno.makeTempDirSync(), "link");
  try {
    Deno.symlinkSync(target, link);
  } catch {
    return; // symlinks unavailable
  }
  const resolvedTarget = Deno.realPathSync(target);
  const output = new SyncBuffer();
  const server = createFixtureServer(output);
  server.cwd = Deno.makeTempDirSync();
  server.handleWorkspaceExtend(
    rpc(1, "opensac/workspace/extend", { additionalDirectories: [link] }),
  );
  assertEquals(server.workspaceAdditionalDirectories.length, 1);
  assertEquals(server.workspaceAdditionalDirectories[0], resolvedTarget);
});

// ─── §4.4 decision deadline reminders ───────────────────────────────────────

test("scheduleDecisionDeadline emits both marks and stops cleanly", async () => {
  const originalCap = acpDecisionDeadlineMarks.firstNoticeCapMs;
  const originalFinal = acpDecisionDeadlineMarks.finalNoticeMs;
  acpDecisionDeadlineMarks.firstNoticeCapMs = 3_600_000;
  acpDecisionDeadlineMarks.finalNoticeMs = 30;
  try {
    const output = new SyncBuffer();
    const server = createFixtureServer(output);
    const timeoutMs = 100;
    const deadline = new Date(Date.now() + timeoutMs);
    // first = min(1h, 50ms) = 50ms; second = 100ms-30ms = 70ms > first.
    const stop = server.scheduleDecisionDeadline(
      "session-1",
      "req-1",
      DECISION_QUESTION,
      timeoutMs,
      deadline,
    );
    await waitForEvent(output, "decision_deadline", 2, 3_000);
    stop();
    await delay(120);
    const events = sessionEventParams(
      parseMessages(output.toString()),
      "decision_deadline",
    );
    assertEquals(events.length, 2);
    for (const event of events) {
      assertEquals(event.requestId, "req-1");
      assertEquals(event.kind, "question");
      assertEquals(event.sessionId, "session-1");
      assert(typeof event.deadline === "string");
      assert(typeof event.remainingMs === "number" && event.remainingMs >= 0);
    }
  } finally {
    acpDecisionDeadlineMarks.firstNoticeCapMs = originalCap;
    acpDecisionDeadlineMarks.finalNoticeMs = originalFinal;
  }
});

test("scheduleDecisionDeadline stops before the first mark", async () => {
  const output = new SyncBuffer();
  const server = createFixtureServer(output);
  const stop = server.scheduleDecisionDeadline(
    "session-1",
    "req-2",
    DECISION_APPROVAL,
    40,
    new Date(Date.now() + 40),
  );
  stop();
  await delay(120);
  assertEquals(
    sessionEventParams(parseMessages(output.toString()), "decision_deadline")
      .length,
    0,
  );
  stop(); // double stop is safe
});

test("scheduleDecisionDeadline skips the final notice for short timeouts", async () => {
  const output = new SyncBuffer();
  const server = createFixtureServer(output);
  // timeout/2 = 10ms fires; timeout-60s is negative and must not schedule.
  const stop = server.scheduleDecisionDeadline(
    "session-1",
    "req-3",
    DECISION_APPROVAL,
    20,
    new Date(Date.now() + 20),
  );
  try {
    await waitForEvent(output, "decision_deadline", 1, 3_000);
    await delay(80);
    assertEquals(
      sessionEventParams(parseMessages(output.toString()), "decision_deadline")
        .length,
      1,
    );
  } finally {
    stop();
  }
});

// ─── §4.6 sub-agent lifecycle events ────────────────────────────────────────

test("observeSubagentEvent projects started and a single terminal", () => {
  const output = new SyncBuffer();
  const server = createFixtureServer(output);

  // Parent-scoped events never produce subagent projections.
  server.observeSubagentEvent("session-1", {
    type: EVENT_TEXT_DELTA,
    textDelta: "parent",
  });
  assertEquals(
    sessionEventParams(parseMessages(output.toString()), "subagent").length,
    0,
  );

  // First child event projects "started"; later activity does not repeat it.
  server.observeSubagentEvent(
    "session-1",
    {
      type: EVENT_TEXT_DELTA,
      agentId: "child-1",
      textDelta: "child",
      memberId: "engineer",
      expertId: "software-company",
      memberDisplayName: "工程师",
      memberEmoji: "🛠️",
      memberRole: "member",
    } satisfies AgentEvent,
  );
  server.observeSubagentEvent("session-1", {
    type: EVENT_TOOL_EXECUTION_END,
    agentId: "child-1",
    toolCallId: "call-1",
  });
  let events = sessionEventParams(parseMessages(output.toString()), "subagent");
  assertEquals(events.length, 1);
  assertEquals(events[0].status, "started");
  assertEquals(events[0].agentId, "child-1");
  assertEquals(events[0].sessionId, "session-1");
  assertEquals(events[0].memberId, "engineer");
  assertEquals(events[0].expertId, "software-company");
  assertEquals(events[0].memberDisplayName, "工程师");
  assertEquals(events[0].memberEmoji, "🛠️");
  assertEquals(events[0].memberRole, "member");

  // The canonical terminal projects exactly one "completed".
  output.reset();
  server.observeSubagentEvent("session-1", {
    type: EVENT_RUN_FINISHED,
    agentId: "child-1",
    status: TASK_SUCCESS,
  });
  server.observeSubagentEvent("session-1", {
    type: EVENT_DONE,
    agentId: "child-1",
    done: true,
  });
  events = sessionEventParams(parseMessages(output.toString()), "subagent");
  assertEquals(events.length, 1);
  assertEquals(events[0].status, "completed");
  assertEquals(events[0].memberDisplayName, "工程师");

  // A failing child maps to "failed".
  output.reset();
  server.observeSubagentEvent("session-1", {
    type: EVENT_RUN_FINISHED,
    agentId: "child-2",
    status: TASK_FAILED,
  });
  events = sessionEventParams(parseMessages(output.toString()), "subagent");
  assertEquals(events.length, 2);
  assertEquals(events[0].status, "started");
  assertEquals(events[1].status, "failed");

  // A cancelled child maps to "failed" and a legacy EVENT_ERROR adds nothing.
  output.reset();
  server.observeSubagentEvent("session-1", {
    type: EVENT_RUN_FINISHED,
    agentId: "child-3",
    status: TASK_CANCELED,
  });
  server.observeSubagentEvent("session-1", {
    type: EVENT_ERROR,
    agentId: "child-3",
  });
  events = sessionEventParams(parseMessages(output.toString()), "subagent");
  assertEquals(events.length, 2);
  assertEquals(events[0].status, "started");
  assertEquals(events[1].status, "failed");

  // Legacy-only streams still pair started with completed.
  output.reset();
  server.observeSubagentEvent("session-2", {
    type: EVENT_DONE,
    agentId: "child-4",
    done: true,
  });
  events = sessionEventParams(parseMessages(output.toString()), "subagent");
  assertEquals(events.length, 2);
  assertEquals(events[0].status, "started");
  assertEquals(events[1].status, "completed");
  assertEquals(events[0].sessionId, "session-2");

  // Shutdown clears the projection state so a reused agent id starts fresh.
  server.clearSubagentProjections("session-2");
  output.reset();
  server.observeSubagentEvent("session-2", {
    type: EVENT_TEXT_DELTA,
    agentId: "child-4",
  });
  events = sessionEventParams(parseMessages(output.toString()), "subagent");
  assertEquals(events.length, 1);
  assertEquals(events[0].status, "started");
});

// ─── §4.8 attachment listing ────────────────────────────────────────────────

test("attachment list validates params before storage", () => {
  const output = new SyncBuffer();
  const server = createFixtureServer(output);
  server.handleAttachmentList(rpc(1, "opensac/attachment/list"));
  server.handleAttachmentList(
    rpc(2, "opensac/attachment/list", { sessionId: "s", status: "expired" }),
  );
  const messages = parseMessages(output.toString());
  assertEquals(messages.length, 2);
  assertRPCErrorCode(messages[0], "invalid_params");
  assertRPCErrorCode(messages[1], "attachment_list_invalid_status");
});

// ─── §4.9 capability discovery ──────────────────────────────────────────────

test("initialize declares the Phase 1 feature keys", () => {
  const output = new SyncBuffer();
  const server = createFixtureServer(output);
  server.handleInitialize(rpc(1, "initialize", { protocolVersion: 1 }));
  const response = parseMessages(output.toString())[0] as {
    result: { _meta: Record<string, unknown> };
  };
  const namespace = response.result._meta["opensac.dev"] as {
    features: string[];
  };
  const features = new Set(namespace.features);
  for (
    const want of [
      "runStatus",
      "sessionMeta",
      "projects",
      "workspaceExtend",
      "decisionDeadline",
      "subagentEvents",
      "toolResultImages",
      "attachmentList",
      "sessionListAll",
      "sessionWorkDir",
      // Phase 0 keys must survive the additive change.
      "artifactProjection",
      "attachmentFetch",
    ]
  ) {
    assert(features.has(want), `missing feature ${want}`);
  }
});

test("initialize advertises standard session lifecycle capabilities", () => {
  const output = new SyncBuffer();
  const server = createFixtureServer(output);
  server.handleInitialize(rpc(1, "initialize"));

  const message = parseMessages(output.toString())[0];
  const result = message.result as Record<string, unknown>;
  const agentCaps = result.agentCapabilities as Record<string, unknown>;
  const caps = agentCaps.sessionCapabilities as Record<string, unknown>;
  for (const key of ["close", "list", "delete", "resume"]) {
    assert(
      typeof caps[key] === "object" && caps[key] !== null,
      `capability ${key} = ${JSON.stringify(caps[key])}`,
    );
  }
  assert(!("configOptions" in caps));
  const mcpCaps = agentCaps.mcpCapabilities as Record<string, unknown>;
  assert(!("stdio" in mcpCaps));
  const meta = agentCaps._meta as Record<string, unknown>;
  const extension = meta["opensac.dev"] as Record<string, unknown>;
  assertEquals(extension.doctor, true);
  assert((extension.features as string[]).includes("sessionConfigProvider"));
  assert((extension.features as string[]).includes("usageCacheProjection"));
  const agentInfo = result.agentInfo as Record<string, unknown>;
  assertEquals(agentInfo.name, "opensac");
  assertEquals(agentInfo.title, "OpenSAC");
  assert((agentInfo.version as string).length > 0);
  const rootMeta = result._meta as Record<string, unknown>;
  assertEquals(
    (rootMeta["opensac.dev"] as Record<string, unknown>).doctor,
    true,
  );
});

test("initialize parses typed client capabilities", () => {
  const output = new SyncBuffer();
  const server = createFixtureServer(output);
  server.handleInitialize(
    rpc(1, "initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        auth: { terminal: false },
        elicitation: { form: {}, url: {} },
        session: { configOptions: { boolean: {} } },
      },
    }),
  );
  assertEquals(server.clientCaps.fs?.readTextFile, true);
  assertEquals(server.clientCaps.fs?.writeTextFile, true);
  assertEquals(server.clientCaps.terminal, true);
  assertEquals(server.clientCaps.auth?.terminal, false);
  assertNotStrictEquals(server.clientCaps.elicitation?.form, undefined);
  assertNotStrictEquals(server.clientCaps.elicitation?.url, undefined);
  assertNotStrictEquals(
    server.clientCaps.session?.configOptions?.boolean,
    undefined,
  );
  const message = parseMessages(output.toString())[0];
  const caps = (message.result as Record<string, unknown>)
    .agentCapabilities as Record<string, unknown>;
  const sessionCaps = caps.sessionCapabilities as Record<string, unknown>;
  assert(typeof sessionCaps.additionalDirectories === "object");
});

test("initialize rejects a duplicate call", () => {
  const output = new SyncBuffer();
  const server = createFixtureServer(output);
  server.handleInitialize(rpc(1, "initialize", { protocolVersion: 1 }));
  output.reset();
  server.handleInitialize(rpc(2, "initialize", { protocolVersion: 1 }));
  const messages = parseMessages(output.toString());
  assertEquals(messages.length, 1);
  assertEquals((messages[0].error as Record<string, unknown>).code, -32600);
});

// ─── doctor ─────────────────────────────────────────────────────────────────

test("handleDoctor does not require a session", () => {
  const configDir = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const output = new SyncBuffer();
    const server = createFixtureServer(output);
    server.handleDoctor(rpc(1, "opensac/doctor", {}));
    const result = parseMessages(output.toString())[0].result as {
      version: string;
      checks: { id: string }[];
    };
    assert(typeof result.version === "string");
    assert(result.checks.some((check) => check.id === "cli"));
  });
});

test("handleDoctor uses the server cwd when the request omits it", () => {
  const configDir = Deno.makeTempDirSync();
  const cwd = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const output = new SyncBuffer();
    const server = createFixtureServer(output);
    server.cwd = cwd;
    server.version = "test-version";
    server.handleDoctor(rpc(1, "opensac/doctor", {}));
    const result = parseMessages(output.toString())[0].result as {
      checks: { id: string; detail?: string }[];
    };
    const cwdCheck = result.checks.find((check) => check.id === "cwd");
    if (cwdCheck !== undefined) assertEquals(cwdCheck.detail, cwd);
  });
});

test("initialize and doctor use the configured run version", () => {
  const output = new SyncBuffer();
  const server = createFixtureServer(output);
  server.version = "0.3.1";
  server.handleInitialize(rpc(1, "initialize"));
  server.handleDoctor(rpc(2, "opensac/doctor", {}));
  const messages = parseMessages(output.toString());
  const initialize = messages[0].result as Record<string, unknown>;
  assertEquals(
    (initialize.agentInfo as Record<string, unknown>).version,
    "0.3.1",
  );
  const doctorResult = messages[1].result as Record<string, unknown>;
  assertEquals(doctorResult.version, "0.3.1");
});

test("doctor matches the shared doctor response", () => {
  const configDir = Deno.makeTempDirSync();
  const cwd = Deno.makeTempDirSync();
  withEnv("OPENSAC_DIR", configDir, () => {
    const output = new SyncBuffer();
    const server = createFixtureServer(output);
    server.cwd = cwd;
    server.version = "0.3.1";
    server.handleDoctor(rpc(1, "opensac/doctor", {}));
    const wire = parseMessages(output.toString())[0].result as {
      ok: boolean;
      version: string;
      summary: string;
      checks: { id: string; status: string }[];
    };
    const shared = doctorRun(cwd, "0.3.1");
    assertStrictEquals(wire.ok, shared.ok);
    assertStrictEquals(wire.version, shared.version);
    assertStrictEquals(wire.summary, shared.summary);
    assertEquals(wire.checks.length, shared.checks.length);
    for (let i = 0; i < shared.checks.length; i++) {
      assertEquals(wire.checks[i].id, shared.checks[i].id);
      assertEquals(wire.checks[i].status, shared.checks[i].status);
    }
  });
});

test("handleDoctor rejects a relative cwd", () => {
  const output = new SyncBuffer();
  const server = createFixtureServer(output);
  server.handleDoctor(rpc(1, "opensac/doctor", { cwd: "relative" }));
  const message = parseMessages(output.toString())[0];
  assertEquals((message.error as Record<string, unknown>).code, -32602);
});
